import { describe, expect, it } from 'vitest';
import { analyzeDocument, clusterAtoms, componentLines, denseHead, findBands, isDenseLine, peelLines, refineBands, rowPieces, splitBesideFigure, splitStackedLines, startColumn, strokeRule, wrapFragments, type Band, type Fragment, type Ink, type PageBands } from './reflow';

function blank(width: number, height: number): Ink {
  return { width, height, data: new Uint8Array(width * height) };
}

function fill(ink: Ink, x0: number, x1: number, y0: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink.data[y * ink.width + x] = 1;
}

function band(left: number, right: number, top: number, height = 20): Band {
  return { left, right, top, bottom: top + height, baseline: top + height - 3, atoms: [{ x0: left, x1: right }] };
}

function page(bands: Band[], number = 1): PageBands {
  return { page: number, width: 1000, height: 1400, bands };
}

describe('行の検出', () => {
  it('空白で行を分け、狭い隙間の添字は同じ行にする', () => {
    const ink = blank(100, 100);
    fill(ink, 10, 50, 10, 20);
    fill(ink, 10, 50, 22, 26);
    fill(ink, 20, 80, 50, 60);
    const bands = findBands(ink, 3);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toMatchObject({ top: 10, bottom: 26, left: 10, right: 50 });
    expect(bands[1]).toMatchObject({ top: 50, bottom: 60, left: 20, right: 80 });
  });

  it('文字の塊を列の隙間で分ける', () => {
    const ink = blank(100, 30);
    fill(ink, 10, 20, 5, 15);
    fill(ink, 25, 35, 5, 15);
    expect(findBands(ink, 3)[0].atoms).toEqual([{ x0: 10, x1: 20 }, { x0: 25, x1: 35 }]);
  });
});

describe('つながった行の分け直し', () => {
  it('本文2行がつながった帯は2行に分ける', () => {
    const ink = blank(200, 60);
    fill(ink, 10, 190, 5, 20);
    fill(ink, 10, 190, 23, 38);
    const [merged] = findBands(ink, 4);
    expect(merged.bottom - merged.top).toBe(33);
    const parts = splitStackedLines(ink, [merged], 15);
    expect(parts.map((part) => [part.top, part.bottom])).toEqual([[5, 20], [23, 38]]);
  });

  it('分数のように短い部分を含む帯は分けない', () => {
    const ink = blank(200, 60);
    fill(ink, 90, 110, 5, 15);
    fill(ink, 10, 190, 18, 33);
    fill(ink, 90, 110, 36, 46);
    const bands = findBands(ink, 4);
    expect(bands).toHaveLength(1);
    expect(splitStackedLines(ink, bands, 15)).toEqual(bands);
  });
});

describe('文字のまとまり', () => {
  it('間の狭い方の隣と同じ字にまとめる(「Iに」の「に」の左の画を「I」に付けない)', () => {
    const clusters = clusterAtoms([{ x0: 0, x1: 6 }, { x0: 10, x1: 13 }, { x0: 14, x1: 24 }], 16);
    expect(clusters.map((c) => [c.x0, c.x1])).toEqual([[0, 6], [10, 24]]);
  });

  it('「川」のように1文字内で分かれた塊をまとめる', () => {
    const atoms = [{ x0: 0, x1: 3 }, { x0: 8, x1: 11 }, { x0: 16, x1: 20 }, { x0: 24, x1: 44 }];
    expect(clusterAtoms(atoms, 20)).toEqual([{ x0: 0, x1: 20 }, { x0: 24, x1: 44 }]);
  });
});

