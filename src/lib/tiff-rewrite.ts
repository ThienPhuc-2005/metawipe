// Bộ VIẾT LẠI khối TIFF/EXIF: dựng một khối TIFF mới chỉ chứa các tag được giữ,
// copy nguyên vẹn dữ liệu ảnh (strips/tiles/JPEG cũ) và cập nhật lại mọi offset.
//
// Dùng cho 3 việc:
//  1. Chế độ "chỉ xoá GPS": giữ nguyên EXIF, chỉ cắt GPS IFD.
//  2. Xoá sạch nhưng giữ vài tag (Orientation, Copyright) — dựng EXIF tối giản.
//  3. Handler file TIFF thật: giữ tag hiển thị (whitelist), copy dữ liệu ảnh.
//
// Giữ nguyên thứ tự byte (endian) của file gốc để không phá MakerNote.

import {CleanerError} from './binary';

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

// Tag con trỏ tới IFD khác — xử lý riêng, không copy giá trị thô
const EXIF_IFD_TAG = 0x8769;
const GPS_IFD_TAG = 0x8825;
const INTEROP_IFD_TAG = 0xa005;
const SUBIFDS_TAG = 0x014a;

// Cặp tag [offset ảnh → độ dài ảnh] cần copy dữ liệu và ghi lại offset mới
const DATA_TAG_PAIRS: Record<number, number> = {
  273: 279, // StripOffsets → StripByteCounts
  324: 325, // TileOffsets → TileByteCounts
  513: 514, // JPEGInterchangeFormat → ...Length (JPEG cũ / thumbnail EXIF)
};
const DATA_LENGTH_TAGS = new Set(Object.values(DATA_TAG_PAIRS));

export interface TiffRewriteFilter {
  /** Giữ tag thường trong IFD trang ảnh / IFD0 / IFD1? */
  keepPageTag(tag: number): boolean;
  /**
   * Biến đổi GIÁ TRỊ của một tag được giữ (vd gột GPS khỏi XMP tag 700).
   * Trả undefined = giữ nguyên; trả Uint8Array = thay giá trị (count cập nhật theo).
   */
  transformPageTag?(tag: number, value: Uint8Array): Uint8Array | undefined;
  /** Giữ nguyên Exif IFD (true trong chế độ chỉ-xoá-GPS)? */
  keepExifIfd: boolean;
  /** Lọc từng tag bên trong Exif IFD (mặc định giữ hết). */
  keepExifTag?(tag: number): boolean;
  keepGpsIfd: boolean;
  keepInteropIfd: boolean;
  /** Giữ IFD1 (thumbnail trong EXIF) / các trang sau của TIFF nhiều trang? */
  keepChain: boolean;
  /** Copy dữ liệu ảnh (bật cho file TIFF thật và thumbnail IFD1). */
  copyImageData: boolean;
}

export interface TiffRewriteResult {
  /** Khối TIFF mới, hoặc null nếu không còn tag nào đáng giữ. */
  data: Uint8Array | null;
  /** Tag đã bị xoá (mã hex + IFD) để báo cáo. */
  removedTags: string[];
  warnings: string[];
}

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  /** Giá trị thô đã giải offset (đúng byteLen). */
  value: Uint8Array;
}

class ByteWriter {
  private buf = new Uint8Array(4096);
  len = 0;

