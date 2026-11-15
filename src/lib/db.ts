import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SubjectId } from './exam';
import type { DocLayout } from './reflow';
import type { Answers } from './scoring';

export interface CatalogExam {
  id: string;
  label: string;
  subjects: Partial<Record<SubjectId, { question?: string; answer?: string }>>;
}

export interface Catalog {
  version: number;
  exams: CatalogExam[];
}

export interface Attempt {
  id: string;
  examId: string;
  subject: SubjectId;
  status: 'active' | 'submitted' | 'finished';
  startedAt: number;
  finishedAt: number | null;
  elapsedSec: number;
  answers: Answers;
  flags: Record<string, boolean>;
  pageOf: Record<string, number>;
  points: number | null;
}

export interface KeyRecord {
  id: string;
  key: Answers;
  updatedAt: number;
}

export interface ResolvedRecord {
  id: string;
  resolvedAt: number;
}

interface Schema extends DBSchema {
  pdfs: { key: string; value: ArrayBuffer };
  meta: { key: string; value: unknown };
  keys: { key: string; value: KeyRecord };
  attempts: { key: string; value: Attempt; indexes: { byExam: [string, SubjectId] } };
  resolved: { key: string; value: ResolvedRecord };
}

const DB_NAME = 'rikugi-study';
let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore('pdfs');
      database.createObjectStore('meta');
      database.createObjectStore('keys', { keyPath: 'id' });
      database.createObjectStore('resolved', { keyPath: 'id' });
      const attempts = database.createObjectStore('attempts', { keyPath: 'id' });
      attempts.createIndex('byExam', ['examId', 'subject']);
    },
  });
  return dbPromise;
}

export const keyId = (examId: string, subject: SubjectId) => `${examId}/${subject}`;
export const questionRef = (examId: string, subject: SubjectId, questionId: string) =>
  `${examId}/${subject}/${questionId}`;

// ---- ライブラリ ----

export async function getCatalog(): Promise<Catalog | null> {
  return ((await (await db()).get('meta', 'catalog')) as Catalog | undefined) ?? null;
}

/** PDFを1つ保存する(ZIPから1つずつ取り出して保存し、メモリを使い過ぎないように)。 */
export async function savePdf(name: string, bytes: Uint8Array): Promise<void> {
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
  await (await db()).put('pdfs', copy, name);
}

/** 保存済みのPDFの名前。 */
export async function pdfNames(): Promise<Set<string>> {
  return new Set(await (await db()).getAllKeys('pdfs'));
}

/** 回の一覧を保存する(PDFをすべて保存し終えてから)。 */
export async function saveCatalog(catalog: Catalog): Promise<void> {
  await (await db()).put('meta', catalog, 'catalog');
}

export async function getPdf(name: string): Promise<ArrayBuffer | null> {
  return (await (await db()).get('pdfs', name)) ?? null;
}

// ---- 表示用レイアウト(切り出し座標のみ。解析方法を変えたら版を上げる) ----

/** 解析方法の版。Macで作った切り分けデータ(layouts.json)も、この版が一致するときだけ使う。 */
export const LAYOUT_VERSION = 'v166';
const layoutKey = (file: string) => `layout-${LAYOUT_VERSION}:${file}`;

export async function getLayout(file: string): Promise<DocLayout | null> {
  return ((await (await db()).get('meta', layoutKey(file))) as DocLayout | undefined) ?? null;
}

export async function saveLayout(file: string, layout: DocLayout): Promise<void> {
  await (await db()).put('meta', layout, layoutKey(file));
}

/** Macで作った切り分けデータをまとめて保存する(端末ごとの描画の違いで切り分けが変わらないように)。 */
export async function saveLayouts(layouts: Record<string, DocLayout>): Promise<number> {
  const tx = (await db()).transaction('meta', 'readwrite');
  let count = 0;
  for (const [file, layout] of Object.entries(layouts)) {
    if (!layout?.ok) continue;
    await tx.store.put(layout, layoutKey(file));
    count += 1;
  }
  await tx.done;
  return count;
}

// ---- 正答 ----

export async function getKey(examId: string, subject: SubjectId): Promise<Answers | undefined> {
  return (await (await db()).get('keys', keyId(examId, subject)))?.key;
}

export async function saveKey(examId: string, subject: SubjectId, key: Answers): Promise<void> {
  await (await db()).put('keys', { id: keyId(examId, subject), key, updatedAt: Date.now() });
}

