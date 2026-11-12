import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportBackup,
  findActiveAttempt,
  getAttempt,
  getKey,
  importBackup,
  newAttempt,
  resetDatabaseForTests,
  saveAttempt,
  saveKey,
  type Attempt,
} from './db';
import { allSlots, daysUntil, formatDuration, getSubject, questionsFor } from './exam';
import { buildReviewItems } from './review';
import { draftKeyFrom, isKeyComplete, scoreAnswers, type Answers } from './scoring';

const kiso = getSubject('kiso');
const hoki = getSubject('hoki');

function keyOf(subject = kiso, value = 1): Answers {
  return Object.fromEntries(allSlots(subject).map((slot) => [slot.key, value]));
}

/** 上から順に指定点になるよう正解させた解答を作る。 */
function answersWorth(subject: typeof kiso, target: number): Answers {
  const answers: Answers = {};
  let remaining = target;
  for (const slot of allSlots(subject)) {
    if (remaining >= slot.points) {
      answers[slot.key] = 1;
      remaining -= slot.points;
    } else {
      answers[slot.key] = 2;
    }
  }
  return answers;
}

describe('問題構成', () => {
  it('公表の問題数と満点に一致する', () => {
    expect(questionsFor(kiso)).toHaveLength(25);
    expect(questionsFor(hoki)).toHaveLength(20);
    expect(allSlots(kiso).reduce((sum, slot) => sum + slot.points, 0)).toBe(125);
    expect(allSlots(hoki).reduce((sum, slot) => sum + slot.points, 0)).toBe(100);
  });
});

describe('採点', () => {
  it('基礎系は75点で合格、74点で不合格', () => {
    expect(scoreAnswers(kiso, answersWorth(kiso, 75), keyOf()).passed).toBe(true);
    const below = scoreAnswers(kiso, answersWorth(kiso, 74), keyOf());
    expect(below.points).toBe(74);
    expect(below.passed).toBe(false);
  });

  it('法規は60点で合格、59点で不合格', () => {
    expect(scoreAnswers(hoki, answersWorth(hoki, 60), keyOf(hoki)).passed).toBe(true);
    expect(scoreAnswers(hoki, answersWorth(hoki, 59), keyOf(hoki)).passed).toBe(false);
  });

  it('B問題は1欄ごとに部分点が付く', () => {
    const answers = { 'B-1-ア': 1, 'B-1-イ': 1, 'B-1-ウ': 2 };
    const result = scoreAnswers(kiso, answers, keyOf());
    const b1 = result.questions.find((question) => question.id === 'B-1');
    expect(b1?.earned).toBe(2);
    expect(b1?.allCorrect).toBe(false);
  });

  it('未解答は不正解として扱う', () => {
    expect(scoreAnswers(kiso, {}, keyOf()).points).toBe(0);
  });

  it('正答が未入力なら一致扱いにしない', () => {
    expect(scoreAnswers(kiso, { 'A-1': 1 }, {}).points).toBe(0);
  });
});

describe('答え合わせの下書き', () => {
  it('保存済みの正答を自分の解答より優先する', () => {
    expect(draftKeyFrom(kiso, { 'A-1': 3, 'A-2': 4 }, { 'A-1': 5 })).toEqual({ 'A-1': 5, 'A-2': 4 });
  });

  it('全欄そろって範囲内のときだけ完了扱い', () => {
    expect(isKeyComplete(kiso, keyOf())).toBe(true);
    expect(isKeyComplete(kiso, { ...keyOf(), 'A-1': 6 })).toBe(false);
    const missing = keyOf();
    delete missing['B-5-オ'];
    expect(isKeyComplete(kiso, missing)).toBe(false);
  });
});

describe('補助関数', () => {
  it('試験までの日数', () => {
    expect(daysUntil('2027-01-19', new Date(2027, 0, 18, 23, 30))).toBe(1);
    expect(daysUntil('2027-01-19', new Date(2027, 0, 19, 8))).toBe(0);
  });

  it('時間の表示', () => {
    expect(formatDuration(9000)).toBe('2:30:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(-3)).toBe('0:00');
  });
});

function finished(overrides: Partial<Attempt>): Attempt {
  return { ...newAttempt('2026-07', 'kiso', 1000), status: 'finished', finishedAt: 2000, ...overrides };
}

describe('復習リスト', () => {
  const lookup = () => keyOf();

  it('最新の記録だけを対象にする', () => {
    const old = finished({ id: 'old', finishedAt: 1000, answers: { 'A-1': 2 } });
    const latest = finished({ id: 'new', finishedAt: 3000, answers: keyOf() });
    expect(buildReviewItems([old, latest], [], lookup)).toEqual([]);
  });

  it('解き直しで正解した問題は外れ、その後の再受験で間違えると戻る', () => {
    const attempt = finished({ answers: { ...keyOf(), 'A-1': 2 }, pageOf: { 'A-1': 3 } });
    const before = buildReviewItems([attempt], [], lookup);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ questionId: 'A-1', page: 3, reason: 'wrong' });

    const ref = before[0].ref;
    expect(buildReviewItems([attempt], [{ id: ref, resolvedAt: 2500 }], lookup)).toEqual([]);

    const retake = finished({ id: 'retake', finishedAt: 4000, answers: { ...keyOf(), 'A-1': 3 } });
    expect(buildReviewItems([attempt, retake], [{ id: ref, resolvedAt: 2500 }], lookup)).toHaveLength(1);
  });

  it('★は正解でも残す', () => {
    const attempt = finished({ answers: keyOf(), flags: { 'A-2': true } });
    expect(buildReviewItems([attempt], [], lookup)[0]).toMatchObject({ questionId: 'A-2', reason: 'flag' });
  });

  it('正答が未登録の回は除外する', () => {
    expect(buildReviewItems([finished({ answers: {} })], [], () => undefined)).toEqual([]);
  });
});

describe('保存とバックアップ', () => {
  beforeEach(resetDatabaseForTests);

  it('途中の解答を再開できる', async () => {
    const attempt = newAttempt('2026-07', 'hoki', 1);
    attempt.answers['A-1'] = 3;
    await saveAttempt(attempt);
    expect((await findActiveAttempt('2026-07', 'hoki'))?.answers).toEqual({ 'A-1': 3 });
  });

  it('バックアップから復元できる', async () => {
    const attempt = finished({ id: 'a1', points: 80 });
    await saveAttempt(attempt);
    await saveKey('2026-07', 'kiso', keyOf());
    const backup = JSON.parse(JSON.stringify(await exportBackup(5)));

    await resetDatabaseForTests();
    expect(await getAttempt('a1')).toBeUndefined();

    await importBackup(backup);
    expect((await getAttempt('a1'))?.points).toBe(80);
    expect(await getKey('2026-07', 'kiso')).toEqual(keyOf());
  });

  it('古いバックアップで採点済みの記録を巻き戻さない', async () => {
    const backup = JSON.parse(JSON.stringify({
      app: 'rikugi-study', version: 1, exportedAt: 1, keys: [], resolved: [],
      attempts: [{ ...newAttempt('2026-07', 'kiso', 1), id: 'a2', elapsedSec: 50 }],
    }));
    await saveAttempt(finished({ id: 'a2', elapsedSec: 40, points: 90 }));
    await importBackup(backup);
    expect((await getAttempt('a2'))?.status).toBe('finished');
  });

  it('別形式のファイルは拒否する', async () => {
    await expect(importBackup({ foo: 1 })).rejects.toThrow('バックアップファイルではありません');
  });
});
