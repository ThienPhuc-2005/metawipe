// Unit test handler WebM/MKV (Void-in-place) và AVI (JUNK-in-place).

import {describe, expect, it} from 'vitest';
import {buildWebm, buildAvi, latin1Encode} from './fixtures';
import {cleanWebm, inspectWebm, parseWebm} from '../src/lib/handlers/webm';
import {cleanAvi, inspectAvi, parseAvi} from '../src/lib/handlers/avi';
import {detectFormat} from '../src/lib/detect';
import {CleanerError} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};

const fullWebm = () =>
  buildWebm({
    title: 'Video rieng tu cua toi',
    date: true,
    tags: [['ARTIST', 'Nguyen Van A'], ['COMMENT', 'quay o nha rieng']],
  });

const fullAvi = () =>
  buildAvi({
    software: 'TestSoft 1.0',
    artist: 'Nguyen Van A',
    date: '2026-04-15',
    idit: 'THU APR 15 10:20:30 2026',
    streamName: 'Stream Ten Rieng',
  });

describe('detect WebM/AVI', () => {
  it('nhận diện đúng bằng magic bytes', () => {
    expect(detectFormat(fullWebm())).toMatchObject({format: 'webm', supported: true});
    expect(detectFormat(fullAvi())).toMatchObject({format: 'avi', supported: true});
  });
});

