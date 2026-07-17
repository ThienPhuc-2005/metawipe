// Unit test handler JPEG. Kiểm chứng chéo: bộ xoá là code của mình,
// bộ đọc lại là thư viện exifr độc lập — xoá xong exifr phải "mù" hoàn toàn.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {buildJpeg, HANOI_GPS, latin1Encode, type ExifFixtureOpts} from './fixtures';
import {cleanJpeg, inspectJpeg, parseJpeg} from '../src/lib/handlers/jpeg';
import {CleanerError, concatParts} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const FULL_EXIF: ExifFixtureOpts = {
  orientation: 6,
  make: 'TestMake',
  model: 'TestModel 3000',
  software: 'PhotoEditor 9.0',
  artist: 'Nguyen Van A',
  dateTime: '2026:04:15 10:20:30',
  gps: HANOI_GPS,
  serial: 'SN-1234567890',
};

const fullJpeg = () =>
  buildJpeg({
    exif: FULL_EXIF,
    xmp: true,
    iptc: true,
    icc: true,
    adobe14: true,
    comment: 'chu thich thu nghiem',
    jfxx: true,
  });

async function exifrAll(bytes: Uint8Array): Promise<Record<string, any> | undefined> {
  const options = {
    ifd0: true,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: true,
    mergeOutput: false,
    translateValues: false, // giữ giá trị số gốc (6 thay vì 'Rotate 90 CW')
  } as unknown as Parameters<typeof exifr.parse>[1];
  return exifr.parse(bytes, options) as Promise<Record<string, any> | undefined>;
}

function segmentKinds(bytes: Uint8Array): string[] {
  return parseJpeg(bytes).segments.map(s => s.kind);
}

// Danh sách kind cấu trúc RIÊNG của test (không import từ code chính) —
// mọi segment cấu trúc phải sống sót qua clean, nguyên từng byte, đúng thứ tự.
const STRUCTURAL_KINDS = new Set([
  'soi', 'jfif', 'adobe-app14', 'dqt', 'sof', 'dht', 'dri', 'sos', 'entropy', 'eoi', 'seg',
]);

function structuralHexes(bytes: Uint8Array): string[] {
  return parseJpeg(bytes)
    .segments.filter(s => STRUCTURAL_KINDS.has(s.kind))
    .map(s => `${s.kind}:` + Array.from(bytes.subarray(s.start, s.end)).join(','));
}

