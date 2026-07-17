// Gộp các file đã làm sạch thành một file ZIP để tải xuống.
// Dùng mức nén 0 (chỉ đóng gói) vì JPEG/PNG vốn đã nén — nhanh hơn nhiều.

import {zipSync} from 'fflate';

export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function safeEntryName(name: string): string {
  // Key '__proto__' làm hỏng object JS thường (kể cả bên trong fflate):
  // phép gán biến thành đổi prototype, file sẽ biến mất khỏi archive.
  // Đổi tên nhẹ để giữ an toàn — nội dung file không đổi.
  return name === '__proto__' ? '__proto__.file' : name;
}

export function buildZip(files: Array<{name: string; data: Uint8Array}>): Uint8Array {
  const used = new Set<string>();
  const entries: Record<string, [Uint8Array, {level: 0}]> = Object.create(null);
  for (const f of files) {
    entries[uniqueName(safeEntryName(f.name), used)] = [f.data, {level: 0}];
  }
  return zipSync(entries);
}
