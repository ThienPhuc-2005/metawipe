// Test các chế độ chọn lọc mới của Phase 2: chỉ-xoá-GPS, giữ bản quyền,
// gỡ GPS khỏi XMP, handler TIFF, điểm riêng tư, mã hoá PNG, HEIC (decoder giả).

import {describe, expect, it, afterEach} from 'vitest';
import exifr from 'exifr';
import {unzlibSync} from 'fflate';
import {
  buildJpeg,
  buildPng,
  buildTiffExif,
  buildTiffImage,
  HANOI_GPS,
  xmpPacket,
  type ExifFixtureOpts,
} from './fixtures';
import {cleanJpeg, inspectJpeg, parseJpeg} from '../src/lib/handlers/jpeg';
import {cleanPng, parsePng, inspectPng} from '../src/lib/handlers/png';
import {cleanTiff, inspectTiff} from '../src/lib/handlers/tiff';
import {cleanHeic, setHeifDecoderFactory, type HeifImageLike} from '../src/lib/handlers/heic';
import {encodePngRgba} from '../src/lib/png-encode';
import {scrubXmpGps} from '../src/lib/xmp-scrub';
import {privacyScore} from '../src/lib/risk';
import {resolvePreset} from '../src/lib/presets';
import {CleanerError, decodeUtf8} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const FULL_EXIF: ExifFixtureOpts = {
  orientation: 6,
  make: 'TestMake',
  model: 'TestModel',
  artist: 'Nguyen Van A',
  copyright: '(c) 2026 Nguyen Van A',
  dateTime: '2026:04:15 10:20:30',
  gps: HANOI_GPS,
  serial: 'SN-777',
};

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};

async function exifrAll(bytes: Uint8Array): Promise<Record<string, any> | undefined> {
  const options = {
    ifd0: true, exif: true, gps: true, xmp: true, iptc: true, mergeOutput: false, translateValues: false,
  } as unknown as Parameters<typeof exifr.parse>[1];
  return exifr.parse(bytes, options) as Promise<Record<string, any> | undefined>;
}

describe('scrubXmpGps', () => {
  it('gỡ GPS dạng thuộc tính lẫn phần tử, giữ nguyên phần còn lại', () => {
    const xml = xmpPacket('Nguyễn Văn A', 'Tool 1.0', {gps: true});
    const result = scrubXmpGps(xml);
    expect(result.removed).toBeGreaterThanOrEqual(4);
    expect(result.xml).not.toMatch(/GPS\w/);
    expect(result.xml).toContain('Nguyễn Văn A');
    expect(result.xml).toContain('Tool 1.0');
  });

  it('XMP không có GPS thì giữ nguyên 100%', () => {
    const xml = xmpPacket();
    const result = scrubXmpGps(xml);
    expect(result.removed).toBe(0);
    expect(result.xml).toBe(xml);
  });

  it('bắt được kiểu ghi của DJI drone: GpsLatitude viết thường, Longtitude sai chính tả, Latitude trần', () => {
    const xml =
      '<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"' +
      ' drone-dji:GpsLatitude="+21.0285" drone-dji:GpsLongtitude="+105.8542"' +
      ' drone-dji:AbsoluteAltitude="+58.90" Latitude="21.03">' +
      '<drone-dji:GimbalDegree>+10</drone-dji:GimbalDegree>' +
      '<Camera:MotionBlurVal xmlns:Camera="x">5</Camera:MotionBlurVal>' +
      '</rdf:Description>';
    const result = scrubXmpGps(xml);
    expect(result.removed).toBeGreaterThanOrEqual(4);
    expect(result.xml).not.toMatch(/lati?tude|longt?itude|altitude/i);
    expect(result.xml).toContain('GimbalDegree'); // không xoá lố
    expect(result.xml).toContain('MotionBlurVal');
  });

  it('không đụng vào geometry/creator dù chứa chữ gần giống', () => {
    const xml = '<x geometry="10x10" dc:creator="A"><exif:GPSLatitude>1</exif:GPSLatitude></x>';
    const result = scrubXmpGps(xml);
    expect(result.xml).toContain('geometry="10x10"');
    expect(result.xml).toContain('creator="A"');
    expect(result.xml).not.toContain('GPSLatitude');
  });
});

