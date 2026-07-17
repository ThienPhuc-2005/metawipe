// Test đóng gói ZIP: tên trùng phải được đánh số, nội dung giải nén khớp.

import {describe, expect, it} from 'vitest';
import {unzipSync} from 'fflate';
import {buildZip, uniqueName} from '../src/lib/zip';
import {latin1Encode} from './fixtures';

describe('uniqueName', () => {
  it('đánh số file trùng tên, giữ nguyên đuôi', () => {
    const used = new Set<string>();
    expect(uniqueName('anh.jpg', used)).toBe('anh.jpg');
    expect(uniqueName('anh.jpg', used)).toBe('anh (2).jpg');
    expect(uniqueName('anh.jpg', used)).toBe('anh (3).jpg');
    expect(uniqueName('khong-duoi', used)).toBe('khong-duoi');
    expect(uniqueName('khong-duoi', used)).toBe('khong-duoi (2)');
  });
});

describe('buildZip', () => {
  it('file tên đúng chuỗi "__proto__" không phá hỏng archive', () => {
    const a = latin1Encode('noi dung proto');
    const b = latin1Encode('noi dung anh');
    const zip = buildZip([
      {name: '__proto__', data: a},
      {name: 'a.jpg', data: b},
    ]);
    // Số entry ghi trong End Of Central Directory (2 byte tại offset 10 từ cuối lên)
    const eocd = zip.length - 22;
    const entryCount = zip[eocd + 10] | (zip[eocd + 11] << 8);
    expect(entryCount).toBe(2);
    const asText = String.fromCharCode(...zip);
    expect(asText).toContain('__proto__');
    expect(asText).toContain('a.jpg');
    expect(asText).not.toContain('level'); // không có entry rác từ prototype
  });

  it('gộp nhiều file (kể cả trùng tên) và giải nén lại đúng nội dung', () => {
    const a = latin1Encode('noi dung A');
    const b = latin1Encode('noi dung B dai hon mot chut');
    const zip = buildZip([
      {name: 'anh.jpg', data: a},
      {name: 'anh.jpg', data: b},
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(['anh (2).jpg', 'anh.jpg']);
    expect(Array.from(out['anh.jpg'])).toEqual(Array.from(a));
    expect(Array.from(out['anh (2).jpg'])).toEqual(Array.from(b));
  });
});
