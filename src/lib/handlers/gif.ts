// Handler GIF: xoá Comment/Application/Plain Text extension (lossless).
//
// Chi tiết đã xác minh với spec GIF89a + Adobe XMP Part 3:
// - Block: 0x2C = ảnh, 0x21 = extension (label: 0xF9 GCE, 0xFE Comment, 0xFF App, 0x01 Text),
//   0x3B = kết thúc. Dữ liệu đi theo chuỗi sub-block [độ dài][data]... kết thúc 0x00.
// - GIỮ: Graphic Control (timing/trong suốt của GIF động) + NETSCAPE2.0/ANIMEXTS1.0 (loop).
// - XOÁ: Comment, XMP ('XMP Data'+'XMP', packet ghi thẳng + magic trailer 258 byte),
//   application extension lạ, Plain Text (kèm GCE đứng ngay trước nó).

import {CleanerError, concatParts, asciiAt, decodeLatin1, decodeUtf8} from '../binary';
import type {CleanOptions, CleanResult, MetadataField, MetadataReport, SegmentInfo} from '../types';
import {scrubXmpGps} from '../xmp-scrub';
import {classifyTag} from '../risk';

export interface GifBlock {
  kind:
    | 'header' // header + LSD + GCT
    | 'image'
    | 'gce'
    | 'comment'
    | 'xmp'
    | 'netscape'
    | 'application'
    | 'plaintext'
    | 'trailer'
    | 'trailing';
  start: number;
  end: number;
  /** Với extension: vị trí bắt đầu dữ liệu sau introducer+label. */
  dataStart: number;
}

export interface GifParseResult {
  blocks: GifBlock[];
  width: number;
  height: number;
  warnings: string[];
}

/** Nhảy qua chuỗi sub-block ([len][data])* 0x00, trả vị trí sau byte kết thúc. */
function walkSubBlocks(bytes: Uint8Array, pos: number): number {
  while (true) {
    if (pos >= bytes.length) {
      throw new CleanerError('truncated', 'GIF bị cắt cụt giữa chuỗi sub-block.');
    }
    const len = bytes[pos];
    pos++;
    if (len === 0) return pos;
    if (pos + len > bytes.length) {
      throw new CleanerError('truncated', 'GIF bị cắt cụt giữa một sub-block.');
    }
    pos += len;
  }
}

/** Tìm chuỗi byte ASCII trong mảng, từ vị trí from. Trả -1 nếu không thấy. */
function indexOfAscii(bytes: Uint8Array, needle: string, from: number): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Byte có thể mở đầu một block GIF hợp lệ ngay sau extension. */
function isBlockIntroducer(b: number | undefined): boolean {
  return b === 0x21 || b === 0x2c || b === 0x3b;
}

/**
 * Tìm điểm kết thúc của application extension XMP dựa trên NỘI DUNG packet
 * (packet luôn kết thúc bằng '</x:xmpmeta>' hoặc '<?xpacket end=...?>'),
 * sau đó nuốt dãy byte 0x00 (cuối magic trailer + block terminator).
 *
 * An toàn chống "nuốt nhầm": (1) byte 0x00 ĐẦU TIÊN sau identifier phải nằm
 * sau vị trí marker — nếu 0x00 xuất hiện trước marker nghĩa là marker tìm thấy
 * thuộc về block khác phía sau (packet XMP thật không chứa byte 0); (2) điểm
 * kết thúc phải đứng ngay trước một block introducer hợp lệ.
 * Trả null nếu không xác định được — caller sẽ quyết định tiếp.
 */
