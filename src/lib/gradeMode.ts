/** 採点のしかた。each: 1問ごとに答え合わせ(既定)、all: 本番と同じく最後にまとめて採点。 */
export type GradeMode = 'each' | 'all';

const KEY = 'rikugi-grade-mode';

export function getGradeMode(): GradeMode {
  try {
    return localStorage.getItem(KEY) === 'all' ? 'all' : 'each';
  } catch {
    return 'each';
  }
}

export function setGradeMode(mode: GradeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // 保存できない環境では、その場だけの設定になる。
  }
}
