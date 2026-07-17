// Tiện ích đọc/ghi bytes dùng chung.

export type CleanerErrorCode = 'empty' | 'unsupported' | 'truncated' | 'corrupt';

export class CleanerError extends Error {
  constructor(
    public code: CleanerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CleanerError';
  }
}

export function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

export function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function asciiAt(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

export function startsWithAscii(b: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) {
    if (b[o + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

export function concatParts(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Bảng CRC32 chuẩn (đa thức 0xEDB88320) — dùng cho chunk PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const latin1Decoder = new TextDecoder('latin1');
const utf8Decoder = new TextDecoder('utf-8', {fatal: false});

export function decodeLatin1(b: Uint8Array): string {
  return latin1Decoder.decode(b);
}

export function decodeUtf8(b: Uint8Array): string {
  return utf8Decoder.decode(b);
}