function xmpExtensionEnd(bytes: Uint8Array, dataStart: number): number | null {
  const searchFrom = dataStart + 12; // sau sub-block identifier 11 byte

  // Marker kết thúc packet: lấy cái xuất hiện SỚM NHẤT rồi tự hiệu chỉnh bằng quét 0x00
  let packetEnd = -1;
  const metaClose = indexOfAscii(bytes, '</x:xmpmeta>', searchFrom);
  if (metaClose >= 0) packetEnd = metaClose + '</x:xmpmeta>'.length;
  const xpacket = indexOfAscii(bytes, '<?xpacket end', searchFrom);
  if (xpacket >= 0) {
    let close = -1;
    for (let i = xpacket; i < bytes.length; i++) {
      if (bytes[i] === 0x3e) {
        close = i + 1;
        break;
      }
    }
    if (close > packetEnd) packetEnd = close;
  }
  if (packetEnd < 0) return null;

  // Chống marker "mượn" từ block sau: packet XMP không chứa 0x00, nên byte 0
  // đầu tiên sau identifier phải nằm SAU vị trí marker sớm nhất tìm được
  // (0x00 đứng trước marker = marker đó thuộc về block khác phía sau)
  const markerStart = Math.min(
    metaClose >= 0 ? metaClose : Number.POSITIVE_INFINITY,
    xpacket >= 0 ? xpacket : Number.POSITIVE_INFINITY,
  );
  let firstZero = -1;
  for (let i = searchFrom; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      firstZero = i;
      break;
    }
  }
  if (firstZero >= 0 && firstZero < markerStart) return null;

  // Nhảy qua magic trailer (toàn byte khác 0) rồi nuốt tối đa 2 byte 0x00
  // (byte 0 cuối dãy đếm ngược + block terminator)
  let p = packetEnd;
  while (p < bytes.length && bytes[p] !== 0) p++;
  let zeros = 0;
  while (p < bytes.length && bytes[p] === 0 && zeros < 2) {
    p++;
    zeros++;
  }
  if (p >= bytes.length || !isBlockIntroducer(bytes[p])) return null;
  return p;
}

/** Đọc nội dung chuỗi sub-block thành một mảng byte liền. */
function readSubBlocks(bytes: Uint8Array, pos: number): Uint8Array {
  const parts: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = bytes[pos];
    pos++;
    if (len === 0) break;
    parts.push(bytes.subarray(pos, pos + len));
    pos += len;
  }
  return concatParts(parts);
}

export function parseGif(bytes: Uint8Array): GifParseResult {
  if (bytes.length === 0) throw new CleanerError('empty', 'File rỗng (0 byte).');
  if (bytes.length < 13 || asciiAt(bytes, 0, 3) !== 'GIF') {
    throw new CleanerError('corrupt', 'Không phải file GIF hợp lệ.');
  }
  const warnings: string[] = [];
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);

  // Header 6 + Logical Screen Descriptor 7 + Global Color Table (nếu có)
  let pos = 13;
  const packed = bytes[10];
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }
  if (pos > bytes.length) throw new CleanerError('truncated', 'GIF bị cắt cụt trong bảng màu.');

  const blocks: GifBlock[] = [{kind: 'header', start: 0, end: pos, dataStart: 0}];
  let sawTrailer = false;

  while (pos < bytes.length) {
    const b = bytes[pos];
    if (b === 0x3b) {
      blocks.push({kind: 'trailer', start: pos, end: pos + 1, dataStart: pos});
      sawTrailer = true;
      pos++;
      break;
    }
    if (b === 0x2c) {
      // Image Descriptor 10 byte + Local Color Table + LZW min code + sub-blocks
      if (pos + 10 > bytes.length) throw new CleanerError('truncated', 'GIF cắt cụt trong image descriptor.');
      const start = pos;
      const ipacked = bytes[pos + 9];
      let p = pos + 10;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 0x07) + 1));
      p += 1; // LZW minimum code size
      if (p > bytes.length) throw new CleanerError('truncated', 'GIF cắt cụt trong bảng màu cục bộ.');
      p = walkSubBlocks(bytes, p);
      blocks.push({kind: 'image', start, end: p, dataStart: pos + 10});
      pos = p;
      continue;
    }
    if (b === 0x21) {
      if (pos + 2 > bytes.length) throw new CleanerError('truncated', 'GIF cắt cụt trong extension.');
      const label = bytes[pos + 1];
      const start = pos;
      const dataStart = pos + 2;

      let kind: GifBlock['kind'];
      let end: number;
      if (label === 0xf9) kind = 'gce';
      else if (label === 0xfe) kind = 'comment';
      else if (label === 0x01) kind = 'plaintext';
      else if (label === 0xff) {
        const id = bytes[dataStart] === 11 ? asciiAt(bytes, dataStart + 1, 11) : '';
        if (id === 'XMP DataXMP') kind = 'xmp';
        else if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') kind = 'netscape';
        else kind = 'application';
      } else {
        warnings.push(`Extension lạ 0x${label.toString(16)} — coi như metadata.`);
        kind = 'application';
      }

      if (kind === 'xmp') {
        // XMP ghi packet THẲNG (không chia sub-block). Ưu tiên tìm điểm kết thúc theo
        // nội dung packet — chịu được cả file thiếu magic trailer (tool ghi sai chuẩn).
        const smart = xmpExtensionEnd(bytes, dataStart);
        if (smart !== null) {
          end = smart;
        } else {
          end = walkSubBlocks(bytes, dataStart); // magic trailer bảo đảm dừng đúng chỗ
        }
      } else {
        end = walkSubBlocks(bytes, dataStart);
      }
      blocks.push({kind, start, end, dataStart});
      pos = end;
      continue;
    }
    throw new CleanerError('corrupt', `Byte không mong đợi 0x${b.toString(16)} tại ${pos}.`);
  }

  if (!sawTrailer) warnings.push('GIF thiếu byte kết thúc 0x3B — file có thể bị cắt cụt.');
  if (sawTrailer && pos < bytes.length) {
    blocks.push({kind: 'trailing', start: pos, end: bytes.length, dataStart: pos});
  }
  return {blocks, width, height, warnings};
}

