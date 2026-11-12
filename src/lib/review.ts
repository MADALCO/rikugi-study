import { getSubject, type SubjectId } from './exam';
import { questionRef, type Attempt, type ResolvedRecord } from './db';
import { scoreAnswers, type Answers } from './scoring';

export interface ReviewItem {
  ref: string;
  examId: string;
  subject: SubjectId;
  questionId: string;
  page: number;
  reason: 'wrong' | 'flag' | 'both';
}

type KeyLookup = (examId: string, subject: SubjectId) => Answers | undefined;

/** 回×科目ごとに最新の採点済み記録を見て、間違い・★の問題を復習対象にする。 */
export function buildReviewItems(
  attempts: Attempt[],
  resolved: ResolvedRecord[],
  keyOf: KeyLookup,
): ReviewItem[] {
  const latest = new Map<string, Attempt>();
  for (const attempt of attempts) {
    if (attempt.status !== 'finished' || attempt.finishedAt === null) continue;
    const id = `${attempt.examId}/${attempt.subject}`;
    const current = latest.get(id);
    if (!current || (current.finishedAt ?? 0) < attempt.finishedAt) latest.set(id, attempt);
  }

  const resolvedAt = new Map(resolved.map((record) => [record.id, record.resolvedAt]));
  const items: ReviewItem[] = [];
  for (const attempt of latest.values()) {
    const key = keyOf(attempt.examId, attempt.subject);
    if (!key) continue;
    const result = scoreAnswers(getSubject(attempt.subject), attempt.answers, key);
    for (const question of result.questions) {
      const ref = questionRef(attempt.examId, attempt.subject, question.id);
      const flagged = Boolean(attempt.flags[question.id]);
      const fixedAfter = (resolvedAt.get(ref) ?? 0) > (attempt.finishedAt ?? 0);
      const wrong = !question.allCorrect && !fixedAfter;
      if (!wrong && !flagged) continue;
      items.push({
        ref,
        examId: attempt.examId,
        subject: attempt.subject,
        questionId: question.id,
        page: attempt.pageOf[question.id] ?? 1,
        reason: wrong && flagged ? 'both' : wrong ? 'wrong' : 'flag',
      });
    }
  }
  return items;
}
