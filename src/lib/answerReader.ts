// 解答PDF(1ページの表)から正答の数字を読み取る。
// 罫線から表とセルを求め、「正答」列の数字だけを字形の照合で判定する。文章は読まない。
import type { Ink } from './reflow';

export interface Line {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Cell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Glyph {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Column {
  x0: number;
  x1: number;
  cells: Cell[];
}

export interface Table {
  columns: Column[];
}

/** 指定長以上の横線を探す。厚みが maxThick を超える塊(塗りつぶし)は線とみなさない。 */
export function findHorizontalLines(ink: Ink, minLength: number, maxThick: number): Line[] {
  const raw: Line[] = [];
  for (let y = 0; y < ink.height; y++) {
    let start = -1;
    for (let x = 0; x <= ink.width; x++) {
      const on = x < ink.width && ink.data[y * ink.width + x] === 1;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start >= minLength) raw.push({ x0: start, x1: x, y0: y, y1: y + 1 });
        start = -1;
      }
    }
  }
  return mergeLines(raw, 'y', maxThick);
}

/** 縦線を探す。色の違いなどで途切れた同じ位置の線は maxGap 以内ならつなぐ。 */
export function findVerticalLines(ink: Ink, minLength: number, maxThick: number, maxGap = 0): Line[] {
  const raw: Line[] = [];
  // 文字の縦棒(「1」など)を線の断片と誤らないよう、断片も十分に長いものだけを使う。
  const pieceLength = Math.max(4, Math.floor(minLength * 0.8));
  for (let x = 0; x < ink.width; x++) {
    let start = -1;
    for (let y = 0; y <= ink.height; y++) {
      const on = y < ink.height && ink.data[y * ink.width + x] === 1;
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (y - start >= pieceLength) raw.push({ x0: x, x1: x + 1, y0: start, y1: y });
        start = -1;
      }
    }
  }
  return joinVertical(mergeLines(raw, 'x', maxThick), maxGap, minLength);
}

/** 同じ位置で途切れた縦線をつなぐ。別々の条件で検出した線を合わせるときにも使う。 */
export function joinVertical(lines: Line[], maxGap: number, minLength: number): Line[] {
  const pieces = [...lines].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
  const joined: Line[] = [];
  for (const piece of pieces) {
    const target = joined.find(
      (line) => Math.abs(line.x0 - piece.x0) <= 3 && piece.y0 - line.y1 <= maxGap && piece.y1 - line.y0 > 0,
    );
    if (target) {
      target.x0 = Math.min(target.x0, piece.x0);
      target.x1 = Math.max(target.x1, piece.x1);
      target.y0 = Math.min(target.y0, piece.y0);
      target.y1 = Math.max(target.y1, piece.y1);
    } else {
      joined.push({ ...piece });
    }
  }
  return joined.filter((line) => line.y1 - line.y0 >= minLength);
}

function mergeLines(raw: Line[], axis: 'x' | 'y', maxThick: number): Line[] {
  const merged: Line[] = [];
  const along = axis === 'y' ? (line: Line) => [line.x0, line.x1] : (line: Line) => [line.y0, line.y1];
  for (const line of raw) {
    const [a0, a1] = along(line);
    const target = merged.find((candidate) => {
      const [b0, b1] = along(candidate);
      const adjacent = axis === 'y' ? line.y0 <= candidate.y1 : line.x0 <= candidate.x1;
      return adjacent && Math.min(a1, b1) - Math.max(a0, b0) > (Math.min(a1 - a0, b1 - b0)) * 0.8;
    });
    if (target) {
      target.x0 = Math.min(target.x0, line.x0);
      target.x1 = Math.max(target.x1, line.x1);
      target.y0 = Math.min(target.y0, line.y0);
      target.y1 = Math.max(target.y1, line.y1);
    } else {
      merged.push({ ...line });
    }
  }
  return merged.filter((line) => (axis === 'y' ? line.y1 - line.y0 : line.x1 - line.x0) <= maxThick);
}

/**
 * 列の中の文字の行を、そのままセルとして返す。行の罫線は薄い色で消えることがあるので頼らない。
 * 列幅のほとんどを占める横一列の墨は罫線とみなして除く。
 */
export function rowsInColumn(ink: Ink, x0: number, x1: number, y0: number, y1: number, inset: number): Cell[] {
  const left = x0 + inset;
  const right = x1 - inset;
  const width = right - left;
  const cells: Cell[] = [];
  let start = -1;
  for (let y = y0; y <= y1; y++) {
    let count = 0;
    if (y < y1) for (let x = left; x < right; x++) count += ink.data[y * ink.width + x];
    const text = count > 0 && count < width * 0.8;
    if (text && start < 0) start = y;
    if (!text && start >= 0) {
      if (y - start >= 4) cells.push({ x0, x1, y0: Math.max(y0, start - inset), y1: Math.min(y1, y + inset) });
      start = -1;
    }
  }
  return cells;
}

