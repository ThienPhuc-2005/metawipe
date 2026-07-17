// Bộ sinh file mẫu (fixture) cho unit test: dựng file JPEG/PNG hợp lệ TỪNG BYTE
// với metadata biết trước (GPS giả, tên tác giả, serial máy...). Không cần exiftool.
//
// File JPEG sinh ra là ảnh baseline 1x1 giải mã được thật; file PNG là ảnh xám 1x1
// với chunk IDAT nén zlib chuẩn — trình duyệt và exifr đều đọc được.

import {zlibSync, zipSync as fflateZipSync} from 'fflate';
import {concatParts} from '../src/lib/binary';

// ---------------------------------------------------------------- tiện ích chung

export function latin1Encode(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

export const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);

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

function u16beBytes(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u32beBytes(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

// ------------------------------------------------------- bộ dựng TIFF/EXIF (IFD)

type TiffType = 'BYTE' | 'ASCII' | 'SHORT' | 'LONG' | 'RATIONAL';
const TYPE_CODE: Record<TiffType, number> = {BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5};

export interface TiffEntry {
  tag: number;
  type: TiffType;
  /** ASCII: string; RATIONAL: mảng cặp [tử, mẫu]; còn lại: mảng số. */
  value: string | number[] | Array<[number, number]>;
}

function entryCount(e: TiffEntry): number {
  if (e.type === 'ASCII') return (e.value as string).length + 1;
  return (e.value as unknown[]).length;
}

function entryByteLen(e: TiffEntry): number {
  const n = entryCount(e);
  switch (e.type) {
    case 'BYTE':
    case 'ASCII':
      return n;
    case 'SHORT':
      return n * 2;
    case 'LONG':
      return n * 4;
    case 'RATIONAL':
      return n * 8;
  }
}

const pad2 = (n: number) => n + (n % 2);

function ifdBlockSize(entries: TiffEntry[]): number {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) {
    const len = entryByteLen(e);
    if (len > 4) size += pad2(len);
  }
  return size;
}

function writeEntryValue(bytes: Uint8Array, pos: number, e: TiffEntry, little: boolean): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  if (e.type === 'ASCII') {
    const s = e.value as string;
    for (let i = 0; i < s.length; i++) bytes[pos + i] = s.charCodeAt(i) & 0xff;
    bytes[pos + s.length] = 0;
    return;
  }
  if (e.type === 'RATIONAL') {
    const pairs = e.value as Array<[number, number]>;
    pairs.forEach(([num, den], i) => {
      dv.setUint32(pos + i * 8, num, little);
      dv.setUint32(pos + i * 8 + 4, den, little);
    });
    return;
  }
  const nums = e.value as number[];
  nums.forEach((v, i) => {
    if (e.type === 'BYTE') bytes[pos + i] = v & 0xff;
    else if (e.type === 'SHORT') dv.setUint16(pos + i * 2, v, little);
    else dv.setUint32(pos + i * 4, v, little);
  });
}

function writeIfd(bytes: Uint8Array, offset: number, entries: TiffEntry[], little: boolean): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  dv.setUint16(offset, sorted.length, little);
  let entryPos = offset + 2;
  let valuePos = offset + 2 + sorted.length * 12 + 4;
  for (const e of sorted) {
    dv.setUint16(entryPos, e.tag, little);
    dv.setUint16(entryPos + 2, TYPE_CODE[e.type], little);
    dv.setUint32(entryPos + 4, entryCount(e), little);
    const len = entryByteLen(e);
    if (len <= 4) {
      writeEntryValue(bytes, entryPos + 8, e, little);
    } else {
      dv.setUint32(entryPos + 8, valuePos, little);
      writeEntryValue(bytes, valuePos, e, little);
      valuePos += pad2(len);
    }
    entryPos += 12;
  }
  dv.setUint32(offset + 2 + sorted.length * 12, 0, little); // không có IFD kế tiếp
}

export interface ExifFixtureOpts {
  /** Thứ tự byte TIFF: 'II' little-endian (mặc định) hoặc 'MM' big-endian như iPhone. */
  endian?: 'II' | 'MM';
  orientation?: number;
  make?: string;
  model?: string;
  software?: string;
  artist?: string;
  dateTime?: string;
  /** Toạ độ GPS: [độ, phút, giây×10] với mẫu số [1,1,10]. */
  gps?: {lat: [number, number, number]; latRef: 'N' | 'S'; lon: [number, number, number]; lonRef: 'E' | 'W'};
  serial?: string;
  copyright?: string;
  /** Thêm IFD1 (thumbnail) chứa một JPEG nhúng qua tag 513/514. */
  thumbnail?: boolean;
}

/** Dựng nguyên khối TIFF (little-endian) chứa IFD0 + Exif IFD + GPS IFD. */
export function buildTiffExif(opts: ExifFixtureOpts): Uint8Array {
  const ifd0: TiffEntry[] = [];
  if (opts.make) ifd0.push({tag: 0x010f, type: 'ASCII', value: opts.make});
  if (opts.model) ifd0.push({tag: 0x0110, type: 'ASCII', value: opts.model});
  if (opts.orientation) ifd0.push({tag: 0x0112, type: 'SHORT', value: [opts.orientation]});
  if (opts.software) ifd0.push({tag: 0x0131, type: 'ASCII', value: opts.software});
  if (opts.dateTime) ifd0.push({tag: 0x0132, type: 'ASCII', value: opts.dateTime});
  if (opts.artist) ifd0.push({tag: 0x013b, type: 'ASCII', value: opts.artist});
  if (opts.copyright) ifd0.push({tag: 0x8298, type: 'ASCII', value: opts.copyright});

  const exifIfd: TiffEntry[] = [];
  if (opts.serial) exifIfd.push({tag: 0xa431, type: 'ASCII', value: opts.serial});
  if (opts.dateTime) exifIfd.push({tag: 0x9003, type: 'ASCII', value: opts.dateTime});

  const gpsIfd: TiffEntry[] = [];
  if (opts.gps) {
    const toRat = (v: [number, number, number]): Array<[number, number]> => [
      [v[0], 1],
      [v[1], 1],
      [v[2], 10],
    ];
    gpsIfd.push({tag: 0x0000, type: 'BYTE', value: [2, 3, 0, 0]});
    gpsIfd.push({tag: 0x0001, type: 'ASCII', value: opts.gps.latRef});
    gpsIfd.push({tag: 0x0002, type: 'RATIONAL', value: toRat(opts.gps.lat)});
    gpsIfd.push({tag: 0x0003, type: 'ASCII', value: opts.gps.lonRef});
    gpsIfd.push({tag: 0x0004, type: 'RATIONAL', value: toRat(opts.gps.lon)});
  }

  // IFD0 chứa con trỏ tới Exif IFD / GPS IFD — kích thước tính được trước giá trị
  const ifd0Full: TiffEntry[] = [...ifd0];
  if (exifIfd.length) ifd0Full.push({tag: 0x8769, type: 'LONG', value: [0]});
  if (gpsIfd.length) ifd0Full.push({tag: 0x8825, type: 'LONG', value: [0]});

  const size0 = ifdBlockSize(ifd0Full);
  const offExif = 8 + size0;
  const sizeExif = exifIfd.length ? ifdBlockSize(exifIfd) : 0;
  const offGps = offExif + sizeExif;
  const sizeGps = gpsIfd.length ? ifdBlockSize(gpsIfd) : 0;

  const ifd0Final: TiffEntry[] = [...ifd0];
  if (exifIfd.length) ifd0Final.push({tag: 0x8769, type: 'LONG', value: [offExif]});
  if (gpsIfd.length) ifd0Final.push({tag: 0x8825, type: 'LONG', value: [offGps]});

  const little = (opts.endian ?? 'II') === 'II';

  // IFD1 (thumbnail): 2 entry LONG trỏ tới một JPEG tí hon nhúng cuối khối
  const thumbJpeg = opts.thumbnail ? buildJpeg({jfif: true}) : null;
  const offIfd1 = 8 + size0 + sizeExif + sizeGps;
  const sizeIfd1 = thumbJpeg ? 2 + 2 * 12 + 4 : 0;
  const thumbDataOff = offIfd1 + sizeIfd1;

  const total = 8 + size0 + sizeExif + sizeGps + sizeIfd1 + (thumbJpeg?.length ?? 0);
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  bytes[0] = little ? 0x49 : 0x4d;
  bytes[1] = bytes[0];
  dv.setUint16(2, 42, little);
  dv.setUint32(4, 8, little);
  writeIfd(bytes, 8, ifd0Final, little);
  if (exifIfd.length) writeIfd(bytes, offExif, exifIfd, little);
  if (gpsIfd.length) writeIfd(bytes, offGps, gpsIfd, little);
  if (thumbJpeg) {
    // Vá con trỏ "IFD kế tiếp" của IFD0 để trỏ sang IFD1
    dv.setUint32(8 + 2 + ifd0Final.length * 12, offIfd1, little);
    writeIfd(
      bytes,
      offIfd1,
      [
        {tag: 0x0201, type: 'LONG', value: [thumbDataOff]}, // JPEGInterchangeFormat
        {tag: 0x0202, type: 'LONG', value: [thumbJpeg.length]},
      ],
      little,
    );
    bytes.set(thumbJpeg, thumbDataOff);
  }
  return bytes;
}