/** Trích packet XMP từ block xmp (bỏ 11 byte identifier + 258 byte magic trailer). */
function extractXmpPacket(bytes: Uint8Array, block: GifBlock): string {
  // Sub-block đầu: [0x0B][11 byte id]; packet ghi THẲNG sau đó, kết thúc bằng trailer
  let p = block.dataStart + 1 + 11;
  let end = block.end - 1; // trừ block terminator
  const packet = bytes.subarray(p, Math.max(p, end));
  // Cắt magic trailer 257 byte cuối (0x01 + 256 byte đếm ngược) nếu có
  if (packet.length > 257 && packet[packet.length - 257] === 0x01 && packet[packet.length - 1] === 0x00) {
    return decodeUtf8(packet.subarray(0, packet.length - 257));
  }
  return decodeUtf8(packet);
}

/** Magic trailer 257 byte + block terminator để XMP raw không phá bộ đọc sub-block. */
function xmpMagicTrailer(): Uint8Array {
  const t = new Uint8Array(258);
  t[0] = 0x01;
  for (let i = 0; i < 256; i++) t[1 + i] = 255 - i;
  t[257] = 0x00; // block terminator
  return t;
}

function buildXmpExtension(packet: string): Uint8Array {
  const payload = new TextEncoder().encode(packet);
  return concatParts([
    new Uint8Array([0x21, 0xff, 0x0b]),
    new TextEncoder().encode('XMP DataXMP'),
    payload,
    xmpMagicTrailer(),
  ]);
}

export function cleanGif(bytes: Uint8Array, options: CleanOptions): CleanResult {
  const {blocks} = parseGif(bytes);
  const removed: SegmentInfo[] = [];
  const notes: string[] = [];
  const parts: Uint8Array[] = [];
  let pendingGce: GifBlock | null = null;

  const flushGce = () => {
    if (pendingGce) {
      parts.push(bytes.subarray(pendingGce.start, pendingGce.end));
      pendingGce = null;
    }
  };

  for (const block of blocks) {
    const size = block.end - block.start;
    switch (block.kind) {
      case 'header':
      case 'trailer':
      case 'netscape':
        flushGce();
        parts.push(bytes.subarray(block.start, block.end));
        break;
      case 'image':
        flushGce();
        parts.push(bytes.subarray(block.start, block.end));
        break;
      case 'gce':
        // GCE gắn với block đồ hoạ NGAY SAU nó — giữ lại trừ khi block đó bị xoá
        flushGce();
        pendingGce = block;
        break;
      case 'comment':
        // Block bị XOÁ thì KHÔNG nhả GCE đang chờ — GCE phải tiếp tục chờ để
        // gắn đúng vào block đồ hoạ kế tiếp (nếu nhả sớm sẽ thành GCE "mồ côi")
        if (options.gpsOnly) {
          flushGce();
          parts.push(bytes.subarray(block.start, block.end));
        } else {
          removed.push({kind: 'comment', bytes: size});
        }
        break;
      case 'xmp': {
        if (options.gpsOnly) {
          flushGce();
          const scrubbed = scrubXmpGps(extractXmpPacket(bytes, block));
          if (scrubbed.removed > 0) {
            const rebuilt = buildXmpExtension(scrubbed.xml);
            parts.push(rebuilt);
            removed.push({
              kind: 'xmp',
              bytes: Math.max(0, size - rebuilt.length),
              note: `đã gỡ ${scrubbed.removed} mục GPS trong XMP`,
            });
          } else {
            parts.push(bytes.subarray(block.start, block.end));
          }
        } else {
          removed.push({kind: 'xmp', bytes: size});
        }
        break;
      }
      case 'application':
        if (options.gpsOnly) {
          flushGce();
          parts.push(bytes.subarray(block.start, block.end));
        } else {
          removed.push({kind: 'app-extension', bytes: size});
        }
        break;
      case 'plaintext':
        if (options.gpsOnly) {
          flushGce();
          parts.push(bytes.subarray(block.start, block.end));
        } else {
          // Xoá plain text thì xoá luôn GCE đi kèm (phạm vi của nó là block này)
          if (pendingGce) {
            removed.push({kind: 'gce', bytes: pendingGce.end - pendingGce.start, note: 'GCE của plain text'});
            pendingGce = null;
          }
          removed.push({kind: 'plaintext', bytes: size});
        }
        break;
      case 'trailing':
        if (options.gpsOnly) {
          notes.push(
            `Giữ ${size.toLocaleString('vi-VN')} byte dữ liệu sau trailer — LƯU Ý: phần này có thể chứa toạ độ GPS riêng, chế độ "chỉ xoá GPS" chưa quét được vào trong đó.`,
          );
          parts.push(bytes.subarray(block.start, block.end));
        } else {
          removed.push({kind: 'trailing', bytes: size, note: `${size} byte dữ liệu ẩn sau trailer`});
        }
        break;
    }
  }
  flushGce();

  const bytesRemoved = removed.reduce((sum, r) => sum + Math.max(0, r.bytes), 0);
  return {data: concatParts(parts), removed, bytesRemoved, notes};
}

