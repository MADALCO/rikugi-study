// マークシートの楕円をモチーフにしたアプリアイコン(PNG)を外部ライブラリなしで生成する。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAPER = [250, 247, 242];
const VERMILION = [200, 69, 47];
const GRAPHITE = [43, 42, 40];
const SAMPLES = 4;

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 3つの楕円のうち中央だけを塗りつぶし、「マークした」状態を表す。
function colorAt(u, v) {
  const centers = [0.2, 0.5, 0.8];
  for (let i = 0; i < centers.length; i++) {
    const dx = (u - centers[i]) / 0.11;
    const dy = (v - 0.5) / 0.26;
    const radius = dx * dx + dy * dy;
    if (i === 1 && radius <= 1) return GRAPHITE;
    if (radius <= 1 && radius >= 0.62) return VERMILION;
  }
  return PAPER;
}

function png(size) {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      const total = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = colorAt((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size);
          color.forEach((value, channel) => (total[channel] += value));
        }
      }
      total.forEach((value, channel) => {
        raw[y * row + 1 + x * 3 + channel] = Math.round(value / (SAMPLES * SAMPLES));
      });
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(join(root, 'public'), { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(join(root, 'public', `icon-${size}.png`), png(size));
}
