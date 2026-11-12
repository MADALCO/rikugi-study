import * as pdfjs from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';

/** 描画された図形(線・面・画像)の外接矩形。座標は解析幅の画像の px。 */
export interface GraphicRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  image: boolean;
  /** 軸に沿った長方形(rectangle 命令)。見えない背景の枠などを見分けるのに使う。 */
  rect?: boolean;
}

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** 白(背景と同じ色)なら見えないので図形として数えない。 */
function isWhite(color: unknown): boolean {
  if (typeof color === 'string') return /^#?f{6}$/i.test(color);
  if (Array.isArray(color) && color.length >= 3) return color.slice(0, 3).every((v) => Number(v) >= 250 || Number(v) >= 0.98 && Number(v) <= 1);
  return false;
}

/**
 * 画像の中で白以外が描かれている範囲を、画像の単位正方形の座標 [u0, v0, u1, v1] で返す(PDFの画像は下から上)。
 * 何も描かれていなければ undefined、画素を読めなければ null(外枠を使う)。
 */
async function imageContent(page: PDFPageProxy, id: string): Promise<[number, number, number, number] | null | undefined> {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  const image = await new Promise<{ width: number; height: number; data?: Uint8ClampedArray; bitmap?: ImageBitmap; kind?: number } | null>((resolve) => {
    try {
      store.get(id, resolve);
    } catch {
      resolve(null);
    }
    setTimeout(() => resolve(null), 3000);
  });
  if (!image || !image.width || !image.height) return null;
  const { width, height } = image;
  let rgba: Uint8ClampedArray | null = null;
  if (image.bitmap && typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image.bitmap, 0, 0);
    rgba = context.getImageData(0, 0, width, height).data;
  }
  const dark = (x: number, y: number): boolean => {
    const i = y * width + x;
    if (rgba) return rgba[i * 4 + 3] > 0 && (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3 < 200;
    const data = image.data;
    if (!data) return true;
    if (image.kind === 1) return ((data[y * Math.ceil(width / 8) + (x >> 3)] >> (7 - (x & 7))) & 1) === 0;
    if (image.kind === 2) return (data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2]) / 3 < 200;
    return data[i * 4 + 3] > 0 && (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 < 200;
  };
  if (!rgba && !image.data) return null;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 600));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (!dark(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return undefined;
  return [x0 / width, 1 - (y1 + step) / height, Math.min(1, (x1 + step) / width), 1 - y0 / height];
}

/**
 * ページの描画命令から、線・塗りつぶし・画像の位置を取り出す(文字は含めない。内容の文字は読まない)。
 * 墨の形から図を推測する代わりに、PDFに描かれた図形そのものの範囲を使う。
 */
export async function pageGraphics(page: PDFPageProxy, width: number): Promise<GraphicRect[]> {
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const list = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const rects: GraphicRect[] = [];
  let ctm: Matrix = viewport.transform as Matrix;
  const stack: Array<{ ctm: Matrix; fill: unknown; stroke: unknown }> = [];
  let fill: unknown = '#000000';
  let stroke: unknown = '#000000';
  // 描画待ちの線(つながった線ごとの外接矩形。ページ座標)。古いPDFはページ中の線を1つの命令でまとめて描くので、線ごとに分ける。
  let pending: Array<Array<[number, number]>> = [];
  const rectangles = new WeakSet<Array<[number, number]>>();
  const push = (corners: Array<[number, number]>, image: boolean) => {
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const rect: GraphicRect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), image, ...(rectangles.has(corners) && { rect: true }) };
    if (rect.right < 0 || rect.bottom < 0 || rect.left > width || rect.top > viewport.height) return;
    // ページの外へはみ出す部分は切り捨てる。
    rect.left = Math.max(0, rect.left);
    rect.top = Math.max(0, rect.top);
    rect.right = Math.min(width, rect.right);
    rect.bottom = Math.min(viewport.height, rect.bottom);
    rects.push(rect);
  };
  const paintPending = (visible: boolean) => {
    if (visible) for (const points of pending) if (points.length > 0) push(points, false);
    pending = [];
  };
  const addPath = (ops: number[], coords: number[], m: Matrix) => {
    let current: Array<[number, number]> | null = null;
    let k = 0;
    const take = (count: number) => {
      const points: Array<[number, number]> = [];
      for (let n = 0; n < count; n += 2) points.push(apply(m, coords[k + n], coords[k + n + 1]));
      k += count;
      return points;
    };
    for (const op of ops) {
      switch (op) {
        case OPS.moveTo:
          current = take(2);
          pending.push(current);
          break;
        case OPS.lineTo:
        case OPS.curveTo:
        case OPS.curveTo2:
        case OPS.curveTo3: {
          const count = op === OPS.lineTo ? 2 : op === OPS.curveTo ? 6 : 4;
          const points = take(count);
          if (!current) {
            current = [];
            pending.push(current);
          }
          current.push(...points);
          break;
        }
        case OPS.rectangle: {
          const [x, y, w, h] = coords.slice(k, k + 4);
          k += 4;
          const corners: Array<[number, number]> = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
          rectangles.add(corners);
          pending.push(corners);
          current = null;
          break;
        }
        default:
          break;
      }
    }
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push({ ctm, fill, stroke });
        break;
      case OPS.restore: {
        const state = stack.pop();
        if (state) ({ ctm, fill, stroke } = state);
        break;
      }
      case OPS.transform:
        ctm = multiply(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ctm, fill, stroke });
        if (Array.isArray(args[0]) && args[0].length === 6) ctm = multiply(ctm, args[0] as Matrix);
        break;
      case OPS.paintFormXObjectEnd: {
        const state = stack.pop();
        if (state) ({ ctm, fill, stroke } = state);
        break;
      }
      case OPS.setFillRGBColor:
        fill = args.length === 1 ? args[0] : args;
        break;
      case OPS.setStrokeRGBColor:
        stroke = args.length === 1 ? args[0] : args;
        break;
      case OPS.constructPath:
        if (Array.isArray(args[0]) && Array.isArray(args[1])) addPath(args[0] as number[], args[1] as number[], ctm);
        break;
      case OPS.stroke:
      case OPS.closeStroke:
        paintPending(!isWhite(stroke));
        break;
      case OPS.fill:
      case OPS.eoFill:
        paintPending(!isWhite(fill));
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        paintPending(!isWhite(fill) || !isWhite(stroke));
        break;
      case OPS.endPath:
        paintPending(false);
        break;
      case OPS.paintImageXObject: {
        // 画像は外枠ではなく、白以外が描かれている部分の範囲を使う(余白の大きい画像が本文に重ならないように)。
        const content = typeof args[0] === 'string' ? await imageContent(page, args[0]) : null;
        const [u0, v0, u1, v1] = content ?? [0, 0, 1, 1];
        if (content !== undefined) push([apply(ctm, u0, v0), apply(ctm, u1, v0), apply(ctm, u0, v1), apply(ctm, u1, v1)], true);
        break;
      }
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
        push([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)], true);
        break;
      default:
        break;
    }
  }
  return rects;
}

