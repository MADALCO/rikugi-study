import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classify, store } from './fetch-pdfs.mjs';
import { parseKemaName } from './import-kema.mjs';
import { buildCatalog, examIdFromDate, examLabel, preferred } from './make-catalog.mjs';

const OFFICIAL = 'https://www.nichimu.or.jp/vc-files/kshiken/pdf/siken/3/riku-gi-1-kiso.pdf';
const ARCHIVE = 'https://web.archive.org/web/2023id_/http://www.nichimu.or.jp/x.pdf';

function file(overrides) {
  return { sha: 'aaaa', subject: 'kiso', kind: 'question', created: '2026-07-06', sources: [ARCHIVE], ...overrides };
}

describe('URLの分類', () => {
  it('現行の命名を判定する', () => {
    expect(classify(OFFICIAL)).toEqual({ subject: 'kiso', kind: 'question' });
    expect(classify(OFFICIAL.replace('kiso.pdf', 'hoki-kaito.pdf'))).toEqual({ subject: 'hoki', kind: 'answer' });
  });

  it('旧サイトの命名を判定する', () => {
    const base = 'http://www.nichimu.or.jp/kshiken/pdf/shiken1/riku-gi-1/kogaku-a';
    expect(classify(`${base}/kogaku-a.pdf`)).toEqual({ subject: 'kogaku-a', kind: 'question' });
    expect(classify(`${base}/kaito.pdf`)).toEqual({ subject: 'kogaku-a', kind: 'answer' });
  });

  it('合格率の統計PDFは対象外', () => {
    expect(classify('http://www.nichimu.or.jp/kshiken/kekka/riku-gi-1/021.pdf')).toBeNull();
  });
});

describe('重複排除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rikugi-'));
  afterAll(() => rmSync(dir, { recursive: true }));

  it('同じ内容は1ファイルにまとめ、取得元だけ追記する', () => {
    const index = { files: {}, seenUrls: {} };
    const meta = { subject: 'kiso', kind: 'question' };
    expect(store(index, Buffer.from('%PDF-same'), { ...meta, source: 'a' }, dir)).toBe(true);
    expect(store(index, Buffer.from('%PDF-same'), { ...meta, source: 'b' }, dir)).toBe(false);
    expect(store(index, Buffer.from('%PDF-other'), { ...meta, source: 'c' }, dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
    const [first] = Object.values(index.files);
    expect(first.sources).toEqual(['a', 'b']);
    expect(existsSync(join(dir, `${first.sha}.pdf`))).toBe(true);
  });
});

describe('試験回の推定', () => {
  it('作成月から回を決める', () => {
    expect(examIdFromDate('2025-12-18')).toBe('2026-01');
    expect(examIdFromDate('2026-01-20')).toBe('2026-01');
    expect(examIdFromDate('2026-09-18')).toBe('2026-07');
    expect(examIdFromDate('2026-03-01')).toBeNull();
    expect(examIdFromDate('')).toBeNull();
  });

  it('元号で表示する', () => {
    expect(examLabel('2026-07')).toBe('令和8年7月期');
    expect(examLabel('2019-07')).toBe('令和元年7月期');
    expect(examLabel('2019-01')).toBe('平成31年1月期');
  });
});

describe('一括ZIPのファイル名', () => {
  it('通常の回と問題・解答を判定する', () => {
    expect(parseKemaName('一陸技/1rikugi-2026(R08)-07-houki.pdf')).toEqual({ examId: '2026-07', subject: 'hoki', kind: 'question' });
    expect(parseKemaName('一陸技/1rikugi-2002(H14)-01-kougaku-a-kaitou.pdf')).toEqual({ examId: '2002-01', subject: 'kogaku-a', kind: 'answer' });
  });

  it('kaito の表記ゆれと第1回・第2回を判定する', () => {
    expect(parseKemaName('x/1rikugi-2013(H25)-01-kougaku-b-kaito.pdf')).toEqual({ examId: '2013-01', subject: 'kogaku-b', kind: 'answer' });
    expect(parseKemaName('x/1rikugi-2022(R04)-07-2-kiso.pdf')).toEqual({ examId: '2022-07-2', subject: 'kiso', kind: 'question' });
  });

  it('形式の違うファイルは拾わない', () => {
    expect(parseKemaName('x/readme.pdf')).toBeNull();
  });
});

describe('カタログ', () => {
  it('第1回・第2回は表示で区別する', () => {
    expect(examLabel('2022-07-2')).toBe('令和4年7月期 第2回');
  });

  it('回が確定しているファイルは作成日より優先する', () => {
    const { catalog } = buildCatalog([file({ sha: 'x', created: '2002-07-26', examId: '2002-01' })]);
    expect(catalog.exams[0].id).toBe('2002-01');
  });

  it('第1回・第2回に分かれた期へ、作成日だけのファイルを混ぜない', () => {
    const { catalog, unknown } = buildCatalog([
      file({ sha: 'one', created: '2022-07-06', examId: '2022-07-1' }),
      file({ sha: 'guess', created: '2022-07-19' }),
    ]);
    expect(catalog.exams.map((exam) => exam.id)).toEqual(['2022-07-1']);
    expect(unknown.map((item) => item.sha)).toEqual(['guess']);
  });

  it('公式の版がなければ回の確定している版を採る', () => {
    const named = file({ sha: 'named', created: '2006-01-01', examId: '2006-07' });
    const guessed = file({ sha: 'guessed', created: '2006-07-20' });
    expect(preferred(guessed, named).sha).toBe('named');
  });

  it('公式サイトに現存する版を優先する', () => {
    const live = file({ sha: 'live', created: '2020-01-01', sources: [OFFICIAL] });
    const archived = file({ sha: 'old', created: '2026-01-01' });
    expect(preferred(archived, live).sha).toBe('live');
  });

  it('問題と解答を同じ回にまとめ、新しい回から並べる', () => {
    const { catalog } = buildCatalog([
      file({ sha: 'q1', created: '2025-07-01' }),
      file({ sha: 'a1', created: '2025-07-02', kind: 'answer' }),
      file({ sha: 'q2', created: '2026-07-01' }),
    ]);
    expect(catalog.exams.map((exam) => exam.id)).toEqual(['2026-07', '2025-07']);
    expect(catalog.exams[1].subjects.kiso).toEqual({ question: 'q1.pdf', answer: 'a1.pdf' });
  });

  it('個別指定を作成日より優先し、skipは除外する', () => {
    const { catalog, unknown } = buildCatalog(
      [file({ sha: 'fix1', created: '2026-03-01' }), file({ sha: 'drop', created: '2026-07-01' }), file({ sha: 'nope', created: '2026-03-01' })],
      { fix1: '2026-01', drop: 'skip' },
    );
    expect(catalog.exams.map((exam) => exam.id)).toEqual(['2026-01']);
    expect(unknown.map((item) => item.sha)).toEqual(['nope']);
  });
});
