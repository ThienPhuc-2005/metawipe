// Handler WebP: strip chunk EXIF/XMP trong RIFF container (lossless).
//
// Chi tiết đã xác minh với spec + mã nguồn libwebp:
// - Chunk: FourCC + size u32 LE (chỉ đếm payload) + payload + 1 byte đệm nếu size lẻ.
// - VP8X payload 10 byte; byte 0 là cờ: ICC=0x20, Alpha=0x10, EXIF=0x08, XMP=0x04, Anim=0x02.
// - Xoá chunk EXIF/XMP thì PHẢI tắt cờ tương ứng (mux libwebp từ chối file lệch cờ),
//   và cập nhật lại RIFF File Size ở offset 4 (= tổng file - 8).
// - FourCC chính xác: 'EXIF' (hoa), 'XMP ' (có dấu cách), 'ICCP'.

import {CleanerError, concatParts, asciiAt, decodeUtf8, startsWithAscii} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {collectExifrFields, parseWithExifr} from '../exifr-fields';
import {rewriteTiff} from '../tiff-rewrite';
import {scrubXmpGps} from '../xmp-scrub';
import {readOrientation} from './exif';

const STRUCTURAL = new Set(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ALPH', 'VP8 ', 'VP8L']);

const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

export interface WebpChunk {
  fourcc: string;
  start: number;
  /** Hết chunk KỂ CẢ byte đệm. */
  end: number;
  dataStart: number;
  dataEnd: number;
}

export interface WebpParseResult {
  chunks: WebpChunk[];
  /** Byte thừa sau vùng RIFF khai báo. */
  trailingStart: number | null;
  warnings: string[];
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function parseWebp(bytes: Uint8Array): WebpParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (
    bytes.length < 12 ||
    !startsWithAscii(bytes, 0, 'RIFF') ||
    !startsWithAscii(bytes, 8, 'WEBP')
  ) {
    throw new CleanerError('corrupt', 'Không phải file WebP hợp lệ (thiếu RIFF/WEBP).');
  }
  const riffSize = u32le(bytes, 4);
  const declaredEnd = 8 + riffSize;
  if (declaredEnd > bytes.length) {
    throw new CleanerError('truncated', 'File WebP bị cắt cụt (RIFF size vượt quá cuối file).');
  }
  const warnings: string[] = [];

  const chunks: WebpChunk[] = [];
  let pos = 12;
  while (pos < declaredEnd) {
    if (pos + 8 > declaredEnd) {
      throw new CleanerError('truncated', 'File WebP bị cắt cụt giữa chừng một chunk.');
    }
    const fourcc = asciiAt(bytes, pos, 4);
    if (!/^[\x20-\x7e]{4}$/.test(fourcc)) {
      throw new CleanerError('corrupt', `FourCC không hợp lệ tại byte ${pos}.`);
    }
    const size = u32le(bytes, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    const end = dataEnd + (size % 2); // byte đệm khi size lẻ
    if (dataEnd > declaredEnd) {
      throw new CleanerError('truncated', `Chunk ${fourcc} dài quá vùng RIFF khai báo.`);
    }
    chunks.push({fourcc, start: pos, end: Math.min(end, declaredEnd), dataStart, dataEnd});
    pos = end;
  }

  const trailingStart = declaredEnd < bytes.length ? declaredEnd : null;
  return {chunks, trailingStart, warnings};
}

/** Payload EXIF trong WebP đôi khi kèm tiền tố 'Exif\0\0' — chuẩn hoá về TIFF trần. */
function exifPayloadToTiff(bytes: Uint8Array, chunk: WebpChunk): Uint8Array {
  if (startsWithAscii(bytes, chunk.dataStart, 'Exif\0\0')) {
    return bytes.slice(chunk.dataStart + 6, chunk.dataEnd);
  }
  return bytes.slice(chunk.dataStart, chunk.dataEnd);
}

function classify(chunk: WebpChunk): {kind: string; category: 'structural' | 'icc' | 'metadata'} {
  if (chunk.fourcc === 'ICCP') return {kind: 'icc', category: 'icc'};
  if (STRUCTURAL.has(chunk.fourcc)) return {kind: 'structural', category: 'structural'};
  if (chunk.fourcc === 'EXIF') return {kind: 'exif', category: 'metadata'};
  if (chunk.fourcc === 'XMP ') return {kind: 'xmp', category: 'metadata'};
  return {kind: 'chunk', category: 'metadata'};
}

function buildChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  for (let i = 0; i < 4; i++) head[i] = fourcc.charCodeAt(i);
  const size = payload.length;
  head[4] = size & 0xff;
  head[5] = (size >>> 8) & 0xff;
  head[6] = (size >>> 16) & 0xff;
  head[7] = (size >>> 24) & 0xff;
  const parts = [head, payload];
  if (size % 2 === 1) parts.push(new Uint8Array([0]));
  return concatParts(parts);
}

function readDimensions(bytes: Uint8Array, chunks: WebpChunk[]): {width?: number; height?: number} {
  const vp8x = chunks.find(c => c.fourcc === 'VP8X');
  if (vp8x && vp8x.dataEnd - vp8x.dataStart >= 10) {
    const o = vp8x.dataStart + 4;
    const w = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + 1;
    const h = (bytes[o + 3] | (bytes[o + 4] << 8) | (bytes[o + 5] << 16)) + 1;
    return {width: w, height: h};
  }
  const vp8 = chunks.find(c => c.fourcc === 'VP8 ');
  if (vp8 && vp8.dataEnd - vp8.dataStart >= 10) {
    const o = vp8.dataStart;
    // Key frame: 3 byte frame tag + start code 9D 01 2A + w/h (14 bit mỗi chiều)
    if (bytes[o + 3] === 0x9d && bytes[o + 4] === 0x01 && bytes[o + 5] === 0x2a) {
      return {
        width: (bytes[o + 6] | (bytes[o + 7] << 8)) & 0x3fff,
        height: (bytes[o + 8] | (bytes[o + 9] << 8)) & 0x3fff,
      };
    }
  }
  const vp8l = chunks.find(c => c.fourcc === 'VP8L');
  if (vp8l && vp8l.dataEnd - vp8l.dataStart >= 5 && bytes[vp8l.dataStart] === 0x2f) {
    const o = vp8l.dataStart + 1;
    const bits = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1};
  }
  return {};
}

