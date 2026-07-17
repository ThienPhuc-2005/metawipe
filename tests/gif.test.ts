// Unit test handler GIF: block/sub-block, XMP magic trailer, giữ animation.

import {describe, expect, it} from 'vitest';
import {buildGif, latin1Encode, xmpPacket} from './fixtures';
import {cleanGif, inspectGif, parseGif} from '../src/lib/handlers/gif';
import {CleanerError, decodeUtf8} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const fullGif = () =>
  buildGif({
    comments: ['chu thich mot', 'chu thich hai'],
    xmp: true,
    netscape: true,
    appExt: true,
    plainText: true,
    trailing: latin1Encode('AN-SAU-TRAILER'),
  });

function kinds(bytes: Uint8Array): string[] {
  return parseGif(bytes).blocks.map(b => b.kind);
}

describe('cleanGif', () => {
  it('xoá comment/XMP/app lạ/plain text (kèm GCE của nó); giữ ảnh + GCE của ảnh + NETSCAPE', () => {
    const src = fullGif();
    const srcKinds = kinds(src);
    expect(srcKinds.filter(k => k === 'comment')).toHaveLength(2);
    expect(srcKinds).toContain('xmp');
    expect(srcKinds).toContain('netscape');
    expect(srcKinds).toContain('plaintext');

    const result = cleanGif(src, DEFAULT_CLEAN_OPTIONS);
    const outKinds = kinds(result.data);
    expect(outKinds).not.toContain('comment');
    expect(outKinds).not.toContain('xmp');
    expect(outKinds).not.toContain('application');
    expect(outKinds).not.toContain('plaintext');
    expect(outKinds).not.toContain('trailing');
    expect(outKinds).toContain('netscape');
    expect(outKinds).toContain('image');
    // GCE của ảnh được giữ; GCE của plain text bị xoá cùng plain text
    expect(outKinds.filter(k => k === 'gce')).toHaveLength(1);
    expect(result.removed.some(r => r.kind === 'gce')).toBe(true);
    expect(result.removed.some(r => r.kind === 'trailing')).toBe(true);
  });

  it('LOSSLESS: block ảnh + header + bảng màu giữ nguyên từng byte', () => {
    const src = fullGif();
    const out = cleanGif(src, DEFAULT_CLEAN_OPTIONS).data;
    const pick = (bytes: Uint8Array, kind: string) => {
      const b = parseGif(bytes).blocks.find(x => x.kind === kind)!;
      return Array.from(bytes.subarray(b.start, b.end));
    };
    expect(pick(out, 'header')).toEqual(pick(src, 'header'));
    expect(pick(out, 'image')).toEqual(pick(src, 'image'));
  });

  it('XMP thiếu magic trailer (tool ghi sai chuẩn) vẫn xoá được, không treo/crash', () => {
    const src = buildGif({xmp: true, xmpNoTrailer: true});
    const result = cleanGif(src, DEFAULT_CLEAN_OPTIONS);
    expect(kinds(result.data)).not.toContain('xmp');
    expect(kinds(result.data)).toContain('image');
  });

  it('packet chứa "<?xpacket end" GIẢ trong XML comment: không cắt sớm, ảnh còn nguyên', () => {
    // Marker giả '<?xpacket end' nằm GIỮA packet (trong XML comment) —
    // thuật toán phải tự hiệu chỉnh về điểm kết thúc thật, không cắt sớm
    const packet = xmpPacket('Tac Gia').replace(
      '<dc:creator>',
      '<!-- vi du trich dan: <?xpacket end="w"?> khong phai ket thuc that --><dc:creator>',
    );
    const src = buildGif({xmp: packet, comments: ['giu cau truc']});
    const srcKinds = kinds(src);
    expect(srcKinds).toContain('xmp');
    expect(srcKinds).toContain('image');

    const result = cleanGif(src, DEFAULT_CLEAN_OPTIONS);
    const outKinds = kinds(result.data);
    expect(outKinds).not.toContain('xmp');
    expect(outKinds).toContain('image'); // KHÔNG được nuốt nhầm khối ảnh
    expect(outKinds).toContain('trailer');
  });

  it('GCE đứng trước comment bị xoá: GCE không thành "mồ côi", vẫn chờ đúng block đồ hoạ', () => {
    const src = buildGif({gceBeforeComments: true, comments: ['se bi xoa']});
    const srcKinds = kinds(src);
    // nguồn: gce (chèn), comment, gce (của ảnh gốc), image
    expect(srcKinds.filter(k => k === 'gce')).toHaveLength(2);

    const result = cleanGif(src, DEFAULT_CLEAN_OPTIONS);
    const outKinds = kinds(result.data);
    expect(outKinds).not.toContain('comment');
    // cả 2 GCE được giữ, liền nhau ngay trước ảnh — không cái nào bị nhả lạc chỗ
    expect(outKinds.filter(k => k === 'gce')).toHaveLength(2);
    const imageIdx = outKinds.indexOf('image');
    expect(outKinds[imageIdx - 1]).toBe('gce');
    expect(outKinds[imageIdx - 2]).toBe('gce');
  });

  it('chỉ xoá GPS: comment giữ nguyên, XMP được gỡ GPS nhưng vẫn còn', () => {
    const src = buildGif({comments: ['giu lai'], xmp: xmpPacket('Tac Gia', 'Tool', {gps: true})});
    const result = cleanGif(src, {keepIcc: true, keepOrientation: true, gpsOnly: true});
    const outKinds = kinds(result.data);
    expect(outKinds).toContain('comment');
    expect(outKinds).toContain('xmp');

    const xmpBlock = parseGif(result.data).blocks.find(b => b.kind === 'xmp')!;
    const xml = decodeUtf8(result.data.subarray(xmpBlock.dataStart, xmpBlock.end));
    expect(xml).not.toMatch(/GPSL/);
    expect(xml).toContain('Tac Gia');
    expect(result.removed.some(r => r.kind === 'xmp')).toBe(true);
  });

  it('idempotent + lỗi rõ ràng: rỗng / không phải GIF / cắt cụt giữa sub-block', () => {
    const once = cleanGif(fullGif(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanGif(once, DEFAULT_CLEAN_OPTIONS).data;
    expect(Array.from(twice)).toEqual(Array.from(once));

    const expectCode = (fn: () => unknown, code: string) => {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CleanerError);
      expect((err as CleanerError).code).toBe(code);
    };
    expectCode(() => cleanGif(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanGif(latin1Encode('PNG hay JPEG gi do'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    const src = fullGif();
    expectCode(() => cleanGif(src.slice(0, src.length - 20), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });
});

describe('inspectGif', () => {
  it('liệt kê comment (kèm nội dung), XMP (cảnh báo GPS), app lạ; đọc đúng kích thước', async () => {
    const report = await inspectGif(
      buildGif({
        comments: ['binh luan thu'],
        xmp: xmpPacket('X', 'Y', {gps: true}),
        appExt: true,
        trailing: latin1Encode('X'.repeat(50)),
      }),
    );
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);
    expect(report.fields.some(f => f.tag === 'Comment' && f.value === 'binh luan thu')).toBe(true);
    const xmpField = report.fields.find(f => f.tag === 'XMP');
    expect(xmpField?.risk).toBe('high');
    expect(xmpField?.value).toContain('GPS');
    expect(report.fields.some(f => f.tag === 'Application' && f.value.includes('TRACKAPP'))).toBe(true);
    expect(report.trailingBytes).toBe(50);
  });
});
