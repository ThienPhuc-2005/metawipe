// Sinh file mẫu vào thư mục test-fixtures/ để thử tay trên trình duyệt.
// Chạy: npm run fixtures

import {mkdir, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {
  buildAvi,
  buildDocx,
  buildGif,
  buildJpeg,
  buildMp4,
  buildOdt,
  buildPng,
  buildTiffExif,
  buildTiffImage,
  buildWebm,
  buildWebp,
  HANOI_GPS,
  latin1Encode,
  xmpPacket,
} from '../tests/fixtures';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

const FULL_EXIF = {
  orientation: 6,
  make: 'TestMake',
  model: 'TestModel 3000',
  software: 'PhotoEditor 9.0',
  artist: 'Nguyen Van A',
  dateTime: '2026:04:15 10:20:30',
  gps: HANOI_GPS,
  serial: 'SN-1234567890',
};

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Bao cao noi bo Q2');
  doc.setAuthor('Nguyen Van A');
  doc.setCreator('Word 2026');
  doc.setProducer('PrintDriver 3.0');
  doc.setCreationDate(new Date('2026-04-15T10:20:30Z'));
  const page = doc.addPage([400, 200]);
  page.drawText('Noi dung PDF thu nghiem', {x: 30, y: 100, size: 16});
  return doc.save({useObjectStreams: false});
}

async function main() {
  await mkdir(OUT, {recursive: true});

  const files: Array<[string, Uint8Array]> = [
    [
      'jpeg-day-du.jpg',
      buildJpeg({exif: FULL_EXIF, xmp: true, iptc: true, icc: true, adobe14: true, comment: 'chu thich', jfxx: true}),
    ],
    ['jpeg-gps-hanoi.jpg', buildJpeg({exif: {orientation: 1, make: 'TestMake', gps: HANOI_GPS}})],
    ['jpeg-xmp-mo-rong.jpg', buildJpeg({exif: {make: 'M'}, xmp: true, extendedXmpParts: 3})],
    [
      'jpeg-hai-scan.jpg',
      buildJpeg({exif: {make: 'M'}, comment: 'dau file', multiScan: true, commentBetweenScans: 'giua hai scan'}),
    ],
    [
      'jpeg-du-lieu-an-sau-eoi.jpg',
      buildJpeg({exif: {make: 'M'}, trailing: latin1Encode('GIA-LAP-VIDEO-MOTION-PHOTO-'.repeat(50))}),
    ],
    ['jpeg-sach.jpg', buildJpeg()],
    [
      'png-van-ban.png',
      buildPng({
        text: [['Author', 'Nguyen Van A'], ['Comment', 'binh luan']],
        ztxt: [['Description', 'mo ta nen zlib']],
        time: true,
        srgb: true,
      }),
    ],
    ['png-exif-gps.png', buildPng({exifTiff: buildTiffExif({make: 'TestMake', gps: HANOI_GPS}), gama: true})],
    ['png-xmp.png', buildPng({xmp: true, srgb: true})],
    ['png-du-lieu-an.png', buildPng({text: [['Author', 'X']], trailing: latin1Encode('DU-LIEU-AN-'.repeat(30))})],
    ['png-sach.png', buildPng({srgb: true, gama: true})],
    // File "giả mạo đuôi": bytes là JPEG nhưng đuôi .png — app phải nhận diện đúng
    ['gia-mao-anh.png', buildJpeg({exif: {make: 'FakeExt'}})],
    ['rong.jpg', new Uint8Array(0)],
    // Phase 2 — LƯU Ý: webp/gif dưới đây dùng dữ liệu ảnh giả lập cho test parser;
    // muốn xem ảnh thật hãy dùng file WebP/GIF từ máy bạn
    [
      'webp-day-du.webp',
      buildWebp({icc: true, exif: {orientation: 6, make: 'TestMake', gps: HANOI_GPS}, xmp: true, unknownChunk: true}),
    ],
    ['gif-comment-xmp.gif', buildGif({comments: ['chu thich'], xmp: xmpPacket('Tac Gia', 'Tool', {gps: true}), netscape: true})],
    [
      'tiff-day-du.tif',
      buildTiffImage({
        orientation: 6,
        make: 'TestMake',
        model: 'TestModel',
        artist: 'Nguyen Van A',
        copyright: '(c) 2026',
        dateTime: '2026:04:15 10:20:30',
        gps: HANOI_GPS,
      }),
    ],
    ['tiff-hai-trang.tif', buildTiffImage({artist: 'Nguyen Van A', pages: 2})],
    // Phase 3 — mp4 có cấu trúc hợp lệ nhưng dữ liệu video giả lập (không phát được)
    [
      'video-gps.mp4',
      buildMp4({gps: true, tool: 'TestRecorder 9.9', appleMeta: {location: true}, xmpUuid: true}),
    ],
    [
      'tai-lieu.docx',
      buildDocx({
        creator: 'Nguyen Van A',
        company: 'Cong ty TNHH Test',
        custom: true,
        comments: [{author: 'Le Van C', text: 'gop y'}],
        trackedAuthor: 'Pham Thi D',
        people: true,
      }),
    ],
    ['van-ban.odt', buildOdt({creator: 'Nguyen Van A'})],
    ['bao-cao.pdf', await makePdf()],
    // Phase 4 — video giả lập cho test parser
    [
      'video.webm',
      buildWebm({title: 'Video rieng tu', date: true, tags: [['ARTIST', 'Nguyen Van A']]}),
    ],
    ['video.avi', buildAvi({software: 'TestSoft 1.0', artist: 'Nguyen Van A', date: '2026-04-15'})],
  ];

  for (const [name, bytes] of files) {
    await writeFile(join(OUT, name), bytes);
    console.log(`  ${name} (${bytes.length.toLocaleString('vi-VN')} byte)`);
  }
  console.log(`Đã sinh ${files.length} file mẫu vào test-fixtures/`);
}

main();
