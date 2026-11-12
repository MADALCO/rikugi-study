import { useEffect, useState } from 'react';
import { Loading } from '../components/Sheet';
import { allAttempts, getCatalog, type Attempt, type Catalog } from '../lib/db';
import { SUBJECTS, type Subject } from '../lib/exam';

const WIDTH = 320;
const HEIGHT = 130;
const PAD = { left: 30, right: 26, top: 10, bottom: 10 };

const examLabel = (catalog: Catalog | null, examId: string) =>
  catalog?.exams.find((exam) => exam.id === examId)?.label ?? examId;

function ScoreChart({ subject, attempts, catalog }: { subject: Subject; attempts: Attempt[]; catalog: Catalog | null }) {
  const [active, setActive] = useState<number | null>(null);
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const xOf = (index: number) => PAD.left + (attempts.length === 1 ? innerWidth / 2 : (index / (attempts.length - 1)) * innerWidth);
  const yOf = (points: number) => PAD.top + innerHeight * (1 - points / subject.maxScore);
  const line = attempts.map((attempt, index) => `${index === 0 ? 'M' : 'L'}${xOf(index)},${yOf(attempt.points ?? 0)}`).join(' ');
  const last = attempts[attempts.length - 1];
  const shown = active !== null ? attempts[active] : null;

  return (
    <div className="chart" onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${subject.name}の得点推移。直近は${last.points}点`}>
        <line className="grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(0)} y2={yOf(0)} />
        <line className="grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(subject.maxScore)} y2={yOf(subject.maxScore)} />
        <line className="pass-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(subject.passScore)} y2={yOf(subject.passScore)} />
        <text className="axis" x={PAD.left - 5} y={yOf(0)} textAnchor="end" dominantBaseline="middle">0</text>
        <text className="axis" x={PAD.left - 5} y={yOf(subject.maxScore)} textAnchor="end" dominantBaseline="middle">{subject.maxScore}</text>
        <text className="axis" x={PAD.left - 5} y={yOf(subject.passScore)} textAnchor="end" dominantBaseline="middle">{subject.passScore}</text>
        {attempts.length > 1 && <path className="series" d={line} />}
        {attempts.map((attempt, index) => (
          <g key={attempt.id} onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
            <circle className="dot" cx={xOf(index)} cy={yOf(attempt.points ?? 0)} r={active === index ? 5.5 : 4} />
            <circle className="hit" cx={xOf(index)} cy={yOf(attempt.points ?? 0)} r={16} />
          </g>
        ))}
        <text className="value" x={xOf(attempts.length - 1) + 8} y={yOf(last.points ?? 0)} dominantBaseline="middle">
          {last.points}
        </text>
      </svg>
      <p className="chart-note">
        {shown
          ? `${examLabel(catalog, shown.examId)} ・ ${shown.points}点 ・ ${new Date(shown.finishedAt ?? 0).toLocaleDateString('ja-JP')}`
          : `破線は合格点(${subject.passScore}点)`}
      </p>
    </div>
  );
}

function SubjectCard({ subject, attempts, catalog }: { subject: Subject; attempts: Attempt[]; catalog: Catalog | null }) {
  if (attempts.length === 0) {
    return (
      <section className="stat-card">
        <h2>{subject.name}</h2>
        <p className="muted">まだ採点した記録がありません。</p>
      </section>
    );
  }
  const scores = attempts.map((attempt) => attempt.points ?? 0);
  const passed = scores.filter((score) => score >= subject.passScore).length;
  return (
    <section className="stat-card">
      <h2>{subject.name}</h2>
      <dl className="tiles">
        <div>
          <dt>最高</dt>
          <dd>{Math.max(...scores)}</dd>
        </div>
        <div>
          <dt>直近</dt>
          <dd>{scores[scores.length - 1]}</dd>
        </div>
        <div>
          <dt>合格点以上</dt>
          <dd>
            {passed}/{scores.length}
          </dd>
        </div>
      </dl>
      <ScoreChart subject={subject} attempts={attempts} catalog={catalog} />
      <details className="data-table">
        <summary>表で見る</summary>
        <table>
          <tbody>
            {[...attempts].reverse().map((attempt) => (
              <tr key={attempt.id}>
                <th scope="row">
                  <a href={`#/result/${encodeURIComponent(attempt.id)}`}>{examLabel(catalog, attempt.examId)}</a>
                </th>
                <td>{new Date(attempt.finishedAt ?? 0).toLocaleDateString('ja-JP')}</td>
                <td className="digits">{attempt.points}点</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function Stats() {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    void (async () => {
      setCatalog(await getCatalog());
      const finished = (await allAttempts()).filter((attempt) => attempt.status === 'finished' && attempt.points !== null);
      setAttempts(finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)));
    })();
  }, []);

  if (!attempts) return <Loading />;

  return (
    <>
      <header className="page-head">
        <h1>成績</h1>
      </header>
      <div className="stat-grid">
        {SUBJECTS.map((subject) => (
          <SubjectCard
            key={subject.id}
            subject={subject}
            attempts={attempts.filter((attempt) => attempt.subject === subject.id)}
            catalog={catalog}
          />
        ))}
      </div>
    </>
  );
}
