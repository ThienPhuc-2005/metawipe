// Unit test handler PNG: xoá chunk metadata theo danh sách trắng, lossless.

import {describe, expect, it} from 'vitest';
import {buildPng, buildTiffExif, HANOI_GPS, latin1Encode, pngChunk, type PngFixtureOpts} from './fixtures';
import {cleanPng, inspectPng, parsePng} from '../src/lib/handlers/png';
import {CleanerError, concatParts} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const fullOpts = (): PngFixtureOpts => ({
  text: [
    ['Author', 'Nguyen Van A'],
    ['Comment', 'binh luan thu nghiem'],
  ],
  ztxt: [['Description', 'mo ta nen bang zlib']],
  itxt: [['Note', 'ghi chú tiếng Việt có dấu', true]],
  xmp: true,
  time: true,
  exifTiff: buildTiffExif({make: 'TestMake', model: 'TestModel', gps: HANOI_GPS}),
  iccp: true,
  srgb: true,
  gama: true,
  phys: true,
  unknownAncillary: true,
  trailing: latin1Encode('DU-LIEU-AN-SAU-IEND'),
});

const fullPng = () => buildPng(fullOpts());

function chunkTypes(bytes: Uint8Array): string[] {
  return parsePng(bytes).chunks.map(c => c.type);
}

function chunkBytes(bytes: Uint8Array, type: string): Uint8Array {
  const chunk = parsePng(bytes).chunks.find(c => c.type === type);
  expect(chunk, `thiếu chunk ${type}`).toBeTruthy();
  return bytes.subarray(chunk!.start, chunk!.end);
}

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

describe('fixture PNG (kiểm tra bộ sinh file mẫu trước)', () => {
  it('inspect đọc được đủ metadata từ fixture', async () => {
    const report = await inspectPng(fullPng());
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);

    const author = report.fields.find(f => f.tag === 'Author');
    expect(author?.value).toBe('Nguyen Van A');
    expect(author?.risk).toBe('high');

    const desc = report.fields.find(f => f.tag === 'Description');
    expect(desc?.value).toBe('mo ta nen bang zlib'); // giải nén zTXt đúng

    const note = report.fields.find(f => f.tag === 'Note');
    expect(note?.value).toBe('ghi chú tiếng Việt có dấu'); // iTXt nén + UTF-8 có dấu

    expect(report.fields.some(f => f.group === 'XMP' && f.risk === 'high')).toBe(true);
    expect(report.fields.some(f => f.tag === 'tIME' && f.risk === 'medium')).toBe(true);

    // eXIf chứa GPS → phải hiện toạ độ mức cao kèm link bản đồ
    const gps = report.fields.find(f => f.id === 'gps:coordinates');
    expect(gps?.risk).toBe('high');
    expect(gps?.mapUrl).toContain('openstreetmap.org');

    expect(report.trailingBytes).toBeGreaterThan(0);
    expect(report.warnings.some(w => w.includes('ẩn'))).toBe(true);
  });
});

