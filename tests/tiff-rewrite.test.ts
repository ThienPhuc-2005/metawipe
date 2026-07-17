// Test bộ viết lại TIFF/EXIF — nền tảng của xoá chọn lọc và handler TIFF.
// Kiểm chứng chéo bằng exifr (bộ đọc độc lập).

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {rewriteTiff, type TiffRewriteFilter} from '../src/lib/tiff-rewrite';
import {CleanerError} from '../src/lib/binary';
import {buildTiffExif, buildTiffImage, HANOI_GPS} from './fixtures';

const FULL = {
  orientation: 6,
  make: 'TestMake',
  model: 'TestModel',
  software: 'Editor 1.0',
  artist: 'Nguyen Van A',
  dateTime: '2026:04:15 10:20:30',
  copyright: '(c) 2026 Test',
  gps: HANOI_GPS,
  serial: 'SN-999',
};

const KEEP_ALL: TiffRewriteFilter = {
  keepPageTag: () => true,
  keepExifIfd: true,
  keepGpsIfd: true,
  keepInteropIfd: true,
  keepChain: true,
  copyImageData: true,
};

async function parse(bytes: Uint8Array): Promise<Record<string, any> | undefined> {
  const options = {
    ifd0: true, exif: true, gps: true, mergeOutput: false, translateValues: false,
  } as unknown as Parameters<typeof exifr.parse>[1];
  return exifr.parse(bytes, options) as Promise<Record<string, any> | undefined>;
}

describe('rewriteTiff — chế độ giữ nguyên (round-trip)', () => {
  for (const endian of ['II', 'MM'] as const) {
    it(`giữ tất cả (${endian}): exifr đọc lại đủ các trường`, async () => {
      const src = buildTiffExif({...FULL, endian});
      const result = rewriteTiff(src, KEEP_ALL);
      expect(result.data).toBeTruthy();
      // Endian gốc được giữ nguyên
      expect(result.data![0]).toBe(src[0]);

      const before = await parse(src);
      const after = await parse(result.data!);
      expect(after?.ifd0?.Make).toBe(before?.ifd0?.Make);
      expect(after?.ifd0?.Artist).toBe('Nguyen Van A');
      expect(after?.ifd0?.Copyright).toBe('(c) 2026 Test');
      expect(after?.exif?.SerialNumber ?? after?.exif?.BodySerialNumber).toBeTruthy();
      expect(after?.gps?.latitude).toBeCloseTo(before?.gps?.latitude, 5);
    });
  }
});

describe('rewriteTiff — chỉ xoá GPS', () => {
  it('GPS biến mất, mọi thứ khác giữ nguyên', async () => {
    const src = buildTiffExif(FULL);
    const result = rewriteTiff(src, {...KEEP_ALL, keepGpsIfd: false});
    const after = await parse(result.data!);
    expect(after?.gps).toBeUndefined();
    expect(after?.ifd0?.Make).toBe('TestMake');
    expect(after?.ifd0?.Artist).toBe('Nguyen Van A');
    expect(after?.exif?.DateTimeOriginal).toBeTruthy();
    expect(result.removedTags.some(t => t.includes('GPS'))).toBe(true);
  });
});

describe('rewriteTiff — EXIF tối giản (giữ vài tag chọn lọc)', () => {
  it('chỉ giữ Orientation + Copyright, bỏ hết phần còn lại', async () => {
    const src = buildTiffExif(FULL);
    const keep = new Set([0x0112, 0x8298]);
    const result = rewriteTiff(src, {
      keepPageTag: tag => keep.has(tag),
      keepExifIfd: false,
      keepGpsIfd: false,
      keepInteropIfd: false,
      keepChain: false,
      copyImageData: false,
    });
    const after = await parse(result.data!);
    expect(Object.keys(after?.ifd0 ?? {}).sort()).toEqual(['Copyright', 'Orientation']);
    expect(after?.ifd0?.Orientation).toBe(6);
    expect(after?.gps).toBeUndefined();
    expect(after?.exif ?? {}).toEqual({});
  });

  it('không còn gì để giữ → trả data null', () => {
    const src = buildTiffExif({make: 'M', gps: HANOI_GPS});
    const result = rewriteTiff(src, {
      keepPageTag: () => false,
      keepExifIfd: false,
      keepGpsIfd: false,
      keepInteropIfd: false,
      keepChain: false,
      copyImageData: false,
    });
    expect(result.data).toBeNull();
    expect(result.removedTags.length).toBeGreaterThan(0);
  });
});

