// Handler PDF (pdf-lib, nạp lười ~178KB gzip):
// - Xoá Info dictionary (Title/Author/Producer/AAPL:Keywords/ngày giờ) + trailer /ID
// - Xoá luồng XMP metadata — cả THAM CHIẾU lẫn OBJECT (pdf-lib ghi ra file mọi
//   object trong map kể cả mồ côi, nên chỉ xoá tham chiếu là dữ liệu vẫn sót!)
// - Xoá /PieceInfo + /LastModified (trang + catalog), tên người ghi chú (/T annotation)
// - Ảnh JPEG nhúng: xoá EXIF/GPS/XMP bằng handler JPEG (không nén lại) + XMP riêng của ảnh
// - Tệp đính kèm: GIỮ LẠI (là nội dung) nhưng làm sạch metadata bên trong + ngày tạo/sửa
// - PDF mã hoá → bắt EncryptedPDFError bằng instanceof (tên class bị minify khi build)
// pdf-lib GHI LẠI TOÀN BỘ file (full rewrite) — nội dung trang giữ nguyên.

import {unzlibSync} from 'fflate';
import {CleanerError, decodeUtf8} from '../binary';
import {DEFAULT_CLEAN_OPTIONS, type CleanOptions, type CleanResult, type MetadataField, type MetadataReport, type SegmentInfo} from '../types';
import {detectFormat} from '../detect';
import {scrubXmpGps} from '../xmp-scrub';
import {summarizeEmbeddedImage} from '../embedded-image';
import {cleanJpeg, inspectJpeg} from './jpeg';

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

type PdfRef = import('pdf-lib').PDFRef;
type PdfRawStream = import('pdf-lib').PDFRawStream;

/**
 * Mọi ảnh (Image XObject) trong file — kể cả ảnh không còn trang nào trỏ tới, vì
 * pdf-lib vẫn ghi object mồ côi ra file. `isJpeg` chỉ đúng khi DCTDecode là filter
 * DUY NHẤT: khi đó nội dung stream chính là một file JPEG hoàn chỉnh (kèm cả EXIF).
 */
function imageStreams(lib: PdfLibModule, doc: PdfDoc): Array<{ref: PdfRef; stream: PdfRawStream; isJpeg: boolean}> {
  const out: Array<{ref: PdfRef; stream: PdfRawStream; isJpeg: boolean}> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof lib.PDFRawStream)) continue;
    const subtype = obj.dict.get(lib.PDFName.of('Subtype'));
    if (!subtype || String(subtype) !== '/Image') continue;
    const filterRaw = obj.dict.get(lib.PDFName.of('Filter'));
    const filterObj = filterRaw instanceof lib.PDFRef ? doc.context.lookup(filterRaw) : filterRaw;
    const filterStr = filterObj ? String(filterObj).trim() : '';
    const isJpeg = /^\/DCTDecode$/.test(filterStr) || /^\[\s*\/DCTDecode\s*\]$/.test(filterStr);
    out.push({ref, stream: obj, isJpeg});
  }
  return out;
}

interface ImageCleanStats {
  cleaned: number;
  bytes: number;
  xmpRemoved: number;
  failed: number[];
}

/**
 * Ảnh nhúng: xoá EXIF/GPS/XMP trong ảnh JPEG (cùng tuỳ chọn với file lẻ, không nén
 * lại) và gỡ luồng XMP gắn riêng trên từng ảnh (/Metadata — Acrobat/InDesign hay ghi).
 * XMP của ảnh có thể nén bằng filter bất kỳ nên không lọc chọn lọc được: xoá hẳn,
 * kể cả ở chế độ chỉ xoá GPS (thà mất XMP còn hơn để sót toạ độ).
 */
function cleanImages(lib: PdfLibModule, doc: PdfDoc, options: CleanOptions): ImageCleanStats {
  const stats: ImageCleanStats = {cleaned: 0, bytes: 0, xmpRemoved: 0, failed: []};
  const metaKey = lib.PDFName.of('Metadata');
  for (const {ref, stream, isJpeg} of imageStreams(lib, doc)) {
    const metaRef = stream.dict.get(metaKey);
    if (metaRef) {
      if (metaRef instanceof lib.PDFRef) doc.context.delete(metaRef);
      stream.dict.delete(metaKey);
      stats.xmpRemoved++;
    }
    if (!isJpeg) continue;
    try {
      const data = stream.getContents();
      const result = cleanJpeg(data, options);
      if (result.removed.length === 0) continue;
      // Thay cả object — /Length được pdf-lib tính lại từ nội dung mới khi ghi file
      doc.context.assign(ref, lib.PDFRawStream.of(stream.dict, result.data));
      stats.cleaned++;
      stats.bytes += Math.max(0, data.length - result.data.length);
    } catch {
      // Ảnh hỏng: giữ nguyên để trang không mất hình — nhưng phải báo rõ, không trấn an
      stats.failed.push(ref.objectNumber);
    }
  }
  return stats;
}

