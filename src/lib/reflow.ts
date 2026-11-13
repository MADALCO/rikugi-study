// PDFを描画した画像の「墨の位置」だけを解析し、問題ごとの切り出し位置と折り返し方を求める。
// 文字認識はしない。結果は座標のみで、表示のたびに原本の描画から切り出す。
import { correlation, sampleGlyph } from './answerReader';

export interface Ink {
  width: number;
  height: number;
  /** 1 = 墨あり。長さ width * height */
  data: Uint8Array;
}

export interface Atom {
  x0: number;
  x1: number;
  /** 字ごとに上下の範囲が決まっている場合(行の間にはみ出す丸囲み文字など)。なければ行の範囲を使う。 */
  y0?: number;
  y1?: number;
}

export interface Band {
  top: number;
  bottom: number;
  left: number;
  right: number;
  baseline: number;
  atoms: Atom[];
  /** 図の横に並ぶ本文の行では、その段の右端。折り返しの判定に使う。 */
  limit?: number;
  /** 本文の横に並ぶ図。常に折り返さずに表示する。 */
  figure?: boolean;
  /** 図の横に並ぶ本文の行では、その段の左端。 */
  columnLeft?: number;
  /** 表示するときに白く塗る範囲(文章として別に表示した部分)。 */
  mask?: Mask;
  /** 同上(複数)。 */
  masks?: Mask[];
}

export interface Mask {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PageBands {
  page: number;
  width: number;
  height: number;
  bands: Band[];
}

export interface Fragment {
  page: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
}

export type Item =
  | { kind: 'text'; fragments: Fragment[] }
  | { kind: 'block'; page: number; left: number; right: number; top: number; bottom: number; figure?: boolean; masks?: Mask[]; aside?: boolean };

export interface DocLayout {
  ok: boolean;
  found: number;
  expected: number;
  textHeight: number;
  pageWidth: number;
  questions: Item[][];
}

function columnAtoms(ink: Ink, top: number, bottom: number, x0 = 0, x1 = ink.width): Atom[] {
  const atoms: Atom[] = [];
  let start = -1;
  for (let x = x0; x < x1; x++) {
    let hit = false;
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + x]) {
        hit = true;
        break;
      }
    }
    if (hit && start < 0) start = x;
    if (!hit && start >= 0) {
      atoms.push({ x0: start, x1: x });
      start = -1;
    }
  }
  if (start >= 0) atoms.push({ x0: start, x1 });
  return atoms;
}

/**
 * 横一列に墨のある帯(行)を見つける。上下の添字や分数は mergeGap 以内なら同じ行とする。
 * splits に指定した行では必ず帯を分ける(問題の先頭が図と結合しているときに使う)。
 */
export function findBands(ink: Ink, mergeGap: number, splits: number[] = []): Band[] {
  const splitRows = new Set(splits);
  const rows = rowCounts(ink);

  const spans: Array<[number, number]> = [];
  let start = -1;
  let lastInk = -1;
  for (let y = 0; y <= ink.height; y++) {
    const has = y < ink.height && rows[y] > 0;
    if (splitRows.has(y) && start >= 0) {
      spans.push([start, lastInk + 1]);
      start = -1;
    }
    if (has) {
      if (start < 0) start = y;
      lastInk = y;
    } else if (start >= 0 && (y === ink.height || y - lastInk > mergeGap)) {
      spans.push([start, lastInk + 1]);
      start = -1;
    }
  }

  return spans.map(([top, bottom]) => makeBand(ink, rows, top, bottom));
}

function rowCounts(ink: Ink): Int32Array {
  const rows = new Int32Array(ink.height);
  for (let y = 0; y < ink.height; y++) {
    let count = 0;
    for (let x = 0; x < ink.width; x++) count += ink.data[y * ink.width + x];
    rows[y] = count;
  }
  return rows;
}

function makeBand(ink: Ink, _rows: Int32Array, top: number, bottom: number): Band {
  const atoms = columnAtoms(ink, top, bottom);
  return { top, bottom, left: atoms[0]?.x0 ?? 0, right: atoms[atoms.length - 1]?.x1 ?? 0, baseline: estimateBaseline(ink, top, bottom, 0, ink.width), atoms };
}

const LONG_RUN = 36;

/**
 * 文字の下端(基準線)を推定する。空欄の枠や分数の横棒のような長い横線は数えないので、
 * 枠のある行でも文字の位置がずれない。
 */
function estimateBaseline(ink: Ink, top: number, bottom: number, x0: number, x1: number): number {
  const counts: number[] = [];
  let peak = 0;
  for (let y = top; y < bottom; y++) {
    let count = 0;
    let run = 0;
    for (let x = x0; x <= x1; x++) {
      const on = x < x1 && ink.data[y * ink.width + x] === 1;
      if (on) run += 1;
      else {
        if (run > 0 && run < LONG_RUN) count += run;
        run = 0;
      }
    }
    counts.push(count);
    peak = Math.max(peak, count);
  }
  for (let y = bottom - 1; y >= top; y--) {
    if (counts[y - top] >= peak * 0.35) return y + 1;
  }
  return bottom;
}

export function makeBandIn(ink: Ink, top: number, bottom: number, x0: number, x1: number): Band {
  const atoms = columnAtoms(ink, top, bottom, x0, x1);
  return { top, bottom, left: atoms[0]?.x0 ?? x0, right: atoms[atoms.length - 1]?.x1 ?? x0, baseline: estimateBaseline(ink, top, bottom, x0, x1), atoms };
}

/**
 * 空欄の枠の縦線や図の一部で行どうしがつながった部分から、上と下の文章の行を1行ずつはがす。
 * 行の間の「ほぼ空白」の行(墨がごくわずか)で切り、はがす部分が文章の1行(高さ1行分・大きな空白なし・十分な幅)のときだけ切る。
 * 残った部分(図や表など)の範囲も返す。
 */
export function peelLines(
  ink: Ink,
  top: number,
  bottom: number,
  x0: number,
  x1: number,
  textHeight: number,
): { above: Band[]; below: Band[]; top: number; bottom: number; mask?: Mask; restMasks?: Mask[] } {
  const counts = new Int32Array(bottom - top);
  for (let y = top; y < bottom; y++) {
    let count = 0;
    for (let x = x0; x < x1; x++) count += ink.data[y * ink.width + x];
    counts[y - top] = count;
  }
  // 文章の行(字が3つ以上並ぶ)。図の枠の底辺のような1本の横線は行とみなさない。
  const lineLike = (band: Band, tall = 1.6) =>
    band.atoms.length >= 3 && band.bottom - band.top <= textHeight * tall && (band.right - band.left >= (x1 - x0) * 0.3 || band.right - band.left >= textHeight * 8) && isDenseLine(band, textHeight);
  // 横切る墨が細い縦線(枠の縦の辺や図の線)だけの行。丸囲み文字の弧のように幅のある線が横切る行で切ると字が欠ける。
  // 細いだけでなく、上下にまっすぐ続く線(枠の縦の辺や図の線)であること。丸囲み文字の円の側面は曲がっているので当たらない。
  const reach = Math.max(2, Math.round(textHeight * 0.6));
  // 上か下のどちらかへ、まっすぐ続いていればよい(空欄の枠の縦の辺は、すぐ下で枠の底辺に曲がることがある)。
  const near = (x: number, yy: number) => {
    if (yy < 0 || yy >= ink.height) return false;
    const row = yy * ink.width;
    return ink.data[row + x] === 1 || (x > 0 && ink.data[row + x - 1] === 1) || (x + 1 < ink.width && ink.data[row + x + 1] === 1);
  };
  const straight = (x: number, y: number) => {
    if (!near(x, y)) return false;
    let up = 0;
    while (up < reach && near(x, y - up - 1)) up += 1;
    if (up >= reach) return true;
    let down = 0;
    while (down < reach && near(x, y + down + 1)) down += 1;
    return down >= reach;
  };
  const thinCrossing = (y: number, from = x0, to = x1) => {
    let run = 0;
    for (let x = from; x <= to; x++) {
      const on = x < to && ink.data[y * ink.width + x] === 1;
      if (on) run += 1;
      else {
        if (run > 3) return false;
        if (run > 0 && !straight(x - Math.ceil(run / 2), y)) return false;
        run = 0;
      }
    }
    return true;
  };
  const low = (y: number, typical: number) => counts[y - top] <= Math.max(2, typical * 0.05) && (counts[y - top] === 0 || thinCrossing(y));
  // 「ほぼ空白」の基準は、はがそうとしている行の近く(2行分)の墨の量から決める。
  // 部分全体で決めると、図や表の疎らな行に引きずられて基準が低くなりすぎる。
  const typicalOf = (a: number, b: number) => {
    let max = 0;
    for (let y = a; y < b; y++) max = Math.max(max, counts[y - top]);
    return max;
  };
  const above: Band[] = [];
  const below: Band[] = [];
  // 空欄の枠の縦の辺だけが横切る行で切ったとき、枠の底辺が切れ目のすぐ下に残る。底辺は上の行の字(枠)に含め、
  // 下の部分を表示するときに白く塗る範囲として返す(解析用の墨は変えない。解析をやり直しても同じ結果になるように)。
  const restMasks: Mask[] = [];
  /** 底辺を上の行に含めた枠があれば、その底辺の最も下の行を返す(切れ目の下にほかの墨がなければ、次の行はその下から始める)。 */
  const settleBoxBottoms = (part: Band, cut: number): number => {
    const limit = Math.min(b - 1, cut + Math.round(textHeight * 0.4));
    const settled: Array<{ x0: number; x1: number; edgeEnd: number }> = [];
    part.atoms.forEach((atom, index) => {
      const width = atom.x1 - atom.x0;
      if (width < textHeight * 0.8) return;
      const inkIn = (y: number) => {
        let count = 0;
        for (let x = atom.x0; x < atom.x1; x++) count += ink.data[y * ink.width + x];
        return count;
      };
      let edge = -1;
      for (let y = cut; y <= limit; y++) {
        const count = inkIn(y);
        if (count >= width * 0.7) {
          edge = y;
          break;
        }
        if (count > 6) return;
      }
      if (edge < 0) return;
      let edgeEnd = edge;
      while (edgeEnd + 1 <= limit && inkIn(edgeEnd + 1) >= width * 0.7) edgeEnd += 1;
      part.atoms[index] = { ...atom, y0: atom.y0 ?? part.top, y1: edgeEnd + 1 };
      settled.push({ x0: atom.x0, x1: atom.x1, edgeEnd });
    });
    if (settled.length === 0) return -1;
    const lowest = Math.max(...settled.map((box) => box.edgeEnd));
    // 切れ目から底辺までの行に、枠以外の墨がないか。
    let clean = true;
    for (let y = cut; y <= lowest && clean; y++) {
      for (let x = x0; x < x1; x++) {
        if (ink.data[y * ink.width + x] && !settled.some((box) => x >= box.x0 && x < box.x1 && y <= box.edgeEnd)) {
          clean = false;
          break;
        }
      }
    }
    if (clean) return lowest;
    for (const box of settled) restMasks.push({ top: cut, bottom: box.edgeEnd + 1, left: box.x0, right: box.x1 });
    return -1;
  };
  let t = top;
  let b = bottom;
  for (;;) {
    if (b - t <= textHeight * 1.6) break;
    const typical = typicalOf(t, Math.min(b, t + Math.round(textHeight * 2.2)));
    let cut = -1;
    for (let y = t + Math.round(textHeight * 0.6); y <= Math.min(b - 1, t + Math.round(textHeight * 1.8)); y++) {
      if (low(y, typical) && (cut < 0 || counts[y - top] < counts[cut - top])) cut = y;
    }
    // 行の右の方に図の番号などが行の間にまたがって置かれていると、幅全体では切れ目がない。右に図の線がなければ、左半分だけで切れ目を探す。
    const midX = x0 + Math.round((x1 - x0) * 0.5);
    // 右半分にあるのが、図の番号のような少数の小さな記号だけのとき(図の線や破線があるときは使わない)。
    const rightSide = makeBandIn(ink, t, Math.min(b, t + Math.round(textHeight * 2.2)), midX, x1);
    const windowBottom = Math.min(b, t + Math.round(textHeight * 2.2));
    const glyphHeight = (atom: Atom) => {
      let y0 = -1;
      let y1 = -1;
      for (let y = t; y < windowBottom; y++) {
        if (columnHasInk(ink, atom, y, y + 1)) {
          if (y0 < 0) y0 = y;
          y1 = y + 1;
        }
      }
      return y1 - y0;
    };
    // 字の大きさの記号(高さが行の0.5〜1.3倍)だけ。破線の切れ端(細い・斜め)は含めない。
    const onlySmallMarks =
      rightSide.atoms.length > 0 &&
      rightSide.atoms.length <= 24 &&
      rightSide.atoms.every((atom) => atom.x1 - atom.x0 <= textHeight * 2 && glyphHeight(atom) >= textHeight * 0.5 && glyphHeight(atom) <= textHeight * 1.3);
    if (cut < 0 && onlySmallMarks && !hasLongStroke(ink, t, Math.min(b, t + Math.round(textHeight * 2.2)), midX, x1, strokeRule(textHeight))) {
      const mid = midX;
      const leftCount = (y: number) => {
        let count = 0;
        for (let x = x0; x < mid; x++) count += ink.data[y * ink.width + x];
        return count;
      };
      let typicalLeft = 0;
      for (let y = t; y < Math.min(b, t + Math.round(textHeight * 2.2)); y++) typicalLeft = Math.max(typicalLeft, leftCount(y));
      let best = Infinity;
      for (let y = t + Math.round(textHeight * 0.6); y <= Math.min(b - 1, t + Math.round(textHeight * 1.8)); y++) {
        const count = leftCount(y);
        if (count <= Math.max(2, typicalLeft * 0.05) && (count === 0 || thinCrossing(y, x0, mid)) && count < best) {
          best = count;
          cut = y;
        }
      }
    }
    if (cut < 0) break;
    // 切った下に残るのが細い帯(空欄の枠の底辺など)だけなら、それも行に含める。
    const end = b - cut - 1 < textHeight * 0.4 ? b : cut;
    const part = makeBandIn(ink, t, end, x0, x1);
    if (!lineLike(part, end === b ? 2 : 1.6)) {
      // 行の右側に図のラベルなどの小さな記号だけが重なっている場合は、行の前半だけを文章とする。
      // 図の側は元の範囲のまま残し、文章として出した部分を白く塗って二重に見えないようにする。
      let head = denseHead(part, textHeight);
      // 後ろが大きく(8文字分以上)離れていて、そこに字の並び(文章)がなければ、前半を文章とする(上の図の端などがかかっている場合)。
      if (!head) {
        const split = part.atoms.findIndex((atom, index) => index > 0 && atom.x0 - part.atoms[index - 1].x1 >= textHeight * 8);
        if (split > 0) {
          const headAtoms = part.atoms.slice(0, split);
          const candidate: Band = { ...part, atoms: headAtoms, right: headAtoms[headAtoms.length - 1].x1 };
          const rest = part.atoms.slice(split);
          let run = 1;
          let textLike = false;
          for (let index = 1; index < rest.length; index++) {
            run = rest[index].x0 - rest[index - 1].x1 <= textHeight * 0.8 ? run + 1 : 1;
            if (run >= 4) textLike = true;
          }
          if (!textLike && isDenseLine(candidate, textHeight) && candidate.right - candidate.left >= textHeight * 8) head = candidate;
        }
      }
      const gapAfter = head ? (part.atoms.find((atom) => atom.x0 > head.right)?.x0 ?? head.right) - head.right : 0;
      // 前半が幅の30%以上、または後ろの記号(図の番号など)が前半から大きく離れている(8文字分以上)とき。
      const longEnough = head !== null && (head.right - head.left >= (x1 - x0) * 0.3 || (head.right - head.left >= textHeight * 8 && gapAfter >= textHeight * 8));
      if (head && longEnough && part.bottom - part.top <= textHeight * 1.6) {
        above.push(head);
        const gapEnd = part.atoms.find((atom) => atom.x0 > head.right)?.x0 ?? head.right;
        const columnRight = Math.round((head.right + gapEnd) / 2);
        const mask = { top: t, bottom: cut, left: x0, right: columnRight };
        // 図の左に続く文章の行も、同じ列の範囲で1行ずつはがす(白く塗る範囲も下へ広げる)。
        let next = cut + 1;
        while (b - next >= textHeight * 0.5) {
          let lineEnd = b;
          if (b - next > textHeight * 1.8) {
            lineEnd = -1;
            for (let y = next + Math.round(textHeight * 0.6); y <= Math.min(b - 1, next + Math.round(textHeight * 1.8)); y++) {
              if (!columnHasInk(ink, { x0, x1: columnRight }, y, y + 1)) {
                lineEnd = y;
                break;
              }
            }
            if (lineEnd < 0) break;
          }
          const line = makeBandIn(ink, next, lineEnd, x0, columnRight);
          if (line.atoms.length === 0) {
            next = lineEnd + 1;
            continue;
          }
          if (!isDenseLine(line, textHeight) || line.right - line.left < (columnRight - x0) * 0.3 || lineEnd - next > textHeight * 1.8) break;
          above.push(line);
          mask.bottom = lineEnd;
          next = lineEnd + 1;
        }
        // 図の横の段の行として、段の右端を持たせる(段落のつながりの判断に使う)。
        const headIndex = above.indexOf(head);
        for (let k = headIndex; k >= 0 && k < above.length; k++) above[k] = { ...above[k], limit: columnRight, columnLeft: x0 };
        return { above, below, top: t, bottom: b, mask, ...(restMasks.length > 0 && { restMasks }) };
      }
      break;
    }
    const boxBottom = end !== b ? settleBoxBottoms(part, cut) : -1;
    above.push(part);
    t = end === b ? b : Math.max(cut + 1, boxBottom + 1);
  }
  for (;;) {
    if (b - t <= textHeight * 1.6) break;
    const typical = typicalOf(Math.max(t, b - Math.round(textHeight * 2.2)), b);
    let cut = -1;
    for (let y = b - Math.round(textHeight * 0.6); y >= Math.max(t + 1, b - Math.round(textHeight * 1.8)); y--) {
      if (low(y, typical) && (cut < 0 || counts[y - top] < counts[cut - top])) cut = y;
    }
    if (cut < 0) break;
    // 切れ目のすぐ下が上の行の空欄の枠の底辺だけなら、底辺の下から次の行とし、底辺は上の行の側に残す。
    let below0 = cut + 1;
    {
      let edgeEnd = -1;
      for (let y = cut + 1; y <= Math.min(b - 1, cut + Math.round(textHeight * 0.4)); y++) {
        let run = 0;
        let long = false;
        let ok = true;
        for (let x = x0; x <= x1; x++) {
          const on = x < x1 && ink.data[y * ink.width + x] === 1;
          if (on) {
            run += 1;
            continue;
          }
          if (run > 3 && run < textHeight * 0.8) ok = false;
          if (run >= textHeight * 0.8) long = true;
          run = 0;
        }
        if (!ok) break;
        if (long) edgeEnd = y;
        else if (edgeEnd >= 0) break;
      }
      if (edgeEnd >= 0) below0 = edgeEnd + 1;
    }
    const start = cut - t < textHeight * 0.4 ? t : below0;
    const part = makeBandIn(ink, start, b, x0, x1);
    if (!lineLike(part, start === t ? 2 : 1.6)) break;
    below.unshift(part);
    b = start === t ? t : start - 1 > cut ? start : cut;
  }
  return { above, below, top: t, bottom: b, ...(restMasks.length > 0 && { restMasks }) };
}

/**
 * 行の前半の文章部分。大きな空白の後ろが小さな記号(1.5文字分以下)だけのときに、前半を返す。
 * 後ろに文字のまとまり(表のセルなど)があれば null。
 */
