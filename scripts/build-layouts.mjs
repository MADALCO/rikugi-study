// pdfs/layouts.json(開発サーバーでMacのブラウザが作った切り分けデータ)を、アプリで読み込む小さなZIPにまとめる。
// PDFは含まない(座標のみ)。iPhoneで「ZIPを読み込む」から読み込むと、端末での解析の代わりに使われる。
// iPhoneで一度に全部を展開しないよう、科目ごとのファイル(layouts/<PDF名>.json)に分けて入れる。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export function layoutEntries(root) {
  const { version, layouts } = JSON.parse(readFileSync(join(root, 'pdfs', 'layouts.json'), 'utf8'));
  const encoder = new TextEncoder();
  const entries = { 'layouts/version.json': [encoder.encode(JSON.stringify({ version })), { level: 6 }] };
  for (const [file, layout] of Object.entries(layouts)) entries[`layouts/${file}.json`] = [encoder.encode(JSON.stringify(layout)), { level: 6 }];
  return { version, count: Object.keys(layouts).length, entries };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { version, count, entries } = layoutEntries(root);
  const zip = zipSync(entries);
  writeFileSync(join(root, 'rikugi-layouts.zip'), zip);
  console.log(`版 ${version}、${count}科目分、${(zip.length / 1048576).toFixed(1)} MB`);
}
