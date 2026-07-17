// Đọc metadata chi tiết bằng thư viện exifr rồi đổ về danh sách MetadataField
// có phân mức rủi ro. exifr là bộ phân tích ĐỘC LẬP với bộ xoá của chúng ta —
// nhờ đó unit test "xoá xong đọc lại phải rỗng" mới có ý nghĩa kiểm chứng chéo.

import exifr from 'exifr';
import type {MetadataField} from './types';
import {classifyTag, dmsToDecimal, osmUrl} from './risk';

export interface ExifrResult {
  blocks: Record<string, Record<string, unknown>>;
  error?: string;
}

// Kiểu TS của exifr hẹp hơn API thật (boolean cho từng block là hợp lệ lúc chạy)
const EXIFR_OPTIONS = {
  ifd0: true,
  exif: true,
  gps: true,
  interop: false,
  ifd1: false,
  xmp: true,
  iptc: true,
  icc: true,
  mergeOutput: false,
} as unknown as Parameters<typeof exifr.parse>[1];

const BLOCK_LABELS: Record<string, string> = {
  ifd0: 'EXIF',
  exif: 'EXIF',
  gps: 'GPS',
  xmp: 'XMP',
  iptc: 'IPTC',
  icc: 'ICC',
};

// Các khóa cấp 1 mà exifr trả về KHÔNG phải namespace XMP. Với mergeOutput:false,
// exifr 7.x trả MỖI namespace XMP (dc, photoshop, xmpMM, aux, crs...) thành một
// khóa cấp 1 riêng — nếu chỉ nhặt khóa cố định thì tên tác giả (dc:creator),
// địa điểm (photoshop:City)... sẽ rơi khỏi báo cáo một cách im lặng.
const NON_XMP_KEYS = new Set([
  'ifd0', 'exif', 'gps', 'iptc', 'icc', 'ifd1', 'interop', 'thumbnail',
  'makerNote', 'userComment', 'jfif', 'ihdr', 'errors', 'xmp',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v)
  );
}

/** Chạy exifr trên bytes (JPEG nguyên file hoặc khối TIFF trần từ PNG eXIf). */
export async function parseWithExifr(bytes: Uint8Array): Promise<ExifrResult> {
  try {
    const out = (await exifr.parse(bytes, EXIFR_OPTIONS)) as
      | Record<string, unknown>
      | undefined;
    if (!out) return {blocks: {}};
    const blocks: Record<string, Record<string, unknown>> = {};
    for (const key of Object.keys(BLOCK_LABELS)) {
      const block = out[key];
      if (key !== 'xmp' && isPlainObject(block)) {
        blocks[key] = block;
      }
    }

    // Gom XMP: khóa 'xmp' (namespace xap) + MỌI khóa cấp 1 lạ khác (mỗi cái là
    // một namespace XMP), thêm tiền tố 'namespace:' để người dùng biết nguồn gốc
    const xmp: Record<string, unknown> = {};
    if (isPlainObject(out.xmp)) {
      Object.assign(xmp, flattenOneLevel(out.xmp));
    } else if (typeof out.xmp === 'string' && out.xmp.length > 0) {
      xmp['packet'] = `Gói XMP ${out.xmp.length.toLocaleString('vi-VN')} ký tự`;
    }
    for (const [key, value] of Object.entries(out)) {
      if (NON_XMP_KEYS.has(key)) continue;
      if (isPlainObject(value)) {
        for (const [k2, v2] of Object.entries(value)) xmp[`${key}:${k2}`] = v2;
      } else if (value != null) {
        xmp[key] = value;
      }
    }
    if (Object.keys(xmp).length > 0) blocks.xmp = xmp;
    return {blocks};
  } catch (err) {
    return {blocks: {}, error: err instanceof Error ? err.message : String(err)};
  }
}

function flattenOneLevel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        out[`${k}:${k2}`] = v2;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function formatMetaValue(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (ArrayBuffer.isView(v)) return `${(v as ArrayBufferView).byteLength} byte dữ liệu nhị phân`;
  if (Array.isArray(v)) return v.map(formatMetaValue).join(', ');
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 300 ? s.slice(0, 300) + '…' : s;
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Đổ các block exifr thành danh sách trường có mức rủi ro. */
export function collectExifrFields(
  blocks: Record<string, Record<string, unknown>>,
  fields: MetadataField[],
): void {
  // Toạ độ GPS: gộp thành 1 trường dễ hiểu + link bản đồ
  const gps = blocks.gps;
  if (gps) {
    let lat = typeof gps.latitude === 'number' ? (gps.latitude as number) : undefined;
    let lon = typeof gps.longitude === 'number' ? (gps.longitude as number) : undefined;
    if (lat === undefined && gps.GPSLatitude) {
      lat = dmsToDecimal(gps.GPSLatitude as ArrayLike<number>, gps.GPSLatitudeRef as string);
    }
    if (lon === undefined && gps.GPSLongitude) {
      lon = dmsToDecimal(gps.GPSLongitude as ArrayLike<number>, gps.GPSLongitudeRef as string);
    }
    if (lat !== undefined && lon !== undefined) {
      fields.push({
        id: 'gps:coordinates',
        group: 'GPS',
        tag: 'Toạ độ GPS',
        value: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
        risk: 'high',
        mapUrl: osmUrl(lat, lon),
      });
    }
  }

  const seen = new Set<string>();
  for (const [blockKey, label] of Object.entries({
    ifd0: 'EXIF',
    exif: 'EXIF',
    gps: 'GPS',
    xmp: 'XMP',
    iptc: 'IPTC',
    icc: 'ICC',
  })) {
    const block = blocks[blockKey];
    if (!block) continue;
    for (const [tag, value] of Object.entries(block)) {
      if (value == null) continue;
      // latitude/longitude do exifr tính sẵn — đã gộp thành trường "Toạ độ GPS"
      if (blockKey === 'gps' && (tag === 'latitude' || tag === 'longitude')) continue;
      const id = `${blockKey}:${tag}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const formatted = formatMetaValue(value);
      if (!formatted) continue;
      fields.push({
        id,
        group: label,
        tag,
        value: formatted,
        risk: classifyTag(label, tag),
      });
    }
  }
}
