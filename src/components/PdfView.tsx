import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_CANVAS_PIXELS = 12_000_000;
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];

export interface PdfViewHandle {
  scrollToPage(page: number): void;
}

interface PageSize {
  width: number;
  height: number;
}

// 発行元のコピー不可設定を尊重し、テキスト層を作らずcanvasへの描画だけを行う。
function PdfPage({ doc, number, size, scale }: { doc: PDFDocumentProxy; number: number; size: PageSize; scale: number }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    // rootを省略するとスクロール枠で切り取られ、先読みの余白が効かない。
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: holder.closest('.pdf-scroller'),
      rootMargin: '900px 0px',
    });
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible) {
      // iOSはcanvasの総メモリ制限が厳しいので、離れたページは解放する。
      canvas.width = 0;
      canvas.height = 0;
      setDrawn(false);
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;
    // 破棄済みの文書では getPage が同期的に例外を投げるので、Promiseの中で呼ぶ。
    void Promise.resolve().then(() => doc.getPage(number)).then((page) => {
      if (cancelled) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      let renderScale = scale * ratio;
      const pixels = size.width * size.height * renderScale * renderScale;
      if (pixels > MAX_CANVAS_PIXELS) renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale: renderScale });
      const scratch = document.createElement('canvas');
      scratch.width = Math.floor(viewport.width);
      scratch.height = Math.floor(viewport.height);
      const context = scratch.getContext('2d');
      if (!context) return;
      task = page.render({ canvasContext: context, viewport });
      task.promise
        .then(() => {
          if (cancelled) return;
          canvas.width = scratch.width;
          canvas.height = scratch.height;
          canvas.getContext('2d')?.drawImage(scratch, 0, 0);
          setDrawn(true);
          scratch.width = 0;
          scratch.height = 0;
        })
        .catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, scale, size, visible]);

  return (
    <div
      ref={holderRef}
      className="pdf-page"
      data-page={number}
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      {!drawn && <span className="pdf-page-wait">{number}ページを表示しています…</span>}
      <canvas ref={canvasRef} aria-label={`${number}ページ`} />
    </div>
  );
}

interface PdfViewProps {
  data: ArrayBuffer;
  initialPage?: number;
  onPageChange?: (page: number) => void;
}

export const PdfView = memo(
  forwardRef<PdfViewHandle, PdfViewProps>(function PdfView({ data, initialPage = 1, onPageChange }, ref) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
    const [sizes, setSizes] = useState<PageSize[]>([]);
    const [availableWidth, setAvailableWidth] = useState(0);
    const [zoomIndex, setZoomIndex] = useState(0);
    const [page, setPage] = useState(initialPage);
    const [error, setError] = useState<string | null>(null);
    const initialScrollDone = useRef(false);
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;

    useEffect(() => {
      let cancelled = false;
      const base = new URL('pdfjs/', document.baseURI).href;
      const task = pdfjs.getDocument({
        data: new Uint8Array(data.slice(0)),
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
        isEvalSupported: false,
      });
      task.promise
        .then(async (loaded) => {
          const measured: PageSize[] = [];
          for (let n = 1; n <= loaded.numPages; n++) {
            const viewport = (await loaded.getPage(n)).getViewport({ scale: 1 });
            measured.push({ width: viewport.width, height: viewport.height });
          }
          if (cancelled) return;
          setSizes(measured);
          setDoc(loaded);
        })
        .catch((reason: Error) => {
          if (!cancelled) setError(reason.message);
        });
      return () => {
        cancelled = true;
        // 破棄する文書を子ページが使い続けないよう、先に手放す。
        setDoc(null);
        void task.destroy();
      };
    }, [data]);

    useEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const observer = new ResizeObserver(() => setAvailableWidth(scroller.clientWidth));
      observer.observe(scroller);
      return () => observer.disconnect();
    }, []);

    const scrollToPage = (target: number) => {
      const scroller = scrollerRef.current;
      const element = scroller?.querySelector<HTMLElement>(`[data-page="${target}"]`);
      if (scroller && element) scroller.scrollTop = element.offsetTop - 8;
    };
    useImperativeHandle(ref, () => ({ scrollToPage }), []);

    const widest = sizes.reduce((max, size) => Math.max(max, size.width), 0);
    const scale = widest > 0 && availableWidth > 0 ? ((availableWidth - 16) / widest) * ZOOM_STEPS[zoomIndex] : 0;

    useEffect(() => {
      if (scale > 0 && !initialScrollDone.current) {
        initialScrollDone.current = true;
        requestAnimationFrame(() => scrollToPage(initialPage));
      }
    }, [scale, initialPage]);

    // ズームしても今読んでいるページから動かないようにする。
    const changeZoom = (delta: number) => {
      const current = page;
      setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + delta)));
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToPage(current)));
    };

    const onScroll = () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const middle = scroller.scrollTop + scroller.clientHeight / 2;
      for (const element of scroller.querySelectorAll<HTMLElement>('[data-page]')) {
        if (element.offsetTop + element.offsetHeight >= middle) {
          const number = Number(element.dataset.page);
          setPage((previous) => {
            if (previous !== number) onPageChangeRef.current?.(number);
            return number;
          });
          break;
        }
      }
    };

    return (
      <div className="pdf">
        <div ref={scrollerRef} className="pdf-scroller" onScroll={onScroll}>
          {error && <p className="pdf-message">PDFを開けませんでした: {error}</p>}
          {!error && !doc && <p className="pdf-message">PDFを読み込んでいます…</p>}
          {doc && scale > 0 && (
            <div className="pdf-pages">
              {sizes.map((size, index) => (
                <PdfPage key={index} doc={doc} number={index + 1} size={size} scale={scale} />
              ))}
            </div>
          )}
        </div>
        {doc && (
          <div className="pdf-tools">
            <span className="pdf-count">
              {page} / {sizes.length}
            </span>
            <button type="button" className="icon-btn" aria-label="縮小" disabled={zoomIndex === 0} onClick={() => changeZoom(-1)}>
              −
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="拡大"
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              onClick={() => changeZoom(1)}
            >
              ＋
            </button>
          </div>
        )}
      </div>
    );
  }),
);