export interface TiffImageFixtureOpts extends ExifFixtureOpts {
  /** Số trang ảnh (multi-page TIFF). */
  pages?: number;
  /** Gói XMP nhúng vào tag 700. */
  xmp?: string;
  /** Giả lập TIFF nén JPEG kiểu cũ: Compression=6 (kiểu LONG) + tag bảng 519. */
  oldStyleJpeg?: boolean;
}

/** Dựng một FILE TIFF hoàn chỉnh: ảnh xám 1x1 không nén + metadata tuỳ chọn. */
export function buildTiffImage(opts: TiffImageFixtureOpts = {}): Uint8Array {
  const little = (opts.endian ?? 'II') === 'II';
  const nPages = Math.max(1, opts.pages ?? 1);

  // Mỗi trang: IFD + 1 byte dữ liệu strip. Tính layout tuần tự.
  const pageEntries = (stripOff: number): TiffEntry[] => {
    const entries: TiffEntry[] = [
      {tag: 256, type: 'SHORT', value: [1]}, // ImageWidth
      {tag: 257, type: 'SHORT', value: [1]}, // ImageLength
      {tag: 258, type: 'SHORT', value: [8]}, // BitsPerSample
      {tag: 259, type: 'SHORT', value: [1]}, // Compression = none
      {tag: 262, type: 'SHORT', value: [1]}, // Photometric = BlackIsZero
      {tag: 273, type: 'LONG', value: [stripOff]}, // StripOffsets
      {tag: 277, type: 'SHORT', value: [1]}, // SamplesPerPixel
      {tag: 278, type: 'SHORT', value: [1]}, // RowsPerStrip
      {tag: 279, type: 'LONG', value: [1]}, // StripByteCounts
      {tag: 282, type: 'RATIONAL', value: [[72, 1]]}, // XResolution
      {tag: 283, type: 'RATIONAL', value: [[72, 1]]}, // YResolution
      {tag: 296, type: 'SHORT', value: [2]}, // ResolutionUnit
    ];
    if (opts.make) entries.push({tag: 0x010f, type: 'ASCII', value: opts.make});
    if (opts.model) entries.push({tag: 0x0110, type: 'ASCII', value: opts.model});
    if (opts.orientation) entries.push({tag: 0x0112, type: 'SHORT', value: [opts.orientation]});
    if (opts.software) entries.push({tag: 0x0131, type: 'ASCII', value: opts.software});
    if (opts.dateTime) entries.push({tag: 0x0132, type: 'ASCII', value: opts.dateTime});
    if (opts.artist) entries.push({tag: 0x013b, type: 'ASCII', value: opts.artist});
    if (opts.copyright) entries.push({tag: 0x8298, type: 'ASCII', value: opts.copyright});
    if (opts.xmp) entries.push({tag: 700, type: 'BYTE', value: Array.from(utf8Encode(opts.xmp))});
    if (opts.oldStyleJpeg) {
      const i = entries.findIndex(e => e.tag === 259);
      entries[i] = {tag: 259, type: 'LONG', value: [6]};
      entries.push({tag: 519, type: 'LONG', value: [0]}); // JPEGQTables — offset không độ dài
    }
    return entries;
  };

  // GPS IFD (chỉ gắn vào trang đầu)
  const gpsIfd: TiffEntry[] = [];
  if (opts.gps) {
    const toRat = (v: [number, number, number]): Array<[number, number]> => [
      [v[0], 1],
      [v[1], 1],
      [v[2], 10],
    ];
    gpsIfd.push({tag: 0x0000, type: 'BYTE', value: [2, 3, 0, 0]});
    gpsIfd.push({tag: 0x0001, type: 'ASCII', value: opts.gps.latRef});
    gpsIfd.push({tag: 0x0002, type: 'RATIONAL', value: toRat(opts.gps.lat)});
    gpsIfd.push({tag: 0x0003, type: 'ASCII', value: opts.gps.lonRef});
    gpsIfd.push({tag: 0x0004, type: 'RATIONAL', value: toRat(opts.gps.lon)});
  }

  // Tính layout: [header][trang 0: IFD + gps? + strip][trang 1: IFD + strip]...
  let cursor = 8;
  const pagePlans: Array<{ifdOff: number; gpsOff: number; stripOff: number; entries: TiffEntry[]}> = [];
  for (let p = 0; p < nPages; p++) {
    const withGps = p === 0 && gpsIfd.length > 0;
    const baseEntries = pageEntries(0); // strip offset vá sau khi biết layout
    const full: TiffEntry[] = [...baseEntries];
    if (withGps) full.push({tag: 0x8825, type: 'LONG', value: [0]});
    const ifdOff = cursor;
    cursor += ifdBlockSize(full);
    const gpsOff = withGps ? cursor : 0;
    if (withGps) cursor += ifdBlockSize(gpsIfd);
    const stripOff = cursor;
    cursor += 2; // 1 byte strip + 1 byte đệm chẵn
    pagePlans.push({ifdOff, gpsOff, stripOff, entries: full});
  }

  const bytes = new Uint8Array(cursor);
  const dv = new DataView(bytes.buffer);
  bytes[0] = little ? 0x49 : 0x4d;
  bytes[1] = bytes[0];
  dv.setUint16(2, 42, little);
  dv.setUint32(4, pagePlans[0].ifdOff, little);

  pagePlans.forEach((plan, p) => {
    const entries = plan.entries.map(e => {
      if (e.tag === 273) return {...e, value: [plan.stripOff]};
      if (e.tag === 0x8825) return {...e, value: [plan.gpsOff]};
      return e;
    });
    writeIfd(bytes, plan.ifdOff, entries, little);
    if (plan.gpsOff) writeIfd(bytes, plan.gpsOff, gpsIfd, little);
    bytes[plan.stripOff] = 0x80; // pixel xám
    // nối chuỗi trang: vá con trỏ next-IFD
    if (p + 1 < pagePlans.length) {
      dv.setUint32(plan.ifdOff + 2 + entries.length * 12, pagePlans[p + 1].ifdOff, little);
    }
  });
  return bytes;
}

