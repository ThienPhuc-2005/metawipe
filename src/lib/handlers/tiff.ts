// Handler file TIFF: viết lại file chỉ giữ tag cần cho hiển thị (whitelist),
// copy nguyên vẹn dữ liệu ảnh. Từ chối các biến thể không xử lý an toàn được:
// BigTIFF, DNG (ảnh RAW), TIFF nén JPEG kiểu cũ có bảng ngoài (tag 512/515-521).

import {CleanerError, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {collectExifrFields, parseWithExifr} from '../exifr-fields';
import {rewriteTiff} from '../tiff-rewrite';
import {scrubXmpGps} from '../xmp-scrub';
import {readOrientation} from './exif';

// Whitelist tag hiển thị — tổng hợp từ TIFF 6.0 + TechNotes (đã tra cứu từng tag):
// cấu trúc con, hình học, strip/tile, màu (kể cả đủ bộ YCbCr 529-532), nén đặc thù,
// độ phân giải, đa trang. Tag lạ/độc quyền tự động bị loại.
const DISPLAY_TAGS = new Set([
  254, 255, // NewSubfileType, SubfileType
  256, 257, 258, 259, 262, 277, // hình học lõi
  273, 278, 279, // strip
  322, 323, 324, 325, // tile
  320, 338, 339, 284, 346, // màu: ColorMap, ExtraSamples, SampleFormat, Planar, Indexed
  529, 530, 531, 532, // đủ bộ YCbCr (thiếu 529 là sai màu)
  301, 318, 319, 290, 291, 321, 340, 341, 280, 281, // màu nâng cao
  332, 333, 334, 336, // ảnh in tách màu
  317, 347, 292, 293, 266, // Predictor, JPEGTables, T4/T6Options, FillOrder
  282, 283, 296, // độ phân giải
  297, 286, 287, // PageNumber, XPosition, YPosition
  330, // SubIFDs (đệ quy trong bộ viết lại)
]);

const ORIENTATION_TAG = 274;
const ICC_TAG = 34675;
const COPYRIGHT_TAG = 33432;
const DNG_VERSION_TAG = 50706;
// JPEG kiểu cũ: các tag bảng/tham số trỏ offset không có độ dài — không thể relocate an toàn
const OLD_JPEG_TAGS = new Set([512, 515, 517, 518, 519, 520, 521]);

interface TiffScan {
  /** Mọi tag gặp trong chuỗi IFD trang (không tính Exif/GPS IFD con). */
  pageTags: Set<number>;
  pageCount: number;
  compressionValues: number[];
}

/** Quét nhẹ chuỗi IFD (kể cả SubIFD) để lấy danh sách tag + số trang. */
function scanTiff(bytes: Uint8Array): TiffScan {
  const little = bytes[0] === 0x49;
  const u16 = (o: number): number =>
    little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
  const u32 = (o: number): number =>
    little
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;

  const pageTags = new Set<number>();
  const compressionValues: number[] = [];
  let pageCount = 0;
  const seen = new Set<number>();

  const scanIfd = (off: number, depth: number): void => {
    if (off === 0 || seen.has(off) || off + 2 > bytes.length || depth > 4 || seen.size > 2048) return;
    seen.add(off);
    const n = u16(off);
    const tableEnd = off + 2 + n * 12;
    if (tableEnd + 4 > bytes.length) return;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      pageTags.add(tag);
      if (tag === 259) {
        // Compression có thể ghi kiểu SHORT hoặc LONG — đọc đúng kiểu và endian
        compressionValues.push(type === 4 ? u32(e + 8) : u16(e + 8));
      }
      if (tag === 330 && (type === 4 || type === 13)) {
        // SubIFD: theo đuôi để guard không bị né
        if (count === 1) scanIfd(u32(e + 8), depth + 1);
        else if (count >= 2 && count <= 32) {
          const vo = u32(e + 8);
          for (let k = 0; k < count && vo + k * 4 + 4 <= bytes.length; k++) {
            scanIfd(u32(vo + k * 4), depth + 1);
          }
        }
      }
    }
  };

  let off = u32(4);
  const chainSeen = new Set<number>();
  while (off !== 0 && !chainSeen.has(off) && pageCount < 600) {
    if (off + 2 > bytes.length) break;
    chainSeen.add(off);
    pageCount++;
    scanIfd(off, 0);
    const n = u16(off);
    const tableEnd = off + 2 + n * 12;
    if (tableEnd + 4 > bytes.length) break;
    off = u32(tableEnd);
  }
  return {pageTags, pageCount, compressionValues};
}

function guardUnsupported(bytes: Uint8Array): void {
  const scan = scanTiff(bytes);
  if (scan.pageTags.has(DNG_VERSION_TAG)) {
    throw new CleanerError(
      'unsupported',
      'File DNG (ảnh RAW dạng TIFF) — xoá metadata sẽ phá dữ liệu RAW, chưa hỗ trợ.',
    );
  }
  if (scan.compressionValues.includes(6)) {
    for (const t of OLD_JPEG_TAGS) {
      if (scan.pageTags.has(t)) {
        throw new CleanerError(
          'unsupported',
          'TIFF nén JPEG kiểu cũ (có bảng tham chiếu ngoài) — không thể viết lại an toàn.',
        );
      }
    }
  }
}