describe('問題の分割', () => {
  const L = 60;
  const R = 940;

  it('外れ値に引きずられず、十分な数がそろう列を1行目の列とする', () => {
    const lefts = [40, 92, 96, 100, 100, 100, 140, 140, 140, 140];
    expect(startColumn(lefts, 10, 1000)).toEqual({ min: 92, max: 100 });
  });

  it('1行目が図と結合した縦長の帯でも問題の先頭として数える', () => {
    const layout = analyzeDocument([page([band(L, R, 100), band(90, R, 130), band(L, R, 300, 200), band(90, R, 520)])], 2);
    expect(layout.ok).toBe(true);
    expect(layout.questions[1][0].kind).toBe('block');
  });

  it('左端から始まる行を問題の先頭にする', () => {
    const layout = analyzeDocument(
      [page([band(L, R, 100), band(90, R, 130), band(90, 400, 160), band(L, R, 300), band(90, R, 330)])],
      2,
    );
    expect(layout.ok).toBe(true);
    expect(layout.questions).toHaveLength(2);
    expect(layout.questions[0]).toHaveLength(1);
    expect(layout.questions[0][0].kind).toBe('text');
  });

  it('問題数が合わなければ失敗として返す', () => {
    const layout = analyzeDocument([page([band(L, R, 100), band(90, R, 130)])], 25);
    expect(layout).toMatchObject({ ok: false, found: 1, expected: 25 });
  });

  it('短い記号行やページ番号を問題に含めない', () => {
    const layout = analyzeDocument(
      [page([band(L, 140, 40), band(L, R, 100), band(90, R, 130), band(800, 940, 1300)])],
      1,
    );
    expect(layout.ok).toBe(true);
    const texts = layout.questions[0].filter((item) => item.kind === 'block');
    expect(texts).toHaveLength(0);
  });

  it('ページ下端の短い行でも、左から始まる行(本文の最後の行)は試験記号として捨てない', () => {
    const layout = analyzeDocument([page([band(L, R, 100), band(90, R, 130), band(90, 300, 1300)])], 1);
    expect(layout.ok).toBe(true);
    const bottoms = layout.questions[0].flatMap((item) => (item.kind === 'text' ? item.fragments.map((fragment) => fragment.bottom) : [item.bottom]));
    expect(Math.max(...bottoms)).toBe(1320);
  });

  it('表の行(列の間に大きな空白がある行)は折り返さず、続きをひとつのブロックにまとめる', () => {
    const row = (top: number): Band => ({
      left: 120,
      right: 800,
      top,
      bottom: top + 20,
      baseline: top + 17,
      atoms: [{ x0: 120, x1: 160 }, { x0: 400, x1: 440 }, { x0: 760, x1: 800 }],
    });
    const layout = analyzeDocument([page([band(L, R, 100), band(90, 500, 130), row(200), band(120, 800, 230, 90), row(340)])], 1);
    const items = layout.questions[0];
    expect(items.map((item) => item.kind)).toEqual(['text', 'block']);
    expect(items[1]).toMatchObject({ top: 200, bottom: 360, left: 120, right: 800 });
  });

  it('短い文章の1行は単独で折り返し、ページの中ほどから始まる行は表と一緒にする', () => {
    const layout = analyzeDocument([page([band(L, R, 100), band(90, 500, 130), band(120, 400, 200), band(600, 900, 240)])], 1);
    expect(layout.questions[0].map((item) => item.kind)).toEqual(['text', 'text', 'block']);
  });

  it('ページをまたぐ問題を前の問題の続きにする', () => {
    const layout = analyzeDocument(
      [page([band(L, R, 100), band(90, R, 130)], 1), page([band(90, R, 60), band(L, R, 200)], 2)],
      2,
    );
    const first = layout.questions[0][0];
    expect(first.kind === 'text' && first.fragments.map((fragment) => fragment.page)).toEqual([1, 1, 2]);
  });
});

function chars(count: number, pitch = 20, top = 0, gap = 2): Fragment[] {
  return Array.from({ length: count }, (_, index) => ({
    page: 1,
    x0: index * (pitch + gap),
    x1: index * (pitch + gap) + pitch,
    top,
    bottom: top + pitch,
    baseline: top + pitch - 2,
  }));
}

