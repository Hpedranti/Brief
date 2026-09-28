// Rasterize the Brief mark (docs/icon.svg) into PNGs with zero dependencies.
// Writes docs/icon-192.png, docs/icon-512.png, docs/apple-touch-icon.png (180px).
// Usage: node job/make-icons.mjs
//
// Geometry lives in a 100x100 unit space, mirroring icon.svg. Shapes are rounded
// rectangles rendered with 4x4 supersampling for anti-aliased edges.

import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const BLACK = [0x0b, 0x0b, 0x0d];
const LIME = [0xa6, 0xff, 0x00];

// Bars: x, y, w, h, r (units of 100). Matches icon.svg.
const BARS = [
  [26, 29, 48, 11, 5.5],
  [26, 45, 35, 11, 5.5],
  [26, 61, 22, 11, 5.5],
];

// Signed-distance-ish inside test for a rounded rectangle.
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(size, { cornerRadius }) {
  const px = new Uint8Array(size * size * 4);
  const S = 4; // supersamples per axis
  const k = 100 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bgCov = 0;
      let limeCov = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const u = (i + (si + 0.5) / S) * k;
          const v = (j + (sj + 0.5) / S) * k;
          if (cornerRadius <= 0 || inRoundRect(u, v, 0, 0, 100, 100, cornerRadius)) {
            bgCov++;
            if (BARS.some((b) => inRoundRect(u, v, ...b))) limeCov++;
          }
        }
      }
      const n = S * S;
      const a = bgCov / n;
      const t = bgCov ? limeCov / bgCov : 0; // lime share within the covered area
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BLACK[c] * (1 - t) + LIME[c] * t);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ---------- PNG encoder ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- write + verify ----------

const OUT = [
  // Manifest icons double as maskable, so keep them full-bleed: the OS applies its own mask.
  { file: 'icon-192.png', size: 192, cornerRadius: 0 },
  { file: 'icon-512.png', size: 512, cornerRadius: 0 },
  // iOS rounds home-screen icons itself; transparent corners would render black anyway.
  { file: 'apple-touch-icon.png', size: 180, cornerRadius: 0 },
];

for (const { file, size, cornerRadius } of OUT) {
  const path = join(DOCS, file);
  writeFileSync(path, encodePNG(size, render(size, { cornerRadius })));
  const back = readFileSync(path);
  const sigOK = back.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = back.readUInt32BE(16);
  const h = back.readUInt32BE(20);
  if (!sigOK || back.toString('ascii', 12, 16) !== 'IHDR' || w !== size || h !== size) {
    console.error(`FAIL ${file}: sig=${sigOK} ${w}x${h}`);
    process.exit(1);
  }
  console.log(`ok ${file} ${w}x${h} ${back.length} bytes`);
}