/** GPS giả đặt tại Hà Nội (21.0285, 105.8542) — dùng chung cho các test. */
export const HANOI_GPS: NonNullable<ExifFixtureOpts['gps']> = {
  lat: [21, 1, 426], // 21° 1' 42.6" N ≈ 21.0285
  latRef: 'N',
  lon: [105, 51, 151], // 105° 51' 15.1" E ≈ 105.8542
  lonRef: 'E',
};

// ---------------------------------------------------------------- ICC / XMP / IPTC

export function fakeIccProfile(): Uint8Array {
  const b = new Uint8Array(132);
  const dv = new DataView(b.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
  };
  dv.setUint32(0, 132); // kích thước profile
  ascii(4, 'ADBE'); // CMM
  dv.setUint32(8, 0x02100000); // phiên bản 2.1
  ascii(12, 'mntr'); // loại thiết bị
  ascii(16, 'RGB '); // không gian màu
  ascii(20, 'XYZ '); // PCS
  ascii(36, 'acsp'); // chữ ký bắt buộc
  ascii(40, 'MSFT'); // nền tảng
  dv.setUint32(128, 0); // 0 tag
  return b;
}

export function xmpPacket(
  creator = 'Nguyễn Văn A',
  tool = 'MetaWipe TestTool 1.0',
  extra: {gps?: boolean} = {},
): string {
  // GPS trong XMP xuất hiện cả 2 dạng: thuộc tính và phần tử — test phải phủ cả hai
  const gpsAttrs = extra.gps
    ? ' xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="21,1.71N" exif:GPSLongitude="105,51.25E"'
    : '';
  const gpsElems = extra.gps
    ? '<exif:GPSAltitude>10/1</exif:GPSAltitude><exif:GPSAltitudeRef>0</exif:GPSAltitudeRef>'
    : '';
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about=""' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"' +
    gpsAttrs +
    ` xmp:CreatorTool="${tool}">` +
    `<dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator>` +
    gpsElems +
    '</rdf:Description></rdf:RDF></x:xmpmeta>' +
    '<?xpacket end="w"?>'
  );
}

/** Payload APP13 Photoshop chứa IPTC IIM (By-line, City, Caption). */
export function buildIptcApp13(byline = 'Nguyen Van A', city = 'Hanoi'): Uint8Array {
  const record = (dataset: number, value: Uint8Array): Uint8Array =>
    concatParts([new Uint8Array([0x1c, 2, dataset]), u16beBytes(value.length), value]);

  const iptc = concatParts([
    record(0, new Uint8Array([0, 2])), // phiên bản IIM
    record(80, latin1Encode(byline)), // 2:80 By-line (tác giả)
    record(90, latin1Encode(city)), // 2:90 City
    record(120, latin1Encode('Anh chup thu nghiem')), // 2:120 Caption
  ]);

  const block = concatParts([
    latin1Encode('8BIM'),
    u16beBytes(0x0404), // resource ID của IPTC
    new Uint8Array([0, 0]), // tên rỗng (pascal string, đệm chẵn)
    u32beBytes(iptc.length),
    iptc,
    iptc.length % 2 ? new Uint8Array([0]) : new Uint8Array(0),
  ]);
  return concatParts([latin1Encode('Photoshop 3.0\0'), block]);
}

// ---------------------------------------------------------------- bộ dựng JPEG

function jpegSeg(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concatParts([new Uint8Array([0xff, marker]), u16beBytes(len), payload]);
}

function jfifApp0(withThumbnail = false): Uint8Array {
  return jpegSeg(
    0xe0,
    concatParts([
      latin1Encode('JFIF\0'),
      new Uint8Array([1, 1, 0]),
      u16beBytes(1),
      u16beBytes(1),
      withThumbnail
        ? new Uint8Array([1, 1, 0xaa, 0xbb, 0xcc]) // thumbnail RGB 1×1 nhúng trong header
        : new Uint8Array([0, 0]),
    ]),
  );
}

function jfxxApp0(): Uint8Array {
  return jpegSeg(0xe0, concatParts([latin1Encode('JFXX\0'), new Uint8Array([0x11, 1, 1, 0x00])]));
}

function adobeApp14(): Uint8Array {
  return jpegSeg(
    0xee,
    concatParts([latin1Encode('Adobe'), new Uint8Array([0, 100, 0, 0, 0, 0, 0])]),
  );
}

function dqt(): Uint8Array {
  const table = new Uint8Array(65);
  table[0] = 0x00;
  table.fill(16, 1);
  return jpegSeg(0xdb, table);
}

function sof0(): Uint8Array {
  // 8 bit, cao 1, rộng 1, 1 thành phần (xám), lấy mẫu 1x1, bảng lượng tử 0
  return jpegSeg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 0x01, 0x11, 0x00]));
}

function dht(acTable: boolean): Uint8Array {
  // Bảng Huffman tối giản: đúng 1 mã dài 1 bit → ký hiệu 0x00
  const p = new Uint8Array(1 + 16 + 1);
  p[0] = acTable ? 0x10 : 0x00;
  p[1] = 1; // 1 mã có độ dài 1 bit
  p[17] = 0x00;
  return jpegSeg(0xc4, p);
}

function sos(): Uint8Array {
  return jpegSeg(0xda, new Uint8Array([1, 1, 0x00, 0, 63, 0]));
}

// 1 MCU: DC hạng 0 (bit '0') + AC EOB (bit '0') → '00' đệm 1 thành 0x3F
const ENTROPY = new Uint8Array([0x3f]);

export interface JpegFixtureOpts {
  jfif?: boolean;
  /** JFIF header có thumbnail RGB nhúng (payload > 14 byte). */
  jfifThumbnail?: boolean;
  jfxx?: boolean;
  exif?: ExifFixtureOpts;
  xmp?: boolean | string;
  /** Số phần XMP mở rộng (mỗi phần một segment APP1 riêng). */
  extendedXmpParts?: number;
  iptc?: boolean;
  icc?: boolean;
  /** ICC profile trải trên nhiều segment APP2 (profile >64KB ngoài đời). */
  iccParts?: number;
  adobe14?: boolean;
  /** Chèn segment DAC (0xCC — bảng mã hoá số học) TRƯỚC SOF, hợp lệ theo T.81. */
  dac?: boolean;
  comment?: string;
  /** Tạo file 2 lượt quét (giả progressive) có FF00 + marker RST trong dữ liệu nén. */
  multiScan?: boolean;
  commentBetweenScans?: string;
  trailing?: Uint8Array;
}

