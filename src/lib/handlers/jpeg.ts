// Handler JPEG: strip metadata trực tiếp trên bytes (lossless, không re-encode).
//
// Cấu trúc JPEG = chuỗi segment [FF marker] [độ dài 2 byte] [payload], xen giữa là
// dữ liệu nén (entropy-coded). Chiến lược: đi qua từng segment, giữ nguyên byte các
// segment cấu trúc (DQT/DHT/SOF/SOS/dữ liệu nén...), bỏ các segment metadata
// (EXIF/XMP/IPTC/COM...), và bỏ dữ liệu thừa sau EOI (motion photo, gain map...).

import {CleanerError, concatParts, startsWithAscii, u16be, decodeLatin1, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {readOrientation} from './exif';
import {collectExifrFields, parseWithExifr} from '../exifr-fields';
import {classifyTag} from '../risk';
import {rewriteTiff} from '../tiff-rewrite';
import {scrubXmpGps} from '../xmp-scrub';

export type JpegCategory = 'structural' | 'metadata' | 'icc' | 'trailing';

export interface JpegSegment {
  /** Mã marker (0xD8, 0xE1...), null với dữ liệu nén / dữ liệu thừa. */
  marker: number | null;
  kind: string;
  category: JpegCategory;
  start: number;
  end: number;
  /** Vị trí bắt đầu payload (sau marker + 2 byte độ dài). */
  payloadStart: number;
  note?: string;
}

export interface JpegParseResult {
  segments: JpegSegment[];
  warnings: string[];
}

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_HEADER = 'http://ns.adobe.com/xmp/extension/\0';
const ICC_HEADER = 'ICC_PROFILE\0';
const IPTC_HEADER = 'Photoshop 3.0\0';

function classifySegment(
  marker: number,
  bytes: Uint8Array,
  start: number,
  end: number,
  payloadStart: number,
): JpegSegment {
  const base = {marker, start, end, payloadStart};
  const has = (s: string) => startsWithAscii(bytes, payloadStart, s);

  if (marker >= 0xe0 && marker <= 0xef) {
    // Segment APPn — nơi chứa hầu hết metadata
    switch (marker) {
      case 0xe0:
        if (has('JFIF\0')) {
          // Payload JFIF chuẩn dài 14 byte; dài hơn nghĩa là có thumbnail RGB
          // nhúng ngay trong header (JFIF 1.02 §10) — một ảnh thu nhỏ có thể lộ nội dung
          if (end - payloadStart > 14) {
            return {...base, kind: 'jfif-thumb', category: 'metadata', note: 'JFIF có thumbnail nhúng'};
          }
          return {...base, kind: 'jfif', category: 'structural'};
        }
        if (has('JFXX\0'))
          return {...base, kind: 'jfxx', category: 'metadata', note: 'thumbnail JFIF'};
        return {...base, kind: 'app', category: 'metadata', note: 'APP0 lạ'};
      case 0xe1:
        if (has(EXIF_HEADER)) return {...base, kind: 'exif', category: 'metadata'};
        if (has(XMP_HEADER)) return {...base, kind: 'xmp', category: 'metadata'};
        if (has(XMP_EXT_HEADER))
          return {...base, kind: 'xmp-extended', category: 'metadata', note: 'XMP mở rộng'};
        return {...base, kind: 'app', category: 'metadata', note: 'APP1 lạ'};
      case 0xe2:
        if (has(ICC_HEADER)) return {...base, kind: 'icc', category: 'icc'};
        if (has('MPF\0'))
          return {...base, kind: 'mpf', category: 'metadata', note: 'Multi-Picture Format'};
        return {...base, kind: 'app', category: 'metadata', note: 'APP2 lạ'};
      case 0xed:
        if (has(IPTC_HEADER))
          return {...base, kind: 'iptc', category: 'metadata', note: 'IPTC / Photoshop'};
        return {...base, kind: 'app', category: 'metadata', note: 'APP13 lạ'};
      case 0xee:
        // APP14 'Adobe' quyết định cách giải mã màu — bắt buộc giữ, nếu bỏ ảnh sẽ sai màu
        if (has('Adobe')) return {...base, kind: 'adobe-app14', category: 'structural'};
        return {...base, kind: 'app', category: 'metadata', note: 'APP14 lạ'};
      default:
        return {
          ...base,
          kind: 'app',
          category: 'metadata',
          note: `APP${marker - 0xe0}`,
        };
    }
  }
  if (marker === 0xfe) return {...base, kind: 'comment', category: 'metadata'};
  if (marker === 0xda) return {...base, kind: 'sos', category: 'structural'};
  if (marker === 0xdb) return {...base, kind: 'dqt', category: 'structural'};
  if (marker === 0xc4) return {...base, kind: 'dht', category: 'structural'};
  if (marker === 0xdd) return {...base, kind: 'dri', category: 'structural'};
  // 0xCC = DAC (bảng mã hoá số học) và 0xC8 = JPG (dự trữ) KHÔNG phải frame header —
  // nếu xếp nhầm thành 'sof' thì inspect sẽ đọc kích thước ảnh từ payload sai
  if (marker === 0xcc) return {...base, kind: 'dac', category: 'structural'};
  if (marker === 0xc8) return {...base, kind: 'seg', category: 'structural', note: 'JPG (dự trữ)'};
  if (marker >= 0xc0 && marker <= 0xcf) return {...base, kind: 'sof', category: 'structural'};
  return {...base, kind: 'seg', category: 'structural', note: `marker 0x${marker.toString(16)}`};
}

/** Đi qua toàn bộ file JPEG, trả về danh sách segment (kể cả dữ liệu nén và dữ liệu thừa). */
export function parseJpeg(bytes: Uint8Array): JpegParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new CleanerError('corrupt', 'Không phải file JPEG hợp lệ (thiếu chữ ký FF D8 FF).');
  }

  const segments: JpegSegment[] = [
    {marker: 0xd8, kind: 'soi', category: 'structural', start: 0, end: 2, payloadStart: 2},
  ];
  const warnings: string[] = [];
  let pos = 2;
  let sawEoi = false;

  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      throw new CleanerError('corrupt', `Cấu trúc JPEG hỏng tại byte ${pos} (mong đợi marker).`);
    }
    // Bỏ qua byte đệm 0xFF (chuẩn cho phép nhiều 0xFF liền nhau trước marker)
    let mpos = pos;
    while (mpos < bytes.length && bytes[mpos] === 0xff) mpos++;
    if (mpos >= bytes.length) {
      warnings.push('File kết thúc giữa chừng một marker.');
      break;
    }
    const marker = bytes[mpos];
    const segStart = pos;
    pos = mpos + 1;

    if (marker === 0x00) {
      throw new CleanerError('corrupt', `Byte FF 00 nằm ngoài vùng dữ liệu nén tại ${segStart}.`);
    }
    if (marker === 0xd9) {
      segments.push({
        marker,
        kind: 'eoi',
        category: 'structural',
        start: segStart,
        end: pos,
        payloadStart: pos,
      });
      sawEoi = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Marker đứng một mình (TEM/RST) — hiếm khi xuất hiện ở đây nhưng cứ giữ nguyên
      segments.push({
        marker,
        kind: 'seg',
        category: 'structural',
        start: segStart,
        end: pos,
        payloadStart: pos,
      });
      continue;
    }

    if (pos + 2 > bytes.length) {
      throw new CleanerError('truncated', 'File bị cắt cụt giữa chừng (thiếu độ dài segment).');
    }
    const len = u16be(bytes, pos);
    if (len < 2) throw new CleanerError('corrupt', `Độ dài segment không hợp lệ tại ${pos}.`);
    const end = pos + len;
    if (end > bytes.length) {
      throw new CleanerError('truncated', 'File bị cắt cụt giữa chừng (segment dài quá cuối file).');
    }
    const payloadStart = pos + 2;
    segments.push(classifySegment(marker, bytes, segStart, end, payloadStart));
    pos = end;

    if (marker === 0xda) {
      // Sau SOS là dữ liệu nén: chạy tới marker "thật" tiếp theo.
      // Trong vùng này FF 00 là byte chèn, FF D0..D7 là marker restart — đều thuộc dữ liệu.
      const entStart = pos;
      let p = pos;
      let found = false;
      while (p + 1 < bytes.length) {
        if (bytes[p] === 0xff) {
          const nxt = bytes[p + 1];
          if (nxt === 0x00 || (nxt >= 0xd0 && nxt <= 0xd7)) {
            p += 2;
            continue;
          }
          if (nxt === 0xff) {
            p++;
            continue;
          }
          found = true;
          break;
        }
        p++;
      }
      const entEnd = found ? p : bytes.length;
      if (entEnd > entStart) {
        segments.push({
          marker: null,
          kind: 'entropy',
          category: 'structural',
          start: entStart,
          end: entEnd,
          payloadStart: entStart,
        });
      }
      pos = entEnd;
      if (!found) {
        warnings.push('Không tìm thấy marker kết thúc ảnh (EOI) — file có thể bị cắt cụt.');
        break;
      }
    }
  }

  if (sawEoi && pos < bytes.length) {
    segments.push({
      marker: null,
      kind: 'trailing',
      category: 'trailing',
      start: pos,
      end: bytes.length,
      payloadStart: pos,
      note: `${bytes.length - pos} byte dữ liệu ẩn sau EOI`,
    });
  }

  return {segments, warnings};
}

