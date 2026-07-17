// Unit test handler MP4/MOV: vô hiệu hoá metadata tại chỗ (free-in-place),
// offset video tuyệt đối không được xê dịch dù chỉ 1 byte.

import {describe, expect, it} from 'vitest';
import {buildMp4, latin1Encode, MP4_CREATION_TIME} from './fixtures';
import {cleanMp4, inspectMp4, parseMp4, parseIso6709} from '../src/lib/handlers/mp4';
import {CleanerError, u32be, asciiAt} from '../src/lib/binary';
import {DEFAULT_CLEAN_OPTIONS} from '../src/lib/types';

const GPS_ONLY = {keepIcc: true, keepOrientation: true, gpsOnly: true};

const fullMp4 = () =>
  buildMp4({gps: true, tool: 'TestRecorder 9.9', appleMeta: {location: true}, trackUdta: true, xmpUuid: true});

function boxTypes(bytes: Uint8Array): string[] {
  return parseMp4(bytes).boxes.map(b => `${b.path ? b.path + '/' : ''}${b.type}`);
}

function findBox(bytes: Uint8Array, type: string, path?: string) {
  return parseMp4(bytes).boxes.find(b => b.type === type && (path === undefined || b.path === path));
}

describe('cleanMp4 — vô hiệu hoá metadata tại chỗ', () => {
  it('KÍCH THƯỚC FILE GIỮ NGUYÊN, mdat + stco không xê dịch một byte nào', () => {
    const src = fullMp4();
    const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(out.length).toBe(src.length);

    const srcMdat = findBox(src, 'mdat')!;
    const outMdat = findBox(out, 'mdat')!;
    expect(outMdat.start).toBe(srcMdat.start);
    expect(Array.from(out.subarray(outMdat.start, outMdat.end))).toEqual(
      Array.from(src.subarray(srcMdat.start, srcMdat.end)),
    );

    const srcStco = findBox(src, 'stco')!;
    expect(Array.from(out.subarray(srcStco.start, srcStco.end))).toEqual(
      Array.from(src.subarray(srcStco.start, srcStco.end)),
    );
  });

  it('udta/meta/uuid thành box free với nội dung TOÀN SỐ 0 (hex editor cũng không đọc được)', () => {
    const src = fullMp4();
    const srcUdta = findBox(src, 'udta', 'moov')!;
    const srcMeta = findBox(src, 'meta', 'moov')!;
    const srcUuid = findBox(src, 'uuid', '')!;
    const result = cleanMp4(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;

    for (const seg of [srcUdta, srcMeta, srcUuid]) {
      expect(asciiAt(out, seg.start + 4, 4)).toBe('free');
      for (let i = seg.start + 8; i < seg.end; i++) {
        expect(out[i]).toBe(0);
      }
    }
    // GPS + XMP không còn dấu vết dạng chuỗi trong file
    const text = String.fromCharCode(...out);
    expect(text).not.toContain('+21.0285');
    expect(text).not.toContain('xpacket');
    expect(text).not.toContain('TestRecorder');
    expect(text).not.toContain('com.apple.quicktime');

    const kinds = result.removed.map(r => r.kind);
    expect(kinds).toContain('udta');
    expect(kinds).toContain('meta');
    expect(kinds).toContain('xmp');
  });

  it('trak/udta (metadata cấp track) cũng bị vô hiệu hoá', () => {
    const src = fullMp4();
    const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(String.fromCharCode(...out)).not.toContain('TestMake');
    // trak/udta giờ là free
    const trakUdta = findBox(src, 'udta', 'moov/trak')!;
    expect(asciiAt(out, trakUdta.start + 4, 4)).toBe('free');
  });

  it('thời gian tạo/sửa trong mvhd/tkhd/mdhd bị ghi 0 (cả version 0 lẫn 1)', () => {
    for (const version1 of [false, true]) {
      const src = buildMp4({gps: true, version1});
      const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
      for (const type of ['mvhd', 'tkhd', 'mdhd']) {
        const box = findBox(out, type)!;
        const tsLen = out[box.payloadStart] === 1 ? 16 : 8;
        for (let i = box.payloadStart + 4; i < box.payloadStart + 4 + tsLen; i++) {
          expect(out[i], `${type} byte ${i}`).toBe(0);
        }
        // timescale/duration phía sau timestamps phải CÒN NGUYÊN
        if (type === 'mdhd' && out[box.payloadStart] === 0) {
          expect(u32be(out, box.payloadStart + 12)).toBe(30000);
        }
      }
    }
  });

  it('tên phần mềm trong hdlr bị ghi 0 nhưng box hdlr vẫn còn (bắt buộc cho playback)', () => {
    const src = buildMp4({handlerName: 'GoPro MET'});
    const result = cleanMp4(src, DEFAULT_CLEAN_OPTIONS);
    const out = result.data;
    expect(String.fromCharCode(...out)).not.toContain('GoPro MET');
    const hdlr = findBox(out, 'hdlr', 'moov/trak/mdia')!;
    expect(hdlr).toBeTruthy();
    expect(asciiAt(out, hdlr.payloadStart + 8, 4)).toBe('vide'); // handler_type còn nguyên
    expect(result.removed.some(r => r.kind === 'handler-name')).toBe(true);
  });

  it('chỉ xoá GPS: ©xyz + meta chứa vị trí bị vô hiệu, ©too và timestamps GIỮ NGUYÊN', () => {
    const src = fullMp4();
    const result = cleanMp4(src, GPS_ONLY);
    const out = result.data;
    const text = String.fromCharCode(...out);
    expect(text).not.toContain('+21.0285');
    expect(text).not.toContain('location.ISO6709');
    expect(text).toContain('TestRecorder 9.9'); // ©too giữ nguyên
    // timestamps giữ nguyên
    const mvhd = findBox(out, 'mvhd')!;
    expect(u32be(out, mvhd.payloadStart + 4)).toBe(MP4_CREATION_TIME);
    expect(result.removed.some(r => r.kind === 'gps')).toBe(true);
  });

  it('meta KHÔNG chứa vị trí thì được giữ trong chế độ chỉ-xoá-GPS', () => {
    const src = buildMp4({gps: true, appleMeta: {location: false}});
    const out = cleanMp4(src, GPS_ONLY).data;
    expect(String.fromCharCode(...out)).toContain('TestPhone 15');
  });

  it('chỉ xoá GPS: toạ độ trong XMP (box uuid, kiểu drone) cũng bị xoá hết', () => {
    const src = buildMp4({gps: true, xmpUuidGps: true});
    const text0 = String.fromCharCode(...src);
    expect(text0).toMatch(/GPSLatitude/); // fixture thật có GPS trong XMP

    const result = cleanMp4(src, GPS_ONLY);
    const text = String.fromCharCode(...result.data);
    expect(text).not.toContain('+21.0285');
    expect(text).not.toMatch(/GPSLatitude/);
    expect(result.removed.some(r => r.kind === 'xmp')).toBe(true);
  });

  it('modification_time bị xoá kể cả khi creation_time = 0', () => {
    const src = buildMp4({gps: true});
    // Đặt creation_time=0, modification_time!=0 trong mvhd
    const mvhd = findBox(src, 'mvhd')!;
    const patched = src.slice();
    // v0: payloadStart+4 = creation (4 byte), +8 = modification (4 byte)
    patched.fill(0, mvhd.payloadStart + 4, mvhd.payloadStart + 8);
    new DataView(patched.buffer).setUint32(mvhd.payloadStart + 8, 0xd0000000);

    const result = cleanMp4(patched, DEFAULT_CLEAN_OPTIONS);
    const outMvhd = findBox(result.data, 'mvhd')!;
    for (let i = outMvhd.payloadStart + 4; i < outMvhd.payloadStart + 12; i++) {
      expect(result.data[i]).toBe(0);
    }
    expect(result.removed.some(r => r.kind === 'timestamp' && !!r.note?.includes('mvhd'))).toBe(true);
  });


  it('box free có sẵn chứa dữ liệu sót → bị ghi 0', () => {
    // Chèn box free chứa "bí mật" giữa ftyp và moov
    const base = buildMp4({});
    const secret = latin1Encode('old-metadata-secret');
    const freeBox = new Uint8Array(8 + secret.length);
    new DataView(freeBox.buffer).setUint32(0, freeBox.length);
    freeBox.set(latin1Encode('free'), 4);
    freeBox.set(secret, 8);
    const ftypEnd = findBox(base, 'ftyp')!.end;
    const src = new Uint8Array(base.length + freeBox.length);
    src.set(base.subarray(0, ftypEnd));
    src.set(freeBox, ftypEnd);
    src.set(base.subarray(ftypEnd), ftypEnd + freeBox.length);

    const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(String.fromCharCode(...out)).not.toContain('old-metadata-secret');
  });

  it('mdat đứng trước moov (không faststart) cũng xử lý được y hệt', () => {
    const src = buildMp4({gps: true, mdatFirst: true});
    const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(out.length).toBe(src.length);
    expect(String.fromCharCode(...out)).not.toContain('+21.0285');
    expect(String.fromCharCode(...out)).toContain('FAKE-VIDEO-PAYLOAD');
  });

  it('udta có 4 byte 0 kết thúc kiểu QuickTime: không bị coi là file hỏng', () => {
    const src = buildMp4({gps: true, udtaTerminator: true});
    expect(() => parseMp4(src)).not.toThrow();
    const out = cleanMp4(src, DEFAULT_CLEAN_OPTIONS).data;
    expect(String.fromCharCode(...out)).not.toContain('+21.0285');
  });

  it('idempotent + lỗi rõ ràng: rỗng / không phải MP4 / box dài quá file', () => {
    const once = cleanMp4(fullMp4(), DEFAULT_CLEAN_OPTIONS).data;
    const twice = cleanMp4(once, DEFAULT_CLEAN_OPTIONS).data;
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
    expectCode(() => cleanMp4(new Uint8Array(0), DEFAULT_CLEAN_OPTIONS), 'empty');
    // Tên box chứa byte điều khiển → corrupt ngay box đầu
    expectCode(
      () => cleanMp4(new Uint8Array([0, 0, 0, 16, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]), DEFAULT_CLEAN_OPTIONS),
      'corrupt',
    );
    // Chuỗi văn bản: 4 byte đầu đọc thành size khổng lồ → truncated (an toàn, không đoán bừa)
    expectCode(() => cleanMp4(latin1Encode('day khong phai video'), DEFAULT_CLEAN_OPTIONS), 'truncated');
    const src = fullMp4();
    expectCode(() => cleanMp4(src.slice(0, src.length - 10), DEFAULT_CLEAN_OPTIONS), 'truncated');
  });

  it('rác sau box cuối cùng: bị cắt (full) / giữ kèm cảnh báo (gpsOnly)', () => {
    // Rác không có dạng header box hợp lệ (byte >0x7E) — rác ASCII trông như box
    // sẽ bị từ chối 'truncated' thay vì đoán bừa, đó là hành vi chủ đích
    const src = buildMp4({gps: true, trailing: new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 1, 2, 3])});
    const {trailingStart} = parseMp4(src);
    expect(trailingStart).not.toBeNull();

    const full = cleanMp4(src, DEFAULT_CLEAN_OPTIONS);
    expect(full.data.length).toBe(trailingStart!);
    expect(full.removed.some(r => r.kind === 'trailing')).toBe(true);

    const gps = cleanMp4(src, GPS_ONLY);
    expect(gps.data.length).toBe(src.length);
    expect(gps.notes.join(' ')).toContain('sau box cuối');
  });
});

