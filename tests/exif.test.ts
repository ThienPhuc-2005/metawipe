// Test đọc Orientation từ TIFF (cả 2 chiều byte) và dựng EXIF tối giản.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {buildOrientationExif, readOrientation} from '../src/lib/handlers/exif';
import {buildTiffExif} from './fixtures';
import {concatParts} from '../src/lib/binary';

describe('readOrientation', () => {
  it('đọc đúng orientation từ TIFF little-endian do bộ sinh fixture tạo', () => {
    for (const o of [1, 3, 6, 8]) {
      expect(readOrientation(buildTiffExif({orientation: o, make: 'M'}))).toBe(o);
    }
  });

  it('đọc đúng orientation từ TIFF big-endian (MM) viết tay', () => {
    // 'MM' 42, IFD0 tại 8, 1 entry: tag 0x0112 SHORT count 1 value 6
    const mm = new Uint8Array([
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01,
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(readOrientation(mm)).toBe(6);
  });

  it('không có tag orientation / dữ liệu hỏng → undefined, không crash', () => {
    expect(readOrientation(buildTiffExif({make: 'M'}))).toBeUndefined();
    expect(readOrientation(new Uint8Array(0))).toBeUndefined();
    expect(readOrientation(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toBeUndefined();
    // Header đúng nhưng offset IFD trỏ ra ngoài file
    const bad = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(readOrientation(bad)).toBeUndefined();
  });
});

describe('buildOrientationExif', () => {
  it('segment tự dựng đọc lại được bằng chính readOrientation', () => {
    for (const o of [2, 3, 4, 5, 6, 7, 8]) {
      const seg = buildOrientationExif(o);
      expect(seg.length).toBe(36);
      // Bỏ FF E1 + 2 byte độ dài + 'Exif\0\0' (6 byte) = 10 byte đầu
      expect(readOrientation(seg.subarray(10))).toBe(o);
    }
  });

  it('exifr cũng đọc được segment tối giản khi gắn vào một JPEG', async () => {
    // JPEG tối giản: SOI + EXIF tối giản + EOI là đủ cho exifr đọc metadata
    const jpeg = concatParts([
      new Uint8Array([0xff, 0xd8]),
      buildOrientationExif(6),
      new Uint8Array([0xff, 0xd9]),
    ]);
    const options = {ifd0: true, mergeOutput: false, translateValues: false} as unknown as Parameters<
      typeof exifr.parse
    >[1];
    const parsed = await exifr.parse(jpeg, options);
    expect(parsed?.ifd0?.Orientation).toBe(6);
  });
});