export function buildJpeg(opts: JpegFixtureOpts = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];

  if (opts.jfif !== false) parts.push(jfifApp0(opts.jfifThumbnail));
  if (opts.jfxx) parts.push(jfxxApp0());
  if (opts.exif) {
    parts.push(jpegSeg(0xe1, concatParts([latin1Encode('Exif\0\0'), buildTiffExif(opts.exif)])));
  }
  if (opts.xmp) {
    const packet = typeof opts.xmp === 'string' ? opts.xmp : xmpPacket();
    parts.push(
      jpegSeg(0xe1, concatParts([latin1Encode('http://ns.adobe.com/xap/1.0/\0'), utf8Encode(packet)])),
    );
  }
  if (opts.extendedXmpParts) {
    const guid = 'A'.repeat(32);
    const chunk = latin1Encode('<extended-xmp-part/>'.repeat(3));
    const total = chunk.length * opts.extendedXmpParts;
    for (let i = 0; i < opts.extendedXmpParts; i++) {
      parts.push(
        jpegSeg(
          0xe1,
          concatParts([
            latin1Encode('http://ns.adobe.com/xmp/extension/\0'),
            latin1Encode(guid),
            u32beBytes(total),
            u32beBytes(i * chunk.length),
            chunk,
          ]),
        ),
      );
    }
  }
  if (opts.icc) {
    parts.push(
      jpegSeg(0xe2, concatParts([latin1Encode('ICC_PROFILE\0'), new Uint8Array([1, 1]), fakeIccProfile()])),
    );
  }
  if (opts.iccParts && opts.iccParts > 1) {
    const profile = fakeIccProfile();
    const n = opts.iccParts;
    const chunkSize = Math.ceil(profile.length / n);
    for (let i = 0; i < n; i++) {
      parts.push(
        jpegSeg(
          0xe2,
          concatParts([
            latin1Encode('ICC_PROFILE\0'),
            new Uint8Array([i + 1, n]),
            profile.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, profile.length)),
          ]),
        ),
      );
    }
  }
  if (opts.iptc) parts.push(jpegSeg(0xed, buildIptcApp13()));
  if (opts.adobe14) parts.push(adobeApp14());
  if (opts.comment) parts.push(jpegSeg(0xfe, latin1Encode(opts.comment)));

  if (opts.dac) parts.push(jpegSeg(0xcc, new Uint8Array([0x00, 0x10])));
  parts.push(dqt(), sof0(), dht(false), dht(true), sos());

  if (opts.multiScan) {
    // Dữ liệu nén có byte chèn FF00 và marker restart FFD0 — thử thách bộ dò marker
    parts.push(new Uint8Array([0x3f, 0xff, 0x00, 0xff, 0xd0, 0x3f]));
    parts.push(dht(false));
    if (opts.commentBetweenScans) parts.push(jpegSeg(0xfe, latin1Encode(opts.commentBetweenScans)));
    parts.push(sos(), ENTROPY);
  } else {
    parts.push(ENTROPY);
  }

  parts.push(new Uint8Array([0xff, 0xd9]));
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}

// ---------------------------------------------------------------- bộ dựng WebP

function webpChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  for (let i = 0; i < 4; i++) head[i] = fourcc.charCodeAt(i);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, payload.length, true);
  const parts = [head, payload];
  if (payload.length % 2 === 1) parts.push(new Uint8Array([0]));
  return concatParts(parts);
}

export interface WebpFixtureOpts {
  /** File simple (không VP8X) — chỉ ảnh trần. */
  simple?: boolean;
  icc?: boolean;
  exif?: ExifFixtureOpts;
  /** Payload EXIF kèm tiền tố 'Exif\0\0' (biến thể gặp ngoài đời). */
  exifWithHeader?: boolean;
  /** Số chunk EXIF (file lỗi có thể chứa nhiều). */
  exifCount?: number;
  xmp?: boolean | string;
  anim?: boolean;
  unknownChunk?: boolean;
  trailing?: Uint8Array;
}