export function cleanTiff(bytes: Uint8Array, options: CleanOptions): CleanResult {
  guardUnsupported(bytes);
  const notes: string[] = [];

  let xmpScrubbed = 0;
  const result = options.gpsOnly
    ? rewriteTiff(bytes, {
        keepPageTag: () => true,
        // XMP (tag 700) có thể chứa toạ độ — gột GPS ngay trong giá trị tag
        transformPageTag: (tag, value) => {
          if (tag !== 700) return undefined;
          try {
            const scrubbed = scrubXmpGps(decodeUtf8(value));
            if (scrubbed.removed === 0) return undefined;
            xmpScrubbed += scrubbed.removed;
            return new TextEncoder().encode(scrubbed.xml);
          } catch {
            return undefined;
          }
        },
        keepExifIfd: true,
        keepExifTag: tag => tag !== 0x927c, // MakerNote có thể giấu GPS + offset tuyệt đối
        keepGpsIfd: false,
        keepInteropIfd: true,
        keepChain: true,
        copyImageData: true,
      })
    : rewriteTiff(bytes, {
        keepPageTag: tag =>
          DISPLAY_TAGS.has(tag) ||
          (options.keepOrientation && tag === ORIENTATION_TAG) ||
          (options.keepIcc && tag === ICC_TAG) ||
          (options.keepCopyright === true && tag === COPYRIGHT_TAG),
        keepExifIfd: false,
        keepGpsIfd: false,
        keepInteropIfd: false,
        keepChain: true,
        copyImageData: true,
      });

  if (!result.data) {
    throw new CleanerError('corrupt', 'TIFF không còn IFD hợp lệ sau khi lọc.');
  }
  if (options.gpsOnly && result.removedTags.some(t => t.includes('MakerNote') || t.includes('927c'))) {
    notes.push('Đã xoá cả MakerNote của hãng máy ảnh (có thể chứa toạ độ ẩn).');
  }
  if (xmpScrubbed > 0) {
    notes.push(`Đã gỡ ${xmpScrubbed} mục GPS trong XMP của TIFF.`);
  }
  for (const w of result.warnings) notes.push(w);

  const removed: SegmentInfo[] = result.removedTags.map(t => ({
    kind: 'tiff-tag',
    bytes: 0,
    note: t,
  }));
  const bytesRemoved = Math.max(0, bytes.length - result.data.length);
  return {data: result.data, removed, bytesRemoved, notes};
}

export async function inspectTiff(bytes: Uint8Array): Promise<MetadataReport> {
  // Kiểm tra cấu trúc trước để file hỏng báo lỗi tử tế (không đọc mù)
  if (bytes.length < 8) throw new CleanerError('corrupt', 'File TIFF quá ngắn.');
  const scan = scanTiff(bytes);
  if (scan.pageCount === 0) throw new CleanerError('corrupt', 'TIFF không có IFD nào.');

  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const allWarnings: string[] = [];

  const parsed = await parseWithExifr(bytes);
  if (parsed.error) allWarnings.push(`Không đọc được chi tiết metadata: ${parsed.error}`);
  collectExifrFields(parsed.blocks, fields);

  const orientation = readOrientation(bytes);
  const width = typeof parsed.blocks.ifd0?.ImageWidth === 'number' ? (parsed.blocks.ifd0.ImageWidth as number) : undefined;
  const height = typeof parsed.blocks.ifd0?.ImageHeight === 'number' ? (parsed.blocks.ifd0.ImageHeight as number) : undefined;

  // Liệt kê các "khối" metadata vật lý ở mức tag
  const META_TAG_LABELS: Array<[number, string]> = [
    [700, 'XMP (tag 700)'],
    [33723, 'IPTC (tag 33723)'],
    [34377, 'Photoshop (tag 34377)'],
    [34665, 'Exif IFD'],
    [34853, 'GPS IFD'],
    [34675, 'ICC profile'],
  ];
  for (const [tag, label] of META_TAG_LABELS) {
    if (scan.pageTags.has(tag)) {
      metaSegments.push({kind: tag === 34675 ? 'icc' : 'tiff-tag', bytes: 0, note: label});
    }
  }
  if (scan.pageCount > 1) {
    allWarnings.push(`TIFF có ${scan.pageCount} trang — tất cả sẽ được làm sạch và giữ nguyên.`);
  }
  if (scan.pageTags.has(DNG_VERSION_TAG)) {
    allWarnings.push('Đây là file DNG (ảnh RAW) — chưa hỗ trợ làm sạch.');
  }

  return {
    format: 'tiff',
    fileSize: bytes.length,
    width,
    height,
    orientation,
    fields,
    metaSegments,
    trailingBytes: 0,
    warnings: allWarnings,
  };
}
