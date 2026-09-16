// Draws the Latte mark into PNG files, with no image dependency.
//
// The shape is no longer a polygon written here by hand: it is the master SVG in
// assets/latte-mark.svg. This file flattens that path's quadratic curves into a
// polygon and rasterises it with the same 4x supersampling it always used, then
// compresses with Node's own zlib. One source of truth, zero new dependencies.
//
// Usage: node scripts/make-icon.mjs

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SVG_FILE = path.join(root, 'assets', 'latte-mark.svg');
const BACKGROUND = [40, 37, 31];        // --dark
const ACCENT = [183, 85, 52];           // --accent, #b75534
// El tile es oscuro, asi que la marca usa el tinte claro: el acento puro sobre
// carbon queda por debajo del contraste minimo. El favicon es transparente y se
// ve sobre fondos claros, asi que se queda con el acento primario.
const ACCENT_ON_DARK = [210, 125, 96];  // --accent-on-dark, #d27d60
const CORNER = 0.22;                   // rounded tile, as a fraction of the side
const INSET = 0.22;                    // breathing room around the mark

/* ------------------------------------------------------------- the SVG path */

/**
 * Flattens an SVG path of M/L/Q/Z into a polygon.
 * Q segments are sampled; that is all this mark uses, so nothing else is handled.
 */
function flattenPath(d, steps = 8) {
  const tokens = d.match(/[MLQZmlqz]|-?\d*\.?\d+/g) ?? [];
  const pts = [];
  let i = 0;
  let cmd = null;
  let cur = [0, 0];
  const num = () => Number.parseFloat(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[MLQZmlqz]$/.test(token)) { cmd = token; i += 1; continue; }

    if (cmd === 'M' || cmd === 'm') {
      cur = [num(), num()];
      pts.push(cur);
      cmd = 'L';                       // later coordinate pairs are implicit lineto
    } else if (cmd === 'L' || cmd === 'l') {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === 'Q' || cmd === 'q') {
      const cx = num();
      const cy = num();
      const x = num();
      const y = num();
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps;
        const m = 1 - t;
        pts.push([
          m * m * cur[0] + 2 * m * t * cx + t * t * x,
          m * m * cur[1] + 2 * m * t * cy + t * t * y,
        ]);
      }
      cur = [x, y];
    } else if (cmd === 'Z' || cmd === 'z') {
      cmd = null;
    } else {
      i += 1;
    }
  }
  return pts;
}

/** Reads the master SVG and returns its outline normalised to the 0..1 box. */
function loadMark() {
  const svg = fs.readFileSync(SVG_FILE, 'utf8');
  const vb = svg.match(/viewBox="([^"]+)"/);
  if (!vb) throw new Error(`${SVG_FILE} has no viewBox`);
  const [vx, vy, vw, vh] = vb[1].trim().split(/\s+/).map(Number);

  const d = svg.match(/\sd="([^"]+)"/);
  if (!d) throw new Error(`${SVG_FILE} has no path`);

  const pts = flattenPath(d[1]).map(([x, y]) => [(x - vx) / vw, (y - vy) / vh]);

  // The icon is square, so the mark is fitted by its longest side and centred.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const scale = 1 / Math.max(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return pts.map(([x, y]) => [(x - cx) * scale + 0.5, (y - cy) * scale + 0.5]);
}

/* ---------------------------------------------------------------- rasteriser */

function insidePolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 4x supersampling: the curves need it or they look ragged. */
function coverage(polygon, px, py, size, inset) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const x = ((px + (sx + 0.5) / 4) / size - inset) / (1 - 2 * inset);
      const y = ((py + (sy + 0.5) / 4) / size - inset) / (1 - 2 * inset);
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && insidePolygon(polygon, x, y)) hits += 1;
    }
  }
  return hits / 16;
}

function roundedCorner(px, py, size, radius) {
  const corners = [[radius, radius], [size - radius, radius], [radius, size - radius], [size - radius, size - radius]];
  const x = px + 0.5;
  const y = py + 0.5;
  const outside = (x < radius || x > size - radius) && (y < radius || y > size - radius);
  if (!outside) return 1;
  const [cx, cy] = corners.find(([ax, ay]) => Math.abs(x - ax) < radius && Math.abs(y - ay) < radius) ?? [];
  if (cx === undefined) return 1;
  return Math.max(0, Math.min(1, radius - Math.hypot(x - cx, y - cy) + 0.5));
}

function renderIcon(polygon, size, { transparent = false } = {}) {
  const radius = Math.round(size * CORNER);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const mark = coverage(polygon, x, y, size, INSET);
      const ink = transparent ? ACCENT : ACCENT_ON_DARK;
      const base = transparent ? ACCENT : BACKGROUND;
      const alphaBase = transparent ? 0 : 255;
      const rgb = base.map((c, i) => Math.round(c + (ink[i] - c) * mark));
      const alpha = Math.round((alphaBase + (255 - alphaBase) * mark) * roundedCorner(x, y, size, radius));
      const at = 1 + x * 4;
      row[at] = rgb[0];
      row[at + 1] = rgb[1];
      row[at + 2] = rgb[2];
      row[at + 3] = alpha;
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

/* -------------------------------------------------------------- PNG encoder */

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

/* --------------------------------------------------------------------- run */

const polygon = loadMark();
console.log(`[icon] ${path.relative(root, SVG_FILE)} -> ${polygon.length} points`);

const targets = [
  ['assets/icon-512.png', 512, {}],
  ['assets/icon-256.png', 256, {}],
  ['assets/icon-64.png', 64, {}],
  ['assets/favicon.png', 64, { transparent: true }],
];
for (const [file, size, options] of targets) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderIcon(polygon, size, options));
  console.log(`${file}  ${size}x${size}  ${fs.statSync(target).size} bytes`);
}
