// Handler WebM/MKV (EBML/Matroska): vô hiệu hoá metadata TẠI CHỖ bằng phần tử
// Void (0xEC) — cách chuẩn của Matroska (mkvpropedit dùng đúng kỹ thuật này).
// Kích thước file giữ nguyên → offset trong SeekHead/Cues không xê dịch.
//
// Vô hiệu hoá: Segment/Tags (toàn bộ), Info/Title, Info/DateUTC (thời điểm quay);
// Info/MuxingApp + WritingApp (tên phần mềm) được ghi đè bằng khoảng trắng
// (2 phần tử này bắt buộc theo spec nên không Void được).

import {CleanerError, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';

// ID EBML (giữ nguyên bit đánh dấu như quy ước Matroska)
const ID_EBML_HEADER = 0x1a45dfa3;
const ID_DOCTYPE = 0x4282;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TAGS = 0x1254c367;
const ID_TITLE = 0x7ba9;
const ID_DATE_UTC = 0x4461;
const ID_MUXING_APP = 0x4d80;
const ID_WRITING_APP = 0x5741;
const ID_TAG = 0x7373;
const ID_SIMPLE_TAG = 0x67c8;
const ID_TAG_NAME = 0x45a3;
const ID_TAG_STRING = 0x4487;
const ID_ATTACHMENTS = 0x1941a469;
const ID_CLUSTER = 0x1f43b675;

interface Vint {
  value: number;
  length: number;
  /** true nếu mọi bit giá trị đều là 1 — nghĩa là "kích thước không xác định". */
  unknown: boolean;
}

function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null; // độ dài > 8 byte — không hợp lệ
  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || pos + length > bytes.length) return null;

  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = bytes[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  if (value > Number.MAX_SAFE_INTEGER) return null;
  return {value, length, unknown: allOnes};
}

export interface EbmlElement {
  id: number;
  path: string;
  start: number;
  end: number;
  dataStart: number;
  /** Kích thước khai là "không xác định" (file ghi kiểu streaming). */
  unknownSize: boolean;
}

export interface EbmlParseResult {
  elements: EbmlElement[];
  warnings: string[];
  /** Vị trí bắt đầu vùng không quét được (sau phần tử kích thước không xác định). */
  opaqueFrom: number | null;
}

/** Container cần duyệt vào trong. */
const CONTAINERS = new Set([ID_SEGMENT, ID_INFO]);

export function parseWebm(bytes: Uint8Array): EbmlParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3
  ) {
    throw new CleanerError('corrupt', 'Không phải file WebM/MKV hợp lệ (thiếu chữ ký EBML).');
  }

  const elements: EbmlElement[] = [];
  const warnings: string[] = [];
  let opaqueFrom: number | null = null;

  function walk(start: number, end: number, path: string, depth: number): void {
    if (depth > 8) throw new CleanerError('corrupt', 'Phần tử EBML lồng quá sâu.');
    let pos = start;
    while (pos < end) {
      const id = readVint(bytes, pos, true);
      if (!id) {
        throw new CleanerError('corrupt', `Phần tử EBML không hợp lệ tại byte ${pos}.`);
      }
      const size = readVint(bytes, pos + id.length, false);
      if (!size) {
        throw new CleanerError('truncated', `File bị cắt cụt giữa phần tử EBML tại byte ${pos}.`);
      }
      const dataStart = pos + id.length + size.length;
      const unknownSize = size.unknown;
      let elEnd: number;
      if (unknownSize) {
        // Kích thước không xác định: Segment kéo tới hết file; phần tử khác
        // (Cluster ghi kiểu live) → không thể đi tiếp an toàn ở mức này
        elEnd = end;
        if (id.value !== ID_SEGMENT) {
          opaqueFrom = pos;
          warnings.push(
            'File ghi kiểu streaming (phần tử kích thước không xác định) — metadata nằm SAU điểm này (vd Tags ở cuối file) KHÔNG quét/xoá được. Muốn sạch tuyệt đối, hãy remux file bằng mkvmerge trước.',
          );
        }
      } else {
        elEnd = dataStart + size.value;
        if (elEnd > end) {
          throw new CleanerError('truncated', `Phần tử EBML dài quá vùng chứa (tại byte ${pos}).`);
        }
      }

      elements.push({id: id.value, path, start: pos, end: elEnd, dataStart, unknownSize});

      if (unknownSize && id.value !== ID_SEGMENT) return; // dừng level này
      if (CONTAINERS.has(id.value)) {
        walk(dataStart, elEnd, path ? `${path}/${id.value.toString(16)}` : id.value.toString(16), depth + 1);
      }
      pos = elEnd;
    }
  }

  walk(0, bytes.length, '', 0);
  return {elements, warnings, opaqueFrom};
}

