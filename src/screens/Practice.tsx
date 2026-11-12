import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { PdfView } from '../components/PdfView';
import { ReflowView } from '../components/ReflowView';
import { Loading, QuestionMarks, useCompact } from '../components/Sheet';
import {
  getCatalog,
  getKey,
  getOrCreateActiveAttempt,
  getPdf,
  saveAttempt,
  type Attempt,
} from '../lib/db';
import { allSlots, formatDuration, getSubject, questionsFor, type Question, type Slot, type SubjectId } from '../lib/exam';
import { isKeyComplete, scoreAnswers } from '../lib/scoring';

const SAVE_EVERY_SEC = 15;

function Timer({ attemptRef, limitSec, onSave }: { attemptRef: React.MutableRefObject<Attempt | null>; limitSec: number; onSave: () => void }) {
  const [remaining, setRemaining] = useState(() => limitSec - (attemptRef.current?.elapsedSec ?? 0));
  useEffect(() => {
    const id = window.setInterval(() => {
      const attempt = attemptRef.current;
      if (!attempt || document.hidden) return;
      attempt.elapsedSec += 1;
      setRemaining(limitSec - attempt.elapsedSec);
      if (attempt.elapsedSec % SAVE_EVERY_SEC === 0) onSave();
    }, 1000);
    return () => window.clearInterval(id);
  }, [attemptRef, limitSec, onSave]);
  return (
    <span className={remaining <= 0 ? 'timer timer-over' : 'timer'} role="timer">
      {remaining <= 0 ? `超過 ${formatDuration(-remaining)}` : formatDuration(remaining)}
    </span>
  );
}

function isAnswered(question: Question, attempt: Attempt): boolean {
  return question.slots.every((slot) => attempt.answers[slot.key] !== undefined);
}

