import { useEffect, useState } from 'react';
import type { Question, Slot } from '../lib/exam';
import type { Answers } from '../lib/scoring';

export function useCompact(): boolean {
  const query = '(max-width: 820px)';
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setCompact(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return compact;
}

interface BubblesProps {
  slot: Slot;
  value: number | undefined;
  onChange?: (value: number | undefined) => void;
  correct?: number | null;
}

/** マークシートの楕円。もう一度押すと消せる。 */
export function Bubbles({ slot, value, onChange, correct }: BubblesProps) {
  const numbers = Array.from({ length: slot.choices }, (_, index) => index + 1);
  return (
    <div className="bubbles" role="group" aria-label={`${slot.label}の解答`}>
      {numbers.map((number) => {
        const classes = ['bubble'];
        if (value === number) classes.push('bubble-on');
        if (correct === number) classes.push('bubble-correct');
        return (
          <button
            key={number}
            type="button"
            className={classes.join(' ')}
            aria-pressed={value === number}
            disabled={!onChange}
            onClick={() => onChange?.(value === number ? undefined : number)}
          >
            {number % 10}
          </button>
        );
      })}
    </div>
  );
}

interface QuestionMarksProps {
  question: Question;
  answers: Answers;
  onMark?: (slot: Slot, value: number | undefined) => void;
  corrects?: Answers;
  edited?: (slot: Slot) => boolean;
  unsure?: (slot: Slot) => boolean;
}

export function QuestionMarks({ question, answers, onMark, corrects, edited, unsure }: QuestionMarksProps) {
  if (question.type === 'A') {
    const slot = question.slots[0];
    return (
      <Bubbles
        slot={slot}
        value={answers[slot.key]}
        correct={corrects?.[slot.key]}
        onChange={onMark ? (value) => onMark(slot, value) : undefined}
      />
    );
  }
  return (
    <div className="blanks">
      {question.slots.map((slot) => (
        <div key={slot.key} className={['blank', edited?.(slot) ? 'blank-edited' : '', unsure?.(slot) ? 'blank-unsure' : ''].filter(Boolean).join(' ')}>
          <span className="blank-label">{slot.label}</span>
          <Bubbles
            slot={slot}
            value={answers[slot.key]}
            correct={corrects?.[slot.key]}
            onChange={onMark ? (value) => onMark(slot, value) : undefined}
          />
        </div>
      ))}
    </div>
  );
}

export function Loading({ text = '読み込んでいます…' }: { text?: string }) {
  return <p className="muted center-pad">{text}</p>;
}
