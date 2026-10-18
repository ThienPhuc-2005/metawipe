// Handler tài liệu Office: DOCX/XLSX/PPTX (OOXML) và ODT/ODS/ODP (OpenDocument).
// Bản chất là file ZIP → giải nén, thay/gột các phần metadata, đóng gói lại:
// - docProps/core.xml  → bản rỗng (tác giả, người sửa cuối, ngày giờ, revision)
// - docProps/app.xml   → bản rỗng (phần mềm, Company, tổng thời gian chỉnh sửa)
// - docProps/custom.xml → XOÁ hẳn (kèm gỡ tham chiếu trong .rels + [Content_Types])
// - Tên người trong nội dung: comment (Word/Excel/PowerPoint), tracked changes,
//   people.xml/persons — ẩn danh hoá thành "Người dùng" (giữ cấu trúc để không hỏng file)
// - ODF: meta.xml → bản rỗng; entry 'mimetype' giữ đứng đầu và KHÔNG nén
// - Ảnh nhúng (word/media, xl/media, ppt/media, Pictures/...) → chạy qua đúng handler
//   ảnh như file lẻ: ảnh chụp điện thoại dán vào Word vẫn mang nguyên EXIF/GPS!

import {unzipSync, zipSync, type Zippable} from 'fflate';
import {CleanerError, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {classifyTag} from '../risk';
import {summarizeEmbeddedImage} from '../embedded-image';
import {detectFormat} from '../detect';
import {cleanJpeg, inspectJpeg} from './jpeg';
import {cleanPng, inspectPng} from './png';
import {cleanWebp, inspectWebp} from './webp';
import {cleanGif, inspectGif} from './gif';
import {cleanTiff, inspectTiff} from './tiff';

const ANON = 'Người dùng';

interface EmbeddedImageHandler {
  inspect(bytes: Uint8Array): Promise<MetadataReport>;
  clean(bytes: Uint8Array, options: CleanOptions): CleanResult;
}

/**
 * Handler cho ảnh nhúng — chỉ các định dạng strip ĐỒNG BỘ, tại chỗ (HEIC phải đổi
 * sang PNG, kéo theo đổi tên + content-type trong gói nên không làm ở đây).
 * Import thẳng từng handler thay vì qua handlers/index để tránh vòng import.
 */
const EMBEDDED_IMAGE_HANDLERS: Record<string, EmbeddedImageHandler> = {
  jpeg: {inspect: inspectJpeg, clean: cleanJpeg},
  png: {inspect: inspectPng, clean: cleanPng},
  webp: {inspect: inspectWebp, clean: cleanWebp},
  gif: {inspect: inspectGif, clean: cleanGif},
  tiff: {inspect: inspectTiff, clean: cleanTiff},
};

/** Nhận diện ảnh nhúng bằng magic bytes — không tin đuôi file trong gói. */
function embeddedImageHandler(path: string, data: Uint8Array): EmbeddedImageHandler | null {
  if (data.length === 0 || /\.(xml|rels)$/i.test(path)) return null;
  try {
    return EMBEDDED_IMAGE_HANDLERS[detectFormat(data).format] ?? null;
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}


const EMPTY_CORE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
  ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

const EMPTY_APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
  ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVT"/>';

const EMPTY_ODF_META =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' office:version="1.2"><office:meta/></office:document-meta>';

type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'ooxml' | 'odt' | 'ods' | 'odp' | 'odf';

interface OfficeArchive {
  entries: Record<string, Uint8Array>;
  kind: OfficeKind;
}

function readArchive(bytes: Uint8Array): OfficeArchive {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new CleanerError('corrupt', `Không giải nén được file ZIP: ${err instanceof Error ? err.message : err}`);
  }

  if (entries['mimetype']) {
    const mime = decodeUtf8(entries['mimetype']);
    const kind: OfficeKind = mime.includes('opendocument.text')
      ? 'odt'
      : mime.includes('opendocument.spreadsheet')
        ? 'ods'
        : mime.includes('opendocument.presentation')
          ? 'odp'
          : 'odf';
    if (mime.includes('opendocument')) return {entries, kind};
  }
  if (entries['[Content_Types].xml']) {
    const kind: OfficeKind = entries['word/document.xml']
      ? 'docx'
      : entries['xl/workbook.xml']
        ? 'xlsx'
        : entries['ppt/presentation.xml']
          ? 'pptx'
          : 'ooxml';
    return {entries, kind};
  }
  throw new CleanerError(
    'unsupported',
    'File ZIP thường (không phải tài liệu Word/Excel/PowerPoint/OpenDocument) — sẽ hỗ trợ sau.',
  );
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Đổi tên entry '__proto__' — key này làm hỏng object thường bên trong fflate. */
function safeEntry(path: string): string {
  return path === '__proto__' ? '__proto__.bin' : path;
}

/**
 * Xoá mọi phần tử `<tag ...>` (tự đóng HOẶC có thẻ đóng) mà phần thuộc tính
 * khớp `attrMatch`. Chịu được nháy đơn/kép và thứ tự thuộc tính bất kỳ.
 */
function removeXmlElement(xml: string, tag: string, attrMatch: RegExp): string {
  const re = new RegExp(`<${tag}\\b[^>]*?>(?:[\\s\\S]*?<\\/${tag}\\s*>)?`, 'g');
  return xml.replace(re, m => {
    // Chỉ khớp thẻ tự đóng hoặc thẻ mở-đóng; kiểm attr trong phần mở đầu
    const head = m.slice(0, m.indexOf('>') + 1);
    return attrMatch.test(head) ? '' : m;
  });
}

/** Gột tên người trong một file XML nội dung. Trả [xml mới, số chỗ đã ẩn danh]. */
function anonymizeAuthors(xml: string, path: string): [string, number] {
  let count = 0;
  let out = xml;

  // Word: w:author / w:initials trên comment + tracked changes (w:ins/w:del)
  out = out.replace(/(w:author=")([^"]*)(")/g, (_, a, name, b) => {
    if (name !== ANON) count++;
    return a + ANON + b;
  });
  out = out.replace(/(w:initials=")([^"]*)(")/g, (_, a, v, b) => {
    if (v !== '') count++;
    return a + b;
  });
  // Word people.xml: w15:person w15:author="..."
  out = out.replace(/(w15:author=")([^"]*)(")/g, (_, a, name, b) => {
    if (name !== ANON) count++;
    return a + ANON + b;
  });

  // Excel comment cũ: <author>Tên</author>
  if (/xl\/comments/.test(path)) {
    out = out.replace(/(<author>)([^<]*)(<\/author>)/g, (_, a, name, b) => {
      if (name !== ANON) count++;
      return a + ANON + b;
    });
  }
  // Excel threaded comments / persons: displayName + userId
  out = out.replace(/(displayName=")([^"]*)(")/g, (_, a, name, b) => {
    if (name !== ANON) count++;
    return a + ANON + b;
  });
  out = out.replace(/(userId=")([^"]*)(")/g, (_, a, v, b) => {
    if (v !== '') count++;
    return a + b;
  });

  // PowerPoint commentAuthors.xml (cổ điển) + authors.xml (modern 365):
  // <p:cmAuthor ... name="..." initials="..."/> hoặc <p188:author ... name="..." userId="..."/>
  if (/commentAuthors\.xml$/.test(path) || /(^|\/)authors\.xml$/.test(path)) {
    out = out.replace(/(\sname=")([^"]*)(")/g, (_, a, name, b) => {
      if (name !== ANON) count++;
      return a + ANON + b;
    });
    out = out.replace(/(\sinitials=")([^"]*)(")/g, (_, a, v, b) => {
      if (v !== '') count++;
      return a + b;
    });
  }

  // Excel shared-workbook revisions: <...  userName="..."/>
  if (/revision/i.test(path)) {
    out = out.replace(/(\suserName=")([^"]*)(")/g, (_, a, name, b) => {
      if (name !== ANON) count++;
      return a + ANON + b;
    });
  }

  // ODF (content.xml): comment <office:annotation><dc:creator>Tên</dc:creator>
  // và tracked changes <office:change-info><dc:creator>Tên</dc:creator>
  out = out.replace(/(<dc:creator>)([^<]*)(<\/dc:creator>)/g, (_, a, name, b) => {
    if (name && name !== ANON) count++;
    return a + ANON + b;
  });

  return [out, count];
}

