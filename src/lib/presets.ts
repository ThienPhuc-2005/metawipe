// Preset xoá metadata cho UI: mỗi preset quy về một bộ CleanOptions cụ thể.

import type {CleanOptions} from './types';

export type PresetId = 'social' | 'wipe-all' | 'gps-only' | 'custom';

export interface PresetInfo {
  id: PresetId;
  label: string;
  hint: string;
}

export const PRESETS: PresetInfo[] = [
  {
    id: 'social',
    label: 'An toàn đăng mạng xã hội',
    hint: 'Xoá mọi metadata; giữ màu sắc (ICC) và hướng xoay để ảnh hiển thị y nguyên.',
  },
  {
    id: 'wipe-all',
    label: 'Xoá sạch tuyệt đối',
    hint: 'Xoá tất cả, kể cả ICC và hướng xoay — file "trần" nhất có thể.',
  },
  {
    id: 'gps-only',
    label: 'Chỉ xoá vị trí (GPS)',
    hint: 'Chỉ gỡ toạ độ GPS khỏi EXIF/XMP, mọi thứ khác giữ nguyên.',
  },
  {
    id: 'custom',
    label: 'Tuỳ chỉnh',
    hint: 'Tự chọn giữ gì: màu sắc, hướng xoay, bản quyền.',
  },
];

/** Quy preset + tuỳ chỉnh của người dùng về CleanOptions mà handler hiểu. */
export function resolvePreset(preset: PresetId, custom: CleanOptions): CleanOptions {
  switch (preset) {
    case 'social':
      return {keepIcc: true, keepOrientation: true, keepCopyright: false, gpsOnly: false};
    case 'wipe-all':
      return {keepIcc: false, keepOrientation: false, keepCopyright: false, gpsOnly: false};
    case 'gps-only':
      // gpsOnly bỏ qua các cờ keep* (mọi thứ ngoài GPS đều được giữ)
      return {keepIcc: true, keepOrientation: true, keepCopyright: true, gpsOnly: true};
    case 'custom':
      return {...custom, gpsOnly: false};
  }
}
