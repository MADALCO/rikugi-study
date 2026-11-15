import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { readZipEntry, readZipIndex } from './zipReader';

describe('readZipIndex / readZipEntry', () => {
  it('無圧縮とdeflateのファイルを1つずつ取り出せる', async () => {
    const pdf = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
    const json = new TextEncoder().encode(JSON.stringify({ a: 'あいう'.repeat(500) }));
    const zip = zipSync({ 'catalog.json': json, 'x/a.pdf': [pdf, { level: 0 }], 'layouts/k.json': [json, { level: 6 }] });
    const file = new Blob([zip]);
    const entries = await readZipIndex(file);
    expect(entries.map((e) => e.name).sort()).toEqual(['catalog.json', 'layouts/k.json', 'x/a.pdf']);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(await readZipEntry(file, byName['x/a.pdf'])).toEqual(pdf);
    expect(await readZipEntry(file, byName['layouts/k.json'])).toEqual(json);
    expect(await readZipEntry(file, byName['catalog.json'])).toEqual(json);
  });

  it('ZIPでなければエラー', async () => {
    await expect(readZipIndex(new Blob([new Uint8Array(100)]))).rejects.toThrow('ZIP');
  });
});