describe('rewriteTiff — thumbnail IFD1', () => {
  it('keepChain=false: thumbnail bị cắt; keepChain=true: thumbnail được copy sang offset mới', async () => {
    const src = buildTiffExif({...FULL, thumbnail: true});
    // exifr xác nhận fixture có thumbnail thật
    const thumbBefore = await exifr.thumbnail(src);
    expect(thumbBefore?.length).toBeGreaterThan(50);

    const dropped = rewriteTiff(src, {...KEEP_ALL, keepChain: false});
    expect(await exifr.thumbnail(dropped.data!)).toBeUndefined();

    const kept = rewriteTiff(src, KEEP_ALL);
    const thumbAfter = await exifr.thumbnail(kept.data!);
    expect(thumbAfter?.length).toBe(thumbBefore!.length);
    expect(Array.from(thumbAfter!)).toEqual(Array.from(thumbBefore!));
  });
});

describe('rewriteTiff — file TIFF thật (có dữ liệu ảnh)', () => {
  const DISPLAY_TAGS = new Set([
    256, 257, 258, 259, 262, 266, 273, 277, 278, 279, 282, 283, 284, 296,
    317, 320, 322, 323, 324, 325, 330, 338, 339, 347, 530, 531, 532,
  ]);
  const displayFilter: TiffRewriteFilter = {
    keepPageTag: tag => DISPLAY_TAGS.has(tag),
    keepExifIfd: false,
    keepGpsIfd: false,
    keepInteropIfd: false,
    keepChain: true,
    copyImageData: true,
  };

  it('xoá Make/Artist/GPS nhưng pixel strip được copy nguyên vẹn, offset cập nhật đúng', async () => {
    const src = buildTiffImage(FULL);
    const result = rewriteTiff(src, displayFilter);
    const after = await parse(result.data!);
    expect(after?.ifd0?.Make).toBeUndefined();
    expect(after?.ifd0?.Artist).toBeUndefined();
    expect(after?.gps).toBeUndefined();
    expect(after?.ifd0?.ImageWidth).toBe(1);

    // Đọc lại strip qua chính cấu trúc mới: StripOffsets phải trỏ tới byte 0x80
    const out = result.data!;
    const dv = new DataView(out.buffer, out.byteOffset);
    const little = out[0] === 0x49;
    const ifd0 = dv.getUint32(4, little);
    const n = dv.getUint16(ifd0, little);
    let stripOff = -1;
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12;
      if (dv.getUint16(e, little) === 273) stripOff = dv.getUint32(e + 8, little);
    }
    expect(stripOff).toBeGreaterThan(0);
    expect(out[stripOff]).toBe(0x80);
  });

  it('TIFF nhiều trang: cả 2 trang sống sót, metadata sạch ở mọi trang', async () => {
    const src = buildTiffImage({...FULL, pages: 2});
    const result = rewriteTiff(src, displayFilter);
    const out = result.data!;
    const dv = new DataView(out.buffer, out.byteOffset);
    const little = out[0] === 0x49;
    // đếm chuỗi IFD
    let count = 0;
    let off = dv.getUint32(4, little);
    while (off !== 0 && count < 10) {
      count++;
      const n = dv.getUint16(off, little);
      off = dv.getUint32(off + 2 + n * 12, little);
    }
    expect(count).toBe(2);
    const after = await parse(out);
    expect(after?.ifd0?.Artist).toBeUndefined();
  });

  it('endian MM cũng hoạt động với dữ liệu ảnh', async () => {
    const src = buildTiffImage({...FULL, endian: 'MM'});
    const result = rewriteTiff(src, displayFilter);
    expect(result.data![0]).toBe(0x4d);
    const after = await parse(result.data!);
    expect(after?.ifd0?.ImageWidth).toBe(1);
    expect(after?.ifd0?.Make).toBeUndefined();
  });
});

describe('rewriteTiff — file hỏng/không hỗ trợ', () => {
  function expectCode(fn: () => unknown, code: string): void {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err, 'phải ném CleanerError').toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe(code);
  }

  it('BigTIFF → unsupported; sai chữ ký/magic → corrupt; IFD trỏ bậy → corrupt', () => {
    const big = new Uint8Array([0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0]);
    expectCode(() => rewriteTiff(big, KEEP_ALL), 'unsupported');
    expectCode(() => rewriteTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), KEEP_ALL), 'corrupt');
    const badIfd = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0x00, 0x00]);
    expectCode(() => rewriteTiff(badIfd, KEEP_ALL), 'corrupt');
  });
});
