export type SubjectId = 'kiso' | 'kogaku-a' | 'kogaku-b' | 'hoki';

export interface Subject {
  id: SubjectId;
  name: string;
  shortName: string;
  aCount: number;
  bCount: number;
  minutes: number;
  maxScore: number;
  passScore: number;
}

export interface Slot {
  key: string;
  label: string;
  choices: number;
  points: number;
}

export interface Question {
  id: string;
  type: 'A' | 'B';
  slots: Slot[];
}

/** 科目ごとの問題構成。問題数・時間・満点・合格点は日本無線協会の公表値。 */
export const SUBJECTS: Subject[] = [
  { id: 'kiso', name: '無線工学の基礎', shortName: '基礎', aCount: 20, bCount: 5, minutes: 150, maxScore: 125, passScore: 75 },
  { id: 'kogaku-a', name: '無線工学A', shortName: '工学A', aCount: 20, bCount: 5, minutes: 150, maxScore: 125, passScore: 75 },
  { id: 'kogaku-b', name: '無線工学B', shortName: '工学B', aCount: 20, bCount: 5, minutes: 150, maxScore: 125, passScore: 75 },
  { id: 'hoki', name: '法規', shortName: '法規', aCount: 15, bCount: 5, minutes: 120, maxScore: 100, passScore: 60 },
];

export const A_POINTS = 5;
export const B_BLANK_POINTS = 1;
export const A_CHOICES = 5;
export const B_CHOICES = 10;
export const BLANK_LABELS = ['ア', 'イ', 'ウ', 'エ', 'オ'];

/** 次回試験の初日(令和9年1月期)。 */
export const NEXT_EXAM_DATE = '2027-01-19';

export function getSubject(id: SubjectId): Subject {
  const subject = SUBJECTS.find((candidate) => candidate.id === id);
  if (!subject) throw new Error(`未知の科目: ${id}`);
  return subject;
}

export function questionsFor(subject: Subject): Question[] {
  const questions: Question[] = [];
  for (let n = 1; n <= subject.aCount; n++) {
    const id = `A-${n}`;
    questions.push({
      id,
      type: 'A',
      slots: [{ key: id, label: id, choices: A_CHOICES, points: A_POINTS }],
    });
  }
  for (let n = 1; n <= subject.bCount; n++) {
    const id = `B-${n}`;
    questions.push({
      id,
      type: 'B',
      slots: BLANK_LABELS.map((label) => ({
        key: `${id}-${label}`,
        label,
        choices: B_CHOICES,
        points: B_BLANK_POINTS,
      })),
    });
  }
  return questions;
}

export function allSlots(subject: Subject): Slot[] {
  return questionsFor(subject).flatMap((question) => question.slots);
}

export function daysUntil(dateText: string, now: Date = new Date()): number {
  const [year, month, day] = dateText.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
