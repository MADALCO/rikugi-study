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
import { isKeyComplete, scoreAnswers, type Answers } from '../lib/scoring';
import { getGradeMode } from '../lib/gradeMode';
import { readAnswerKey } from '../lib/answerReaderPdf';
import { openPdf } from '../lib/reflowPdf';

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
  const gradeMode = useMemo(() => getGradeMode(), []);
  // 1問ごとに採点するモードで、前回の解答が残っている回を開いたときは、続きから解くか最初から解き直すかを選ぶ。
  const [askResume, setAskResume] = useState(false);
  const [timerKey, setTimerKey] = useState(0);
  // 1問ごとの答え合わせに使う正答。登録済みの正答がなければ、解答PDFの表を自動で読み取ったものを使う。
  const [key, setKey] = useState<{ answers: Answers; auto: boolean; uncertain: Set<string> } | null>(null);
  const [keyState, setKeyState] = useState<'loading' | 'ready' | 'none'>('loading');

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
      if (getGradeMode() === 'each' && Object.keys(active.answers).length > 0) setAskResume(true);
    })();
  }, [examId, subjectId]);

  useEffect(() => {
    if (gradeMode !== 'each') return;
    let cancelled = false;
    void (async () => {
      const saved = await getKey(examId, subjectId);
      if (saved && Object.keys(saved).length > 0) {
        if (!cancelled) {
          setKey({ answers: saved, auto: false, uncertain: new Set() });
          setKeyState('ready');
        }
        return;
      }
      const catalog = await getCatalog();
      const file = catalog?.exams.find((candidate) => candidate.id === examId)?.subjects[subjectId]?.answer;
      const bytes = file ? await getPdf(file) : null;
      if (!bytes) {
        if (!cancelled) setKeyState('none');
        return;
      }
      const handle = openPdf(bytes);
      try {
        const result = await readAnswerKey(await handle.promise, subject);
        if (cancelled) return;
        if (result.ok) {
          setKey({ answers: result.autoKey.key, auto: true, uncertain: new Set(result.autoKey.uncertain) });
          setKeyState('ready');
        } else setKeyState('none');
      } catch {
        if (!cancelled) setKeyState('none');
      } finally {
        handle.destroy();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [examId, subjectId, subject, gradeMode]);

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
    // 選んでも次の問題へは進まない(迷いながら仮に選ぶことがあるため)。
  };

  /** 解答と答え合わせの結果を消して、最初から解き直す(★と時間も最初から)。 */
  const restart = () => {
    update((draft) => {
      draft.answers = {};
      draft.checked = {};
      draft.elapsedSec = 0;
      draft.startedAt = Date.now();
    });
    setTimerKey((value) => value + 1);
    setCurrentIndex(0);
    setAskResume(false);
  };

  /** 答え合わせを済ませた1問だけを、解く前の状態に戻す。 */
  const retry = (question: Question) =>
    update((draft) => {
      for (const slot of question.slots) delete draft.answers[slot.key];
      if (draft.checked) {
        draft.checked = { ...draft.checked };
        delete draft.checked[question.id];
      }
    });

  const isChecked = (question: Question) => Boolean(attempt?.checked?.[question.id]);
  const canGrade = (question: Question) => Boolean(key && question.slots.every((slot) => key.answers[slot.key] !== undefined));
  const resultOf = (question: Question) => {
    if (!key || !attempt) return null;
    const ok = question.slots.filter((slot) => attempt.answers[slot.key] === key.answers[slot.key]).length;
    return { ok, total: question.slots.length };
  };
  const check = (question: Question) =>
    update((draft) => {
      draft.checked = { ...(draft.checked ?? {}), [question.id]: true };
      draft.pageOf[question.id] = pageRef.current;
    });

  /** 1問ごとの答え合わせの欄(「採点する」ボタンと結果)。 */
  const judgeRow = (question: Question) => {
    if (gradeMode !== 'each') return null;
    if (isChecked(question)) {
      const result = resultOf(question);
      if (!result) return null;
      const all = result.ok === result.total;
      const correctText = question.type === 'A' ? `正解は ${key!.answers[question.slots[0].key]}` : `${result.ok}/${result.total}欄正解`;
      const unsure = key!.auto && question.slots.some((slot) => key!.uncertain.has(slot.key));
      return (
        <div className="judge" role="status">
          <span className={all ? 'judge-ok' : 'judge-ng'}>{all ? '○ 正解' : '× 不正解'}</span>
          <span className="muted">{correctText}{unsure ? '(正答は自動読み取りのため要確認)' : ''}</span>
          <button type="button" className="btn btn-small" onClick={() => retry(question)}>
            解き直す
          </button>
        </div>
      );
    }
    if (keyState === 'loading') return <div className="judge muted">正答を準備しています…</div>;
    if (!canGrade(question)) return <div className="judge muted">この回は正答を読み取れないため、提出後にまとめて採点します。</div>;
    const answered = question.slots.every((slot) => attempt?.answers[slot.key] !== undefined);
    return (
      <div className="judge">
        <button type="button" className="btn" disabled={!answered} onClick={() => check(question)}>
          採点する
        </button>
      </div>
    );
  };

  /** 答え合わせを済ませた問題は、正答を示して解答を変えられないようにする。 */
  const marks = (question: Question) => {
    const done = gradeMode === 'each' && isChecked(question) && key;
    return (
      <QuestionMarks
        question={question}
        answers={attempt!.answers}
        corrects={done ? key!.answers : undefined}
        judge={Boolean(done)}
        onMark={done ? undefined : (slot, value) => mark(question, slot, value)}
      />
    );
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
      <Timer key={timerKey} attemptRef={attemptRef} limitSec={subject.minutes * 60} onSave={persist} />
    </div>
  );

  const resumeBanner = askResume ? (
    <div className="notice resume" role="dialog" aria-label="前回の解答">
      <span>前回の解答が残っています({answered}/{questions.length}問)。</span>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => setAskResume(false)}>
          続きから解く
        </button>
        <button type="button" className="btn" onClick={restart}>
          最初から解き直す
        </button>
      </div>
    </div>
  ) : null;

  const grid = (
    <div className="qgrid">
      {questions.map((question, index) => {
        const classes = ['qchip'];
        if (isAnswered(question, attempt)) classes.push('qchip-done');
        if (gradeMode === 'each' && isChecked(question)) {
          const result = resultOf(question);
          if (result) classes.push(result.ok === result.total ? 'qchip-ok' : 'qchip-ng');
        }
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
        {resumeBanner}
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
            <>
              {marks(current)}
              {judgeRow(current)}
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="work work-wide">
      {topBar}
      {resumeBanner}
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
                {marks(question)}
                {judgeRow(question)}
              </div>
            ))}
          </div>
          <div className="side-foot">{submitButton}</div>
        </aside>
      </div>
    </div>
  );
}
