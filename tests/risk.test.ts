// Test quy tắc phân mức rủi ro theo tên tag.

import {describe, expect, it} from 'vitest';
import {classifyTag, dmsToDecimal, osmUrl} from '../src/lib/risk';

describe('classifyTag', () => {
  it('nhóm GPS luôn ở mức cao', () => {
    expect(classifyTag('GPS', 'GPSLatitude')).toBe('high');
    expect(classifyTag('GPS', 'BatKyTagNao')).toBe('high');
  });

  it('danh tính / thiết bị cụ thể → cao', () => {
    expect(classifyTag('EXIF', 'Artist')).toBe('high');
    expect(classifyTag('EXIF', 'SerialNumber')).toBe('high');
    expect(classifyTag('EXIF', 'BodySerialNumber')).toBe('high');
    expect(classifyTag('EXIF', 'CameraOwnerName')).toBe('high');
    expect(classifyTag('XMP', 'creator')).toBe('high');
    expect(classifyTag('IPTC', 'Byline')).toBe('high');
    expect(classifyTag('IPTC', 'City')).toBe('high');
    expect(classifyTag('EXIF', 'ImageUniqueID')).toBe('high');
    expect(classifyTag('EXIF', 'HostComputer')).toBe('high');
  });

  it('thiết bị chung chung / thời gian / phần mềm → trung bình', () => {
    expect(classifyTag('EXIF', 'Make')).toBe('medium');
    expect(classifyTag('EXIF', 'Model')).toBe('medium');
    expect(classifyTag('EXIF', 'Software')).toBe('medium');
    expect(classifyTag('EXIF', 'DateTimeOriginal')).toBe('medium');
    expect(classifyTag('EXIF', 'LensModel')).toBe('medium');
    expect(classifyTag('XMP', 'CreatorTool')).toBe('medium'); // KHÔNG phải high dù chứa 'creator'
    expect(classifyTag('EXIF', 'Copyright')).toBe('medium');
  });

  it('thông số kỹ thuật vô hại → thấp (kể cả ExposureTime chứa chữ "time")', () => {
    expect(classifyTag('EXIF', 'ExposureTime')).toBe('low');
    expect(classifyTag('EXIF', 'FNumber')).toBe('low');
    expect(classifyTag('EXIF', 'FocalLength')).toBe('low');
    expect(classifyTag('EXIF', 'ColorSpace')).toBe('low');
    expect(classifyTag('EXIF', 'Orientation')).toBe('low');
    expect(classifyTag('ICC', 'ProfileVersion')).toBe('low');
  });
});

describe('tiện ích GPS', () => {
  it('đổi độ-phút-giây sang thập phân, hướng Nam/Tây thành số âm', () => {
    expect(dmsToDecimal([21, 1, 42.6], 'N')!).toBeCloseTo(21.0285, 3);
    expect(dmsToDecimal([21, 1, 42.6], 'S')!).toBeCloseTo(-21.0285, 3);
    expect(dmsToDecimal([105, 51, 15.1], 'W')!).toBeCloseTo(-105.8542, 3);
  });

  it('link OpenStreetMap chứa toạ độ', () => {
    expect(osmUrl(21.0285, 105.8542)).toContain('mlat=21.028500');
    expect(osmUrl(21.0285, 105.8542)).toContain('mlon=105.854200');
  });
});
