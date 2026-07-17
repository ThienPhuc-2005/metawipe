// Handler PNG: strip chunk metadata trực tiếp trên bytes (lossless).
//
// Cấu trúc PNG = 8 byte chữ ký + chuỗi chunk [độ dài 4B][tên 4B][dữ liệu][CRC 4B].
// Chiến lược an toàn: dùng DANH SÁCH TRẮNG — chỉ giữ chunk quan trọng (critical) và
// các chunk phụ trợ đã biết là vô hại với hiển thị (màu sắc, độ trong suốt, APNG...).
// Mọi chunk phụ trợ khác (tEXt/zTXt/iTXt/tIME/eXIf và cả chunk riêng của phần mềm lạ)
// đều bị xoá — nhờ đó metadata "lạ chưa từng gặp" cũng không lọt lưới.
// Chunk được giữ thì copy nguyên byte (CRC giữ nguyên, không cần tính lại).

import {unzlibSync} from 'fflate';
import {CleanerError, concatParts, asciiAt, u32be, crc32, decodeLatin1, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {collectExifrFields, parseWithExifr} from '../exifr-fields';
import {classifyTag} from '../risk';
import {rewriteTiff} from '../tiff-rewrite';
import {scrubXmpGps} from '../xmp-scrub';
import {readOrientation} from './exif';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Chunk phụ trợ an toàn: ảnh hưởng trực tiếp tới cách hiển thị ảnh, không chứa
// thông tin cá nhân. (tRNS = trong suốt, gAMA/cHRM/sRGB/cICP/sBIT = màu,
// bKGD = nền, pHYs = mật độ điểm ảnh, hIST = histogram bảng màu,
// acTL/fcTL/fdAT = ảnh động APNG, mDCV/cLLI = HDR theo PNG 3 chính thức,
// mDCv/cLLi = tên bản nháp cũ, giữ để tương thích file sinh thời kỳ nháp.)
// Chú ý KHÔNG whitelist sPLT: bảng màu "gợi ý" không ảnh hưởng hiển thị nhưng
// có trường tên dạng văn bản tự do — có thể bị lợi dụng nhét chuỗi tracking.
const SAFE_ANCILLARY = new Set([
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'hIST',
  'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi',
]);

export interface PngChunk {
  type: string;
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
}

export interface PngParseResult {
  chunks: PngChunk[];
  /** Vị trí bắt đầu dữ liệu thừa sau IEND, null nếu không có. */
  trailingStart: number | null;
  warnings: string[];
}

export function parsePng(bytes: Uint8Array): PngParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (bytes.length < 8 || PNG_SIG.some((v, i) => bytes[i] !== v)) {
    throw new CleanerError('corrupt', 'Không phải file PNG hợp lệ (sai chữ ký 8 byte đầu).');
  }

  const chunks: PngChunk[] = [];
  const warnings: string[] = [];
  let pos = 8;
  let sawIend = false;

  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) {
      throw new CleanerError('truncated', 'File PNG bị cắt cụt giữa chừng một chunk.');
    }
    const dlen = u32be(bytes, pos);
    if (dlen > 0x7fffffff) {
      throw new CleanerError('corrupt', `Độ dài chunk không hợp lệ tại byte ${pos}.`);
    }
    const type = asciiAt(bytes, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new CleanerError('corrupt', `Tên chunk không hợp lệ tại byte ${pos + 4}.`);
    }
    const end = pos + 12 + dlen;
    if (end > bytes.length) {
      throw new CleanerError('truncated', `File PNG bị cắt cụt (chunk ${type} dài quá cuối file).`);
    }
    chunks.push({type, start: pos, end, dataStart: pos + 8, dataEnd: pos + 8 + dlen});
    pos = end;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (chunks.length === 0 || chunks[0].type !== 'IHDR') {
    throw new CleanerError('corrupt', 'File PNG thiếu chunk IHDR ở đầu.');
  }
  if (chunks[0].dataEnd - chunks[0].dataStart !== 13) {
    // Chuẩn PNG quy định IHDR đúng 13 byte — sai nghĩa là file giả mạo/hỏng,
    // nếu cứ đọc tiếp sẽ báo kích thước ảnh rác cho người dùng
    throw new CleanerError('corrupt', 'Chunk IHDR sai độ dài (chuẩn PNG yêu cầu đúng 13 byte).');
  }
  if (!sawIend) warnings.push('File PNG thiếu chunk IEND kết thúc — có thể bị cắt cụt.');

  const trailingStart = sawIend && pos < bytes.length ? pos : null;
  return {chunks, trailingStart, warnings};
}

type ChunkCategory = 'structural' | 'metadata' | 'icc';

function isCritical(type: string): boolean {
  // Chữ cái đầu viết HOA = chunk bắt buộc để giải mã ảnh
  return (type.charCodeAt(0) & 0x20) === 0;
}

