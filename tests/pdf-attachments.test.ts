// Unit test tệp đính kèm trong PDF: tệp được GIỮ LẠI (là nội dung tác giả gửi kèm)
// nhưng metadata bên trong tệp và ngày tạo/sửa trong /Params phải được xoá.

import {describe, expect, it} from 'vitest';
import exifr from 'exifr';
import {unzipSync} from 'fflate';
import {PDFDocument, PDFName, PDFRawStream, PDFDict, PDFString, PDFHexString, decodePDFRawStream} from 'pdf-lib';
import {buildDocx, buildJpeg, HANOI_GPS, latin1Encode} from './fixtures';
import {cleanPdf, inspectPdf} from '../src/lib/handlers/pdf';
import {decodeUtf8} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};
const DATE = new Date('2026-04-15T10:20:30Z');

const gpsJpeg = () => buildJpeg({exif: {make: 'Apple', model: 'iPhone 15', gps: HANOI_GPS}});

async function pdfWithAttachment(data: Uint8Array, name: string, author?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({updateMetadata: false});
  if (author) doc.setAuthor(author);
  doc.addPage([200, 200]);
  await doc.attach(data, name, {mimeType: 'application/octet-stream', creationDate: DATE, modificationDate: DATE});
  return doc.save({useObjectStreams: false});
}

