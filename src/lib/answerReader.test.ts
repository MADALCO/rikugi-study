import { describe, expect, it } from 'vitest';
import { answerColumns, classifyDigit, joinVertical, rowsInColumn, type Table, type Template } from './answerReader';
import type { Ink } from './reflow';

function blank(width: number, height: number): Ink {
  return { width, height, data: new Uint8Array(width * height) };
}

function fill(ink: Ink, x0: number, x1: number, y0: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink.data[y * ink.width + x] = 1;
}

describe('罫線', () => {
  it('同じ位置で途切れた縦線をつなぐ', () => {
    const lines = joinVertical(
      [
        { x0: 100, x1: 102, y0: 0, y1: 80 },
        { x0: 101, x1: 103, y0: 82, y1: 160 },
        { x0: 300, x1: 302, y0: 0, y1: 60 },
      ],
      6,
      70,
    );
    expect(lines).toEqual([{ x0: 100, x1: 103, y0: 0, y1: 160 }]);
  });

  it('離れすぎた線はつながない', () => {
    const lines = joinVertical([{ x0: 10, x1: 12, y0: 0, y1: 80 }, { x0: 10, x1: 12, y0: 120, y1: 200 }], 6, 70);
    expect(lines).toHaveLength(2);
  });
});

describe('列の中の行', () => {
  it('文字の行をセルとし、列幅いっぱいの罫線は除く', () => {
    const ink = blank(100, 120);
    fill(ink, 40, 50, 10, 25);
    fill(ink, 0, 100, 40, 42);
    fill(ink, 40, 50, 60, 75);
    const cells = rowsInColumn(ink, 0, 100, 0, 120, 2);
    expect(cells).toHaveLength(2);
    expect(cells[0].y0).toBeLessThanOrEqual(10);
    expect(cells[1].y1).toBeGreaterThanOrEqual(75);
  });
});

describe('正答列の判定', () => {
  const column = (x0: number) => ({ x0, x1: x0 + 50, cells: [] });
  const table: Table = { columns: [column(0), column(60), column(120), column(180), column(240)] };

  it('A問題の表: 番号列の右隣の列', () => {
    expect(answerColumns({ columns: table.columns.slice(0, 4) }, [true, false, true, false]).map((c) => c.x0)).toEqual([60, 180]);
  });

  it('B問題の表: 記号列(ア〜オ)は除き、その右の列だけ', () => {
    expect(answerColumns({ columns: table.columns.slice(0, 3) }, [true, false, false]).map((c) => c.x0)).toEqual([120]);
  });
});

describe('数字の判定', () => {
  const pattern = (bits: number[]): Float32Array => Float32Array.from(bits);
  const one = pattern(Array.from({ length: 216 }, (_, i) => (i % 12 === 6 ? 1 : 0)));
  const bar = pattern(Array.from({ length: 216 }, (_, i) => (Math.floor(i / 12) === 9 ? 1 : 0)));
  const templates: Template[] = [
    { digit: 1, aspect: 0.3, pixels: one },
    { digit: 7, aspect: 0.6, pixels: bar },
  ];

  it('最も近い見本の数字と、2番目との差を返す', () => {
    const guess = classifyDigit({ aspect: 0.3, pixels: one }, templates);
    expect(guess.digit).toBe(1);
    expect(guess.margin).toBeGreaterThan(0.5);
  });
});