function classifyChunk(bytes: Uint8Array, chunk: PngChunk): {category: ChunkCategory; kind: string; note?: string} {
  const {type} = chunk;
  if (type === 'iCCP') return {category: 'icc', kind: 'icc', note: 'iCCP'};
  if (isCritical(type)) return {category: 'structural', kind: 'critical', note: type};
  if (SAFE_ANCILLARY.has(type)) return {category: 'structural', kind: 'safe', note: type};
  if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
    const kw = readKeyword(bytes, chunk);
    // XMP có thể nằm trong CẢ 3 loại chunk văn bản (một số tool ghi sai chỗ)
    if (kw === 'XML:com.adobe.xmp') return {category: 'metadata', kind: 'xmp-png', note: `XMP (${type})`};
    // ImageMagick chép NGUYÊN khối EXIF/IPTC mã hoá hex vào text chunk
    if (kw.startsWith('Raw profile type')) return {category: 'metadata', kind: 'raw-profile', note: kw};
    return {category: 'metadata', kind: 'text', note: type};
  }
  if (type === 'tIME') return {category: 'metadata', kind: 'time', note: type};
  if (type === 'eXIf') return {category: 'metadata', kind: 'exif', note: type};
  return {category: 'metadata', kind: 'chunk', note: type};
}

function readKeyword(bytes: Uint8Array, chunk: PngChunk): string {
  let end = chunk.dataStart;
  while (end < chunk.dataEnd && bytes[end] !== 0) end++;
  return decodeLatin1(bytes.subarray(chunk.dataStart, Math.min(end, chunk.dataStart + 90)));
}

/** Dựng một chunk PNG hoàn chỉnh (độ dài + tên + dữ liệu + CRC). */
function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) typeAndData[i] = type.charCodeAt(i);
  typeAndData.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeAndData, 4);
  dv.setUint32(8 + data.length, crc32(typeAndData));
  return out;
}

function buildXmpItxt(packet: string): Uint8Array {
  const kw = 'XML:com.adobe.xmp';
  const payload = new TextEncoder().encode(packet);
  const head = new Uint8Array(kw.length + 5); // kw + \0 + compFlag + compMethod + lang\0 + translated\0
  for (let i = 0; i < kw.length; i++) head[i] = kw.charCodeAt(i);
  return buildPngChunk('iTXt', concatParts([head, payload]));
}

