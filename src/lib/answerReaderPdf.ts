import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  answerColumns,
  buildTablesByRows,
  cellGlyphs,
  findVerticalLines,
  joinVertical,
  isWideColumn,
  readNumber,
  sampleGlyph,
  type Template,
} from './answerReader';
import { allSlots, type Subject } from './exam';
import type { Ink } from './reflow';
import { renderPage } from './reflowPdf';
import type { Answers } from './scoring';

const READ_WIDTH = 1800;
const FONTS = [
  'Hiragino Mincho ProN',
  'Hiragino Sans',
  'Hiragino Kaku Gothic ProN',
  'Times New Roman',
  'Georgia',
  'Helvetica',
  'Arial',
  'Courier New',
  'serif',
  'sans-serif',
];

let templateCache: Template[] | null = null;

/** 端末にある書体で数字の見本を描き、照合用の見本を作る(半角・全角、標準・太字)。 */
export function buildTemplates(): Template[] {
  if (templateCache) return templateCache;
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 120;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const templates: Template[] = [];
  for (const font of FONTS) {
    for (const weight of ['400', '700']) {
      for (let digit = 0; digit <= 9; digit++) {
        for (const text of [String(digit), String.fromCharCode(0xff10 + digit)]) {
          context.fillStyle = '#fff';
          context.fillRect(0, 0, 120, 120);
          context.fillStyle = '#000';
          context.font = `${weight} 80px "${font}"`;
          context.textBaseline = 'middle';
          context.fillText(text, 20, 60);
          const ink = toInk(canvas);
          const glyphs = cellGlyphs(ink, { x0: 0, x1: 120, y0: 0, y1: 120 }, 0);
          if (glyphs.length !== 1) continue;
          templates.push({ digit, ...sampleGlyph(ink, glyphs[0]) });
        }
      }
    }
  }
  templateCache = templates;
  return templates;
}

function toInk(canvas: HTMLCanvasElement, threshold = 160): Ink {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    data[i] = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3 < threshold ? 1 : 0;
  }
  return { width, height, data };
}

export interface AutoKey {
  key: Answers;
  uncertain: string[];
}

export type AutoKeyResult = { ok: true; autoKey: AutoKey } | { ok: false; reason: string; found?: number };

/** 解答PDFの1ページ目から正答を読む。欄の数と値の範囲が合わなければ使わない。 */
export async function readAnswerKey(doc: PDFDocumentProxy, subject: Subject): Promise<AutoKeyResult> {
  const canvas = await renderPage(doc, 1, READ_WIDTH);
  const ink = toInk(canvas);
  // 罫線は色付きのことがあるので、文字より薄い色まで拾う。淡い背景色は拾わない。
  const lineInk = toInk(canvas, 205);
  canvas.width = 0;
  const W = ink.width;

  const inset = 4;
  const minLine = Math.round(W * 0.04);
  const vertical = joinVertical(
    [...findVerticalLines(ink, minLine, 6, 6), ...findVerticalLines(lineInk, minLine, 6, 6)],
    6,
    minLine,
  );
  const tables = buildTablesByRows(ink, vertical, Math.round(W * 0.015), inset);

  const heights: number[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      for (const cell of column.cells) for (const glyph of cellGlyphs(ink, cell, inset)) heights.push(glyph.y1 - glyph.y0);
    }
  }
  heights.sort((a, b) => a - b);
  const glyphHeight = heights[Math.floor(heights.length / 2)] ?? 20;
  const templates = buildTemplates();

  // 表ごとに正答列を読み、列は左から、行は上から順に並べる。
  const perTable = tables.map((table) => {
    const wide = table.columns.map((column) => isWideColumn(ink, column, inset, glyphHeight));
    const values: Array<{ value: number; confident: boolean }> = [];
    for (const column of answerColumns(table, wide)) {
      for (const cell of column.cells) {
        const read = readNumber(ink, cell, inset, templates);
        if (read) values.push(read);
      }
    }
    return values;
  });

  const aCount = subject.aCount;
  const bCount = subject.bCount * 5;
  const flat = perTable.flat();
  const aTable = perTable.findIndex((values) => values.length === aCount);
  const bTable = perTable.findIndex((values, index) => index !== aTable && values.length === bCount);
  let ordered: Array<{ value: number; confident: boolean }>;
  if (aTable >= 0 && bTable >= 0) ordered = [...perTable[aTable], ...perTable[bTable]];
  else if (flat.length === aCount + bCount) ordered = flat;
  else return { ok: false, reason: '正答欄の数が合いません', found: flat.length };

  const slots = allSlots(subject);
  const key: Answers = {};
  const uncertain: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const { value, confident } = ordered[i];
    if (value < 1 || value > slots[i].choices) return { ok: false, reason: `範囲外の値 ${slots[i].key}` };
    key[slots[i].key] = value;
    if (!confident) uncertain.push(slots[i].key);
  }
  return { ok: true, autoKey: { key, uncertain } };
}