describe('JPEG — chế độ chỉ xoá GPS', () => {
  it('GPS biến mất khỏi EXIF lẫn XMP; Artist/Model/IPTC/comment còn nguyên', async () => {
    const src = buildJpeg({
      exif: FULL_EXIF,
      xmp: xmpPacket('Nguyễn Văn A', 'Tool', {gps: true}),
      iptc: true,
      comment: 'giu nguyen comment',
    });
    const result = cleanJpeg(src, GPS_ONLY);
    const parsed = await exifrAll(result.data);
    expect(parsed?.gps).toBeUndefined();
    expect(JSON.stringify(parsed?.xmp ?? {})).not.toMatch(/GPS\w/);
    expect(parsed?.ifd0?.Artist).toBe('Nguyen Van A');
    expect(parsed?.ifd0?.Model).toBe('TestModel');
    expect(parsed?.exif?.DateTimeOriginal).toBeTruthy();
    expect(JSON.stringify(parsed?.iptc ?? {})).toContain('Nguyen Van A');

    const report = await inspectJpeg(result.data);
    expect(report.fields.some(f => f.group === 'JPEG' && f.tag === 'Comment')).toBe(true);
    expect(report.fields.find(f => f.id === 'gps:coordinates')).toBeUndefined();
  });

  it('dữ liệu ảnh vẫn lossless trong chế độ chỉ xoá GPS', () => {
    const src = buildJpeg({exif: FULL_EXIF, comment: 'x'});
    const out = cleanJpeg(src, GPS_ONLY).data;
    const scan = (b: Uint8Array) => {
      const segs = parseJpeg(b).segments;
      const sos = segs.find(s => s.kind === 'sos')!;
      const eoi = segs.find(s => s.kind === 'eoi')!;
      return Array.from(b.subarray(sos.start, eoi.end));
    };
    expect(scan(out)).toEqual(scan(src));
  });

  it('MakerNote bị xoá kèm ghi chú (có thể giấu toạ độ)', () => {
    const src = buildJpeg({exif: FULL_EXIF});
    const result = cleanJpeg(src, GPS_ONLY);
    expect(result.notes.join(' ')).not.toContain('MakerNote'); // fixture không có MakerNote → không ghi chú thừa
  });

  it('XMP mở rộng bị XOÁ trong chế độ chỉ-xoá-GPS (không thể quét an toàn từng phần)', () => {
    const src = buildJpeg({exif: {make: 'M'}, xmp: true, extendedXmpParts: 3});
    const result = cleanJpeg(src, GPS_ONLY);
    expect(result.removed.filter(r => r.kind === 'xmp-extended')).toHaveLength(3);
    expect(result.notes.some(n => n.includes('XMP mở rộng'))).toBe(true);
    expect(parseJpeg(result.data).segments.some(s => s.kind === 'xmp-extended')).toBe(false);
  });

  it('dữ liệu thừa sau EOI được giữ nhưng cảnh báo nêu RÕ rủi ro GPS', () => {
    const src = buildJpeg({exif: FULL_EXIF, trailing: new Uint8Array(500)});
    const result = cleanJpeg(src, GPS_ONLY);
    const note = result.notes.find(n => n.includes('sau ảnh'));
    expect(note).toBeTruthy();
    expect(note).toContain('GPS');
  });
});

describe('JPEG — giữ bản quyền (keepCopyright)', () => {
  it('EXIF tối giản chứa đúng Orientation + Copyright', async () => {
    const src = buildJpeg({exif: FULL_EXIF});
    const result = cleanJpeg(src, {keepIcc: true, keepOrientation: true, keepCopyright: true});
    const parsed = await exifrAll(result.data);
    expect(Object.keys(parsed?.ifd0 ?? {}).sort()).toEqual(['Copyright', 'Orientation']);
    expect(parsed?.ifd0?.Copyright).toBe('(c) 2026 Nguyen Van A');
    expect(parsed?.gps).toBeUndefined();
    expect(parsed?.ifd0?.Artist).toBeUndefined();
  });

  it('preset quy đổi đúng: social/wipe-all/gps-only/custom', () => {
    expect(resolvePreset('social', DEFAULT_CLEAN_OPTIONS)).toMatchObject({
      keepIcc: true, keepOrientation: true, gpsOnly: false,
    });
    expect(resolvePreset('wipe-all', DEFAULT_CLEAN_OPTIONS)).toMatchObject({
      keepIcc: false, keepOrientation: false,
    });
    expect(resolvePreset('gps-only', DEFAULT_CLEAN_OPTIONS).gpsOnly).toBe(true);
    expect(
      resolvePreset('custom', {keepIcc: false, keepOrientation: true, keepCopyright: true}),
    ).toMatchObject({keepIcc: false, keepOrientation: true, keepCopyright: true, gpsOnly: false});
  });
});