export function Practice({ examId, subjectId }: { examId: string; subjectId: SubjectId }) {
  const subject = getSubject(subjectId);
  const questions = useMemo(() => questionsFor(subject), [subject]);
  const compact = useCompact();

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pdfFile, setPdfFile] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const pageRef = useRef(1);

  useEffect(() => {
    void (async () => {
      const catalog = await getCatalog();
      const exam = catalog?.exams.find((candidate) => candidate.id === examId);
      const file = exam?.subjects[subjectId]?.question;
      if (!exam || !file) {
        setProblem('この回の問題PDFが見つかりません。');
        return;
      }
      setTitle(exam.label);
      setPdfFile(file);
      const bytes = await getPdf(file);
      if (!bytes) {
        setProblem('PDFが保存されていません。設定からライブラリを読み込み直してください。');
        return;
      }
      const active = await getOrCreateActiveAttempt(examId, subjectId);
      attemptRef.current = active;
      setAttempt(active);
      setPdf(bytes);
    })();
  }, [examId, subjectId]);

  const persist = useCallback(() => {
    if (attemptRef.current) void saveAttempt(attemptRef.current);
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.hidden) persist();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      persist();
    };
  }, [persist]);

  const update = (change: (draft: Attempt) => void) => {
    const current = attemptRef.current;
    if (!current) return;
    const next: Attempt = {
      ...current,
      answers: { ...current.answers },
      flags: { ...current.flags },
      pageOf: { ...current.pageOf },
    };
    change(next);
    attemptRef.current = next;
    setAttempt(next);
    void saveAttempt(next);
  };

  const mark = (question: Question, slot: Slot, value: number | undefined) => {
    update((draft) => {
      if (value === undefined) delete draft.answers[slot.key];
      else draft.answers[slot.key] = value;
      draft.pageOf[question.id] = pageRef.current;
    });
    // スマホは1問ずつ表示するので、A問題は選んだら次へ進む。
    if (compact && question.type === 'A' && value !== undefined) {
      setCurrentIndex((index) => Math.min(index + 1, questions.length - 1));
    }
  };

  const onPageChange = useCallback((page: number) => {
    pageRef.current = page;
  }, []);

  const submit = async () => {
    const current = attemptRef.current;
    if (!current) return;
    const unanswered = allSlots(subject).filter((slot) => current.answers[slot.key] === undefined).length;
    const message = unanswered > 0 ? `未解答が${unanswered}欄あります。提出しますか？` : '提出して採点に進みますか？';
    if (!window.confirm(message)) return;

    const key = await getKey(examId, subjectId);
    if (isKeyComplete(subject, key)) {
      const scored: Attempt = {
        ...current,
        status: 'finished',
        finishedAt: Date.now(),
        points: scoreAnswers(subject, current.answers, key!).points,
      };
      attemptRef.current = scored;
      await saveAttempt(scored);
      navigate('result', scored.id);
    } else {
      const submitted: Attempt = { ...current, status: 'submitted' };
      attemptRef.current = submitted;
      await saveAttempt(submitted);
      navigate('check', submitted.id);
    }
  };

  if (problem) {
    return (
      <div className="center-pad">
        <p>{problem}</p>
        <a className="btn" href="#/">
          一覧へ戻る
        </a>
      </div>
    );
  }
  if (!attempt || !pdf) return <Loading />;

  const answered = questions.filter((question) => isAnswered(question, attempt)).length;
  const current = questions[currentIndex];

  const topBar = (
    <div className="work-bar">
      <a className="link-back" href="#/" onClick={persist} aria-label="一覧へ戻る(途中保存されます)">
        ‹ 一覧
      </a>
      <span className="work-title">
        {title} {subject.shortName}
      </span>
      <Timer attemptRef={attemptRef} limitSec={subject.minutes * 60} onSave={persist} />
    </div>
  );

  const grid = (
    <div className="qgrid">
      {questions.map((question, index) => {
        const classes = ['qchip'];
        if (isAnswered(question, attempt)) classes.push('qchip-done');
        if (index === currentIndex) classes.push('qchip-now');
        return (
          <button
            key={question.id}
            type="button"
            className={classes.join(' ')}
            onClick={() => {
              setCurrentIndex(index);
              setShowGrid(false);
            }}
          >
            {question.id}
            {attempt.flags[question.id] && <span className="star-mini">★</span>}
          </button>
        );
      })}
    </div>
  );

  const flagButton = (question: Question) => (
    <button
      type="button"
      className={attempt.flags[question.id] ? 'flag flag-on' : 'flag'}
      aria-pressed={Boolean(attempt.flags[question.id])}
      aria-label={`${question.id}をあとで見直す`}
      onClick={() =>
        update((draft) => {
          if (draft.flags[question.id]) delete draft.flags[question.id];
          else draft.flags[question.id] = true;
          draft.pageOf[question.id] = pageRef.current;
        })
      }
    >
      ★
    </button>
  );

  const submitButton = (
    <button type="button" className="btn btn-primary btn-wide" onClick={() => void submit()}>
      提出する({answered}/{questions.length}問)
    </button>
  );

  if (compact) {
    return (
      <div className="work work-compact">
        {topBar}
        <ReflowView data={pdf} file={pdfFile} subject={subject} questionIndex={currentIndex} onPageChange={onPageChange} />
        <section className="dock" aria-label="解答欄">
          <div className="dock-head">
            <button type="button" className="icon-btn" aria-label="前の問題" disabled={currentIndex === 0} onClick={() => setCurrentIndex(currentIndex - 1)}>
              ‹
            </button>
            <button type="button" className="dock-title" aria-expanded={showGrid} onClick={() => setShowGrid(!showGrid)}>
              {current.id} <span className="muted">{answered}/{questions.length} ▾</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="次の問題"
              disabled={currentIndex === questions.length - 1}
              onClick={() => setCurrentIndex(currentIndex + 1)}
            >
              ›
            </button>
            {flagButton(current)}
          </div>
          {showGrid ? (
            <div className="dock-more">
              {grid}
              {submitButton}
            </div>
          ) : (
            <QuestionMarks question={current} answers={attempt.answers} onMark={(slot, value) => mark(current, slot, value)} />
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="work work-wide">
      {topBar}
      <div className="work-body">
        <PdfView data={pdf} onPageChange={onPageChange} />
        <aside className="side" aria-label="解答欄">
          <div className="side-list">
            {questions.map((question, index) => (
              <div
                key={question.id}
                className={index === currentIndex ? 'side-q side-q-now' : 'side-q'}
                onClickCapture={() => setCurrentIndex(index)}
              >
                <div className="side-q-head">
                  <span className="q-id">{question.id}</span>
                  {flagButton(question)}
                </div>
                <QuestionMarks question={question} answers={attempt.answers} onMark={(slot, value) => mark(question, slot, value)} />
              </div>
            ))}
          </div>
          <div className="side-foot">{submitButton}</div>
        </aside>
      </div>
    </div>
  );
}
