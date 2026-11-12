import { useEffect, useState } from 'react';
import { allAttempts, getCatalog, getLastBackupAt, type Attempt, type Catalog } from '../lib/db';
import { daysUntil, NEXT_EXAM_DATE, SUBJECTS, type Subject } from '../lib/exam';
import { Loading } from '../components/Sheet';

const BACKUP_REMINDER_DAYS = 14;

function ScoreCell({ examId, subject, available, attempts }: { examId: string; subject: Subject; available: boolean; attempts: Attempt[] }) {
  if (!available) return <span className="cell cell-none">なし</span>;
  const mine = attempts.filter((attempt) => attempt.examId === examId && attempt.subject === subject.id);
  const inProgress = mine.some((attempt) => attempt.status !== 'finished');
  const best = mine.reduce<number | null>(
    (max, attempt) => (attempt.points !== null && attempt.status === 'finished' ? Math.max(max ?? 0, attempt.points) : max),
    null,
  );
  const classes = ['cell'];
  if (best !== null) classes.push(best >= subject.passScore ? 'cell-pass' : 'cell-fail');
  return (
    <a className={classes.join(' ')} href={`#/exam/${encodeURIComponent(examId)}/${subject.id}`} aria-label={`${subject.name}を解く`}>
      {best !== null ? best : '未'}
      {inProgress && <span className="cell-tag">途中</span>}
    </a>
  );
}

export function Library() {
  const [catalog, setCatalog] = useState<Catalog | null | undefined>(undefined);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [needsBackup, setNeedsBackup] = useState(false);

  useEffect(() => {
    void (async () => {
      const [loadedCatalog, loadedAttempts, lastBackup] = await Promise.all([getCatalog(), allAttempts(), getLastBackupAt()]);
      setCatalog(loadedCatalog);
      setAttempts(loadedAttempts);
      const oldest = lastBackup ?? loadedAttempts.reduce((min, attempt) => Math.min(min, attempt.startedAt), Date.now());
      setNeedsBackup(loadedAttempts.length > 0 && Date.now() - oldest > BACKUP_REMINDER_DAYS * 86400000);
    })();
  }, []);

  if (catalog === undefined) return <Loading />;

  const days = daysUntil(NEXT_EXAM_DATE);

  return (
    <>
      <header className="page-head">
        <h1>一陸技 過去問</h1>
        {days >= 0 && (
          <p className="countdown">
            次回試験まで <strong>{days}</strong> 日
          </p>
        )}
      </header>

      {needsBackup && (
        <a className="notice" href="#/settings">
          前回のバックアップから{BACKUP_REMINDER_DAYS}日以上たちました。設定から学習記録を書き出してください。
        </a>
      )}

      {!catalog ? (
        <section className="empty">
          <h2>過去問を読み込みましょう</h2>
          <p>Macで作った過去問ライブラリ(ZIP)を読み込むと、ここに一覧が表示されます。</p>
          <a className="btn btn-primary" href="#/settings">
            ライブラリを読み込む
          </a>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="library">
            <thead>
              <tr>
                <th scope="col">試験回</th>
                {SUBJECTS.map((subject) => (
                  <th key={subject.id} scope="col">
                    {subject.shortName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catalog.exams.map((exam) => (
                <tr key={exam.id}>
                  <th scope="row">{exam.label}</th>
                  {SUBJECTS.map((subject) => (
                    <td key={subject.id}>
                      <ScoreCell
                        examId={exam.id}
                        subject={subject}
                        available={Boolean(exam.subjects[subject.id]?.question)}
                        attempts={attempts}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