function scanSlice(bytes: Uint8Array): Uint8Array {
  const {segments} = parseJpeg(bytes);
  const sos = segments.find(s => s.kind === 'sos')!;
  const eoi = segments.find(s => s.kind === 'eoi')!;
  return bytes.subarray(sos.start, eoi.end);
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

describe('fixture JPEG (kiểm tra bộ sinh file mẫu trước)', () => {
  it('exifr đọc được đầy đủ metadata từ fixture — nếu test này fail thì các test "xoá sạch" vô nghĩa', async () => {
    const parsed = await exifrAll(fullJpeg());
    expect(parsed).toBeTruthy();
    expect(parsed!.ifd0?.Make).toBe('TestMake');
    expect(parsed!.ifd0?.Model).toBe('TestModel 3000');
    expect(parsed!.ifd0?.Artist).toBe('Nguyen Van A');
    expect(parsed!.ifd0?.Orientation).toBeDefined();
    expect(parsed!.gps).toBeTruthy();
    const lat = parsed!.gps.latitude as number;
    const lon = parsed!.gps.longitude as number;
    expect(Math.abs(lat - 21.0285)).toBeLessThan(0.001);
    expect(Math.abs(lon - 105.8542)).toBeLessThan(0.001);
    expect(JSON.stringify(parsed!.xmp ?? {})).toContain('MetaWipe TestTool');
    expect(JSON.stringify(parsed!.iptc ?? {})).toContain('Nguyen Van A');
  });
});

describe('cleanJpeg — xoá metadata lossless', () => {
  it('xoá sạch EXIF/GPS/XMP/IPTC/COM, chỉ còn Orientation được giữ chủ động', async () => {
    const cleaned = cleanJpeg(fullJpeg(), DEFAULT_CLEAN_OPTIONS).data;
    const parsed = await exifrAll(cleaned);
    expect(parsed?.gps).toBeUndefined();
    expect(parsed?.xmp).toBeUndefined();
    expect(parsed?.iptc).toBeUndefined();
    // EXIF chỉ còn đúng 1 tag Orientation (giữ hướng xoay theo mặc định)
    expect(Object.keys(parsed?.ifd0 ?? {})).toEqual(['Orientation']);
    expect(parsed?.ifd0?.Orientation).toBe(FULL_EXIF.orientation);
    expect(parsed?.exif ?? {}).toEqual({});
  });

  it('keepOrientation=false: không còn bất kỳ EXIF nào', async () => {
    const cleaned = cleanJpeg(fullJpeg(), {keepIcc: false, keepOrientation: false}).data;
    const parsed = await exifrAll(cleaned);
    expect(parsed).toBeUndefined(); // exifr hoàn toàn "mù" — không còn gì để đọc
    expect(segmentKinds(cleaned)).not.toContain('exif');
  });

  it('orientation = 1 thì không cần chèn EXIF tối giản', () => {
    const src = buildJpeg({exif: {...FULL_EXIF, orientation: 1}});
    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(segmentKinds(cleaned)).not.toContain('exif');
  });

  it('ảnh không có EXIF gốc thì không tự bịa ra EXIF', () => {
    const src = buildJpeg({comment: 'chi co comment'});
    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(segmentKinds(cleaned)).not.toContain('exif');
  });

  it('LOSSLESS: toàn bộ dữ liệu ảnh nén (SOS → EOI) giống hệt từng byte', () => {
    const src = fullJpeg();
    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(scanSlice(cleaned))).toEqual(Array.from(scanSlice(src)));
  });

  it('ICC profile được giữ mặc định, xoá khi keepIcc=false', () => {
    const src = fullJpeg();
    const keep = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(segmentKinds(keep)).toContain('icc');
    const strip = cleanJpeg(src, {keepIcc: false, keepOrientation: true}).data;
    expect(segmentKinds(strip)).not.toContain('icc');
  });

  it('JFIF có thumbnail nhúng trong header: dựng lại header sạch 14 byte, giữ thông tin hiển thị', () => {
    const src = buildJpeg({jfifThumbnail: true, exif: {make: 'M'}});
    expect(segmentKinds(src)).toContain('jfif-thumb');

    const result = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.removed.some(r => r.kind === 'jfif-thumb')).toBe(true);

    const outSegs = parseJpeg(result.data).segments;
    const jfif = outSegs.find(s => s.kind === 'jfif');
    expect(jfif).toBeTruthy();
    expect(jfif!.end - jfif!.start).toBe(18); // FF E0 + độ dài 16 = header chuẩn không thumbnail
    // Phiên bản + mật độ điểm ảnh được giữ nguyên (trong src, payload JFIF bắt đầu
    // tại byte 6 nên khối version→density nằm ở byte 11..18)
    expect(Array.from(result.data.subarray(jfif!.payloadStart + 5, jfif!.payloadStart + 12))).toEqual(
      Array.from(src.subarray(11, 18)),
    );
    // Dữ liệu ảnh vẫn lossless
    expect(Array.from(scanSlice(result.data))).toEqual(Array.from(scanSlice(src)));
  });

  it('giữ APP14 Adobe (thông tin giải mã màu) và APP0 JFIF, xoá JFXX thumbnail', () => {
    const kinds = segmentKinds(cleanJpeg(fullJpeg(), DEFAULT_CLEAN_OPTIONS).data);
    expect(kinds).toContain('adobe-app14');
    expect(kinds).toContain('jfif');
    expect(kinds).not.toContain('jfxx');
  });

  it('nhiều APP1 cùng lúc: EXIF + XMP + XMP mở rộng (3 segment) đều bị xoá', () => {
    const src = buildJpeg({exif: {make: 'M'}, xmp: true, extendedXmpParts: 3});
    const srcKinds = segmentKinds(src);
    expect(srcKinds.filter(k => k === 'xmp-extended')).toHaveLength(3);

    const result = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.removed.filter(r => r.kind === 'xmp-extended')).toHaveLength(3);
    expect(result.removed.filter(r => r.kind === 'xmp')).toHaveLength(1);
    expect(result.removed.filter(r => r.kind === 'exif')).toHaveLength(1);
    const kinds = segmentKinds(result.data);
    expect(kinds).not.toContain('xmp');
    expect(kinds).not.toContain('xmp-extended');
  });

  it('xoá dữ liệu ẩn sau EOI (kiểu motion photo) và báo cáo rõ', () => {
    const trailing = latin1Encode('HIDDEN-VIDEO-DATA'.repeat(20));
    const src = buildJpeg({exif: {make: 'M'}, trailing});
    const result = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.removed.some(r => r.kind === 'trailing' && r.bytes === trailing.length)).toBe(true);
    // File sạch phải kết thúc đúng bằng marker EOI
    expect(result.data[result.data.length - 2]).toBe(0xff);
    expect(result.data[result.data.length - 1]).toBe(0xd9);
    expect(segmentKinds(result.data)).not.toContain('trailing');
  });

  it('file 2 lượt quét có FF00 + marker RST: dữ liệu nén giữ nguyên, COM giữa 2 scan bị xoá', () => {
    const src = buildJpeg({
      exif: {make: 'M'},
      comment: 'dau file',
      multiScan: true,
      commentBetweenScans: 'giua hai scan',
    });
    const srcParse = parseJpeg(src);
    expect(srcParse.segments.filter(s => s.kind === 'sos')).toHaveLength(2);
    expect(srcParse.segments.filter(s => s.kind === 'comment')).toHaveLength(2);

    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    const outParse = parseJpeg(cleaned);
    expect(outParse.segments.filter(s => s.kind === 'comment')).toHaveLength(0);
    expect(outParse.segments.filter(s => s.kind === 'sos')).toHaveLength(2);

    // Từng khối dữ liệu nén phải giống hệt byte (kể cả FF00 và FFD0 bên trong)
    const srcEntropy = srcParse.segments.filter(s => s.kind === 'entropy');
    const outEntropy = outParse.segments.filter(s => s.kind === 'entropy');
    expect(outEntropy).toHaveLength(srcEntropy.length);
    srcEntropy.forEach((seg, i) => {
      expect(Array.from(cleaned.subarray(outEntropy[i].start, outEntropy[i].end))).toEqual(
        Array.from(src.subarray(seg.start, seg.end)),
      );
    });
  });

  it('LOSSLESS toàn cục: mọi segment cấu trúc sống sót nguyên byte, đúng thứ tự (kể cả DHT giữa 2 scan)', () => {
    for (const src of [
      fullJpeg(),
      buildJpeg({exif: {make: 'M'}, comment: 'dau', multiScan: true, commentBetweenScans: 'giua'}),
    ]) {
      const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
      expect(structuralHexes(cleaned)).toEqual(structuralHexes(src));
    }
  });

  it('LOSSLESS toàn cục: file sạch = đúng phép ghép các segment được giữ, không thêm bớt byte nào', () => {
    const src = fullJpeg();
    const expected = concatParts(
      parseJpeg(src)
        .segments.filter(s => s.category === 'structural' || s.category === 'icc')
        .map(s => src.subarray(s.start, s.end)),
    );
    const cleaned = cleanJpeg(src, {keepIcc: true, keepOrientation: false}).data;
    expect(Array.from(cleaned)).toEqual(Array.from(expected));
  });

  it('chạy 2 lần cho kết quả y hệt (idempotent)', () => {
    const once = cleanJpeg(fullJpeg(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanJpeg(once, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('layout máy ảnh thật (không có JFIF, EXIF ngay sau SOI): EXIF tối giản chèn đúng chỗ', async () => {
    const src = buildJpeg({jfif: false, exif: {orientation: 6, make: 'M', gps: HANOI_GPS}});
    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    const kinds = segmentKinds(cleaned);
    expect(kinds[0]).toBe('soi');
    expect(kinds[1]).toBe('exif'); // EXIF tối giản đứng ngay sau SOI
    const parsed = await exifrAll(cleaned);
    expect(parsed?.ifd0?.Orientation).toBe(6);
    expect(parsed?.gps).toBeUndefined();
  });

  it('EXIF big-endian (MM, kiểu iPhone): xoá sạch và vẫn giữ được orientation', async () => {
    const src = buildJpeg({exif: {...FULL_EXIF, endian: 'MM'}, xmp: true});
    // exifr phải đọc được fixture MM trước đã (kiểm bộ sinh)
    const before = await exifrAll(src);
    expect(before?.ifd0?.Make).toBe('TestMake');
    expect(before?.gps?.latitude).toBeDefined();

    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    const parsed = await exifrAll(cleaned);
    expect(parsed?.gps).toBeUndefined();
    expect(parsed?.xmp).toBeUndefined();
    expect(Object.keys(parsed?.ifd0 ?? {})).toEqual(['Orientation']);
    expect(parsed?.ifd0?.Orientation).toBe(FULL_EXIF.orientation);
  });

  it('ICC trải trên 3 segment APP2: giữ đủ cả 3 (mặc định) hoặc xoá đủ cả 3 (keepIcc=false)', () => {
    const src = buildJpeg({iccParts: 3, exif: {make: 'M'}});
    const keep = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS);
    expect(segmentKinds(keep.data).filter(k => k === 'icc')).toHaveLength(3);
    const strip = cleanJpeg(src, {keepIcc: false, keepOrientation: true});
    expect(segmentKinds(strip.data).filter(k => k === 'icc')).toHaveLength(0);
    expect(strip.removed.filter(r => r.kind === 'icc')).toHaveLength(3);
  });

  it('segment DAC (0xCC) đứng trước SOF không bị nhầm là frame header — kích thước ảnh vẫn đúng', async () => {
    const src = buildJpeg({dac: true, exif: {make: 'M'}});
    const {segments} = parseJpeg(src);
    expect(segments.some(s => s.kind === 'dac')).toBe(true);
    const report = await inspectJpeg(src);
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);
    // DAC là segment cấu trúc — phải được giữ nguyên
    expect(segmentKinds(cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data)).toContain('dac');
  });

  it('notes: cảnh báo rõ khi bỏ orientation, ghi chú khi giữ bằng EXIF tối giản', () => {
    const src = buildJpeg({exif: {orientation: 6, make: 'M'}});
    const kept = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS);
    expect(kept.notes.some(n => n.includes('tối giản'))).toBe(true);
    const dropped = cleanJpeg(src, {keepIcc: true, keepOrientation: false});
    expect(dropped.notes.some(n => n.includes('sai chiều'))).toBe(true);
  });

  it('báo lỗi rõ ràng: file rỗng / bị cắt cụt / không phải JPEG', () => {
    expectCode(() => cleanJpeg(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanJpeg(fullJpeg().slice(0, 40), DEFAULT_CLEAN_OPTIONS), 'truncated');
    expectCode(() => cleanJpeg(latin1Encode('day khong phai anh'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    // Segment khai độ dài vượt quá cuối file
    const bogus = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    expectCode(() => cleanJpeg(bogus, DEFAULT_CLEAN_OPTIONS), 'truncated');
  });
});

describe('inspectJpeg — đọc metadata và phân mức rủi ro', () => {
  it('báo cáo đủ: GPS mức cao kèm link bản đồ, tác giả cao, model trung bình, kích thước ảnh', async () => {
    const report = await inspectJpeg(fullJpeg());
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);
    expect(report.orientation).toBe(6);

    const gpsField = report.fields.find(f => f.id === 'gps:coordinates');
    expect(gpsField).toBeTruthy();
    expect(gpsField!.risk).toBe('high');
    expect(gpsField!.mapUrl).toContain('openstreetmap.org');
    expect(gpsField!.value).toContain('21.028');

    const artist = report.fields.find(f => f.tag === 'Artist');
    expect(artist?.risk).toBe('high');
    const serial = report.fields.find(f => /serial/i.test(f.tag));
    expect(serial?.risk).toBe('high');
    const model = report.fields.find(f => f.tag === 'Model');
    expect(model?.risk).toBe('medium');
    expect(report.fields.some(f => f.group === 'JPEG' && f.tag === 'Comment')).toBe(true);

    // XMP: tên tác giả nằm trong namespace dc (dc:creator) phải hiện trong báo cáo
    // với mức cao — exifr trả mỗi namespace thành khóa riêng, không được làm rơi
    const xmpCreator = report.fields.find(f => f.group === 'XMP' && /creator$/i.test(f.tag));
    expect(xmpCreator?.value).toContain('Nguyễn Văn A');
    expect(xmpCreator?.risk).toBe('high');

    const segKinds = report.metaSegments.map(s => s.kind);
    for (const k of ['exif', 'xmp', 'iptc', 'icc', 'jfxx']) expect(segKinds).toContain(k);
  });

  it('báo trailingBytes và cảnh báo khi có dữ liệu ẩn sau EOI', async () => {
    const trailing = latin1Encode('X'.repeat(1000));
    const report = await inspectJpeg(buildJpeg({trailing}));
    expect(report.trailingBytes).toBe(1000);
    expect(report.warnings.some(w => w.includes('ẩn'))).toBe(true);
  });

  it('sau khi clean, inspect lại không còn trường rủi ro cao/trung bình nào (trừ nhóm ICC được giữ chủ động)', async () => {
    const cleaned = cleanJpeg(fullJpeg(), DEFAULT_CLEAN_OPTIONS).data;
    const report = await inspectJpeg(cleaned);
    expect(report.fields.filter(f => f.risk === 'high')).toEqual([]);
    expect(report.fields.filter(f => f.group !== 'ICC' && f.risk === 'medium')).toEqual([]);
    expect(report.trailingBytes).toBe(0);
  });
});