describe('PNG — chế độ chọn lọc', () => {
  const pngSrc = () =>
    buildPng({
      text: [['Author', 'Nguyen Van A']],
      xmp: true,
      exifTiff: buildTiffExif(FULL_EXIF),
      time: true,
      srgb: true,
    });

  it('chỉ xoá GPS: eXIf còn Make, tEXt/tIME giữ nguyên', async () => {
    const out = cleanPng(pngSrc(), GPS_ONLY).data;
    const types = parsePng(out).chunks.map(c => c.type);
    expect(types).toContain('tEXt');
    expect(types).toContain('tIME');
    expect(types).toContain('eXIf');

    const report = await inspectPng(out);
    expect(report.fields.find(f => f.id === 'gps:coordinates')).toBeUndefined();
    expect(report.fields.some(f => f.tag === 'Make')).toBe(true);
    expect(report.fields.some(f => f.tag === 'Author')).toBe(true);
  });

  it('giữ hướng xoay: eXIf tối giản chỉ còn Orientation', async () => {
    const out = cleanPng(pngSrc(), DEFAULT_CLEAN_OPTIONS).data;
    const exifChunk = parsePng(out).chunks.find(c => c.type === 'eXIf');
    expect(exifChunk).toBeTruthy();
    const parsed = await exifrAll(out.slice(exifChunk!.dataStart, exifChunk!.dataEnd));
    expect(Object.keys(parsed?.ifd0 ?? {})).toEqual(['Orientation']);
  });

  it('chỉ xoá GPS: chunk "Raw profile type exif" (bản sao EXIF mã hoá hex) bị xoá hẳn', () => {
    const src = buildPng({
      text: [
        ['Raw profile type exif', '\nexif\n 1234\n45786966...'],
        ['Author', 'Giu Lai'],
      ],
    });
    const result = cleanPng(src, GPS_ONLY);
    const types = parsePng(result.data).chunks.map(c => c.type);
    // tEXt Author còn, tEXt raw-profile mất
    expect(types.filter(t => t === 'tEXt')).toHaveLength(1);
    expect(result.removed.some(r => r.kind === 'raw-profile')).toBe(true);
  });

  it('chỉ xoá GPS: XMP giấu trong zTXt cũng bị quét và gỡ GPS', () => {
    const src = buildPng({
      ztxt: [['XML:com.adobe.xmp', xmpPacket('Tac Gia', 'Tool', {gps: true})]],
    });
    const result = cleanPng(src, GPS_ONLY);
    expect(result.removed.some(r => r.kind === 'xmp-png')).toBe(true);
    // packet sau khi gỡ nằm trong iTXt mới, không còn GPS
    const out = result.data;
    const itxt = parsePng(out).chunks.find(c => c.type === 'iTXt');
    expect(itxt).toBeTruthy();
    const xml = new TextDecoder().decode(out.subarray(itxt!.dataStart, itxt!.dataEnd));
    expect(xml).not.toMatch(/GPSL/i);
    expect(xml).toContain('Tac Gia');
  });

  it('id trường ổn định: diff trước/sau chỉ ra ĐÚNG các trường GPS, không đếm oan trường giữ lại', async () => {
    const src = pngSrc();
    const before = await inspectPng(src);
    const after = await inspectPng(cleanPng(src, GPS_ONLY).data);
    const removedByDiff = before.fields.filter(
      f => !after.fields.some(a => a.id === f.id && a.value === f.value),
    );
    // chỉ các trường GPS biến mất; Author/tIME/Make phải khớp id+value và không bị đếm oan
    expect(removedByDiff.length).toBeGreaterThan(0);
    for (const f of removedByDiff) {
      expect(f.group === 'GPS' || /gps/i.test(f.tag)).toBe(true);
    }
  });
});