describe('cleanPng — xoá chunk metadata theo danh sách trắng', () => {
  it('xoá tEXt/zTXt/iTXt/XMP/tIME/eXIf/chunk lạ + dữ liệu sau IEND; giữ chunk hiển thị', () => {
    const result = cleanPng(fullPng(), DEFAULT_CLEAN_OPTIONS);
    const types = chunkTypes(result.data);
    expect(types).toEqual(['IHDR', 'sRGB', 'gAMA', 'pHYs', 'iCCP', 'IDAT', 'IEND']);

    const removedKinds = result.removed.map(r => r.kind);
    for (const k of ['text', 'xmp-png', 'time', 'exif', 'chunk', 'trailing']) {
      expect(removedKinds).toContain(k);
    }
    expect(result.bytesRemoved).toBeGreaterThan(0);
  });

  it('LOSSLESS: IHDR và IDAT giữ nguyên từng byte (kể cả CRC)', () => {
    const src = fullPng();
    const cleaned = cleanPng(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(chunkBytes(cleaned, 'IDAT'))).toEqual(Array.from(chunkBytes(src, 'IDAT')));
    expect(Array.from(chunkBytes(cleaned, 'IHDR'))).toEqual(Array.from(chunkBytes(src, 'IHDR')));
  });

  it('LOSSLESS toàn cục: file sạch = chữ ký + đúng phép ghép các chunk được giữ, nguyên từng byte', () => {
    // Whitelist RIÊNG của test (không import từ code chính) để kiểm chứng độc lập.
    // mDCV/cLLI là tên HDR chính thức của PNG 3; sPLT KHÔNG được giữ (có trường
    // văn bản tự do có thể chứa tracking).
    const SAFE = new Set([
      'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs', 'hIST',
      'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi',
    ]);
    const expectedClean = (src: Uint8Array, keepIcc: boolean): Uint8Array =>
      concatParts([
        src.subarray(0, 8),
        ...parsePng(src)
          .chunks.filter(c => {
            const critical = (c.type.charCodeAt(0) & 0x20) === 0;
            return critical || SAFE.has(c.type) || (c.type === 'iCCP' && keepIcc);
          })
          .map(c => src.subarray(c.start, c.end)),
      ]);

    for (const src of [
      fullPng(),
      buildPng({...fullOpts(), apng: true, unknownCritical: true}),
      // Ảnh bảng màu (PLTE + tRNS) + dữ liệu ảnh chia 3 chunk IDAT + chunk HDR PNG 3
      buildPng({
        ...fullOpts(),
        palette: true,
        idatParts: 3,
        extraChunks: [
          ['mDCV', new Uint8Array(24)],
          ['cLLI', new Uint8Array(8)],
        ],
      }),
    ]) {
      expect(Array.from(cleanPng(src, DEFAULT_CLEAN_OPTIONS).data)).toEqual(
        Array.from(expectedClean(src, true)),
      );
      expect(Array.from(cleanPng(src, {keepIcc: false, keepOrientation: true}).data)).toEqual(
        Array.from(expectedClean(src, false)),
      );
    }
  });

  it('iCCP giữ mặc định, xoá khi keepIcc=false', () => {
    const src = fullPng();
    expect(chunkTypes(cleanPng(src, DEFAULT_CLEAN_OPTIONS).data)).toContain('iCCP');
    expect(
      chunkTypes(cleanPng(src, {keepIcc: false, keepOrientation: true}).data),
    ).not.toContain('iCCP');
  });

  it('ảnh bảng màu: PLTE/tRNS và cả 3 chunk IDAT được giữ nguyên, đúng thứ tự', () => {
    const src = buildPng({palette: true, idatParts: 3, text: [['Author', 'X']]});
    const cleaned = cleanPng(src, DEFAULT_CLEAN_OPTIONS).data;
    const types = chunkTypes(cleaned);
    expect(types).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IDAT', 'IDAT', 'IEND']);
    // Ghép dữ liệu các IDAT phải giống hệt file gốc
    const idatData = (b: Uint8Array) =>
      parsePng(b)
        .chunks.filter(c => c.type === 'IDAT')
        .flatMap(c => Array.from(b.subarray(c.dataStart, c.dataEnd)));
    expect(idatData(cleaned)).toEqual(idatData(src));
  });

  it('chunk HDR chuẩn PNG 3 (mDCV/cLLI — chữ cuối HOA) được giữ, không bị xoá nhầm như chunk lạ', () => {
    const src = buildPng({
      extraChunks: [
        ['mDCV', new Uint8Array(24)],
        ['cLLI', new Uint8Array(8)],
      ],
      text: [['Author', 'X']],
    });
    const types = chunkTypes(cleanPng(src, DEFAULT_CLEAN_OPTIONS).data);
    expect(types).toContain('mDCV');
    expect(types).toContain('cLLI');
    expect(types).not.toContain('tEXt');
  });

  it('sPLT (bảng màu gợi ý, có trường tên văn bản tự do) bị xoá và báo cáo', () => {
    const spltData = concatParts([latin1Encode('user-12345-tracker'), new Uint8Array([0, 8])]);
    const src = buildPng({extraChunks: [['sPLT', spltData]]});
    const result = cleanPng(src, DEFAULT_CLEAN_OPTIONS);
    expect(chunkTypes(result.data)).not.toContain('sPLT');
    expect(result.removed.some(r => r.note === 'sPLT')).toBe(true);
  });

  it('IHDR sai độ dài (file giả mạo) → báo corrupt thay vì hiển thị kích thước rác', () => {
    const forged = concatParts([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', new Uint8Array(0)), // IHDR rỗng — chuẩn bắt buộc 13 byte
      pngChunk('IEND', new Uint8Array(0)),
    ]);
    expectCode(() => cleanPng(forged, DEFAULT_CLEAN_OPTIONS), 'corrupt');
  });

  it('chunk ảnh động APNG (acTL/fcTL) được giữ, metadata vẫn bị xoá', () => {
    const src = buildPng({apng: true, text: [['Author', 'X']]});
    const types = chunkTypes(cleanPng(src, DEFAULT_CLEAN_OPTIONS).data);
    expect(types).toContain('acTL');
    expect(types).toContain('fcTL');
    expect(types).not.toContain('tEXt');
  });

  it('chunk bắt buộc lạ được giữ (xoá sẽ hỏng ảnh) và có cảnh báo khi inspect', async () => {
    const src = buildPng({unknownCritical: true});
    expect(chunkTypes(cleanPng(src, DEFAULT_CLEAN_OPTIONS).data)).toContain('KrIt');
    const report = await inspectPng(src);
    expect(report.warnings.some(w => w.includes('KrIt'))).toBe(true);
  });

  it('chunk phụ trợ lạ (có thể chứa tracking) bị xoá và báo cáo', () => {
    const result = cleanPng(buildPng({unknownAncillary: true}), DEFAULT_CLEAN_OPTIONS);
    expect(chunkTypes(result.data)).not.toContain('prVt');
    expect(result.removed.some(r => r.kind === 'chunk' && r.note === 'prVt')).toBe(true);
  });

  it('file sạch kết thúc đúng ở IEND — dữ liệu ẩn phía sau biến mất', () => {
    const result = cleanPng(fullPng(), DEFAULT_CLEAN_OPTIONS);
    expect(parsePng(result.data).trailingStart).toBeNull();
    expect(result.removed.some(r => r.kind === 'trailing')).toBe(true);
  });

  it('chạy 2 lần cho kết quả y hệt (idempotent)', () => {
    const once = cleanPng(fullPng(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanPng(once, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('báo lỗi rõ ràng: file rỗng / sai chữ ký / bị cắt cụt', () => {
    expectCode(() => cleanPng(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanPng(latin1Encode('PNG gia mao'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    expectCode(() => cleanPng(fullPng().slice(0, 20), DEFAULT_CLEAN_OPTIONS), 'truncated');
    // Cắt vào giữa chunk IEND (dùng file KHÔNG có trailing để cắt trúng chunk thật)
    const src = buildPng({text: [['Author', 'X']]});
    expectCode(() => cleanPng(src.slice(0, src.length - 5), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });

  it('sau khi clean, inspect lại không còn trường rủi ro cao/trung bình nào', async () => {
    const cleaned = cleanPng(fullPng(), DEFAULT_CLEAN_OPTIONS).data;
    const report = await inspectPng(cleaned);
    expect(report.fields.filter(f => f.risk === 'high')).toEqual([]);
    expect(report.fields.filter(f => f.risk === 'medium')).toEqual([]);
    expect(report.trailingBytes).toBe(0);
  });
});