/** Dựng file WebP: VP8L giả 1×1 (parser coi là khối mờ) + chunk metadata tuỳ chọn. */
export function buildWebp(opts: WebpFixtureOpts = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const hasExif = !!opts.exif;
  const hasXmp = !!opts.xmp;

  if (!opts.simple) {
    const flags =
      (opts.icc ? 0x20 : 0) | (hasExif ? 0x08 : 0) | (hasXmp ? 0x04 : 0) | (opts.anim ? 0x02 : 0);
    // canvas 1×1: width-1 = 0, height-1 = 0 (u24 LE)
    chunks.push(webpChunk('VP8X', new Uint8Array([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  }
  if (opts.icc) chunks.push(webpChunk('ICCP', fakeIccProfile()));
  if (opts.anim) {
    chunks.push(webpChunk('ANIM', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0])));
  }
  // VP8L 1×1: chữ ký 0x2F + 28 bit kích thước (0,0) — payload 5 byte LẺ để test pad byte
  chunks.push(webpChunk('VP8L', new Uint8Array([0x2f, 0, 0, 0, 0])));

  for (let i = 0; i < (hasExif ? (opts.exifCount ?? 1) : 0); i++) {
    const tiff = buildTiffExif(opts.exif!);
    const payload = opts.exifWithHeader
      ? concatParts([latin1Encode('Exif\0\0'), tiff])
      : tiff;
    chunks.push(webpChunk('EXIF', payload));
  }
  if (hasXmp) {
    const packet = typeof opts.xmp === 'string' ? opts.xmp : xmpPacket();
    chunks.push(webpChunk('XMP ', utf8Encode(packet)));
  }
  if (opts.unknownChunk) chunks.push(webpChunk('MSIR', latin1Encode('secret-tracker-999')));

  const body = concatParts(chunks);
  const header = new Uint8Array(12);
  header.set(latin1Encode('RIFF'));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(latin1Encode('WEBP'), 8);
  const parts = [header, body];
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}

// ---------------------------------------------------------------- bộ dựng GIF

// GIF 1×1 hợp lệ nổi tiếng (điểm ảnh trong suốt) — giải mã được trong mọi trình duyệt
const GIF_1PX_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Trailer thần kỳ 258 byte của XMP-trong-GIF (0x01 + đếm ngược 255..0 + terminator). */
export function gifXmpTrailer(): Uint8Array {
  const t = new Uint8Array(258);
  t[0] = 0x01;
  for (let i = 0; i < 256; i++) t[1 + i] = 255 - i;
  t[257] = 0x00;
  return t;
}

export interface GifFixtureOpts {
  /** Chèn một GCE đứng TRƯỚC các comment (test GCE mồ côi khi comment bị xoá). */
  gceBeforeComments?: boolean;
  comments?: string[];
  xmp?: boolean | string;
  /** XMP ghi SAI chuẩn: thiếu magic trailer (một số tool ngoài đời làm vậy). */
  xmpNoTrailer?: boolean;
  netscape?: boolean;
  /** Application extension lạ (có thể chứa tracking). */
  appExt?: boolean;
  /** Cặp GCE + Plain Text extension. */
  plainText?: boolean;
  trailing?: Uint8Array;
}

/** Dựng GIF 1×1 thật + chèn các extension tuỳ chọn ngay sau bảng màu. */
export function buildGif(opts: GifFixtureOpts = {}): Uint8Array {
  const base = b64ToBytes(GIF_1PX_B64);
  const HEAD_END = 6 + 7 + 6; // header + LSD + GCT 2 màu
  const ext: Uint8Array[] = [];

  if (opts.netscape) {
    ext.push(
      concatParts([
        new Uint8Array([0x21, 0xff, 0x0b]),
        latin1Encode('NETSCAPE2.0'),
        new Uint8Array([0x03, 0x01, 0x00, 0x00, 0x00]),
      ]),
    );
  }
  if (opts.gceBeforeComments) {
    ext.push(new Uint8Array([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
  for (const c of opts.comments ?? []) {
    const text = latin1Encode(c.slice(0, 255));
    ext.push(
      concatParts([new Uint8Array([0x21, 0xfe, text.length]), text, new Uint8Array([0x00])]),
    );
  }
  if (opts.xmp) {
    const packet = utf8Encode(typeof opts.xmp === 'string' ? opts.xmp : xmpPacket());
    ext.push(
      concatParts([
        new Uint8Array([0x21, 0xff, 0x0b]),
        latin1Encode('XMP DataXMP'),
        packet,
        opts.xmpNoTrailer ? new Uint8Array([0x00]) : gifXmpTrailer(),
      ]),
    );
  }
  if (opts.appExt) {
    ext.push(
      concatParts([
        new Uint8Array([0x21, 0xff, 0x0b]),
        latin1Encode('TRACKAPP1.0'),
        new Uint8Array([0x04]),
        latin1Encode('data'),
        new Uint8Array([0x00]),
      ]),
    );
  }
  if (opts.plainText) {
    ext.push(new Uint8Array([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00])); // GCE đi kèm
    ext.push(
      concatParts([
        new Uint8Array([0x21, 0x01, 0x0c, 0, 0, 0, 0, 1, 0, 1, 0, 8, 8, 1, 0]),
        new Uint8Array([0x05]),
        latin1Encode('hello'),
        new Uint8Array([0x00]),
      ]),
    );
  }

  const parts = [base.subarray(0, HEAD_END), ...ext, base.subarray(HEAD_END)];
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}

// ---------------------------------------------------------------- bộ dựng MP4

function mp4Box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concatParts(parts);
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(payload, 8);
  return out;
}

function mp4FullBoxPayload(version: number, body: Uint8Array): Uint8Array {
  return concatParts([new Uint8Array([version, 0, 0, 0]), body]);
}

function u32Seq(...vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 4);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v));
  return b;
}

/** mvhd v0: creation/modification/timescale/duration + rate/volume/matrix... */
function mvhdBox(creation: number, version1 = false): Uint8Array {
  if (version1) {
    const body = new Uint8Array(108);
    const dv = new DataView(body.buffer);
    dv.setUint32(4, creation); // creation u64 (hi=0, lo=creation)
    dv.setUint32(12, creation); // modification u64
    dv.setUint32(16, 1000); // timescale
    dv.setUint32(28, 0x00010000); // rate (sau duration u64 @20)
    dv.setUint32(104, 2); // next track id
    return mp4Box('mvhd', mp4FullBoxPayload(1, body));
  }
  const body = new Uint8Array(96);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, creation);
  dv.setUint32(4, creation); // modification
  dv.setUint32(8, 1000); // timescale
  dv.setUint32(12, 5000); // duration
  dv.setUint32(16, 0x00010000); // rate
  dv.setUint16(20, 0x0100); // volume
  // matrix identity
  dv.setUint32(32, 0x00010000);
  dv.setUint32(48, 0x00010000);
  dv.setUint32(64, 0x40000000);
  dv.setUint32(92, 2); // next track id
  return mp4Box('mvhd', mp4FullBoxPayload(0, body));
}

function tkhdBox(creation: number): Uint8Array {
  const body = new Uint8Array(80); // v0: 84 byte payload gồm 4 byte ver/flags
  const dv = new DataView(body.buffer);
  dv.setUint32(0, creation);
  dv.setUint32(4, creation);
  dv.setUint32(8, 1); // track id
  dv.setUint32(16, 5000); // duration
  dv.setUint32(36, 0x00010000); // matrix
  dv.setUint32(52, 0x00010000);
  dv.setUint32(68, 0x40000000);
  dv.setUint32(72, 320 << 16); // width 16.16
  dv.setUint32(76, 240 << 16); // height 16.16
  return mp4Box('tkhd', mp4FullBoxPayload(0, body));
}

function mdhdBox(creation: number): Uint8Array {
  const body = new Uint8Array(20);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, creation);
  dv.setUint32(4, creation);
  dv.setUint32(8, 30000); // timescale
  dv.setUint32(12, 150000); // duration
  dv.setUint16(16, 0x55c4); // language 'und'
  return mp4Box('mdhd', mp4FullBoxPayload(0, body));
}

function hdlrBox(handlerType: string, name: string): Uint8Array {
  return mp4Box(
    'hdlr',
    mp4FullBoxPayload(0, concatParts([
      new Uint8Array(4), // pre_defined
      latin1Encode(handlerType),
      new Uint8Array(12), // reserved
      latin1Encode(name),
      new Uint8Array([0]),
    ])),
  );
}

/** Entry © trong udta: [u16 size][u16 lang] + chuỗi. */
function udtaTextBox(type: string, text: string): Uint8Array {
  const body = utf8Encode(text);
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint16(0, body.length);
  new DataView(head.buffer).setUint16(2, 0x15c7); // 'eng'
  return mp4Box(type, head, body);
}

/** moov/meta kiểu Apple (không version/flags): hdlr mdta + keys + ilst chứa location. */
function appleMetaBox(withLocation: boolean): Uint8Array {
  const keyName = withLocation ? 'com.apple.quicktime.location.ISO6709' : 'com.apple.quicktime.model';
  const keyBody = utf8Encode(keyName);
  const keyEntry = concatParts([u32Seq(8 + keyBody.length), latin1Encode('mdta'), keyBody]);
  const keys = mp4Box('keys', mp4FullBoxPayload(0, concatParts([u32Seq(1), keyEntry])));
  const value = utf8Encode(withLocation ? '+21.0285+105.8542+058.900/' : 'TestPhone 15');
  const dataBox = mp4Box('data', u32Seq(1), u32Seq(0), value);
  // entry của ilst: [u32 size][u32 = chỉ số key 1-based] + data box
  const entry = new Uint8Array(8 + dataBox.length);
  new DataView(entry.buffer).setUint32(0, entry.length);
  new DataView(entry.buffer).setUint32(4, 1);
  entry.set(dataBox, 8);
  const ilst = mp4Box('ilst', entry);
  return mp4Box('meta', hdlrBox('mdta', ''), keys, ilst);
}

export interface Mp4FixtureOpts {
  gps?: boolean;
  tool?: string;
  appleMeta?: boolean | {location: boolean};
  trackUdta?: boolean;
  xmpUuid?: boolean;
  /** Packet XMP trong box uuid có chứa GPS (mô phỏng video drone/Premiere). */
  xmpUuidGps?: boolean;
  version1?: boolean;
  /** Thứ tự: mặc định moov trước mdat (faststart). */
  mdatFirst?: boolean;
  /** Thêm 4 byte 0 kết thúc udta (kiểu QuickTime cũ). */
  udtaTerminator?: boolean;
  handlerName?: string;
  trailing?: Uint8Array;
}

export const MP4_CREATION_TIME = 0xd0000000; // ~2014 theo epoch 1904

