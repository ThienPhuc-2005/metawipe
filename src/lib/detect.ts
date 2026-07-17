// Nhận diện định dạng file bằng "magic bytes" (byte đặc trưng đầu file),
// KHÔNG tin đuôi file — file .jpg giả mạo sẽ bị phát hiện đúng bản chất.

import {CleanerError, startsWithAscii} from './binary';

export interface Detection {
  format: string;
  supported: boolean;
  label: string;
}

export function detectFormat(bytes: Uint8Array): Detection {
  if (bytes.length === 0) {
    throw new CleanerError('empty', 'File rỗng (0 byte).');
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return {format: 'jpeg', supported: true, label: 'JPEG'};
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return {format: 'png', supported: true, label: 'PNG'};
  }
  if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) {
    return {format: 'webp', supported: true, label: 'WebP'};
  }
  if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'AVI ')) {
    return {format: 'avi', supported: true, label: 'Video AVI'};
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return {format: 'webm', supported: true, label: 'Video WebM/MKV'};
  }
  if (startsWithAscii(bytes, 0, 'GIF8')) {
    return {format: 'gif', supported: true, label: 'GIF'};
  }
  if (
    (bytes.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return {format: 'tiff', supported: true, label: 'TIFF'};
  }
  if (bytes.length >= 12 && startsWithAscii(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return {format: 'heic', supported: true, label: 'HEIC (sẽ chuyển sang PNG)'};
    }
    if (['avif', 'avis'].includes(brand)) {
      return {format: 'avif', supported: false, label: 'AVIF (sẽ hỗ trợ ở Phase 3)'};
    }
    return {format: 'mp4', supported: true, label: 'Video MP4/MOV'};
  }
  if (startsWithAscii(bytes, 0, '%PDF')) {
    return {format: 'pdf', supported: true, label: 'PDF'};
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return {format: 'office', supported: true, label: 'Tài liệu Office'};
  }
  if (startsWithAscii(bytes, 0, 'BM')) {
    return {format: 'bmp', supported: false, label: 'BMP (hiếm khi chứa metadata)'};
  }
  return {format: 'unknown', supported: false, label: 'Không nhận diện được định dạng'};
}
