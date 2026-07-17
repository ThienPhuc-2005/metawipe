/// <reference types="vitest/config" />
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig({
  // base tương đối để deploy lên GitHub Pages với bất kỳ tên repo nào
  base: './',
  plugins: [
    react(),
    VitePWA({
      // 'prompt': service worker mới CHỜ tới khi mọi tab đóng mới kích hoạt —
      // tab đang mở tiếp tục dùng cache cũ, không bị 404 chunk nạp lười giữa chừng
      registerType: 'prompt',
      injectRegister: 'auto',
      manifest: {
        name: 'MetaWipe — Xoá metadata, 100% trên máy bạn',
        short_name: 'MetaWipe',
        description:
          'Xoá thông tin ẩn (GPS, tên tác giả, thiết bị...) khỏi ảnh, video, PDF, tài liệu Office — hoàn toàn trên thiết bị, không gửi đi đâu.',
        lang: 'vi',
        display: 'standalone',
        theme_color: '#12131a',
        background_color: '#12131a',
        icons: [
          {src: 'icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: 'icon-512.png', sizes: '512x512', type: 'image/png'},
          {src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
        ],
      },
      workbox: {
        // Cache cả chunk nạp lười (libheif WASM 1.4MB, pdf-lib) để offline trọn vẹn
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5175,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
