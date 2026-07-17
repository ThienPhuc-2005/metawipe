// Handler AVI (RIFF): vô hiệu hoá metadata TẠI CHỖ bằng chunk JUNK —
// chunk đệm chuẩn của AVI. Kích thước file giữ nguyên → bảng index idx1
// (offset tương đối vào movi) không xê dịch, an toàn tuyệt đối.
//
// Vô hiệu hoá: LIST INFO (ISFT phần mềm, IART tác giả, ICRD ngày, ICOP bản quyền…),
// chunk IDIT (ngày số hoá — camera hay ghi), chunk strn (tên stream).

import {CleanerError, asciiAt, decodeLatin1} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {classifyTag} from '../risk';

export interface AviChunk {
  fourcc: string;
  /** Với LIST: loại danh sách (hdrl/INFO/movi...). */
  listType?: string;
  start: number;
  /** Hết chunk KỂ CẢ byte đệm khi size lẻ. */
  end: number;
  dataStart: number;
  dataEnd: number;
  path: string;
}

export interface AviParseResult {
  chunks: AviChunk[];
  trailingStart: number | null;
  warnings: string[];
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Các LIST cần duyệt vào trong để tìm metadata (KHÔNG duyệt movi — toàn dữ liệu video). */
const DESCEND_LISTS = new Set(['hdrl', 'strl', 'odml']);

export function parseAvi(bytes: Uint8Array): AviParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (
    bytes.length < 12 ||
    asciiAt(bytes, 0, 4) !== 'RIFF' ||
    asciiAt(bytes, 8, 4) !== 'AVI '
  ) {
    throw new CleanerError('corrupt', 'Không phải file AVI hợp lệ (thiếu RIFF/AVI ).');
  }
  const riffSize = u32le(bytes, 4);
  const declaredEnd = 8 + riffSize + (riffSize % 2);
  if (8 + riffSize > bytes.length) {
    throw new CleanerError('truncated', 'File AVI bị cắt cụt (RIFF size vượt quá cuối file).');
  }

  const chunks: AviChunk[] = [];
  const warnings: string[] = [];

  function walk(start: number, end: number, path: string, depth: number): void {
    if (depth > 8) throw new CleanerError('corrupt', 'LIST AVI lồng quá sâu.');
    let pos = start;
    while (pos < end) {
      if (pos + 8 > end) {
        throw new CleanerError('truncated', `File AVI bị cắt cụt giữa chunk (tại ${pos}).`);
      }
      const fourcc = asciiAt(bytes, pos, 4);
      if (!/^[\x20-\x7e]{4}$/.test(fourcc)) {
        throw new CleanerError('corrupt', `FourCC không hợp lệ tại byte ${pos}.`);
      }
      const size = u32le(bytes, pos + 4);
      const dataStart = pos + 8;
      const dataEnd = dataStart + size;
      const chunkEnd = dataEnd + (size % 2);
      if (dataEnd > end) {
        throw new CleanerError('truncated', `Chunk ${fourcc} dài quá vùng chứa (tại ${pos}).`);
      }
      const chunk: AviChunk = {
        fourcc,
        start: pos,
        end: Math.min(chunkEnd, end),
        dataStart,
        dataEnd,
        path,
      };
      if (fourcc === 'LIST' && size >= 4) {
        chunk.listType = asciiAt(bytes, dataStart, 4);
        if (DESCEND_LISTS.has(chunk.listType)) {
          chunks.push(chunk);
          walk(dataStart + 4, dataEnd, path ? `${path}/${chunk.listType}` : chunk.listType, depth + 1);
          pos = chunk.end;
          continue;
        }
      }
      chunks.push(chunk);
      pos = chunk.end;
    }
  }

  walk(12, Math.min(declaredEnd, bytes.length), '', 0);
  const trailingStart = declaredEnd < bytes.length ? declaredEnd : null;
  return {chunks, trailingStart, warnings};
}

/** Đổi chunk thành JUNK + payload toàn 0 (giữ nguyên trường size). */
function junkInPlace(out: Uint8Array, chunk: AviChunk): void {
  out[chunk.start] = 0x4a; // 'J'
  out[chunk.start + 1] = 0x55; // 'U'
  out[chunk.start + 2] = 0x4e; // 'N'
  out[chunk.start + 3] = 0x4b; // 'K'
  out.fill(0, chunk.dataStart, chunk.end);
}

const INFO_LABELS: Record<string, string> = {
  ISFT: 'Phần mềm',
  IART: 'Tác giả/Nghệ sĩ',
  ICRD: 'Ngày tạo',
  ICOP: 'Bản quyền',
  ICMT: 'Chú thích',
  INAM: 'Tên video',
  IENG: 'Người quay',
  ITCH: 'Kỹ thuật viên',
  ISRC: 'Nguồn',
};

