// PDF.js の文字マップと標準フォントを public/ に置き、オフラインでも日本語を描画できるようにする。
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'public', 'pdfjs');
mkdirSync(target, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts']) {
  cpSync(join(source, folder), join(target, folder), { recursive: true });
}