export function denseHead(band: Band, textHeight: number): Band | null {
  const segments: Atom[][] = [[]];
  band.atoms.forEach((atom, index) => {
    if (index > 0 && atom.x0 - band.atoms[index - 1].x1 > textHeight * 2.2) segments.push([]);
    segments[segments.length - 1].push(atom);
  });
  if (segments.length < 2) return null;
  const width = (segment: Atom[]) => segment[segment.length - 1].x1 - segment[0].x0;
  const [head, ...others] = segments;
  // 前半が長い(ページ幅の30%以上)ときは、後ろの記号を矢印付きのラベル程度(2.5文字分)まで認める。
  // 後ろの記号が前半から大きく(8文字分以上)離れているときも同様(行の右に離れて置かれた図の見出しやラベル)。
  const farApart = others[0][0].x0 - head[head.length - 1].x1 >= textHeight * 8;
  const longHead = (width(head) >= (band.atoms[band.atoms.length - 1].x1 - band.atoms[0].x0) * 0.3 && width(head) >= textHeight * 12) || farApart;
  const limit = textHeight * (longHead ? 2.5 : 1.5);
  if (width(head) < textHeight * 2 || !others.every((segment) => width(segment) <= limit)) return null;
  return { ...band, atoms: head, right: head[head.length - 1].x1 };
}

/**
 * 範囲内を空白の行で分ける。分子・分母や添字のような小さな部分は、近い方の隣とまとめて切り離さない。
 */
export function rowPieces(ink: Ink, top: number, bottom: number, x0: number, x1: number, textHeight: number): Array<{ top: number; bottom: number }> {
  const pieces: Array<{ top: number; bottom: number; left: number; right: number }> = [];
  let start = -1;
  let left = x1;
  let right = x0;
  for (let y = top; y <= bottom; y++) {
    let has = false;
    if (y < bottom) {
      for (let x = x0; x < x1; x++) {
        if (ink.data[y * ink.width + x]) {
          has = true;
          left = Math.min(left, x);
          break;
        }
      }
      if (has) {
        for (let x = x1 - 1; x >= x0; x--) {
          if (ink.data[y * ink.width + x]) {
            right = Math.max(right, x + 1);
            break;
          }
        }
      }
    }
    if (has && start < 0) start = y;
    if (!has && start >= 0) {
      pieces.push({ top: start, bottom: y, left, right });
      start = -1;
      left = x1;
      right = x0;
    }
  }
  type Piece = { top: number; bottom: number; left: number; right: number };
  const small = (piece: Piece) => piece.bottom - piece.top < textHeight * 0.8 || piece.right - piece.left < (x1 - x0) * 0.25;
  // 分数の横棒: 小さな部分の真下(分子のとき)または真上(分母のとき)の行に、その幅の大半を覆う横線がある。
  // 横棒は小さな部分の幅とほぼ同じ範囲にあり、すぐ近く(0.6行以内)にある。表の枠線などは当たらない。
  const barNear = (piece: Piece, other: Piece, otherBelow: boolean) => {
    const gap = otherBelow ? other.top - piece.bottom : piece.top - other.bottom;
    if (gap > textHeight * 0.6) return false;
    const height = other.bottom - other.top;
    const from = otherBelow ? other.top : other.bottom - Math.ceil(height * 0.6);
    const to = otherBelow ? other.top + Math.ceil(height * 0.6) : other.bottom;
    const width = piece.right - piece.left;
    const lo = Math.max(x0, piece.left - Math.round(textHeight));
    const hi = Math.min(x1, piece.right + Math.round(textHeight));
    for (let y = from; y < to; y++) {
      let run = 0;
      for (let x = lo; x <= hi; x++) {
        const on = x < hi && ink.data[y * ink.width + x] === 1;
        if (on) {
          run += 1;
          continue;
        }
        const start = x - run;
        // 横棒の両端が小さな部分の左右の端の近くにあること
        if (run >= width * 0.7 && start >= piece.left - textHeight && start <= piece.left + width * 0.3 && x >= piece.right - width * 0.3 && x <= piece.right + textHeight) return true;
        run = 0;
      }
    }
    return false;
  };
  const attachedTo = (index: number): number | null => {
    const piece = pieces[index];
    const above = pieces[index - 1];
    const below = pieces[index + 1];
    const overlaps = (other: Piece) => Math.min(other.right, piece.right) - Math.max(other.left, piece.left) > 0;
    // 間隔が詰まっているだけで結合するのは、高さの小さい部分(添字など)に限る。短い1行は結合しない。
    const tiny = piece.bottom - piece.top < textHeight * 0.8;
    const candidates: Array<{ target: number; gap: number }> = [];
    // 添字は隣の行よりずっと幅が狭い。小さな字の注記の行(幅が広い)は結合しない。
    const narrowerThan = (other: Piece) => piece.right - piece.left <= (other.right - other.left) * 0.5;
    if (above && overlaps(above) && ((tiny && narrowerThan(above) && piece.top - above.bottom <= 2) || barNear(piece, above, false))) candidates.push({ target: index - 1, gap: piece.top - above.bottom });
    if (below && overlaps(below) && ((tiny && narrowerThan(below) && below.top - piece.bottom <= 2) || barNear(piece, below, true))) candidates.push({ target: index + 1, gap: below.top - piece.bottom });
    candidates.sort((a, b) => a.gap - b.gap);
    return candidates[0]?.target ?? null;
  };
  let index = 0;
  while (index < pieces.length && pieces.length > 1) {
    const target = small(pieces[index]) ? attachedTo(index) : null;
    if (target === null) {
      index += 1;
      continue;
    }
    const piece = pieces[index];
    const other = pieces[target];
    pieces[target] = {
      top: Math.min(other.top, piece.top),
      bottom: Math.max(other.bottom, piece.bottom),
      left: Math.min(other.left, piece.left),
      right: Math.max(other.right, piece.right),
    };
    pieces.splice(index, 1);
    index = Math.max(0, Math.min(index, target) - 1);
  }
  return pieces.map(({ top: t, bottom: b }) => ({ top: t, bottom: b }));
}

/**
 * 文章の行らしいか: 文字の間に、表の列の間のような大きな空白がない。
 * 行の頭の番号(「注 1」「A−13」など、5文字分まで)の後ろの空白は数えない。
 */
export function isDenseLine(band: Band, textHeight: number, strict = false): boolean {
  const start = band.atoms[0]?.x0 ?? 0;
  for (let i = 1; i < band.atoms.length; i++) {
    const gap = band.atoms[i].x0 - band.atoms[i - 1].x1;
    if (gap > textHeight * 2.2 && (strict || band.atoms[i - 1].x1 - start > textHeight * 5)) return false;
  }
  return true;
}

/** 指定の列の範囲に、指定の行の範囲で墨があるか。 */
function columnHasInk(ink: Ink, atom: Atom, top: number, bottom: number): boolean {
  for (let y = top; y < bottom; y++) {
    for (let x = atom.x0; x < atom.x1; x++) if (ink.data[y * ink.width + x]) return true;
  }
  return false;
}

/** 図の線の長さの基準。空欄の枠(縦が1行分程度)や分数の横棒は図とみなさない。 */
export interface StrokeRule {
  horizontal: number;
  vertical: number;
}

export function strokeRule(textHeight: number): StrokeRule {
  return { horizontal: Math.round(textHeight * 3), vertical: Math.round(textHeight * 1.8) };
}

/** 範囲内に、文字より長い縦線・横線(図の線)があるか。 */
export function hasLongStroke(ink: Ink, top: number, bottom: number, x0: number, x1: number, rule: StrokeRule): boolean {
  for (let y = top; y < bottom; y++) {
    let run = 0;
    for (let x = x0; x < x1; x++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= rule.horizontal) return true;
    }
  }
  for (let x = x0; x < x1; x++) {
    let run = 0;
    for (let y = top; y < bottom; y++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= rule.vertical) return true;
    }
  }
  return false;
}

/** 範囲内の長い線(図の線)が占める左端と右端。なければ null。 */
export function strokeExtent(ink: Ink, top: number, bottom: number, x0: number, x1: number, rule: StrokeRule): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let y = top; y < bottom; y++) {
    let run = 0;
    for (let x = x0; x < x1; x++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= rule.horizontal) {
        min = Math.min(min, x - run + 1);
        max = Math.max(max, x + 1);
      }
    }
  }
  for (let x = x0; x < x1; x++) {
    let run = 0;
    for (let y = top; y < bottom; y++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= rule.vertical) {
        min = Math.min(min, x);
        max = Math.max(max, x + 1);
        break;
      }
    }
  }
  return min <= max ? [min, max] : null;
}

/** 範囲の中で、縦の長い線(図の線)が始まる最も上の高さ。なければ null。 */
function strokeExtentTop(ink: Ink, top: number, bottom: number, x0: number, x1: number, vertical: number): number | null {
  let min = Infinity;
  for (let x = x0; x < x1; x++) {
    let run = 0;
    for (let y = top; y < Math.min(bottom, min + vertical); y++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= vertical) {
        min = Math.min(min, y - run + 1);
        break;
      }
    }
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * 図(長い線)と、その横の本文・表を分ける縦の空白を探す。
 * 一番広い空白ではなく図に最も近い空白で分けるので、表の列の間で切ることはない。
 */
export function splitBesideFigure(
  ink: Ink,
  top: number,
  bottom: number,
  minGap: number,
  rule: StrokeRule,
): { text: [number, number]; figure: [number, number]; figureLeft: boolean; textBottom?: number } | null {
  // 図の位置は縦線のまとまりで決める(本文中の分数の横棒は図とみなさない)。横線は、そのまとまりに重なるものだけ図に含める。
  const verticalColumns: number[] = [];
  const strokeStart = new Map<number, number>();
  for (let x = 0; x < ink.width; x++) {
    let run = 0;
    for (let y = top; y < bottom; y++) {
      run = ink.data[y * ink.width + x] ? run + 1 : 0;
      if (run >= rule.vertical) {
        verticalColumns.push(x);
        strokeStart.set(x, y - run + 1);
        break;
      }
    }
  }
  if (verticalColumns.length === 0) return null;
  const clusters: Array<[number, number]> = [];
  for (const x of verticalColumns) {
    const last = clusters[clusters.length - 1];
    if (last && x - last[1] <= rule.vertical * 2) last[1] = x + 1;
    else clusters.push([x, x + 1]);
  }
  const widen = (cluster: [number, number]): [number, number] => {
    let [lo, hi] = cluster;
    for (let y = top; y < bottom; y++) {
      let run = 0;
      for (let x = 0; x <= ink.width; x++) {
        const on = x < ink.width && ink.data[y * ink.width + x] === 1;
        if (on) {
          run += 1;
          continue;
        }
        const start = x - run;
        if (run >= rule.horizontal && start <= hi && x >= lo) {
          lo = Math.min(lo, start);
          hi = Math.max(hi, x);
        }
        run = 0;
      }
    }
    return [lo, hi];
  };

  const filled = new Uint8Array(ink.width);
  for (let x = 0; x < ink.width; x++) {
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + x]) {
        filled[x] = 1;
        break;
      }
    }
  }
  const first = filled.indexOf(1);
  const last = filled.lastIndexOf(1);
  const gaps: Array<[number, number]> = [];
  let x = first;
  while (x <= last) {
    if (filled[x]) {
      x += 1;
      continue;
    }
    const start = x;
    while (x <= last && !filled[x]) x += 1;
    if (x - start >= minGap) gaps.push([start, x]);
  }

  // 本文側に図の縦線がなく、本文の行として十分な幅がある分け方を探す。
  // 図が右にある場合は右端のまとまりから、図が複数並ぶ場合に備えて左へ1つずつ広げて試す。左にある場合も同様。
  const minText = ink.width * 0.3;
  const clean = (from: number, to: number) => to - from >= minText && !verticalColumns.some((column) => column >= from && column < to);
  // 本文側の下の方にだけ図の線(選択肢の小さな図など)がある場合、その線より上が本文の行になる。
  const strokeTopIn = (from: number, to: number) => {
    let min = Infinity;
    for (const column of verticalColumns) if (column >= from && column < to) min = Math.min(min, strokeStart.get(column)!);
    return min;
  };
  // 図の外側(右に図がある場合はさらに右)に残る部分に文章の行がなければ、それも図の一部(等価回路など)とみなす。
  const noProse = (from: number, to: number) => {
    if (to - from <= 0) return true;
    for (const piece of rowPieces(ink, top, bottom, from, to, rule.vertical / 1.8)) {
      const band = makeBandIn(ink, piece.top, piece.bottom, from, to);
      if (band.atoms.length > 0 && isDenseLine(band, rule.vertical / 1.8, true) && band.right - band.left >= (rule.vertical / 1.8) * 8) return false;
    }
    return true;
  };
  const candidates: Array<{ text: [number, number]; figure: [number, number]; figureLeft: boolean }> = [];
  for (let k = clusters.length - 1; k >= 0; k--) {
    const figure = widen([clusters[k][0], clusters[clusters.length - 1][1]]);
    const gapLeft = gaps.filter(([, end]) => end <= figure[0]).pop();
    if (gapLeft && (!gaps.some(([start]) => start >= figure[1]) || noProse(figure[1], last + 1))) {
      candidates.push({ text: [first, gapLeft[0]], figure: [gapLeft[1], last + 1], figureLeft: false });
    }
  }
  for (let k = 0; k < clusters.length; k++) {
    const figure = widen([clusters[0][0], clusters[k][1]]);
    const gapRight = gaps.find(([start]) => start >= figure[1]);
    if (gapRight && (!gaps.some(([, end]) => end <= figure[0]) || noProse(first, figure[0]))) {
      candidates.push({ text: [gapRight[1], last + 1], figure: [first, gapRight[0]], figureLeft: true });
    }
  }
  const whole = candidates.find((candidate) => clean(candidate.text[0], candidate.text[1]));
  if (whole) return whole;
  for (const candidate of candidates) {
    if (candidate.text[1] - candidate.text[0] < minText) continue;
    const strokeTop = strokeTopIn(candidate.text[0], candidate.text[1]);
    // 図の線の少し上(ラベルの分)までを本文とする。本文として2行分以上の高さがあるときだけ。
    const textBottom = Math.round(strokeTop - rule.vertical * 0.8);
    if (textBottom - top >= rule.vertical * 1.1) return { ...candidate, textBottom };
  }
  return null;
}

/** 指定の列の範囲の内側(両端の墨の間)で、最も広い縦の空白。なければ null。 */
function widestGap(ink: Ink, top: number, bottom: number, x0: number, x1: number): [number, number] | null {
  const filled = new Uint8Array(x1 - x0);
  for (let x = x0; x < x1; x++) {
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + x]) {
        filled[x - x0] = 1;
        break;
      }
    }
  }
  const first = filled.indexOf(1);
  const last = filled.lastIndexOf(1);
  if (first < 0) return null;
  let best: [number, number] | null = null;
  let x = first;
  while (x <= last) {
    if (filled[x]) {
      x += 1;
      continue;
    }
    const start = x;
    while (x <= last && !filled[x]) x += 1;
    if (!best || x - start > best[1] - best[0]) best = [start, x];
  }
  return best && [best[0] + x0, best[1] + x0];
}

/** 範囲の内側で最も広い縦の空白を探し、左右の段に分ける。 */
export function splitColumns(ink: Ink, top: number, bottom: number, minGap: number): { left: [number, number]; right: [number, number] } | null {
  const filled = new Uint8Array(ink.width);
  for (let x = 0; x < ink.width; x++) {
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + x]) {
        filled[x] = 1;
        break;
      }
    }
  }
  let first = filled.indexOf(1);
  let last = filled.lastIndexOf(1);
  if (first < 0) return null;
  let best: [number, number] | null = null;
  let x = first;
  while (x <= last) {
    if (filled[x]) {
      x += 1;
      continue;
    }
    const gapStart = x;
    while (x <= last && !filled[x]) x += 1;
    if (x - gapStart >= minGap && (!best || x - gapStart > best[1] - best[0])) best = [gapStart, x];
  }
  if (!best) return null;
  return { left: [first, best[0]], right: [best[1], last + 1] };
}

/**
 * 行の形だけでは分けられない帯(本文と図が上下に重なっている、行間が狭い)を、本文の行と図に分け直す。
 * 1. 空白の行で分ける(分数などの小さな部分は切り離さない)。
 * 2. それでも高い部分は、縦の空白で左右の段に分け、片側だけに図の線があれば、もう片側を本文の行に分ける。
 *    両側に図の線がある、またはどちらにもない(選択肢の表など)ときは分けない。
 */