describe('折り返し', () => {
  it('指定幅を超えない', () => {
    const rows = wrapFragments(chars(30), 100, 20);
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.width).toBeLessThanOrEqual(100);
  });

  it('全ての断片を順番どおりに1回ずつ含む', () => {
    const source = chars(23);
    const output = wrapFragments(source, 90, 20).flatMap((row) => row.fragments.map((fragment) => fragment.x0));
    expect(output).toEqual(source.map((fragment) => fragment.x0));
  });

  it('幅に収まらない1塊はそのまま1行にする', () => {
    const wide: Fragment[] = [{ page: 1, x0: 0, x1: 300, top: 0, bottom: 20, baseline: 18 }];
    expect(wrapFragments(wide, 100, 20)).toHaveLength(1);
  });

  it('近くの最も広い隙間で改行する', () => {
    const items: Fragment[] = [
      { page: 1, x0: 0, x1: 80, top: 0, bottom: 20, baseline: 18 },
      { page: 1, x0: 90, x1: 100, top: 0, bottom: 20, baseline: 18 },
      { page: 1, x0: 101, x1: 125, top: 0, bottom: 20, baseline: 18 },
    ];
    const rows = wrapFragments(items, 110, 20);
    expect(rows[0].fragments).toHaveLength(1);
    expect(rows[1].fragments).toHaveLength(2);
  });

  it('字ごとに上下の範囲が違っても、同じ行(基準線が同じ)の断片の間は元の隙間を保つ', () => {
    const items: Fragment[] = [
      { page: 1, x0: 0, x1: 20, top: 2, bottom: 20, baseline: 18 },
      { page: 1, x0: 40, x1: 60, top: -4, bottom: 24, baseline: 18 },
    ];
    expect(wrapFragments(items, 1000, 20)[0].width).toBe(60);
  });

  it('別の行から続く断片は行またぎの隙間を詰める', () => {
    const items = [...chars(2), ...chars(1, 20, 40)];
    const [row] = wrapFragments(items, 1000, 20);
    expect(row.width).toBeCloseTo(20 + 2 + 20 + 1.6 + 20);
  });
});

/** 文字の行を、字の間に隙間のある塊として描く(塗りつぶしの長方形は図の線に見えてしまう)。 */
function text(ink: Ink, x0: number, x1: number, y0: number, y1: number) {
  for (let x = x0; x + 12 <= x1; x += 16) fill(ink, x, x + 12, y0, y1);
}

describe('本文と図の分け直し', () => {
  it('分数の分子・分母(横棒の真上と真下の小さな部分)は行から切り離さない', () => {
    const ink = blank(400, 80);
    fill(ink, 190, 210, 10, 20);
    text(ink, 20, 380, 24, 40);
    fill(ink, 185, 215, 30, 31);
    fill(ink, 190, 210, 44, 54);
    expect(rowPieces(ink, 10, 54, 0, 400, 16)).toHaveLength(1);
  });

  it('短い1行は、間隔が詰まっていても前の行に結合しない', () => {
    const ink = blank(400, 60);
    text(ink, 20, 380, 5, 21);
    text(ink, 20, 90, 23, 39);
    expect(rowPieces(ink, 5, 39, 0, 400, 16)).toHaveLength(2);
  });

  it('表の行(列の間に大きな空白)は文章の行とみなさない。行頭の番号の後ろの空白は数えない', () => {
    const row = (atoms: Array<[number, number]>): Band => ({ left: atoms[0][0], right: atoms[atoms.length - 1][1], top: 0, bottom: 16, baseline: 14, atoms: atoms.map(([x0, x1]) => ({ x0, x1 })) });
    expect(isDenseLine(row([[0, 10], [60, 200]]), 16)).toBe(true);
    expect(isDenseLine(row([[0, 10], [30, 100], [200, 260]]), 16)).toBe(false);
  });

  it('前半から大きく離れた見出し(3文字程度)も、前半を文章として取り出す', () => {
    const line: Band = { left: 10, right: 700, top: 0, bottom: 20, baseline: 17, atoms: [] };
    for (let x = 10; x < 180; x += 17) line.atoms.push({ x0: x, x1: x + 15 });
    line.atoms.push({ x0: 660, x1: 700 });
    expect(denseHead(line, 17)?.right).toBeLessThan(200);
  });

  it('行の右に小さな記号だけが離れて並ぶときは、前半を文章として取り出す', () => {
    const line: Band = { left: 0, right: 500, top: 0, bottom: 16, baseline: 14, atoms: [{ x0: 0, x1: 200 }, { x0: 480, x1: 492 }] };
    expect(denseHead(line, 16)?.right).toBe(200);
    const table: Band = { ...line, atoms: [{ x0: 0, x1: 200 }, { x0: 400, x1: 480 }] };
    expect(denseHead(table, 16)).toBeNull();
  });

  it('図(長い線)の左側の本文を、図に最も近い空白で分ける', () => {
    const ink = blank(600, 100);
    text(ink, 10, 122, 10, 26);
    text(ink, 160, 300, 10, 26);
    fill(ink, 420, 422, 5, 95);
    fill(ink, 420, 580, 50, 52);
    const split = splitBesideFigure(ink, 0, 100, 20, strokeRule(16));
    expect(split?.figureLeft).toBe(false);
    expect(split?.figure).toEqual([420, 580]);
    expect(split?.text[0]).toBe(10);
    expect(split?.text[1]).toBeLessThanOrEqual(300);
  });

  it('上下の文章の行をはがし、残り(図)の範囲を返す', () => {
    const ink = blank(600, 120);
    text(ink, 10, 590, 5, 21);
    fill(ink, 300, 302, 21, 24);
    fill(ink, 300, 302, 24, 110);
    const peeled = peelLines(ink, 5, 110, 0, 600, 16);
    expect(peeled.above).toHaveLength(1);
    expect(peeled.top).toBeGreaterThan(20);
  });

  it('本文の行の端と図の端の間に縦の空白がほとんどなくても、図の本体(大きくつながった線)で本文と図を分ける', () => {
    const ink = blank(600, 200);
    for (const y of [10, 34, 58, 82]) text(ink, 10, 300, y, y + 16);
    // 図: 本文のすぐ右(3px)から始まる枠と、その中の円
    fill(ink, 297, 299, 5, 150);
    fill(ink, 558, 560, 5, 150);
    fill(ink, 297, 560, 5, 7);
    fill(ink, 297, 560, 148, 150);
    for (let y = 15; y <= 135; y++) {
      for (let x = 370; x <= 490; x++) {
        const d = Math.hypot(x - 430, y - 75);
        if (d <= 60 && d >= 58) ink.data[y * ink.width + x] = 1;
      }
    }
    const bands = refineBands(ink, findBands(ink, 4), 16);
    const figure = bands.find((band) => band.figure);
    expect(figure?.left).toBe(297);
    expect(figure?.bottom).toBe(150);
    const lines = bands.filter((band) => !band.figure);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.right <= 295)).toBe(true);
  });

  it('空欄の枠の縦の辺だけが横切る行で切るときは、枠の底辺も上の行に含め、下の部分では白く塗る', () => {
    const ink = blank(600, 60);
    text(ink, 10, 400, 5, 21);
    // 空欄の枠(下の辺が本文より下にはみ出す)
    fill(ink, 420, 460, 4, 6);
    fill(ink, 420, 422, 4, 27);
    fill(ink, 458, 460, 4, 27);
    fill(ink, 420, 460, 25, 27);
    // 次の行(枠の底辺と同じ高さから始まる)
    text(ink, 10, 400, 26, 42);
    const peeled = peelLines(ink, 4, 42, 0, 600, 16);
    expect(peeled.above).toHaveLength(1);
    const box = peeled.above[0].atoms.find((atom) => atom.x0 >= 420);
    expect(box?.y1).toBeGreaterThanOrEqual(27);
    expect(peeled.restMasks).toEqual([expect.objectContaining({ left: 420, right: 460, bottom: 27 })]);
  });
});

