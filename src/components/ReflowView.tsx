import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PdfView } from './PdfView';
import type { Subject } from '../lib/exam';
import { getLayout, saveLayout } from '../lib/db';
import { wrapFragments, type DocLayout, type Item, type Row } from '../lib/reflow';
import { ANALYSIS_WIDTH, analyzePdf, openPdf, renderPage } from '../lib/reflowPdf';

const SIZES = [15, 18, 22, 27];
const SIZE_KEY = 'rikugi-reflow-size';
const MAX_DPR = 2;
const SIDE_PADDING = 12;

function readSize(): number {
  try {
    const stored = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(stored) ? stored : SIZES[1];
  } catch {
    return SIZES[1];
  }
}

function saveSize(size: number) {
  try {
    localStorage.setItem(SIZE_KEY, String(size));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

type Placed = { kind: 'row'; row: Row; y: number } | { kind: 'block'; item: Extract<Item, { kind: 'block' }>; y: number; scale: number };

/** 問題を、表示倍率に合わせた縦積みのレイアウトに変換する。単位はCSS px。 */
function placeItems(items: Item[], layout: DocLayout, viewWidth: number, textSize: number): { placed: Placed[]; height: number; zoom: number } {
  const zoom = textSize / layout.textHeight;
  const maxRaw = viewWidth / zoom;
  const placed: Placed[] = [];
  let y = 0;
  for (const item of items) {
    if (item.kind === 'text') {
      for (const row of wrapFragments(item.fragments, maxRaw, layout.textHeight)) {
        placed.push({ kind: 'row', row, y });
        y += (row.ascent + row.descent) * zoom + textSize * 0.5;
      }
      y += textSize * 0.5;
    } else {
      const scale = Math.min(zoom, viewWidth / (item.right - item.left));
      placed.push({ kind: 'block', item, y, scale });
      y += (item.bottom - item.top) * scale + textSize;
    }
  }
  return { placed, height: Math.max(1, y), zoom };
}

type Block = Extract<Item, { kind: 'block' }>;

/** 文章として別に表示した部分を白く塗り、図の中に二重に見えないようにする。 */
function paintMask(context: CanvasRenderingContext2D, block: Block, x: number, y: number, scale: number) {
  context.fillStyle = '#fff';
  for (const mask of block.masks ?? []) {
    const left = Math.max(mask.left, block.left);
    const right = Math.min(mask.right, block.right);
    const top = Math.max(mask.top, block.top);
    const bottom = Math.min(mask.bottom, block.bottom);
    if (right <= left || bottom <= top) continue;
    context.fillRect(x + (left - block.left) * scale, y + (top - block.top) * scale, (right - left) * scale, (bottom - top) * scale + 1);
  }
}

/** 縮小表示の図・選択肢を、本文と同じ倍率で全画面に出す。はみ出す分は指で動かして見る。 */
function BlockZoom({ block, source, ratio, zoom, dpr, onClose }: { block: Block; source: HTMLCanvasElement; ratio: number; zoom: number; dpr: number; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = block.right - block.left;
  const height = block.bottom - block.top;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    canvas.width = Math.ceil(width * zoom * dpr);
    canvas.height = Math.ceil(height * zoom * dpr);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, block.left * ratio, block.top * ratio, width * ratio, height * ratio, 0, 0, canvas.width, canvas.height);
    paintMask(context, block, 0, 0, zoom * dpr);
  }, [block, source, ratio, zoom, dpr, width, height]);

  return (
    <div className="block-zoom" role="dialog" aria-label="拡大表示">
      <div className="block-zoom-scroll">
        <canvas ref={canvasRef} style={{ width: width * zoom, height: height * zoom }} />
      </div>
      <button type="button" className="btn btn-primary block-zoom-close" onClick={onClose}>
        閉じる
      </button>
    </div>
  );
}

interface ReflowViewProps {
  data: ArrayBuffer;
  file: string;
  subject: Subject;
  questionIndex: number;
  fallbackPage?: number;
  onPageChange?: (page: number) => void;
}