export function refineBands(ink: Ink, input: Band[], textHeight: number, known?: FigureRegion[]): Band[] {
  const regions = known ?? [];
  const W = ink.width;
  const result: Band[] = [];
  // PDFの図形から分かった図が、空白の行で上下の帯に分かれていれば、1つの帯にまとめる。
  let bands = input;
  for (const region of regions) {
    const hit = bands.map((band, index) => (band.top < region.bottom && region.top < band.bottom ? index : -1)).filter((index) => index >= 0);
    if (hit.length < 2) continue;
    const first = hit[0];
    const last = hit[hit.length - 1];
    const merged = makeBandIn(ink, Math.min(...bands.slice(first, last + 1).map((band) => band.top)), Math.max(...bands.slice(first, last + 1).map((band) => band.bottom)), 0, W);
    bands = [...bands.slice(0, first), merged, ...bands.slice(last + 1)];
  }
  for (const band of bands) {
    // PDFに描かれた図がある帯は、その範囲で本文と図を分ける。
    const inBand = regions.filter((region) => region.top < band.bottom && band.top < region.bottom && Math.min(region.bottom, band.bottom) - Math.max(region.top, band.top) >= (region.bottom - region.top) * 0.5);
    if (inBand.length > 0) {
      const split = regionFigureSplit(ink, band.top, band.bottom, textHeight, inBand);
      if (split) {
        result.push(...split);
        continue;
      }
    }
    if (band.bottom - band.top <= textHeight * 1.6) {
      result.push(band);
      continue;
    }
    for (const piece of rowPieces(ink, band.top, band.bottom, 0, W, textHeight)) {
      if (piece.bottom - piece.top <= textHeight * 1.6) {
        result.push(makeBandIn(ink, piece.top, piece.bottom, 0, W));
        continue;
      }
      // 文章の行だけが詰まって並び、空欄の枠や丸囲み文字が行の間にはみ出している場合は、字ごとに行へ振り分ける。
      // 横にまっすぐ切ると、枠の底辺だけが次の行に残ってしまうため。
      {
        const lines = componentLines(ink, piece.top, piece.bottom, 0, W, textHeight);
        const overhang = lines?.some((line) => line.atoms.some((atom) => (atom.y1 ?? 0) - (atom.y0 ?? 0) > textHeight * 1.3));
        if (
          lines &&
          overhang &&
          !hasLongStroke(ink, piece.top, piece.bottom, 0, W, { horizontal: Infinity, vertical: strokeRule(textHeight).vertical }) &&
          lines.every((line) => isDenseLine(line, textHeight) && line.bottom - line.top <= textHeight * 2.2)
        ) {
          result.push(...lines);
          continue;
        }
      }
      // 上下の文章の行をはがし、残り(図や表など)だけを次の処理に回す。
      const peeled = peelLines(ink, piece.top, piece.bottom, 0, W, textHeight);
      result.push(...peeled.above);
      const restStart = result.length;
      const restMasks = peeled.restMasks;
      const attachRestMasks = () => {
        if (!restMasks) return;
        for (let k = restStart; k < result.length; k++) {
          const band = result[k];
          const hits = restMasks.filter((m) => m.top < band.bottom && m.bottom > band.top && m.left < band.right && m.right > band.left);
          if (hits.length > 0) result[k] = { ...band, masks: [...(band.masks ?? []), ...hits] };
        }
      };
      const rest = { top: peeled.top, bottom: peeled.bottom };
      const pushRest = () => {
        if (rest.bottom > rest.top) result.push(makeBandIn(ink, rest.top, rest.bottom, 0, W));
      };
      if (peeled.mask) {
        const mask = peeled.mask;
        // 文章として出した行を消した墨で、残り(図と、その横や下の本文)を通常どおり分け直せるなら、そちらを使う。
        if (rest.bottom - rest.top > textHeight * 1.6) {
          const erased: Ink = { width: ink.width, height: ink.height, data: ink.data.slice() };
          for (let y = mask.top; y < mask.bottom; y++) erased.data.fill(0, y * ink.width + mask.left, y * ink.width + mask.right);
          const again =
            splitAroundFigure(erased, rest.top, rest.bottom, textHeight) ??
            componentFigureSplit(erased, rest.top, rest.bottom, textHeight) ??
            tableBesideSplit(erased, rest.top, rest.bottom, textHeight);
          if (again && again.some((band) => !band.figure && isDenseLine(band, textHeight) && band.right - band.left >= textHeight * 8)) {
            result.push(...again.map((band) => (band.figure ? { ...band, masks: [...(band.masks ?? []), mask] } : band)));
            attachRestMasks();
            result.push(...peeled.below);
            continue;
          }
        }
        // 塗りつぶす部分(文章として出した行の前半)を除いて、ブロックの左右の範囲を求める。
        const whole = makeBandIn(ink, rest.top, rest.bottom, 0, W);
        const atoms = whole.atoms.filter((atom) => atom.x0 >= mask.right || columnHasInk(ink, atom, mask.bottom, rest.bottom));
        const left = atoms[0]?.x0 ?? mask.right;
        // 本文の横(ページの右寄り)に残る部分は、図・表のブロックとして扱う(文章をはさんで続く部分とまとめられるように)。
        result.push({ ...whole, atoms, left, right: atoms[atoms.length - 1]?.x1 ?? whole.right, mask, ...(left >= W * 0.4 && { figure: true }) });
        attachRestMasks();
        result.push(...peeled.below);
        continue;
      }
      if (rest.bottom - rest.top <= textHeight * 1.6) {
        pushRest();
        attachRestMasks();
        result.push(...peeled.below);
        continue;
      }
      const split =
        splitAroundFigure(ink, rest.top, rest.bottom, textHeight) ??
        componentFigureSplit(ink, rest.top, rest.bottom, textHeight) ??
        tableBesideSplit(ink, rest.top, rest.bottom, textHeight);
      if (!split) {
        // 図のない本文だけの部分で、まっすぐな切れ目がないときは、字ごとに行へ振り分ける(行より背の高いまとまりがあれば使わない)。
        // 丸囲み文字のように行からはみ出す字(行の高さの1.3倍超)がある場合に限る。
        const lines = componentLines(ink, rest.top, rest.bottom, 0, W, textHeight);
        const overhang = lines?.some((line) => line.atoms.some((atom) => (atom.y1 ?? 0) - (atom.y0 ?? 0) > textHeight * 1.3));
        const withLabels = lines && overhang && lines.every((line) => isDenseLine(line, textHeight)) ? null : componentLinesWithLabels(ink, rest.top, rest.bottom, textHeight);
        if (lines && overhang && lines.every((line) => isDenseLine(line, textHeight))) result.push(...lines);
        else if (withLabels) result.push(...withLabels);
        else pushRest();
        attachRestMasks();
        result.push(...peeled.below);
        continue;
      }
      result.push(...split);
      attachRestMasks();
      result.push(...peeled.below);
    }
  }
  // 凡例を図に移したあとに残る小さな切れ端(根号の上の線など)は、分子の行と同じく次の行へまとめる。
  // PDFの図形が分かっているページでは、図形のない所を墨の形から図としない(縦に並ぶ空欄の枠や式を図と見誤らない)。
  const checked = known
    ? result.flatMap((band) => {
        if (!band.figure || known.some((region) => region.left < band.right && band.left < region.right && region.top < band.bottom && band.top < region.bottom)) return [band];
        const pieces = rowPieces(ink, band.top, band.bottom, band.left, band.right, textHeight);
        const lines = pieces.map((piece) => makeBandIn(ink, piece.top, piece.bottom, band.left, band.right)).filter((line) => line.atoms.length > 0);
        return lines.length > 0 ? lines : [{ ...band, figure: undefined, mask: undefined, masks: undefined }];
      })
    : result;
  // 図にラベルを含めると図の範囲が広がり、そのすぐ外のラベルも図に近くなるので、2回通す。
  return splitRowAlignedTable(ink, mergeFractionRows(absorbFigureLabels(ink, absorbFigureLabels(ink, checked, textHeight), textHeight), textHeight), textHeight);
}

/**
 * 図のすぐ左にある短い字のまとまり(「V:直流電圧〔V〕」のような凡例)は、図に含める。
 * 選択肢の行の右端に並んでいても、本文側より図の方がはっきり近い(間が半分以下)ときだけ切り離す。
 */
function absorbFigureLabels(ink: Ink, bands: Band[], textHeight: number): Band[] {
  const W = ink.width;
  const figures = bands.filter((band) => band.figure);
  // 凡例を除いた残り。何行かがつながった帯(凡例が行の間にまたがっていた)なら、行ごとに分け直す。
  // とても背の高い帯(行の4.5倍超)は、行に分け直せたときだけ凡例を切り離す(分けられなければ null で、帯はそのまま)。
  const remainder = (band: Band, atoms: Atom[], right: number): Band[] | null => {
    const rest = { ...band, atoms, right };
    const tall = band.bottom - band.top > textHeight * 4.5;
    if (band.bottom - band.top <= textHeight * 1.8) return [rest];
    const limit = textHeight * (tall ? 3 : 1.8);
    let lines = componentLines(ink, band.top, band.bottom, band.left, right + 1, textHeight);
    // 字ごとに分けられない(分数の行など)ときは、上下の空白で切る。
    if (!lines || lines.length < 2 || !lines.every((line) => line.bottom - line.top <= limit)) {
      const pieces = rowPieces(ink, band.top, band.bottom, band.left, right + 1, textHeight);
      lines = pieces.length >= 2 ? pieces.map((piece) => makeBandIn(ink, piece.top, piece.bottom, band.left, right + 1)).filter((line) => line.atoms.length > 0) : null;
    }
    const ok = lines && lines.length >= 2 && lines.every((line) => line.bottom - line.top <= limit);
    if (!ok) return tall ? null : [rest];
    return lines!.map((line) => ({
      ...line,
      ...(band.limit !== undefined && { limit: band.limit }),
      ...(band.columnLeft !== undefined && { columnLeft: band.columnLeft }),
    }));
  };
  if (figures.length === 0) return bands;
  const out: Band[] = [];
  // ページ下端の試験記号(最後の短い帯)は図に含めない(問題の区切りの判定で使う)。
  const last = bands[bands.length - 1];
  for (const band of bands) {
    const footer =
      band === last &&
      band.right - band.left < W * 0.25 &&
      band.top > ink.height * 0.85 &&
      (band.left > W * 0.5 || (Math.abs((band.left + band.right) / 2 - W / 2) < W * 0.06 && band.right - band.left < W * 0.1));
    if (footer || band.figure || band.mask || band.masks || band.bottom - band.top > textHeight * 6 || band.atoms.length === 0) {
      out.push(band);
      continue;
    }
    // 図の真下や真上の列にある字(目盛りの説明・凡例・図の番号など)が、左の選択肢の行と同じ高さに並んでいる場合。
    // (何行かがつながった帯は、本文の行のことが多いので対象にしない。)
    const under = band.bottom - band.top > textHeight * 1.8 ? undefined : figures.find(
      (candidate) =>
        band.top < candidate.bottom + textHeight * 3 &&
        band.bottom > candidate.top - textHeight * 1.5 &&
        band.right > candidate.left &&
        band.right <= candidate.right + textHeight * 2,
    );
    if (under) {
      // 図の上・下の列にかかる部分を、行の中の一番右の大きな空白(字2個分以上)から切り離す(本文の途中では切らない)。
      let split = band.atoms[0] && band.atoms[0].x0 >= under.left - textHeight ? 0 : -1;
      band.atoms.forEach((atom, index) => {
        if (index > 0 && atom.x0 >= under.left - textHeight && atom.x0 - band.atoms[index - 1].x1 >= textHeight * 2) split = index;
      });
      // 式の番号(「・・・・⑤」の⑤など)は点線で式とつながっているので、左の部分から字4個分以上離れているときだけ切り離す。
      const group = split >= 0 ? band.atoms.slice(split) : [];
      const clean =
        group.length > 0 &&
        (split === 0 ? group[0].x0 >= W * 0.35 : group[0].x0 - band.atoms[split - 1].x1 >= textHeight * 4) &&
        // 小さな点が3つ以上並ぶもの(式の点線「・・・・」)は図の説明ではない。
        group.filter((atom) => atom.x1 - atom.x0 <= textHeight * 0.4).length < 3;
      const alignedUnder = clean
        ? bands.filter(
            (other) =>
              !other.figure &&
              other.bottom > under.top - textHeight * 4 &&
              other.top < under.bottom + textHeight * 4 &&
              other.atoms.some((atom, j) => Math.abs(atom.x0 - group[0].x0) <= textHeight && (j === 0 || atom.x0 - other.atoms[j - 1].x1 >= textHeight * 2)),
          ).length
        : 0;
      const kept = clean && alignedUnder <= 3 ? (split > 0 ? remainder(band, band.atoms.slice(0, split), band.atoms[split - 1].x1) : []) : null;
      if (kept) {
        under.left = Math.min(under.left, group[0].x0);
        under.right = Math.max(under.right, group[group.length - 1].x1);
        under.top = Math.min(under.top, band.top);
        under.bottom = Math.max(under.bottom, band.bottom);
        out.push(...kept);
        continue;
      }
    }
    const figure = figures.find(
      (candidate) =>
        band.top < candidate.bottom + textHeight * 0.5 &&
        band.bottom > candidate.top - textHeight * 0.5 &&
        band.right <= candidate.right &&
        candidate.left - band.right <= textHeight * 6,
    );
    if (!figure) {
      out.push(band);
      continue;
    }
    const atoms = band.atoms;
    let start = atoms.length - 1;
    while (start > 0 && atoms[start].x0 - atoms[start - 1].x1 <= textHeight) start -= 1;
    const labelLeft = atoms[start].x0;
    const gapToFigure = figure.left - band.right;
    const separated = start === 0 ? labelLeft >= W * 0.35 && gapToFigure <= textHeight * 3 : labelLeft - atoms[start - 1].x1 >= Math.max(textHeight * 3, gapToFigure * 1.8);
    // 表の列(同じ位置から始まる字が何行も並ぶ)は凡例ではない。
    // 図の上下近くの行で、大きな空白のあとに同じ位置から始まる字を数える。
    const aligned = bands.filter(
      (other) =>
        !other.figure &&
        other.bottom > figure.top - textHeight * 4 &&
        other.top < figure.bottom + textHeight * 4 &&
        other.atoms.some((atom, j) => Math.abs(atom.x0 - labelLeft) <= textHeight && (j === 0 || atom.x0 - other.atoms[j - 1].x1 >= textHeight * 2)),
    ).length;
    // 小さな点が3つ以上並ぶもの(式の点線「・・・・」と式の番号)は凡例ではない。
    const leader = atoms.slice(start).filter((atom) => atom.x1 - atom.x0 <= textHeight * 0.4).length >= 3;
    const kept = band.right - labelLeft > textHeight * 10 || !separated || aligned > 3 || leader ? null : start > 0 ? remainder(band, atoms.slice(0, start), atoms[start - 1].x1) : [];
    if (!kept) {
      out.push(band);
      continue;
    }
    figure.left = Math.min(figure.left, labelLeft);
    figure.top = Math.min(figure.top, band.top);
    figure.bottom = Math.max(figure.bottom, band.bottom);
    out.push(...kept);
  }
  return out;
}

/**
 * 本文の行と、右の選択肢の表の行が同じ高さに並んでいる場合(1行ずつの帯が「文章 + 表の行」になる)。
 * 続けて2行以上、左が文章(大きな空白のない8文字分以上)で右の同じ位置から表が始まるなら、左を本文の行に、右をまとめて1つの表のブロックにする。
 */
function splitRowAlignedTable(ink: Ink, bands: Band[], textHeight: number): Band[] {
  const W = ink.width;
  type Parts = { left: Band | null; rightX: number };
  const partsOf = (band: Band): Parts | null => {
    if (band.figure || band.mask || band.limit !== undefined || band.bottom - band.top > textHeight * 2.4) return null;
    let best = -1;
    let bestGap = 0;
    band.atoms.forEach((atom, index) => {
      if (index === 0) return;
      const gap = atom.x0 - band.atoms[index - 1].x1;
      // 最も左の大きな空白(表の中の列の間ではなく、本文と表の間)。
      if (best < 0 && gap >= textHeight * 2 && atom.x0 >= W * 0.45 && gap > bestGap) {
        best = index;
        bestGap = gap;
      }
    });
    if (best < 0) return band.left >= W * 0.45 ? { left: null, rightX: band.left } : null;
    const atoms = band.atoms.slice(0, best);
    const left: Band = { ...band, atoms, right: atoms[atoms.length - 1].x1 };
    if (!isDenseLine(left, textHeight, true) || left.right - left.left < textHeight * 5) return null;
    return { left, rightX: band.atoms[best].x0 };
  };
  const out: Band[] = [];
  let i = 0;
  while (i < bands.length) {
    const first = partsOf(bands[i]);
    if (!first) {
      out.push(bands[i]);
      i += 1;
      continue;
    }
    let j = i;
    const run: Parts[] = [];
    while (j < bands.length) {
      const parts = partsOf(bands[j]);
      if (!parts || (run.length > 0 && Math.abs(parts.rightX - run[0].rightX) > textHeight * 6)) break;
      run.push(parts);
      j += 1;
    }
    // 左が本文の段らしいこと: 幅の30%以上の文章の行が2行以上あり、そのうち2行以上が段の右端にそろっている(表のセルの文は短く不ぞろい)。
    const wide = run.filter((parts) => parts.left && parts.left.right - parts.left.left >= Math.max(textHeight * 10, W * 0.3));
    const edge = wide.length > 0 ? Math.max(...wide.map((parts) => parts.left!.right)) : 0;
    const withText = wide.filter((parts) => parts.left!.right >= edge - textHeight * 1.5).length;
    if (withText < 2) {
      out.push(bands[i]);
      i += 1;
      continue;
    }
    const rightX = Math.min(...run.map((parts) => parts.rightX));
    const leftRight = Math.max(...run.filter((parts) => parts.left).map((parts) => parts.left!.right));
    if (leftRight >= rightX - textHeight) {
      out.push(bands[i]);
      i += 1;
      continue;
    }
    const top = bands[i].top;
    const bottom = bands[j - 1].bottom;
    const columnLeft = Math.min(...run.filter((parts) => parts.left).map((parts) => parts.left!.left));
    for (const parts of run) {
      if (!parts.left) continue;
      const { masks: _masks, ...left } = parts.left;
      out.push({ ...left, limit: rightX - 1, columnLeft });
    }
    const right = Math.max(...bands.slice(i, j).map((band) => band.right));
    const masks = bands.slice(i, j).flatMap((band) => band.masks ?? []).filter((mask) => mask.right > rightX);
    out.push({ ...makeBandIn(ink, top, bottom, rightX, right + 1), figure: true, ...(masks.length > 0 && { masks }) });
    i = j;
  }
  return out;
}

/**
 * 本文と図が横に並ぶ部分を、本文の行・図・本文側の下の小さな図に分ける。分けられなければ null。
 * 空白の幅は、まず本文の行の高さの0.7倍(下限は幅の1.2%)で探す。見つからなければ、より狭い空白でも試すが、
 * そのときは本文側に図のラベルらしい行(本文の字下げ位置より右から始まる短い行)がないことを条件にする。
 */
