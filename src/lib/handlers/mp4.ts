// Handler MP4/MOV (ISOBMFF): vô hiệu hoá metadata TẠI CHỖ, không re-encode.
//
// Chiến lược "free-in-place": đổi type của box metadata thành 'free' và ghi đè
// toàn bộ nội dung bằng 0. Kích thước file GIỮ NGUYÊN nên mọi offset tuyệt đối
// trong bảng stco/co64 (trỏ vào dữ liệu video trong mdat) không hề xê dịch —
// an toàn tuyệt đối với mọi trình phát, kể cả file "faststart" (moov đứng trước mdat).
//
// Vị trí metadata bị vô hiệu hoá:
// - moov/udta (chứa ©xyz = GPS iPhone, ©too/©swr phần mềm, tag Android...)
// - moov/meta + trak/meta (com.apple.quicktime.* : vị trí, model máy...)
// - trak/udta, box uuid (XMP nhúng)
// - creation_time/modification_time trong mvhd/tkhd/mdhd (ghi 0)
// - dữ liệu thừa sau box cuối cùng

import {CleanerError, asciiAt, decodeUtf8, u16be, u32be} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {osmUrl} from '../risk';

/** Box container thuần — duyệt thẳng vào con (udta chứa ©xyz, ©too... là box con chuẩn). */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra', 'udta',
]);

/** Sample entry video trong stsd — chứa trường compressorname 32 byte (tên encoder). */
const VIDEO_SAMPLE_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp08', 'vp09', 'av01', 's263']);

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

export interface Mp4Box {
  type: string;
  /** Đường dẫn cha, vd 'moov/trak'. */
  path: string;
  start: number;
  end: number;
  /** Sau size+type (+largesize nếu có). Với uuid: sau cả 16 byte usertype. */
  payloadStart: number;
  /** usertype hex nếu là box uuid. */
  usertype?: string;
}

export interface Mp4ParseResult {
  boxes: Mp4Box[];
  trailingStart: number | null;
  warnings: string[];
}

function u64be(b: Uint8Array, o: number): number {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  const v = hi * 0x100000000 + lo;
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new CleanerError('unsupported', 'Box MP4 lớn hơn 8 PB — không hợp lệ.');
  }
  return v;
}

function toHex(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += b[o + i].toString(16).padStart(2, '0');
  return s;
}

