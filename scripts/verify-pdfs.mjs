// カタログが参照する全PDFを PDF.js で開き、全ページを取得できるか確かめる。本文の抽出はしない。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(root, 'pdfs', 'catalog.json'), 'utf8'));
const names = catalog.exams.flatMap((exam) => Object.values(exam.subjects).flatMap((files) => [files.question, files.answer].filter(Boolean)));

let pages = 0;
const failures = [];
for (const name of names) {
  try {
    const task = getDocument({ data: new Uint8Array(readFileSync(join(root, 'pdfs', 'raw', name))), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) await doc.getPage(n);
    pages += doc.numPages;
    await task.destroy();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
console.log(`${names.length} ファイル、${pages} ページを確認 / 失敗 ${failures.length}`);
for (const failure of failures) console.log(`  ${failure}`);
process.exitCode = failures.length ? 1 : 0;
