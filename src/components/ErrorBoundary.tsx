import { Component, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

/** 予期しない例外で画面全体が真っ白になるのを防ぐ。解答は操作のたびに保存済みなので、再読み込みで続きから戻れる。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-pad">
        <p>表示中に問題が起きました。解答は保存されています。</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          再読み込み
        </button>
      </div>
    );
  }
}
