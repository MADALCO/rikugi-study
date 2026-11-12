import { useEffect, useState } from 'react';
import type { SubjectId } from './lib/exam';
import { Library } from './screens/Library';
import { Practice } from './screens/Practice';
import { Check } from './screens/Check';
import { Result } from './screens/Result';
import { Review, ReviewDetail } from './screens/Review';
import { Stats } from './screens/Stats';
import { Settings } from './screens/Settings';

function useHashPath(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [path, setPath] = useState(read);
  useEffect(() => {
    const onChange = () => setPath(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export function navigate(...parts: string[]): void {
  window.location.hash = `/${parts.map(encodeURIComponent).join('/')}`;
}

const TABS = [
  { path: '', label: '過去問' },
  { path: 'review', label: '復習' },
  { path: 'stats', label: '成績' },
  { path: 'settings', label: '設定' },
];

function TabBar({ current }: { current: string }) {
  return (
    <nav className="tabbar" aria-label="メインメニュー">
      {TABS.map((tab) => (
        <a key={tab.path} href={`#/${tab.path}`} className={tab.path === current ? 'tab tab-on' : 'tab'}>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export function App() {
  const path = useHashPath();
  const [head, a, b] = path;

  // 問題を解く画面は全画面で使うため、下部メニューを出さない。
  if (head === 'exam' && a && b) return <Practice key={`${a}/${b}`} examId={a} subjectId={b as SubjectId} />;
  if (head === 'check' && a) return <Check key={a} attemptId={a} />;
  if (head === 'review' && a) return <ReviewDetail key={a} itemRef={a} />;

  let screen = <Library />;
  if (head === 'result' && a) screen = <Result key={a} attemptId={a} />;
  if (head === 'review') screen = <Review />;
  if (head === 'stats') screen = <Stats />;
  if (head === 'settings') screen = <Settings />;

  return (
    <div className="shell">
      <main className="page">{screen}</main>
      <TabBar current={head === 'result' ? '' : (head ?? '')} />
    </div>
  );
}
