import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { analyzeDocument, docMetrics, emptyRowAbove, findBands, findLabelStarts, refineBands, type DocLayout, type FigureRegion, type Ink, type PageBands } from './reflow';
import { figureRegions, pageGraphics, visibleGraphics, type GraphicRect } from './pdfGraphics';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 解析用の描画幅(px)。切り出し座標はすべてこの幅が基準。 */
export const ANALYSIS_WIDTH = 1200;
const INK_THRESHOLD = 170;
const MERGE_GAP = 4;

export function openPdf(data: ArrayBuffer): { promise: Promise<PDFDocumentProxy>; destroy: () => void } {
  const base = new URL('pdfjs/', document.baseURI).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    isEvalSupported: false,
  });
  return { promise: task.promise, destroy: () => void task.destroy() };
}

export async function renderPage(doc: PDFDocumentProxy, number: number, width: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(number);
  const scale = width / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvasを作成できません');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // 画面に直接出さない描画なので、画面の更新(requestAnimationFrame)に合わせない(背景のタブなどで大きく遅くなるため)。
  await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
  page.cleanup();
  return canvas;
}

export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * ページの一部だけを描く。座標は解析幅(ANALYSIS_WIDTH)基準で、ratio は解析幅1pxあたりの描画px。
 * iOSはcanvasの総メモリが厳しいので、表示用にページ全体を高解像度で描かない。
 */
export async function renderRegion(doc: PDFDocumentProxy, number: number, ratio: number, region: Region): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(number);
  const scale = (ratio * ANALYSIS_WIDTH) / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil((region.right - region.left) * ratio));
  canvas.height = Math.max(1, Math.ceil((region.bottom - region.top) * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvasを作成できません');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: context,
    viewport,
    intent: 'print',
    transform: [1, 0, 0, 1, -region.left * ratio, -region.top * ratio],
  }).promise;
  page.cleanup();
  return canvas;
}

function toInk(canvas: HTMLCanvasElement): Ink {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    data[i] = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3 < INK_THRESHOLD ? 1 : 0;
  }
  return { width, height, data };
}

export async function analyzePdf(
  doc: PDFDocumentProxy,
  expected: number,
  onProgress?: (done: number, total: number) => void,
): Promise<DocLayout> {
  const pages: PageBands[] = [];
  const inks: Ink[] = [];
  const graphics: GraphicRect[][] = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const canvas = await renderPage(doc, number, ANALYSIS_WIDTH);
    const ink = toInk(canvas);
    inks.push(ink);
    // PDFに描かれた図形(線・面・画像)の位置。図の範囲を墨の形から推測せずに求めるために使う。
    graphics.push(visibleGraphics(await pageGraphics(await doc.getPage(number), ANALYSIS_WIDTH).catch(() => []), ink));
    pages.push({ page: number, width: ink.width, height: ink.height, bands: findBands(ink, MERGE_GAP) });
    canvas.width = 0;
    canvas.height = 0;
    onProgress?.(number, doc.numPages);
  }
  // 行間の狭い文書で、つながった本文行を分け直す。
  const estimate = docMetrics(pages, expected);
  // 図の範囲が分からないページ(スキャンした画像など)は undefined で、墨の形から図を推測する。
  let regions: Array<FigureRegion[] | undefined> = pages.map(() => undefined);
  if (estimate) {
    regions = pages.map((page, index) => figureRegions(graphics[index], estimate.textHeight, page.width, page.height) ?? undefined);
    pages.forEach((page, index) => {
      page.bands = refineBands(inks[index], page.bands, estimate.textHeight, regions[index]);
    });
  }
  const first = analyzeDocument(pages, expected);
  if (first.ok) return first;

  // 行の形だけで数が合わなければ、問題番号の字の形で先頭を探し直す。
  const metrics = docMetrics(pages, expected);
  if (!metrics) return first;
  const starts = findLabelStarts(pages, inks, metrics);
  if (starts.length !== expected) return { ...first, found: starts.length || first.found };
  const split = pages.map((page, index) => ({
    ...page,
    bands: refineBands(
      inks[index],
      findBands(
        inks[index],
        MERGE_GAP,
        starts
          .filter((start) => start.page === page.page)
          .map((start) => emptyRowAbove(inks[index], start.top, metrics.textHeight))
          .filter((row): row is number => row !== null),
      ),
      metrics.textHeight,
      regions[index],
    ),
  }));
  return analyzeDocument(split, expected, starts);
}
