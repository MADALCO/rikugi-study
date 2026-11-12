// kema's Homepage の一括ZIPから PDF だけを pdfs/raw に取り込む。
// ファイル名に試験回が入っているので、index.json に確定情報(examId)として記録する。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { store } from './fetch-pdfs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 「houk」は配布ZIP内の実在する誤記(2024年1月期の法規)。
const SUBJECT_NAMES = { houki: 'hoki', houk: 'hoki', kiso: 'kiso', 'kougaku-a': 'kogaku-a', 'kougaku-b': 'kogaku-b' };
// 令和2年11月〜令和5年7月期は同じ期に2種類の試験があり、「-1」「-2」で区別されている。
const NAME_PATTERN = /1rikugi-(\d{4})\([HR]\d+\)-(\d{2})(?:-(\d))?-(houki|houk|kiso|kougaku-a|kougaku-b)(-kaitou?)?\.pdf$/;

export function parseKemaName(name) {
  const match = name.match(NAME_PATTERN);
  if (!match) return null;
  const [, year, month, sitting, subject, answer] = match;
  return {
    examId: `${year}-${month}${sitting ? `-${sitting}` : ''}`,
    subject: SUBJECT_NAMES[subject],
    kind: answer ? 'answer' : 'question',
  };
}

function main() {
  const indexPath = join(root, 'pdfs', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entries = unzipSync(new Uint8Array(readFileSync(join(root, 'pdfs', 'third-party', 'kema.zip'))), {
    filter: (file) => file.name.toLowerCase().endsWith('.pdf'),
  });

  let added = 0;
  let matched = 0;
  const unparsed = [];
  for (const [name, bytes] of Object.entries(entries)) {
    const parsed = parseKemaName(name);
    if (!parsed) {
      unparsed.push(name);
      continue;
    }
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
      unparsed.push(`${name} (PDFではない)`);
      continue;
    }
    const buffer = Buffer.from(bytes);
    const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const source = `kema:${name.split('/').pop()}`;
    if (index.files[sha]?.sources.includes(source)) continue;
    if (store(index, buffer, { subject: parsed.subject, kind: parsed.kind, source })) added += 1;
    else matched += 1;
    index.files[sha].examId = parsed.examId;
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
  console.log(`新規 ${added} / 既存と同一 ${matched} / 解析不能 ${unparsed.length}`);
  for (const name of unparsed) console.log(`  ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
