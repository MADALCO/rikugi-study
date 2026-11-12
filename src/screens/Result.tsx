import { useEffect, useState } from 'react';
import { Loading } from '../components/Sheet';
import { getAttempt, getCatalog, getKey, type Attempt } from '../lib/db';
import { formatDuration, getSubject } from '../lib/exam';
import { scoreAnswers, type Answers } from '../lib/scoring';

export function Result({ attemptId }: { attemptId: string }) {
  const [attempt, setAttempt] = useState<Attempt | null | undefined>(undefined);
  const [key, setKey] = useState<Answers | undefined>();
  const [label, setLabel] = useState('');

  useEffect(() => {
    void (async () => {
      const loaded = await getAttempt(attemptId);
      if (loaded) {
        setKey(await getKey(loaded.examId, loaded.subject));
        const catalog = await getCatalog();
        setLabel(catalog?.exams.find((exam) => exam.id === loaded.examId)?.label ?? loaded.examId);
      }
      setAttempt(loaded ?? null);
    })();
  }, [attemptId]);

  if (attempt === undefined) return <Loading />;
  if (attempt === null || !key) return <p className="center-pad">採点結果が見つかりません。</p>;

  const subject = getSubject(attempt.subject);
  const result = scoreAnswers(subject, attempt.answers, key);
  const wrong = result.questions.filter((question) => !question.allCorrect).length;

  return (
    <>
      <header className="page-head">
        <h1>
          {label} {subject.name}
        </h1>
      </header>

      <section className={result.passed ? 'verdict verdict-pass' : 'verdict verdict-fail'}>
        <p className="verdict-label">{result.passed ? '合格点に到達' : `合格点まであと${result.passScore - result.points}点`}</p>
        <p className="verdict-score">
          <strong>{result.points}</strong> / {result.maxScore}点
        </p>
        <p className="muted">
          合格点 {result.passScore}点 ・ 解答時間 {formatDuration(attempt.elapsedSec)} ・ 間違い {wrong}問
        </p>
      </section>

      <div className="actions">
        {wrong > 0 && (
          <a className="btn btn-primary" href="#/review">
            間違いを復習
          </a>
        )}
        <a className="btn" href={`#/exam/${encodeURIComponent(attempt.examId)}/${attempt.subject}`}>
          もう一度解く
        </a>
        <a className="btn" href={`#/check/${encodeURIComponent(attempt.id)}`}>
          正答を修正
        </a>
      </div>

      <table className="result-table">
        <thead>
          <tr>
            <th scope="col">問題</th>
            <th scope="col">得点</th>
            <th scope="col">あなた</th>
            <th scope="col">正答</th>
          </tr>
        </thead>
        <tbody>
          {result.questions.map((question) => (
            <tr key={question.id} className={question.allCorrect ? '' : 'row-wrong'}>
              <th scope="row">{question.id}</th>
              <td>
                <span className={question.allCorrect ? 'mark-ok' : 'mark-ng'}>{question.allCorrect ? '○' : '×'}</span> {question.earned}/{question.max}
              </td>
              <td className="digits">{question.slots.map((slot) => slot.answer ?? '−').join(' ')}</td>
              <td className="digits">{question.slots.map((slot) => slot.correct ?? '−').join(' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