export function cleanWebp(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {chunks, trailingStart} = parseWebp(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const outChunks: Uint8Array[] = [];
  let hasExifOut = false;
  let hasXmpOut = false;
  let hasIccOut = false;
  let vp8xIndex = -1;

  for (const chunk of chunks) {
    const {kind, category} = classify(chunk);
    const size = chunk.end - chunk.start;

    if (chunk.fourcc === 'VP8X') {
      vp8xIndex = outChunks.length;
      outChunks.push(bytes.slice(chunk.start, chunk.end)); // copy để sửa cờ sau
      continue;
    }
    if (category === 'structural') {
      outChunks.push(bytes.subarray(chunk.start, chunk.end));
      continue;
    }
    if (category === 'icc') {
      if (options.keepIcc || options.gpsOnly) {
        outChunks.push(bytes.subarray(chunk.start, chunk.end));
        hasIccOut = true;
      } else {
        removed.push({kind: 'icc', bytes: size});
      }
      continue;
    }
    if (kind === 'exif') {
      const tiff = exifPayloadToTiff(bytes, chunk);
      let newTiff: Uint8Array | null = null;
      if (options.gpsOnly) {
        try {
          newTiff = rewriteTiff(tiff, {
            keepPageTag: () => true,
            keepExifIfd: true,
            // MakerNote chứa offset tuyệt đối + có thể giấu GPS của hãng — bỏ
            keepExifTag: tag => tag !== 0x927c,
            keepGpsIfd: false,
            keepInteropIfd: true,
            keepChain: true,
            copyImageData: true,
          }).data;
        } catch {
          notes.push('EXIF trong WebP hỏng — đã xoá hẳn thay vì chỉ lọc GPS.');
        }
      } else if (options.keepOrientation || options.keepCopyright) {
        const orientation = readOrientation(tiff);
        const keep = new Set<number>();
        if (options.keepOrientation && orientation && orientation !== 1) keep.add(0x0112);
        if (options.keepCopyright) keep.add(0x8298);
        if (keep.size > 0) {
          try {
            newTiff = rewriteTiff(tiff, {
              keepPageTag: tag => keep.has(tag),
              keepExifIfd: false,
              keepGpsIfd: false,
              keepInteropIfd: false,
              keepChain: false,
              copyImageData: false,
            }).data;
          } catch {
            newTiff = null;
          }
        }
      }
      if (newTiff) {
        const newChunk = buildChunk('EXIF', newTiff);
        outChunks.push(newChunk);
        hasExifOut = true;
        removed.push({kind: 'exif', bytes: Math.max(0, size - newChunk.length), note: 'đã lọc bớt'});
      } else {
        removed.push({kind: 'exif', bytes: size});
      }
      continue;
    }
    if (kind === 'xmp') {
      if (options.gpsOnly) {
        const xml = decodeUtf8(bytes.subarray(chunk.dataStart, chunk.dataEnd));
        const scrubbed = scrubXmpGps(xml);
        if (scrubbed.removed > 0) {
          const rebuilt = buildChunk('XMP ', new TextEncoder().encode(scrubbed.xml));
          outChunks.push(rebuilt);
          removed.push({
            kind: 'xmp',
            bytes: Math.max(0, size - rebuilt.length),
            note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`,
          });
        } else {
          // Không có gì để gỡ: copy nguyên byte — re-encode UTF-8 sẽ âm thầm
          // làm mất BOM / đổi byte không hợp lệ dù ta không đụng gì
          outChunks.push(bytes.subarray(chunk.start, chunk.end));
        }
        hasXmpOut = true;
      } else {
        removed.push({kind: 'xmp', bytes: size});
      }
      continue;
    }
    // Chunk lạ: chế độ chỉ-xoá-GPS thì giữ, còn lại xoá theo triết lý whitelist
    if (options.gpsOnly) {
      outChunks.push(bytes.subarray(chunk.start, chunk.end));
    } else {
      removed.push({kind: 'chunk', bytes: size, note: chunk.fourcc});
    }
  }

  // Dữ liệu thừa nằm NGOÀI vùng RIFF — tuyệt đối không gộp vào RIFF size,
  // nếu không decoder sẽ đọc rác như chunk và từ chối cả file
  let trailingKept: Uint8Array | null = null;
  if (trailingStart !== null) {
    const size = bytes.length - trailingStart;
    if (options.gpsOnly) {
      notes.push(
        `Giữ ${size.toLocaleString('vi-VN')} byte dữ liệu sau vùng RIFF (thường là video/ảnh phụ) — LƯU Ý: phần này có thể chứa toạ độ GPS riêng, chế độ "chỉ xoá GPS" chưa quét được vào trong đó.`,
      );
      trailingKept = bytes.subarray(trailingStart);
    } else {
      removed.push({kind: 'trailing', bytes: size, note: `${size} byte dữ liệu ẩn sau vùng RIFF`});
    }
  }

  // Cập nhật cờ VP8X cho khớp các chunk còn lại (mux libwebp từ chối file lệch cờ)
  if (vp8xIndex >= 0) {
    const vp8x = outChunks[vp8xIndex];
    if (vp8x.length >= 9) {
      let flags = vp8x[8];
      if (!hasExifOut) flags &= ~FLAG_EXIF;
      if (!hasXmpOut) flags &= ~FLAG_XMP;
      if (!hasIccOut) flags &= ~FLAG_ICC;
      vp8x[8] = flags;
    }
  }

  const body = concatParts(outChunks);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  const riffSize = body.length + 4; // + 4 byte 'WEBP'
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >>> 8) & 0xff;
  header[6] = (riffSize >>> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP

  const bytesRemoved = removed.reduce((sum, r) => sum + Math.max(0, r.bytes), 0);
  const parts = trailingKept ? [header, body, trailingKept] : [header, body];
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

export async function inspectWebp(bytes: Uint8Array): Promise<MetadataReport> {
  const {chunks, trailingStart, warnings} = parseWebp(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const allWarnings = [...warnings];

  const {width, height} = readDimensions(bytes, chunks);
  let orientation: number | undefined;
  // id trường theo số thứ tự (không dùng offset byte) để so sánh trước/sau ổn định
  let xmpIndex = 0;
  let chunkIndex = 0;

  for (const chunk of chunks) {
    const {kind, category} = classify(chunk);
    if (category === 'structural') continue;
    const size = chunk.end - chunk.start;
    metaSegments.push({kind, bytes: size, note: chunk.fourcc});

    if (kind === 'exif') {
      const tiff = exifPayloadToTiff(bytes, chunk);
      orientation = orientation ?? readOrientation(tiff);
      const parsed = await parseWithExifr(tiff);
      if (parsed.error) allWarnings.push(`Không đọc được EXIF trong WebP: ${parsed.error}`);
      collectExifrFields(parsed.blocks, fields);
    } else if (kind === 'xmp') {
      const xml = decodeUtf8(bytes.subarray(chunk.dataStart, chunk.dataEnd));
      const hasGps = /GPS\w+/i.test(xml);
      fields.push({
        id: `webp:xmp:${xmpIndex++}`,
        group: 'XMP',
        tag: 'XMP',
        value: `Gói XMP (${xml.length.toLocaleString('vi-VN')} ký tự)${hasGps ? ' — CÓ chứa toạ độ GPS' : ''}`,
        risk: 'high',
      });
    } else if (kind === 'chunk') {
      fields.push({
        id: `webp:chunk:${chunk.fourcc}:${chunkIndex++}`,
        group: 'WebP',
        tag: chunk.fourcc,
        value: `Chunk lạ ${size.toLocaleString('vi-VN')} byte`,
        risk: 'medium',
      });
    }
  }

  const trailingBytes = trailingStart !== null ? bytes.length - trailingStart : 0;
  if (trailingBytes > 0) {
    metaSegments.push({kind: 'trailing', bytes: trailingBytes, note: 'dữ liệu ẩn sau vùng RIFF'});
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau ảnh. Sẽ bị xoá.`,
    );
  }

  return {
    format: 'webp',
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