function splitAroundFigure(ink: Ink, top: number, bottom: number, textHeight: number): Band[] | null {
  const W = ink.width;
  const stroke = strokeRule(textHeight);
  const attempt = (minGap: number, strictLabels: boolean, given?: ReturnType<typeof splitBesideFigure>): Band[] | null => {
    const split = given ?? splitBesideFigure(ink, top, bottom, minGap, stroke);
    if (!split) return null;
    // 本文側の下の方にだけ図がある場合は、その上までを本文の範囲とし、下は別のブロックにする。
    let textBottom = bottom;
    if (split.textBottom !== undefined) textBottom = emptyRowIn(ink, split.textBottom, top, split.text[0], split.text[1]) ?? top;
    // 図の横の部分に図の線が残っていれば(図が二つ並ぶなど)分けない。本文側が狭すぎるときも分けない。
    if (
      textBottom - top < textHeight ||
      split.text[1] - split.text[0] < W * 0.3 ||
      hasLongStroke(ink, top, textBottom, split.text[0], split.text[1], { horizontal: Infinity, vertical: stroke.vertical })
    ) {
      return null;
    }
    let figureSide = split.figure;
    // 本文側の行を求める。図のラベルを図の側へ移したときは、本文側をラベルの手前まで狭めてもう一度求める。
    const collect = (textSide: [number, number]) => {
      // 本文側の中でも、行間が狭くつながった行は「ほぼ空白」の行で上下からはがして1行ずつにする。
      const rawLines: Band[] = rowPieces(ink, top, textBottom, textSide[0], textSide[1], textHeight)
        .flatMap((piece) => {
          if (piece.bottom - piece.top <= textHeight * 1.6) return [makeBandIn(ink, piece.top, piece.bottom, textSide[0], textSide[1])];
          const peeled = peelLines(ink, piece.top, piece.bottom, textSide[0], textSide[1], textHeight);
          if (peeled.mask) return [makeBandIn(ink, piece.top, piece.bottom, textSide[0], textSide[1])];
          let middle: Band[] = peeled.bottom > peeled.top ? [makeBandIn(ink, peeled.top, peeled.bottom, textSide[0], textSide[1])] : [];
          // 図や表の横の本文の段なので、各行が文章の行なら字ごとに振り分けてよい(枠や添字・平方根などで行がつながる場合も)。
          if (peeled.bottom - peeled.top > textHeight * 1.6) {
            const lines = componentLines(ink, peeled.top, peeled.bottom, textSide[0], textSide[1], textHeight);
            // 行末に図のラベルが離れて付いている行も文章の行とみなす(ラベルは後で図の側へ戻す)。
            if (lines?.every((line) => isDenseLine(line, textHeight) || denseHead(line, textHeight) !== null)) middle = lines;
          }
          return [...peeled.above, ...middle, ...peeled.below];
        })
        .map((line) => ({ ...line, limit: textSide[1], columnLeft: textSide[0] }));
      mergeFractionRows(rawLines, textHeight);
      // 図のラベル(「12[V]」など)が本文側の右端に入り込んでいることがある。
      // 行の右端に離れて付いた小さな記号は図のラベルとして図の側へ戻し、ラベルだけの行も図の側へ回す。
      const sideWidth = textSide[1] - textSide[0];
      const nearFigure = (x: number) => (split.figureLeft ? x <= textSide[0] + sideWidth * 0.3 : x >= textSide[1] - sideWidth * 0.3);
      const labels: Array<{ top: number; bottom: number; x0: number; x1: number; head?: Band }> = [];
      const textLines: Band[] = [];
      for (const line of rawLines) {
        const width = line.right - line.left;
        if (!split.figureLeft && width <= textHeight * 4 && nearFigure(line.left)) {
          labels.push({ top: line.top, bottom: line.bottom, x0: line.left, x1: line.right });
          continue;
        }
        // 表の行などの右端に、図の側の凡例の頭(「Vi :」など)が分かれ目に接して付いている場合も、図の側へ戻す。
        if (!split.figureLeft && !isDenseLine(line, textHeight) && textSide[1] - line.right <= textHeight * 0.5) {
          let start = line.atoms.length - 1;
          while (start > 0 && line.atoms[start].x0 - line.atoms[start - 1].x1 <= textHeight * 1.2) start -= 1;
          const tail = line.atoms.slice(start);
          const tailWidth = tail[tail.length - 1].x1 - tail[0].x0;
          if (
            start > 0 &&
            tailWidth <= textHeight * 4 &&
            columnHasInk(ink, { x0: figureSide[0], x1: Math.min(ink.width, figureSide[0] + textHeight) }, line.top, line.bottom)
          ) {
            const headAtoms = line.atoms.slice(0, start);
            const head: Band = { ...line, atoms: headAtoms, right: headAtoms[headAtoms.length - 1].x1 };
            labels.push({ top: line.top, bottom: line.bottom, x0: tail[0].x0, x1: tail[tail.length - 1].x1, head });
            textLines.push(head);
            continue;
          }
        }
        if (!split.figureLeft && !isDenseLine(line, textHeight)) {
          const head = denseHead(line, textHeight);
          const tail = head ? line.atoms.filter((atom) => atom.x0 > head.right) : [];
          if (head && tail.length > 0 && nearFigure(tail[0].x0)) {
            labels.push({ top: line.top, bottom: line.bottom, x0: tail[0].x0, x1: tail[tail.length - 1].x1, head });
            textLines.push({ ...head, limit: textSide[1], columnLeft: textSide[0] });
            continue;
          }
        }
        textLines.push(line);
      }
      return { textLines, labels };
    };
    let textSide: [number, number] = split.text;
    let { textLines, labels } = collect(textSide);
    if (labels.length > 0) {
      const narrowed: [number, number] = [textSide[0], Math.min(...labels.map((label) => label.x0)) - 1];
      if (narrowed[1] - narrowed[0] >= W * 0.3) {
        const again = collect(narrowed);
        if (again.labels.length === 0) {
          textSide = narrowed;
          textLines = again.textLines;
        }
      }
    }
    // 図の凡例(「D:ドレイン」など)が本文側の右に並び、行と交互に入り組んでいる場合。本文側の中に広い縦の空白があれば、
    // そこから右を図の側にして求め直し、本文側がすべて文章の行になるなら、そちらを使う。
    const proseLine = (line: Band) => isDenseLine(line, textHeight) && line.bottom - line.top <= textHeight * 3;
    if (labels.length === 0 && !split.figureLeft && textLines.some((line) => !proseLine(line))) {
      const inner = widestGap(ink, top, textBottom, textSide[0], textSide[1]);
      if (inner && inner[1] - inner[0] >= textHeight * 2.5 && inner[0] - textSide[0] >= W * 0.3) {
        const again = collect([textSide[0], inner[0]]);
        if (again.labels.length === 0 && again.textLines.length > 0 && again.textLines.every(proseLine)) {
          textSide = [textSide[0], inner[0]];
          textLines = again.textLines;
          figureSide = [inner[1], figureSide[1]];
        }
      }
    }
    // 等幅の字の間の隙間が縦にそろい、図の上の行の途中で分けてしまった場合。図の側の上の部分(図の線より上で、空白の行で
    // 図と離れている)が、本文側の行の続き(隙間のすぐ右から始まる文章の行)なら、その行は本文側とつないで1行にし、図はその下からとする。
    let figureTop = top;
    const continuationMasks: Mask[] = [];
    // 行の続き(「とする。」など)が図の側へはみ出していれば本文側へつなぐ。図の側ではその部分を白く塗る。
    // afterHead: 図の上の行をつないだ後(続きの行が途切れたら終わる)。
    const attachTails = (from: number, afterHead: boolean) => {
      for (let k = from; k < textLines.length; k++) {
        const text = textLines[k];
        if (text.right < textSide[1] - textHeight || (afterHead && text.top < figureTop - textHeight)) {
          if (afterHead) break;
          continue;
        }
        const side = makeBandIn(ink, text.top, text.bottom, figureSide[0], figureSide[1]);
        const run: Atom[] = [];
        for (const atom of side.atoms) {
          const previous = run[run.length - 1];
          if (previous ? atom.x0 - previous.x1 <= textHeight * 0.8 : atom.x0 - text.right <= textHeight * 1.5) run.push(atom);
          else break;
        }
        if (run.length === 0) {
          if (afterHead) break;
          continue;
        }
        const x0 = run[0].x0;
        const x1 = run[run.length - 1].x1;
        const next = side.atoms[run.length];
        // 墨のある高さの範囲(文章の1文字分程度であること)。
        let inkTop = text.bottom;
        let inkBottom = text.top;
        for (let y = text.top; y < text.bottom; y++) {
          if (columnHasInk(ink, { x0, x1 }, y, y + 1)) {
            inkTop = Math.min(inkTop, y);
            inkBottom = y + 1;
          }
        }
        const piece = makeBandIn(ink, inkTop, inkBottom, x0, x1);
        const isolated =
          !columnHasInk(ink, { x0, x1 }, Math.max(0, text.top - 2), text.top) &&
          !columnHasInk(ink, { x0, x1 }, text.bottom, Math.min(ink.height, text.bottom + 2));
        if (
          (next && next.x0 - x1 < textHeight * 1.5) ||
          !isolated ||
          piece.bottom - piece.top > textHeight * 1.6 ||
          !isDenseLine(piece, textHeight) ||
          hasLongStroke(ink, text.top, text.bottom, x0, x1, stroke) ||
          // 図の上の行をつないでいないときは、図のラベル(1〜2文字)と取り違えないよう、2文字分以上の長さを求める。
          (!afterHead && x1 - x0 < textHeight * 2)
        ) {
          if (afterHead) break;
          continue;
        }
        textLines[k] = { ...text, right: x1, atoms: [...text.atoms, ...piece.atoms.map((atom) => ({ ...atom, y0: inkTop, y1: inkBottom }))] };
        delete textLines[k].limit;
        delete textLines[k].columnLeft;
        continuationMasks.push({ top: inkTop, bottom: inkBottom, left: x0, right: x1 });
      }
    };
    if (labels.length === 0 && figureSide[0] - textSide[1] <= textHeight * 1.2) {
      const strokeTop = strokeExtentTop(ink, top, bottom, figureSide[0], figureSide[1], stroke.vertical);
      // 図の線がなければ(縦線のない小さな図として分けた場合)、図の側全体を行の続きの候補とする。
      const headBottom = strokeTop === null ? bottom : emptyRowIn(ink, strokeTop, top, figureSide[0], figureSide[1]);
      if (headBottom !== null && headBottom - top >= textHeight * 0.8) {
        const head = makeBandIn(ink, top, headBottom, figureSide[0], figureSide[1]);
        const headLines =
          head.atoms.length === 0
            ? []
            : headBottom - top > textHeight * 1.6
              ? componentLines(ink, top, headBottom, figureSide[0], figureSide[1], textHeight)
              : [head];
        const center = (band: Band) => (band.top + band.bottom) / 2;
        const matches = headLines?.map((line) => textLines.findIndex((text) => Math.abs(center(text) - center(line)) <= textHeight * 0.6));
        if (
          headLines &&
          headLines.length > 0 &&
          matches!.every((match, i) => match === i) &&
          headLines.every((line, i) => isDenseLine(line, textHeight) && line.left - textLines[i].right <= textHeight * 1.5)
        ) {
          headLines.forEach((line, i) => {
            const text = textLines[i];
            const bandTop = Math.min(text.top, line.top);
            const bandBottom = Math.max(text.bottom, line.bottom);
            const withRange = (atoms: Atom[], band: Band) => atoms.map((atom) => ({ ...atom, y0: atom.y0 ?? band.top, y1: atom.y1 ?? band.bottom }));
            textLines[i] = {
              top: bandTop,
              bottom: bandBottom,
              left: text.left,
              right: line.right,
              baseline: text.baseline,
              atoms: [...withRange(text.atoms, text), ...withRange(line.atoms, line)],
            };
          });
          figureTop = headBottom;
          attachTails(headLines.length, true);
        }
      }
      if (figureTop === top) attachTails(0, false);
    }
    // 上に文章の行、その下に選択肢・表の行が続く形なら分ける(表の行は analyzeDocument で崩さずに表示する)。
    // 表の途中に長い文章の行が割り込む形(表の横の凡例など)は分けない。分数を含む背の高い数式の行も文章側として扱う。
    const prose = (line: Band) => isDenseLine(line, textHeight) && line.bottom - line.top <= textHeight * 3;
    const firstOther = textLines.findIndex((line) => !prose(line));
    const tailHasProse =
      firstOther >= 0 &&
      textLines
        .slice(firstOther)
        .some((line) => isDenseLine(line, textHeight, true) && line.right - line.left >= textHeight * 8 && line.bottom - line.top <= textHeight * 1.6);
    // 文章の行の間に数式の行が1〜2行ずつ挟まる形(表のように文章でない行が3行以上続くことがない)は、本文の段とみなす。
    let run = 0;
    let longestRun = 0;
    for (const line of textLines) {
      run = prose(line) ? 0 : run + 1;
      longestRun = Math.max(longestRun, run);
    }
    const formulaColumn = !given && longestRun <= 2 && textLines.filter((line) => prose(line) && line.right - line.left >= textHeight * 8).length >= 2;
    if (textLines.length === 0 || (!formulaColumn && (firstOther === 0 || tailHasProse))) return null;
    // 縦線のない小さな図として分ける場合は、本文側がすべて文章の行で、2行以上あることを条件にする。
    if (given && (firstOther >= 0 || textLines.filter((line) => line.right - line.left >= textHeight * 8).length < 2)) return null;
    // 狭い空白で分けたときは、図のラベルが本文側に紛れていないか確かめる。
    if (strictLabels && textLines.some((line) => line.left > textSide[0] + (textSide[1] - textSide[0]) * 0.25)) return null;
    let figure: Band = { ...makeBandIn(ink, figureTop, bottom, figureSide[0], figureSide[1]), figure: true };
    // 図の側がすべて本文の行の続きだった場合は、図はない。
    if (figureTop >= bottom - 1 || figure.atoms.length === 0) {
      const lines = textLines.map(({ limit: _limit, columnLeft: _columnLeft, ...line }) => line);
      if (textBottom < bottom) lines.push({ ...makeBandIn(ink, textBottom, bottom, textSide[0], textSide[1]), figure: true });
      return lines;
    }
    if (continuationMasks.length > 0) {
      // 白く塗る部分(本文側へつないだ行の続き)を除いて、図の左右の範囲を求める。
      const atoms = figure.atoms.filter(
        (atom) =>
          !continuationMasks.some((mask) => atom.x0 >= mask.left && atom.x1 <= mask.right) ||
          continuationMasks.some((mask) => columnHasInk(ink, atom, figureTop, mask.top) || columnHasInk(ink, atom, mask.bottom, bottom)),
      );
      if (atoms.length > 0) figure = { ...figure, atoms, left: atoms[0].x0, right: atoms[atoms.length - 1].x1, masks: continuationMasks };
    }
    if (labels.length > 0) {
      // 図の範囲をラベルの位置まで広げ、その範囲に入る本文(ラベル以外)を白く塗る。
      const labelLeft = Math.min(...labels.map((label) => label.x0));
      const masks: Mask[] = [];
      for (const line of textLines) {
        const label = labels.find((candidate) => candidate.head && candidate.top === line.top);
        const right = label ? label.x0 - 1 : line.right;
        if (right > labelLeft) masks.push({ top: line.top, bottom: line.bottom, left: labelLeft, right });
      }
      figure = { ...makeBandIn(ink, top, bottom, labelLeft, figureSide[1]), figure: true, ...(masks.length > 0 && { masks }) };
    }
    // 本文側の下に残る部分(選択肢の小さな図など)は、崩さずに1つのブロックにする。
    if (textBottom < bottom) textLines.push({ ...makeBandIn(ink, textBottom, bottom, textSide[0], textSide[1]), figure: true });
    // 画面では左の段から順に並べる。
    return split.figureLeft ? [figure, ...textLines] : [...textLines, figure];
  };
  const normal = Math.max(Math.round(W * 0.012), Math.round(textHeight * 0.7));
  return attempt(normal, false) ?? attempt(Math.max(4, Math.round(textHeight * 0.3)), true) ?? attempt(normal, true, smallFigureSplit(ink, top, bottom, normal));
}

/**
 * 分数の分子のような小さな行(行の高さの0.8倍以下で、6文字分以下か、間の空いた記号だけ)が、すぐ下の行の上に接していれば、その行に含める。
 * 字ごとに範囲を持たせるので、分子・分数の横棒・分母が同じ行で一緒に切り出される。
 */
function mergeFractionRows(lines: Band[], textHeight: number): Band[] {
  for (let k = lines.length - 2; k >= 0; k--) {
    const small = lines[k];
    const next = lines[k + 1];
    if (
      small.figure ||
      next.figure ||
      // 小さな行: 高さが行の0.8倍以下で6文字分以下、または間の空いた少数の記号(分子が並ぶ行など。高さは行の1.1倍まで)。
      !(
        (small.bottom - small.top <= textHeight * 0.8 && small.right - small.left <= textHeight * 6) ||
        // 根号の上の線などの短い切れ端(すぐ下の行に接している)。
        (small.atoms.length <= 3 && small.right - small.left <= textHeight * 4 && small.bottom - small.top <= textHeight * 1.25) ||
        (small.atoms.length <= 8 &&
          small.bottom - small.top <= textHeight * 1.1 &&
          (!isDenseLine(small, textHeight) || small.atoms.every((atom) => atom.x1 - atom.x0 <= textHeight * 2)))
      ) ||
      next.top - small.bottom > 4 ||
      small.left < next.left ||
      small.right > next.right
    ) {
      continue;
    }
    const withRange = (band: Band) => band.atoms.map((atom) => ({ ...atom, y0: atom.y0 ?? band.top, y1: atom.y1 ?? band.bottom }));
    const atoms = [...withRange(small), ...withRange(next)].sort((a, b) => a.x0 - b.x0);
    const merged: Atom[] = [];
    for (const atom of atoms) {
      const last = merged[merged.length - 1];
      if (last && atom.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, atom.x1);
        last.y0 = Math.min(last.y0!, atom.y0!);
        last.y1 = Math.max(last.y1!, atom.y1!);
      } else merged.push({ ...atom });
    }
    lines.splice(k, 2, { ...next, top: Math.min(small.top, next.top), atoms: merged });
  }
  // 分数の分母だけが下に分かれた短い切れ端(すぐ上の行に接している)は、上の行へまとめる。
  for (let k = 1; k < lines.length; k++) {
    const small = lines[k];
    const prev = lines[k - 1];
    const next = lines[k + 1];
    if (
      small.figure ||
      prev.figure ||
      small.mask ||
      small.masks ||
      !(small.atoms.length <= 3 && small.right - small.left <= textHeight * 4 && small.bottom - small.top <= textHeight * 1.25) ||
      small.top - prev.bottom > 4 ||
      small.left < prev.left ||
      small.right > prev.right ||
      // 上の行が式の行(短い)のときだけ。文章の行の下の切れ端は、次の式の分子のことがある。
      prev.right - prev.left > textHeight * 12 ||
      (next !== undefined && !next.figure && next.top - small.bottom <= 4)
    ) {
      continue;
    }
    const withRange = (band: Band) => band.atoms.map((atom) => ({ ...atom, y0: atom.y0 ?? band.top, y1: atom.y1 ?? band.bottom }));
    const atoms = [...withRange(prev), ...withRange(small)].sort((a, b) => a.x0 - b.x0);
    const merged: Atom[] = [];
    for (const atom of atoms) {
      const last = merged[merged.length - 1];
      if (last && atom.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, atom.x1);
        last.y0 = Math.min(last.y0!, atom.y0!);
        last.y1 = Math.max(last.y1!, atom.y1!);
      } else merged.push({ ...atom });
    }
    lines.splice(k - 1, 2, { ...prev, bottom: Math.max(prev.bottom, small.bottom), atoms: merged });
    k -= 1;
  }
  return lines;
}

/** PDFの描画命令から求めた図の範囲(座標は解析幅の px)。parts は図を形づくる図形の矩形。 */
export interface FigureRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
  parts?: Array<{ left: number; top: number; right: number; bottom: number }>;
}

/**
 * PDFに描かれた図形から分かった図の範囲で、本文と図を分ける(墨の形から図を推測しない)。
 * 図形に重なる墨は図の線、図の範囲の中にあって範囲の外へ続かない字は図のラベル、それ以外は本文の行とする。
 */