/** Dựng file MP4 cấu trúc hợp lệ (mdat giả) đủ cho parser + tool metadata. */
export function buildMp4(opts: Mp4FixtureOpts = {}): Uint8Array {
  const ftyp = mp4Box('ftyp', latin1Encode('isom'), u32Seq(0x200), latin1Encode('isommp42'));

  const udtaChildren: Uint8Array[] = [];
  if (opts.gps) udtaChildren.push(udtaTextBox('\xa9xyz', '+21.0285+105.8542/'));
  if (opts.tool) udtaChildren.push(udtaTextBox('\xa9too', opts.tool));
  if (opts.udtaTerminator) udtaChildren.push(new Uint8Array(4));
  const udta = udtaChildren.length ? mp4Box('udta', ...udtaChildren) : null;

  const stco = mp4Box('stco', mp4FullBoxPayload(0, u32Seq(1, 0x99887766)));
  const stbl = mp4Box(
    'stbl',
    mp4Box('stsd', mp4FullBoxPayload(0, u32Seq(0))),
    stco,
  );
  const minf = mp4Box('minf', stbl);
  const mdia = mp4Box(
    'mdia',
    mdhdBox(MP4_CREATION_TIME),
    hdlrBox('vide', opts.handlerName ?? 'Core Media Data Handler'),
    minf,
  );
  const trakChildren = [tkhdBox(MP4_CREATION_TIME), mdia];
  if (opts.trackUdta) trakChildren.push(mp4Box('udta', udtaTextBox('\xa9mak', 'TestMake')));
  const trak = mp4Box('trak', ...trakChildren);

  const moovChildren: Uint8Array[] = [mvhdBox(MP4_CREATION_TIME, opts.version1), trak];
  if (udta) moovChildren.push(udta);
  if (opts.appleMeta) {
    const loc = typeof opts.appleMeta === 'object' ? opts.appleMeta.location : true;
    moovChildren.push(appleMetaBox(loc));
  }
  const moov = mp4Box('moov', ...moovChildren);

  const mdat = mp4Box('mdat', latin1Encode('FAKE-VIDEO-PAYLOAD-1234567890'));

  const parts: Uint8Array[] = [ftyp];
  if (opts.mdatFirst) parts.push(mdat, moov);
  else parts.push(moov, mdat);
  if (opts.xmpUuid || opts.xmpUuidGps) {
    const usertype = new Uint8Array([
      0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
    ]);
    parts.push(mp4Box('uuid', usertype, utf8Encode(xmpPacket('Nguoi Quay', 'DroneCam', {gps: !!opts.xmpUuidGps}))));
  }
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}

// ---------------------------------------------------------------- bộ dựng WebM/AVI

/** Mã hoá EBML ID (đã gồm bit đánh dấu) thành bytes BE. */
function ebmlId(id: number): Uint8Array {
  const len = id <= 0xff ? 1 : id <= 0xffff ? 2 : id <= 0xffffff ? 3 : 4;
  const out = new Uint8Array(len);
  let v = id;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

/** Mã hoá kích thước EBML (VINT) với độ dài tối thiểu. */
function ebmlSize(value: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    if (value <= Math.pow(2, 7 * len) - 2) {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = len - 1; i >= 1; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] = v | (0x80 >> (len - 1));
      return out;
    }
  }
  throw new Error('Giá trị VINT quá lớn');
}

function ebmlEl(id: number, ...payload: Uint8Array[]): Uint8Array {
  const data = concatParts(payload);
  return concatParts([ebmlId(id), ebmlSize(data.length), data]);
}

const ebmlStr = (id: number, s: string): Uint8Array => ebmlEl(id, utf8Encode(s));
const ebmlUint = (id: number, v: number, len: number): Uint8Array => {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return ebmlEl(id, b);
};

export interface WebmFixtureOpts {
  title?: string;
  date?: boolean;
  tags?: Array<[string, string]>;
  muxer?: string;
  /** Cluster khai kích thước "không xác định" (file ghi kiểu streaming/OBS). */
  unknownSizeCluster?: boolean;
}

/** Dựng file WebM cấu trúc hợp lệ (block giả) với metadata biết trước. */
export function buildWebm(opts: WebmFixtureOpts = {}): Uint8Array {
  const header = ebmlEl(
    0x1a45dfa3,
    ebmlUint(0x4286, 1, 1), // EBMLVersion
    ebmlUint(0x42f7, 1, 1), // EBMLReadVersion
    ebmlUint(0x42f2, 4, 1), // EBMLMaxIDLength
    ebmlUint(0x42f3, 8, 1), // EBMLMaxSizeLength
    ebmlStr(0x4282, 'webm'), // DocType
    ebmlUint(0x4287, 4, 1),
    ebmlUint(0x4285, 2, 1),
  );

  const infoChildren: Uint8Array[] = [
    ebmlUint(0x2ad7b1, 1000000, 3), // TimecodeScale
    ebmlStr(0x4d80, opts.muxer ?? 'TestMuxer 1.0'), // MuxingApp
    ebmlStr(0x5741, 'TestWriter 2.0'), // WritingApp
  ];
  if (opts.title) infoChildren.push(ebmlStr(0x7ba9, opts.title));
  if (opts.date) {
    // DateUTC: s64 nano giây kể từ 2001-01-01 — chọn ~2026-04-15
    const ns = BigInt(Date.UTC(2026, 3, 15) - Date.UTC(2001, 0, 1)) * 1000000n;
    const b = new Uint8Array(8);
    let v = ns;
    for (let i = 7; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    infoChildren.push(ebmlEl(0x4461, b));
  }
  const info = ebmlEl(0x1549a966, ...infoChildren);

  const tagEls = (opts.tags ?? []).map(([name, value]) =>
    ebmlEl(
      0x7373, // Tag
      ebmlEl(0x63c0), // Targets rỗng
      ebmlEl(0x67c8, ebmlStr(0x45a3, name), ebmlStr(0x4487, value)), // SimpleTag
    ),
  );
  const tags = tagEls.length ? ebmlEl(0x1254c367, ...tagEls) : null;

  const clusterPayload = concatParts([
    ebmlUint(0xe7, 0, 1), // Timestamp
    ebmlEl(0xa3, latin1Encode('FAKE-WEBM-BLOCK-DATA-1234567890')), // SimpleBlock
  ]);
  const cluster = opts.unknownSizeCluster
    ? concatParts([
        ebmlId(0x1f43b675),
        new Uint8Array([0xff]), // kích thước không xác định (VINT all-ones 1 byte)
        clusterPayload,
      ])
    : ebmlEl(0x1f43b675, clusterPayload);

  const segmentPayload = concatParts([info, ...(tags ? [tags] : []), cluster]);
  const segment = ebmlEl(0x18538067, segmentPayload);
  return concatParts([header, segment]);
}

function aviChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  for (let i = 0; i < 4; i++) head[i] = fourcc.charCodeAt(i);
  new DataView(head.buffer).setUint32(4, payload.length, true);
  const parts = [head, payload];
  if (payload.length % 2 === 1) parts.push(new Uint8Array([0]));
  return concatParts(parts);
}

function aviList(type: string, ...children: Uint8Array[]): Uint8Array {
  return aviChunk('LIST', concatParts([latin1Encode(type), ...children]));
}

export interface AviFixtureOpts {
  software?: string;
  artist?: string;
  date?: string;
  idit?: string;
  streamName?: string;
  /** Thêm đoạn RIFF AVIX nối tiếp (chuẩn OpenDML cho file >1GB). */
  avix?: boolean;
  trailing?: Uint8Array;
}

