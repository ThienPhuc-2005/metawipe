// Đọc tag Orientation từ khối TIFF của EXIF và dựng lại segment EXIF tối giản
// chỉ chứa đúng 1 tag Orientation (dùng khi người dùng muốn giữ hướng xoay ảnh).

/** Đọc Orientation (1..8) từ bytes TIFF (bắt đầu bằng 'II'/'MM'). Trả undefined nếu không có/hỏng. */
export function readOrientation(tiff: Uint8Array): number | undefined {
  if (tiff.length < 14) return undefined;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return undefined;

  const u16 = (o: number): number =>
    little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
  const u32 = (o: number): number =>
    little
      ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
      : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;

  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return undefined;
    if (u16(e) === 0x0112) {
      if (u16(e + 2) !== 3) return undefined; // phải là kiểu SHORT
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : undefined;
    }
  }
  return undefined;
}

/**
 * Dựng nguyên một segment APP1 EXIF tối giản (34 byte) chỉ chứa tag Orientation.
 * Trả về bytes gồm cả marker FF E1 + độ dài, chèn thẳng vào file JPEG được.
 */
export function buildOrientationExif(orientation: number): Uint8Array {
  const seg = new Uint8Array(2 + 2 + 32);
  let o = 0;
  const put = (...vals: number[]) => {
    for (const v of vals) seg[o++] = v;
  };
  put(0xff, 0xe1); // marker APP1
  put(0x00, 0x22); // độ dài = 34 (2 byte độ dài + 32 byte payload)
  put(0x45, 0x78, 0x69, 0x66, 0x00, 0x00); // 'Exif\0\0'
  put(0x49, 0x49); // 'II' — little endian
  put(0x2a, 0x00); // 42
  put(0x08, 0x00, 0x00, 0x00); // IFD0 tại offset 8
  put(0x01, 0x00); // 1 entry
  put(0x12, 0x01); // tag 0x0112 Orientation
  put(0x03, 0x00); // kiểu SHORT
  put(0x01, 0x00, 0x00, 0x00); // count 1
  put(orientation & 0xff, 0x00, 0x00, 0x00); // giá trị
  put(0x00, 0x00, 0x00, 0x00); // không có IFD tiếp theo
  return seg;
}