export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 図を形づくる図形(線・面・画像)の矩形。図の線の墨を見分けるのに使う。 */
  parts?: Region[];
}

const near = (a: Region, b: Region, gap: number) =>
  a.left - gap <= b.right && b.left - gap <= a.right && a.top - gap <= b.bottom && b.top - gap <= a.bottom;

function cluster<T extends Region>(rects: T[], gap: number): Array<{ box: Region; members: T[] }> {
  const groups: Array<{ box: Region; members: T[] }> = rects.map((rect) => ({ box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, members: [rect] }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (!near(groups[i].box, groups[j].box, gap)) continue;
        const a = groups[i].box;
        const b = groups[j].box;
        groups[i] = {
          box: { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) },
          members: [...groups[i].members, ...groups[j].members],
        };
        groups.splice(j, 1);
        changed = true;
        j -= 1;
      }
    }
  }
  return groups;
}

/**
 * 図形の矩形から、図の範囲を求める。
 * 分数の横棒・空欄の枠・根号の線のような小さく孤立した図形は字の一部なので除き、
 * 大きなまとまり(図・表の罫線・画像)だけを図とする。近くの小さな図形(端子の記号の画像など)は図に含める。
 * ページ全体を覆う画像(スキャンしたPDF)や、図形がページの大半を占める場合は使わない(null)。
 */