export function parseMp4(bytes: Uint8Array): Mp4ParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (bytes.length < 8) throw new CleanerError('corrupt', 'File MP4 quá ngắn.');

  const boxes: Mp4Box[] = [];
  const warnings: string[] = [];
  let trailingStart: number | null = null;

  function walk(start: number, end: number, path: string, depth: number): void {
    if (depth > 16) throw new CleanerError('corrupt', 'Box MP4 lồng quá sâu.');
    const topLevel = path === '';
    let pos = start;
    while (pos < end) {
      if (pos + 8 > end) {
        // QuickTime cho phép udta kết thúc bằng 4 byte 0 (terminator kiểu cũ)
        let allZero = true;
        for (let i = pos; i < end; i++) {
          if (bytes[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero && !topLevel) return;
        if (topLevel && boxes.length > 0) {
          trailingStart = pos;
          return;
        }
        throw new CleanerError('truncated', `File MP4 bị cắt cụt giữa header box (tại ${pos}).`);
      }
      const size32 = u32be(bytes, pos);
      const type = asciiAt(bytes, pos + 4, 4);
      const validType = /^[\x20-\x7e\xa9]{4}$/.test(type);
      if (!validType || (size32 !== 0 && size32 !== 1 && size32 < 8)) {
        // Rác sau box cuối cùng ở cấp cao nhất → coi là dữ liệu thừa, không phải lỗi
        if (topLevel && boxes.length > 0) {
          trailingStart = pos;
          return;
        }
        throw new CleanerError('corrupt', `Box không hợp lệ tại byte ${pos}.`);
      }
      let payloadStart = pos + 8;
      let boxEnd: number;
      if (size32 === 0) {
        // Box kéo dài tới hết vùng chứa — chỉ hợp lệ cho box cuối
        boxEnd = end;
      } else if (size32 === 1) {
        if (pos + 16 > end) throw new CleanerError('truncated', 'Thiếu largesize của box MP4.');
        boxEnd = pos + u64be(bytes, pos + 8);
        payloadStart = pos + 16;
      } else {
        boxEnd = pos + size32;
      }
      if (boxEnd > end) {
        throw new CleanerError('truncated', `Box '${type}' dài quá vùng chứa (tại ${pos}).`);
      }

      const box: Mp4Box = {type, path, start: pos, end: boxEnd, payloadStart};
      if (type === 'uuid') {
        if (payloadStart + 16 > boxEnd) throw new CleanerError('corrupt', 'Box uuid thiếu usertype.');
        box.usertype = toHex(bytes, payloadStart, 16);
        box.payloadStart = payloadStart + 16;
      }
      boxes.push(box);

      if (CONTAINERS.has(type)) {
        walk(box.payloadStart, boxEnd, path ? `${path}/${type}` : type, depth + 1);
      }
      pos = boxEnd;
    }
  }

  walk(0, bytes.length, '', 0);

  if (!boxes.some(b => b.type === 'moov' && b.path === '')) {
    warnings.push('File không có box moov ở cấp cao nhất — có thể là file phân mảnh (streaming).');
  }
  return {boxes, trailingStart, warnings};
}

/** Các trường creation/modification time trong mvhd/tkhd/mdhd. */
function timestampRange(bytes: Uint8Array, box: Mp4Box): {start: number; length: number} | null {
  if (box.payloadStart + 4 > box.end) return null;
  const version = bytes[box.payloadStart];
  const start = box.payloadStart + 4;
  const length = version === 1 ? 16 : 8; // 2 trường u64 hoặc 2 trường u32
  if (start + length > box.end) return null;
  return {start, length};
}

function readTimestamp(bytes: Uint8Array, box: Mp4Box): number | null {
  const range = timestampRange(bytes, box);
  if (!range) return null;
  const version = bytes[box.payloadStart];
  return version === 1 ? u64be(bytes, range.start) : u32be(bytes, range.start);
}

/** Epoch của MP4 là 1904-01-01 (giây). */
function mp4DateToIso(seconds: number): string | null {
  if (!seconds) return null;
  const EPOCH_1904 = Date.UTC(1904, 0, 1) / 1000;
  const d = new Date((EPOCH_1904 + seconds) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Parse chuỗi ISO 6709 kiểu '+21.0285+105.8542+058.9/' → lat/lon. */
export function parseIso6709(s: string): {lat: number; lon: number} | null {
  const m = s.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {lat, lon};
}

const GPS_KEY = 'com.apple.quicktime.location';

function payloadContainsAscii(bytes: Uint8Array, box: Mp4Box, needle: string): boolean {
  outer: for (let i = box.payloadStart; i <= box.end - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

/** Đổi box thành 'free' + ghi đè nội dung bằng 0 (giữ nguyên trường size). */
function freeBoxInPlace(out: Uint8Array, box: Mp4Box): void {
  out[box.start + 4] = 0x66; // 'f'
  out[box.start + 5] = 0x72; // 'r'
  out[box.start + 6] = 0x65; // 'e'
  out[box.start + 7] = 0x65; // 'e'
  // Giữ nguyên largesize (byte 8-16) nếu size==1 để parser vẫn biết độ dài
  const zeroFrom = u32be(out, box.start) === 1 ? box.start + 16 : box.start + 8;
  out.fill(0, zeroFrom, box.end);
}

export function cleanMp4(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {boxes, trailingStart} = parseMp4(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];

  const endLimit = options.gpsOnly || trailingStart === null ? bytes.length : trailingStart;
  const out = bytes.slice(0, endLimit);
  if (trailingStart !== null) {
    if (options.gpsOnly) {
      notes.push(
        `Giữ ${(bytes.length - trailingStart).toLocaleString('vi-VN')} byte dữ liệu sau box cuối — có thể chứa thông tin riêng, chưa quét được.`,
      );
    } else {
      removed.push({
        kind: 'trailing',
        bytes: bytes.length - trailingStart,
        note: 'dữ liệu ẩn sau box cuối cùng',
      });
    }
  }

  const freed = new Set<Mp4Box>();
  const isInsideFreed = (box: Mp4Box): boolean => {
    for (const f of freed) {
      if (box.start >= f.start && box.end <= f.end) return true;
    }
    return false;
  };

  for (const box of boxes) {
    if (isInsideFreed(box)) continue;

    if (options.gpsOnly) {
      // Chỉ vô hiệu hoá đúng những khối chứa vị trí:
      // ©xyz (Android), loci (3GPP), meta Apple, và uuid XMP có chứa GPS
      const isCoord = (box.type === '©xyz' || box.type === 'loci') && box.path.endsWith('udta');
      const isAppleLoc = box.type === 'meta' && payloadContainsAscii(bytes, box, GPS_KEY);
      const isXmpGps =
        box.type === 'uuid' &&
        box.usertype === XMP_UUID &&
        (payloadContainsAscii(bytes, box, 'GPS') || payloadContainsAscii(bytes, box, 'location'));
      if (isCoord || isAppleLoc || isXmpGps) {
        freeBoxInPlace(out, box);
        freed.add(box);
        removed.push({
          kind: isCoord ? 'gps' : isXmpGps ? 'xmp' : 'meta',
          bytes: box.end - box.start,
          note: isCoord
            ? box.type === 'loci'
              ? 'toạ độ GPS (loci 3GPP)'
              : 'toạ độ GPS (©xyz)'
            : isXmpGps
              ? 'toạ độ GPS trong XMP (uuid)'
              : 'khối meta chứa vị trí Apple — vô hiệu hoá cả khối',
        });
      }
      continue;
    }

    const isMetadataBox =
      ((box.type === 'udta' || box.type === 'meta' || box.type === 'meco') &&
        (box.path === '' || box.path === 'moov' || box.path === 'moov/trak')) ||
      (box.type === 'uuid' && (box.path === '' || box.path === 'moov' || box.path === 'moov/trak')) ||
      (box.type === 'prft' && box.path === ''); // ProducerReferenceTime: đồng hồ thật lúc quay

    if (isMetadataBox) {
      freeBoxInPlace(out, box);
      freed.add(box);
      removed.push({
        kind: box.type === 'uuid' ? (box.usertype === XMP_UUID ? 'xmp' : 'uuid') : box.type,
        bytes: box.end - box.start,
        note: `${box.path ? box.path + '/' : ''}${box.type}`,
      });
      continue;
    }

    // Box free/skip/wide CÓ SẴN: editor cũ hay bỏ quên metadata trong đó — ghi 0 nội dung
    if (box.type === 'free' || box.type === 'skip' || box.type === 'wide') {
      let dirty = false;
      for (let i = box.payloadStart; i < box.end; i++) {
        if (bytes[i] !== 0) {
          dirty = true;
          break;
        }
      }
      if (dirty) {
        out.fill(0, box.payloadStart, box.end);
        removed.push({kind: 'free-leftover', bytes: box.end - box.payloadStart, note: `dữ liệu sót trong box ${box.type}`});
      }
      continue;
    }

    // hdlr trong mdia có trường name lộ phần mềm ('Core Media Data Handler', 'GoPro MET'...)
    // — ghi 0 phần name, GIỮ box (hdlr là bắt buộc). Layout: ver/flags 4 + predefined 4 +
    // handler_type 4 + reserved 12 = 24 byte, name từ byte 24 tới hết.
    if (box.type === 'hdlr' && box.path.endsWith('mdia')) {
      const nameStart = box.payloadStart + 24;
      if (nameStart < box.end) {
        let hasName = false;
        for (let i = nameStart; i < box.end; i++) {
          if (bytes[i] !== 0) {
            hasName = true;
            break;
          }
        }
        if (hasName) {
          out.fill(0, nameStart, box.end);
          removed.push({kind: 'handler-name', bytes: 0, note: 'tên phần mềm trong hdlr'});
        }
      }
      continue;
    }

    // compressorname 32 byte trong sample entry video của stsd (tên encoder)
    if (box.type === 'stsd') {
      // stsd là FullBox: ver/flags 4 + entry_count 4, rồi các sample entry là box con
      let p = box.payloadStart + 8;
      let guard = 0;
      while (p + 8 <= box.end && guard++ < 64) {
        const esize = u32be(bytes, p);
        if (esize < 8 || p + esize > box.end) break;
        const etype = asciiAt(bytes, p + 4, 4);
        if (VIDEO_SAMPLE_ENTRIES.has(etype)) {
          // VisualSampleEntry: header 8 + 42 byte trường cố định → compressorname 32 byte
          const cn = p + 8 + 42;
          if (cn + 32 <= p + esize) {
            let hasName = false;
            for (let i = cn; i < cn + 32; i++) {
              if (bytes[i] !== 0) {
                hasName = true;
                break;
              }
            }
            if (hasName) {
              out.fill(0, cn, cn + 32);
              removed.push({kind: 'handler-name', bytes: 0, note: `tên encoder trong ${etype}`});
            }
          }
        }
        p += esize;
      }
      continue;
    }

    // Ghi 0 vào creation/modification time (kiểm CẢ range — không chỉ creation_time,
    // vì file thật có thể có creation=0 nhưng modification≠0)
    if (box.type === 'mvhd' || box.type === 'tkhd' || box.type === 'mdhd') {
      const range = timestampRange(bytes, box);
      if (range) {
        let hasTime = false;
        for (let i = range.start; i < range.start + range.length; i++) {
          if (bytes[i] !== 0) {
            hasTime = true;
            break;
          }
        }
        if (hasTime) {
          out.fill(0, range.start, range.start + range.length);
          removed.push({kind: 'timestamp', bytes: 0, note: `thời gian tạo/sửa trong ${box.type}`});
        }
      }
    }
  }

  if (freed.size > 0) {
    notes.push(
      'Các khối metadata được đổi thành vùng trống (free) và ghi đè bằng 0 — kích thước file giữ nguyên để không xê dịch offset video (an toàn tuyệt đối, không re-encode).',
    );
  }

  // File-in-place: kích thước KHÔNG đổi (trừ khi cắt trailing) — báo cáo đúng lượng
  // byte thật sự giảm để UI không nói "nhẹ đi X" sai
  const bytesRemoved = bytes.length - out.length;
  return {data: out, removed, bytesRemoved, notes};
}

/** Đọc các entry ©xxx trong udta: [u16 size][u16 lang][chuỗi]. */
function readUdtaText(bytes: Uint8Array, box: Mp4Box): string | null {
  if (box.payloadStart + 4 > box.end) return null;
  const len = u16be(bytes, box.payloadStart);
  const start = box.payloadStart + 4;
  if (start + len > box.end) return null;
  return decodeUtf8(bytes.subarray(start, start + len));
}

const UDTA_LABELS: Record<string, {tag: string; risk: 'high' | 'medium' | 'low'}> = {
  '©xyz': {tag: 'Toạ độ GPS (©xyz)', risk: 'high'},
  '©too': {tag: 'Phần mềm tạo file', risk: 'medium'},
  '©swr': {tag: 'Phần mềm', risk: 'medium'},
  '©day': {tag: 'Ngày quay', risk: 'medium'},
  '©mak': {tag: 'Hãng máy', risk: 'medium'},
  '©mod': {tag: 'Model máy', risk: 'medium'},
  '©nam': {tag: 'Tên video', risk: 'medium'},
  '©cmt': {tag: 'Chú thích', risk: 'medium'},
  '©aut': {tag: 'Tác giả', risk: 'high'},
};

export async function inspectMp4(bytes: Uint8Array): Promise<MetadataReport> {
  const {boxes, trailingStart, warnings} = parseMp4(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const allWarnings = [...warnings];
  const counters = new Map<string, number>();
  const nextId = (k: string): string => {
    const n = counters.get(k) ?? 0;
    counters.set(k, n + 1);
    return `mp4:${k}:${n}`;
  };

  let width: number | undefined;
  let height: number | undefined;

  for (const box of boxes) {
    // Kích thước từ tkhd (fixed-point 16.16, nằm cuối payload)
    if (box.type === 'tkhd' && width === undefined) {
      const version = bytes[box.payloadStart];
      const off = box.payloadStart + (version === 1 ? 88 : 76);
      if (off + 8 <= box.end) {
        const w = u32be(bytes, off) >>> 16;
        const h = u32be(bytes, off + 4) >>> 16;
        if (w > 0 && h > 0) {
          width = w;
          height = h;
        }
      }
    }

    if (box.type === 'mvhd') {
      const created = readTimestamp(bytes, box);
      const iso = created ? mp4DateToIso(created) : null;
      if (iso) {
        fields.push({
          id: nextId('created'),
          group: 'MP4',
          tag: 'Thời gian tạo',
          value: iso,
          risk: 'medium',
        });
      }
    }

    // loci: box vị trí 3GPP (Android/Nokia cũ) — cấu trúc phức, chỉ báo là có GPS
    if (box.type === 'loci' && box.path.endsWith('udta')) {
      metaSegments.push({kind: 'gps', bytes: box.end - box.start, note: 'loci (GPS 3GPP)'});
      fields.push({
        id: nextId('loci'),
        group: 'GPS',
        tag: 'Toạ độ GPS (loci 3GPP)',
        value: `${(box.end - box.start).toLocaleString('vi-VN')} byte`,
        risk: 'high',
      });
    }

    if (box.path.endsWith('udta') && box.type.startsWith('©')) {
      const text = readUdtaText(bytes, box);
      const label = UDTA_LABELS[box.type] ?? {tag: box.type, risk: 'medium' as const};
      if (box.type === '©xyz' && text) {
        const gps = parseIso6709(text);
        fields.push({
          id: nextId('gps'),
          group: 'GPS',
          tag: 'Toạ độ GPS',
          value: gps ? `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}` : text,
          risk: 'high',
          mapUrl: gps ? osmUrl(gps.lat, gps.lon) : undefined,
        });
      } else {
        fields.push({
          id: nextId(box.type),
          group: 'MP4',
          tag: label.tag,
          value: text ?? `${box.end - box.start} byte`,
          risk: label.risk,
        });
      }
    }

    if ((box.type === 'udta' || box.type === 'meta') && (box.path === 'moov' || box.path === 'moov/trak')) {
      metaSegments.push({kind: box.type, bytes: box.end - box.start, note: `${box.path}/${box.type}`});
      if (box.type === 'meta') {
        const hasLocation = payloadContainsAscii(bytes, box, GPS_KEY);
        fields.push({
          id: nextId('meta'),
          group: 'MP4',
          tag: 'Khối meta Apple/Android',
          value: `${(box.end - box.start).toLocaleString('vi-VN')} byte (model máy, phần mềm${hasLocation ? ', CÓ VỊ TRÍ' : ''}…)`,
          risk: hasLocation ? 'high' : 'medium',
        });
      }
    }
    if (box.type === 'uuid' && (box.path === '' || box.path === 'moov')) {
      metaSegments.push({
        kind: box.usertype === XMP_UUID ? 'xmp' : 'uuid',
        bytes: box.end - box.start,
        note: box.usertype === XMP_UUID ? 'XMP nhúng (uuid)' : `uuid ${box.usertype?.slice(0, 8)}…`,
      });
      fields.push({
        id: nextId('uuid'),
        group: 'MP4',
        tag: box.usertype === XMP_UUID ? 'XMP' : 'uuid',
        value: `${(box.end - box.start).toLocaleString('vi-VN')} byte`,
        risk: 'high',
      });
    }
  }

  const trailingBytes = trailingStart !== null ? bytes.length - trailingStart : 0;
  if (trailingBytes > 0) {
    metaSegments.push({kind: 'trailing', bytes: trailingBytes, note: 'dữ liệu ẩn sau box cuối'});
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau video. Sẽ bị xoá.`,
    );
  }

  return {
    format: 'mp4',
    fileSize: bytes.length,
    width,
    height,
    fields,
    metaSegments,
    trailingBytes,
    warnings: allWarnings,
  };
}
