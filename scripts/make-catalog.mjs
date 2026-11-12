// pdfs/index.json と PDFの作成日から pdfs/catalog.json を作る。
// 作成日だけでは誤る回は scripts/catalog-overrides.json で個別に指定する(sha先頭 → 試験回ID、"skip" で除外)。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 1月期は前年12月〜2月、7月期は5〜9月に作られたPDFとして試験回を推定する。 */
export function examIdFromDate(dateText) {
  if (!dateText) return null;
  const [year, month] = dateText.split('-').map(Number);
  if (month === 12) return `${year + 1}-01`;
  if (month <= 2) return `${year}-01`;
  if (month >= 5 && month <= 9) return `${year}-07`;
  return null;
}

export function examLabel(examId) {
  const [year, month, sitting] = examId.split('-').map(Number);
  const era = year >= 2019 && !(year === 2019 && month < 5) ? ['令和', year - 2018] : ['平成', year - 1988];
  return `${era[0]}${era[1] === 1 ? '元' : era[1]}年${month}月期${sitting ? ` 第${sitting}回` : ''}`;
}

/** 同じ回・科目に複数版あるときは、公式サイトに現存する版、回が確定している版、作成日の新しい版の順に採る。 */
export function preferred(a, b) {
  const official = (file) => file.sources.some((source) => source.startsWith('https://www.nichimu.or.jp/'));
  if (official(a) !== official(b)) return official(a) ? a : b;
  if (Boolean(a.examId) !== Boolean(b.examId)) return a.examId ? a : b;
  return (a.created ?? '') >= (b.created ?? '') ? a : b;
}

export function buildCatalog(files, overrides = {}) {
  const exams = new Map();
  const unknown = [];
  // 同じ期が第1回・第2回に分かれていると、作成日だけではどちらか決められない。
  const splitPeriods = new Set(files.map((file) => file.examId).filter((id) => id?.split('-').length === 3).map((id) => id.slice(0, 7)));
  for (const file of files) {
    const override = Object.entries(overrides).find(([prefix]) => file.sha.startsWith(prefix))?.[1];
    if (override === 'skip') continue;
    const examId = override ?? file.examId ?? examIdFromDate(file.created);
    if (!examId || splitPeriods.has(examId)) {
      unknown.push(file);
      continue;
    }
    const exam = exams.get(examId) ?? { id: examId, label: examLabel(examId), picks: {} };
    exams.set(examId, exam);
    const slot = (exam.picks[file.subject] ??= {});
    slot[file.kind] = slot[file.kind] ? preferred(slot[file.kind], file) : file;
  }
  const list = [...exams.values()]
    .sort((a, b) => b.id.localeCompare(a.id))
    .map((exam) => ({
      id: exam.id,
      label: exam.label,
      subjects: Object.fromEntries(
        Object.entries(exam.picks).map(([subject, pick]) => [
          subject,
          {
            ...(pick.question && { question: `${pick.question.sha}.pdf` }),
            ...(pick.answer && { answer: `${pick.answer.sha}.pdf` }),
          },
        ]),
      ),
    }));
  return { catalog: { version: 1, exams: list }, unknown };
}

function main() {
  const raw = join(root, 'pdfs', 'raw');
  const index = JSON.parse(readFileSync(join(root, 'pdfs', 'index.json'), 'utf8'));
  const output = execFileSync('osascript', ['-l', 'JavaScript', join(root, 'scripts', 'pdf-dates.js'), raw], { encoding: 'utf8' });
  const dates = new Map(output.trim().split('\n').map((line) => line.split('\t')).map(([name, created, pages]) => [name.replace('.pdf', ''), { created, pages: Number(pages) }]));
  const files = Object.values(index.files).filter((file) => dates.get(file.sha)?.pages > 0).map((file) => ({ ...file, ...dates.get(file.sha) }));
  const overridePath = join(root, 'scripts', 'catalog-overrides.json');
  const overrides = existsSync(overridePath) ? JSON.parse(readFileSync(overridePath, 'utf8')) : {};
  const { catalog, unknown } = buildCatalog(files, overrides);
  writeFileSync(join(root, 'pdfs', 'catalog.json'), JSON.stringify(catalog, null, 1));

  for (const exam of catalog.exams) {
    const parts = Object.entries(exam.subjects).map(([subject, pick]) => `${subject}:${pick.question ? '問' : '-'}${pick.answer ? '解' : '-'}`);
    console.log(`${exam.label}\t${parts.join(' ')}`);
  }
  console.log(`計 ${catalog.exams.length} 回 / 回を特定できないファイル ${unknown.length}`);
  for (const file of unknown) console.log(`  ${file.sha} ${file.subject} ${file.kind} created=${file.created} ${file.sources[0]}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
