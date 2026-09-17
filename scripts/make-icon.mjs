// Draws the small, flat sizes of the Latte mark and assembles the Windows .ico, with no
// image dependency: rasterised by hand and compressed with Node's own zlib.
//
// The mark prints differently by size, the way a real print would:
// - print (256px and up): made by scripts/make-print-icons.cjs with the canonical icon of
//   assets/brand/print-kit.js (grain, halftone, steam). Run it first; this script reads its 256.
// - steam (48–128px): flat inks plus the three wisps of steam.
// - flat (below 48px): the L alone. Taskbar, tabs, favicon. Texture there is only noise.
//
// Geometry and colours match the kit's printedIcon: corner radius 96/520, L inset 0.22,
// the same steam curve and width. Windows picks one image per size from the .ico, so each
// size is drawn on its own instead of downscaling the printed 256.
//
// Usage: npm run assets:icons (prints the large sizes, then runs this)
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The wordmark's L, as fractions of the box: same polygon as the CSS clip-path and the kit's L. */
const MARK = [[0, 0.28], [0.33, 0], [0.33, 0.72], [1, 0.72], [0.72, 1], [0, 1]];
const INSET = 0.22;
const RADIUS = 96 / 520;
const BACKGROUND = [41, 42, 36];     // #292a24, the kit's ink
const MARK_COLOR = [170, 78, 49];    // #aa4e31, the brand rust
const CREAM = [233, 196, 170];       // #e9c4aa, steam

/** Three wisps of steam rise from the foot of the L, one per agent: the kit's curve at time 0.8. */
const STEAM_WIDTH = 13 / 520;
const STEAM = [0, 1, 2].map((i) => Array.from({ length: 25 }, (_, step) => {
  const u = step / 24;
  return [(280 + 50 * i + Math.sin(u * 6 + 0.8 * 1.3 + i * 1.1) * 12 * u) / 520, (294 - 190 * u) / 520];
}));

const clamp = (value) => Math.max(0, Math.min(1, value));
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

function insidePolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function inSteam(x, y) {
  if (x < 0.5 || x > 0.79 || y < 0.17 || y > 0.6) return false;
  return STEAM.some((wisp) => wisp.some((point, i) => i > 0 && distanceToSegment(x, y, wisp[i - 1], point) <= STEAM_WIDTH / 2));
}

/** 4x supersampled coverage of the L and the steam, for one pixel. */
function sample(px, py, size, steam) {
  let mark = 0, wisps = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const x = (px + (sx + 0.5) / 4) / size;
      const y = (py + (sy + 0.5) / 4) / size;
      const mx = (x - INSET) / (1 - 2 * INSET);
      const my = (y - INSET) / (1 - 2 * INSET);
      if (mx >= 0 && mx <= 1 && my >= 0 && my <= 1 && insidePolygon(MARK, mx, my)) mark += 1;
      if (steam && inSteam(x, y)) wisps += 1;
    }
  }
  return { mark: mark / 16, steam: wisps / 16 };
}

function roundedCorner(px, py, size, radius) {
  const corners = [[radius, radius], [size - radius, radius], [radius, size - radius], [size - radius, size - radius]];
  const x = px + 0.5;
  const y = py + 0.5;
  const outside = (x < radius || x > size - radius) && (y < radius || y > size - radius);
  if (!outside) return 1;
  const [cx, cy] = corners.find(([ax, ay]) => Math.abs(x - ax) < radius && Math.abs(y - ay) < radius) ?? [];
  if (cx === undefined) return 1;
  return clamp(radius - Math.hypot(x - cx, y - cy) + 0.5);
}

const styleFor = (size) => (size >= 256 ? 'print' : size >= 48 ? 'steam' : 'flat');

function renderIcon(size, { transparent = false } = {}) {
  const steamOn = !transparent && styleFor(size) === 'steam';
  const radius = size * RADIUS;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const { mark, steam } = sample(x, y, size, steamOn);
      const rgb = mix(mix(transparent ? MARK_COLOR : BACKGROUND, MARK_COLOR, mark), CREAM, steam);
      const alphaBase = transparent ? 0 : 255;
      const alpha = Math.round((alphaBase + (255 - alphaBase) * Math.max(mark, steam)) * roundedCorner(x, y, size, radius));
      const at = 1 + x * 4;
      row[at] = Math.round(rgb[0]);
      row[at + 1] = Math.round(rgb[1]);
      row[at + 2] = Math.round(rgb[2]);
      row[at + 3] = alpha;
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function png(size, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico is a 6-byte header, a 16-byte entry per image, then the images; PNG entries are valid since Vista. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([size, data]) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);  // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, data]) => data)]);
}

function write(file, data, note) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  console.log(`${file}  ${note}  ${data.length} bytes`);
}

const printed256 = path.join(root, 'assets', 'icon-256.png');
if (!fs.existsSync(printed256)) {
  console.error('assets/icon-256.png is missing: run scripts/make-print-icons.cjs first.');
  process.exit(1);
}

write('assets/icon-64.png', renderIcon(64), '64x64 steam');
write('assets/favicon.png', renderIcon(64, { transparent: true }), '64x64 flat');

const icoSizes = [16, 24, 32, 48, 64, 128];
const layers = icoSizes.map((size) => [size, renderIcon(size)]);
layers.push([256, fs.readFileSync(printed256)]);
write('assets/icon.ico', ico(layers), [...icoSizes, 256].map((size) => `${size}:${styleFor(size)}`).join(' '));