/** Các file XML có thể chứa tên người trong nội dung. */
function isAuthorBearing(path: string): boolean {
  return (
    // Word: comment/people/document + tracked changes cũng nằm trong header/footer/footnotes/glossary
    /^word\/(comments\w*|people|document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(path) ||
    path === 'word/glossary/document.xml' ||
    // Excel: comment cũ, threaded, persons, và shared-workbook revisions
    /^xl\/comments\w*\.xml$/.test(path) ||
    /^xl\/threadedComments\/.*\.xml$/.test(path) ||
    /^xl\/persons\/.*\.xml$/.test(path) ||
    /^xl\/revisions\/.*\.xml$/.test(path) ||
    // PowerPoint: commentAuthors cổ điển + comments + authors.xml modern (365)
    /^ppt\/comment(Authors|s)\/?.*\.xml$/.test(path) ||
    path === 'ppt/commentAuthors.xml' ||
    path === 'ppt/authors.xml' ||
    // ODF: comment + tracked changes nằm ngay trong content.xml
    path === 'content.xml'
  );
}

export function cleanOffice(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {entries, kind} = readArchive(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];

  const out: Record<string, [Uint8Array, {level: number}]> = Object.create(null);
  const isOdf = kind === 'odt' || kind === 'ods' || kind === 'odp' || kind === 'odf';
  let anonymized = 0;
  let imagesCleaned = 0;
  let imageBytesRemoved = 0;
  const imagesFailed: string[] = [];

  // Ảnh nhúng dùng CÙNG tuỳ chọn với file lẻ (chỉ xoá GPS / giữ ICC / giữ hướng xoay)
  const cleanImage = (path: string, data: Uint8Array, handler: EmbeddedImageHandler): Uint8Array => {
    try {
      const result = handler.clean(data, options);
      if (result.removed.length === 0) return data;
      imagesCleaned++;
      imageBytesRemoved += Math.max(0, data.length - result.data.length);
      return result.data;
    } catch {
      // Ảnh hỏng: giữ nguyên để tài liệu không mất hình — nhưng phải báo rõ, không trấn an
      imagesFailed.push(baseName(path));
      return data;
    }
  };

  for (const [path, data] of Object.entries(entries)) {
    // ODF: mimetype phải đứng đầu và KHÔNG nén — giữ nguyên như bản gốc
    if (isOdf && path === 'mimetype') {
      out[path] = [data, {level: 0}];
      continue;
    }
    const imageHandler = embeddedImageHandler(path, data);
    if (options.gpsOnly) {
      // Chỉ xoá GPS: toạ độ chỉ có thể nằm trong ảnh nhúng — mọi phần khác giữ nguyên
      out[safeEntry(path)] = [imageHandler ? cleanImage(path, data, imageHandler) : data, {level: 6}];
      continue;
    }

    if (isOdf && path === 'meta.xml') {
      out[path] = [utf8Encode(EMPTY_ODF_META), {level: 6}];
      removed.push({kind: 'office-meta', bytes: data.length, note: 'meta.xml (tác giả, ngày giờ, số lần sửa)'});
      continue;
    }
    if (path === 'docProps/core.xml') {
      out[path] = [utf8Encode(EMPTY_CORE_XML), {level: 6}];
      removed.push({kind: 'office-meta', bytes: data.length, note: 'core.xml (tác giả, người sửa cuối, ngày giờ)'});
      continue;
    }
    if (path === 'docProps/app.xml') {
      out[path] = [utf8Encode(EMPTY_APP_XML), {level: 6}];
      removed.push({kind: 'office-meta', bytes: data.length, note: 'app.xml (phần mềm, công ty, thời gian chỉnh sửa)'});
      continue;
    }
    if (path === 'docProps/custom.xml' || /^docProps\/thumbnail\./.test(path)) {
      removed.push({
        kind: 'office-meta',
        bytes: data.length,
        note: path === 'docProps/custom.xml' ? 'custom.xml (thuộc tính tuỳ ý)' : 'ảnh thumbnail xem trước',
      });
      continue; // xoá hẳn — tham chiếu được gỡ bên dưới
    }
    // ODF: ảnh thumbnail xem trước cũng lộ nội dung tài liệu — xoá cho nhất quán
    if (isOdf && /^Thumbnails\//.test(path)) {
      removed.push({kind: 'office-meta', bytes: data.length, note: 'Thumbnails/ (ảnh xem trước)'});
      continue;
    }
    if (path === '[Content_Types].xml' || path === '_rels/.rels') {
      // Gỡ tham chiếu tới các phần đã xoá để Office không đòi "repair".
      // Regex phải chịu được: nháy đơn/kép, Target tuyệt đối ('/docProps/...' do
      // OpenXML SDK/.NET hay ghi), và thẻ tự đóng LẪN <Relationship ...></Relationship>.
      let xml = decodeUtf8(data);
      xml = removeXmlElement(xml, 'Override', /PartName=(["'])\/?docProps\/custom\.xml\1/);
      xml = removeXmlElement(xml, 'Override', /PartName=(["'])\/?docProps\/thumbnail\.[^"']*\1/);
      xml = removeXmlElement(xml, 'Relationship', /Target=(["'])\/?docProps\/custom\.xml\1/);
      xml = removeXmlElement(xml, 'Relationship', /Target=(["'])\/?docProps\/thumbnail\.[^"']*\1/);
      out[path] = [utf8Encode(xml), {level: 6}];
      continue;
    }
    if (imageHandler) {
      out[safeEntry(path)] = [cleanImage(path, data, imageHandler), {level: 6}];
      continue;
    }
    if (isAuthorBearing(path)) {
      const [xml, count] = anonymizeAuthors(decodeUtf8(data), path);
      anonymized += count;
      // Comment threaded của Excel/Word có thể nhắc tên người dạng @mention NGAY
      // TRONG nội dung — không thể tự động gột an toàn (dễ xoá nhầm nội dung thật)
      if (/threadedComment|(^|\/)comments?\d*\.xml$/.test(path) && /@[\w.]/.test(xml)) {
        notes.push(
          'Lưu ý: comment có thể nhắc tên người dạng @mention ngay trong nội dung — phần này được giữ nguyên, hãy tự kiểm tra nếu cần.',
        );
      }
      // Key '__proto__' làm hỏng object thường bên trong fflate → đổi tên an toàn
      out[safeEntry(path)] = [utf8Encode(xml), {level: 6}];
      continue;
    }
    out[safeEntry(path)] = [data, {level: 6}];
  }

  if (imagesFailed.length > 0) {
    notes.push(
      `Cảnh báo: không đọc được ${imagesFailed.length} ảnh nhúng (${imagesFailed.slice(0, 5).join(', ')}) — các ảnh này được giữ nguyên và CÓ THỂ còn metadata.`,
    );
  }
  if (options.gpsOnly) {
    if (imagesCleaned === 0) {
      notes.push('Không có ảnh nhúng nào chứa toạ độ GPS — chế độ "chỉ xoá GPS" không thay đổi gì.');
      return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
    }
    removed.push({kind: 'embedded-image', bytes: imageBytesRemoved, note: `đã gỡ GPS khỏi ${imagesCleaned} ảnh nhúng`});
    const data = zipSync(out as unknown as Zippable);
    return {data, removed, bytesRemoved: Math.max(0, bytes.length - data.length), notes};
  }
  if (imagesCleaned > 0) {
    removed.push({
      kind: 'embedded-image',
      bytes: imageBytesRemoved,
      note: `metadata (EXIF/GPS/XMP...) trong ${imagesCleaned} ảnh nhúng`,
    });
    notes.push(`Đã xoá metadata trong ${imagesCleaned} ảnh nhúng (ảnh giữ nguyên chất lượng, không nén lại).`);
  }
  if (anonymized > 0) {
    removed.push({kind: 'authors', bytes: 0, note: `${anonymized} chỗ ghi tên người (comment, tracked changes) đã ẩn danh hoá`});
    notes.push(`Đã ẩn danh hoá ${anonymized} chỗ ghi tên người trong nội dung thành "${ANON}" (giữ nguyên comment/tracked changes).`);
  }

  const data = zipSync(out as unknown as Zippable);
  const bytesRemoved = Math.max(0, bytes.length - data.length);
  return {data, removed, bytesRemoved, notes};
}

function textBetween(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
  return m && m[1] ? m[1] : null;
}

export async function inspectOffice(bytes: Uint8Array): Promise<MetadataReport> {
  const {entries, kind} = readArchive(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const warnings: string[] = [];

  const pushField = (id: string, tag: string, value: string | null, risk?: 'high' | 'medium' | 'low'): void => {
    if (!value) return;
    fields.push({
      id: `office:${id}`,
      group: 'Office',
      tag,
      value: value.slice(0, 300),
      risk: risk ?? classifyTag('Office', tag),
    });
  };

  const core = entries['docProps/core.xml'] ? decodeUtf8(entries['docProps/core.xml']) : null;
  if (core) {
    metaSegments.push({kind: 'office-meta', bytes: entries['docProps/core.xml'].length, note: 'docProps/core.xml'});
    pushField('creator', 'Tác giả (dc:creator)', textBetween(core, 'dc:creator'), 'high');
    pushField('lastModifiedBy', 'Người sửa cuối', textBetween(core, 'cp:lastModifiedBy'), 'high');
    pushField('title', 'Tiêu đề', textBetween(core, 'dc:title'));
    pushField('subject', 'Chủ đề', textBetween(core, 'dc:subject'));
    pushField('description', 'Mô tả', textBetween(core, 'dc:description'));
    pushField('keywords', 'Từ khoá', textBetween(core, 'cp:keywords'));
    pushField('created', 'Ngày tạo', textBetween(core, 'dcterms:created'), 'medium');
    pushField('modified', 'Ngày sửa', textBetween(core, 'dcterms:modified'), 'medium');
    pushField('revision', 'Số lần sửa (revision)', textBetween(core, 'cp:revision'), 'medium');
  }

  const app = entries['docProps/app.xml'] ? decodeUtf8(entries['docProps/app.xml']) : null;
  if (app) {
    metaSegments.push({kind: 'office-meta', bytes: entries['docProps/app.xml'].length, note: 'docProps/app.xml'});
    pushField('application', 'Phần mềm', textBetween(app, 'Application'), 'medium');
    pushField('company', 'Công ty', textBetween(app, 'Company'), 'high');
    pushField('manager', 'Quản lý', textBetween(app, 'Manager'), 'high');
    const totalTime = textBetween(app, 'TotalTime');
    if (totalTime && totalTime !== '0') {
      pushField('totalTime', 'Tổng thời gian chỉnh sửa', `${totalTime} phút`, 'medium');
    }
    pushField('template', 'Template', textBetween(app, 'Template'), 'medium');
  }

  if (entries['docProps/custom.xml']) {
    metaSegments.push({kind: 'office-meta', bytes: entries['docProps/custom.xml'].length, note: 'docProps/custom.xml'});
    const custom = decodeUtf8(entries['docProps/custom.xml']);
    const names = [...custom.matchAll(/name="([^"]{1,60})"/g)].map(m => m[1]).slice(0, 10);
    pushField(
      'custom',
      'Thuộc tính tuỳ ý (custom.xml)',
      names.length ? `${names.length}+ thuộc tính: ${names.join(', ')}` : 'có',
      'high',
    );
  }

  // Tên người trong nội dung (comment, tracked changes, persons, revisions)
  const authors = new Set<string>();
  for (const [path, data] of Object.entries(entries)) {
    if (!isAuthorBearing(path)) continue;
    const xml = decodeUtf8(data);
    for (const m of xml.matchAll(/(?:w:author|w15:author|displayName|userName)="([^"]+)"/g)) authors.add(m[1]);
    if (/xl\/comments/.test(path)) {
      for (const m of xml.matchAll(/<author>([^<]+)<\/author>/g)) authors.add(m[1]);
    }
    if (/commentAuthors\.xml$/.test(path) || /(^|\/)authors\.xml$/.test(path)) {
      for (const m of xml.matchAll(/\sname="([^"]+)"/g)) authors.add(m[1]);
    }
    if (path === 'content.xml') {
      for (const m of xml.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g)) authors.add(m[1]);
    }
  }
  authors.delete(ANON);
  if (authors.size > 0) {
    pushField(
      'contentAuthors',
      'Tên người trong comment/tracked changes',
      [...authors].slice(0, 10).join(', '),
      'high',
    );
  }

  // Ảnh nhúng: đọc bằng chính handler ảnh rồi tóm tắt (GPS + một dòng mỗi ảnh)
  for (const [path, data] of Object.entries(entries)) {
    const handler = embeddedImageHandler(path, data);
    if (!handler) continue;
    const name = baseName(path);
    let report: MetadataReport;
    try {
      report = await handler.inspect(data);
    } catch {
      warnings.push(`Không đọc được ảnh nhúng ${name}.`);
      continue;
    }
    const summary = summarizeEmbeddedImage(report, `office:image:${path}`, name, 'Office');
    fields.push(...summary.fields);
    if (summary.metaBytes > 0) metaSegments.push({kind: 'embedded-image', bytes: summary.metaBytes, note: path});
  }

  // ODF meta.xml
  const odfMeta = entries['meta.xml'] ? decodeUtf8(entries['meta.xml']) : null;
  if (odfMeta) {
    metaSegments.push({kind: 'office-meta', bytes: entries['meta.xml'].length, note: 'meta.xml'});
    pushField('odf-initial', 'Người tạo', textBetween(odfMeta, 'meta:initial-creator'), 'high');
    pushField('odf-creator', 'Người sửa cuối', textBetween(odfMeta, 'dc:creator'), 'high');
    pushField('odf-generator', 'Phần mềm', textBetween(odfMeta, 'meta:generator'), 'medium');
    pushField('odf-created', 'Ngày tạo', textBetween(odfMeta, 'meta:creation-date'), 'medium');
    pushField('odf-modified', 'Ngày sửa', textBetween(odfMeta, 'dc:date'), 'medium');
    const cycles = textBetween(odfMeta, 'meta:editing-cycles');
    if (cycles && cycles !== '1') pushField('odf-cycles', 'Số lần chỉnh sửa', cycles, 'medium');
  }

  return {
    format: kind,
    fileSize: bytes.length,
    fields,
    metaSegments,
    trailingBytes: 0,
    warnings,
  };
}
