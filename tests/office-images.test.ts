// Unit test ảnh nhúng trong tài liệu Office: ảnh chụp điện thoại dán vào Word/ODT
// mang nguyên EXIF/GPS — làm sạch tài liệu phải làm sạch cả ảnh bên trong.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {unzipSync, zipSync} from 'fflate';
import {buildDocx, buildJpeg, buildOdt, buildPng, buildTiffExif, HANOI_GPS} from './fixtures';
import {cleanOffice, inspectOffice} from '../src/lib/handlers/office';
import {parseJpeg} from '../src/lib/handlers/jpeg';
import {privacyScore} from '../src/lib/risk';
import {decodeUtf8} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};

const gpsJpeg = () =>
  buildJpeg({exif: {make: 'Apple', model: 'iPhone 15', artist: 'Nguyen Van A', gps: HANOI_GPS}, xmp: true});

/** Thêm entry vào một gói ZIP có sẵn (mimetype ODF vẫn đứng đầu, không nén). */
function withEntries(zip: Uint8Array, extra: Record<string, Uint8Array>): Uint8Array {
  const entries = unzipSync(zip);
  const out: Record<string, [Uint8Array, {level: 0 | 6}]> = {};
  for (const [path, data] of Object.entries(entries)) out[path] = [data, {level: path === 'mimetype' ? 0 : 6}];
  for (const [path, data] of Object.entries(extra)) out[path] = [data, {level: 6}];
  return zipSync(out);
}

const docxWithPhoto = () => withEntries(buildDocx({creator: 'Nguyen Van A'}), {'word/media/image1.jpeg': gpsJpeg()});

describe('cleanOffice — ảnh nhúng', () => {
  it('DOCX: xoá EXIF/GPS/XMP khỏi ảnh trong word/media, dữ liệu ảnh nén giữ nguyên', async () => {
    const photo = gpsJpeg();
    const src = docxWithPhoto();
    const result = cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const img = unzipSync(result.data)['word/media/image1.jpeg'];

    expect(await exifr.gps(img).catch(() => undefined)).toBeUndefined();
    const kinds = parseJpeg(img).segments.map(s => s.kind);
    expect(kinds).not.toContain('exif');
    expect(kinds).not.toContain('xmp');
    // Lossless: segment dữ liệu nén y hệt bản gốc
    const entropy = (b: Uint8Array) => {
      const s = parseJpeg(b).segments.find(x => x.kind === 'entropy')!;
      return Array.from(b.subarray(s.start, s.end));
    };
    expect(entropy(img)).toEqual(entropy(photo));

    expect(result.removed.some(r => r.kind === 'embedded-image')).toBe(true);
    expect(result.notes.join(' ')).toContain('ảnh nhúng');
  });

  it('inspect thấy GPS trong ảnh nhúng (kèm link bản đồ); đọc lại sau khi làm sạch thì hết', async () => {
    const src = docxWithPhoto();
    const before = await inspectOffice(src);
    const gps = before.fields.find(f => f.group === 'GPS');
    expect(gps?.tag).toContain('image1.jpeg');
    expect(gps?.mapUrl).toContain('openstreetmap');
    expect(before.fields.some(f => f.id === 'office:image:word/media/image1.jpeg' && f.risk === 'high')).toBe(true);
    expect(before.metaSegments.some(s => s.kind === 'embedded-image')).toBe(true);

    const after = await inspectOffice(cleanOffice(src, DEFAULT_CLEAN_OPTIONS).data);
    expect(after.fields.filter(f => f.id.startsWith('office:image:'))).toEqual([]);
    expect(privacyScore(after)).toBeGreaterThan(privacyScore(before));
  });

  it('ODT: ảnh PNG có eXIf GPS trong Pictures/ cũng được làm sạch', async () => {
    const png = buildPng({exifTiff: buildTiffExif({gps: HANOI_GPS}), text: [['Author', 'Nguyen Van A']]});
    const src = withEntries(buildOdt(), {'Pictures/anh.png': png});
    expect((await inspectOffice(src)).fields.some(f => f.group === 'GPS')).toBe(true);

    const result = cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const entries = unzipSync(result.data);
    expect(decodeUtf8(entries['Pictures/anh.png'])).not.toContain('Nguyen Van A');
    expect((await inspectOffice(result.data)).fields.some(f => f.group === 'GPS')).toBe(false);
    // Quy tắc ODF vẫn giữ: mimetype đứng đầu gói
    expect(Object.keys(entries)[0]).toBe('mimetype');
  });

  it('nhận diện bằng magic bytes: ảnh JPEG mang đuôi .bin vẫn được làm sạch', async () => {
    const src = withEntries(buildDocx(), {'word/media/image1.bin': gpsJpeg()});
    const img = unzipSync(cleanOffice(src, DEFAULT_CLEAN_OPTIONS).data)['word/media/image1.bin'];
    expect(await exifr.gps(img).catch(() => undefined)).toBeUndefined();
  });

  it('chỉ xoá GPS: gỡ GPS khỏi ảnh nhúng, giữ nguyên tác giả và metadata khác', async () => {
    const src = docxWithPhoto();
    const result = cleanOffice(src, GPS_ONLY);
    const entries = unzipSync(result.data);
    const img = entries['word/media/image1.jpeg'];

    expect(await exifr.gps(img).catch(() => undefined)).toBeUndefined();
    const exif = await exifr.parse(img, {ifd0: true} as never);
    expect(exif?.Model).toBe('iPhone 15'); // chỉ GPS bị gỡ
    expect(decodeUtf8(entries['docProps/core.xml'])).toContain('Nguyen Van A');
    expect(result.removed.map(r => r.kind)).toEqual(['embedded-image']);
  });

  it('chỉ xoá GPS: ảnh nhúng không có GPS → tài liệu giữ nguyên từng byte', async () => {
    const src = withEntries(buildDocx(), {'word/media/image1.jpeg': buildJpeg({exif: {make: 'Canon'}})});
    const result = cleanOffice(src, GPS_ONLY);
    expect(Array.from(result.data)).toEqual(Array.from(src));
    expect(result.notes.join(' ')).toContain('GPS');
  });

  it('ảnh nhúng hỏng: giữ nguyên để tài liệu không mất hình, nhưng cảnh báo rõ', async () => {
    const broken = gpsJpeg().subarray(0, 40); // cắt cụt giữa segment EXIF
    const src = withEntries(buildDocx(), {'word/media/hong.jpeg': broken});
    const result = cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    expect(Array.from(unzipSync(result.data)['word/media/hong.jpeg'])).toEqual(Array.from(broken));
    expect(result.notes.join(' ')).toMatch(/không đọc được 1 ảnh nhúng \(hong\.jpeg\)/);
    expect((await inspectOffice(src)).warnings.join(' ')).toContain('hong.jpeg');
  });
});