/** 縦線の組から表と列を作る。セルは列の中の文字の行から求める。 */
export function buildTablesByRows(ink: Ink, vertical: Line[], minColumnWidth: number, inset: number): Table[] {
  const sorted = [...vertical].sort((a, b) => a.x0 - b.x0);
  const groups: Line[][] = [];
  for (const line of sorted) {
    const group = groups.find((candidate) => {
      const ref = candidate[0];
      const overlap = Math.min(ref.y1, line.y1) - Math.max(ref.y0, line.y0);
      return overlap > Math.min(ref.y1 - ref.y0, line.y1 - line.y0) * 0.5;
    });
    if (group) group.push(line);
    else groups.push([line]);
  }
  const tables: Table[] = [];
  for (const group of groups) {
    const lines = group.sort((a, b) => a.x0 - b.x0);
    const columns: Column[] = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      const left = lines[i];
      const right = lines[i + 1];
      if (right.x0 - left.x1 < minColumnWidth) continue;
      // 片側の罫線が部分的にしか取れないことがあるので、長い方の線を列の上下の範囲とする。
      const span = left.y1 - left.y0 >= right.y1 - right.y0 ? left : right;
      const cells = rowsInColumn(ink, left.x1, right.x0, span.y0, span.y1, inset);
      if (cells.length > 0) columns.push({ x0: left.x1, x1: right.x0, cells });
    }
    if (columns.length > 0) tables.push({ columns });
  }
  return tables.sort((a, b) => a.columns[0].cells[0].y0 - b.columns[0].cells[0].y0 || a.columns[0].x0 - b.columns[0].x0);
}

/** 縦線の組から表と列を、列を横切る横線からセルを作る。結合セル(B問題の番号など)も扱える。 */
export function buildTables(vertical: Line[], horizontal: Line[], minColumnWidth: number, tolerance: number): Table[] {
  const sorted = [...vertical].sort((a, b) => a.x0 - b.x0);
  const groups: Line[][] = [];
  for (const line of sorted) {
    const group = groups.find((candidate) => {
      const ref = candidate[0];
      const overlap = Math.min(ref.y1, line.y1) - Math.max(ref.y0, line.y0);
      return overlap > Math.min(ref.y1 - ref.y0, line.y1 - line.y0) * 0.5;
    });
    if (group) group.push(line);
    else groups.push([line]);
  }

  const tables: Table[] = [];
  for (const group of groups) {
    const lines = group.sort((a, b) => a.x0 - b.x0);
    const columns: Column[] = [];
    for (let i = 0; i + 1 < lines.length; i++) {
      const left = lines[i];
      const right = lines[i + 1];
      if (right.x0 - left.x1 < minColumnWidth) continue;
      const top = Math.max(left.y0, right.y0);
      const bottom = Math.min(left.y1, right.y1);
      const x0 = left.x1;
      const x1 = right.x0;
      const ys = horizontal
        .filter((line) => line.x0 <= x0 + tolerance && line.x1 >= x1 - tolerance && line.y1 >= top - tolerance && line.y0 <= bottom + tolerance)
        .map((line) => [line.y0, line.y1] as const)
        .sort((a, b) => a[0] - b[0]);
      const cells: Cell[] = [];
      for (let k = 0; k + 1 < ys.length; k++) {
        const y0 = ys[k][1];
        const y1 = ys[k + 1][0];
        if (y1 - y0 > tolerance) cells.push({ x0, x1, y0, y1 });
      }
      if (cells.length > 0) columns.push({ x0, x1, cells });
    }
    if (columns.length > 0) tables.push({ columns });
  }
  return tables.sort((a, b) => a.columns[0].cells[0].y0 - b.columns[0].cells[0].y0 || a.columns[0].x0 - b.columns[0].x0);
}

/** セル内の文字の塊を左から順に返す。罫線に触れないよう内側を少し削ってから調べる。 */
export function cellGlyphs(ink: Ink, cell: Cell, inset: number): Glyph[] {
  const x0 = cell.x0 + inset;
  const x1 = cell.x1 - inset;
  const y0 = cell.y0 + inset;
  const y1 = cell.y1 - inset;
  const glyphs: Glyph[] = [];
  let start = -1;
  for (let x = x0; x <= x1; x++) {
    let hit = false;
    if (x < x1) {
      for (let y = y0; y < y1; y++) {
        if (ink.data[y * ink.width + x]) {
          hit = true;
          break;
        }
      }
    }
    if (hit && start < 0) start = x;
    if (!hit && start >= 0) {
      let top = y1;
      let bottom = y0;
      for (let y = y0; y < y1; y++) {
        for (let gx = start; gx < x; gx++) {
          if (ink.data[y * ink.width + gx]) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y + 1);
            break;
          }
        }
      }
      glyphs.push({ x0: start, x1: x, y0: top, y1: bottom });
      start = -1;
    }
  }
  return glyphs;
}

