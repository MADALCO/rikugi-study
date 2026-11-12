import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { PdfView } from '../components/PdfView';
import { Loading, QuestionMarks } from '../components/Sheet';
import { readAnswerKey } from '../lib/answerReaderPdf';
import { getAttempt, getCatalog, getKey, getPdf, saveAttempt, saveKey, type Attempt } from '../lib/db';
import { allSlots, getSubject, questionsFor, type Slot } from '../lib/exam';
import { openPdf } from '../lib/reflowPdf';
import { draftKeyFrom, isKeyComplete, scoreAnswers, type Answers } from '../lib/scoring';

type Source = 'saved' | 'auto' | 'manual';

const NOTES: Record<Source, string> = {
  saved: '登録済みの正答です。必要なら修正してください。',
  auto: '解答表から自動で読み取った正答です。表と見比べ、違う欄だけ直してください。オレンジは要確認の欄です。',
  manual: '自動で読み取れませんでした。自分の解答を初期値にしているので、公式解答と違う欄だけ直してください。',
};

/**
 * 公式解答PDFを見ながら正答を登録する。未登録なら解答表を自動で読み取って初期値にし、
 * 読めなければ自分の解答を初期値にする。どちらも利用者が確認して保存するまでは採点に使わない。
 */
export function Check({ attemptId }: { attemptId: string }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [draft, setDraft] = useState<Answers>({});
  const [baseline, setBaseline] = useState<Answers>({});
  const [source, setSource] = useState<Source>('manual');
  const [uncertain, setUncertain] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const loaded = await getAttempt(attemptId);
      if (!loaded) {
        setReady(true);
        return;
      }
      const subject = getSubject(loaded.subject);
      const catalog = await getCatalog();
      const file = catalog?.exams.find((exam) => exam.id === loaded.examId)?.subjects[loaded.subject]?.answer;
      const bytes = file ? await getPdf(file) : null;
      setPdf(bytes);
      const saved = await getKey(loaded.examId, loaded.subject);
      let initial: Answers | null = null;
      if (saved) {
        initial = draftKeyFrom(subject, loaded.answers, saved);
        setSource('saved');
      } else if (bytes) {
        const handle = openPdf(bytes);
        try {
          const result = await readAnswerKey(await handle.promise, subject);
          if (result.ok) {
            initial = result.autoKey.key;
            setUncertain(new Set(result.autoKey.uncertain));
            setSource('auto');
          }
        } catch {
          // 読み取れなければ手入力に切り替える
        } finally {
          handle.destroy();
        }
      }
      initial ??= draftKeyFrom(subject, loaded.answers);
      setDraft(initial);
      setBaseline(initial);
      setAttempt(loaded);
      setReady(true);
    })();
  }, [attemptId]);

  const subject = attempt ? getSubject(attempt.subject) : null;
  const questions = useMemo(() => (subject ? questionsFor(subject) : []), [subject]);

  if (!ready) return <Loading />;
  if (!attempt || !subject) {
    return (
      <div className="center-pad">
        <p>記録が見つかりません。</p>
        <a className="btn" href="#/">
          一覧へ戻る
        </a>
      </div>
    );
  }

  const slots = allSlots(subject);
  const missing = slots.filter((slot) => draft[slot.key] === undefined).length;
  // 修正の印は、画面を開いたときの初期値(自動読み取りまたは自分の解答)からの変更に付ける。
  const edited = (slot: Slot) => draft[slot.key] !== baseline[slot.key];
  const unsure = (slot: Slot) => uncertain.has(slot.key) && !edited(slot);
  const editedCount = slots.filter(edited).length;

  const setSlot = (slot: Slot, value: number | undefined) => {
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined) delete next[slot.key];
      else next[slot.key] = value;
      return next;
    });
  };

  const finish = async () => {
    if (!isKeyComplete(subject, draft)) return;
    setSaving(true);
    await saveKey(attempt.examId, attempt.subject, draft);
    await saveAttempt({
      ...attempt,
      status: 'finished',
      finishedAt: attempt.finishedAt ?? Date.now(),
      points: scoreAnswers(subject, attempt.answers, draft).points,
    });
    navigate('result', attempt.id);
  };

  return (
    <div className="work work-check">
      <div className="work-bar">
        <span className="work-title">答え合わせ {subject.shortName}</span>
      </div>
      <div className="work-body">
        {pdf ? <PdfView data={pdf} /> : <p className="pdf-message">この回の解答PDFはありません。手元の解答を見て入力してください。</p>}
        <aside className="side" aria-label="正答の入力">
          <p className={source === 'auto' ? 'side-note side-note-auto' : 'side-note'}>
            {NOTES[source]}
          </p>
          <div className="side-list">
            {questions.map((question) => {
              const changed = question.slots.some(edited);
              const blank = question.slots.some((slot) => draft[slot.key] === undefined);
              const doubtful = question.slots.some(unsure);
              const classes = ['side-q'];
              if (changed) classes.push('side-q-edited');
              if (doubtful) classes.push('side-q-unsure');
              if (blank) classes.push('side-q-blank');
              return (
                <div key={question.id} className={classes.join(' ')}>
                  <div className="side-q-head">
                    <span className="q-id">{question.id}</span>
                    {changed && <span className="tag">修正</span>}
                    {doubtful && <span className="tag tag-unsure">要確認</span>}
                  </div>
                  <QuestionMarks question={question} answers={draft} onMark={setSlot} edited={edited} unsure={unsure} />
                </div>
              );
            })}
          </div>
          <div className="side-foot">
            <button type="button" className="btn btn-primary btn-wide" disabled={missing > 0 || saving} onClick={() => void finish()}>
              {missing > 0
                ? `あと${missing}欄入力してください`
                : source === 'auto'
                  ? `確認したので保存して採点(修正${editedCount}欄)`
                  : `正答を保存して採点(修正${editedCount}欄)`}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