/** Dựng file AVI cấu trúc hợp lệ (frame giả) với metadata biết trước. */
export function buildAvi(opts: AviFixtureOpts = {}): Uint8Array {
  const avih = new Uint8Array(56);
  const dv = new DataView(avih.buffer);
  dv.setUint32(32, 320, true); // width
  dv.setUint32(36, 240, true); // height

  const strlChildren: Uint8Array[] = [
    aviChunk('strh', new Uint8Array(56)),
    aviChunk('strf', new Uint8Array(40)),
  ];
  if (opts.streamName) strlChildren.push(aviChunk('strn', latin1Encode(opts.streamName + '\0')));
  const hdrlChildren: Uint8Array[] = [aviChunk('avih', avih), aviList('strl', ...strlChildren)];
  if (opts.idit) hdrlChildren.push(aviChunk('IDIT', latin1Encode(opts.idit + '\0')));
  const hdrl = aviList('hdrl', ...hdrlChildren);

  const infoChildren: Uint8Array[] = [];
  if (opts.software) infoChildren.push(aviChunk('ISFT', latin1Encode(opts.software + '\0')));
  if (opts.artist) infoChildren.push(aviChunk('IART', latin1Encode(opts.artist + '\0')));
  if (opts.date) infoChildren.push(aviChunk('ICRD', latin1Encode(opts.date + '\0')));
  const info = infoChildren.length ? aviList('INFO', ...infoChildren) : null;

  const movi = aviList('movi', aviChunk('00dc', latin1Encode('FAKE-AVI-FRAME-DATA-1234567890')));
  const idx1 = aviChunk('idx1', new Uint8Array(16));

  const body = concatParts([
    latin1Encode('AVI '),
    hdrl,
    ...(info ? [info] : []),
    movi,
    idx1,
  ]);
  const header = new Uint8Array(8);
  header.set(latin1Encode('RIFF'));
  new DataView(header.buffer).setUint32(4, body.length, true);
  const parts = [header, body];
  if (opts.avix) {
    // Đoạn RIFF AVIX (OpenDML): chứa movi thứ hai — là VIDEO THẬT, không phải rác
    const avixBody = concatParts([
      latin1Encode('AVIX'),
      aviList('movi', aviChunk('00dc', latin1Encode('SECOND-SEGMENT-FRAME-DATA'))),
    ]);
    const avixHeader = new Uint8Array(8);
    avixHeader.set(latin1Encode('RIFF'));
    new DataView(avixHeader.buffer).setUint32(4, avixBody.length, true);
    parts.push(avixHeader, avixBody);
  }
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}

// ---------------------------------------------------------------- bộ dựng Office

export interface DocxFixtureOpts {
  creator?: string;
  lastModifiedBy?: string;
  company?: string;
  totalTime?: string;
  custom?: boolean;
  comments?: Array<{author: string; text: string}>;
  trackedAuthor?: string;
  people?: boolean;
  /** Tracked change nằm trong word/header1.xml (không phải document.xml). */
  headerTrackedAuthor?: string;
  /** Target của Relationship custom.xml: 'absolute' (/docProps) hoặc nháy đơn. */
  relStyle?: 'relative' | 'absolute' | 'singlequote';
}

/** Dựng file DOCX tối thiểu hợp lệ với metadata biết trước. */
export function buildDocx(opts: DocxFixtureOpts = {}): Uint8Array {
  const hasComments = (opts.comments ?? []).length > 0;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    (opts.custom
      ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'
      : '') +
    (hasComments
      ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
      : '') +
    (opts.people
      ? '<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>'
      : '') +
    '</Types>';

  // Relationship custom.xml có thể ghi theo nhiều kiểu hợp lệ khác nhau
  const customRel =
    opts.relStyle === 'absolute'
      ? '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="/docProps/custom.xml"/>'
      : opts.relStyle === 'singlequote'
        ? "<Relationship Id='rId4' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties' Target='docProps/custom.xml'/>"
        : '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    (opts.custom ? customRel : '') +
    '</Relationships>';

  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>${opts.creator ?? 'Nguyen Van A'}</dc:creator>` +
    `<cp:lastModifiedBy>${opts.lastModifiedBy ?? 'Tran Thi B'}</cp:lastModifiedBy>` +
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-04-15T10:20:30Z</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-04-16T08:00:00Z</dcterms:modified>' +
    '<cp:revision>7</cp:revision>' +
    '</cp:coreProperties>';

  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVT">' +
    '<Application>Microsoft Office Word</Application>' +
    `<Company>${opts.company ?? 'Cong ty TNHH Test'}</Company>` +
    `<TotalTime>${opts.totalTime ?? '95'}</TotalTime>` +
    '</Properties>';

  const tracked = opts.trackedAuthor
    ? `<w:ins w:id="1" w:author="${opts.trackedAuthor}" w:date="2026-04-15T10:00:00Z"><w:r><w:t>them vao</w:t></w:r></w:ins>`
    : '';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>Noi dung van ban giu nguyen.</w:t></w:r>${tracked}</w:p></w:body></w:document>`;

  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': utf8Encode(contentTypes),
    '_rels/.rels': utf8Encode(rootRels),
    'word/document.xml': utf8Encode(document),
    'docProps/core.xml': utf8Encode(core),
    'docProps/app.xml': utf8Encode(app),
  };
  if (opts.custom) {
    entries['docProps/custom.xml'] = utf8Encode(
      '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties">' +
        '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MaNhanVien"><vt:lpwstr xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVT">NV-007</vt:lpwstr></property></Properties>',
    );
  }
  if (hasComments) {
    const body = (opts.comments ?? [])
      .map(
        (c, i) =>
          `<w:comment w:id="${i}" w:author="${c.author}" w:initials="${c.author.slice(0, 2)}" w:date="2026-04-15T10:00:00Z">` +
          `<w:p><w:r><w:t>${c.text}</w:t></w:r></w:p></w:comment>`,
      )
      .join('');
    entries['word/comments.xml'] =
      utf8Encode(
        '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          body +
          '</w:comments>',
      );
  }
  if (opts.people) {
    entries['word/people.xml'] = utf8Encode(
      '<?xml version="1.0"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">' +
        '<w15:person w15:author="Nguyen Van A"><w15:presenceInfo w15:providerId="AD" w15:userId="S::a@test.vn::guid"/></w15:person></w15:people>',
    );
  }
  if (opts.headerTrackedAuthor) {
    entries['word/header1.xml'] = utf8Encode(
      '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:p><w:ins w:id="9" w:author="${opts.headerTrackedAuthor}" w:date="2026-04-15T10:00:00Z">` +
        '<w:r><w:t>sua header</w:t></w:r></w:ins></w:p></w:hdr>',
    );
  }
  const zipEntries: Record<string, [Uint8Array, {level: 6}]> = {};
  for (const [k, v] of Object.entries(entries)) zipEntries[k] = [v, {level: 6}];
  return fflateZipSync(zipEntries);
}

/** Dựng PPTX modern comments (Office 365): tác giả ở ppt/authors.xml. */
export function buildPptxModern(author = 'Nguyen Van A'): Uint8Array {
  const p188 = 'http://schemas.microsoft.com/office/powerpoint/2018/8/main';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/ppt/authors.xml" ContentType="application/vnd.ms-powerpoint.authors+xml"/>' +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  const core =
    '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Nguoi Tao</dc:creator></cp:coreProperties>';
  const app =
    '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>Microsoft PowerPoint</Application></Properties>';
  const presentation =
    '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>';
  const authors =
    `<?xml version="1.0"?><p188:authorLst xmlns:p188="${p188}">` +
    `<p188:author id="{11111111-1111-1111-1111-111111111111}" name="${author}" initials="NA" userId="S::${author}@cty.vn::guid" providerId="ADAL"/>` +
    '</p188:authorLst>';
  const entries: Record<string, [Uint8Array, {level: 6}]> = {
    '[Content_Types].xml': [utf8Encode(contentTypes), {level: 6}],
    '_rels/.rels': [utf8Encode(rootRels), {level: 6}],
    'ppt/presentation.xml': [utf8Encode(presentation), {level: 6}],
    'ppt/authors.xml': [utf8Encode(authors), {level: 6}],
    'docProps/core.xml': [utf8Encode(core), {level: 6}],
    'docProps/app.xml': [utf8Encode(app), {level: 6}],
  };
  return fflateZipSync(entries);
}

