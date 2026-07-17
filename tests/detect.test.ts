// Test nhận diện định dạng bằng magic bytes — không tin đuôi file.

import {describe, expect, it} from 'vitest';
import {buildJpeg, buildPng, latin1Encode} from './fixtures';
import {detectFormat} from '../src/lib/detect';
import {CleanerError} from '../src/lib/binary';
import {concatParts} from '../src/lib/binary';

describe('detectFormat', () => {
  it('nhận diện JPEG và PNG (được hỗ trợ)', () => {
    expect(detectFormat(buildJpeg())).toMatchObject({format: 'jpeg', supported: true});
    expect(detectFormat(buildPng())).toMatchObject({format: 'png', supported: true});
  });

  it('file JPEG đội lốt đuôi .png vẫn bị nhận diện đúng là JPEG (chỉ nhìn bytes)', () => {
    const fakePng = buildJpeg(); // người dùng có thể đặt tên file này là anh.png
    expect(detectFormat(fakePng).format).toBe('jpeg');
  });

  it('Phase 2: WebP/GIF/TIFF/HEIC đã được hỗ trợ', () => {
    const webp = concatParts([
      latin1Encode('RIFF'),
      new Uint8Array([16, 0, 0, 0]),
      latin1Encode('WEBP'),
    ]);
    expect(detectFormat(webp)).toMatchObject({format: 'webp', supported: true});
    expect(detectFormat(latin1Encode('GIF89a...'))).toMatchObject({format: 'gif', supported: true});
    expect(detectFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0]))).toMatchObject({
      format: 'tiff',
      supported: true,
    });
    const heic = concatParts([
      new Uint8Array([0, 0, 0, 24]),
      latin1Encode('ftypheic'),
      new Uint8Array(12),
    ]);
    expect(detectFormat(heic)).toMatchObject({format: 'heic', supported: true});
  });

  it('Phase 3: MP4/PDF/Office đã được hỗ trợ', () => {
    const mp4 = concatParts([
      new Uint8Array([0, 0, 0, 24]),
      latin1Encode('ftypisom'),
      new Uint8Array(12),
    ]);
    expect(detectFormat(mp4)).toMatchObject({format: 'mp4', supported: true});
    expect(detectFormat(latin1Encode('%PDF-1.7 abc'))).toMatchObject({format: 'pdf', supported: true});
    expect(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toMatchObject({
      format: 'office',
      supported: true,
    });
  });

  it('nhận diện các định dạng chưa hỗ trợ với nhãn thân thiện', () => {
    const avif = concatParts([
      new Uint8Array([0, 0, 0, 24]),
      latin1Encode('ftypavif'),
      new Uint8Array(12),
    ]);
    expect(detectFormat(avif)).toMatchObject({format: 'avif', supported: false});
    expect(detectFormat(latin1Encode('BMxxxxxx'))).toMatchObject({format: 'bmp', supported: false});
  });

  it('file rỗng ném CleanerError mã "empty"', () => {
    try {
      detectFormat(new Uint8Array(0));
      expect.fail('phải ném lỗi');
    } catch (err) {
      expect(err).toBeInstanceOf(CleanerError);
      expect((err as CleanerError).code).toBe('empty');
    }
  });

  it('nội dung lạ → unknown, không crash', () => {
    expect(detectFormat(latin1Encode('xin chao day la van ban'))).toMatchObject({
      format: 'unknown',
      supported: false,
    });
    expect(detectFormat(new Uint8Array([1]))).toMatchObject({format: 'unknown'});
  });
});