describe('cleanWebm — Void-in-place', () => {
  it('KÍCH THƯỚC GIỮ NGUYÊN, block video không xê dịch, mọi chuỗi nhạy cảm biến mất', () => {
    const src = fullWebm();
    const result = cleanWebm(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;
    expect(out.length).toBe(src.length);

    const text = String.fromCharCode(...out);
    expect(text).not.toContain('Nguyen Van A');
    expect(text).not.toContain('Video rieng tu');
    expect(text).not.toContain('quay o nha rieng');
    expect(text).not.toContain('TestMuxer');
    expect(text).not.toContain('TestWriter');
    expect(text).toContain('FAKE-WEBM-BLOCK-DATA'); // dữ liệu video còn nguyên

    // Block video giữ nguyên TẠI CHỖ
    const idx0 = src.indexOf(0x46); // 'F' đầu tiên của FAKE...
    const blockStart = String.fromCharCode(...src).indexOf('FAKE-WEBM');
    expect(String.fromCharCode(...out).indexOf('FAKE-WEBM')).toBe(blockStart);
    void idx0;

    // Tags giờ là phần tử Void (0xEC)
    const srcTags = parseWebm(src).elements.find(e => e.id === 0x1254c367)!;
    expect(out[srcTags.start]).toBe(0xec);
    // File sạch vẫn parse được
    expect(() => parseWebm(out)).not.toThrow();
    expect(result.removed.map(r => r.note)).toContain('Tags (metadata)');
    expect(result.removed.map(r => r.note)).toContain('Thời điểm quay');
  });

  it('MuxingApp/WritingApp thành khoảng trắng (không Void vì spec bắt buộc phải có)', () => {
    const src = buildWebm({muxer: 'SecretApp 9'});
    const out = cleanWebm(src, DEFAULT_CLEAN_OPTIONS).data;
    const {elements} = parseWebm(out);
    const mux = elements.find(e => e.id === 0x4d80)!;
    expect(mux).toBeTruthy(); // vẫn tồn tại
    for (let i = mux.dataStart; i < mux.end; i++) expect(out[i]).toBe(0x20);
  });

  it('file streaming (Cluster kích thước không xác định): metadata trước đó vẫn được gột', () => {
    const src = buildWebm({title: 'Bi mat', tags: [['ARTIST', 'X']], unknownSizeCluster: true});
    const result = cleanWebm(src, DEFAULT_CLEAN_OPTIONS);
    const text = String.fromCharCode(...result.data);
    expect(text).not.toContain('Bi mat');
    expect(result.notes.some(n => n.includes('streaming'))).toBe(true);
  });

  it('gpsOnly là no-op có ghi chú; idempotent; lỗi rõ ràng', () => {
    const src = fullWebm();
    const gps = cleanWebm(src, GPS_ONLY);
    expect(Array.from(gps.data)).toEqual(Array.from(src));
    expect(gps.notes.join(' ')).toContain('GPS');

    const once = cleanWebm(src, DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanWebm(once, DEFAULT_CLEAN_OPTIONS).data;
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
    expectCode(() => cleanWebm(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanWebm(latin1Encode('khong phai webm'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    expectCode(() => cleanWebm(src.slice(0, src.length - 15), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });

  it('inspect đọc Title/ngày quay/phần mềm/tag ARTIST (mức cao)', async () => {
    const report = await inspectWebm(fullWebm());
    expect(report.fields.some(f => f.tag === 'Tiêu đề' && f.value.includes('rieng tu'))).toBe(true);
    expect(report.fields.some(f => f.tag === 'Thời điểm quay' && f.value.includes('2026'))).toBe(true);
    expect(report.fields.some(f => f.value === 'TestMuxer 1.0')).toBe(true);
    const artist = report.fields.find(f => f.tag === 'ARTIST');
    expect(artist?.value).toBe('Nguyen Van A');
    expect(artist?.risk).toBe('high');
  });
});

describe('cleanAvi — JUNK-in-place', () => {
  it('KÍCH THƯỚC GIỮ NGUYÊN, movi + idx1 không xê dịch, INFO/IDIT/strn bị vô hiệu', () => {
    const src = fullAvi();
    const result = cleanAvi(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;
    expect(out.length).toBe(src.length);

    const text = String.fromCharCode(...out);
    expect(text).not.toContain('Nguyen Van A');
    expect(text).not.toContain('TestSoft');
    expect(text).not.toContain('2026');
    expect(text).not.toContain('Stream Ten Rieng');
    expect(text).toContain('FAKE-AVI-FRAME-DATA');

    // movi + idx1 giữ nguyên tại chỗ
    const srcMovi = String.fromCharCode(...src).indexOf('FAKE-AVI');
    expect(text.indexOf('FAKE-AVI')).toBe(srcMovi);
    const srcIdx = parseAvi(src).chunks.find(c => c.fourcc === 'idx1')!;
    const outIdx = parseAvi(out).chunks.find(c => c.fourcc === 'idx1')!;
    expect(outIdx.start).toBe(srcIdx.start);

    // LIST INFO giờ là JUNK
    const srcInfo = parseAvi(src).chunks.find(c => c.listType === 'INFO')!;
    expect(String.fromCharCode(...out.subarray(srcInfo.start, srcInfo.start + 4))).toBe('JUNK');
    expect(result.removed.some(r => !!r.note?.includes('LIST INFO'))).toBe(true);
    expect(result.removed.some(r => !!r.note?.includes('IDIT'))).toBe(true);
  });

  it('kích thước ảnh đọc từ avih; IART mức cao', async () => {
    const report = await inspectAvi(fullAvi());
    expect(report.width).toBe(320);
    expect(report.height).toBe(240);
    const artist = report.fields.find(f => f.tag === 'Tác giả/Nghệ sĩ');
    expect(artist?.value).toBe('Nguyen Van A');
    expect(artist?.risk).toBe('high');
    expect(report.fields.some(f => f.tag === 'Phần mềm')).toBe(true);
  });

  it('rác sau vùng RIFF bị cắt; gpsOnly no-op; idempotent; lỗi rõ ràng', () => {
    const trailing = latin1Encode('DU-LIEU-AN-123');
    const src = buildAvi({artist: 'X', trailing});
    const result = cleanAvi(src, DEFAULT_CLEAN_OPTIONS);
    expect(result.data.length).toBe(src.length - trailing.length);
    expect(result.removed.some(r => r.kind === 'trailing')).toBe(true);

    const gps = cleanAvi(src, GPS_ONLY);
    expect(Array.from(gps.data)).toEqual(Array.from(src));

    const once = cleanAvi(fullAvi(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanAvi(once, DEFAULT_CLEAN_OPTIONS).data;
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
    expectCode(() => cleanAvi(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    expectCode(() => cleanAvi(latin1Encode('RIFFxxxxWAVE'), DEFAULT_CLEAN_OPTIONS), 'corrupt');
    const full = fullAvi();
    expectCode(() => cleanAvi(full.slice(0, full.length - 10), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });
});