export function regionFigureSplit(ink: Ink, top: number, bottom: number, textHeight: number, regions: FigureRegion[]): Band[] | null {
  const W = ink.width;
  const height = bottom - top;
  if (height <= 0 || W * height > 4_000_000 || regions.length === 0) return null;
  const label = new Int32Array(W * height).fill(-1);
  const boxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const index = y * W + x;
      if (label[index] >= 0 || !ink.data[(top + y) * W + x]) continue;
      const id = boxes.length;
      const box = { x0: x, x1: x + 1, y0: y, y1: y + 1 };
      label[index] = id;
      stack.push(index);
      while (stack.length > 0) {
        const current = stack.pop()!;
        const cx = current % W;
        const cy = (current - cx) / W;
        if (cx < box.x0) box.x0 = cx;
        if (cx + 1 > box.x1) box.x1 = cx + 1;
        if (cy < box.y0) box.y0 = cy;
        if (cy + 1 > box.y1) box.y1 = cy + 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= height) continue;
            const next = ny * W + nx;
            if (label[next] >= 0 || !ink.data[(top + ny) * W + nx]) continue;
            label[next] = id;
            stack.push(next);
          }
        }
      }
      boxes.push(box);
    }
  }
  // ページ座標の箱。
  const page = boxes.map((box) => ({ x0: box.x0, x1: box.x1, y0: box.y0 + top, y1: box.y1 + top }));
  const overlaps = (a: { x0: number; x1: number; y0: number; y1: number }, r: { left: number; top: number; right: number; bottom: number }, pad: number) =>
    a.x0 < r.right + pad && r.left - pad < a.x1 && a.y0 < r.bottom + pad && r.top - pad < a.y1;
  const owner = new Int32Array(boxes.length).fill(-1);
  // 図形に重なる墨(図の線・画像)。
  page.forEach((box, id) => {
    regions.forEach((region, r) => {
      if (owner[id] >= 0) return;
      const parts = region.parts ?? [region];
      if (parts.some((part) => overlaps(box, part, 1))) owner[id] = r;
    });
  });
  // 図の範囲の中や周り(目盛りの数字・軸の名前など)の字: 横に続く字の並びが図から離れて延びていなければ図のラベル。
  const rowOverlap = (a: { y0: number; y1: number }, b: { y0: number; y1: number }) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
  // 図形に重なっていても、図の外まで続く本文の行の字や空欄の枠は本文に戻す(透明な画像が本文に重なる場合や、行末の空欄の枠が図に接する場合)。
  const charLike = (box: { x0: number; x1: number; y0: number; y1: number }) => box.y1 - box.y0 <= textHeight * 2 && box.x1 - box.x0 <= textHeight * 8;
  page.forEach((box, id) => {
    if (owner[id] < 0 || !charLike(box)) return;
    const region = regions[owner[id]];
    let x0 = box.x0;
    let x1 = box.x1;
    let free = 0;
    for (let grown = true; grown; ) {
      grown = false;
      page.forEach((other, j) => {
        if (j === id || !charLike(other) || Math.min(box.y1, other.y1) - Math.max(box.y0, other.y0) < Math.min(box.y1 - box.y0, other.y1 - other.y0) * 0.5) return;
        if (other.x1 >= x0 - textHeight * 1.2 && other.x1 <= x0 + 1 && other.x0 < x0) {
          x0 = other.x0;
          if (owner[j] < 0) free += 1;
          grown = true;
        } else if (other.x0 <= x1 + textHeight * 1.2 && other.x0 >= x1 - 1 && other.x1 > x1) {
          x1 = other.x1;
          if (owner[j] < 0) free += 1;
          grown = true;
        }
      });
    }
    if (free >= 3 && (x0 < region.left - textHeight * 3 || x1 > region.right + textHeight * 3)) owner[id] = -1;
  });
  // 図が右寄り(本文は左)なら図の右側の字(凡例など)も、左寄りなら図の左側の字もラベルの候補にする。
  const side = (region: FigureRegion) => (region.left > W * 0.35 ? 'right' : region.right < W * 0.65 ? 'left' : 'center');
  // 図の位置(右寄り・左寄り)は、元の図形の範囲で決める(ラベルで広げた範囲では変えない)。
  const sides = regions.map(side);
  const candidate = (box: { x0: number; x1: number; y0: number; y1: number }, region: FigureRegion, r: number) => {
    const pad = textHeight * 1.5;
    const where = sides[r];
    // 右寄りの図は、上に字4個分ほど離れた題や説明(「I_b:ベース電流」など)も候補にする(本文につながる字は後で除く)。
    if (box.y0 < region.top - (where === 'right' ? textHeight * 4 : pad) || box.y1 > region.bottom + pad) return false;
    // 字の点ほどの小さな墨のかけらは、元の図の範囲の外ではラベルにしない(本文の字の一部)。
    const original = regions[r];
    if (box.x1 - box.x0 <= 4 && box.y1 - box.y0 <= 4 && (box.x1 < original.left || box.x0 > original.right || box.y1 < original.top || box.y0 > original.bottom)) return false;
    if (where === 'right') return box.x0 >= original.left - textHeight * 10;
    if (where === 'left') return box.x1 <= region.right + pad;
    return box.x0 >= original.left - textHeight * 3 && box.x1 <= original.right + textHeight * 3;
  };
  // 図に含めた字の分だけ図の範囲を上下に広げ、図の下の「図1」や説明の行も順に含める。
  const grown = regions.map((region) => ({ ...region }));
  // 広げるのは右寄りの図だけ(本文は左)。中央の図の下の選択肢の行などを取り込まないように。
  const extend = () => {
    page.forEach((box, id) => {
      const r = owner[id];
      if (r < 0 || side(regions[r]) !== 'right') return;
      // 広げすぎて本文まで取り込まないよう、元の図形から左へ字10個分、上へ字4個分までにする。
      grown[r].top = Math.max(regions[r].top - textHeight * 4, Math.min(grown[r].top, box.y0));
      grown[r].bottom = Math.max(grown[r].bottom, box.y1);
      grown[r].left = Math.max(regions[r].left - textHeight * 10, Math.min(grown[r].left, box.x0));
    });
  };
  extend();
  for (let pass = 0; pass < 8; pass++) {
  let changed = false;
  page.forEach((box, id) => {
    if (owner[id] >= 0) return;
    const r = grown.findIndex((region, index) => candidate(box, region, index));
    if (r < 0) return;
    const region = grown[r];
    let x0 = box.x0;
    let x1 = box.x1;
    for (let grown = true; grown; ) {
      grown = false;
      page.forEach((other, j) => {
        if (j === id || owner[j] >= 0 || !rowOverlap(box, other)) return;
        // 句読点の後などの空き(字1個分強)では行を切らない。
        if (other.x1 >= x0 - textHeight * 1.5 && other.x1 <= x0 && other.x0 < x0) {
          x0 = other.x0;
          grown = true;
        } else if (other.x0 <= x1 + textHeight * 1.5 && other.x0 >= x1 && other.x1 > x1) {
          x1 = other.x1;
          grown = true;
        }
      });
    }
    // 横に続く字の並びが、図から本文の側へ延びていなければ図のラベル。
    const where = sides[r];
    // 図の左の凡例: 左隣の字(選択肢など)との間が、図との間よりはっきり広ければ図のラベル。
    let leftNeighbor = -Infinity;
    if (where === 'right' && x0 < region.left - textHeight * 3) {
      // (左隣を探す)
      page.forEach((other, j) => {
        if (owner[j] < 0 && other.x1 <= x0 && rowOverlap(box, other)) leftNeighbor = Math.max(leftNeighbor, other.x1);
      });
    }
    // 図に食い込む字のかたまり(図の左下から図の下へ延びる凡例など)も、左隣から離れていれば図のラベル。
    const legend =
      where === 'right' &&
      ((x1 <= region.left + textHeight && x0 >= region.left - textHeight * 10 && x0 - leftNeighbor >= Math.max(textHeight * 3, (region.left - x1) * 1.8)) ||
        (x1 > region.left + textHeight && x0 - leftNeighbor >= textHeight * 3));
    // 図の外(上下)にある長い字の並び(字12個分超)は本文の行(幅いっぱいの図の真下の行など)。
    const outside = box.y1 <= regions[r].top || box.y0 >= regions[r].bottom;
    const ok =
      outside && x1 - x0 > textHeight * 12
        ? false
        : where === 'right'
        ? x0 >= region.left - textHeight * 3 || (x0 >= region.left - textHeight * 10 && legend)
        : where === 'left'
          ? x1 <= region.right + textHeight * 3
          : x0 >= region.left - textHeight * 3 && x1 <= region.right + textHeight * 3;
    if (ok) {
      owner[id] = r;
      changed = true;
    }
  });
  if (!changed) break;
  extend();
  }
  // 図に含めた字(凡例など)にすぐ隣り合う字のかたまり(行の左端の記号・コロン・字の点)も、本文側の字から離れていれば図に含める。
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    page.forEach((box, id) => {
      if (owner[id] >= 0) return;
      // 隣り合う(字1.5個分以内)まだ図でない字のかたまり。
      const chain = new Set([id]);
      let x0 = box.x0;
      let x1 = box.x1;
      for (let grown = true; grown; ) {
        grown = false;
        page.forEach((other, j) => {
          if (chain.has(j) || owner[j] >= 0 || !rowOverlap(box, other)) return;
          if ((other.x1 <= x0 + 1 && x0 - other.x1 <= textHeight * 1.5) || (other.x0 >= x1 - 1 && other.x0 - x1 <= textHeight * 1.5)) {
            chain.add(j);
            x0 = Math.min(x0, other.x0);
            x1 = Math.max(x1, other.x1);
            grown = true;
          }
        });
      }
      let target = -1;
      let leftGap = Infinity;
      page.forEach((other, j) => {
        if (chain.has(j) || !rowOverlap(box, other)) return;
        if (owner[j] >= 0 && other.x0 - x1 >= -1 && other.x0 - x1 <= textHeight * 1.5 && sides[owner[j]] === 'right') target = owner[j];
        if (owner[j] < 0 && other.x1 <= x0) leftGap = Math.min(leftGap, x0 - other.x1);
      });
      if (target >= 0 && leftGap >= textHeight * 3 && x0 >= regions[target].left - textHeight * 16 && x1 - x0 <= textHeight * 10) {
        for (const j of chain) owner[j] = target;
        changed = true;
      }
    });
    if (!changed) break;
  }
  // 本文の墨。
  const text: Ink = { width: W, height: ink.height, data: new Uint8Array(ink.data.length) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const id = label[y * W + x];
      if (id >= 0 && owner[id] < 0) text.data[(top + y) * W + x] = 1;
    }
  }
  let lines = componentLines(text, top, bottom, 0, W, textHeight);
  if (!lines) {
    lines = rowPieces(text, top, bottom, 0, W, textHeight)
      .map((piece) => makeBandIn(text, piece.top, piece.bottom, 0, W))
      .filter((band) => band.atoms.length > 0);
  }
  lines = mergeFractionRows(lines, textHeight);
  // 背の高い行(本文の行と分数の式がつながったものなど)は、図を除いた墨で、従来の方法により分け直す。
  // 図を除いた墨には図はないので、分け直しで図と判定された場合は、上下の空白で切るだけにする。
  lines = lines.flatMap((line) => {
    if (line.bottom - line.top <= textHeight * 1.8) return [line];
    const again = refineBands(text, [makeBandIn(text, line.top, line.bottom, 0, W)], textHeight);
    if (!again.some((band) => band.figure)) {
      // まだ背の高い塊(本文の行と式がつながったもの)は、上下の空白で切り、分数の分子・分母は式の行へ戻す。
      return mergeFractionRows(
        again.flatMap((band) => {
          if (band.bottom - band.top <= textHeight * 1.8 || band.mask || band.masks) return [band];
          const pieces = rowPieces(text, band.top, band.bottom, band.left, band.right + 1, textHeight);
          if (pieces.length > 1) return pieces.map((piece) => makeBandIn(text, piece.top, piece.bottom, band.left, band.right + 1)).filter((part) => part.atoms.length > 0);
          // 上下の空白で切れない(分数の式の行と次の行が接している)ときは、字ごとに行へ振り分ける。
          const byComponents = componentLines(text, band.top, band.bottom, band.left, band.right + 1, textHeight);
          return byComponents && byComponents.length > 1 && byComponents.every((part) => part.bottom - part.top <= textHeight * 3) ? byComponents : [band];
        }),
        textHeight,
      );
    }
    const pieces = rowPieces(text, line.top, line.bottom, line.left, line.right + 1, textHeight);
    return pieces.length > 1
      ? mergeFractionRows(pieces.map((piece) => makeBandIn(text, piece.top, piece.bottom, line.left, line.right + 1)).filter((band) => band.atoms.length > 0), textHeight)
      : [line];
  });
  const figures: Band[] = [];
  regions.forEach((region, r) => {
    const members = page.filter((_, id) => owner[id] === r);
    if (members.length === 0) return;
    const figure = {
      left: Math.min(region.left, ...members.map((box) => box.x0)),
      right: Math.max(region.right, ...members.map((box) => box.x1)),
      top: Math.max(top, Math.min(region.top, ...members.map((box) => box.y0))),
      bottom: Math.min(bottom, Math.max(region.bottom, ...members.map((box) => box.y1))),
    };
    // 本文の字を白く塗る範囲は、最後に(本文として表示する字が決まってから)まとめて付ける。
    const band = makeBandIn(ink, Math.round(figure.top), Math.round(figure.bottom), Math.round(figure.left), Math.round(figure.right));
    figures.push({ ...band, left: Math.round(figure.left), right: Math.round(figure.right), figure: true });
  });
  if (figures.length === 0) return null;
  // 図の左に並ぶ段の行には、段の右端(図の左端)を持たせる。
  // 段の右端は、図のブロックの左端(左へ広げたラベルを含む)ではなく、図形そのものの左端で決める。
  const cores = regions.map((region) => {
    const parts = region.parts ?? [region];
    return { left: Math.min(...parts.map((part) => part.left)), top: region.top, bottom: region.bottom };
  });
  const columned = lines.map((line) => {
    // 図のすぐ上(字2.5個分以内)で図の手前で折り返している行も、図の横の段の行とする。
    const right = cores.find((core) => core.top - textHeight * 2.5 < line.bottom && line.top < core.bottom + textHeight && line.right <= core.left);
    if (!right) return line;
    const column = lines!.filter((other) => right.top - textHeight * 2.5 < other.bottom && other.top < right.bottom + textHeight && other.right <= right.left);
    return { ...line, limit: Math.round(right.left), columnLeft: Math.min(...column.map((other) => other.left)) };
  });
  return [...columned, ...figures];
}

/**
 * 本文と右の図の間に、上から下まで通る縦の空白がない場合(図の端が行の端にほぼ接している、図の上端が本文の行にかかる)。
 * 図を「行より大きくつながった線(図の本体)」として見つけ、各行の高さで図の本体より右にある小さなまとまり(図のラベル)も図とする。
 * 残りの字を行へ振り分け、本文の行と図のブロックに分ける。分けられなければ null。
 */
export function componentFigureSplit(ink: Ink, top: number, bottom: number, textHeight: number): Band[] | null {
  const W = ink.width;
  const height = bottom - top;
  if (height <= 0 || W * height > 4_000_000) return null;
  const label = new Int32Array(W * height).fill(-1);
  const boxes: Array<{ x0: number; x1: number; y0: number; y1: number; pixels: number }> = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const index = y * W + x;
      if (label[index] >= 0 || !ink.data[(top + y) * W + x]) continue;
      const id = boxes.length;
      const box = { x0: x, x1: x + 1, y0: y, y1: y + 1, pixels: 0 };
      label[index] = id;
      stack.push(index);
      while (stack.length > 0) {
        const current = stack.pop()!;
        box.pixels += 1;
        const cx = current % W;
        const cy = (current - cx) / W;
        box.x0 = Math.min(box.x0, cx);
        box.x1 = Math.max(box.x1, cx + 1);
        box.y0 = Math.min(box.y0, cy);
        box.y1 = Math.max(box.y1, cy + 1);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= height) continue;
            const next = ny * W + nx;
            if (label[next] >= 0 || !ink.data[(top + ny) * W + nx]) continue;
            label[next] = id;
            stack.push(next);
          }
        }
      }
      boxes.push(box);
    }
  }
  // 図の本体: 行の高さの2.6倍より背が高い、または12文字分より長いまとまり。
  // 細い直線(グラフの軸など。横は8文字分以上、縦は行の1.8倍以上)も図の本体とする。
  const big = boxes.map(
    (box) =>
      box.y1 - box.y0 > textHeight * 2.6 ||
      box.x1 - box.x0 > textHeight * 12 ||
      (box.y1 - box.y0 <= 4 && box.x1 - box.x0 >= textHeight * 8) ||
      (box.x1 - box.x0 <= 4 && box.y1 - box.y0 >= textHeight * 1.8) ||
      // 線だけでできた疎らなまとまり(グラフの軸の「L」字など。字は墨が詰まっている)。
      (box.x1 - box.x0 >= textHeight * 5 && box.y1 - box.y0 >= textHeight * 1.5 && box.pixels / ((box.x1 - box.x0) * (box.y1 - box.y0)) < 0.2),
  );
  // 破線(細長い短い線が同じ高さ・同じ位置に4つ以上並ぶ)の枠も図の本体とする。点線(「・・・」)は含めない。
  const thin = (box: { x0: number; x1: number; y0: number; y1: number }, horizontal: boolean) =>
    horizontal
      ? box.y1 - box.y0 <= 3 && box.x1 - box.x0 >= Math.max(4, (box.y1 - box.y0) * 2) && box.x1 - box.x0 <= textHeight * 1.5
      : box.x1 - box.x0 <= 3 && box.y1 - box.y0 >= Math.max(4, (box.x1 - box.x0) * 2) && box.y1 - box.y0 <= textHeight * 1.5;
  const chains: Array<{ horizontal: boolean; members: number[]; x0: number; x1: number; y0: number; y1: number }> = [];
  for (const horizontal of [true, false]) {
    const ids = boxes.map((_, id) => id).filter((id) => !big[id] && thin(boxes[id], horizontal));
    const key = (id: number) => (horizontal ? boxes[id].y0 : boxes[id].x0);
    const along = (id: number) => (horizontal ? boxes[id].x0 : boxes[id].y0);
    const alongEnd = (id: number) => (horizontal ? boxes[id].x1 : boxes[id].y1);
    ids.sort((a, b) => key(a) - key(b) || along(a) - along(b));
    const used = new Set<number>();
    for (const id of ids) {
      if (used.has(id)) continue;
      const chain = [id];
      for (const other of ids) {
        if (used.has(other) || chain.includes(other)) continue;
        const last = chain[chain.length - 1];
        if (Math.abs(key(other) - key(id)) <= 1 && along(other) >= alongEnd(last) && along(other) - alongEnd(last) <= textHeight) chain.push(other);
      }
      if (chain.length >= 4 && alongEnd(chain[chain.length - 1]) - along(chain[0]) >= textHeight * 5) {
        for (const member of chain) used.add(member);
        chains.push({
          horizontal,
          members: chain,
          x0: Math.min(...chain.map((m) => boxes[m].x0)),
          x1: Math.max(...chain.map((m) => boxes[m].x1)),
          y0: Math.min(...chain.map((m) => boxes[m].y0)),
          y1: Math.max(...chain.map((m) => boxes[m].y1)),
        });
      }
    }
  }
  // 破線の枠: 横の破線と縦の破線が角で接しているものだけを図の本体とする(1本だけの一点鎖線などは寸法線や中心線のことが多い)。
  const near = (a: (typeof chains)[number], b: (typeof chains)[number]) =>
    a.x0 <= b.x1 + textHeight && b.x0 <= a.x1 + textHeight && a.y0 <= b.y1 + textHeight && b.y0 <= a.y1 + textHeight;
  for (const chain of chains) {
    if (chains.some((other) => other.horizontal !== chain.horizontal && near(chain, other))) for (const member of chain.members) big[member] = true;
  }
  if (!big.some(Boolean)) return null;
  // 図が右側にある場合だけ扱う。左側の大きなまとまり(選択肢の平方根などの数式)は、その上で本文を切り、下を別のブロックにする。
  const rightBig = boxes.map((box, id) => big[id] && box.x0 >= W * 0.35);
  if (!rightBig.some(Boolean)) return null;
  const figureLeft = Math.min(...boxes.filter((_, id) => rightBig[id]).map((box) => box.x0));
  let lowerTop = height;
  const leftBig = boxes.filter((_, id) => big[id] && !rightBig[id]);
  if (leftBig.length > 0) {
    lowerTop = Math.min(...leftBig.map((box) => box.y0));
    const leftHasInk = (y: number) => {
      for (let x = 0; x < figureLeft; x++) if (ink.data[(top + y) * W + x]) return true;
      return false;
    };
    while (lowerTop > 0 && leftHasInk(lowerTop)) lowerTop -= 1;
    if (lowerTop < textHeight * 2) return null;
    boxes.forEach((_, id) => {
      if (!rightBig[id]) big[id] = false;
    });
  }
  const lower = boxes.map((box) => box.y0 >= lowerTop && box.x1 <= figureLeft);
  // 各行の高さでの図の本体の左端。
  const edge = new Int32Array(height).fill(W);
  for (let y = 0; y < height; y++) {
    for (let x = figureLeft; x < W; x++) {
      const id = label[y * W + x];
      if (id >= 0 && big[id]) {
        edge[y] = x;
        break;
      }
    }
  }
  // 図の本体より右(少しの余裕を含む)にある小さなまとまりは、図のラベルとする。
  const margin = Math.round(textHeight * 0.5);
  const inFigure = boxes.map((box, id) => {
    if (big[id]) return true;
    if (lower[id]) return false;
    let limit = W;
    for (let y = box.y0; y < box.y1; y++) limit = Math.min(limit, edge[y]);
    // そのまとまりの高さに図の本体がなければ、上下近く(1行分)の図の本体の左端を使う。
    if (limit === W) {
      for (let y = Math.max(0, box.y0 - textHeight); y < Math.min(height, box.y1 + textHeight); y++) limit = Math.min(limit, edge[y]);
    }
    return box.x0 >= limit - margin;
  });
  // 図の本体のすぐ左や上下に接する短い字のまとまり(「焦点F」「(励振点)」など)で、本文の字から離れているものも図のラベルとする。
  const overlapY = (a: { y0: number; y1: number }, b: { y0: number; y1: number }) => a.y0 < b.y1 && b.y0 < a.y1;
  const overlapX = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => a.x0 < b.x1 && b.x0 < a.x1;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    boxes.forEach((box, id) => {
      if (inFigure[id] || lower[id] || box.x0 < figureLeft - textHeight * 8) return;
      const adjacent = boxes.some(
        (other, j) =>
          inFigure[j] &&
          ((overlapY(box, other) && other.x0 - box.x1 >= -1 && other.x0 - box.x1 <= textHeight * 1.5) ||
            (!big[j] && overlapX(box, other) && Math.max(other.y0 - box.y1, box.y0 - other.y1) <= textHeight * 0.8)),
      );
      if (!adjacent) return;
      const group = [id];
      const inGroup = new Set(group);
      const span = { ...box };
      for (let grown = true; grown && span.x1 - span.x0 <= textHeight * 8; ) {
        grown = false;
        boxes.forEach((other, j) => {
          if (inFigure[j] || inGroup.has(j) || !overlapY(other, span) || other.x1 < span.x0 - textHeight || other.x0 > span.x1 + textHeight) return;
          const leftOf = other.x1 <= span.x0 + 1 && span.x0 - other.x1 <= textHeight;
          const rightOf = other.x0 >= span.x1 - 1 && other.x0 - span.x1 <= textHeight;
          if (leftOf || rightOf) {
            group.push(j);
            inGroup.add(j);
            span.x0 = Math.min(span.x0, other.x0);
            span.x1 = Math.max(span.x1, other.x1);
            span.y0 = Math.min(span.y0, other.y0);
            span.y1 = Math.max(span.y1, other.y1);
            grown = true;
          }
        });
      }
      if (span.x1 - span.x0 > textHeight * 8) return;
      let nearestLeft = -Infinity;
      boxes.forEach((other, j) => {
        if (!inFigure[j] && !inGroup.has(j) && overlapY(other, span) && other.x1 <= span.x0) nearestLeft = Math.max(nearestLeft, other.x1);
      });
      if (span.x0 - nearestLeft < textHeight * 1.8) return;
      for (const j of group) inFigure[j] = true;
      changed = true;
    });
    if (!changed) break;
  }
  // 図以外の字だけを残した墨で、行へ振り分ける。
  const text: Ink = { width: W, height: ink.height, data: new Uint8Array(ink.data.length) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const id = label[y * W + x];
      if (id >= 0 && !inFigure[id] && !lower[id]) text.data[(top + y) * W + x] = 1;
    }
  }
  const found = componentLines(text, top, bottom, 0, W, textHeight);
  if (!found) return null;
  const lines = mergeFractionRows(found, textHeight);
  const proseLines = lines.filter((line) => isDenseLine(line, textHeight) && line.right - line.left >= textHeight * 8);
  // 図のブロックの範囲と、その範囲に入る本文の字を白く塗る範囲。
  const figureBoxes = boxes.filter((_, id) => inFigure[id]);
  const figure = {
    left: Math.min(...figureBoxes.map((box) => box.x0)),
    right: Math.max(...figureBoxes.map((box) => box.x1)),
    top: top + Math.min(...figureBoxes.map((box) => box.y0)),
    bottom: top + Math.max(...figureBoxes.map((box) => box.y1)),
  };
  if (proseLines.length < 2) {
    // 図の左が文章でなく選択肢の表などの場合も、左の段が図からはっきり離れた行の並びなら分ける(表と図を1枚にしない)。
    const column =
      lines.length >= 2 &&
      lines.every((line) => line.bottom - line.top <= textHeight * 1.8 && line.right <= figure.left - textHeight) &&
      Math.min(...lines.map((line) => line.left)) <= W * 0.3 &&
      figure.right - figure.left >= textHeight * 6 &&
      figure.bottom - figure.top >= textHeight * 3;
    if (!column) return null;
  }
  const masks: Mask[] = [];
  for (const line of lines) {
    for (const atom of line.atoms) {
      const y0 = atom.y0 ?? line.top;
      const y1 = atom.y1 ?? line.bottom;
      if (atom.x1 > figure.left && atom.x0 < figure.right && y1 > figure.top && y0 < figure.bottom) {
        masks.push({ top: y0, bottom: y1, left: atom.x0, right: atom.x1 });
      }
    }
  }
  const figureBand: Band = {
    ...makeBandIn(ink, figure.top, figure.bottom, figure.left, figure.right),
    figure: true,
    ...(masks.length > 0 && { masks }),
  };
  // 図の左の段の行には、段の右端を持たせる(図の上にかかる長い行は持たない)。
  const textLeft = Math.min(...lines.map((line) => line.left));
  const columned = lines.map((line) => (line.right <= figure.left ? { ...line, limit: figure.left, columnLeft: textLeft } : line));
  // 左下に残した部分(選択肢など)は1つのブロックにする。
  const lowerBands: Band[] = lowerTop < height ? [makeBandIn(ink, top + lowerTop, bottom, 0, figureLeft - 1)].filter((band) => band.atoms.length > 0) : [];
  return [...columned, ...lowerBands, figureBand];
}