function toSegmentInfo(seg: JpegSegment): SegmentInfo {
  return {kind: seg.kind, bytes: seg.end - seg.start, note: seg.note};
}

/** Bọc một khối TIFF thành segment APP1 EXIF hoàn chỉnh (FF E1 + độ dài + header). */
function buildExifApp1(tiff: Uint8Array): Uint8Array | null {
  const len = tiff.length + 6 + 2;
  if (len > 0xffff) return null; // không vừa một segment — không bao giờ xảy ra với đầu vào hợp lệ
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // 'Exif\0\0'
  seg.set(tiff, 10);
  return seg;
}

/** Bọc packet XMP thành segment APP1 XMP. */
function buildXmpApp1(packet: string): Uint8Array | null {
  const payload = new TextEncoder().encode(packet);
  const len = XMP_HEADER.length + payload.length + 2;
  if (len > 0xffff) return null;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  for (let i = 0; i < XMP_HEADER.length; i++) seg[4 + i] = XMP_HEADER.charCodeAt(i);
  seg.set(payload, 4 + XMP_HEADER.length);
  return seg;
}

/** Chế độ "chỉ xoá GPS": lọc GPS khỏi EXIF/XMP, giữ nguyên mọi thứ khác. */
function cleanJpegGpsOnly(bytes: Uint8Array, segments: JpegSegment[]): CleanResult {
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const parts: Uint8Array[] = [];
  let saidExtended = false;

  for (const seg of segments) {
    const size = seg.end - seg.start;
    if (seg.kind === 'exif') {
      const tiff = bytes.subarray(seg.payloadStart + 6, seg.end);
      let rebuilt: Uint8Array | null = null;
      let gpsRemoved = false;
      let makerNoteRemoved = false;
      try {
        const rw = rewriteTiff(tiff, {
          keepPageTag: () => true,
          keepExifIfd: true,
          keepExifTag: tag => tag !== 0x927c, // MakerNote: offset tuyệt đối + có thể giấu GPS
          keepGpsIfd: false,
          keepInteropIfd: true,
          keepChain: true,
          copyImageData: true,
        });
        rebuilt = rw.data ? buildExifApp1(rw.data) : null;
        gpsRemoved = rw.removedTags.some(t => t.includes('GPS'));
        makerNoteRemoved = rw.removedTags.some(t => t.toLowerCase().includes('927c'));
      } catch {
        rebuilt = null;
      }
      if (rebuilt) {
        parts.push(rebuilt);
        if (gpsRemoved) {
          removed.push({kind: 'exif', bytes: Math.max(0, size - rebuilt.length), note: 'đã gỡ GPS khỏi EXIF'});
        }
        if (makerNoteRemoved) {
          notes.push('Đã xoá MakerNote của hãng (có thể chứa toạ độ ẩn, không thể giữ an toàn).');
        }
      } else {
        // Không viết lại được thì xoá hẳn — an toàn hơn là để GPS sót lại
        removed.push({kind: 'exif', bytes: size, note: 'EXIF hỏng — xoá hẳn để chắc chắn không sót GPS'});
      }
      continue;
    }
    if (seg.kind === 'xmp') {
      const packet = decodeUtf8(bytes.subarray(seg.payloadStart + XMP_HEADER.length, seg.end));
      const scrubbed = scrubXmpGps(packet);
      if (scrubbed.removed > 0) {
        const rebuilt = buildXmpApp1(scrubbed.xml);
        if (rebuilt) {
          parts.push(rebuilt);
          removed.push({
            kind: 'xmp',
            bytes: Math.max(0, size - rebuilt.length),
            note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`,
          });
        } else {
          removed.push({kind: 'xmp', bytes: size});
        }
      } else {
        parts.push(bytes.subarray(seg.start, seg.end));
      }
      continue;
    }
    if (seg.kind === 'xmp-extended') {
      // XMP mở rộng chia packet thành nhiều phần — không thể quét GPS an toàn
      // từng phần, nên xoá hẳn (giống quyết định với MakerNote)
      if (!saidExtended) {
        saidExtended = true;
        notes.push('Đã xoá XMP mở rộng: packet bị chia nhỏ nên không thể quét GPS an toàn.');
      }
      removed.push({kind: 'xmp-extended', bytes: size});
      continue;
    }
    if (seg.category === 'trailing') {
      notes.push(
        `Giữ ${size.toLocaleString('vi-VN')} byte dữ liệu sau ảnh (thường là video motion photo) — LƯU Ý: phần này có thể chứa toạ độ GPS riêng, chế độ "chỉ xoá GPS" chưa quét được vào trong đó.`,
      );
    }
    // Mọi thứ khác giữ nguyên — người dùng chỉ yêu cầu xoá vị trí
    parts.push(bytes.subarray(seg.start, seg.end));
  }

  const bytesRemoved = removed.reduce((sum, r) => sum + Math.max(0, r.bytes), 0);
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

/** Xoá metadata, giữ nguyên 100% dữ liệu ảnh nén (lossless). */
export function cleanJpeg(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {segments} = parseJpeg(bytes);
  if (options.gpsOnly) return cleanJpegGpsOnly(bytes, segments);

  const removed: SegmentInfo[] = [];
  const notes: string[] = [];

  // Giữ hướng xoay / bản quyền: dựng EXIF tối giản từ EXIF gốc bằng bộ viết lại TIFF
  let minimalExif: Uint8Array | null = null;
  const exifSeg = segments.find(s => s.kind === 'exif');
  if (exifSeg) {
    const tiff = bytes.subarray(exifSeg.payloadStart + 6, exifSeg.end);
    const orientation = readOrientation(tiff);
    const keepTags = new Set<number>();
    if (options.keepOrientation && orientation && orientation !== 1) keepTags.add(0x0112);
    if (options.keepCopyright) keepTags.add(0x8298);
    if (keepTags.size > 0) {
      try {
        const rw = rewriteTiff(tiff, {
          keepPageTag: tag => keepTags.has(tag),
          keepExifIfd: false,
          keepGpsIfd: false,
          keepInteropIfd: false,
          keepChain: false,
          copyImageData: false,
        });
        minimalExif = rw.data ? buildExifApp1(rw.data) : null;
      } catch {
        minimalExif = null;
      }
      if (minimalExif) {
        notes.push(
          keepTags.has(0x8298)
            ? 'Đã giữ lại EXIF tối giản (hướng xoay/bản quyền theo lựa chọn).'
            : 'Đã giữ hướng xoay ảnh bằng một EXIF tối giản (chỉ chứa đúng 1 tag Orientation).',
        );
      }
    }
    if (!options.keepOrientation && orientation && orientation !== 1) {
      notes.push(
        'Cảnh báo: ảnh gốc có hướng xoay khác chuẩn — sau khi xoá EXIF, một số ứng dụng sẽ hiển thị ảnh sai chiều.',
      );
    }
  }

  const parts: Uint8Array[] = [];
  const keptKinds: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'jfif-thumb') {
      // Dựng lại header JFIF sạch 14 byte: giữ phiên bản/mật độ điểm ảnh,
      // đặt kích thước thumbnail về 0 và bỏ dữ liệu thumbnail phía sau
      const rebuilt = new Uint8Array(2 + 2 + 14);
      rebuilt[0] = 0xff;
      rebuilt[1] = 0xe0;
      rebuilt[2] = 0x00;
      rebuilt[3] = 0x10; // độ dài 16
      rebuilt.set(bytes.subarray(seg.payloadStart, seg.payloadStart + 12), 4);
      // 2 byte cuối (Xthumbnail/Ythumbnail) để 0
      parts.push(rebuilt);
      keptKinds.push('jfif');
      removed.push({
        kind: 'jfif-thumb',
        bytes: seg.end - seg.start - rebuilt.length,
        note: 'thumbnail nhúng trong header JFIF',
      });
      notes.push('Đã gỡ thumbnail nhúng trong header JFIF (giữ lại thông tin hiển thị).');
      continue;
    }
    const keep =
      seg.category === 'structural' || (seg.category === 'icc' && options.keepIcc);
    if (keep) {
      parts.push(bytes.subarray(seg.start, seg.end));
      keptKinds.push(seg.kind);
    } else {
      removed.push(toSegmentInfo(seg));
    }
  }

  if (minimalExif) {
    // Chèn ngay sau SOI (hoặc sau APP0 JFIF nếu có, theo thông lệ)
    let idx = 1;
    if (keptKinds[1] === 'jfif') idx = 2;
    parts.splice(idx, 0, minimalExif);
  }

  const bytesRemoved = removed.reduce((sum, r) => sum + r.bytes, 0);
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

/** Đọc toàn bộ metadata + phân mức rủi ro, KHÔNG thay đổi file. */
export async function inspectJpeg(bytes: Uint8Array): Promise<MetadataReport> {
  const {segments, warnings} = parseJpeg(bytes);
  const fields: MetadataField[] = [];
  const allWarnings = [...warnings];

  // Kích thước ảnh từ segment SOF: [độ chính xác 1B][cao 2B][rộng 2B]
  const sof = segments.find(s => s.kind === 'sof');
  const height = sof ? u16be(bytes, sof.payloadStart + 1) : undefined;
  const width = sof ? u16be(bytes, sof.payloadStart + 3) : undefined;

  const exifSeg = segments.find(s => s.kind === 'exif');
  const orientation = exifSeg
    ? readOrientation(bytes.subarray(exifSeg.payloadStart + 6, exifSeg.end))
    : undefined;

  // Đọc chi tiết từng trường bằng exifr (bộ phân tích độc lập với bộ xoá)
  const parsed = await parseWithExifr(bytes);
  if (parsed.error) allWarnings.push(`Không đọc được chi tiết metadata: ${parsed.error}`);
  collectExifrFields(parsed.blocks, fields);

  // Chú thích COM (văn bản tự do) — id theo số thứ tự để diff trước/sau ổn định
  segments
    .filter(s => s.kind === 'comment')
    .forEach((c, i) => {
      const text = decodeLatin1(bytes.subarray(c.payloadStart, c.end)).slice(0, 500);
      fields.push({
        id: `jpeg:comment:${i}`,
        group: 'JPEG',
        tag: 'Comment',
        value: text,
        risk: classifyTag('JPEG', 'Comment'),
      });
    });

  const metaSegments = segments
    .filter(s => s.category === 'metadata' || s.category === 'icc' || s.category === 'trailing')
    .map(toSegmentInfo);

  const trailingBytes = segments
    .filter(s => s.category === 'trailing')
    .reduce((sum, s) => sum + (s.end - s.start), 0);
  if (trailingBytes > 0) {
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau ảnh (có thể là video "motion photo", ảnh HDR phụ...). Sẽ bị xoá.`,
    );
  }

  return {
    format: 'jpeg',
    fileSize: bytes.length,
    width,
    height,
    orientation,
    fields,
    metaSegments,
    trailingBytes,
    warnings: allWarnings,
  };
}
