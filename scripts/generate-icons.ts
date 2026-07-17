// Sinh icon PWA bằng chính bộ mã hoá PNG của dự án (không cần công cụ ngoài).
// Thiết kế: nền tối bo tròn + vòng khiên xanh ngọc + chấm giữa — tối giản, nhận diện được.
// Chạy: npx tsx scripts/generate-icons.ts

import {mkdir, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodePngRgba} from '../src/lib/png-encode';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [0x12, 0x13, 0x1a, 255]; // nền tối
const RING = [0x37, 0xe0, 0xc8, 255]; // xanh ngọc
const DOT = [0xf5, 0xf7, 0xfa, 255]; // trắng ngà

function drawIcon(size: number, padded: boolean): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  // maskable cần vùng an toàn ~80% — thu nhỏ hình khi padded
  const scale = padded ? 0.72 : 0.92;
  const rOuter = c * 0.62 * scale;
  const rInner = c * 0.42 * scale;
  const rDot = c * 0.16 * scale;
  const corner = size * 0.18;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // nền bo góc (bo tròn 4 góc bằng khoảng cách tới tâm góc)
      let inside = true;
      const cx = x < corner ? corner : x > size - corner ? size - corner : x;
      const cy = y < corner ? corner : y > size - corner ? size - corner : y;
      if ((x < corner || x > size - corner) && (y < corner || y > size - corner)) {
        inside = Math.hypot(x - cx, y - cy) <= corner;
      }
      if (!inside) {
        rgba[i + 3] = 0; // trong suốt ngoài góc bo
        continue;
      }
      const d = Math.hypot(x - c, y - c);
      const color = d <= rDot ? DOT : d >= rInner && d <= rOuter ? RING : BG;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
  return encodePngRgba(rgba, size, size);
}

async function main() {
  await mkdir(OUT, {recursive: true});
  await writeFile(join(OUT, 'icon-192.png'), drawIcon(192, false));
  await writeFile(join(OUT, 'icon-512.png'), drawIcon(512, false));
  await writeFile(join(OUT, 'icon-maskable-512.png'), drawIcon(512, true));
  console.log('Đã sinh 3 icon PWA vào public/');
}

main();