/** Ghi kết quả làm sạch ảnh vào removed/notes. Trả true nếu file có thay đổi. */
function reportImageStats(stats: ImageCleanStats, gpsOnly: boolean, removed: SegmentInfo[], notes: string[]): boolean {
  if (stats.cleaned > 0) {
    removed.push({
      kind: 'embedded-image',
      bytes: stats.bytes,
      note: gpsOnly
        ? `đã gỡ GPS khỏi ${stats.cleaned} ảnh nhúng`
        : `metadata (EXIF/GPS/XMP...) trong ${stats.cleaned} ảnh JPEG nhúng`,
    });
    if (!gpsOnly) {
      notes.push(`Đã xoá metadata trong ${stats.cleaned} ảnh nhúng (ảnh giữ nguyên chất lượng, không nén lại).`);
    }
  }
  if (stats.xmpRemoved > 0) {
    removed.push({kind: 'xmp', bytes: 0, note: `luồng XMP gắn riêng trên ${stats.xmpRemoved} ảnh`});
  }
  if (stats.failed.length > 0) {
    notes.push(
      `Cảnh báo: không đọc được ${stats.failed.length} ảnh JPEG nhúng (object ${stats.failed.slice(0, 5).join(', ')}) — các ảnh này được giữ nguyên và CÓ THỂ còn metadata.`,
    );
  }
  return stats.cleaned > 0 || stats.xmpRemoved > 0;
}

type PdfDict = import('pdf-lib').PDFDict;

/** Độ sâu tối đa khi làm sạch PDF đính kèm bên trong PDF (chống lồng vô hạn). */
const MAX_PDF_DEPTH = 2;

interface Attachment {
  ref: PdfRef;
  stream: PdfRawStream;
  name: string;
}

/**
 * Mọi tệp đính kèm trong file. Dù được trỏ tới từ name tree EmbeddedFiles, từ
 * annotation FileAttachment hay từ /AF (PDF/A-3, hoá đơn điện tử), nội dung tệp luôn
 * là một stream /Type /EmbeddedFile — duyệt thẳng các stream đó thì không sót đường nào.
 * Tên tệp nằm ở file specification (/UF hoặc /F) trỏ tới stream qua /EF.
 */
function attachments(lib: PdfLibModule, doc: PdfDoc): Attachment[] {
  const {PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFString, PDFHexString} = lib;
  const names = new Map<string, string>();
  const collectSpec = (spec: PdfDict): void => {
    const efRaw = spec.get(PDFName.of('EF'));
    const ef = efRaw instanceof PDFRef ? doc.context.lookup(efRaw) : efRaw;
    if (!(ef instanceof PDFDict)) return;
    let name: string | null = null;
    for (const key of ['UF', 'F']) {
      const v = spec.get(PDFName.of(key));
      if (v instanceof PDFString || v instanceof PDFHexString) {
        name = v.decodeText();
        break;
      }
    }
    if (!name) return;
    for (const key of ['UF', 'F']) {
      const target = ef.get(PDFName.of(key));
      if (target instanceof PDFRef) names.set(target.toString(), name);
    }
  };

  // File spec hay nằm TRỰC TIẾP lồng trong object khác chứ không phải object riêng:
  // trong mảng /Names của name tree (PyMuPDF, Acrobat), trong annotation (/FS << >>)...
  // → đi sâu vào dict/mảng trực tiếp (không theo tham chiếu — object được trỏ tới tự
  // nằm trong danh sách duyệt), nên mỗi object chỉ đi qua một lần.
  const walk = (obj: unknown, depth: number): void => {
    if (depth > 12) return;
    if (obj instanceof PDFDict) {
      collectSpec(obj);
      for (const [, value] of obj.entries()) walk(value, depth + 1);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) walk(obj.get(i), depth + 1);
    }
  };

  const streams: Array<{ref: PdfRef; stream: PdfRawStream}> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type && String(type) === '/EmbeddedFile') streams.push({ref, stream: obj});
    } else {
      walk(obj, 0);
    }
  }
  return streams.map(({ref, stream}) => ({ref, stream, name: names.get(ref.toString()) ?? `tệp #${ref.objectNumber}`}));
}