describe('字ごとの行への振り分け', () => {
  function ring(ink: Ink, cx: number, cy: number, r: number) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r && d >= r - 2) ink.data[y * ink.width + x] = 1;
      }
    }
  }

  it('行の間にはみ出す丸囲み文字を、欠けさせずに自分の行に入れる', () => {
    const ink = blank(400, 80);
    text(ink, 10, 300, 10, 26);
    ring(ink, 340, 18, 15);
    text(ink, 10, 380, 40, 56);
    const lines = componentLines(ink, 0, 80, 0, 400, 16);
    expect(lines).toHaveLength(2);
    const circle = lines![0].atoms.find((atom) => atom.x0 >= 320);
    expect(circle?.y0).toBeLessThanOrEqual(3);
    expect(circle?.y1).toBeGreaterThanOrEqual(33);
    expect(lines![1].atoms.every((atom) => atom.x1 <= 330 || (atom.y0 ?? 0) >= 40)).toBe(true);
  });

  it('分数の分子・分母を別の行とみなさない', () => {
    const ink = blank(400, 80);
    text(ink, 180, 220, 10, 20);
    text(ink, 20, 380, 24, 40);
    text(ink, 180, 220, 44, 54);
    expect(componentLines(ink, 0, 80, 0, 400, 16)).toBeNull();
  });

  it('行より大きな図があれば振り分けない', () => {
    const ink = blank(400, 120);
    text(ink, 10, 300, 10, 26);
    fill(ink, 320, 322, 5, 110);
    text(ink, 10, 300, 40, 56);
    expect(componentLines(ink, 0, 120, 0, 400, 16)).toBeNull();
  });
});