/** Dựng file ODT tối thiểu (mimetype STORED đứng đầu). */
export function buildOdt(opts: {creator?: string; comment?: string; thumbnail?: boolean} = {}): Uint8Array {
  const meta =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
    ' xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">' +
    '<office:meta>' +
    `<meta:initial-creator>${opts.creator ?? 'Nguyen Van A'}</meta:initial-creator>` +
    `<dc:creator>${opts.creator ?? 'Nguyen Van A'}</dc:creator>` +
    '<meta:creation-date>2026-04-15T10:20:30</meta:creation-date>' +
    '<meta:generator>LibreOffice/7.6</meta:generator>' +
    '<meta:editing-cycles>12</meta:editing-cycles>' +
    '</office:meta></office:document-meta>';
  const annotation = opts.comment
    ? '<office:annotation xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:creator>${opts.creator ?? 'Nguyen Van A'}</dc:creator><dc:date>2026-04-15T10:00:00</dc:date>` +
      `<text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">${opts.comment}</text:p></office:annotation>`
    : '';
  const content =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2">' +
    '<office:body><office:text><text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">' +
    annotation +
    'Noi dung.</text:p></office:text></office:body>' +
    '</office:document-content>';
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';
  const entries: Record<string, [Uint8Array, {level: 0 | 6}]> = {
    mimetype: [utf8Encode('application/vnd.oasis.opendocument.text'), {level: 0}],
    'META-INF/manifest.xml': [utf8Encode(manifest), {level: 6}],
    'content.xml': [utf8Encode(content), {level: 6}],
    'meta.xml': [utf8Encode(meta), {level: 6}],
  };
  if (opts.thumbnail) {
    entries['Thumbnails/thumbnail.png'] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), {level: 6}];
  }
  return fflateZipSync(entries);
}

// ---------------------------------------------------------------- bộ dựng PNG

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concatParts([latin1Encode(type), data]);
  return concatParts([u32beBytes(data.length), typeAndData, u32beBytes(crc32(typeAndData))]);
}

export interface PngFixtureOpts {
  text?: Array<[string, string]>;
  ztxt?: Array<[string, string]>;
  itxt?: Array<[string, string, boolean?]>;
  /** Thêm gói XMP trong iTXt với keyword chuẩn của Adobe. */
  xmp?: boolean;
  time?: boolean;
  exifTiff?: Uint8Array;
  iccp?: boolean;
  srgb?: boolean;
  gama?: boolean;
  phys?: boolean;
  apng?: boolean;
  /** Ảnh dùng bảng màu: IHDR colorType 3 + PLTE + tRNS (spec bắt buộc giữ). */
  palette?: boolean;
  /** Chia dữ liệu ảnh thành n chunk IDAT liên tiếp (PNG thật hay như vậy). */
  idatParts?: number;
  /** Chunk tuỳ ý chèn trước IDAT: [tên, dữ liệu]. */
  extraChunks?: Array<[string, Uint8Array]>;
  unknownAncillary?: boolean;
  unknownCritical?: boolean;
  trailing?: Uint8Array;
}

export function buildPng(opts: PngFixtureOpts = {}): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];

  parts.push(
    pngChunk(
      'IHDR',
      concatParts([
        u32beBytes(1),
        u32beBytes(1),
        new Uint8Array([8, opts.palette ? 3 : 0, 0, 0, 0]),
      ]),
    ),
  );
  if (opts.palette) {
    parts.push(pngChunk('PLTE', new Uint8Array([0x80, 0x40, 0x20])));
    parts.push(pngChunk('tRNS', new Uint8Array([0xfe])));
  }

  if (opts.srgb) parts.push(pngChunk('sRGB', new Uint8Array([0])));
  if (opts.gama) parts.push(pngChunk('gAMA', u32beBytes(45455)));
  if (opts.phys) {
    parts.push(pngChunk('pHYs', concatParts([u32beBytes(2835), u32beBytes(2835), new Uint8Array([1])])));
  }
  if (opts.iccp) {
    parts.push(
      pngChunk(
        'iCCP',
        concatParts([latin1Encode('test-profile'), new Uint8Array([0, 0]), zlibSync(fakeIccProfile())]),
      ),
    );
  }
  if (opts.apng) parts.push(pngChunk('acTL', concatParts([u32beBytes(1), u32beBytes(0)])));

  for (const [kw, text] of opts.text ?? []) {
    parts.push(pngChunk('tEXt', concatParts([latin1Encode(kw), new Uint8Array([0]), latin1Encode(text)])));
  }
  for (const [kw, text] of opts.ztxt ?? []) {
    parts.push(
      pngChunk(
        'zTXt',
        concatParts([latin1Encode(kw), new Uint8Array([0, 0]), zlibSync(latin1Encode(text))]),
      ),
    );
  }
  for (const [kw, text, compressed] of opts.itxt ?? []) {
    const body = compressed ? zlibSync(utf8Encode(text)) : utf8Encode(text);
    parts.push(
      pngChunk(
        'iTXt',
        concatParts([
          latin1Encode(kw),
          new Uint8Array([0, compressed ? 1 : 0, 0, 0, 0]), // lang rỗng + translated rỗng
          body,
        ]),
      ),
    );
  }
  if (opts.xmp) {
    parts.push(
      pngChunk(
        'iTXt',
        concatParts([
          latin1Encode('XML:com.adobe.xmp'),
          new Uint8Array([0, 0, 0, 0, 0]),
          utf8Encode(xmpPacket()),
        ]),
      ),
    );
  }
  if (opts.time) parts.push(pngChunk('tIME', new Uint8Array([2026 >> 8, 2026 & 0xff, 4, 15, 10, 20, 30])));
  if (opts.exifTiff) parts.push(pngChunk('eXIf', opts.exifTiff));
  if (opts.unknownAncillary) parts.push(pngChunk('prVt', latin1Encode('tracker-id-12345')));
  if (opts.unknownCritical) parts.push(pngChunk('KrIt', new Uint8Array([1, 2, 3])));
  for (const [type, data] of opts.extraChunks ?? []) parts.push(pngChunk(type, data));

  if (opts.apng) {
    parts.push(
      pngChunk(
        'fcTL',
        concatParts([
          u32beBytes(0), u32beBytes(1), u32beBytes(1), u32beBytes(0), u32beBytes(0),
          u16beBytes(1), u16beBytes(10), new Uint8Array([0, 0]),
        ]),
      ),
    );
  }

  // Dữ liệu ảnh 1 pixel (filter 0 + giá trị xám hoặc chỉ số bảng màu)
  const idat = zlibSync(new Uint8Array([0, opts.palette ? 0 : 0x80]));
  const nIdat = Math.max(1, opts.idatParts ?? 1);
  const idatChunk = Math.ceil(idat.length / nIdat);
  for (let i = 0; i < nIdat; i++) {
    parts.push(pngChunk('IDAT', idat.slice(i * idatChunk, Math.min((i + 1) * idatChunk, idat.length))));
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  if (opts.trailing) parts.push(opts.trailing);
  return concatParts(parts);
}
