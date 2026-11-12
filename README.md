# 一陸技 過去問

第一級陸上無線技術士の過去問PDFを表示し、マークシートで解答・採点・復習する個人用のPWAです。

試験問題の著作権は公益財団法人日本無線協会に帰属します。PDFはこのリポジトリに含めず(`pdfs/` はGit管理外)、端末内にのみ保存します。公開するのはアプリ本体だけです。

## 開発

```bash
npm install
npm run dev
npm test
npm run build
```

## 過去問ライブラリの作成

```bash
npm run fetch-pdfs
node scripts/import-kema.mjs
node scripts/make-catalog.mjs
npm run build-library
```

できあがる `rikugi-library.zip` を、アプリの「設定 → ZIPを読み込む」で読み込みます。

新しい試験回が出たら `fetch-pdfs` からやり直します。回の判定を直したいファイルは `scripts/catalog-overrides.json` で個別に指定できます(SHAの先頭 → 試験回ID、`"skip"` で除外)。

`scripts/import-kema.mjs` は `pdfs/third-party/kema.zip` を読みます。問題文の抽出は行いません(公式PDFはコピー不可の設定です)。
