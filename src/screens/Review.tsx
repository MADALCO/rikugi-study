import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { PdfView } from '../components/PdfView';
import { ReflowView } from '../components/ReflowView';
import { Loading, QuestionMarks, useCompact } from '../components/Sheet';
import {
  allAttempts,
  allResolved,
  getCatalog,
  getKey,
  getPdf,
  markResolved,
  saveAttempt,
  type Attempt,
  type Catalog,
} from '../lib/db';
import { getSubject, questionsFor, SUBJECTS, type Slot, type SubjectId } from '../lib/exam';
import { buildReviewItems, type ReviewItem } from '../lib/review';
import type { Answers } from '../lib/scoring';

interface ReviewData {
  items: ReviewItem[];
  catalog: Catalog | null;
  attempts: Attempt[];
  keys: Map<string, Answers>;
}

async function loadReview(): Promise<ReviewData> {
  const [attempts, resolved, catalog] = await Promise.all([allAttempts(), allResolved(), getCatalog()]);
  const keys = new Map<string, Answers>();
  for (const attempt of attempts) {
    const id = `${attempt.examId}/${attempt.subject}`;
    if (keys.has(id)) continue;
    const key = await getKey(attempt.examId, attempt.subject);
    if (key) keys.set(id, key);
  }
  const items = buildReviewItems(attempts, resolved, (examId, subject) => keys.get(`${examId}/${subject}`));
  return { items, catalog, attempts, keys };
}

const examLabel = (catalog: Catalog | null, examId: string) =>
  catalog?.exams.find((exam) => exam.id === examId)?.label ?? examId;

export function Review() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [filter, setFilter] = useState<SubjectId | 'all'>('all');

  useEffect(() => {
    void loadReview().then(setData);
  }, []);

  if (!data) return <Loading />;
  const shown = data.items.filter((item) => filter === 'all' || item.subject === filter);

  return (
    <>
      <header className="page-head">
        <h1>復習</h1>
        <p className="muted">間違えた問題と★を付けた問題</p>
      </header>

      <div className="chips" role="group" aria-label="科目で絞り込み">
        <button type="button" className={filter === 'all' ? 'chip chip-on' : 'chip'} onClick={() => setFilter('all')}>
          すべて
        </button>
        {SUBJECTS.map((subject) => (
          <button
            key={subject.id}
            type="button"
            className={filter === subject.id ? 'chip chip-on' : 'chip'}
            onClick={() => setFilter(subject.id)}
          >
            {subject.shortName}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <section className="empty">
          <p>復習する問題はありません。過去問を解いて採点すると、ここに並びます。</p>
        </section>
      ) : (
        <ul className="review-list">
          {shown.map((item) => (
            <li key={item.ref}>
              <a href={`#/review/${encodeURIComponent(item.ref)}`}>
                <span className="q-id">{item.questionId}</span>
                <span className="review-where">
                  {examLabel(data.catalog, item.examId)} {getSubject(item.subject).shortName}
                </span>
                {item.reason !== 'wrong' && <span className="star-mini">★</span>}
                {item.reason !== 'flag' && <span className="tag tag-wrong">間違い</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ReviewDetail({ itemRef }: { itemRef: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pdfFile, setPdfFile] = useState('');
  const compact = useCompact();
  const [answers, setAnswers] = useState<Answers>({});
  const [judged, setJudged] = useState<boolean | null>(null);

  const [examId, subjectText, questionId] = itemRef.split('/');
  const subjectId = subjectText as SubjectId;
  const subject = getSubject(subjectId);
  const questionIndex = useMemo(() => questionsFor(subject).findIndex((candidate) => candidate.id === questionId), [subject, questionId]);
  const question = questionIndex >= 0 ? questionsFor(subject)[questionIndex] : undefined;

  useEffect(() => {
    void (async () => {
      const loaded = await loadReview();
      const file = loaded.catalog?.exams.find((exam) => exam.id === examId)?.subjects[subjectId]?.question;
      if (file) {
        setPdfFile(file);
        setPdf(await getPdf(file));
      }
      setData(loaded);
    })();
  }, [examId, subjectId]);

  if (!data) return <Loading />;
  const position = data.items.findIndex((item) => item.ref === itemRef);
  const item = data.items[position];
  const key = data.keys.get(`${examId}/${subjectId}`);
  if (!question || !key || !pdf) {
    return (
      <div className="center-pad">
        <p>この問題は開けません。</p>
        <a className="btn" href="#/review">
          復習へ戻る
        </a>
      </div>
    );
  }

  const nextItem = position >= 0 ? data.items[position + 1] : undefined;
  const allFilled = question.slots.every((slot) => answers[slot.key] !== undefined);

  const judge = async (current: Answers) => {
    const ok = question.slots.every((slot) => current[slot.key] === key[slot.key]);
    setJudged(ok);
    if (ok) await markResolved(itemRef);
  };

  const mark = (slot: Slot, value: number | undefined) => {
    const next = { ...answers };
    if (value === undefined) delete next[slot.key];
    else next[slot.key] = value;
    setAnswers(next);
    setJudged(null);
    if (question.type === 'A' && value !== undefined) void judge(next);
  };

  const latestWithFlag = data.attempts
    .filter((attempt) => attempt.examId === examId && attempt.subject === subjectId && attempt.status === 'finished')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];

  const unflag = async () => {
    if (!latestWithFlag) return;
    const flags = { ...latestWithFlag.flags };
    delete flags[question.id];
    await saveAttempt({ ...latestWithFlag, flags });
    navigate('review');
  };

  return (
    <div className="work work-review">
      <div className="work-bar">
        <a className="link-back" href="#/review">
          ‹ 復習
        </a>
        <span className="work-title">
          {examLabel(data.catalog, examId)} {subject.shortName} {question.id}
        </span>
      </div>
      <div className="work-body">
        {compact && pdfFile ? (
          <ReflowView data={pdf} file={pdfFile} subject={subject} questionIndex={questionIndex} fallbackPage={item?.page ?? 1} />
        ) : (
          <PdfView data={pdf} initialPage={item?.page ?? 1} />
        )}
        <aside className="side side-review" aria-label="解き直し">
          <QuestionMarks
            question={question}
            answers={answers}
            onMark={mark}
            corrects={judged === false ? key : undefined}
          />
          {judged === true && <p className="judge judge-ok">正解です</p>}
          {judged === false && <p className="judge judge-ng">不正解。正答は緑の番号です。</p>}
          <div className="actions">
            {question.type === 'B' && (
              <button type="button" className="btn btn-primary" disabled={!allFilled} onClick={() => void judge(answers)}>
                判定する
              </button>
            )}
            {nextItem && (
              <a className="btn" href={`#/review/${encodeURIComponent(nextItem.ref)}`}>
                次の問題 ›
              </a>
            )}
            {item && item.reason !== 'wrong' && (
              <button type="button" className="btn" onClick={() => void unflag()}>
                ★を外す
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
