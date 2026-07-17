// Handler PDF (pdf-lib, nạp lười ~178KB gzip):
// - Xoá Info dictionary (Title/Author/Producer/AAPL:Keywords/ngày giờ) + trailer /ID
// - Xoá luồng XMP metadata — cả THAM CHIẾU lẫn OBJECT (pdf-lib ghi ra file mọi
//   object trong map kể cả mồ côi, nên chỉ xoá tham chiếu là dữ liệu vẫn sót!)
// - Xoá /PieceInfo + /LastModified (trang + catalog), tên người ghi chú (/T annotation)
// - PDF mã hoá → bắt EncryptedPDFError bằng instanceof (tên class bị minify khi build)
// pdf-lib GHI LẠI TOÀN BỘ file (full rewrite) — nội dung trang giữ nguyên.

import {unzlibSync} from 'fflate';
import {CleanerError, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {scrubXmpGps} from '../xmp-scrub';

type PdfLibModule = typeof import('pdf-lib');
type PdfDoc = import('pdf-lib').PDFDocument;

let pdfLibPromise: Promise<PdfLibModule> | null = null;
function loadPdfLib(): Promise<PdfLibModule> {
  pdfLibPromise ??= import('pdf-lib');
  return pdfLibPromise;
}

async function loadDoc(bytes: Uint8Array): Promise<{lib: PdfLibModule; doc: PdfDoc}> {
  const lib = await loadPdfLib();
  try {
    const doc = await lib.PDFDocument.load(bytes, {
      // updateMetadata mặc định TRUE sẽ tự cấy Producer='pdf-lib' + ModDate mới!
      updateMetadata: false,
      // Trong worker không cần throttle theo tick — chạy hết tốc lực
      parseSpeed: lib.ParseSpeeds.Fastest,
    });
    if (doc.getPageCount() === 0) {
      // pdf-lib rất bao dung — file rác vẫn "load" được thành doc 0 trang
      throw new CleanerError('corrupt', 'File PDF không có trang nào (hỏng hoặc giả mạo).');
    }
    return {lib, doc};
  } catch (err) {
    if (err instanceof CleanerError) throw err;
    if (err instanceof lib.EncryptedPDFError) {
      throw new CleanerError(
        'unsupported',
        'PDF được mã hoá / bảo vệ mật khẩu — hãy gỡ mật khẩu trước rồi thử lại.',
      );
    }
    throw new CleanerError(
      'corrupt',
      `Không đọc được file PDF: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const SAVE_OPTIONS = {
  useObjectStreams: false, // xref cổ điển — tương thích tối đa
  addDefaultPage: false,
  updateFieldAppearances: false, // không tự vẽ lại form (tránh đổi nội dung + nhúng font)
} as const;

/**
 * Đọc nội dung luồng XMP. Trả `readable:false` nếu có stream nhưng không giải mã
 * được (filter lạ / lồng nhau) — khi đó chế độ gpsOnly phải XOÁ HẲN thay vì trấn an.
 */
function readXmpStream(
  lib: PdfLibModule,
  doc: PdfDoc,
): {xml: string; ref: unknown; readable: boolean} | null {
  const ref = doc.catalog.get(lib.PDFName.of('Metadata'));
  if (!ref) return null;
  try {
    const stream = doc.context.lookup(ref);
    if (!stream || !(stream instanceof lib.PDFRawStream)) return {xml: '', ref, readable: false};
    // Filter có thể là tên, mảng, hoặc tham chiếu gián tiếp — resolve rồi kiểm
    const filterRaw = stream.dict.get(lib.PDFName.of('Filter'));
    const filterObj = filterRaw instanceof lib.PDFRef ? doc.context.lookup(filterRaw) : filterRaw;
    const filterStr = filterObj ? String(filterObj) : '';
    const raw = stream.getContents();
    if (!filterStr) return {xml: decodeUtf8(raw), ref, readable: true};
    if (filterStr.includes('FlateDecode') && !filterStr.includes('DCTDecode')) {
      // Chỉ giải mã khi Flate là filter DUY NHẤT (chuỗi filter lồng nhau thì bỏ qua)
      const onlyFlate = /^\/?FlateDecode$/.test(filterStr.trim()) || /^\[\s*\/FlateDecode\s*\]$/.test(filterStr.trim());
      if (onlyFlate) return {xml: decodeUtf8(unzlibSync(raw)), ref, readable: true};
    }
    return {xml: '', ref, readable: false};
  } catch {
    return {xml: '', ref, readable: false};
  }
}

/** Xoá cả tham chiếu lẫn object thật (chống object mồ côi bị ghi ra file). */
function deleteCatalogRef(lib: PdfLibModule, doc: PdfDoc, name: string): boolean {
  const key = lib.PDFName.of(name);
  const ref = doc.catalog.get(key);
  if (!ref) return false;
  if (ref instanceof lib.PDFRef) doc.context.delete(ref);
  doc.catalog.delete(key);
  return true;
}

export async function cleanPdf(bytes: Uint8Array, options: CleanOptions): Promise<CleanResult> {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  const {lib, doc} = await loadDoc(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const {PDFName, PDFRef, PDFDict} = lib;

  if (options.gpsOnly) {
    // PDF hầu như không chứa GPS ngoài XMP (từ ảnh scan) — chỉ gột XMP
    const xmp = readXmpStream(lib, doc);
    if (!xmp) {
      notes.push('PDF không có XMP — chế độ "chỉ xoá GPS" không thay đổi gì.');
      return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
    }
    if (!xmp.readable) {
      // Có XMP nhưng không đọc được nội dung → không thể lọc chọn lọc, xoá HẲN
      // cho chắc (thà mất cả XMP còn hơn để sót GPS mà báo "đã sạch")
      if (xmp.ref instanceof PDFRef) doc.context.delete(xmp.ref);
      doc.catalog.delete(PDFName.of('Metadata'));
      removed.push({kind: 'xmp', bytes: 0, note: 'XMP không đọc được nội dung — xoá hẳn để chắc chắn không sót GPS'});
      const data = await doc.save(SAVE_OPTIONS);
      return {data, removed, bytesRemoved: Math.max(0, bytes.length - data.length), notes};
    }
    const scrubbed = scrubXmpGps(xmp.xml);
    if (scrubbed.removed === 0) {
      notes.push('XMP của PDF không chứa GPS — không có gì để xoá.');
      return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
    }
    if (xmp.ref instanceof PDFRef) doc.context.delete(xmp.ref); // xoá stream cũ thật sự
    // Mã hoá UTF-8 thành BYTES trước — flateStream(chuỗi) sẽ cắt cụt ký tự > 0xFF
    // (BOM, tiếng Việt) bằng charCodeAt, làm hỏng gói XMP
    const stream = doc.context.flateStream(new TextEncoder().encode(scrubbed.xml), {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    removed.push({kind: 'xmp', bytes: 0, note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`});
    const data = await doc.save(SAVE_OPTIONS);
    notes.push('PDF được ghi lại toàn bộ (nội dung trang giữ nguyên).');
    return {data, removed, bytesRemoved: Math.max(0, bytes.length - data.length), notes};
  }

  // 1. Luồng XMP: xoá tham chiếu + object
  const xmp = readXmpStream(lib, doc);
  if (deleteCatalogRef(lib, doc, 'Metadata')) {
    removed.push({kind: 'xmp', bytes: xmp ? xmp.xml.length : 0, note: 'luồng XMP metadata'});
  }
  // PieceInfo cấp tài liệu (dấu vết phần mềm, vd Illustrator)
  if (deleteCatalogRef(lib, doc, 'PieceInfo')) {
    removed.push({kind: 'pdf-page-meta', bytes: 0, note: 'PieceInfo của tài liệu'});
  }

  // 2. Metadata từng trang + tên người ghi chú
  let pieceInfo = 0;
  let annotAuthors = 0;
  for (const page of doc.getPages()) {
    for (const key of ['PieceInfo', 'LastModified']) {
      if (page.node.has(PDFName.of(key))) {
        page.node.delete(PDFName.of(key));
        pieceInfo++;
      }
    }
    try {
      const annots = doc.context.lookupMaybe(page.node.Annots(), lib.PDFArray);
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          const annot = doc.context.lookup(annots.get(i));
          if (!(annot instanceof PDFDict) || !annot.has(PDFName.of('T'))) continue;
          // /T trên Widget là TÊN FORM FIELD (không phải tác giả) — xoá sẽ phá form
          const subtype = annot.get(PDFName.of('Subtype'));
          if (subtype && String(subtype) === '/Widget') continue;
          annot.delete(PDFName.of('T'));
          annotAuthors++;
        }
      }
    } catch {
      // annotation hỏng — bỏ qua, không chặn việc xoá phần còn lại
    }
  }
  if (pieceInfo > 0) {
    removed.push({kind: 'pdf-page-meta', bytes: 0, note: `${pieceInfo} mục PieceInfo/LastModified của trang`});
  }
  if (annotAuthors > 0) {
    removed.push({kind: 'authors', bytes: 0, note: `${annotAuthors} tên người trong ghi chú (annotation)`});
    notes.push(`Đã xoá ${annotAuthors} tên người khỏi các ghi chú/comment trong PDF.`);
  }

  // 3. Trailer /ID (MD5 sinh từ đường dẫn file + thời điểm tạo — cũng là dấu vết)
  if (doc.context.trailerInfo.ID !== undefined) {
    doc.context.trailerInfo.ID = undefined;
    removed.push({kind: 'pdf-id', bytes: 0, note: 'trailer /ID (định danh file)'});
  }

  // 4. Info dictionary — LÀM CUỐI CÙNG: mọi lời gọi get/set metadata sau bước này
  //    sẽ tự tạo lại Info dict mới!
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef !== undefined) {
    if (infoRef instanceof PDFRef) doc.context.delete(infoRef);
    doc.context.trailerInfo.Info = undefined; // trailer khi save sẽ không còn key /Info
    removed.push({kind: 'pdf-info', bytes: 0, note: 'Info dictionary (Title/Author/Producer/ngày giờ)'});
  }

  const data = await doc.save(SAVE_OPTIONS);
  notes.push(
    'PDF được ghi lại toàn bộ bằng cấu trúc mới — object cũ không còn sót lại trong file (nội dung trang giữ nguyên).',
  );
  return {data, removed, bytesRemoved: Math.max(0, bytes.length - data.length), notes};
}