/**
 * 左に本文の行、右に選択肢の表(罫線のない表)が並ぶ部分を、最も広い縦の空白で左右に分ける。
 * 左の段に文章の行が2行以上あり、右の段に文章の行がないときだけ分ける(右の段は崩さずに1つのブロックにする)。
 */
export function tableBesideSplit(ink: Ink, top: number, bottom: number, textHeight: number): Band[] | null {
  const W = ink.width;
  // 縦の空白(上から下まで墨のない列)を左から順に試す。
  const filled = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * W + x]) {
        filled[x] = 1;
        break;
      }
    }
  }
  const first = filled.indexOf(1);
  const last = filled.lastIndexOf(1);
  if (first < 0) return null;
  const gaps: Array<[number, number]> = [];
  for (let x = first; x <= last; ) {
    if (filled[x]) {
      x += 1;
      continue;
    }
    const start = x;
    while (x <= last && !filled[x]) x += 1;
    if (x - start >= Math.max(Math.round(textHeight * 1.2), Math.round(W * 0.015))) gaps.push([start, x]);
  }
  const isProse = (band: Band) => band.atoms.length > 0 && isDenseLine(band, textHeight, true) && band.right - band.left >= textHeight * 8 && band.bottom - band.top <= textHeight * 1.8;
  for (const [g0, g1] of gaps) {
    const x0 = first;
    const x1 = g0;
    if (x1 - x0 < W * 0.3 || g1 < W * 0.45) continue;
    const lines: Band[] = [];
    let failed = false;
    for (const piece of rowPieces(ink, top, bottom, x0, x1, textHeight)) {
      if (piece.bottom - piece.top <= textHeight * 1.6) {
        lines.push(makeBandIn(ink, piece.top, piece.bottom, x0, x1));
        continue;
      }
      const split = componentLines(ink, piece.top, piece.bottom, x0, x1, textHeight);
      if (split) {
        lines.push(...split);
        continue;
      }
      // 字ごとに振り分けられなければ、ほぼ空白の行で上下から1行ずつはがす。
      const peeled = peelLines(ink, piece.top, piece.bottom, x0, x1, textHeight);
      if (peeled.mask || peeled.bottom - peeled.top > textHeight * 1.6) {
        failed = true;
        break;
      }
      lines.push(...peeled.above);
      if (peeled.bottom > peeled.top) lines.push(makeBandIn(ink, peeled.top, peeled.bottom, x0, x1));
      lines.push(...peeled.below);
    }
    if (failed) continue;
    mergeFractionRows(lines, textHeight);
    // 左の段は「(1)」などの項目番号で始まる行もあるので、番号の後ろの空白は許して数える。
    const leftProse = (band: Band) => band.atoms.length > 0 && isDenseLine(band, textHeight) && band.right - band.left >= textHeight * 8 && band.bottom - band.top <= textHeight * 1.8;
    if (lines.filter(leftProse).length < 2) continue;
    const [r0, r1] = [g1, last + 1];
    // 右の段の文章の行が2行以上あれば(本文が2段に組まれている)分けない。図の見出し程度の1行はよい。
    let rightProse = 0;
    for (const piece of rowPieces(ink, top, bottom, r0, r1, textHeight)) {
      if (piece.bottom - piece.top > textHeight * 1.6) continue;
      const row = makeBandIn(ink, piece.top, piece.bottom, r0, r1);
      // 2段組みの本文の行(幅の25%以上)だけを数える(表の行は短い)。
      if (isProse(row) && row.right - row.left >= W * 0.25) rightProse += 1;
    }
    if (rightProse >= 2) continue;
    return [
      ...lines.filter((line) => line.atoms.length > 0).map((line) => ({ ...line, limit: x1, columnLeft: x0 })),
      { ...makeBandIn(ink, top, bottom, r0, r1), figure: true },
    ];
  }
  return null;
}

/**
 * 縦線の短い小さな図(端子と記号だけの回路など)の場合。右端の細い部分(幅の30%以下)を、空白で区切られた図とみなす。
 * 本文側がすべて文章の行であることは呼び出し側で確かめる。
 */
function smallFigureSplit(ink: Ink, top: number, bottom: number, minGap: number): { text: [number, number]; figure: [number, number]; figureLeft: boolean } | null {
  const filled = new Uint8Array(ink.width);
  for (let x = 0; x < ink.width; x++) {
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + x]) {
        filled[x] = 1;
        break;
      }
    }
  }
  const first = filled.indexOf(1);
  const last = filled.lastIndexOf(1);
  if (first < 0) return null;
  // 条件(右側が幅の30%以下、左側が50%以上)を満たす空白のうち、最も広いものを選ぶ(表の列の間で切らないように)。
  let best: [number, number] | null = null;
  let x = last;
  while (x > first) {
    if (filled[x]) {
      x -= 1;
      continue;
    }
    const end = x + 1;
    while (x > first && !filled[x]) x -= 1;
    const start = x + 1;
    if (end - start >= minGap && last + 1 - end <= ink.width * 0.3 && start - first >= ink.width * 0.5) {
      if (!best || end - start > best[1] - best[0]) best = [start, end];
    }
  }
  if (best) return { text: [first, best[0]], figure: [best[1], last + 1], figureLeft: false };
  return null;
}

/** y より上(textHeight 以内)で最も近い、墨のない行。なければ null。問題の先頭で帯を分ける位置に使う。 */
export function emptyRowAbove(ink: Ink, y: number, textHeight: number): number | null {
  for (let row = y; row >= Math.max(0, y - Math.round(textHeight)); row--) {
    let empty = true;
    for (let x = 0; x < ink.width; x++) {
      if (ink.data[row * ink.width + x]) {
        empty = false;
        break;
      }
    }
    if (empty) return row;
  }
  return null;
}

/** from から上へ、limit までの範囲で、指定の列の範囲に墨のない行を探す。 */
function emptyRowIn(ink: Ink, from: number, limit: number, x0: number, x1: number): number | null {
  for (let y = from; y > limit; y--) {
    let empty = true;
    for (let x = x0; x < x1; x++) {
      if (ink.data[y * ink.width + x]) {
        empty = false;
        break;
      }
    }
    if (empty) return y;
  }
  return null;
}

/**
 * まっすぐな行の切れ目がない部分(丸囲み文字などが行の間にはみ出している)を、つながった墨のまとまり(字)ごとに行へ振り分ける。
 * 各字は縦の中心がいちばん近い行に属し、字ごとの上下の範囲を持つので、はみ出した字も欠けずに自分の行と一緒に切り出せる。
 * 行より背の高いまとまり(図や枠)があるときは null。
 */
export function componentLines(
  ink: Ink,
  top: number,
  bottom: number,
  x0: number,
  x1: number,
  textHeight: number,
  exclude?: (component: { x0: number; x1: number; y0: number; y1: number }) => boolean,
): Band[] | null {
  const width = x1 - x0;
  const height = bottom - top;
  if (width <= 0 || height <= 0 || width * height > 4_000_000) return null;
  const label = new Int32Array(width * height).fill(-1);
  type Component = { x0: number; x1: number; y0: number; y1: number };
  const components: Component[] = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (label[index] >= 0 || !ink.data[(top + y) * ink.width + x0 + x]) continue;
      const id = components.length;
      const box = { x0: x, x1: x + 1, y0: y, y1: y + 1 };
      label[index] = id;
      stack.push(index);
      while (stack.length > 0) {
        const current = stack.pop()!;
        const cx = current % width;
        const cy = (current - cx) / width;
        box.x0 = Math.min(box.x0, cx);
        box.x1 = Math.max(box.x1, cx + 1);
        box.y0 = Math.min(box.y0, cy);
        box.y1 = Math.max(box.y1, cy + 1);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (label[next] >= 0 || !ink.data[(top + ny) * ink.width + x0 + nx]) continue;
            label[next] = id;
            stack.push(next);
          }
        }
      }
      // 図は線でつながった大きなまとまりになるので、行の高さの4倍を超えるまとまりがあれば振り分けない。
      if (box.y1 - box.y0 > textHeight * 4) return null;
      const component = { x0: box.x0 + x0, x1: box.x1 + x0, y0: box.y0 + top, y1: box.y1 + top, id } as Component & { id: number };
      if (exclude?.(component)) continue;
      components.push(component);
    }
  }
  // 普通の大きさの字の中心から、行の中心を求める。
  const centers = components
    .filter((c) => c.y1 - c.y0 >= textHeight * 0.4 && c.y1 - c.y0 <= textHeight * 1.05)
    .map((c) => (c.y0 + c.y1) / 2)
    .sort((a, b) => a - b);
  const lines: number[][] = [];
  for (const center of centers) {
    const current = lines[lines.length - 1];
    if (current && center - current[current.length - 1] <= textHeight * 0.6) current.push(center);
    else lines.push([center]);
  }
  if (lines.length < 2) return null;
  const lineCenters = lines.map((group) => group[Math.floor(group.length / 2)]);
  // 行の間隔が狭すぎる(分数の分子・分母や添字を別の行とみなしている)ときは振り分けない。
  for (let i = 1; i < lineCenters.length; i++) if (lineCenters[i] - lineCenters[i - 1] < textHeight * 1.1) return null;

  // 2行にまたがるまとまり(丸囲み文字が次の行の字に接しているなど)は、行の中心の間で墨の最も少ない高さで上下に分ける。
  const pieces: Component[] = [];
  for (const component of components as Array<Component & { id: number }>) {
    const inside = lineCenters.filter((center) => center > component.y0 && center < component.y1);
    if (inside.length <= 1) {
      pieces.push(component);
      continue;
    }
    const cuts: number[] = [];
    for (let k = 1; k < inside.length; k++) {
      let best = -1;
      let bestCount = Infinity;
      for (let y = Math.ceil(inside[k - 1]); y < Math.floor(inside[k]); y++) {
        let count = 0;
        for (let x = component.x0; x < component.x1; x++) if (label[(y - top) * width + (x - x0)] === component.id) count += 1;
        if (count < bestCount) {
          bestCount = count;
          best = y;
        }
      }
      cuts.push(best);
    }
    const bounds = [component.y0, ...cuts, component.y1];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const part = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (let y = bounds[k]; y < bounds[k + 1]; y++) {
        for (let x = component.x0; x < component.x1; x++) {
          if (label[(y - top) * width + (x - x0)] !== component.id) continue;
          part.x0 = Math.min(part.x0, x);
          part.x1 = Math.max(part.x1, x + 1);
          part.y0 = Math.min(part.y0, y);
          part.y1 = Math.max(part.y1, y + 1);
        }
      }
      if (part.x0 < part.x1) pieces.push(part);
    }
  }
  if (pieces.some((piece) => piece.y1 - piece.y0 > textHeight * 2.6)) return null;
  components.length = 0;
  components.push(...pieces);
  const owned: Component[][] = lineCenters.map(() => []);
  for (const component of components) {
    const center = (component.y0 + component.y1) / 2;
    let best = 0;
    for (let i = 1; i < lineCenters.length; i++) if (Math.abs(lineCenters[i] - center) < Math.abs(lineCenters[best] - center)) best = i;
    owned[best].push(component);
  }
  return owned.map((group, i) => {
    group.sort((a, b) => a.x0 - b.x0);
    const atoms: Atom[] = [];
    for (const c of group) {
      const last = atoms[atoms.length - 1];
      if (last && c.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, c.x1);
        last.y0 = Math.min(last.y0!, c.y0);
        last.y1 = Math.max(last.y1!, c.y1);
      } else atoms.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
    }
    const bandTop = Math.min(...group.map((c) => c.y0));
    const bandBottom = Math.max(...group.map((c) => c.y1));
    // 基準線は、普通の大きさの字の下端の中央値。
    const bottoms = group.filter((c) => c.y1 - c.y0 >= textHeight * 0.4 && c.y1 - c.y0 <= textHeight * 1.05).map((c) => c.y1).sort((a, b) => a - b);
    const baseline = bottoms.length > 0 ? bottoms[Math.floor(bottoms.length / 2)] : Math.round(lineCenters[i] + textHeight / 2);
    return { top: bandTop, bottom: bandBottom, left: atoms[0].x0, right: atoms[atoms.length - 1].x1, baseline, atoms };
  });
}

/**
 * 行の間に図のラベル(右半分だけに並ぶ短い字の行)がはさまって、字ごとの振り分けができない場合。
 * ラベルの行を除いて振り分け、ラベルは図の側のブロックとして返す。分けられなければ null。
 */
export function componentLinesWithLabels(ink: Ink, top: number, bottom: number, textHeight: number): Band[] | null {
  const W = ink.width;
  const mid = Math.round(W * 0.5);
  // 字の大きさのまとまりの中心から行を求め、右半分だけにある行(ラベル)を探す。
  const found: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  componentLines(ink, top, bottom, 0, W, textHeight, (component) => {
    found.push(component);
    return true;
  });
  // 左半分の字だけで行の中心を求め、右半分にあって、どの行の中心からも離れた字の大きさのまとまりをラベルとする。
  const leftCenters = found
    .filter((c) => c.x1 <= mid && c.y1 - c.y0 >= textHeight * 0.4 && c.y1 - c.y0 <= textHeight * 1.05)
    .map((c) => (c.y0 + c.y1) / 2)
    .sort((a, b) => a - b);
  const centers: number[] = [];
  for (const center of leftCenters) {
    const groupStart = centers.length > 0 ? centers[centers.length - 1] : -Infinity;
    if (center - groupStart > textHeight * 0.6) centers.push(center);
  }
  if (centers.length < 2) return null;
  const isLabel = (c: { x0: number; x1: number; y0: number; y1: number }) => {
    const center = (c.y0 + c.y1) / 2;
    return (
      c.x0 >= mid &&
      c.y1 - c.y0 <= textHeight * 1.3 &&
      center > centers[0] &&
      center < centers[centers.length - 1] &&
      centers.every((line) => Math.abs(line - center) > textHeight * 0.35)
    );
  };
  const labels = found.filter(isLabel);
  if (labels.length === 0) return null;
  const lines = componentLines(ink, top, bottom, 0, W, textHeight, isLabel);
  // 数式を含む行(空白のある行)もあるので、文章の行が1行以上あり、どの行も背が高すぎないこと。
  if (!lines || !lines.some((line) => isDenseLine(line, textHeight)) || lines.some((line) => line.bottom - line.top > textHeight * 2.2)) return null;
  const box = {
    left: Math.min(...labels.map((c) => c.x0)),
    right: Math.max(...labels.map((c) => c.x1)),
    top: Math.min(...labels.map((c) => c.y0)),
    bottom: Math.max(...labels.map((c) => c.y1)),
  };
  const masks: Mask[] = [];
  for (const line of lines) {
    for (const atom of line.atoms) {
      const y0 = atom.y0 ?? line.top;
      const y1 = atom.y1 ?? line.bottom;
      if (atom.x1 > box.left && atom.x0 < box.right && y1 > box.top && y0 < box.bottom) masks.push({ top: y0, bottom: y1, left: atom.x0, right: atom.x1 });
    }
  }
  return [...lines, { ...makeBandIn(ink, box.top, box.bottom, box.left, box.right), figure: true, ...(masks.length > 0 && { masks }) }];
}

/** 互換のための別名(行間が狭くつながった本文行を分け直す)。 */
export const splitStackedLines = refineBands;

/** 1文字の内部の隙間(「川」など)で切らないよう、ほぼ1文字幅になるまで隣の塊をまとめる。 */
export function clusterAtoms(atoms: Atom[], pitch: number): Atom[] {
  const clusters: Atom[] = [];
  atoms.forEach((atom, index) => {
    const last = clusters[clusters.length - 1];
    const next = atoms[index + 1];
    // 次の塊との間の方が狭く、次と合わせて1文字に収まるなら、次と同じ字とみなす(「Iに」の「に」の左の画を「I」に付けない)。
    const pairsWithNext = last !== undefined && next !== undefined && next.x0 - atom.x1 < atom.x0 - last.x1 && next.x1 - atom.x0 <= pitch * 1.08;
    if (last && atom.x1 - last.x0 <= pitch * 1.08 && !pairsWithNext) {
      last.x1 = atom.x1;
      if (atom.y0 !== undefined || last.y0 !== undefined) {
        last.y0 = Math.min(last.y0 ?? Infinity, atom.y0 ?? Infinity);
        last.y1 = Math.max(last.y1 ?? -Infinity, atom.y1 ?? -Infinity);
      }
    } else clusters.push({ ...atom });
  });
  return clusters;
}

