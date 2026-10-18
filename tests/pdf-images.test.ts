// Unit test ảnh nhúng trong PDF: PDF xuất từ Word/điện thoại chứa nguyên file JPEG
// (DCTDecode) kèm EXIF/GPS — làm sạch PDF phải làm sạch cả ảnh bên trong.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {PDFDocument, PDFName, PDFRawStream} from 'pdf-lib';
import {buildJpeg, HANOI_GPS, latin1Encode} from './fixtures';
import {cleanPdf, inspectPdf} from '../src/lib/handlers/pdf';
import {parseJpeg} from '../src/lib/handlers/jpeg';
import {privacyScore} from '../src/lib/risk';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};

const gpsJpeg = () =>
  buildJpeg({exif: {make: 'Apple', model: 'iPhone 15', artist: 'Nguyen Van A', gps: HANOI_GPS}, xmp: true});

async function pdfWithImage(jpeg: Uint8Array, author?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({updateMetadata: false});
  if (author) doc.setAuthor(author);
  const page = doc.addPage([200, 200]);
  page.drawImage(await doc.embedJpg(jpeg), {x: 10, y: 10, width: 100, height: 100});
  return doc.save({useObjectStreams: false});
}

/** Nội dung mọi ảnh (Image XObject) trong file PDF. */
async function imagesOf(pdf: Uint8Array): Promise<PDFRawStream[]> {
  const doc = await PDFDocument.load(pdf, {updateMetadata: false});
  return doc.context
    .enumerateIndirectObjects()
    .map(([, obj]) => obj)
    .filter((obj): obj is PDFRawStream => obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image');
}

const entropy = (b: Uint8Array) => {
  const s = parseJpeg(b).segments.find(x => x.kind === 'entropy')!;
  return Array.from(b.subarray(s.start, s.end));
};

describe('cleanPdf — ảnh JPEG nhúng', () => {
  it('xoá EXIF/GPS/XMP khỏi ảnh JPEG trong PDF, dữ liệu ảnh nén giữ nguyên', async () => {
    const photo = gpsJpeg();
    const result = await cleanPdf(await pdfWithImage(photo), DEFAULT_CLEAN_OPTIONS);
    const [img] = await imagesOf(result.data);
    const data = img.getContents();

    expect(await exifr.gps(data).catch(() => undefined)).toBeUndefined();
    const kinds = parseJpeg(data).segments.map(s => s.kind);
    expect(kinds).not.toContain('exif');
    expect(kinds).not.toContain('xmp');
    expect(entropy(data)).toEqual(entropy(photo));
    expect(result.removed.some(r => r.kind === 'embedded-image')).toBe(true);
    expect(result.notes.join(' ')).toContain('ảnh nhúng');
  });

  it('inspect thấy GPS trong ảnh nhúng (kèm link bản đồ); đọc lại sau khi làm sạch thì hết', async () => {
    const src = await pdfWithImage(gpsJpeg());
    const before = await inspectPdf(src);
    const gps = before.fields.find(f => f.group === 'GPS');
    expect(gps?.tag).toMatch(/ảnh #\d+/);
    expect(gps?.mapUrl).toContain('openstreetmap');
    expect(before.fields.some(f => /^pdf:image:\d+$/.test(f.id) && f.risk === 'high')).toBe(true);

    const after = await inspectPdf((await cleanPdf(src, DEFAULT_CLEAN_OPTIONS)).data);
    expect(after.fields.filter(f => f.id.startsWith('pdf:image:'))).toEqual([]);
    expect(privacyScore(after)).toBeGreaterThan(privacyScore(before));
  });

  it('chỉ xoá GPS: gỡ GPS khỏi ảnh nhúng, giữ nguyên kiểu máy và tác giả PDF', async () => {
    const src = await pdfWithImage(gpsJpeg(), 'Nguyen Van A');
    const result = await cleanPdf(src, GPS_ONLY);
    const [img] = await imagesOf(result.data);

    expect(await exifr.gps(img.getContents()).catch(() => undefined)).toBeUndefined();
    const exif = await exifr.parse(img.getContents(), {ifd0: true} as never);
    expect(exif?.Model).toBe('iPhone 15');
    const doc = await PDFDocument.load(result.data, {updateMetadata: false});
    expect(doc.getAuthor()).toBe('Nguyen Van A');
    expect(result.removed.map(r => r.kind)).toEqual(['embedded-image']);
  });

  it('chỉ xoá GPS: PDF có ảnh nhưng không có GPS → giữ nguyên từng byte', async () => {
    const src = await pdfWithImage(buildJpeg({exif: {make: 'Canon'}}));
    const result = await cleanPdf(src, GPS_ONLY);
    expect(Array.from(result.data)).toEqual(Array.from(src));
    expect(result.notes.join(' ')).toContain('GPS');
  });

  it('gỡ luồng XMP gắn riêng trên ảnh (/Metadata của Image XObject), cả object lẫn tham chiếu', async () => {
    const doc = await PDFDocument.create({updateMetadata: false});
    const page = doc.addPage([200, 200]);
    const image = await doc.embedJpg(buildJpeg({}));
    page.drawImage(image, {x: 0, y: 0, width: 50, height: 50});
    await doc.flush();
    const xmp = doc.context.stream(latin1Encode('<x:xmpmeta><dc:creator>Nguyen Van A</dc:creator></x:xmpmeta>'), {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    const imageObj = doc.context.lookup(image.ref) as PDFRawStream;
    imageObj.dict.set(PDFName.of('Metadata'), doc.context.register(xmp));
    const src = await doc.save({useObjectStreams: false});

    const before = await inspectPdf(src);
    expect(before.fields.some(f => f.id.endsWith(':xmp') && f.group === 'XMP')).toBe(true);
    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    expect(new TextDecoder('latin1').decode(result.data)).not.toContain('Nguyen Van A');
    const [img] = await imagesOf(result.data);
    expect(img.dict.has(PDFName.of('Metadata'))).toBe(false);
  });

  it('ảnh JPEG nhúng hỏng: giữ nguyên để trang không mất hình, nhưng cảnh báo rõ', async () => {
    const doc = await PDFDocument.create({updateMetadata: false});
    doc.addPage([200, 200]);
    const broken = gpsJpeg().subarray(0, 40); // cắt cụt giữa segment EXIF
    doc.context.register(
      doc.context.stream(broken, {Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, Filter: 'DCTDecode'}),
    );
    const src = await doc.save({useObjectStreams: false});

    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    const [img] = await imagesOf(result.data);
    expect(Array.from(img.getContents())).toEqual(Array.from(broken));
    expect(result.notes.join(' ')).toMatch(/không đọc được 1 ảnh JPEG nhúng/);
    expect((await inspectPdf(src)).warnings.join(' ')).toMatch(/Không đọc được ảnh #\d+/);
  });
});