/** Giải nén nội dung tệp đính kèm; null nếu filter không giải được. */
function decodeAttachment(lib: PdfLibModule, stream: PdfRawStream): Uint8Array | null {
  try {
    return stream.dict.has(lib.PDFName.of('Filter')) ? lib.decodePDFRawStream(stream).decode() : stream.getContents();
  } catch {
    return null;
  }
}

/** Params của tệp đính kèm (Size, CheckSum, CreationDate, ModDate) nếu có. */
function attachmentParams(lib: PdfLibModule, doc: PdfDoc, stream: PdfRawStream): PdfDict | null {
  const raw = stream.dict.get(lib.PDFName.of('Params'));
  const params = raw instanceof lib.PDFRef ? doc.context.lookup(raw) : raw;
  return params instanceof lib.PDFDict ? params : null;
}

const ATTACHMENT_DATE_KEYS = ['CreationDate', 'ModDate'];

type AttachmentInspector = (data: Uint8Array) => Promise<MetadataReport>;
type AttachmentCleaner = (data: Uint8Array) => Promise<CleanResult>;

/**
 * Chọn handler cho nội dung tệp đính kèm theo magic bytes. HEIC bị loại (làm sạch
 * nghĩa là đổi sang PNG — sai với tên/loại tệp đã khai trong PDF); PDF lồng nhau
 * chỉ xử lý tới MAX_PDF_DEPTH. Trả null nếu không làm sạch được.
 */
async function attachmentHandler(
  data: Uint8Array,
  options: CleanOptions,
  depth: number,
): Promise<{inspect: AttachmentInspector; clean: AttachmentCleaner} | null> {
  const format = detectFormat(data).format;
  if (format === 'pdf') {
    if (depth >= MAX_PDF_DEPTH) return null;
    return {inspect: d => inspectPdf(d, depth + 1), clean: d => cleanPdf(d, options, depth + 1)};
  }
  if (format === 'heic') return null;
  // Nạp muộn: handlers/index cũng import file này
  const {getHandler} = await import('./index');
  const handler = getHandler(format);
  if (!handler) return null;
  return {inspect: d => handler.inspect(d), clean: async d => handler.clean(d, options)};
}

interface AttachmentStats {
  total: number;
  cleaned: string[];
  datesRemoved: number;
  skipped: string[];
}

/**
 * Tệp đính kèm là NỘI DUNG tác giả cố ý gửi kèm (vd XML hoá đơn điện tử PDF/A-3)
 * nên được giữ lại — nhưng metadata BÊN TRONG tệp được làm sạch bằng đúng handler
 * như file lẻ, và ngày tạo/sửa tệp trong /Params bị xoá.
 */
async function cleanAttachments(
  lib: PdfLibModule,
  doc: PdfDoc,
  options: CleanOptions,
  depth: number,
): Promise<AttachmentStats> {
  const {PDFName, PDFNumber} = lib;
  const list = attachments(lib, doc);
  const stats: AttachmentStats = {total: list.length, cleaned: [], datesRemoved: 0, skipped: []};
  for (const att of list) {
    const params = attachmentParams(lib, doc, att.stream);
    if (params && !options.gpsOnly) {
      let had = false;
      for (const key of ATTACHMENT_DATE_KEYS) {
        if (params.has(PDFName.of(key))) {
          params.delete(PDFName.of(key));
          had = true;
        }
      }
      if (had) stats.datesRemoved++;
    }

    const data = decodeAttachment(lib, att.stream);
    if (!data) {
      stats.skipped.push(att.name);
      continue;
    }
    if (data.length === 0) continue;
    let result: CleanResult;
    try {
      const handler = await attachmentHandler(data, options, depth);
      if (!handler) {
        stats.skipped.push(att.name);
        continue;
      }
      result = await handler.clean(data);
    } catch {
      stats.skipped.push(att.name);
      continue;
    }
    if (result.removed.length === 0) continue;

    // Ghi lại stream đã nén Flate; giữ mọi khoá khác (Type, Subtype, Params...) của bản gốc
    const fresh = doc.context.flateStream(result.data, {});
    for (const [key, value] of att.stream.dict.entries()) {
      if (!['Filter', 'DecodeParms', 'DL', 'Length'].includes(key.asString().slice(1))) fresh.dict.set(key, value);
    }
    if (params) {
      params.set(PDFName.of('Size'), PDFNumber.of(result.data.length));
      params.delete(PDFName.of('CheckSum')); // MD5 của nội dung cũ — không còn đúng
    }
    doc.context.assign(att.ref, fresh);
    stats.cleaned.push(att.name);
  }
  return stats;
}

