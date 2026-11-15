import { inflateSync } from 'fflate';

/**
 * ZIPを丸ごとメモリに載せずに、中のファイルを1つずつ取り出す。
 * iPhone/iPadのSafariは、大きなZIP(80MB超)を全部展開するとメモリ不足でページが落ちるため。
 * 対応するのは無圧縮(0)とdeflate(8)のみ(アプリ用のZIPはこの2つで作る)。
 */
export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const read = async (file: Blob, start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());

export async function readZipIndex(file: Blob): Promise<ZipEntry[]> {
  // 末尾の「中央ディレクトリの終わり」(最大でコメント64KB分)を探す。
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await read(file, tailStart, file.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIPファイルではありません');
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  const dir = await read(file, dirOffset, dirOffset + dirSize);
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (d.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
    const nameLength = d.getUint16(p + 28, true);
    const extraLength = d.getUint16(p + 30, true);
    const commentLength = d.getUint16(p + 32, true);
    entries.push({
      method: d.getUint16(p + 10, true),
      compressedSize: d.getUint32(p + 20, true),
      size: d.getUint32(p + 24, true),
      offset: d.getUint32(p + 42, true),
      name: decoder.decode(dir.subarray(p + 46, p + 46 + nameLength)),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function readZipEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array> {
  const header = await read(file, entry.offset, entry.offset + 30);
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIPの中の ${entry.name} が壊れています`);
  const start = entry.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const data = await read(file, start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.size) });
  throw new Error(`${entry.name} の圧縮方式(${entry.method})には対応していません`);
}