export async function inspectPdf(bytes: Uint8Array): Promise<MetadataReport> {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  const {lib, doc} = await loadDoc(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const warnings: string[] = [];

  const push = (id: string, tag: string, value: string | Date | undefined, risk: 'high' | 'medium' | 'low'): void => {
    if (value === undefined || value === '') return;
    const text =
      value instanceof Date
        ? value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
        : String(value);
    fields.push({id: `pdf:${id}`, group: 'PDF', tag, value: text.slice(0, 300), risk});
  };

  try {
    push('author', 'Tác giả', doc.getAuthor(), 'high');
    push('title', 'Tiêu đề', doc.getTitle(), 'medium');
    push('subject', 'Chủ đề', doc.getSubject(), 'medium');
    push('keywords', 'Từ khoá', doc.getKeywords(), 'medium');
    push('creator', 'Phần mềm tạo', doc.getCreator(), 'medium');
    push('producer', 'Phần mềm xuất (Producer)', doc.getProducer(), 'medium');
    push('creationDate', 'Ngày tạo', doc.getCreationDate() ?? undefined, 'medium');
    push('modificationDate', 'Ngày sửa', doc.getModificationDate() ?? undefined, 'medium');
  } catch {
    warnings.push('Không đọc được một phần Info dictionary.');
  }

  const xmp = readXmpStream(lib, doc);
  if (xmp) {
    metaSegments.push({kind: 'xmp', bytes: xmp.xml.length, note: 'luồng XMP metadata'});
    const hasGps = /GPS\w+/i.test(xmp.xml);
    fields.push({
      id: 'pdf:xmp',
      group: 'XMP',
      tag: 'XMP',
      value: xmp.readable
        ? `Gói XMP (${xmp.xml.length.toLocaleString('vi-VN')} ký tự)${hasGps ? ' — CÓ chứa toạ độ GPS' : ''}`
        : 'Gói XMP (không đọc được nội dung — sẽ xoá hẳn khi làm sạch)',
      risk: 'high',
    });
  }

  // Tên người trong annotation
  const annotAuthors = new Set<string>();
  try {
    for (const page of doc.getPages()) {
      const annots = doc.context.lookupMaybe(page.node.Annots(), lib.PDFArray);
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annot = doc.context.lookup(annots.get(i));
        if (annot instanceof lib.PDFDict) {
          const subtype = annot.get(lib.PDFName.of('Subtype'));
          if (subtype && String(subtype) === '/Widget') continue; // form field, không phải tác giả
          const t = annot.get(lib.PDFName.of('T'));
          if (t && 'decodeText' in t && typeof (t as {decodeText: () => string}).decodeText === 'function') {
            annotAuthors.add((t as {decodeText: () => string}).decodeText());
          }
        }
      }
    }
  } catch {
    // bỏ qua annotation hỏng
  }
  if (annotAuthors.size > 0) {
    fields.push({
      id: 'pdf:annotAuthors',
      group: 'PDF',
      tag: 'Tên người trong ghi chú',
      value: [...annotAuthors].slice(0, 10).join(', '),
      risk: 'high',
    });
  }

  return {
    format: 'pdf',
    fileSize: bytes.length,
    fields,
    metaSegments,
    trailingBytes: 0,
    warnings,
  };
}