/** Ghi đè một phần tử bằng Void (0xEC) cùng tổng kích thước, payload toàn 0. */
function writeVoid(out: Uint8Array, start: number, total: number): void {
  // Tìm độ dài trường size nhỏ nhất: 1 (ID) + sizeLen + payload = total
  for (let sizeLen = 1; sizeLen <= 8; sizeLen++) {
    const payload = total - 1 - sizeLen;
    if (payload < 0) continue;
    const maxVal = Math.pow(2, 7 * sizeLen) - 2; // trừ giá trị all-ones (unknown)
    if (payload > maxVal) continue;
    out[start] = 0xec;
    // VINT: byte đầu chứa marker bit + các bit giá trị cao nhất
    let v = payload;
    for (let i = sizeLen - 1; i >= 1; i--) {
      out[start + 1 + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    out[start + 1] = v | (0x80 >> (sizeLen - 1));
    out.fill(0, start + 1 + sizeLen, start + total);
    return;
  }
  throw new CleanerError('corrupt', 'Không dựng được phần tử Void (kích thước bất thường).');
}

function elementLabel(id: number): string {
  switch (id) {
    case ID_TAGS: return 'Tags (metadata)';
    case ID_TITLE: return 'Tiêu đề';
    case ID_DATE_UTC: return 'Thời điểm quay';
    case ID_ATTACHMENTS: return 'File đính kèm';
    default: return `0x${id.toString(16)}`;
  }
}

export function cleanWebm(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {elements, warnings} = parseWebm(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [...warnings];

  if (options.gpsOnly) {
    notes.push(
      'WebM/MKV không có trường GPS dạng chuẩn — chế độ "chỉ xoá GPS" không thay đổi gì. Dùng chế độ xoá sạch nếu muốn gỡ Tags/thời gian quay.',
    );
    return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
  }

  const out = bytes.slice();
  let voided = 0;

  for (const el of elements) {
    if (el.unknownSize) continue;
    const total = el.end - el.start;

    // Void toàn bộ: Tags, Title, DateUTC (path nằm trong Segment/Info tương ứng)
    if (el.id === ID_TAGS || el.id === ID_TITLE || el.id === ID_DATE_UTC) {
      writeVoid(out, el.start, total);
      voided++;
      removed.push({kind: 'webm-meta', bytes: total, note: elementLabel(el.id)});
      continue;
    }
    // MuxingApp/WritingApp bắt buộc theo spec — ghi đè nội dung bằng khoảng trắng
    if (el.id === ID_MUXING_APP || el.id === ID_WRITING_APP) {
      let dirty = false;
      for (let i = el.dataStart; i < el.end; i++) {
        if (out[i] !== 0x20) {
          dirty = true;
          break;
        }
      }
      if (dirty) {
        out.fill(0x20, el.dataStart, el.end);
        removed.push({
          kind: 'webm-meta',
          bytes: 0,
          note: el.id === ID_MUXING_APP ? 'tên phần mềm mux' : 'tên phần mềm ghi file',
        });
      }
      continue;
    }
  }

  if (voided > 0) {
    notes.push(
      'Các khối metadata được đổi thành phần tử Void chuẩn Matroska — kích thước file giữ nguyên để không xê dịch offset (an toàn tuyệt đối, không re-encode).',
    );
  }

  return {data: out, removed, bytesRemoved: 0, notes};
}

/** Đọc chuỗi con trực tiếp bên trong một phần tử (best-effort, có giới hạn). */
function readChildString(bytes: Uint8Array, parent: EbmlElement, childId: number): string | null {
  let pos = parent.dataStart;
  let guard = 0;
  while (pos < parent.end && guard++ < 64) {
    const id = readVint(bytes, pos, true);
    if (!id) return null;
    const size = readVint(bytes, pos + id.length, false);
    if (!size || size.unknown) return null;
    const dataStart = pos + id.length + size.length;
    if (dataStart + size.value > parent.end) return null;
    if (id.value === childId) {
      return decodeUtf8(bytes.subarray(dataStart, dataStart + Math.min(size.value, 300)));
    }
    pos = dataStart + size.value;
  }
  return null;
}

/** DateUTC: s64 BE nano giây kể từ 2001-01-01 UTC. */
function decodeDateUtc(bytes: Uint8Array, el: EbmlElement): string | null {
  if (el.end - el.dataStart !== 8) return null;
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[el.dataStart + i]);
  if (v & 0x8000000000000000n) v -= 1n << 64n; // signed
  const ms = Number(v / 1000000n) + Date.UTC(2001, 0, 1);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export async function inspectWebm(bytes: Uint8Array): Promise<MetadataReport> {
  const {elements, warnings} = parseWebm(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const counters = new Map<string, number>();
  const nextId = (k: string): string => {
    const n = counters.get(k) ?? 0;
    counters.set(k, n + 1);
    return `webm:${k}:${n}`;
  };

  for (const el of elements) {
    if (el.id === ID_TITLE) {
      fields.push({
        id: nextId('title'),
        group: 'WebM',
        tag: 'Tiêu đề',
        value: decodeUtf8(bytes.subarray(el.dataStart, Math.min(el.end, el.dataStart + 300))),
        risk: 'medium',
      });
      metaSegments.push({kind: 'webm-meta', bytes: el.end - el.start, note: 'Title'});
    } else if (el.id === ID_DATE_UTC) {
      const iso = decodeDateUtc(bytes, el);
      if (iso) {
        fields.push({id: nextId('date'), group: 'WebM', tag: 'Thời điểm quay', value: iso, risk: 'medium'});
      }
      metaSegments.push({kind: 'webm-meta', bytes: el.end - el.start, note: 'DateUTC'});
    } else if (el.id === ID_MUXING_APP || el.id === ID_WRITING_APP) {
      const text = decodeUtf8(bytes.subarray(el.dataStart, Math.min(el.end, el.dataStart + 200))).trim();
      if (text) {
        fields.push({
          id: nextId('app'),
          group: 'WebM',
          tag: el.id === ID_MUXING_APP ? 'Phần mềm mux' : 'Phần mềm ghi file',
          value: text,
          risk: 'medium',
        });
      }
    } else if (el.id === ID_TAGS) {
      metaSegments.push({kind: 'webm-meta', bytes: el.end - el.start, note: 'Tags'});
      // Best-effort: đọc các cặp TagName/TagString bên trong
      let pos = el.dataStart;
      let guard = 0;
      while (pos < el.end && guard++ < 32) {
        const id = readVint(bytes, pos, true);
        if (!id) break;
        const size = readVint(bytes, pos + id.length, false);
        if (!size || size.unknown) break;
        const dataStart = pos + id.length + size.length;
        if (dataStart + size.value > el.end) break;
        if (id.value === ID_TAG || id.value === ID_SIMPLE_TAG) {
          const fake: EbmlElement = {id: id.value, path: '', start: pos, end: dataStart + size.value, dataStart, unknownSize: false};
          const inner: EbmlElement = fake;
          const name = readChildString(bytes, inner, ID_TAG_NAME);
          const value = readChildString(bytes, inner, ID_TAG_STRING);
          if (name || value) {
            fields.push({
              id: nextId('tag'),
              group: 'WebM',
              tag: name ?? 'Tag',
              value: value ?? '(có giá trị lồng bên trong)',
              risk: /artist|author|comment|encoder|location/i.test(name ?? '') ? 'high' : 'medium',
            });
          }
          // đi vào Tag để tìm SimpleTag con
          if (id.value === ID_TAG) {
            pos = dataStart;
            continue;
          }
        }
        pos = dataStart + size.value;
      }
    } else if (el.id === ID_ATTACHMENTS) {
      metaSegments.push({kind: 'webm-meta', bytes: el.end - el.start, note: 'Attachments (file đính kèm)'});
      fields.push({
        id: nextId('attach'),
        group: 'WebM',
        tag: 'File đính kèm',
        value: `${(el.end - el.start).toLocaleString('vi-VN')} byte (ảnh bìa/font — được giữ nguyên)`,
        risk: 'medium',
      });
    }
  }

  return {
    format: 'webm',
    fileSize: bytes.length,
    fields,
    metaSegments,
    trailingBytes: 0,
    warnings,
  };
}