export function figureRegions(rects: GraphicRect[], textHeight: number, pageWidth: number, pageHeight: number): Region[] | null {
  // 本文の幅のほぼ全体を覆う画像(透明な画像が本文に重なっていることがある)は図として扱わない。
  const visible = rects.filter((rect) => (rect.right - rect.left > 0.5 || rect.bottom - rect.top > 0.5) && !(rect.image && rect.right - rect.left > pageWidth * 0.8));
  if (visible.some((rect) => rect.image && (rect.right - rect.left) * (rect.bottom - rect.top) > pageWidth * pageHeight * 0.5)) return null;
  // ほぼ接している図形だけをまとめる(図の線はつながっている。上下の行の根号どうしは離れている)。
  const groups = cluster(visible, 3);
  const isFigure = (group: { box: Region; members: GraphicRect[] }) => {
    const width = group.box.right - group.box.left;
    const height = group.box.bottom - group.box.top;
    // 画像を含まないまとまりは行の3倍以上の高さから(分数を覆う根号は行の2.5倍ほどある)。
    const hasImage = group.members.some((rect) => rect.image);
    if (width < textHeight * 3 || height < textHeight * (hasImage ? 2 : 3)) return false;
    // 1つの矩形だけ(文章を囲む枠や、空欄の大きな枠)は図としない。
    if (group.members.length === 1 && !group.members[0].image) return false;
    // 字の高さほどの枠だけが並んだもの(上下の行の空欄の枠など)も図としない。図には線や大きな図形が含まれる。
    const boxLike = (rect: GraphicRect) =>
      !rect.image && rect.right - rect.left >= 3 && rect.bottom - rect.top >= 3 && rect.bottom - rect.top <= textHeight * 2 && rect.right - rect.left <= textHeight * 8;
    if (group.members.every(boxLike)) return false;
    // 図は、画像・大きな図形を含むか、図形どうしが接している(線がつながる)。
    // 小さな図形が離れて並んでいるだけ(選択肢の根号や分数の横棒が縦に並ぶ)なら字の飾り。
    // 細い線だけの少ないまとまり(式の大きな根号や括弧)は、上線が長くても図としない。
    const thin = (rect: GraphicRect) => rect.right - rect.left <= 3 || rect.bottom - rect.top <= 3 || (rect.right - rect.left <= textHeight * 1.2 && rect.bottom - rect.top <= textHeight * 1.2);
    if (!hasImage && group.members.length <= 8 && height <= textHeight * 4.5 && group.members.every(thin)) return false;
    // 短い縦線(行の高さほど)と短い横線だけでできた低いまとまりは、上下の行の空欄の枠が接して並んだもの。
    const shortLines = group.members.every(
      (rect) =>
        !rect.image &&
        ((rect.right - rect.left <= 3 && rect.bottom - rect.top <= textHeight * 2) || (rect.bottom - rect.top <= 3 && rect.right - rect.left <= textHeight * 8)),
    );
    if (shortLines && height <= textHeight * 4.5) return false;
    if (group.members.some((rect) => rect.image || (!thin(rect) && (rect.bottom - rect.top > textHeight * 2.6 || rect.right - rect.left > textHeight * 8)))) return true;
    let touching = 0;
    for (let i = 0; i < group.members.length && touching < 2; i++) {
      for (let j = i + 1; j < group.members.length && touching < 2; j++) if (near(group.members[i], group.members[j], 1)) touching += 1;
    }
    return touching >= 2;
  };
  const figures = groups.filter(isFigure);
  if (figures.length === 0) return [];
  // 近い図どうし(行の2.5倍以内)はまとめる。小さなまとまりを介してつなげない(空欄の枠などが鎖になって離れた図を結ばないように)。
  // 図の本体に接する小さなまとまり(端子の記号の画像など)は図に含める。
  const small = groups.filter((group) => !isFigure(group));
  const merged = cluster(
    figures.map((group) => ({ ...group.box, parts: group.members.map(({ left, top, right, bottom }) => ({ left, top, right, bottom })) })),
    textHeight * 2.5,
  ).map((group) => {
    const box = { ...group.box };
    const parts = group.members.flatMap((member) => member.parts);
    const cores = [...parts];
    for (const extra of small) {
      // 図の線に接しているものだけ(外接矩形の中にあるだけの空欄の枠などは含めない)。
      if (!cores.some((part) => near(part, extra.box, textHeight))) continue;
      box.left = Math.min(box.left, extra.box.left);
      box.top = Math.min(box.top, extra.box.top);
      box.right = Math.max(box.right, extra.box.right);
      box.bottom = Math.max(box.bottom, extra.box.bottom);
      parts.push(...extra.members.map(({ left, top, right, bottom }) => ({ left, top, right, bottom })));
    }
    return { left: Math.floor(box.left), top: Math.floor(box.top), right: Math.ceil(box.right), bottom: Math.ceil(box.bottom), parts } as Region;
  });
  // 重なる範囲(図の中の図など)は1つにまとめる(同じ部分を二重に表示しない)。
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      for (let j = i + 1; j < merged.length && !changed; j++) {
        const a = merged[i];
        const b = merged[j];
        if (!near(a, b, 0)) continue;
        merged[i] = { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), parts: [...(a.parts ?? []), ...(b.parts ?? [])] };
        merged.splice(j, 1);
        changed = true;
      }
    }
  }
  const area = merged.reduce((sum, region) => sum + (region.right - region.left) * (region.bottom - region.top), 0);
  if (area > pageWidth * pageHeight * 0.6) return null;
  return merged;
}