/** Ghi kết quả làm sạch tệp đính kèm vào removed/notes. Trả true nếu file có thay đổi. */
function reportAttachmentStats(stats: AttachmentStats, removed: SegmentInfo[], notes: string[]): boolean {
  const list = (names: string[]) => names.slice(0, 5).join(', ') + (names.length > 5 ? '…' : '');
  if (stats.cleaned.length > 0) {
    removed.push({kind: 'attachment', bytes: 0, note: `metadata bên trong ${stats.cleaned.length} tệp đính kèm`});
    notes.push(`Đã xoá metadata bên trong ${stats.cleaned.length} tệp đính kèm (${list(stats.cleaned)}).`);
  }
  if (stats.datesRemoved > 0) {
    removed.push({kind: 'attachment-dates', bytes: 0, note: `ngày tạo/sửa của ${stats.datesRemoved} tệp đính kèm`});
  }
  if (stats.skipped.length > 0) {
    notes.push(
      `Lưu ý: giữ nguyên ${stats.skipped.length} tệp đính kèm không làm sạch được (${list(stats.skipped)}) — định dạng không hỗ trợ hoặc tệp hỏng, bên trong CÓ THỂ còn metadata.`,
    );
  }
  if (stats.total > 0) {
    notes.push(`PDF có ${stats.total} tệp đính kèm — được giữ lại vì là nội dung tác giả gửi kèm.`);
  }
  return stats.cleaned.length > 0 || stats.datesRemoved > 0;
}