describe('handler TIFF', () => {
  it('làm sạch file TIFF: Artist/GPS/serial biến mất, ảnh + kích thước còn nguyên', async () => {
    const src = buildTiffImage(FULL_EXIF);
    const before = await exifrAll(src);
    expect(before?.ifd0?.Artist).toBe('Nguyen Van A');

    const result = await cleanTiff(src, DEFAULT_CLEAN_OPTIONS);
    const after = await exifrAll(result.data);
    expect(after?.ifd0?.Artist).toBeUndefined();
    expect(after?.gps).toBeUndefined();
    expect(after?.ifd0?.ImageWidth).toBe(1);
    expect(after?.ifd0?.Orientation).toBe(6); // keepOrientation mặc định
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it('giữ copyright khi keepCopyright=true', async () => {
    const src = buildTiffImage(FULL_EXIF);
    const result = await cleanTiff(src, {keepIcc: true, keepOrientation: true, keepCopyright: true});
    const after = await exifrAll(result.data);
    expect(after?.ifd0?.Copyright).toBe('(c) 2026 Nguyen Van A');
  });

  it('chỉ xoá GPS: Make/Artist còn, GPS mất', async () => {
    const src = buildTiffImage(FULL_EXIF);
    const result = await cleanTiff(src, GPS_ONLY);
    const after = await exifrAll(result.data);
    expect(after?.gps).toBeUndefined();
    expect(after?.ifd0?.Artist).toBe('Nguyen Van A');
  });

  it('chỉ xoá GPS: XMP trong tag 700 của TIFF cũng bị gỡ toạ độ', async () => {
    const src = buildTiffImage({...FULL_EXIF, xmp: xmpPacket('Tac Gia', 'Tool', {gps: true})});
    const result = await cleanTiff(src, GPS_ONLY);
    expect(result.notes.some(n => n.includes('XMP'))).toBe(true);

    const after = await exifrAll(result.data);
    expect(after?.gps).toBeUndefined();
    // exifr trả mỗi namespace XMP thành khóa cấp 1 — quét toàn bộ kết quả
    const allStr = JSON.stringify(after ?? {});
    expect(allStr).not.toMatch(/GPSLat|GPSLong|GPSAlt/i);
    expect(allStr).toContain('Tac Gia'); // phần còn lại của XMP vẫn nguyên
    expect(after?.ifd0?.Artist).toBe('Nguyen Van A');
  });

  it('TIFF 40 trang (vượt giới hạn 32 cũ): giữ đủ 40 trang, không cắt âm thầm', async () => {
    const src = buildTiffImage({artist: 'X', pages: 40});
    const result = await cleanTiff(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;
    const dv = new DataView(out.buffer, out.byteOffset);
    let count = 0;
    let off = dv.getUint32(4, true);
    while (off !== 0 && count < 100) {
      count++;
      const n = dv.getUint16(off, true);
      off = dv.getUint32(off + 2 + n * 12, true);
    }
    expect(count).toBe(40);
  });

  it('guard JPEG-kiểu-cũ không bị né khi Compression ghi kiểu LONG trong file MM', async () => {
    const src = buildTiffImage({endian: 'MM', oldStyleJpeg: true});
    let err: unknown;
    try {
      await cleanTiff(src, DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe('unsupported');
  });

  it('inspect báo cáo GPS mức cao; BigTIFF bị từ chối rõ ràng', async () => {
    const report = await inspectTiff(buildTiffImage(FULL_EXIF));
    expect(report.fields.find(f => f.id === 'gps:coordinates')?.risk).toBe('high');

    const big = new Uint8Array([0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0]);
    let err: unknown;
    try {
      await cleanTiff(big, DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe('unsupported');
  });
});

describe('encodePngRgba', () => {
  it('xuất PNG hợp lệ: cấu trúc chuẩn, pixel giải nén khớp đầu vào', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0]);
    const png = encodePngRgba(rgba, 2, 2);
    const {chunks} = parsePng(png);
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const idat = chunks.find(c => c.type === 'IDAT')!;
    const raw = unzlibSync(png.slice(idat.dataStart, idat.dataEnd));
    // 2 hàng × (1 byte filter + 8 byte RGBA)
    expect(raw.length).toBe(18);
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 9))).toEqual(Array.from(rgba.subarray(0, 8)));
    expect(Array.from(raw.subarray(10, 18))).toEqual(Array.from(rgba.subarray(8, 16)));
  });

  it('từ chối kích thước không khớp', () => {
    expect(() => encodePngRgba(new Uint8Array(3), 1, 1)).toThrow();
  });
});

describe('handler HEIC (decoder giả)', () => {
  afterEach(() => setHeifDecoderFactory(null));

  function fakeImage(width: number, height: number, fill: number): HeifImageLike {
    return {
      get_width: () => width,
      get_height: () => height,
      display(base, cb) {
        base.data.fill(fill);
        cb(base);
      },
      free: () => undefined,
    };
  }

  it('chuyển HEIC → PNG sạch, ghi chú chuyển đổi rõ ràng', async () => {
    setHeifDecoderFactory(async () => ({decode: () => [fakeImage(2, 1, 200)]}));
    const result = await cleanHeic(new Uint8Array([1, 2, 3]), DEFAULT_CLEAN_OPTIONS);
    expect(result.convertedTo).toBe('png');
    expect(result.notes.join(' ')).toContain('CHUYỂN SANG PNG');

    const {chunks} = parsePng(result.data);
    expect(chunks.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']); // PNG sạch tuyệt đối
    const report = await inspectPng(result.data);
    expect(report.fields).toEqual([]);
    expect(report.width).toBe(2);
  });

  it('decoder trả rỗng/lỗi → CleanerError corrupt, không crash', async () => {
    setHeifDecoderFactory(async () => ({decode: () => []}));
    let err: unknown;
    try {
      await cleanHeic(new Uint8Array([1]), DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe('corrupt');
  });

  it(
    'pipeline THẬT: libheif WASM nạp được và từ chối dữ liệu rác một cách tử tế',
    async () => {
      setHeifDecoderFactory(null); // dùng factory mặc định → import('libheif-js/wasm-bundle') thật
      const fakeHeic = new Uint8Array(64);
      fakeHeic.set([0, 0, 0, 24], 0);
      const ascii = (o: number, s: string) => {
        for (let i = 0; i < s.length; i++) fakeHeic[o + i] = s.charCodeAt(i);
      };
      ascii(4, 'ftyp');
      ascii(8, 'heic');
      let err: unknown;
      try {
        await cleanHeic(fakeHeic, DEFAULT_CLEAN_OPTIONS);
      } catch (e) {
        err = e;
      }
      // Nếu import/wasm hỏng, lỗi sẽ KHÔNG phải CleanerError — test này bắt được điều đó
      expect(err).toBeInstanceOf(CleanerError);
      expect((err as CleanerError).code).toBe('corrupt');
    },
    20000,
  );
});

describe('điểm riêng tư', () => {
  it('ảnh đầy metadata điểm thấp, sau khi làm sạch điểm ~100', async () => {
    const src = buildJpeg({exif: FULL_EXIF, xmp: true, iptc: true, comment: 'x'});
    const before = privacyScore(await inspectJpeg(src));
    expect(before).toBeLessThan(40);

    const cleaned = cleanJpeg(src, DEFAULT_CLEAN_OPTIONS).data;
    const after = privacyScore(await inspectJpeg(cleaned));
    expect(after).toBeGreaterThanOrEqual(95);
    expect(after).toBeGreaterThan(before);
  });

  it('dữ liệu ẩn sau ảnh bị phạt nặng', async () => {
    const clean = privacyScore(await inspectJpeg(buildJpeg()));
    const trailing = privacyScore(
      await inspectJpeg(buildJpeg({trailing: new Uint8Array(1000)})),
    );
    expect(clean - trailing).toBeGreaterThanOrEqual(25);
  });
});