export function cleanAvi(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {chunks, trailingStart} = parseAvi(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];

  if (options.gpsOnly) {
    notes.push(
      'AVI không có trường GPS dạng chuẩn — chế độ "chỉ xoá GPS" không thay đổi gì. Dùng chế độ xoá sạch nếu muốn gỡ INFO/ngày quay.',
    );
    return {data: bytes.slice(), removed, bytesRemoved: 0, notes};
  }

  const endLimit = trailingStart ?? bytes.length;
  const out = bytes.slice(0, endLimit);
  if (trailingStart !== null) {
    removed.push({
      kind: 'trailing',
      bytes: bytes.length - trailingStart,
      note: `${bytes.length - trailingStart} byte dữ liệu ẩn sau vùng RIFF`,
    });
  }

  let junked = 0;
  for (const chunk of chunks) {
    const isInfoList = chunk.fourcc === 'LIST' && chunk.listType === 'INFO';
    const isMetaChunk = chunk.fourcc === 'IDIT' || chunk.fourcc === 'strn';
    if (isInfoList || isMetaChunk) {
      junkInPlace(out, chunk);
      junked++;
      removed.push({
        kind: 'avi-meta',
        bytes: chunk.end - chunk.start,
        note: isInfoList ? 'LIST INFO (phần mềm, tác giả, ngày...)' : chunk.fourcc === 'IDIT' ? 'IDIT (ngày số hoá)' : 'strn (tên stream)',
      });
    }
  }

  if (junked > 0) {
    notes.push(
      'Các khối metadata được đổi thành chunk JUNK (đệm chuẩn AVI) và ghi 0 — kích thước file giữ nguyên để không xê dịch bảng index (an toàn tuyệt đối, không re-encode).',
    );
  }

  const bytesRemoved = bytes.length - out.length;
  return {data: out, removed, bytesRemoved, notes};
}

export async function inspectAvi(bytes: Uint8Array): Promise<MetadataReport> {
  const {chunks, trailingStart, warnings} = parseAvi(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const allWarnings = [...warnings];
  const counters = new Map<string, number>();
  const nextId = (k: string): string => {
    const n = counters.get(k) ?? 0;
    counters.set(k, n + 1);
    return `avi:${k}:${n}`;
  };

  let width: number | undefined;
  let height: number | undefined;

  for (const chunk of chunks) {
    // avih (main header) trong hdrl: width u32le @32, height @36 của payload
    if (chunk.fourcc === 'avih' && chunk.dataEnd - chunk.dataStart >= 40) {
      width = u32le(bytes, chunk.dataStart + 32);
      height = u32le(bytes, chunk.dataStart + 36);
    }

    if (chunk.fourcc === 'LIST' && chunk.listType === 'INFO') {
      metaSegments.push({kind: 'avi-meta', bytes: chunk.end - chunk.start, note: 'LIST INFO'});
      // Duyệt các chunk con IXXX bên trong
      let pos = chunk.dataStart + 4;
      let guard = 0;
      while (pos + 8 <= chunk.dataEnd && guard++ < 64) {
        const cc = asciiAt(bytes, pos, 4);
        const size = u32le(bytes, pos + 4);
        if (pos + 8 + size > chunk.dataEnd) break;
        const text = decodeLatin1(bytes.subarray(pos + 8, pos + 8 + size)).replace(/\0+$/, '');
        const label = INFO_LABELS[cc] ?? cc;
        if (text) {
          fields.push({
            id: nextId(cc),
            group: 'AVI',
            tag: label,
            value: text.slice(0, 300),
            risk: /IART|IENG|ITCH/.test(cc) ? 'high' : classifyTag('AVI', label),
          });
        }
        pos += 8 + size + (size % 2);
      }
    }
    if (chunk.fourcc === 'IDIT') {
      const text = decodeLatin1(bytes.subarray(chunk.dataStart, chunk.dataEnd)).replace(/\0+$/, '');
      fields.push({id: nextId('idit'), group: 'AVI', tag: 'Ngày số hoá (IDIT)', value: text, risk: 'medium'});
      metaSegments.push({kind: 'avi-meta', bytes: chunk.end - chunk.start, note: 'IDIT'});
    }
    if (chunk.fourcc === 'strn') {
      const text = decodeLatin1(bytes.subarray(chunk.dataStart, chunk.dataEnd)).replace(/\0+$/, '');
      if (text) {
        fields.push({id: nextId('strn'), group: 'AVI', tag: 'Tên stream', value: text, risk: 'medium'});
      }
      metaSegments.push({kind: 'avi-meta', bytes: chunk.end - chunk.start, note: 'strn'});
    }
  }

  const trailingBytes = trailingStart !== null ? bytes.length - trailingStart : 0;
  if (trailingBytes > 0) {
    metaSegments.push({kind: 'trailing', bytes: trailingBytes, note: 'dữ liệu ẩn sau vùng RIFF'});
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau video. Sẽ bị xoá.`,
    );
  }

  return {
    format: 'avi',
    fileSize: bytes.length,
    width,
    height,
    fields,
    metaSegments,
    trailingBytes,
    warnings: allWarnings,
  };
}
