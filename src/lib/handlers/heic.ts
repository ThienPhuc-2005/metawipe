// Handler HEIC/HEIF: KHÔNG strip tại chỗ được (metadata nằm sâu trong cấu trúc box
// có offset chồng chéo) → giải mã bằng libheif (WASM, nạp lười) rồi xuất PNG sạch.
// Người dùng được báo rõ là có chuyển đổi định dạng.

import {CleanerError} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {collectExifrFields, parseWithExifr} from '../exifr-fields';
import {encodePngRgba} from '../png-encode';

export interface HeifImageLike {
  get_width(): number;
  get_height(): number;
  display(
    base: {data: Uint8ClampedArray; width: number; height: number},
    callback: (result: unknown) => void,
  ): void;
  free?(): void;
}

export interface HeifDecoderLike {
  decode(data: Uint8Array): HeifImageLike[];
}

let decoderFactory: () => Promise<HeifDecoderLike> = defaultFactory;

async function defaultFactory(): Promise<HeifDecoderLike> {
  // Nạp lười WASM ~1MB — chỉ tải khi thực sự gặp file HEIC
  const lib = (await import('libheif-js/wasm-bundle')) as unknown as {
    default?: {HeifDecoder: new () => HeifDecoderLike};
    HeifDecoder?: new () => HeifDecoderLike;
  };
  const Decoder = lib.HeifDecoder ?? lib.default?.HeifDecoder;
  if (!Decoder) throw new CleanerError('unsupported', 'Không nạp được bộ giải mã HEIC.');
  return new Decoder();
}

/** Cho phép unit test tiêm decoder giả (không cần WASM trong Node). */
export function setHeifDecoderFactory(factory: (() => Promise<HeifDecoderLike>) | null): void {
  decoderFactory = factory ?? defaultFactory;
}

// Trần 50MP (đủ cho iPhone 48MP): mỗi ảnh cần ~4 byte/pixel cho RGBA + 1 bản
// copy khi đóng gói PNG — 50MP đã chiếm ~400MB đỉnh, cao hơn nữa dễ sập tab
const MAX_PIXELS = 50_000_000;

async function decodeToRgba(
  bytes: Uint8Array,
): Promise<{rgba: Uint8Array; width: number; height: number}> {
  const decoder = await decoderFactory();
  let images: HeifImageLike[];
  try {
    images = decoder.decode(bytes);
  } catch (err) {
    throw new CleanerError('corrupt', `Không giải mã được HEIC: ${err instanceof Error ? err.message : err}`);
  }
  if (!images || images.length === 0) {
    throw new CleanerError('corrupt', 'File HEIC không chứa ảnh giải mã được.');
  }
  try {
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) {
      throw new CleanerError('corrupt', `Kích thước ảnh HEIC bất thường (${width}×${height}).`);
    }
    if (width * height > MAX_PIXELS) {
      throw new CleanerError(
        'unsupported',
        `Ảnh HEIC ${width}×${height} vượt trần 50 triệu pixel — chuyển đổi sẽ tốn quá nhiều bộ nhớ.`,
      );
    }
    const target = {data: new Uint8ClampedArray(width * height * 4), width, height};
    const ok = await new Promise<unknown>(resolve => image.display(target, resolve));
    if (!ok) throw new CleanerError('corrupt', 'Giải mã pixel HEIC thất bại.');
    return {
      rgba: new Uint8Array(target.data.buffer, target.data.byteOffset, target.data.byteLength),
      width,
      height,
    };
  } finally {
    for (const img of images) {
      try {
        img.free?.();
      } catch {
        // bỏ qua lỗi giải phóng
      }
    }
  }
}

export async function cleanHeic(bytes: Uint8Array, options: CleanOptions): Promise<CleanResult> {
  const {rgba, width, height} = await decodeToRgba(bytes);
  const png = encodePngRgba(rgba, width, height);
  const notes = [
    'HEIC không thể xoá metadata tại chỗ — ảnh đã được CHUYỂN SANG PNG. ' +
      'Pixel giữ nguyên như ảnh giải mã, nhưng file PNG có thể nặng hơn file HEIC gốc.',
  ];
  if (options.gpsOnly) {
    notes.push('Chế độ "chỉ xoá GPS" không áp dụng được cho HEIC — toàn bộ metadata đã bị bỏ khi chuyển đổi.');
  }
  if (options.keepIcc) {
    notes.push('ICC profile không giữ được khi chuyển đổi — màu đã được quy về khi giải mã.');
  }
  const removed: SegmentInfo[] = [
    {kind: 'converted', bytes: bytes.length, note: 'toàn bộ metadata biến mất khi chuyển HEIC → PNG'},
  ];
  return {data: png, removed, bytesRemoved: 0, notes, convertedTo: 'png'};
}

export async function inspectHeic(bytes: Uint8Array): Promise<MetadataReport> {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const warnings: string[] = [
    'File HEIC sẽ được CHUYỂN SANG PNG khi làm sạch (không strip tại chỗ được).',
  ];

  // exifr đọc được EXIF/XMP/ICC trong container HEIC
  const parsed = await parseWithExifr(bytes);
  if (parsed.error) warnings.push(`Không đọc được chi tiết metadata: ${parsed.error}`);
  collectExifrFields(parsed.blocks, fields);

  if (parsed.blocks.ifd0 || parsed.blocks.exif || parsed.blocks.gps) {
    metaSegments.push({kind: 'exif', bytes: 0, note: 'EXIF trong box meta'});
  }
  if (parsed.blocks.xmp) metaSegments.push({kind: 'xmp', bytes: 0, note: 'XMP trong box meta'});
  if (parsed.blocks.icc) metaSegments.push({kind: 'icc', bytes: 0, note: 'ICC trong box meta'});

  const w = parsed.blocks.exif?.ExifImageWidth ?? parsed.blocks.ifd0?.ImageWidth;
  const h = parsed.blocks.exif?.ExifImageHeight ?? parsed.blocks.ifd0?.ImageHeight;
  const ori = parsed.blocks.ifd0?.Orientation;

  return {
    format: 'heic',
    fileSize: bytes.length,
    width: typeof w === 'number' ? w : undefined,
    height: typeof h === 'number' ? h : undefined,
    orientation: typeof ori === 'number' ? ori : undefined,
    fields,
    metaSegments,
    trailingBytes: 0,
    warnings,
  };
}