/** Các tệp đính kèm trong PDF: nội dung đã giải nén + dict Params. */
async function attachmentsOf(pdf: Uint8Array): Promise<Array<{data: Uint8Array; params?: PDFDict}>> {
  const doc = await PDFDocument.load(pdf, {updateMetadata: false});
  return doc.context
    .enumerateIndirectObjects()
    .map(([, obj]) => obj)
    .filter((obj): obj is PDFRawStream => obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Type'))) === '/EmbeddedFile')
    .map(s => ({data: decodePDFRawStream(s).decode(), params: s.dict.lookupMaybe(PDFName.of('Params'), PDFDict)}));
}

describe('cleanPdf — tệp đính kèm', () => {
  it('ảnh JPEG đính kèm: xoá GPS bên trong, xoá ngày tạo/sửa, cập nhật Size; tệp vẫn còn', async () => {
    const src = await pdfWithAttachment(gpsJpeg(), 'anh-hien-truong.jpg');
    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    const [att] = await attachmentsOf(result.data);

    expect(att).toBeDefined();
    expect(await exifr.gps(att.data).catch(() => undefined)).toBeUndefined();
    expect(att.params?.has(PDFName.of('CreationDate'))).toBe(false);
    expect(att.params?.has(PDFName.of('ModDate'))).toBe(false);
    expect(String(att.params?.get(PDFName.of('Size')))).toBe(String(att.data.length));
    expect(result.removed.map(r => r.kind)).toEqual(expect.arrayContaining(['attachment', 'attachment-dates']));
    expect(result.notes.join(' ')).toContain('anh-hien-truong.jpg');
  });

  it('inspect liệt kê tệp đính kèm, ngày tạo/sửa và GPS bên trong; sau khi làm sạch chỉ còn tên tệp', async () => {
    const src = await pdfWithAttachment(gpsJpeg(), 'anh-hien-truong.jpg');
    const before = await inspectPdf(src);
    expect(before.fields.some(f => f.tag === 'Tệp đính kèm' && f.value.includes('anh-hien-truong.jpg'))).toBe(true);
    expect(before.fields.some(f => f.id.endsWith(':dates') && f.risk === 'medium')).toBe(true);
    const gps = before.fields.find(f => f.group === 'GPS');
    expect(gps?.tag).toBe('Toạ độ GPS trong tệp đính kèm (anh-hien-truong.jpg)');

    const after = await inspectPdf((await cleanPdf(src, DEFAULT_CLEAN_OPTIONS)).data);
    const attFields = after.fields.filter(f => f.id.startsWith('pdf:attachment:'));
    expect(attFields.map(f => f.tag)).toEqual(['Tệp đính kèm']);
    expect(attFields[0].risk).toBe('low');
  });

  it('DOCX đính kèm: tên tác giả bên trong tệp bị xoá', async () => {
    const src = await pdfWithAttachment(buildDocx({creator: 'Nguyen Van A', company: 'Cong ty Bi Mat'}), 'hop-dong.docx');
    expect((await inspectPdf(src)).fields.some(f => f.tag === 'Metadata trong tệp đính kèm (hop-dong.docx)')).toBe(true);

    const [att] = await attachmentsOf((await cleanPdf(src, DEFAULT_CLEAN_OPTIONS)).data);
    const entries = unzipSync(att.data);
    expect(decodeUtf8(entries['docProps/core.xml'])).not.toContain('Nguyen Van A');
    expect(decodeUtf8(entries['docProps/app.xml'])).not.toContain('Bi Mat');
  });

  it('PDF đính kèm trong PDF: làm sạch đệ quy (tác giả của PDF con cũng bị xoá)', async () => {
    const child = await PDFDocument.create({updateMetadata: false});
    child.addPage([100, 100]);
    child.setAuthor('Tran Thi B');
    const src = await pdfWithAttachment(await child.save({useObjectStreams: false}), 'phu-luc.pdf');

    const [att] = await attachmentsOf((await cleanPdf(src, DEFAULT_CLEAN_OPTIONS)).data);
    const cleanedChild = await PDFDocument.load(att.data, {updateMetadata: false});
    expect(cleanedChild.getAuthor()).toBeUndefined();
    expect(new TextDecoder('latin1').decode(att.data)).not.toContain('Tran Thi B');
  });

  it('định dạng không hỗ trợ (XML hoá đơn): giữ nguyên từng byte, ghi chú rõ không làm sạch được', async () => {
    const xml = latin1Encode('<?xml version="1.0"?><Invoice><Seller>Cong ty A</Seller></Invoice>');
    const src = await pdfWithAttachment(xml, 'factur-x.xml');
    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    const [att] = await attachmentsOf(result.data);

    expect(Array.from(att.data)).toEqual(Array.from(xml));
    expect(result.notes.join(' ')).toMatch(/giữ nguyên 1 tệp đính kèm không làm sạch được \(factur-x\.xml\)/);
    expect((await inspectPdf(src)).warnings.join(' ')).toContain('factur-x.xml');
  });

  it('chỉ xoá GPS: gỡ GPS trong ảnh đính kèm, giữ ngày tạo/sửa và tác giả PDF', async () => {
    const src = await pdfWithAttachment(gpsJpeg(), 'anh.jpg', 'Nguyen Van A');
    const result = await cleanPdf(src, GPS_ONLY);
    const [att] = await attachmentsOf(result.data);

    expect(await exifr.gps(att.data).catch(() => undefined)).toBeUndefined();
    expect(att.params?.has(PDFName.of('CreationDate'))).toBe(true);
    const doc = await PDFDocument.load(result.data, {updateMetadata: false});
    expect(doc.getAuthor()).toBe('Nguyen Van A');
  });

  it('annotation FileAttachment (file spec nằm trực tiếp trong annotation): lấy đúng tên và làm sạch', async () => {
    const doc = await PDFDocument.create({updateMetadata: false});
    const page = doc.addPage([200, 200]);
    const fileRef = doc.context.register(doc.context.flateStream(gpsJpeg(), {Type: 'EmbeddedFile'}));
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [10, 10, 30, 30],
      FS: {Type: 'Filespec', F: PDFString.of('ghim.jpg'), EF: {F: fileRef}},
    });
    page.node.addAnnot(doc.context.register(annot));
    const src = await doc.save({useObjectStreams: false});

    expect((await inspectPdf(src)).fields.some(f => f.tag === 'Tệp đính kèm' && f.value.startsWith('ghim.jpg'))).toBe(true);
    const [att] = await attachmentsOf((await cleanPdf(src, DEFAULT_CLEAN_OPTIONS)).data);
    expect(await exifr.gps(att.data).catch(() => undefined)).toBeUndefined();
  });
  it('file spec nằm trực tiếp trong mảng /Names (kiểu PyMuPDF/Acrobat): vẫn lấy đúng tên tiếng Việt', async () => {
    const doc = await PDFDocument.create({updateMetadata: false});
    doc.addPage([200, 200]);
    const fileRef = doc.context.register(doc.context.flateStream(gpsJpeg(), {Type: 'EmbeddedFile'}));
    doc.catalog.set(
      PDFName.of('Names'),
      doc.context.obj({
        EmbeddedFiles: {
          Names: [
            PDFString.of('anh.jpg'),
            {Type: 'Filespec', F: PDFString.of('anh.jpg'), UF: PDFHexString.fromText('ảnh-hiện-trường.jpg'), EF: {F: fileRef}},
          ],
        },
      }),
    );
    const src = await doc.save({useObjectStreams: false});

    const report = await inspectPdf(src);
    expect(report.fields.some(f => f.tag === 'Tệp đính kèm' && f.value.startsWith('ảnh-hiện-trường.jpg'))).toBe(true);
    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.notes.join(' ')).toContain('ảnh-hiện-trường.jpg');
  });
});
