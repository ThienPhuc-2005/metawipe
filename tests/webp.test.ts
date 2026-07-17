// Unit test handler WebP: container RIFF, cờ VP8X, pad byte, RIFF size.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {buildWebp, HANOI_GPS, latin1Encode, xmpPacket, type ExifFixtureOpts} from './fixtures';
import {cleanWebp, inspectWebp, parseWebp} from '../src/lib/handlers/webp';
import {CleanerError} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const FULL_EXIF: ExifFixtureOpts = {
  orientation: 6,
  make: 'TestMake',
  model: 'TestModel',
  artist: 'Nguyen Van A',
  gps: HANOI_GPS,
};

const fullWebp = () =>
  buildWebp({icc: true, exif: FULL_EXIF, xmp: true, unknownChunk: true, anim: true});

function fourccs(bytes: Uint8Array): string[] {
  return parseWebp(bytes).chunks.map(c => c.fourcc);
}

function vp8xFlags(bytes: Uint8Array): number {
  const vp8x = parseWebp(bytes).chunks.find(c => c.fourcc === 'VP8X');
  return vp8x ? bytes[vp8x.dataStart] : -1;
}

function riffSizeField(bytes: Uint8Array): number {
  return (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
}

async function exifrTiff(bytes: Uint8Array): Promise<Record<string, any> | undefined> {
  const options = {
    ifd0: true, exif: true, gps: true, mergeOutput: false, translateValues: false,
  } as unknown as Parameters<typeof exifr.parse>[1];
  return exifr.parse(bytes, options) as Promise<Record<string, any> | undefined>;
}

function exifChunkTiff(bytes: Uint8Array): Uint8Array | null {
  const c = parseWebp(bytes).chunks.find(ch => ch.fourcc === 'EXIF');
  if (!c) return null;
  return bytes.slice(c.dataStart, c.dataEnd);
}

describe('cleanWebp', () => {
  it('xoá EXIF/XMP/chunk lạ, giữ ảnh + ICC + ANIM; cờ VP8X và RIFF size cập nhật đúng', async () => {
    const src = fullWebp();
    expect(vp8xFlags(src)).toBe(0x20 | 0x08 | 0x04 | 0x02);

    const result = cleanWebp(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;
    const kinds = fourccs(out);
    expect(kinds).toContain('VP8X');
    expect(kinds).toContain('ICCP');
    expect(kinds).toContain('ANIM');
    expect(kinds).toContain('VP8L');
    expect(kinds).not.toContain('XMP ');
    expect(kinds).not.toContain('MSIR');

    // EXIF còn lại là bản tối giản (giữ orientation) → cờ EXIF vẫn bật, XMP tắt
    expect(kinds).toContain('EXIF');
    expect(vp8xFlags(out)).toBe(0x20 | 0x08 | 0x02);
    const parsed = await exifrTiff(exifChunkTiff(out)!);
    expect(Object.keys(parsed?.ifd0 ?? {})).toEqual(['Orientation']);
    expect(parsed?.gps).toBeUndefined();

    // RIFF size = tổng file - 8 (đã kiểm bằng field + parse lại không lỗi)
    expect(riffSizeField(out)).toBe(out.length - 8);
  });

  it('keepOrientation=false: không còn EXIF, cờ EXIF tắt', () => {
    const out = cleanWebp(fullWebp(), {keepIcc: false, keepOrientation: false}).data;
    const kinds = fourccs(out);
    expect(kinds).not.toContain('EXIF');
    expect(kinds).not.toContain('ICCP');
    expect(vp8xFlags(out)).toBe(0x02); // chỉ còn Animation
  });

  it('LOSSLESS: chunk ảnh (VP8L) giữ nguyên từng byte, pad byte đúng chuẩn', () => {
    const src = fullWebp();
    const out = cleanWebp(src, DEFAULT_CLEAN_OPTIONS).data;
    const srcVp8l = parseWebp(src).chunks.find(c => c.fourcc === 'VP8L')!;
    const outVp8l = parseWebp(out).chunks.find(c => c.fourcc === 'VP8L')!;
    // gồm cả header + pad (payload 5 byte lẻ → có pad)
    expect(Array.from(out.subarray(outVp8l.start, outVp8l.end))).toEqual(
      Array.from(src.subarray(srcVp8l.start, srcVp8l.end)),
    );
    expect(outVp8l.end - outVp8l.dataStart).toBe(6); // 5 byte + 1 pad
  });

  it('nhiều chunk EXIF trùng: xoá TẤT CẢ, không dừng ở chunk đầu', () => {
    const src = buildWebp({exif: {...FULL_EXIF, orientation: undefined}, exifCount: 3});
    expect(fourccs(src).filter(f => f === 'EXIF')).toHaveLength(3);
    const result = cleanWebp(src, DEFAULT_CLEAN_OPTIONS);
    expect(fourccs(result.data).filter(f => f === 'EXIF')).toHaveLength(0);
    expect(result.removed.filter(r => r.kind === 'exif')).toHaveLength(3);
  });

  it('payload EXIF kèm tiền tố Exif\\0\\0 vẫn đọc và lọc được', async () => {
    const src = buildWebp({exif: FULL_EXIF, exifWithHeader: true});
    const report = await inspectWebp(src);
    expect(report.fields.some(f => f.id === 'gps:coordinates')).toBe(true);
    const out = cleanWebp(src, {keepIcc: true, keepOrientation: false}).data;
    expect(fourccs(out)).not.toContain('EXIF');
  });

  it('chỉ xoá GPS: EXIF còn Make, XMP đã gỡ GPS thật sự, chunk lạ giữ nguyên', async () => {
    const src = buildWebp({
      exif: FULL_EXIF,
      xmp: xmpPacket('Tac Gia', 'Tool 1.0', {gps: true}),
      unknownChunk: true,
    });
    const result = cleanWebp(src, {keepIcc: true, keepOrientation: true, gpsOnly: true});
    const out = result.data;
    const kinds = fourccs(out);
    expect(kinds).toContain('EXIF');
    expect(kinds).toContain('XMP ');
    expect(kinds).toContain('MSIR'); // chế độ nhẹ tay: chunk lạ giữ nguyên

    const parsed = await exifrTiff(exifChunkTiff(out)!);
    expect(parsed?.gps).toBeUndefined();
    expect(parsed?.ifd0?.Make).toBe('TestMake');

    // XMP phải được gỡ GPS THẬT (không chỉ tồn tại)
    const xmpChunk = parseWebp(out).chunks.find(c => c.fourcc === 'XMP ')!;
    const xml = String.fromCharCode(...out.subarray(xmpChunk.dataStart, xmpChunk.dataEnd));
    expect(xml).not.toMatch(/GPS\w/i);
    expect(xml).toContain('Tac Gia');
    expect(result.removed.some(r => r.kind === 'xmp' && r.bytes >= 0)).toBe(true);
  });

  it('chỉ xoá GPS + XMP KHÔNG có GPS: chunk giữ nguyên từng byte (kể cả BOM)', () => {
    const src = buildWebp({exif: FULL_EXIF, xmp: '﻿' + xmpPacket('Tac Gia')});
    const out = cleanWebp(src, {keepIcc: true, keepOrientation: true, gpsOnly: true}).data;
    const pick = (b: Uint8Array) => {
      const c = parseWebp(b).chunks.find(ch => ch.fourcc === 'XMP ')!;
      return Array.from(b.subarray(c.start, c.end));
    };
    expect(pick(out)).toEqual(pick(src));
  });

  it('chỉ xoá GPS + dữ liệu thừa sau RIFF: file vẫn HỢP LỆ, rác nằm ngoài vùng RIFF', () => {
    const trailing = latin1Encode('DU-LIEU-AN'.repeat(10));
    const src = buildWebp({exif: FULL_EXIF, xmp: true, trailing});
    const result = cleanWebp(src, {keepIcc: true, keepOrientation: true, gpsOnly: true});
    const out = result.data;

    // parse lại không được ném lỗi — RIFF size chỉ ôm các chunk thật
    const reparsed = parseWebp(out);
    expect(reparsed.trailingStart).not.toBeNull();
    expect(riffSizeField(out)).toBe(reparsed.trailingStart! - 8);
    // rác được giữ nguyên vẹn phía sau
    expect(Array.from(out.subarray(reparsed.trailingStart!))).toEqual(Array.from(trailing));
    expect(result.notes.join(' ')).toContain('GPS');
  });

  it('dữ liệu thừa sau vùng RIFF bị cắt và báo cáo', () => {
    const src = buildWebp({exif: FULL_EXIF, trailing: latin1Encode('DU-LIEU-AN'.repeat(10))});
    const result = cleanWebp(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.removed.some(r => r.kind === 'trailing')).toBe(true);
    expect(riffSizeField(result.data)).toBe(result.data.length - 8);
  });

  it('file simple (không VP8X) có chunk EXIF trái phép: vẫn quét và xoá được', () => {
    const src = buildWebp({simple: true, exif: {...FULL_EXIF, orientation: undefined}});
    const out = cleanWebp(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(fourccs(out)).not.toContain('EXIF');
    expect(fourccs(out)).toContain('VP8L');
  });

  it('idempotent + báo lỗi: rỗng/cắt cụt/không phải WebP', () => {
    const once = cleanWebp(fullWebp(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanWebp(once, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(twice)).toEqual(Array.from(once));

    const expectCode = (fn: () => unknown, code: string) => {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CleanerError);
      expect((err as CleanerError).code).toBe(code);
    };
    expectCode(() => cleanWebp(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanWebp(latin1Encode('RIFFxxxxNOPE'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    expectCode(() => cleanWebp(fullWebp().slice(0, 30), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });
});

describe('inspectWebp', () => {
  it('đọc GPS/Artist từ EXIF, cảnh báo XMP có GPS, kích thước từ VP8X', async () => {
    const report = await inspectWebp(
      buildWebp({exif: FULL_EXIF, xmp: true, icc: true, unknownChunk: true}),
    );
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);
    expect(report.orientation).toBe(6);
    const gps = report.fields.find(f => f.id === 'gps:coordinates');
    expect(gps?.risk).toBe('high');
    expect(report.fields.some(f => f.tag === 'Artist' && f.risk === 'high')).toBe(true);
    const segKinds = report.metaSegments.map(s => s.kind);
    expect(segKinds).toContain('exif');
    expect(segKinds).toContain('xmp');
    expect(segKinds).toContain('icc');
    expect(segKinds).toContain('chunk');
  });
});