  constructor(private little: boolean) {}

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.ensure(2);
    if (this.little) {
      this.buf[this.len++] = v & 0xff;
      this.buf[this.len++] = (v >> 8) & 0xff;
    } else {
      this.buf[this.len++] = (v >> 8) & 0xff;
      this.buf[this.len++] = v & 0xff;
    }
  }

  u32(v: number): void {
    this.ensure(4);
    if (this.little) {
      this.buf[this.len++] = v & 0xff;
      this.buf[this.len++] = (v >>> 8) & 0xff;
      this.buf[this.len++] = (v >>> 16) & 0xff;
      this.buf[this.len++] = (v >>> 24) & 0xff;
    } else {
      this.buf[this.len++] = (v >>> 24) & 0xff;
      this.buf[this.len++] = (v >>> 16) & 0xff;
      this.buf[this.len++] = (v >>> 8) & 0xff;
      this.buf[this.len++] = v & 0xff;
    }
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  align2(): void {
    if (this.len % 2 === 1) this.u8(0);
  }

  patchU32(pos: number, v: number): void {
    const save = this.len;
    this.len = pos;
    this.u32(v);
    this.len = Math.max(save, this.len);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Viết lại khối TIFF theo bộ lọc. Ném CleanerError nếu file hỏng/không hỗ trợ. */
export function rewriteTiff(bytes: Uint8Array, filter: TiffRewriteFilter): TiffRewriteResult {
  if (bytes.length < 8) throw new CleanerError('corrupt', 'Khối TIFF quá ngắn.');
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) throw new CleanerError('corrupt', 'Khối TIFF sai chữ ký byte-order.');

  const u16 = (o: number): number =>
    little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
  const u32 = (o: number): number =>
    little
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;

  const magic = u16(2);
  if (magic === 43) {
    throw new CleanerError('unsupported', 'BigTIFF chưa được hỗ trợ.');
  }
  if (magic !== 42) throw new CleanerError('corrupt', 'Khối TIFF sai magic number.');

  const removedTags: string[] = [];
  const warnings: string[] = [];
  const visited = new Set<number>();

  function readIfd(offset: number, ifdName: string): {entries: RawEntry[]; next: number} {
    if (offset === 0 || offset + 2 > bytes.length) {
      throw new CleanerError('corrupt', `Offset IFD ${ifdName} nằm ngoài file.`);
    }
    if (visited.has(offset)) {
      throw new CleanerError('corrupt', `IFD ${ifdName} tạo vòng lặp offset.`);
    }
    visited.add(offset);
    if (visited.size > 2048) throw new CleanerError('corrupt', 'Quá nhiều IFD (file bất thường).');

    const count = u16(offset);
    const tableEnd = offset + 2 + count * 12;
    if (tableEnd + 4 > bytes.length) {
      throw new CleanerError('corrupt', `IFD ${ifdName} dài quá cuối file.`);
    }
    const entries: RawEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      const size = TYPE_SIZES[type];
      if (!size) {
        warnings.push(`Bỏ qua tag 0x${tag.toString(16)} (${ifdName}) có kiểu dữ liệu lạ ${type}.`);
        continue;
      }
      const byteLen = size * cnt;
      if (byteLen > 64 * 1024 * 1024) {
        warnings.push(`Bỏ qua tag 0x${tag.toString(16)} (${ifdName}) có giá trị lớn bất thường.`);
        continue;
      }
      let value: Uint8Array;
      if (byteLen <= 4) {
        value = bytes.slice(e + 8, e + 8 + byteLen);
      } else {
        const vo = u32(e + 8);
        if (vo + byteLen > bytes.length) {
          warnings.push(`Bỏ qua tag 0x${tag.toString(16)} (${ifdName}) trỏ ra ngoài file.`);
          continue;
        }
        value = bytes.slice(vo, vo + byteLen);
      }
      entries.push({tag, type, count: cnt, value});
    }
    return {entries, next: u32(tableEnd)};
  }

  function readNumbers(entry: RawEntry): number[] {
    const out: number[] = [];
    const dv = new DataView(entry.value.buffer, entry.value.byteOffset, entry.value.byteLength);
    for (let i = 0; i < entry.count; i++) {
      if (entry.type === 3) out.push(dv.getUint16(i * 2, little));
      else if (entry.type === 4 || entry.type === 13) out.push(dv.getUint32(i * 4, little));
      else if (entry.type === 1) out.push(entry.value[i]);
      else throw new CleanerError('corrupt', `Tag offset 0x${entry.tag.toString(16)} có kiểu không hợp lệ.`);
    }
    return out;
  }

  const out = new ByteWriter(little);
  out.u8(little ? 0x49 : 0x4d);
  out.u8(little ? 0x49 : 0x4d);
  out.u16(42);
  const headerPatch = out.len;
  out.u32(0); // offset IFD0 — vá sau

  interface OutEntry {
    tag: number;
    type: number;
    count: number;
    data: Uint8Array;
  }

  function numbersToBytes(nums: number[]): Uint8Array {
    const b = new Uint8Array(nums.length * 4);
    const dv = new DataView(b.buffer);
    nums.forEach((n, i) => dv.setUint32(i * 4, n, little));
    return b;
  }

  /** Copy các khối dữ liệu ảnh mà entry offset trỏ tới; trả entry offset mới (LONG). */
  function copyDataBlocks(entry: RawEntry, all: RawEntry[], ifdName: string): OutEntry | null {
    const lengthTag = DATA_TAG_PAIRS[entry.tag];
    const lenEntry = all.find(e => e.tag === lengthTag);
    const offsets = readNumbers(entry);
    let lengths: number[];
    if (lenEntry) {
      lengths = readNumbers(lenEntry);
    } else if (entry.tag === 513 && offsets.length === 1) {
      // Một số file cũ thiếu JPEGInterchangeFormatLength — copy tới cuối khối
      lengths = [bytes.length - offsets[0]];
      warnings.push('Thiếu độ dài JPEG nhúng — copy tới cuối khối TIFF.');
    } else {
      warnings.push(`Bỏ dữ liệu ảnh của tag 0x${entry.tag.toString(16)} (${ifdName}) vì thiếu tag độ dài.`);
      return null;
    }
    if (lengths.length !== offsets.length) {
      throw new CleanerError('corrupt', `Số offset và số độ dài không khớp trong ${ifdName}.`);
    }
    const newOffsets: number[] = [];
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] + lengths[i] > bytes.length) {
        throw new CleanerError('corrupt', `Dữ liệu ảnh trỏ ra ngoài file (${ifdName}).`);
      }
      out.align2();
      newOffsets.push(out.len);
      out.bytes(bytes.subarray(offsets[i], offsets[i] + lengths[i]));
    }
    return {tag: entry.tag, type: 4, count: newOffsets.length, data: numbersToBytes(newOffsets)};
  }

  /** Ghi một IFD hoàn chỉnh (bảng entry + vùng giá trị), trả offset + vị trí con trỏ cần vá. */
  function writeIfd(entries: OutEntry[], pointerTags: Map<number, number>): {
    offset: number;
    nextPatch: number;
    pointerPatches: Map<number, number>;
  } {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    out.align2();
    const offset = out.len;
    out.u16(sorted.length);
    const valuePatches: Array<{pos: number; data: Uint8Array}> = [];
    const pointerPatches = new Map<number, number>();
    for (const e of sorted) {
      out.u16(e.tag);
      out.u16(e.type);
      out.u32(e.count);
      if (pointerTags.has(e.tag)) {
        pointerPatches.set(e.tag, out.len);
        out.u32(0);
      } else if (e.data.length <= 4) {
        // Giá trị nằm gọn trong 4 byte: ghi thẳng, phần thừa đệm 0
        const pos = out.len;
        out.u32(0);
        const save = out.len;
        out.len = pos;
        out.bytes(e.data);
        out.len = save;
      } else {
        valuePatches.push({pos: out.len, data: e.data});
        out.u32(0);
      }
    }
    const nextPatch = out.len;
    out.u32(0);
    for (const vp of valuePatches) {
      out.align2();
      out.patchU32(vp.pos, out.len);
      out.bytes(vp.data);
    }
    return {offset, nextPatch, pointerPatches};
  }

  /** Dựng lại một IFD "lá" (GPS/Interop) — không có con trỏ con. */
  function rebuildLeafIfd(offset: number, name: string): number {
    const {entries} = readIfd(offset, name);
    const outs: OutEntry[] = entries.map(e => ({tag: e.tag, type: e.type, count: e.count, data: e.value}));
    return writeIfd(outs, new Map()).offset;
  }

  /** Dựng lại Exif IFD (có thể chứa con trỏ Interop). */
  function rebuildExifIfd(offset: number): number {
    const {entries} = readIfd(offset, 'Exif');
    const outs: OutEntry[] = [];
    let interopOffset: number | undefined;
    const pointerTags = new Map<number, number>();
    for (const e of entries) {
      if (filter.keepExifTag && e.tag !== INTEROP_IFD_TAG && !filter.keepExifTag(e.tag)) {
        removedTags.push(`Exif:0x${e.tag.toString(16)}`);
        continue;
      }
      if (e.tag === INTEROP_IFD_TAG) {
        if (filter.keepInteropIfd && e.count === 1) {
          interopOffset = readNumbers(e)[0];
          pointerTags.set(INTEROP_IFD_TAG, 0);
          outs.push({tag: e.tag, type: 4, count: 1, data: new Uint8Array(4)});
        } else {
          removedTags.push('Exif:InteropIFD');
        }
        continue;
      }
      outs.push({tag: e.tag, type: e.type, count: e.count, data: e.value});
    }
    // Ghi Interop trước để biết offset, rồi ghi Exif IFD và vá con trỏ
    let interopNew: number | undefined;
    if (interopOffset !== undefined) {
      try {
        interopNew = rebuildLeafIfd(interopOffset, 'Interop');
      } catch {
        warnings.push('Interop IFD hỏng — đã bỏ.');
        const i = outs.findIndex(o => o.tag === INTEROP_IFD_TAG);
        if (i >= 0) outs.splice(i, 1);
        pointerTags.delete(INTEROP_IFD_TAG);
      }
    }
    const written = writeIfd(outs, pointerTags);
    if (interopNew !== undefined) {
      const p = written.pointerPatches.get(INTEROP_IFD_TAG);
      if (p !== undefined) out.patchU32(p, interopNew);
    }
    return written.offset;
  }

  /**
   * Dựng lại một IFD trang ảnh (IFD0/IFD1/trang TIFF/SubIFD).
   * Trả null nếu sau khi lọc không còn gì đáng giữ.
   */
  function rebuildPageIfd(offset: number, name: string, depth: number): {offset: number; nextPatch: number} | null {
    if (depth > 4) throw new CleanerError('corrupt', 'SubIFD lồng quá sâu.');
    const {entries} = readIfd(offset, name);

    const outs: OutEntry[] = [];
    const pointerTags = new Map<number, number>();
    let exifOffset: number | undefined;
    let gpsOffset: number | undefined;
    let subIfdOffsets: number[] = [];

    for (const e of entries) {
      if (e.tag === EXIF_IFD_TAG) {
        if (filter.keepExifIfd && e.count === 1) {
          exifOffset = readNumbers(e)[0];
          pointerTags.set(EXIF_IFD_TAG, 0);
          outs.push({tag: e.tag, type: 4, count: 1, data: new Uint8Array(4)});
        } else {
          removedTags.push(`${name}:ExifIFD`);
        }
        continue;
      }
      if (e.tag === GPS_IFD_TAG) {
        if (filter.keepGpsIfd && e.count === 1) {
          gpsOffset = readNumbers(e)[0];
          pointerTags.set(GPS_IFD_TAG, 0);
          outs.push({tag: e.tag, type: 4, count: 1, data: new Uint8Array(4)});
        } else {
          removedTags.push(`${name}:GPS`);
        }
        continue;
      }
      if (e.tag === SUBIFDS_TAG) {
        if (filter.keepPageTag(e.tag) && filter.copyImageData) {
          subIfdOffsets = readNumbers(e);
          pointerTags.set(SUBIFDS_TAG, 0);
          outs.push({tag: e.tag, type: 4, count: subIfdOffsets.length, data: new Uint8Array(4 * subIfdOffsets.length)});
        } else {
          removedTags.push(`${name}:SubIFDs`);
        }
        continue;
      }
      if (e.tag in DATA_TAG_PAIRS) {
        if (!filter.copyImageData) {
          removedTags.push(`${name}:0x${e.tag.toString(16)}`);
          continue;
        }
        const copied = copyDataBlocks(e, entries, name);
        if (copied) outs.push(copied);
        continue;
      }
      if (DATA_LENGTH_TAGS.has(e.tag)) {
        if (!filter.copyImageData) continue; // đi cùng tag offset đã bị bỏ
        outs.push({tag: e.tag, type: e.type, count: e.count, data: e.value});
        continue;
      }
      if (filter.keepPageTag(e.tag)) {
        const transformed = filter.transformPageTag?.(e.tag, e.value);
        if (transformed !== undefined) {
          // Giá trị mới: cập nhật count theo kích thước phần tử của kiểu dữ liệu
          const unit = TYPE_SIZES[e.type] || 1;
          outs.push({tag: e.tag, type: e.type, count: Math.ceil(transformed.length / unit), data: transformed});
          removedTags.push(`${name}:0x${e.tag.toString(16)}(đã lọc)`);
        } else {
          outs.push({tag: e.tag, type: e.type, count: e.count, data: e.value});
        }
      } else {
        removedTags.push(`${name}:0x${e.tag.toString(16)}`);
      }
    }

    if (outs.length === 0) return null;

    // Dựng các IFD con trước (dữ liệu của chúng nằm trước bảng IFD cha — hợp lệ vì offset tuyệt đối)
    let exifNew: number | undefined;
    if (exifOffset !== undefined) {
      try {
        exifNew = rebuildExifIfd(exifOffset);
      } catch {
        warnings.push('Exif IFD hỏng — đã bỏ.');
        const i = outs.findIndex(o => o.tag === EXIF_IFD_TAG);
        if (i >= 0) outs.splice(i, 1);
        pointerTags.delete(EXIF_IFD_TAG);
      }
    }
    let gpsNew: number | undefined;
    if (gpsOffset !== undefined) {
      try {
        gpsNew = rebuildLeafIfd(gpsOffset, 'GPS');
      } catch {
        warnings.push('GPS IFD hỏng — đã bỏ.');
        const i = outs.findIndex(o => o.tag === GPS_IFD_TAG);
        if (i >= 0) outs.splice(i, 1);
        pointerTags.delete(GPS_IFD_TAG);
      }
    }
    const subNew: number[] = [];
    for (const so of subIfdOffsets) {
      const child = rebuildPageIfd(so, `${name}/Sub`, depth + 1);
      if (child) subNew.push(child.offset);
    }
    if (pointerTags.has(SUBIFDS_TAG)) {
      const i = outs.findIndex(o => o.tag === SUBIFDS_TAG);
      if (subNew.length === 0) {
        if (i >= 0) outs.splice(i, 1);
        pointerTags.delete(SUBIFDS_TAG);
      } else if (i >= 0) {
        outs[i] = {tag: SUBIFDS_TAG, type: 4, count: subNew.length, data: numbersToBytes(subNew)};
        if (subNew.length <= 1) {
          // vẫn cần vá qua pointerPatches nếu inline ≤4 byte? Không — giá trị đã là offset thật
        }
        pointerTags.delete(SUBIFDS_TAG);
      }
    }
    if (outs.length === 0) return null;

    const written = writeIfd(outs, pointerTags);
    if (exifNew !== undefined) {
      const p = written.pointerPatches.get(EXIF_IFD_TAG);
      if (p !== undefined) out.patchU32(p, exifNew);
    }
    if (gpsNew !== undefined) {
      const p = written.pointerPatches.get(GPS_IFD_TAG);
      if (p !== undefined) out.patchU32(p, gpsNew);
    }
    return {offset: written.offset, nextPatch: written.nextPatch};
  }

  // Đi theo chuỗi IFD: IFD0 → IFD1/trang kế tiếp
  const MAX_PAGES = 512;
  const ifd0Offset = u32(4);
  const chain: number[] = [];
  {
    let off = ifd0Offset;
    const seen = new Set<number>();
    while (off !== 0 && !seen.has(off)) {
      if (chain.length >= MAX_PAGES) {
        // Không được cắt trang âm thầm — mất dữ liệu người dùng
        throw new CleanerError('unsupported', `TIFF có hơn ${MAX_PAGES} trang — chưa hỗ trợ.`);
      }
      seen.add(off);
      chain.push(off);
      if (off + 2 > bytes.length) break;
      const cnt = u16(off);
      const nextPos = off + 2 + cnt * 12;
      if (nextPos + 4 > bytes.length) break;
      off = u32(nextPos);
    }
  }
  if (chain.length === 0) throw new CleanerError('corrupt', 'TIFF không có IFD nào.');

  const pages = filter.keepChain ? chain : chain.slice(0, 1);
  let prevNextPatch: number | null = null;
  let firstOffset: number | null = null;
  for (let i = 0; i < pages.length; i++) {
    const rebuilt = rebuildPageIfd(pages[i], i === 0 ? 'IFD0' : `IFD${i}`, 0);
    if (!rebuilt) continue;
    if (firstOffset === null) {
      firstOffset = rebuilt.offset;
      out.patchU32(headerPatch, rebuilt.offset);
    } else if (prevNextPatch !== null) {
      out.patchU32(prevNextPatch, rebuilt.offset);
    }
    prevNextPatch = rebuilt.nextPatch;
  }

  if (firstOffset === null) {
    return {data: null, removedTags, warnings};
  }
  return {data: out.result(), removedTags, warnings};
}
