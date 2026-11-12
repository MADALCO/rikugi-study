import { allSlots, questionsFor, type Subject } from './exam';

export type Answers = Record<string, number>;

export interface SlotResult {
  key: string;
  label: string;
  answer: number | null;
  correct: number | null;
  ok: boolean;
  points: number;
}

export interface QuestionResult {
  id: string;
  type: 'A' | 'B';
  earned: number;
  max: number;
  allCorrect: boolean;
  slots: SlotResult[];
}

export interface ScoreResult {
  points: number;
  maxScore: number;
  passScore: number;
  passed: boolean;
  questions: QuestionResult[];
}

export function scoreAnswers(subject: Subject, answers: Answers, key: Answers): ScoreResult {
  const questions = questionsFor(subject).map((question): QuestionResult => {
    const slots = question.slots.map((slot): SlotResult => {
      const answer = answers[slot.key] ?? null;
      const correct = key[slot.key] ?? null;
      return {
        key: slot.key,
        label: slot.label,
        answer,
        correct,
        ok: answer !== null && correct !== null && answer === correct,
        points: slot.points,
      };
    });
    const earned = slots.reduce((sum, slot) => sum + (slot.ok ? slot.points : 0), 0);
    const max = slots.reduce((sum, slot) => sum + slot.points, 0);
    return { id: question.id, type: question.type, earned, max, allCorrect: earned === max, slots };
  });
  const points = questions.reduce((sum, question) => sum + question.earned, 0);
  return {
    points,
    maxScore: subject.maxScore,
    passScore: subject.passScore,
    passed: points >= subject.passScore,
    questions,
  };
}

export function isKeyComplete(subject: Subject, key: Answers | undefined): boolean {
  if (!key) return false;
  return allSlots(subject).every((slot) => {
    const value = key[slot.key];
    return Number.isInteger(value) && value >= 1 && value <= slot.choices;
  });
}

export function answeredCount(subject: Subject, answers: Answers): number {
  return allSlots(subject).filter((slot) => answers[slot.key] !== undefined).length;
}

/** 答え合わせの初期値。自分の解答を入れておき、公式解答と違う箇所だけ直せるようにする。 */
export function draftKeyFrom(subject: Subject, answers: Answers, existing?: Answers): Answers {
  const draft: Answers = {};
  for (const slot of allSlots(subject)) {
    const value = existing?.[slot.key] ?? answers[slot.key];
    if (value !== undefined) draft[slot.key] = value;
  }
  return draft;
}