/** 列内の文字幅の中央値から、番号列(「〔A－1〕」など幅広)か、1〜2文字の列かを判定する。
 * 見出し(「正答」)だけが幅広でも、中央値なので影響されない。空のセルは数えない。 */
export function isWideColumn(ink: Ink, column: Column, inset: number, glyphHeight: number): boolean {
  const widths = column.cells
    .map((cell) => cellGlyphs(ink, cell, inset))
    .filter((glyphs) => glyphs.length > 0)
    .map((glyphs) => glyphs[glyphs.length - 1].x1 - glyphs[0].x0)
    .sort((a, b) => a - b);
  if (widths.length === 0) return false;
  return widths[Math.floor(widths.length / 2)] > glyphHeight * 2.4;
}

/** 正答列 = 幅の狭い列のうち、右隣が番号列か表の端であるもの(B問題の記号列「ア〜オ」は除かれる)。 */
export function answerColumns(table: Table, wide: boolean[]): Column[] {
  return table.columns.filter((_, index) => !wide[index] && (index === table.columns.length - 1 || wide[index + 1]));
}

// ---- 数字の判定 ----

export const SAMPLE_W = 12;
export const SAMPLE_H = 18;

export interface Template {
  digit: number;
  aspect: number;
  pixels: Float32Array;
}

/** 文字の外接矩形を固定サイズの濃淡に縮める。縦横比は別に持つ。 */
export function sampleGlyph(ink: Ink, glyph: Glyph): { aspect: number; pixels: Float32Array } {
  const width = glyph.x1 - glyph.x0;
  const height = glyph.y1 - glyph.y0;
  const pixels = new Float32Array(SAMPLE_W * SAMPLE_H);
  for (let sy = 0; sy < SAMPLE_H; sy++) {
    for (let sx = 0; sx < SAMPLE_W; sx++) {
      const gx0 = glyph.x0 + Math.floor((sx * width) / SAMPLE_W);
      const gx1 = glyph.x0 + Math.max(Math.floor(((sx + 1) * width) / SAMPLE_W), Math.floor((sx * width) / SAMPLE_W) + 1);
      const gy0 = glyph.y0 + Math.floor((sy * height) / SAMPLE_H);
      const gy1 = glyph.y0 + Math.max(Math.floor(((sy + 1) * height) / SAMPLE_H), Math.floor((sy * height) / SAMPLE_H) + 1);
      let on = 0;
      let total = 0;
      for (let y = gy0; y < gy1; y++) {
        for (let x = gx0; x < gx1; x++) {
          on += ink.data[y * ink.width + x];
          total += 1;
        }
      }
      pixels[sy * SAMPLE_W + sx] = total ? on / total : 0;
    }
  }
  return { aspect: width / Math.max(1, height), pixels };
}

export function correlation(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export interface DigitGuess {
  digit: number;
  score: number;
  margin: number;
}

/** 複数の書体の見本と比べ、最も近い数字と、2番目の候補との差(確からしさ)を返す。 */
export function classifyDigit(sample: { aspect: number; pixels: Float32Array }, templates: Template[]): DigitGuess {
  const best = new Map<number, number>();
  for (const template of templates) {
    const aspectPenalty = Math.abs(Math.log(Math.max(0.05, sample.aspect) / Math.max(0.05, template.aspect))) * 0.35;
    const score = correlation(sample.pixels, template.pixels) - aspectPenalty;
    if (score > (best.get(template.digit) ?? -Infinity)) best.set(template.digit, score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  return { digit: ranked[0][0], score: ranked[0][1], margin: ranked[0][1] - (ranked[1]?.[1] ?? -1) };
}

export interface ReadCell {
  value: number;
  confident: boolean;
}

export const MIN_SCORE = 0.55;
export const MIN_MARGIN = 0.08;

export function readNumber(ink: Ink, cell: Cell, inset: number, templates: Template[]): ReadCell | null {
  const glyphs = cellGlyphs(ink, cell, inset);
  if (glyphs.length === 0 || glyphs.length > 2) return null;
  let value = 0;
  let confident = true;
  for (const glyph of glyphs) {
    const guess = classifyDigit(sampleGlyph(ink, glyph), templates);
    if (guess.score < MIN_SCORE) return null;
    if (guess.margin < MIN_MARGIN) confident = false;
    value = value * 10 + guess.digit;
  }
  return { value, confident };
}
