/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * 開発サーバー専用: ブラウザで全科目を解析した切り分けデータを pdfs/layouts.json に書き出す受け口。
 * 端末ごとの描画の違いで切り分けが変わらないよう、Macで作ったデータをiPhoneでも使うため。公開版には含まれない。
 */
function layoutSink(): Plugin {
  return {
    name: 'layout-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-layouts', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          writeFileSync(fileURLToPath(new URL('./pdfs/layouts.json', import.meta.url)), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    layoutSink(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-180.png'],
      manifest: {
        name: '一陸技 過去問',
        short_name: '一陸技',
        lang: 'ja',
        display: 'standalone',
        start_url: './',
        scope: './',
        background_color: '#faf7f2',
        theme_color: '#faf7f2',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,png,bcmap,pfb,ttf}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'] },
});