export const ReflowView = memo(function ReflowView({ data, file, subject, questionIndex, fallbackPage, onPageChange }: ReflowViewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [layout, setLayout] = useState<DocLayout | null>(null);
  const [progress, setProgress] = useState('問題を準備しています…');
  const [size, setSize] = useState(readSize);
  const [original, setOriginal] = useState(false);
  const [painting, setPainting] = useState(true);
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageCache = useRef(new Map<number, HTMLCanvasElement>());
  const paintRef = useRef<{ placed: Placed[]; zoom: number; dpr: number; ratio: number } | null>(null);
  const [zoomed, setZoomed] = useState<Block | null>(null);
  const [shrunk, setShrunk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = openPdf(data);
    const cache = pageCache.current;
    void (async () => {
      const loaded = await handle.promise;
      if (cancelled) return;
      setDoc(loaded);
      let result = await getLayout(file);
      if (!result) {
        result = await analyzePdf(loaded, subject.aCount + subject.bCount, (done, total) => {
          if (!cancelled) setProgress(`問題を準備しています… ${done}/${total}`);
        });
        if (!cancelled) await saveLayout(file, result);
      }
      if (!cancelled) setLayout(result);
    })().catch(() => {
      if (!cancelled) setOriginal(true);
    });
    return () => {
      cancelled = true;
      setDoc(null);
      for (const canvas of cache.values()) canvas.width = 0;
      cache.clear();
      handle.destroy();
    };
  }, [data, file, subject]);

  const items = layout?.ok ? layout.questions[questionIndex] : undefined;
  const firstPage = items?.[0] ? (items[0].kind === 'text' ? items[0].fragments[0]?.page : items[0].page) : undefined;

  useEffect(() => {
    if (firstPage) onPageChange?.(firstPage);
  }, [firstPage, onPageChange]);

  useEffect(() => {
    const holder = holderRef.current;
    const canvas = canvasRef.current;
    if (!doc || !layout?.ok || !items || !holder || !canvas || original) return;
    let cancelled = false;
    setPainting(true);
    setZoomed(null);
    holder.scrollTop = 0;

    void (async () => {
      const viewWidth = holder.clientWidth - SIDE_PADDING * 2;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const { placed, height, zoom } = placeItems(items, layout, viewWidth, size);
      const pageWidth = Math.round(ANALYSIS_WIDTH * zoom * dpr);
      const ratio = pageWidth / ANALYSIS_WIDTH;

      const pagesNeeded = new Set<number>();
      for (const entry of placed) {
        if (entry.kind === 'block') pagesNeeded.add(entry.item.page);
        else entry.row.fragments.forEach((fragment) => pagesNeeded.add(fragment.page));
      }

      const cache = pageCache.current;
      for (const [number, cached] of cache) {
        if (!pagesNeeded.has(number) || cached.width !== pageWidth) {
          cached.width = 0;
          cache.delete(number);
        }
      }
      for (const number of pagesNeeded) {
        if (!cache.has(number)) {
          const rendered = await renderPage(doc, number, pageWidth);
          if (cancelled) {
            rendered.width = 0;
            return;
          }
          cache.set(number, rendered);
        }
      }
      if (cancelled) return;

      canvas.width = Math.ceil(viewWidth * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${viewWidth}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = 'high';

      for (const entry of placed) {
        if (entry.kind === 'block') {
          const { item, y, scale } = entry;
          const source = cache.get(item.page)!;
          const w = item.right - item.left;
          const h = item.bottom - item.top;
          context.drawImage(source, item.left * ratio, item.top * ratio, w * ratio, h * ratio, 0, y * dpr, w * scale * dpr, h * scale * dpr);
          paintMask(context, item, 0, y * dpr, scale * dpr);
        } else {
          const { row, y } = entry;
          for (const fragment of row.fragments) {
            const source = cache.get(fragment.page)!;
            const w = fragment.x1 - fragment.x0;
            const h = fragment.bottom - fragment.top;
            const top = y + (row.ascent - (fragment.baseline - fragment.top)) * zoom;
            context.drawImage(source, fragment.x0 * ratio, fragment.top * ratio, w * ratio, h * ratio, fragment.dx * zoom * dpr, top * dpr, w * zoom * dpr, h * zoom * dpr);
          }
        }
      }
      paintRef.current = { placed, zoom, dpr, ratio };
      setShrunk(placed.some((entry) => entry.kind === 'block' && entry.scale < zoom * 0.98));
      setPainting(false);
    })().catch(() => {
      if (!cancelled) setOriginal(true);
    });

    return () => {
      cancelled = true;
    };
  }, [doc, layout, items, size, original]);

  const unavailable = layout !== null && !layout.ok;
  if (original || unavailable) {
    return (
      <div className="reflow-wrap">
        <PdfView data={data} initialPage={firstPage ?? fallbackPage ?? 1} onPageChange={onPageChange} />
        {!unavailable && (
          <div className="reflow-tools">
            <button type="button" className="reflow-btn" onClick={() => setOriginal(false)}>
              見やすい表示
            </button>
          </div>
        )}
      </div>
    );
  }

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const paint = paintRef.current;
    if (!paint) return;
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const hit = paint.placed.find(
      (entry) => entry.kind === 'block' && entry.scale < paint.zoom * 0.98 && y >= entry.y && y <= entry.y + (entry.item.bottom - entry.item.top) * entry.scale,
    );
    if (hit?.kind === 'block') setZoomed(hit.item);
  };

  const zoomSource = zoomed ? pageCache.current.get(zoomed.page) : undefined;

  const changeSize = (delta: number) => {
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(size) + delta))];
    setSize(next);
    saveSize(next);
  };

  return (
    <div className="reflow-wrap">
      <div ref={holderRef} className="reflow-scroller">
        {!layout && <p className="pdf-message">{progress}</p>}
        <canvas ref={canvasRef} className="reflow-canvas" aria-label="問題" hidden={!layout} onClick={onCanvasClick} />
        {layout && painting && <p className="reflow-wait">表示しています…</p>}
        {!painting && shrunk && <p className="reflow-hint">図や選択肢はタップで拡大できます</p>}
      </div>
      {zoomed && zoomSource && paintRef.current && (
        <BlockZoom
          block={zoomed}
          source={zoomSource}
          ratio={paintRef.current.ratio}
          zoom={paintRef.current.zoom}
          dpr={paintRef.current.dpr}
          onClose={() => setZoomed(null)}
        />
      )}
      {layout && (
        <div className="reflow-tools">
          <button type="button" className="reflow-btn" onClick={() => setOriginal(true)}>
            原本
          </button>
          <button type="button" className="icon-btn" aria-label="文字を小さく" disabled={size === SIZES[0]} onClick={() => changeSize(-1)}>
            −
          </button>
          <button type="button" className="icon-btn" aria-label="文字を大きく" disabled={size === SIZES[SIZES.length - 1]} onClick={() => changeSize(1)}>
            ＋
          </button>
        </div>
      )}
    </div>
  );
});