const WIDE = 0.45;

/** 行頭の位置の集まりから、問題の1行目が並ぶ列を求める。少数の外れ値(図や罫線)には引きずられない。 */
export function startColumn(lefts: number[], expected: number, width: number): { min: number; max: number } {
  const sorted = [...lefts].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const value of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && value - current[current.length - 1] <= width * 0.005) current.push(value);
    else clusters.push([value]);
  }
  const chosen = clusters.find((cluster) => cluster.length >= expected * 0.4) ?? clusters[0];
  return { min: chosen[0], max: chosen[chosen.length - 1] };
}

export interface Metrics {
  W: number;
  textHeight: number;
  L0: number;
  L1: number;
  R0: number;
}

/** 文書全体の本文の行の高さ、問題の1行目が並ぶ列、本文の右端を求める。 */
export function docMetrics(pages: PageBands[], expected: number): Metrics | null {
  const W = pages[0]?.width ?? 0;
  const wide = pages.flatMap((page) => page.bands).filter((band) => band.right - band.left >= W * WIDE);
  if (!W || wide.length === 0) return null;
  const { min: L0, max: L1 } = startColumn(wide.map((band) => band.left), expected, W);
  const rights = wide.map((band) => band.right).sort((a, b) => a - b);
  // 本文1行の高さ。枠や添字のある行、つながった行は背が高くなるので、中央値ではなく下側30%の値を使う。
  const heights = wide.map((band) => band.bottom - band.top).sort((a, b) => a - b);
  const textHeight = heights[Math.floor(heights.length * 0.3)];
  return { W, textHeight, L0, L1, R0: rights[Math.floor(rights.length * 0.9)] };
}

export interface LabelStart {
  page: number;
  top: number;
}

const LABEL_MATCH = 0.7;

/** 字の見本を1マスずつ太らせる。太字と通常の字の差を小さくしてから比べるため。 */
function dilateSample(pixels: Float32Array, width = 12, height = 18): Float32Array {
  const out = new Float32Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let max = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width) max = Math.max(max, pixels[yy * width + xx]);
        }
      }
      out[y * width + x] = max;
    }
  }
  return out;
}

/** 字の右隣に「−」(細く短い横棒)があるか。問題番号「A−1」を、表の見出し「A B C」などと区別する。 */
function hasDashAfter(ink: Ink, glyph: { x1: number; y0: number; y1: number }, textHeight: number): boolean {
  const middle = (glyph.y0 + glyph.y1) / 2;
  const top = Math.max(0, Math.round(glyph.y0 - textHeight * 0.3));
  const bottom = Math.min(ink.height, Math.round(glyph.y1 + textHeight * 0.3));
  const limit = Math.min(ink.width, Math.round(glyph.x1 + textHeight * 2.5));
  let x = glyph.x1;
  const column = (cx: number) => {
    for (let y = top; y < bottom; y++) if (ink.data[y * ink.width + cx]) return true;
    return false;
  };
  while (x < limit && !column(x)) x += 1;
  if (x >= limit) return false;
  // 「−」が次の数字とくっついていることがあるので、塊の左端から、細い横棒だけの列が続くかを見る。
  let dashColumns = 0;
  for (let cx = x; cx < Math.min(ink.width, x + Math.round(textHeight * 1.2)); cx++) {
    let y0 = -1;
    let y1 = -1;
    for (let y = top; y < bottom; y++) {
      if (ink.data[y * ink.width + cx]) {
        if (y0 < 0) y0 = y;
        y1 = y + 1;
      }
    }
    if (y0 < 0) break;
    const thin = y1 - y0 <= textHeight * 0.3 && Math.abs((y0 + y1) / 2 - middle) <= textHeight * 0.3;
    if (!thin) break;
    dashColumns += 1;
  }
  return dashColumns >= textHeight * 0.25;
}

/**
 * 問題番号の先頭の字(「A」「B」)の形で問題の先頭を探す。
 * 確実に見つかった問題の先頭の字を見本にし、左端の列にある字のうち、見本の2つ以上とよく似たものを先頭とする。
 * 見本の誤り(左端から始まる本文の行など)も、他の見本と似ていなければ除かれる。
 */
export function findLabelStarts(pages: PageBands[], inks: Ink[], m: Metrics): LabelStart[] {
  const th = m.textHeight;
  const isStrict = (band: Band) =>
    band.right - band.left >= m.W * WIDE && band.left >= m.L0 - m.W * 0.003 && band.left <= m.L1 + m.W * 0.003;

  type Candidate = { page: number; top: number; aspect: number; pixels: Float32Array; strict: boolean };
  const candidates: Candidate[] = [];

  // 左端の帯の中で、各行の最も左の字を候補にする。
  const scan = (page: PageBands, ink: Ink, x0: number, xEnd: number, runLimit: number) => {
    const rowHas = (y: number) => {
      for (let x = x0; x < xEnd; x++) if (ink.data[y * ink.width + x]) return true;
      return false;
    };
    let y = 0;
    while (y < ink.height) {
      if (!rowHas(y)) {
        y += 1;
        continue;
      }
      let y1 = y;
      while (y1 < ink.height && (rowHas(y1) || (y1 + 1 < ink.height && rowHas(y1 + 1)))) y1 += 1;
      let runStart = -1;
      let runEnd = -1;
      for (let x = x0; x < xEnd; x++) {
        let hit = false;
        for (let yy = y; yy < y1; yy++) if (ink.data[yy * ink.width + x]) { hit = true; break; }
        if (hit && runStart < 0) runStart = x;
        if (!hit && runStart >= 0) { runEnd = x; break; }
      }
      if (runStart >= 0 && runStart <= runLimit) {
        if (runEnd < 0) runEnd = xEnd;
        let top = y1;
        let bottom = y;
        for (let yy = y; yy < y1; yy++) {
          for (let x = runStart; x < runEnd; x++) {
            if (ink.data[yy * ink.width + x]) { top = Math.min(top, yy); bottom = Math.max(bottom, yy + 1); break; }
          }
        }
        // まとまりの高さではなく、左端の字そのものの高さで判定する(字下げした行が同じまとまりに入ることがある)。
        const glyphHeight = bottom - top;
        const duplicate = candidates.some((candidate) => candidate.page === page.page && Math.abs(candidate.top - top) <= th * 0.5);
        if (!duplicate && glyphHeight >= th * 0.45 && glyphHeight <= th * 1.3 && hasDashAfter(ink, { x1: runEnd, y0: top, y1: bottom }, th)) {
          const sample = sampleGlyph(ink, { x0: runStart, x1: runEnd, y0: top, y1: bottom });
          const strict = page.bands.some((band) => isStrict(band) && Math.abs(band.top - top) <= th * 0.6);
          candidates.push({ page: page.page, top, aspect: sample.aspect, pixels: dilateSample(sample.pixels), strict });
        }
      }
      y = y1;
    }
  };

  // 番号の桁数や字間で1行目が左右に少しずれる問題があるので、狭い範囲と広い範囲の両方で探す
  // (広い範囲だけだと字下げした行とまとまってしまうことがある)。字形で判定するので誤検出しにくい。
  const left = Math.max(0, Math.round(m.L0 - m.W * 0.015));
  pages.forEach((page, index) => {
    const ink = inks[index];
    scan(page, ink, left, Math.min(m.W, Math.round(m.L1 + m.W * 0.012 + th * 1.2)), m.L1 + m.W * 0.012);
    scan(page, ink, left, Math.min(m.W, Math.round(m.L1 + m.W * 0.018 + th * 1.2)), m.L1 + m.W * 0.018);
  });
  candidates.sort((a, b) => a.page - b.page || a.top - b.top);

  const seeds = candidates.filter((candidate) => candidate.strict);
  if (seeds.length < 3) return [];
  const similar = (a: Candidate, b: Candidate) =>
    Math.abs(Math.log(a.aspect / b.aspect)) < 0.45 && correlation(a.pixels, b.pixels) >= LABEL_MATCH;
  // 見本に2つ以上似ている候補を採用し、採用した候補も見本に加えて、増えなくなるまで繰り返す。
  // (ページによって番号の位置がずれ、確実な見本が少ない種類の番号(B問題など)も拾えるようにする)
  // 見本は減らさず増やすだけにする(必ず終わる)。
  const refs = new Set<Candidate>(seeds);
  const accepted = new Set<Candidate>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const candidate of candidates) {
      if (accepted.has(candidate)) continue;
      let count = 0;
      for (const ref of refs) if (ref !== candidate && similar(ref, candidate)) count += 1;
      if (count >= 2) {
        accepted.add(candidate);
        refs.add(candidate);
        changed = true;
      }
    }
  }
  return candidates.filter((candidate) => accepted.has(candidate)).map(({ page, top }) => ({ page, top }));
}

