import { useEffect, useRef, useState } from 'react';
import { readZipEntry, readZipIndex } from '../lib/zipReader';
import { exportBackup, getCatalog, getLastBackupAt, getPdf, importBackup, LAYOUT_VERSION, pdfNames, saveCatalog, saveLayouts, savePdf, type Catalog } from '../lib/db';
import type { DocLayout } from '../lib/reflow';

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const formatDate = (time: number) => new Date(time).toLocaleDateString('ja-JP');

/** 保存済みのPDFが、ZIPの中のものと同じ大きさか(途中で止まった読み込みのやり直しで、保存済みの分を飛ばすため)。 */
const sameSize = async (name: string, size: number) => (await getPdf(name))?.byteLength === size;

export function Settings() {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [examCount, setExamCount] = useState(0);
  const zipInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLastBackup(await getLastBackupAt());
    setExamCount((await getCatalog())?.exams.length ?? 0);
    if (navigator.storage?.persist) {
      setPersisted((await navigator.storage.persisted()) || (await navigator.storage.persist()));
    }
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage !== undefined) setUsage(`${(estimate.usage / 1048576).toFixed(0)} MB`);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const loadZip = async (file: File) => {
    setBusy(true);
    setMessage('ZIPを開いています…');
    try {
      // ZIPを丸ごと読み込まず、目次を読んでから中のファイルを1つずつ取り出して保存する
      // (iPhone/iPadは大きなZIPを一度に展開するとメモリ不足でページが落ちるため)。
      const index = await readZipIndex(file);
      const byName = new Map(index.map((entry) => [entry.name, entry]));
      const catalogEntry = byName.get('catalog.json');
      const versionEntry = byName.get('layouts/version.json');
      if (!catalogEntry && !versionEntry) throw new Error('catalog.json がありません。ライブラリのZIPを選んでください。');
      const decode = async (name: string) => JSON.parse(new TextDecoder().decode(await readZipEntry(file, byName.get(name)!)));
      const notes: string[] = [];
      if (catalogEntry) {
        const catalog = (await decode('catalog.json')) as Catalog;
        const names = index.filter((entry) => entry.name.endsWith('.pdf'));
        // 途中で止まった読み込みのやり直しでは、保存済みで大きさの同じPDFは飛ばす。
        const stored = await pdfNames();
        let done = 0;
        for (const entry of names) {
          setMessage(`PDFを保存しています… ${done + 1}/${names.length}`);
          if (!stored.has(entry.name) || !(await sameSize(entry.name, entry.size))) await savePdf(entry.name, await readZipEntry(file, entry));
          done += 1;
        }
        await saveCatalog(catalog);
        notes.push(`${catalog.exams.length}回分を読み込みました。`);
      }
      // Macで作った切り分けデータ。アプリの解析方法の版と同じときだけ使う(違えば問題を開くときに端末で解析する)。
      if (versionEntry) {
        const { version } = (await decode('layouts/version.json')) as { version: string };
        if (version === LAYOUT_VERSION) {
          const layouts = index.filter((entry) => entry.name.startsWith('layouts/') && entry.name !== 'layouts/version.json');
          let saved = 0;
          for (const [k, entry] of layouts.entries()) {
            setMessage(`切り分けデータを保存しています… ${k + 1}/${layouts.length}`);
            const layout = (await decode(entry.name)) as DocLayout;
            saved += await saveLayouts({ [entry.name.slice('layouts/'.length, -'.json'.length)]: layout });
          }
          notes.push(`切り分けデータ(${saved}科目分)を読み込みました。`);
        } else {
          notes.push('切り分けデータはアプリの版と合わないため使いませんでした(問題を開くときに端末で解析します)。');
        }
        if (!catalogEntry && !(await getCatalog())) notes.push('過去問のPDFはまだありません。rikugi-library.zip を読み込んでください。');
      }
      setMessage(notes.join(''));
      await refresh();
    } catch (error) {
      setMessage(`読み込めませんでした: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    const backup = await exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `rikugi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setMessage('学習記録を書き出しました。iCloud Driveなどに保存してください。');
    await refresh();
  };

  const restore = async (file: File) => {
    try {
      await importBackup(JSON.parse(await file.text()));
      setMessage('学習記録を取り込みました。');
    } catch (error) {
      setMessage(`取り込めませんでした: ${(error as Error).message}`);
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>設定</h1>
      </header>

      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}

      {!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) && (
        <p className="notice">
          Safariのまま使うと、しばらく開かなかったときに記録が消えることがあります。共有ボタンから「ホーム画面に追加」して、追加したアイコンから開いてください。
        </p>
      )}

      <section className="setting">
        <h2>過去問ライブラリ</h2>
        <p className="muted">読み込み済み: {examCount}回分{usage ? ` ・ 使用容量 ${usage}` : ''}</p>
        <button type="button" className="btn" disabled={busy} onClick={() => zipInput.current?.click()}>
          ZIPを読み込む
        </button>
        <input
          ref={zipInput}
          data-testid="zip-input"
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void loadZip(file);
            event.target.value = '';
          }}
        />
      </section>

      <section className="setting">
        <h2>学習記録のバックアップ</h2>
        <p className="muted">
          前回の書き出し: {lastBackup ? formatDate(lastBackup) : 'まだありません'}
          <br />
          解答・正答・復習の状況を保存します。別の端末へ移すときにも使えます。
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void download()}>
            書き出す
          </button>
          <button type="button" className="btn" onClick={() => backupInput.current?.click()}>
            取り込む
          </button>
        </div>
        <input
          ref={backupInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void restore(file);
            event.target.value = '';
          }}
        />
      </section>

      <section className="setting">
        <h2>データの保護</h2>
        <p className="muted">
          {persisted === null && 'この端末では確認できません。'}
          {persisted === true && 'ブラウザに永続保存を許可されています。'}
          {persisted === false && '永続保存は許可されていません。定期的に書き出してください。'}
        </p>
      </section>

      <section className="setting">
        <h2>このアプリについて</h2>
        <p className="muted">
          試験問題の著作権は公益財団法人日本無線協会に帰属します。PDFは個人の学習用に端末内にのみ保存し、配布はしていません。
        </p>
      </section>
    </>
  );
}
