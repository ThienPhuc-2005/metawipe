// Mã hoá PNG thuần TypeScript (không canvas): nhận pixel RGBA đã giải mã,
// xuất file PNG sạch — không mang theo bất kỳ metadata nào.
// Dùng cho đường chuyển đổi HEIC → PNG.

import {zlibSync} from 'fflate';
import {concatParts, crc32} from './binary';

function chunk(type: string, data: Uint8Array): Uint8Array {
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

export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error(`Kích thước pixel không khớp: ${rgba.length} byte cho ảnh ${width}×${height}.`);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // [10..12] = compression/filter/interlace = 0

  // Mỗi hàng: 1 byte filter (0 = None) + dữ liệu RGBA
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return concatParts([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, {level: 6})),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