export function analyzeDocument(pages: PageBands[], expected: number, forced?: LabelStart[]): DocLayout {
  const empty = (found: number, textHeight = 0, pageWidth = 0): DocLayout => ({
    ok: false,
    found,
    expected,
    textHeight,
    pageWidth,
    questions: [],
  });
  const metrics = docMetrics(pages, expected);
  if (!metrics) return empty(0, 0, pages[0]?.width ?? 0);
  const { W, textHeight, L0, L1, R0 } = metrics;

  // 問題の1行目は左端の列から始まり、続きの行は字下げされている。図の横で短くなる1行目もあるので、
  // 2問目以降は短い行も認める。先頭の短い行(試験記号)は最初の長い行より前なので数えない。
  // 1行目が右の図と結合して縦長の帯になることがあるので、高さでは弾かない。
  // 指定された先頭は1回だけ使う(先頭の近くに小さな帯が分かれていても二重に数えない)。
  const used = new Set<LabelStart>();
  const isStart = (band: Band, started: boolean, page: number) => {
    if (forced) {
      // 帯の上端が先頭の近くにあるか、帯が先頭の位置を含み左端の列から始まる(本文と図を分けた結果、上端が少しずれることがある)。
      const match = forced.find(
        (start) =>
          !used.has(start) &&
          start.page === page &&
          (Math.abs(start.top - band.top) <= textHeight * 0.6 ||
            (band.top <= start.top + textHeight * 0.6 && band.bottom > start.top && band.left <= L1 + W * 0.02 && !band.figure)),
      );
      if (match) used.add(match);
      return match !== undefined;
    }
    const width = band.right - band.left;
    return band.left >= L0 - W * 0.003 && band.left <= L1 + W * 0.003 && width >= W * (started ? 0.15 : WIDE);
  };

  const collected: Array<Array<{ page: number; band: Band }>> = [];
  for (const page of pages) {
    const last = page.bands[page.bands.length - 1];
    // ページ下端の試験記号は右寄せ(ページ番号なら中央)。左から始まる短い行は本文の最後の行なので捨てない。
    const isFooter = (band: Band) =>
      band === last &&
      band.right - band.left < W * 0.25 &&
      band.top > page.height * 0.85 &&
      (band.left > W * 0.5 || (Math.abs((band.left + band.right) / 2 - W / 2) < W * 0.06 && band.right - band.left < W * 0.1));
    for (const band of page.bands) {
      if (isStart(band, collected.length > 0, page.page)) collected.push([]);
      if (collected.length > 0 && !isFooter(band)) collected[collected.length - 1].push({ page: page.page, band });
    }
  }
  if (collected.length !== expected) return empty(collected.length, textHeight, W);

  const toFragments = (page: number, band: Band): Fragment[] =>
    clusterAtoms(band.atoms, textHeight).map((atom) => ({
      page,
      x0: atom.x0,
      x1: atom.x1,
      top: Number.isFinite(atom.y0) ? (atom.y0 as number) : band.top,
      bottom: Number.isFinite(atom.y1) ? (atom.y1 as number) : band.bottom,
      baseline: band.baseline,
    }));

  const questions = collected.map((lines) => {
    const items: Item[] = [];
    let previousFull: Band | null = null;
    // 本文の右端は問題ごとに少し違うので、その問題の文章の行の右端を基準にする(文書全体の値は上限)。
    const proseRights = lines
      .map(({ band }) => band)
      .filter((band) => !band.figure && band.limit === undefined && band.right - band.left >= W * WIDE && band.bottom - band.top <= textHeight * 1.6 && isDenseLine(band, textHeight))
      .map((band) => band.right);
    const questionRight = proseRights.length > 0 ? Math.min(R0, Math.max(...proseRights)) : R0;
    // 図の横の段の右端は、段の境界ではなく、その段の文章の行の右端の最大(字の並ぶ右端)とする。
    const columnRights = new Map<number, number>();
    for (const { band } of lines) {
      if (band.limit === undefined || band.figure || !isDenseLine(band, textHeight)) continue;
      columnRights.set(band.limit, Math.max(columnRights.get(band.limit) ?? 0, band.right));
    }
    let lastPage = -1;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const { page, band } = lines[lineIndex];
      // 次の行が図や表の横の段の行なら、その段の右端まで届く行は、段落の途中(右端まで届いた行)とみなす。
      const nextBand = lines[lineIndex + 1]?.band;
      const nextColumnRight =
        nextBand && nextBand.limit !== undefined && band.limit === undefined && lines[lineIndex + 1].page === page
          ? (columnRights.get(nextBand.limit) ?? nextBand.limit)
          : undefined;
      // 前の行との間が行間より大きく空いていれば(段落や「(1)」などの項目の区切り)、段落としてつなげない。
      if (previousFull !== null && lastPage === page && band.top - previousFull.bottom > textHeight * 1.2) previousFull = null;
      lastPage = page;
      const height = band.bottom - band.top;
      const rightEdge =
        band.limit !== undefined
          ? (columnRights.get(band.limit) ?? band.limit)
          : nextColumnRight !== undefined && band.right < questionRight - W * 0.02 && Math.abs(band.right - nextColumnRight) <= W * 0.02 && band.right - band.left >= W * 0.2
            ? nextColumnRight
            : questionRight;
      // 表の行(列の間に大きな空白がある)は、右端まで届いていても文章として折り返さない。
      const dense = isDenseLine(band, textHeight);
      // 本文の字下げ位置から始まる行か。ページの中ほどから始まる行(表の横の凡例など)は表と一緒に表示する。
      const nearLeft = band.left <= (band.columnLeft ?? L1) + W * 0.2;
      const full =
        !band.figure &&
        dense &&
        (band.limit === undefined || nearLeft) &&
        band.right >= rightEdge - W * 0.02 &&
        (band.limit !== undefined || band.left < W * 0.3) &&
        height <= textHeight * 2.4;
      const tail: boolean =
        !full &&
        !band.figure &&
        dense &&
        previousFull !== null &&
        // 字ごとに振り分けた行(丸囲み文字などで上下にはみ出す)は、行の高さが大きくても文章の行として扱う。空欄の枠を含む行も少し高い。
        height <= textHeight * (band.atoms.some((atom) => atom.y0 !== undefined) ? 2.4 : 1.8) &&
        band.left <= previousFull.left + W * 0.06 &&
        band.left >= previousFull.left - W * 0.03;
      // 表の切れ端(aside)は後で文章の後ろへ移すので、段落のつながりを判断するときは飛ばす。
      let currentIndex = items.length - 1;
      // 図の横の段の行が右端まで届いていれば、図の下の行はその段落の続きなので、間の図(横に並ぶもの)も飛ばしてつなげる(図は段落の後ろに残る)。
      const skippable = (item: Item) =>
        item.kind === 'block' &&
        (item.aside ||
          (item.figure === true && previousFull !== null && item.page === page && item.top < previousFull.bottom + textHeight && item.left >= previousFull.right - textHeight * 0.5));
      while (currentIndex >= 0 && skippable(items[currentIndex])) currentIndex -= 1;
      const current = items[currentIndex];


      // 図の横の段の行は、箇条書きが混ざらないよう段落としてつなげず、1行ずつ折り返す。
      if (band.limit !== undefined && !band.figure && dense && nearLeft && height <= textHeight * 2.4) {
        // ただし、前の行が(段の)右端まで届いていて、この行が字下げなしで続くなら、段落の続きとしてつなげる。
        const continues =
          previousFull !== null &&
          current?.kind === 'text' &&
          band.left <= previousFull.left + W * 0.06 &&
          band.left >= previousFull.left - W * 0.03;
        if (continues && current?.kind === 'text') current.fragments.push(...toFragments(page, band));
        else items.push({ kind: 'text', fragments: toFragments(page, band) });
        // 短い行(選択肢の式など)は、段の右端がその行自身で決まるので「右端まで届いた」とみなさない。
        previousFull = band.right >= rightEdge - W * 0.02 && band.right - band.left >= W * 0.2 ? band : null;
        continue;
      }

      // 行の右に図の番号やラベルなどの小さな記号だけが並んでいる場合は、行の前半だけを文章とする。
      // 段落の続きの行か、前半が十分に長い(問題の1行目など)ときに限る。後ろに文字のまとまり(表のセルなど)があれば切らない。
      if (!full && !tail && !band.figure && !band.mask && !band.masks && height <= textHeight * 2 && nearLeft) {
        const head = denseHead(band, textHeight);
        const continues = previousFull !== null && band.left <= previousFull.left + W * 0.06 && band.left >= previousFull.left - W * 0.03;
        if (head && (continues || head.right - head.left >= W * 0.3)) {
          if (continues && current?.kind === 'text') current.fragments.push(...toFragments(page, head));
          else items.push({ kind: 'text', fragments: toFragments(page, head) });
          const restLeft = band.atoms.find((atom) => atom.x0 > head.right)!.x0;
          // 残り(図のラベルなど)は下の図と合体することがあるので、文章として出した部分を白く塗る範囲を持たせる。
          items.push({
            kind: 'block',
            page,
            left: restLeft,
            right: band.right,
            top: band.top,
            bottom: band.bottom,
            masks: [{ top: band.top, bottom: band.bottom, left: band.left, right: Math.round((head.right + restLeft) / 2) }],
          });
          // 長い前半が本文の右端近くまで届いていれば、次の行へ段落として続ける。
          previousFull = head.right >= rightEdge - W * 0.06 ? head : null;
          continue;
        }
      }

      // 直前に表・図のブロック(本文の横に分けたもの)があり、この行の右側がその列の範囲に収まる場合は、
      // 左側の文章を表の前に文章として入れ、右側(表の続きの行)は表のブロックを下に広げて含める。
      if (!dense && !band.figure && height <= textHeight * 2.8) {
        let figureIndex = -1;
        for (let k = items.length - 1; k >= 0; k--) {
          const item = items[k];
          if (item.kind === 'block' && item.figure && item.page === page) {
            figureIndex = k;
            break;
          }
          if (item.kind === 'block') break;
        }
        const figureItem = figureIndex >= 0 ? (items[figureIndex] as Extract<Item, { kind: 'block' }>) : null;
        if (figureItem && band.top - figureItem.bottom <= textHeight * 1.5) {
          const head = band.atoms.filter((atom) => atom.x1 <= figureItem.left - textHeight * 0.5);
          const rest = band.atoms.filter((atom) => atom.x0 >= figureItem.left - textHeight * 0.5);
          const headBand: Band | null = head.length > 0 ? { ...band, atoms: head, right: head[head.length - 1].x1 } : null;
          if (
            headBand &&
            rest.length > 0 &&
            head.length + rest.length === band.atoms.length &&
            rest[rest.length - 1].x1 <= figureItem.right + textHeight &&
            isDenseLine(headBand, textHeight) &&
            headBand.right - headBand.left >= textHeight * 8
          ) {
            // 図の前の文章が右端まで届いていれば、その段落の続きとしてつなげる。
            const before = items[figureIndex - 1];
            if (before?.kind === 'text' && previousFull !== null) before.fragments.push(...toFragments(page, headBand));
            else items.splice(figureIndex, 0, { kind: 'text', fragments: toFragments(page, headBand) });
            figureItem.bottom = Math.max(figureItem.bottom, band.bottom);
            figureItem.right = Math.max(figureItem.right, rest[rest.length - 1].x1);
            previousFull = null;
            continue;
          }
        }
      }

      if (full || tail) {
        if (current?.kind === 'text' && (previousFull !== null || tail)) current.fragments.push(...toFragments(page, band));
        else items.push({ kind: 'text', fragments: toFragments(page, band) });
        // 句読点などで右端がわずかに短い行は、段落の途中とみなして次の行へつなげる。
        previousFull = full || band.right >= rightEdge - W * 0.025 ? band : null;
        continue;
      }

      // 本文の横に分けた図(figure)は段落を区切らない(図の横の最後の行の続きが図の下に続くことがある)。
      if (!band.figure) previousFull = null;
      // 短くても文章の1行(大きな空白のない行)なら、表とまとめずに1行として折り返す。
      // 分数を含む背の高い数式の行(行の高さの3倍まで)も、十分な長さ(8文字分以上)があれば文章の行とする。
      if (
        !band.figure &&
        dense &&
        nearLeft &&
        band.atoms.length > 0 &&
        (height <= textHeight * 1.6 || (height <= textHeight * 3 && band.right - band.left >= textHeight * 8))
      ) {
        items.push({ kind: 'text', fragments: toFragments(page, band) });
        continue;
      }
      // 問題の途中で、行の左が文章(幅の25%以上の、大きな空白のない行)、右(ページの中ほどより右)が表の行の場合は、左を文章、右を表のブロックにする。
      if (!band.figure && !band.mask && !dense && current !== undefined && height <= textHeight * 2.8 && nearLeft) {
        const split = band.atoms.findIndex((atom, index) => index > 0 && atom.x0 >= W * 0.45 && atom.x0 - band.atoms[index - 1].x1 >= textHeight * 2);
        if (split > 0) {
          const head = band.atoms.slice(0, split);
          const headBand: Band = { ...band, atoms: head, right: head[head.length - 1].x1 };
          if (isDenseLine(headBand, textHeight, true) && headBand.right - headBand.left >= W * 0.25) {
            if (current?.kind === 'text' && previousFull !== null) current.fragments.push(...toFragments(page, headBand));
            else items.push({ kind: 'text', fragments: toFragments(page, headBand) });
            const rest = band.atoms.slice(split);
            items.push({ kind: 'block', page, left: rest[0].x0, right: band.right, top: band.top, bottom: band.bottom, aside: true, ...(band.masks && { masks: band.masks }) });
            // 表の手前で行が終わっているので、次の行へ段落として続ける(表の切れ端は後で文章の後ろへ移す)。
            previousFull = headBand;
            continue;
          }
        }
      }
      // 数式の行などの右に、大きく(8文字分以上)離れて図の番号などの小さな記号だけがある場合は、左の部分だけを1つのブロックにする
      // (右の記号と一緒にすると横に広いブロックになり、縮小されて読めなくなるため)。右の記号は次の図のブロックとまとめる。
      if (!band.figure && !band.mask && !band.masks && height <= textHeight * 3 && nearLeft) {
        // 最も右の大きな空白で分ける(数式の後ろの点線「・・・」の前の空白では分けない)。
        let split = -1;
        band.atoms.forEach((atom, index) => {
          if (index > 0 && atom.x0 - band.atoms[index - 1].x1 >= textHeight * 8) split = index;
        });
        if (split > 0) {
          const head = band.atoms.slice(0, split);
          const rest = band.atoms.slice(split);
          const restWidth = rest[rest.length - 1].x1 - rest[0].x0;
          const headWidth = head[head.length - 1].x1 - head[0].x0;
          // 右の記号は、近い字どうしのまとまりごとに2文字分以下(「図1」など。表のセルの語は長い)。
          const groups: number[] = [];
          rest.forEach((atom, index) => {
            if (index > 0 && atom.x0 - rest[index - 1].x1 <= textHeight) groups[groups.length - 1] = atom.x1 - (rest[index - 1].x1 - groups[groups.length - 1]);
            else groups.push(atom.x1 - atom.x0);
          });
          // 左の部分が表の行のように大きな空白で何列にも分かれていないこと(数式と点線の間の空白1か所までは許す)。
          const bigGapAt = head.findIndex((atom, index) => index > 0 && atom.x0 - head[index - 1].x1 >= textHeight * 3);
          const bigGaps = head.filter((atom, index) => index > 0 && atom.x0 - head[index - 1].x1 >= textHeight * 3).length;
          // 先頭のまとまり(数式の左辺など)は3文字分以上あること(表の番号の列は短い)。
          const firstWidth = bigGapAt > 0 ? head[bigGapAt - 1].x1 - head[0].x0 : headWidth;
          if (headWidth >= textHeight * 4 && bigGaps <= 1 && firstWidth >= textHeight * 3 && groups.every((width) => width <= textHeight * 2) && restWidth <= W * 0.5) {
            const right = head[head.length - 1].x1;
            items.push({ kind: 'block', page, left: head[0].x0, right, top: band.top, bottom: band.bottom });
            // 右の記号のブロックが下のブロックとまとまって左に広がっても、左の部分が二重に見えないように白く塗る。
            items.push({
              kind: 'block',
              page,
              left: rest[0].x0,
              right: rest[rest.length - 1].x1,
              top: band.top,
              bottom: band.bottom,
              masks: [{ top: band.top, bottom: band.bottom, left: head[0].x0, right: right + 1 }],
              aside: true,
            });
            continue;
          }
        }
      }
      // 縦に続くブロックだけをまとめる。横に並ぶ図と選択肢などは別々に表示する。
      if (current?.kind === 'block' && current.page === page && !current.figure && !band.figure && band.top >= current.bottom - 2) {
        current.bottom = band.bottom;
        current.left = Math.min(current.left, band.left);
        current.right = Math.max(current.right, band.right);
        if (band.mask) current.masks = [...(current.masks ?? []), band.mask];
        if (band.masks) current.masks = [...(current.masks ?? []), ...band.masks];
      } else {
        items.push({
          kind: 'block',
          page,
          left: band.left,
          right: band.right,
          top: band.top,
          bottom: band.bottom,
          ...(band.figure && { figure: true }),
          ...((band.mask || band.masks) && { masks: [...(band.mask ? [band.mask] : []), ...(band.masks ?? [])] }),
        });
      }
    }
    // 行の右から切り離した表の切れ端(aside)は、文の途中に割り込まないよう、続く文章の後ろへ移し、隣り合う切れ端や表とまとめる。
    // 本文の横に分けた図・表(figure)も、文章をはさんで同じ位置のすぐ下に続きがあれば(表を行ごとに分けた場合など)、まとめて文章の後ろに置く。
    for (let i = 0; i < items.length; i++) {
      const aside = items[i];
      if (aside.kind !== 'block' || (!aside.aside && !aside.figure)) continue;
      if (!aside.aside) {
        let k = i + 1;
        while (k < items.length && items[k].kind === 'text') k += 1;
        const next = items[k];
        const continues =
          k > i + 1 &&
          next?.kind === 'block' &&
          next.page === aside.page &&
          next.left < aside.right + textHeight &&
          aside.left < next.right + textHeight &&
          next.top - aside.bottom <= textHeight * 2 &&
          next.top >= aside.top;
        if (!continues) continue;
      }
      items.splice(i, 1);
      let j = i;
      while (j < items.length) {
        const item = items[j];
        if (item.kind === 'text') {
          j += 1;
          continue;
        }
        if (
          item.page === aside.page &&
          (!item.figure || item.top - aside.bottom <= textHeight * 2) &&
          item.left < aside.right + textHeight &&
          aside.left < item.right + textHeight
        ) {
          // 次の切れ端や、すぐ下に続く表のブロックとまとめる。
          aside.left = Math.min(aside.left, item.left);
          aside.right = Math.max(aside.right, item.right);
          aside.top = Math.min(aside.top, item.top);
          aside.bottom = Math.max(aside.bottom, item.bottom);
          aside.masks = [...(aside.masks ?? []), ...(item.masks ?? [])];
          if (item.figure) aside.figure = true;
          items.splice(j, 1);
          continue;
        }
        break;
      }
      // まとめた範囲に入る文章の字は白く塗る。
      for (const item of items) {
        if (item.kind !== 'text') continue;
        for (const fragment of item.fragments) {
          if (fragment.page === aside.page && fragment.x1 > aside.left && fragment.x0 < aside.right && fragment.bottom > aside.top && fragment.top < aside.bottom) {
            aside.masks = [...(aside.masks ?? []), { top: fragment.top, bottom: fragment.bottom, left: fragment.x0, right: fragment.x1 }];
          }
        }
      }
      delete aside.aside;
      items.splice(j, 0, aside);
      i = j;
    }
    // 横に並ぶ図の下端で表や段が上下に分かれ、間に図が入った場合(選択肢の1〜4行目と5行目など)は、続きを図の前へ移す。
    // 表どうしは1つにまとめる(まとめた範囲が図に重なるときは並べるだけにする)。
    type Span = { page: number; left: number; right: number; top: number; bottom: number; firstLeft: number; firstTop: number };
    const spanOf = (item: Item, figureTop: number): Span | null => {
      if (item.kind === 'block') return { page: item.page, left: item.left, right: item.right, top: item.top, bottom: item.bottom, firstLeft: item.left, firstTop: item.top };
      const fragments = item.fragments;
      const last = fragments[fragments.length - 1];
      const page = last.page;
      const onPage = fragments.filter((fragment) => fragment.page === page);
      // 図の横にかかる行の右端(図より上の長い行は含めない)。
      const beside = onPage.filter((fragment) => fragment.bottom > figureTop);
      // 2行目以降の字(1行目の下付き文字は含めない)。
      const firstLineBottom = Math.max(...onPage.filter((fragment) => fragment.top < onPage[0].top + textHeight * 0.5).map((fragment) => fragment.bottom));
      const rest = onPage.filter((fragment) => fragment.top >= firstLineBottom - 2);
      return {
        page,
        left: Math.min(...(rest.length > 0 ? rest : onPage).map((fragment) => fragment.x0)),
        right: Math.max(...(beside.length > 0 ? beside : [last]).map((fragment) => fragment.x1)),
        top: Math.min(...onPage.map((fragment) => fragment.top)),
        bottom: Math.max(...onPage.map((fragment) => fragment.bottom)),
        firstLeft: fragments[0].x0,
        firstTop: fragments[0].top,
      };
    };
    const joinedTop = new Map<Item, number>();
    for (let i = 0; i < items.length; i++) {
      const head = items[i];
      if (head.kind === 'block' && head.figure) continue;
      const first = items[i + 1];
      if (first?.kind !== 'block' || !first.figure) continue;
      const span = spanOf(head, first.top);
      if (!span || span.page !== first.page) continue;
      let k = i + 1;
      // 表や段落の続きが、間をほとんど空けずにすぐ下にあるなら、その間に図が縦にはさまる余地はない。
      // 図の位置(横・上・表の範囲の中)にかかわらず、続きを図の前へ移す(続きかどうかは下で確かめる)。
      const beside = (item: Item) => item.kind === 'block' && item.figure === true && item.page === span.page;
      while (k < items.length && beside(items[k])) k += 1;
      const next = items[k];
      if (k === i + 1 || !next || (next.kind === 'block' && next.figure)) continue;
      const figures = items.slice(i + 1, k) as Array<Extract<Item, { kind: 'block' }>>;
      const nextSpan = spanOf(next, first.top);
      if (!nextSpan || (next.kind === 'text' && next.fragments[0].page !== span.page) || nextSpan.page !== span.page) continue;
      const gap = nextSpan.firstTop - span.bottom;
      const blocks = head.kind === 'block' && next.kind === 'block';
      // 同じ段落の続き(段の右端まで届いた行の次の、字下げのない行)か。
      const columnRight = Math.min(...figures.filter((figure) => figure.left >= span.left).map((figure) => figure.left));
      const lastFragment = head.kind === 'text' ? head.fragments[head.fragments.length - 1] : null;
      const sameParagraph =
        head.kind === 'text' &&
        next.kind === 'text' &&
        lastFragment !== null &&
        gap >= -textHeight * 0.5 &&
        gap <= textHeight * 1.2 &&
        lastFragment.x1 >= span.right - W * 0.02 &&
        lastFragment.x1 >= columnRight - textHeight * 3 &&
        Math.abs(nextSpan.firstLeft - span.left) <= textHeight;
      if (sameParagraph) {
        items.splice(k, 1);
        head.fragments.push(...(next as Extract<Item, { kind: 'text' }>).fragments);
        joinedTop.set(head, nextSpan.firstTop);
        i -= 1;
        continue;
      }
      if (
        gap < -textHeight * 0.5 ||
        gap > textHeight * (next.kind === 'block' ? 2 : 1.2) ||
        Math.abs(nextSpan.firstLeft - span.left) > textHeight * 1.5 ||
        // 図の横(またはすぐ下)から始まる要素の続きだけを移す(図から離れた段落を次々に図の前へ移さない)。
        (joinedTop.get(head) ?? span.top) > Math.max(...figures.map((figure) => figure.bottom)) + textHeight * 2 ||
        (blocks && Math.min(nextSpan.right, span.right) - Math.max(nextSpan.left, span.left) < Math.min(nextSpan.right - nextSpan.left, span.right - span.left) * 0.6)
      ) {
        continue;
      }
      const left = Math.min(span.left, nextSpan.left);
      const right = Math.max(span.right, nextSpan.right);
      const overlapsFigure = figures.some((item) => item.left < right - 2 && left + 2 < item.right && item.top < nextSpan.bottom - 2 && span.top + 2 < item.bottom);
      // まとめた範囲に文章の字が入るなら、字が二重に写るのでまとめない。
      const coversText = items.some(
        (item) =>
          item.kind === 'text' &&
          item.fragments.some((fragment) => fragment.page === span.page && fragment.x0 < right - 2 && left + 2 < fragment.x1 && fragment.top < nextSpan.bottom - 2 && span.top + 2 < fragment.bottom),
      );
      if (head.kind === 'block' && next.kind === 'block' && !overlapsFigure && !coversText) {
        head.left = left;
        head.right = right;
        head.bottom = Math.max(head.bottom, next.bottom);
        if (head.masks || next.masks) head.masks = [...(head.masks ?? []), ...(next.masks ?? [])];
        items.splice(k, 1);
        i -= 1;
        continue;
      }
      items.splice(k, 1);
      items.splice(i + 1, 0, next);
    }
    // 行の右から切り離した図のラベル(小さなブロック)は、文の途中に割り込まないよう、同じページの図の直前へ移す。
    for (let i = 0; i < items.length; i++) {
      const label = items[i];
      if (label.kind !== 'block' || !label.masks || label.right - label.left > textHeight * 6) continue;
      const target = items.findIndex(
        (item, j) => j > i + 1 && item.kind === 'block' && item.figure && item.page === label.page && item.right > label.left && item.left < label.right,
      );
      if (target < 0) continue;
      items.splice(i, 1);
      items.splice(target - 1, 0, label);
    }
    // 図の中に入っている(または大きく重なる)別の図は、外側の図にまとめる(同じ部分を二重に表示しない)。
    for (let i = 0; i < items.length; i++) {
      const outer = items[i];
      if (outer.kind !== 'block' || !outer.figure) continue;
      for (let j = 0; j < items.length; j++) {
        const inner = items[j];
        if (j === i || inner.kind !== 'block' || inner.page !== outer.page) continue;
        const overlap = Math.max(0, Math.min(outer.right, inner.right) - Math.max(outer.left, inner.left)) * Math.max(0, Math.min(outer.bottom, inner.bottom) - Math.max(outer.top, inner.top));
        const innerArea = (inner.right - inner.left) * (inner.bottom - inner.top);
        if (innerArea <= 0 || overlap < innerArea * 0.8) continue;
        outer.left = Math.min(outer.left, inner.left);
        outer.right = Math.max(outer.right, inner.right);
        outer.top = Math.min(outer.top, inner.top);
        outer.bottom = Math.max(outer.bottom, inner.bottom);
        if (inner.masks) outer.masks = [...(outer.masks ?? []), ...inner.masks];
        items.splice(j, 1);
        if (j < i) i -= 1;
        j -= 1;
      }
    }
    // どの経路で作ったブロックでも、文章として別に表示する字が範囲に入っていれば白く塗る(二重に写さない)。
    for (const block of items) {
      if (block.kind !== 'block') continue;
      for (const item of items) {
        if (item.kind !== 'text') continue;
        for (const fragment of item.fragments) {
          if (fragment.page !== block.page || fragment.x1 <= block.left || fragment.x0 >= block.right || fragment.bottom <= block.top || fragment.top >= block.bottom) continue;
          const masks = block.masks ?? [];
          if (masks.some((mask) => mask.left <= fragment.x0 && mask.right >= fragment.x1 && mask.top <= fragment.top && mask.bottom >= fragment.bottom)) continue;
          block.masks = [...masks, { top: fragment.top, bottom: fragment.bottom, left: fragment.x0, right: fragment.x1 }];
        }
      }
    }
    return items;
  });

  return { ok: true, found: collected.length, expected, textHeight, pageWidth: W, questions };
}

export interface Row {
  fragments: Array<Fragment & { dx: number }>;
  width: number;
  ascent: number;
  descent: number;
}

/** 断片を指定幅に折り返す。超えたら直前の1.5文字の範囲で最も広い隙間で改行する。 */
export function wrapFragments(fragments: Fragment[], maxWidth: number, pitch: number): Row[] {
  const rows: Row[] = [];
  let pending: Fragment[] = [];

  const gapBetween = (a: Fragment, b: Fragment) => {
    // 同じ行の断片か(字ごとに上下の範囲が違う行もあるので、行の基準線で比べる)。
    const sameLine = a.page === b.page && a.baseline === b.baseline;
    return sameLine ? Math.max(0, b.x0 - a.x1) : pitch * 0.08;
  };

  const widthOf = (items: Fragment[]) =>
    items.reduce((sum, item, index) => sum + (item.x1 - item.x0) + (index > 0 ? gapBetween(items[index - 1], item) : 0), 0);

  const flush = (items: Fragment[]) => {
    let dx = 0;
    let ascent = 0;
    let descent = 0;
    const placed = items.map((item, index) => {
      if (index > 0) dx += gapBetween(items[index - 1], item);
      const entry = { ...item, dx };
      dx += item.x1 - item.x0;
      ascent = Math.max(ascent, item.baseline - item.top);
      descent = Math.max(descent, item.bottom - item.baseline);
      return entry;
    });
    rows.push({ fragments: placed, width: dx, ascent, descent });
  };

  for (const fragment of fragments) {
    pending.push(fragment);
    if (widthOf(pending) <= maxWidth || pending.length === 1) continue;

    let cut = pending.length - 1;
    let best = -1;
    for (let index = pending.length - 1; index >= 1; index--) {
      if (widthOf(pending.slice(0, index)) < maxWidth - pitch * 1.5) break;
      const gap = gapBetween(pending[index - 1], pending[index]);
      // 句読点(幅の狭い字)を行の頭にしない。
      const narrowStart = pending[index].x1 - pending[index].x0 < pitch * 0.45;
      if (!narrowStart && gap > best && widthOf(pending.slice(0, index)) <= maxWidth) {
        best = gap;
        cut = index;
      }
    }
    flush(pending.slice(0, cut));
    pending = pending.slice(cut);
  }
  if (pending.length > 0) flush(pending);
  return rows;
}
