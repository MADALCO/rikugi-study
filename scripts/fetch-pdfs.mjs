// 一陸技の過去問PDFを 公式サイト → Wayback Machine の順に収集する。
// 同じ内容のファイルは SHA-256 で1つにまとめ、途中で止まっても再実行で続きから取得する。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'pdfs', 'raw');
const INDEX_PATH = join(ROOT, 'pdfs', 'index.json');
const OFFICIAL = 'https://www.nichimu.or.jp/vc-files/kshiken/pdf/siken';
const CDX = 'https://web.archive.org/cdx/search/cdx';
const UA = 'Mozilla/5.0 (personal exam study; rikugi-study)';
const SUBJECTS = ['kiso', 'kogaku-a', 'kogaku-b', 'hoki'];
const OFFICIAL_INTERVAL_MS = 1500;
const WAYBACK_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 公式URLの命名規則から科目と問題/解答の別を判定する。対象外(合格率の統計など)は null。
export function classify(url) {
  const path = new URL(url).pathname;
  const flat = path.match(/\/riku-gi-1-(kiso|kogaku-a|kogaku-b|hoki)(-kaito)?\.pdf$/);
  if (flat) return { subject: flat[1], kind: flat[2] ? 'answer' : 'question' };
  const nested = path.match(/\/riku-gi-1\/(kiso|kogaku-a|kogaku-b|hoki)\/(kiso|kogaku-a|kogaku-b|hoki|kaito)\.pdf$/);
  if (nested) return { subject: nested[1], kind: nested[2] === 'kaito' ? 'answer' : 'question' };
  return null;
}

function loadIndex() {
  if (!existsSync(INDEX_PATH)) return { files: {}, seenUrls: {} };
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

async function download(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
      return { bytes, lastModified: res.headers.get('last-modified') };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`  失敗: ${url} (${error.message})`);
        return null;
      }
      await sleep(attempt * 15000);
    }
  }
  return null;
}

export function store(index, bytes, meta, rawDir = RAW_DIR) {
  const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const existing = index.files[sha];
  if (existing) {
    existing.sources.push(meta.source);
    return false;
  }
  writeFileSync(join(rawDir, `${sha}.pdf`), bytes);
  index.files[sha] = {
    sha,
    subject: meta.subject,
    kind: meta.kind,
    size: bytes.length,
    lastModified: meta.lastModified ?? null,
    capturedAt: meta.capturedAt ?? null,
    sources: [meta.source],
  };
  return true;
}

async function collectOfficial(index) {
  for (let folder = 1; folder <= 6; folder++) {
    for (const subject of SUBJECTS) {
      for (const suffix of ['', '-kaito']) {
        const url = `${OFFICIAL}/${folder}/riku-gi-1-${subject}${suffix}.pdf`;
        const result = await download(url);
        await sleep(OFFICIAL_INTERVAL_MS);
        if (!result) {
          console.log(`  なし: ${url}`);
          continue;
        }
        const isNew = store(index, result.bytes, {
          ...classify(url),
          lastModified: result.lastModified,
          source: url,
        });
        console.log(`  ${isNew ? '保存' : '重複'}: ${url}`);
        writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1));
      }
    }
  }
}

async function queryCdx(urlPattern) {
  const params = new URLSearchParams({
    url: urlPattern,
    fl: 'timestamp,original,digest',
    limit: '5000',
  });
  params.append('filter', 'statuscode:200');
  params.append('filter', 'mimetype:application/pdf');
  params.append('filter', 'original:.*riku-gi-1.*');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${CDX}?${params}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [timestamp, original, digest] = line.split(' ');
          return { timestamp, original, digest };
        });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      await sleep(attempt * 20000);
    }
  }
  return [];
}

async function collectWayback(index) {
  const rows = [
    ...(await queryCdx('nichimu.or.jp/vc-files/kshiken/pdf/siken/*')),
    ...(await queryCdx('nichimu.or.jp/kshiken/pdf/*')),
  ];
  const unique = new Map();
  for (const row of rows) {
    if (classify(row.original) && !unique.has(row.digest)) unique.set(row.digest, row);
  }
  const pending = [...unique.values()].filter((row) => !index.seenUrls[row.digest]);
  console.log(`Wayback: 内容違い ${unique.size} 件、未取得 ${pending.length} 件`);

  for (const [i, row] of pending.entries()) {
    const url = `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
    const result = await download(url);
    await sleep(WAYBACK_INTERVAL_MS);
    if (!result) continue;
    const isNew = store(index, result.bytes, {
      ...classify(row.original),
      capturedAt: row.timestamp,
      source: url,
    });
    index.seenUrls[row.digest] = true;
    writeFileSync(INDEX_PATH, JSON.stringify(index, null, 1));
    console.log(`  [${i + 1}/${pending.length}] ${isNew ? '保存' : '重複'}: ${row.timestamp} ${row.original}`);
  }
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const index = loadIndex();
  console.log('公式サイトから取得');
  await collectOfficial(index);
  console.log('Wayback Machine から取得');
  await collectWayback(index);
  const files = Object.values(index.files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`完了: ${files.length} ファイル、${(total / 1048576).toFixed(1)} MB`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
