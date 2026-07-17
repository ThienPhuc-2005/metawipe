// Unit test handler Office (DOCX/ODT) và PDF.

import {describe, expect, it} from 'vitest';
import {unzipSync} from 'fflate';
import {PDFDocument, PDFName, PDFDict, PDFString} from 'pdf-lib';
import {buildDocx, buildOdt, buildPptxModern, latin1Encode} from './fixtures';
import {cleanOffice, inspectOffice} from '../src/lib/handlers/office';
import {cleanPdf, inspectPdf} from '../src/lib/handlers/pdf';
import {CleanerError, decodeUtf8} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const fullDocx = () =>
  buildDocx({
    creator: 'Nguyen Van A',
    lastModifiedBy: 'Tran Thi B',
    company: 'Cong ty TNHH Test',
    custom: true,
    comments: [{author: 'Le Van C', text: 'gop y doan nay'}],
    trackedAuthor: 'Pham Thi D',
    people: true,
  });

describe('cleanOffice — DOCX', () => {
  it('xoá sạch tác giả/công ty/ngày giờ; nội dung văn bản giữ nguyên; file vẫn giải nén được', async () => {
    const src = fullDocx();
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const entries = unzipSync(result.data);

    const core = decodeUtf8(entries['docProps/core.xml']);
    expect(core).not.toContain('Nguyen Van A');
    expect(core).not.toContain('Tran Thi B');
    expect(core).not.toContain('2026-04-15');

    const app = decodeUtf8(entries['docProps/app.xml']);
    expect(app).not.toContain('Cong ty');
    expect(app).not.toContain('TotalTime');

    expect(entries['docProps/custom.xml']).toBeUndefined();
    // Tham chiếu tới custom.xml phải được gỡ khỏi CẢ [Content_Types] lẫn .rels
    expect(decodeUtf8(entries['[Content_Types].xml'])).not.toContain('custom.xml');
    expect(decodeUtf8(entries['_rels/.rels'])).not.toContain('custom.xml');

    // Nội dung giữ nguyên
    const doc = decodeUtf8(entries['word/document.xml']);
    expect(doc).toContain('Noi dung van ban giu nguyen.');
    expect(doc).toContain('them vao'); // tracked change còn, chỉ ẩn danh tác giả
  });

  it('ẩn danh hoá tên người trong comment, tracked changes và people.xml', async () => {
    const src = fullDocx();
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const entries = unzipSync(result.data);
    const all = Object.keys(entries)
      .map(k => decodeUtf8(entries[k]))
      .join('\n');
    expect(all).not.toContain('Le Van C');
    expect(all).not.toContain('Pham Thi D');
    // comments.xml vẫn còn (giữ nội dung góp ý), chỉ đổi tên
    const comments = decodeUtf8(entries['word/comments.xml']);
    expect(comments).toContain('gop y doan nay');
    expect(comments).toContain('w:author="Người dùng"');
    // people.xml còn nhưng đã ẩn danh + userId rỗng
    const people = decodeUtf8(entries['word/people.xml']);
    expect(people).toContain('w15:author="Người dùng"');
    expect(people).toContain('w15:userId=""');
    expect(result.notes.some(n => n.includes('ẩn danh'))).toBe(true);
  });

  it('inspect liệt kê đủ: tác giả cao, công ty cao, thời gian chỉnh sửa, tên người trong comment', async () => {
    const report = await inspectOffice(fullDocx());
    expect(report.format).toBe('docx');
    const get = (tag: string) => report.fields.find(f => f.tag.includes(tag));
    expect(get('Tác giả')?.value).toBe('Nguyen Van A');
    expect(get('Tác giả')?.risk).toBe('high');
    expect(get('Người sửa cuối')?.value).toBe('Tran Thi B');
    expect(get('Công ty')?.risk).toBe('high');
    expect(get('Tổng thời gian')?.value).toContain('95 phút');
    expect(get('comment/tracked')?.value).toContain('Le Van C');
    expect(get('comment/tracked')?.value).toContain('Pham Thi D');
    expect(get('custom.xml')?.value).toContain('MaNhanVien');
  });

  it('gỡ tham chiếu custom.xml với mọi kiểu ghi Relationship (tuyệt đối, nháy đơn)', async () => {
    for (const relStyle of ['relative', 'absolute', 'singlequote'] as const) {
      const src = buildDocx({custom: true, relStyle});
      const entries = unzipSync((await cleanOffice(src, DEFAULT_CLEAN_OPTIONS)).data);
      expect(entries['docProps/custom.xml'], relStyle).toBeUndefined();
      const rels = decodeUtf8(entries['_rels/.rels']);
      // Không còn relationship treo tới part đã xoá
      expect(rels.includes('custom.xml'), `relStyle=${relStyle}`).toBe(false);
    }
  });

  it('ẩn danh tracked changes trong HEADER (không chỉ document.xml)', async () => {
    const src = buildDocx({headerTrackedAuthor: 'Nguyen Van A'});
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const header = decodeUtf8(unzipSync(result.data)['word/header1.xml']);
    expect(header).not.toContain('Nguyen Van A');
    expect(header).toContain('w:author="Người dùng"');
    expect(header).toContain('sua header'); // nội dung giữ nguyên
  });

  it('PowerPoint modern comments: ẩn danh tên + userId trong ppt/authors.xml', async () => {
    const src = buildPptxModern('Nguyen Van A');
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const authors = decodeUtf8(unzipSync(result.data)['ppt/authors.xml']);
    expect(authors).not.toContain('Nguyen Van A');
    expect(authors).not.toContain('@cty.vn');
    expect(authors).toContain('name="Người dùng"');
    // inspect cũng phải thấy tên này
    const report = await inspectOffice(src);
    expect(report.fields.some(f => f.value.includes('Nguyen Van A'))).toBe(true);
  });

  it('chỉ xoá GPS: tài liệu không đổi, có ghi chú giải thích', async () => {
    const src = fullDocx();
    const result = await cleanOffice(src, {keepIcc: true, keepOrientation: true, gpsOnly: true});
    expect(Array.from(result.data)).toEqual(Array.from(src));
    expect(result.notes.join(' ')).toContain('GPS');
  });

  it('ZIP thường (không phải Office) → unsupported; rác → corrupt', async () => {
    const {zipSync} = await import('fflate');
    const plainZip = zipSync({'anh.txt': latin1Encode('xin chao')});
    let err: unknown;
    try {
      await cleanOffice(plainZip, DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe('unsupported');

    let err2: unknown;
    try {
      await cleanOffice(latin1Encode('PK\x03\x04rac-rong'), DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(CleanerError);
  });
});

describe('cleanOffice — ODT', () => {
  it('meta.xml thành bản rỗng; mimetype vẫn đứng ĐẦU và KHÔNG nén', async () => {
    const src = buildOdt({creator: 'Nguyen Van A'});
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const entries = unzipSync(result.data);

    const meta = decodeUtf8(entries['meta.xml']);
    expect(meta).not.toContain('Nguyen Van A');
    expect(meta).not.toContain('LibreOffice');
    expect(meta).toContain('office:document-meta');
    expect(decodeUtf8(entries['content.xml'])).toContain('Noi dung.');

    // Chuẩn ODF: chuỗi 'mimetype' tại offset 30, media type tại offset 38, STORED (method=0)
    const out = result.data;
    expect(decodeUtf8(out.subarray(30, 38))).toBe('mimetype');
    expect(decodeUtf8(out.subarray(38, 38 + 39))).toContain('opendocument.text');
    const method = out[8] | (out[9] << 8); // local header: compression method tại offset 8
    expect(method).toBe(0);
  });

  it('inspect đọc người tạo/phần mềm/số lần sửa từ meta.xml', async () => {
    const report = await inspectOffice(buildOdt({creator: 'Nguyen Van A'}));
    expect(report.format).toBe('odt');
    expect(report.fields.some(f => f.value === 'Nguyen Van A' && f.risk === 'high')).toBe(true);
    expect(report.fields.some(f => f.value.includes('LibreOffice'))).toBe(true);
    expect(report.fields.some(f => f.tag.includes('Số lần chỉnh sửa'))).toBe(true);
  });

  it('ẩn danh comment (office:annotation) nằm trong content.xml, giữ nội dung', async () => {
    const src = buildOdt({creator: 'Nguyen Van A', comment: 'gop y trong tai lieu'});
    const result = await cleanOffice(src, DEFAULT_CLEAN_OPTIONS);
    const content = decodeUtf8(unzipSync(result.data)['content.xml']);
    expect(content).not.toContain('Nguyen Van A');
    expect(content).toContain('gop y trong tai lieu'); // nội dung comment giữ
    expect(content).toContain('Người dùng');
    // inspect thấy tên trong content.xml
    const report = await inspectOffice(src);
    expect(report.fields.some(f => f.value.includes('Nguyen Van A'))).toBe(true);
  });

  it('xoá ảnh thumbnail xem trước của ODF (Thumbnails/)', async () => {
    const src = buildOdt({thumbnail: true});
    const entries = unzipSync((await cleanOffice(src, DEFAULT_CLEAN_OPTIONS)).data);
    expect(entries['Thumbnails/thumbnail.png']).toBeUndefined();
  });
});

describe('handler PDF', () => {
  async function makePdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle('Bao cao noi bo');
    doc.setAuthor('Nguyen Van A');
    doc.setSubject('tai lieu mat');
    doc.setKeywords(['bi mat', 'noi bo']);
    doc.setCreator('Word 2026');
    doc.setProducer('PrintDriver 3.0');
    doc.setCreationDate(new Date('2026-04-15T10:20:30Z'));
    doc.setModificationDate(new Date('2026-04-16T08:00:00Z'));
    const page = doc.addPage([200, 100]);
    page.drawText('Noi dung PDF', {x: 10, y: 50, size: 12});
    return doc.save({useObjectStreams: false});
  }

  it('xoá sạch Info dictionary — mở lại không còn trường nào, kể cả chuỗi thô trong file', async () => {
    const src = await makePdf();
    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);

    const reloaded = await PDFDocument.load(result.data, {updateMetadata: false});
    expect(reloaded.getAuthor()).toBeUndefined();
    expect(reloaded.getTitle()).toBeUndefined();
    expect(reloaded.getProducer()).toBeUndefined();
    expect(reloaded.getCreationDate()).toBeUndefined();
    expect(reloaded.getPageCount()).toBe(1);

    // Object mồ côi không được sót lại trong file (bài học từ nghiên cứu pdf-lib)
    const text = String.fromCharCode(...result.data);
    expect(text).not.toContain('Nguyen Van A');
    expect(text).not.toContain('Bao cao noi bo');
    expect(text).not.toContain('PrintDriver');
  });

  it('inspect đọc đủ trường: tác giả mức cao, producer/ngày giờ mức trung bình', async () => {
    const report = await inspectPdf(await makePdf());
    expect(report.format).toBe('pdf');
    const author = report.fields.find(f => f.tag === 'Tác giả');
    expect(author?.value).toBe('Nguyen Van A');
    expect(author?.risk).toBe('high');
    expect(report.fields.some(f => f.tag.includes('Producer'))).toBe(true);
    expect(report.fields.some(f => f.tag === 'Ngày tạo')).toBe(true);
  });

  it('xoá luồng XMP cả tham chiếu lẫn object', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const xmp = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description creatorTool="SecretTool 1.0"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const stream = doc.context.stream(xmp, {Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML')});
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    const src = await doc.save({useObjectStreams: false});
    expect(String.fromCharCode(...src)).toContain('SecretTool');

    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    expect(String.fromCharCode(...result.data)).not.toContain('SecretTool');
    expect(result.removed.some(r => r.kind === 'xmp')).toBe(true);
  });

  it('form field (Widget) KHÔNG bị phá — /T tên trường được giữ, chỉ xoá /T ghi chú', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const form = doc.getForm();
    const tf = form.createTextField('hoTen');
    tf.addToPage(page, {x: 20, y: 100, width: 200, height: 20});
    // Thêm một annotation ghi chú (Text) có tên tác giả
    const noteRef = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        T: PDFString.of('Nguoi Ghi Chu'),
        Contents: PDFString.of('ghi chu'),
      }),
    );
    const annots = page.node.Annots();
    annots!.push(noteRef);
    const src = await doc.save({useObjectStreams: false});

    const result = await cleanPdf(src, DEFAULT_CLEAN_OPTIONS);
    const reloaded = await PDFDocument.load(result.data, {updateMetadata: false});
    // Form field vẫn còn tên → form không vỡ
    expect(reloaded.getForm().getFields().map(f => f.getName())).toContain('hoTen');
    // Tên người ghi chú đã bị xoá
    expect(String.fromCharCode(...result.data)).not.toContain('Nguoi Ghi Chu');
    expect(result.removed.some(r => r.kind === 'authors')).toBe(true);
  });

  it('gpsOnly: XMP tiếng Việt + BOM không bị hỏng khi ghi lại (mã hoá UTF-8 đúng)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const xmp =
      '﻿<?xpacket begin="﻿"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r">' +
      '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="21,1.71N"' +
      ' dc:title="Tài liệu tiếng Việt có dấu ăn"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const stream = doc.context.flateStream(new TextEncoder().encode(xmp), {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    const src = await doc.save({useObjectStreams: false});

    const result = await cleanPdf(src, {keepIcc: true, keepOrientation: true, gpsOnly: true});
    // Đọc lại XMP đã ghi
    const reloaded = await PDFDocument.load(result.data, {updateMetadata: false});
    const mRef = reloaded.catalog.get(PDFName.of('Metadata'));
    const mStream = reloaded.context.lookup(mRef) as any;
    const raw = mStream.getContents();
    const {unzlibSync} = await import('fflate');
    const text = new TextDecoder('utf-8').decode(unzlibSync(raw));
    expect(text).not.toMatch(/GPSLatitude/); // GPS đã gỡ
    expect(text).toContain('tiếng Việt có dấu ăn'); // tiếng Việt còn nguyên, không bị cắt cụt
    expect(result.removed.some(r => r.kind === 'xmp')).toBe(true);
  });

  it('PDF hỏng → corrupt, không crash', async () => {
    let err: unknown;
    try {
      await cleanPdf(latin1Encode('%PDF-1.7 nhung rong tuech'), DEFAULT_CLEAN_OPTIONS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CleanerError);
    expect((err as CleanerError).code).toBe('corrupt');
  });
});