export async function inspectGif(bytes: Uint8Array): Promise<MetadataReport> {
  const {blocks, width, height, warnings} = parseGif(bytes);
  const fields: MetadataField[] = [];
  const metaSegments: SegmentInfo[] = [];
  const allWarnings = [...warnings];

  // id trường theo số thứ tự (không dùng offset byte) để so sánh trước/sau ổn định
  const counters = {comment: 0, xmp: 0, app: 0, plaintext: 0};
  for (const block of blocks) {
    const size = block.end - block.start;
    if (block.kind === 'comment') {
      const text = decodeLatin1(readSubBlocks(bytes, block.dataStart)).slice(0, 500);
      fields.push({
        id: `gif:comment:${counters.comment++}`,
        group: 'GIF',
        tag: 'Comment',
        value: text,
        risk: classifyTag('GIF', 'Comment'),
      });
      metaSegments.push({kind: 'comment', bytes: size});
    } else if (block.kind === 'xmp') {
      const xml = extractXmpPacket(bytes, block);
      const hasGps = /GPS\w+/i.test(xml);
      fields.push({
        id: `gif:xmp:${counters.xmp++}`,
        group: 'XMP',
        tag: 'XMP',
        value: `Gói XMP (${xml.length.toLocaleString('vi-VN')} ký tự)${hasGps ? ' — CÓ chứa toạ độ GPS' : ''}`,
        risk: 'high',
      });
      metaSegments.push({kind: 'xmp', bytes: size});
    } else if (block.kind === 'application') {
      const id = bytes[block.dataStart] === 11 ? asciiAt(bytes, block.dataStart + 1, 11) : '?';
      fields.push({
        id: `gif:app:${id}:${counters.app++}`,
        group: 'GIF',
        tag: 'Application',
        value: `Extension "${id}" (${size.toLocaleString('vi-VN')} byte)`,
        risk: 'medium',
      });
      metaSegments.push({kind: 'app-extension', bytes: size, note: id});
    } else if (block.kind === 'plaintext') {
      metaSegments.push({kind: 'plaintext', bytes: size});
      fields.push({
        id: `gif:plaintext:${counters.plaintext++}`,
        group: 'GIF',
        tag: 'PlainText',
        value: decodeLatin1(readSubBlocks(bytes, block.dataStart + 13)).slice(0, 200),
        risk: 'medium',
      });
    }
  }

  const trailing = blocks.find(b => b.kind === 'trailing');
  const trailingBytes = trailing ? trailing.end - trailing.start : 0;
  if (trailingBytes > 0) {
    metaSegments.push({kind: 'trailing', bytes: trailingBytes, note: 'dữ liệu ẩn sau trailer'});
    allWarnings.push(
      `Có ${trailingBytes.toLocaleString('vi-VN')} byte dữ liệu ẩn sau ảnh. Sẽ bị xoá.`,
    );
  }

  return {
    format: 'gif',
    fileSize: bytes.length,
    width,
    height,
    fields,
    metaSegments,
    trailingBytes,
    warnings: allWarnings,
  };
}
