import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { cleanupStorage } from './lib/db';
import './styles.css';

registerSW({ immediate: true });
// 古い版の切り分けデータなど、使わなくなったデータを起動時に消す(読み込むたびに容量が増えないように)。
void cleanupStorage().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