/** `depth` > 0 khi đang làm sạch một PDF đính kèm bên trong PDF khác. */
export async function cleanPdf(bytes: Uint8Array, options: CleanOptions, depth = 0): Promise<CleanResult> {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  const {lib, doc} = await loadDoc(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const {PDFName, PDFRef, PDFDict} = lib;

  if (options.gpsOnly) {
    // GPS trong PDF chỉ nằm ở ảnh nhúng và trong XMP (thường do ảnh scan để lại)
    let changed = reportImageStats(cleanImages(lib, doc, options), true, removed, notes);
    if (reportAttachmentStats(await cleanAttachments(lib, doc, options, depth), removed, notes)) changed = true;
    const xmp = readXmpStream(lib, doc);
    if (xmp && !xmp.readable) {
      // Có XMP nhưng không đọc được nội dung → không thể lọc chọn lọc, xoá HẲN
      // cho chắc (thà mất cả XMP còn hơn để sót GPS mà báo "đã sạch")
      if (xmp.ref instanceof PDFRef) doc.context.delete(xmp.ref);
      doc.catalog.delete(PDFName.of('Metadata'));
      removed.push({kind: 'xmp', bytes: 0, note: 'XMP không đọc được nội dung — xoá hẳn để chắc chắn không sót GPS'});
      changed = true;
    } else if (xmp) {
      const scrubbed = scrubXmpGps(xmp.xml);
      if (scrubbed.removed > 0) {
        if (xmp.ref instanceof PDFRef) doc.context.delete(xmp.ref); // xoá stream cũ thật sự
        // Mã hoá UTF-8 thành BYTES trước — flateStream(chuỗi) sẽ cắt cụt ký tự > 0xFF
        // (BOM, tiếng Việt) bằng charCodeAt, làm hỏng gói XMP
        const stream = doc.context.flateStream(new TextEncoder().encode(scrubbed.xml), {
          Type: PDFName.of('Metadata'),
          Subtype: PDFName.of('XML'),
        });
        doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
        removed.push({kind: 'xmp', bytes: 0, note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`});
        changed = true;
      }
    }
    if (!changed) {
      notes.push(
        xmp
          ? 'XMP và ảnh nhúng của PDF không chứa GPS — không có gì để xoá.'
          : 'PDF không có XMP hay ảnh nhúng chứa GPS — chế độ "chỉ xoá GPS" không thay đổi gì.',
      );
      return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
    }
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

  // 3. Ảnh nhúng (EXIF/GPS, XMP riêng của ảnh) + tệp đính kèm (metadata bên trong, ngày tạo/sửa)
  reportImageStats(cleanImages(lib, doc, options), false, removed, notes);
  reportAttachmentStats(await cleanAttachments(lib, doc, options, depth), removed, notes);

  // 4. Trailer /ID (MD5 sinh từ đường dẫn file + thời điểm tạo — cũng là dấu vết)
  if (doc.context.trailerInfo.ID !== undefined) {
    doc.context.trailerInfo.ID = undefined;
    removed.push({kind: 'pdf-id', bytes: 0, note: 'trailer /ID (định danh file)'});
  }

  // 5. Info dictionary — LÀM CUỐI CÙNG: mọi lời gọi get/set metadata sau bước này
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

export async function inspectPdf(bytes: Uint8Array, depth = 0): Promise<MetadataReport> {
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

  // Ảnh nhúng: JPEG đọc bằng chính handler JPEG (ảnh chụp điện thoại trong PDF xuất
  // từ Word...), cộng luồng XMP gắn riêng trên từng ảnh
  for (const {ref, stream, isJpeg} of imageStreams(lib, doc)) {
    const name = `ảnh #${ref.objectNumber}`;
    const idPrefix = `pdf:image:${ref.objectNumber}`;
    if (stream.dict.has(lib.PDFName.of('Metadata'))) {
      fields.push({id: `${idPrefix}:xmp`, group: 'XMP', tag: `XMP trong ảnh nhúng (${name})`, value: 'có', risk: 'high'});
    }
    if (!isJpeg) continue;
    try {
      const summary = summarizeEmbeddedImage(await inspectJpeg(stream.getContents()), idPrefix, name, 'PDF');
      fields.push(...summary.fields);
      if (summary.metaBytes > 0) metaSegments.push({kind: 'embedded-image', bytes: summary.metaBytes, note: name});
    } catch {
      warnings.push(`Không đọc được ${name} (JPEG nhúng).`);
    }
  }

  // Tệp đính kèm: liệt kê (để người dùng biết file còn mang theo gì), ngày tạo/sửa
  // trong /Params, và metadata BÊN TRONG tệp đọc bằng đúng handler của định dạng đó
  for (const att of attachments(lib, doc)) {
    const idPrefix = `pdf:attachment:${att.ref.objectNumber}`;
    const data = decodeAttachment(lib, att.stream);
    fields.push({
      id: idPrefix,
      group: 'PDF',
      tag: 'Tệp đính kèm',
      value: data ? `${att.name} (${data.length.toLocaleString('vi-VN')} byte)` : att.name,
      risk: 'low',
    });
    const params = attachmentParams(lib, doc, att.stream);
    const dates = ATTACHMENT_DATE_KEYS.map(key => params?.get(lib.PDFName.of(key)))
      .filter(v => v instanceof lib.PDFString || v instanceof lib.PDFHexString)
      .map(v => (v as {decodeText(): string}).decodeText());
    if (dates.length > 0) {
      fields.push({
        id: `${idPrefix}:dates`,
        group: 'PDF',
        tag: `Ngày tạo/sửa tệp đính kèm (${att.name})`,
        value: dates.join(' / '),
        risk: 'medium',
      });
    }
    if (!data) {
      warnings.push(`Không giải nén được tệp đính kèm ${att.name} — không kiểm tra được metadata bên trong.`);
      continue;
    }
    if (data.length === 0) continue;
    try {
      const handler = await attachmentHandler(data, DEFAULT_CLEAN_OPTIONS, depth);
      if (!handler) {
        warnings.push(`Tệp đính kèm ${att.name}: định dạng không hỗ trợ — không kiểm tra được metadata bên trong.`);
        continue;
      }
      const summary = summarizeEmbeddedImage(await handler.inspect(data), idPrefix, att.name, 'PDF', 'tệp đính kèm');
      fields.push(...summary.fields);
      if (summary.metaBytes > 0) metaSegments.push({kind: 'attachment', bytes: summary.metaBytes, note: att.name});
    } catch {
      warnings.push(`Không đọc được tệp đính kèm ${att.name}.`);
    }
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
