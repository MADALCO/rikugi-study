// pdfs/catalog.json が参照するPDFを、アプリで読み込むZIPにまとめる。
// PDFは既に圧縮済みなので無圧縮で格納し、iPhoneでの展開を軽くする。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(root, 'pdfs', 'catalog.json'), 'utf8'));
const entries = { 'catalog.json': new TextEncoder().encode(JSON.stringify(catalog)) };

for (const exam of catalog.exams) {
  for (const files of Object.values(exam.subjects)) {
    for (const name of [files.question, files.answer]) {
      if (name) entries[name] = new Uint8Array(readFileSync(join(root, 'pdfs', 'raw', name)));
    }
  }
}

const zip = zipSync(entries, { level: 0 });
writeFileSync(join(root, 'rikugi-library.zip'), zip);
console.log(`${catalog.exams.length}回分、${Object.keys(entries).length - 1}ファイル、${(zip.length / 1048576).toFixed(1)} MB`);