describe('inspectMp4', () => {
  it('đọc GPS (kèm link bản đồ), phần mềm, thời gian tạo, kích thước video', async () => {
    const report = await inspectMp4(fullMp4());
    expect(report.width).toBe(320);
    expect(report.height).toBe(240);

    const gps = report.fields.find(f => f.group === 'GPS');
    expect(gps?.risk).toBe('high');
    expect(gps?.value).toContain('21.028');
    expect(gps?.mapUrl).toContain('openstreetmap.org');

    expect(report.fields.some(f => f.value.includes('TestRecorder'))).toBe(true);
    expect(report.fields.some(f => f.tag === 'Thời gian tạo')).toBe(true);
    const metaField = report.fields.find(f => f.tag === 'Khối meta Apple/Android');
    expect(metaField?.risk).toBe('high'); // có chứa vị trí
    expect(report.metaSegments.map(s => s.kind)).toContain('xmp');
  });

  it('parseIso6709 đọc đúng toạ độ âm/dương', () => {
    expect(parseIso6709('+21.0285+105.8542/')).toEqual({lat: 21.0285, lon: 105.8542});
    expect(parseIso6709('-33.8688+151.2093+058.9/')).toEqual({lat: -33.8688, lon: 151.2093});
    expect(parseIso6709('khong phai toa do')).toBeNull();
  });
});