/** Chế độ "chỉ xoá GPS" cho PNG: lọc eXIf + XMP, giữ nguyên mọi chunk khác. */
function cleanPngGpsOnly(bytes: Uint8Array, chunks: PngChunk[], trailingStart: number | null): CleanResult {
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIG)];

  for (const chunk of chunks) {
    const size = chunk.end - chunk.start;
    const cls = classifyChunk(bytes, chunk);
    if (cls.kind === 'exif') {
      const tiff = bytes.slice(chunk.dataStart, chunk.dataEnd);
      let rebuilt: Uint8Array | null = null;
      let gpsRemoved = false;
      try {
        const rw = rewriteTiff(tiff, {
          keepPageTag: () => true,
          keepExifIfd: true,
          keepExifTag: tag => tag !== 0x927c,
          keepGpsIfd: false,
          keepInteropIfd: true,
          keepChain: true,
          copyImageData: true,
        });
        rebuilt = rw.data ? buildPngChunk('eXIf', rw.data) : null;
        gpsRemoved = rw.removedTags.some(t => t.includes('GPS'));
      } catch {
        rebuilt = null;
      }
      if (rebuilt) {
        parts.push(rebuilt);
        if (gpsRemoved) removed.push({kind: 'exif', bytes: size - rebuilt.length, note: 'đã gỡ GPS khỏi eXIf'});
      } else {
        removed.push({kind: 'exif', bytes: size, note: 'eXIf hỏng — xoá hẳn để chắc chắn không sót GPS'});
      }
      continue;
    }
    if (cls.kind === 'raw-profile') {
      // Không thể quét GPS trong khối EXIF mã hoá hex — xoá hẳn cho chắc
      removed.push({
        kind: 'raw-profile',
        bytes: size,
        note: `${cls.note} — bản sao EXIF/IPTC mã hoá hex, có thể chứa GPS`,
      });
      continue;
    }
    if (cls.kind === 'xmp-png') {
      let packet = '';
      try {
        const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
        const sep = data.indexOf(0);
        if (chunk.type === 'iTXt') {
          const compressed = data[sep + 1] === 1;
          let p = sep + 3;
          while (p < data.length && data[p] !== 0) p++;
          p++;
          while (p < data.length && data[p] !== 0) p++;
          p++;
          packet = compressed ? decodeUtf8(unzlibSync(data.slice(p))) : decodeUtf8(data.subarray(p));
        } else if (chunk.type === 'zTXt') {
          packet = decodeUtf8(unzlibSync(data.slice(sep + 2)));
        } else {
          packet = decodeUtf8(data.subarray(sep + 1));
        }
      } catch {
        removed.push({kind: 'xmp-png', bytes: size, note: 'XMP hỏng — xoá hẳn'});
        continue;
      }
      const scrubbed = scrubXmpGps(packet);
      if (scrubbed.removed > 0) {
        const rebuilt = buildXmpItxt(scrubbed.xml);
        parts.push(rebuilt);
        removed.push({
          kind: 'xmp-png',
          bytes: Math.max(0, size - rebuilt.length),
          note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`,
        });
      } else {
        parts.push(bytes.subarray(chunk.start, chunk.end));
      }
      continue;
    }
    // Mọi chunk khác (kể cả tEXt/tIME/chunk lạ) giữ nguyên — chỉ xoá vị trí
    parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  if (trailingStart !== null) {
    notes.push(
      `Giữ ${(bytes.length - trailingStart).toLocaleString('vi-VN')} byte dữ liệu sau IEND — LƯU Ý: phần này có thể chứa toạ độ GPS riêng, chế độ "chỉ xoá GPS" chưa quét được vào trong đó.`,
    );
    parts.push(bytes.subarray(trailingStart));
  }

  const bytesRemoved = removed.reduce((sum, r) => sum + Math.max(0, r.bytes), 0);
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

/** Xoá metadata, giữ nguyên byte mọi chunk cần cho hiển thị (lossless). */
export function cleanPng(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {chunks, trailingStart} = parsePng(bytes);
  if (options.gpsOnly) return cleanPngGpsOnly(bytes, chunks, trailingStart);

  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIG)];

  for (const chunk of chunks) {
    const {category, kind, note} = classifyChunk(bytes, chunk);
    const size = chunk.end - chunk.start;

    // eXIf: nếu người dùng giữ hướng xoay / bản quyền thì dựng lại bản tối giản
    if (kind === 'exif' && (options.keepOrientation || options.keepCopyright)) {
      const tiff = bytes.slice(chunk.dataStart, chunk.dataEnd);
      const orientation = readOrientation(tiff);
      const keepTags = new Set<number>();
      if (options.keepOrientation && orientation && orientation !== 1) keepTags.add(0x0112);
      if (options.keepCopyright) keepTags.add(0x8298);
      if (keepTags.size > 0) {
        let rebuilt: Uint8Array | null = null;
        try {
          const rw = rewriteTiff(tiff, {
            keepPageTag: tag => keepTags.has(tag),
            keepExifIfd: false,
            keepGpsIfd: false,
            keepInteropIfd: false,
            keepChain: false,
            copyImageData: false,
          });
          rebuilt = rw.data ? buildPngChunk('eXIf', rw.data) : null;
        } catch {
          rebuilt = null;
        }
        if (rebuilt) {
          parts.push(rebuilt);
          removed.push({kind, bytes: size - rebuilt.length, note: 'đã lọc, giữ hướng xoay/bản quyền'});
          notes.push('Đã giữ lại eXIf tối giản (hướng xoay/bản quyền theo lựa chọn).');
          continue;
        }
      }
      removed.push({kind, bytes: size, note});
      continue;
    }

    const keep = category === 'structural' || (category === 'icc' && options.keepIcc);
    if (keep) {
      parts.push(bytes.subarray(chunk.start, chunk.end));
    } else {
      removed.push({kind, bytes: size, note});
    }
  }
  if (trailingStart !== null) {
    removed.push({
      kind: 'trailing',
      bytes: bytes.length - trailingStart,
      note: `${bytes.length - trailingStart} byte dữ liệu ẩn sau IEND`,
    });
  }

  const bytesRemoved = removed.reduce((sum, r) => sum + r.bytes, 0);
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

/** Đọc toàn bộ metadata PNG + phân mức rủi ro, KHÔNG thay đổi file. */
export async function inspectPng(bytes: Uint8Array): Promise<MetadataReport> {
  const {chunks, trailingStart, warnings} = parsePng(bytes);
  const fields: MetadataField[] = [];
  const allWarnings = [...warnings];
  const metaSegments: SegmentInfo[] = [];

  const ihdr = chunks[0];
  const width = u32be(bytes, ihdr.dataStart);
  const height = u32be(bytes, ihdr.dataStart + 4);

  // id trường theo số thứ tự từng loại chunk (không dùng offset byte)
  const idCounts = new Map<string, number>();
  for (const chunk of chunks) {
    const cls = classifyChunk(bytes, chunk);
    if (cls.category === 'structural') {
      if (cls.kind === 'critical' && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(chunk.type)) {
        allWarnings.push(
          `Gặp chunk bắt buộc lạ "${chunk.type}" — được giữ nguyên để không hỏng ảnh.`,
        );
      }
      continue;
    }
    metaSegments.push({kind: cls.kind, bytes: chunk.end - chunk.start, note: cls.note});

    const n = idCounts.get(chunk.type) ?? 0;
    idCounts.set(chunk.type, n + 1);
    try {
      await inspectChunkFields(bytes, chunk, `png:${chunk.type}:${n}`, fields);
    } catch {
      allWarnings.push(`Không đọc được nội dung chunk ${chunk.type} (dữ liệu hỏng?).`);
    }
  }

  const trailingBytes = trailingStart !== null ? bytes.length - trailingStart : 0;
  if (trailingBytes > 0) {
    metaSegments.push({kind: 'trailing', bytes: trailingBytes, note: 'dữ liệu ẩn sau IEND'});
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau ảnh. Sẽ bị xoá.`,
    );
  }

  return {
    format: 'png',
    fileSize: bytes.length,
    width,
    height,
    fields,
    metaSegments,
    trailingBytes,
    warnings: allWarnings,
  };
}

async function inspectChunkFields(
  bytes: Uint8Array,
  chunk: PngChunk,
  id: string,
  fields: MetadataField[],
): Promise<void> {
  const {type} = chunk;
  const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);

  if (type === 'tEXt') {
    const sep = data.indexOf(0);
    if (sep < 0) return;
    const keyword = decodeLatin1(data.subarray(0, sep));
    const text = decodeLatin1(data.subarray(sep + 1));
    fields.push({id, group: 'PNG', tag: keyword, value: text.slice(0, 500), risk: classifyTag('PNG', keyword)});
    return;
  }

  if (type === 'zTXt') {
    const sep = data.indexOf(0);
    if (sep < 0 || sep + 2 > data.length) return;
    // data[sep+1] = phương thức nén (0 = zlib)
    const text = decodeLatin1(unzlibSync(data.slice(sep + 2)));
    const keyword = decodeLatin1(data.subarray(0, sep));
    fields.push({id, group: 'PNG', tag: keyword, value: text.slice(0, 500), risk: classifyTag('PNG', keyword)});
    return;
  }

  if (type === 'iTXt') {
    const sep = data.indexOf(0);
    if (sep < 0 || sep + 3 > data.length) return;
    const keyword = decodeLatin1(data.subarray(0, sep));
    const compressed = data[sep + 1] === 1;
    let p = sep + 3;
    while (p < data.length && data[p] !== 0) p++; // bỏ qua language tag
    p++;
    while (p < data.length && data[p] !== 0) p++; // bỏ qua translated keyword
    p++;
    if (p > data.length) return;
    const raw = data.subarray(p);
    const text = compressed ? decodeUtf8(unzlibSync(raw.slice())) : decodeUtf8(raw);
    if (keyword === 'XML:com.adobe.xmp') {
      fields.push({
        id,
        group: 'XMP',
        tag: 'XMP',
        value: `Gói XMP (${text.length.toLocaleString('vi-VN')} ký tự) — thường chứa tên phần mềm, tác giả, lịch sử chỉnh sửa`,
        risk: 'high',
      });
    } else {
      fields.push({id, group: 'PNG', tag: keyword, value: text.slice(0, 500), risk: classifyTag('PNG', keyword)});
    }
    return;
  }

  if (type === 'tIME') {
    if (data.length < 7) return;
    const y = (data[0] << 8) | data[1];
    const pad = (n: number) => String(n).padStart(2, '0');
    fields.push({
      id,
      group: 'PNG',
      tag: 'tIME',
      value: `${y}-${pad(data[2])}-${pad(data[3])} ${pad(data[4])}:${pad(data[5])}:${pad(data[6])} (thời điểm sửa file)`,
      risk: 'medium',
    });
    return;
  }

  if (type === 'eXIf') {
    // eXIf chứa nguyên một khối TIFF/EXIF — đọc bằng exifr như với JPEG
    const parsed = await parseWithExifr(data.slice());
    collectExifrFields(parsed.blocks, fields);
    return;
  }

  if (type === 'iCCP') {
    const keyword = readKeyword(bytes, chunk);
    fields.push({
      id,
      group: 'ICC',
      tag: 'iCCP',
      value: `ICC profile "${keyword}" (thông tin màu — mặc định được giữ)`,
      risk: 'low',
    });
    return;
  }

  fields.push({
    id,
    group: 'PNG',
    tag: type,
    value: `Chunk "${type}" không rõ nguồn gốc, ${(chunk.dataEnd - chunk.dataStart).toLocaleString('vi-VN')} byte`,
    risk: 'medium',
  });
}