/**
 * 描かれていても見えない図形(白や薄い色の背景、透明な枠)を除く。
 * 長方形は縁に墨があるもの、画像は中に墨があるものだけを残す。同じ位置の重複も除く。
 */
export function visibleGraphics(rects: GraphicRect[], ink: { width: number; height: number; data: Uint8Array }): GraphicRect[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < ink.width && y < ink.height && ink.data[Math.floor(y) * ink.width + Math.floor(x)] === 1;
  const inkNear = (x: number, y: number) => at(x, y) || at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1);
  const seen = new Set<string>();
  return rects.filter((rect) => {
    const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)},${rect.image}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (rect.image) {
      let hits = 0;
      for (let y = rect.top; y < rect.bottom; y += 2) for (let x = rect.left; x < rect.right; x += 2) if (at(x, y)) hits += 1;
      return hits > 0;
    }
    if (!rect.rect || width <= 4 || height <= 4) return true;
    let hits = 0;
    let total = 0;
    for (let x = rect.left; x <= rect.right; x += 2) {
      total += 2;
      if (inkNear(x, rect.top)) hits += 1;
      if (inkNear(x, rect.bottom)) hits += 1;
    }
    for (let y = rect.top; y <= rect.bottom; y += 2) {
      total += 2;
      if (inkNear(rect.left, y)) hits += 1;
      if (inkNear(rect.right, y)) hits += 1;
    }
    return hits >= total * 0.5;
  });
}
