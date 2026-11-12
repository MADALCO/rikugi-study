import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PdfView } from './PdfView';
import type { Subject } from '../lib/exam';
import { getLayout, saveLayout } from '../lib/db';
import { wrapFragments, type DocLayout, type Item, type Row } from '../lib/reflow';
import { analyzePdf, openPdf, renderRegion, type Region } from '../lib/reflowPdf';

const SIZES = [15, 18, 22, 27];
const SIZE_KEY = 'rikugi-reflow-size';
const MAX_DPR = 2;
const SIDE_PADDING = 12;
// iOS Safariはcanvas1枚の面積(約1677万px)と総メモリに上限があり、超えるとタブごと落ちる。
const MAX_SOURCE_PIXELS = 6_000_000;
const MAX_OUTPUT_PIXELS = 8_000_000;
const MAX_ZOOM_PIXELS = 6_000_000;
const REGION_PAD = 3;

/** ページから切り出して描いた部分。座標は解析幅基準。 */
interface Source {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  ratio: number;
}

/** Safariは幅と高さの両方を0にしないとcanvasのメモリを返さないことがある。 */
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/** 面積が上限を超えないよう、描画倍率を下げる。 */
function capRatio(ratio: number, width: number, height: number, max: number): number {
  const pixels = width * height * ratio * ratio;
  return pixels > max ? ratio * Math.sqrt(max / pixels) : ratio;
}

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
function BlockZoom({ block, source, zoom, dpr, onClose }: { block: Block; source: Source; zoom: number; dpr: number; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = block.right - block.left;
  const height = block.bottom - block.top;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    // 元の描画が解放済みなら描かない(解放済みのcanvasを描くと例外になる)。
    if (!canvas || !context || source.canvas.width === 0) return;
    const scale = capRatio(zoom * dpr, width, height, MAX_ZOOM_PIXELS);
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    const { ratio } = source;
    context.drawImage(source.canvas, (block.left - source.left) * ratio, (block.top - source.top) * ratio, width * ratio, height * ratio, 0, 0, canvas.width, canvas.height);
    paintMask(context, block, 0, 0, scale);
    return () => release(canvas);
  }, [block, source, zoom, dpr, width, height]);

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
  const pageCache = useRef(new Map<number, Source>());
  const paintRef = useRef<{ placed: Placed[]; zoom: number; dpr: number } | null>(null);
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
      for (const source of cache.values()) release(source.canvas);
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
      // ページごとに、この問題で使う範囲だけを求める。
      const regions = new Map<number, Region>();
      const include = (page: number, left: number, top: number, right: number, bottom: number) => {
        const region = regions.get(page);
        if (!region) regions.set(page, { left, top, right, bottom });
        else {
          region.left = Math.min(region.left, left);
          region.top = Math.min(region.top, top);
          region.right = Math.max(region.right, right);
          region.bottom = Math.max(region.bottom, bottom);
        }
      };
      for (const entry of placed) {
        if (entry.kind === 'block') include(entry.item.page, entry.item.left, entry.item.top, entry.item.right, entry.item.bottom);
        else for (const fragment of entry.row.fragments) include(fragment.page, fragment.x0, fragment.top, fragment.x1, fragment.bottom);
      }

      // 前の問題の描画を先に解放してから描く(同時に持たない)。
      const cache = pageCache.current;
      for (const source of cache.values()) release(source.canvas);
      cache.clear();
      for (const [number, raw] of regions) {
        const region = {
          left: Math.max(0, Math.floor(raw.left) - REGION_PAD),
          top: Math.max(0, Math.floor(raw.top) - REGION_PAD),
          right: Math.ceil(raw.right) + REGION_PAD,
          bottom: Math.ceil(raw.bottom) + REGION_PAD,
        };
        const ratio = capRatio(zoom * dpr, region.right - region.left, region.bottom - region.top, MAX_SOURCE_PIXELS);
        const rendered = await renderRegion(doc, number, ratio, region);
        if (cancelled) {
          release(rendered);
          return;
        }
        cache.set(number, { canvas: rendered, left: region.left, top: region.top, ratio });
      }
      if (cancelled) return;

      const out = capRatio(dpr, viewWidth, height, MAX_OUTPUT_PIXELS);
      canvas.width = Math.ceil(viewWidth * out);
      canvas.height = Math.ceil(height * out);
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
          const { ratio } = source;
          const w = item.right - item.left;
          const h = item.bottom - item.top;
          context.drawImage(source.canvas, (item.left - source.left) * ratio, (item.top - source.top) * ratio, w * ratio, h * ratio, 0, y * out, w * scale * out, h * scale * out);
          paintMask(context, item, 0, y * out, scale * out);
        } else {
          const { row, y } = entry;
          for (const fragment of row.fragments) {
            const source = cache.get(fragment.page)!;
            const { ratio } = source;
            const w = fragment.x1 - fragment.x0;
            const h = fragment.bottom - fragment.top;
            const top = y + (row.ascent - (fragment.baseline - fragment.top)) * zoom;
            context.drawImage(source.canvas, (fragment.x0 - source.left) * ratio, (fragment.top - source.top) * ratio, w * ratio, h * ratio, fragment.dx * zoom * out, top * out, w * zoom * out, h * zoom * out);
          }
        }
      }
      paintRef.current = { placed, zoom, dpr };
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