// ---- 解答の記録 ----

export function newAttempt(examId: string, subject: SubjectId, now = Date.now()): Attempt {
  return {
    id: `${examId}_${subject}_${now}`,
    examId,
    subject,
    status: 'active',
    startedAt: now,
    finishedAt: null,
    elapsedSec: 0,
    answers: {},
    flags: {},
    pageOf: {},
    points: null,
  };
}

export async function saveAttempt(attempt: Attempt): Promise<void> {
  await (await db()).put('attempts', attempt);
}

export async function getAttempt(id: string): Promise<Attempt | undefined> {
  return (await db()).get('attempts', id);
}

export async function deleteAttempt(id: string): Promise<void> {
  await (await db()).delete('attempts', id);
}

export async function allAttempts(): Promise<Attempt[]> {
  return (await db()).getAll('attempts');
}

/** 途中の記録があれば返し、なければ作る。1トランザクションで行い、二重に作られないようにする。 */
export async function getOrCreateActiveAttempt(examId: string, subject: SubjectId): Promise<Attempt> {
  const tx = (await db()).transaction('attempts', 'readwrite');
  const existing = await tx.store.index('byExam').getAll([examId, subject]);
  const active = existing.find((attempt) => attempt.status !== 'finished');
  if (active) {
    await tx.done;
    return active;
  }
  const created = newAttempt(examId, subject);
  await tx.store.put(created);
  await tx.done;
  return created;
}

export async function findActiveAttempt(examId: string, subject: SubjectId): Promise<Attempt | undefined> {
  const attempts = await (await db()).getAllFromIndex('attempts', 'byExam', [examId, subject]);
  return attempts.find((attempt) => attempt.status !== 'finished');
}

// ---- 復習 ----

export async function allResolved(): Promise<ResolvedRecord[]> {
  return (await db()).getAll('resolved');
}

export async function markResolved(ref: string, now = Date.now()): Promise<void> {
  await (await db()).put('resolved', { id: ref, resolvedAt: now });
}

// ---- バックアップ ----

export interface Backup {
  app: 'rikugi-study';
  version: 1;
  exportedAt: number;
  keys: KeyRecord[];
  attempts: Attempt[];
  resolved: ResolvedRecord[];
}

export async function getLastBackupAt(): Promise<number | null> {
  return ((await (await db()).get('meta', 'lastBackupAt')) as number | undefined) ?? null;
}

export async function exportBackup(now = Date.now()): Promise<Backup> {
  const database = await db();
  const backup: Backup = {
    app: 'rikugi-study',
    version: 1,
    exportedAt: now,
    keys: await database.getAll('keys'),
    attempts: await database.getAll('attempts'),
    resolved: await database.getAll('resolved'),
  };
  await database.put('meta', now, 'lastBackupAt');
  return backup;
}

function assertBackup(value: unknown): asserts value is Backup {
  const candidate = value as Partial<Backup> | null;
  if (
    !candidate ||
    candidate.app !== 'rikugi-study' ||
    !Array.isArray(candidate.keys) ||
    !Array.isArray(candidate.attempts) ||
    !Array.isArray(candidate.resolved)
  ) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
}

/** バックアップを統合する。同じIDは経過時間や更新時刻が新しい方を残すので、既存の記録は巻き戻らない。 */
export async function importBackup(value: unknown): Promise<void> {
  assertBackup(value);
  const database = await db();
  const tx = database.transaction(['keys', 'attempts', 'resolved'], 'readwrite');
  for (const record of value.keys) {
    const current = await tx.objectStore('keys').get(record.id);
    if (!current || current.updatedAt <= record.updatedAt) await tx.objectStore('keys').put(record);
  }
  for (const attempt of value.attempts) {
    const current = await tx.objectStore('attempts').get(attempt.id);
    if (!current || current.status !== 'finished' || attempt.status === 'finished') {
      if (!current || attempt.elapsedSec >= current.elapsedSec || attempt.status === 'finished') {
        await tx.objectStore('attempts').put(attempt);
      }
    }
  }
  for (const record of value.resolved) {
    const current = await tx.objectStore('resolved').get(record.id);
    if (!current || current.resolvedAt <= record.resolvedAt) await tx.objectStore('resolved').put(record);
  }
  await tx.done;
}

export async function resetDatabaseForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
