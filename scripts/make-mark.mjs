// Genera el SVG maestro de la marca de Latte.
//
// Este archivo es la FUENTE DE VERDAD. Todo lo demás —los PNG del icono, el BMP
// del instalador, la marca del sitio y de la app— se deriva de acá. Antes el
// mismo polígono estaba escrito a mano en cuatro lugares de dos repos, con cinco
// naranjas distintos; esto lo reemplaza por un solo archivo.
//
// La geometría: una L caligráfica trazada con física de plumilla ancha. El ancho
// del trazo es `nibW/2 * |sin(filo - dirección)|`, que es lo que produce el
// contraste grueso/fino de una pluma real. El `floor` evita que el ancho llegue a
// cero cuando la dirección del trazo cruza el ángulo del filo: sin él, el polígono
// se auto-intersecta y queda una muesca visible en el codo a partir de ~200px.
//
// Uso: node make-mark.mjs [destino.svg]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ ajustes */
// La espina de la letra: entrada corta, descenso largo, vuelta redonda, salida
// que se abre. Sin esquinas — una pluma no gira en ángulo recto.
const SPINE = [
  [118, 24], [101, 34], [91, 56], [84, 88], [79, 122], [77, 152],
  [82, 170], [99, 180], [126, 182], [158, 176], [182, 163], [193, 150],
];
const NIB_W = 30;      // ancho nominal de la plumilla
const NIB_DEG = 34;    // ángulo del filo
const FLOOR = 0.25;    // piso de ancho: arregla la muesca del codo
const TAPER = 0.03;    // afinado en los extremos
const PAD = 6;         // respiro alrededor de la letra, en unidades

/* ------------------------------------------------------------------ helpers */
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = dist(pts[i - 1], pts[i]);
    while (carry + seg >= step) {
      const t = (step - carry) / seg;
      ax += (bx - ax) * t; ay += (by - ay) * t;
      out.push([ax, ay]);
      seg = dist([ax, ay], [bx, by]); carry = 0;
    }
    carry += seg;
  }
  if (dist(out[out.length - 1], pts[pts.length - 1]) > step * 0.5) out.push(pts[pts.length - 1]);
  return out;
}

/** Catmull-Rom: una espina genuinamente suave, para que la pluma nunca toque un vértice. */
function crSpline(pts, samples = 300) {
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  const per = Math.ceil(samples / (p.length - 3));
  for (let i = 0; i < p.length - 3; i++) {
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p[i + 1][0]) + (-p[i][0] + p[i + 2][0]) * t +
        (2 * p[i][0] - 5 * p[i + 1][0] + 4 * p[i + 2][0] - p[i + 3][0]) * t2 +
        (-p[i][0] + 3 * p[i + 1][0] - 3 * p[i + 2][0] + p[i + 3][0]) * t3);
      const y = 0.5 * ((2 * p[i + 1][1]) + (-p[i][1] + p[i + 2][1]) * t +
        (2 * p[i][1] - 5 * p[i + 1][1] + 4 * p[i + 2][1] - p[i + 3][1]) * t2 +
        (-p[i][1] + 3 * p[i + 1][1] - 3 * p[i + 2][1] + p[i + 3][1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(p[p.length - 2]);
  return out;
}

function smooth(pts, closed = false) {
  const p = closed ? [...pts, pts[0]] : pts;
  const f = (n) => (Math.round(n * 10) / 10).toString();
  if (p.length < 3) return `M ${p.map((q) => q.map(f).join(' ')).join(' L ')}`;
  let d = `M ${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
    d += `Q${f(p[i][0])} ${f(p[i][1])} ${f(mx)} ${f(my)}`;
  }
  const l = p[p.length - 1];
  d += `L${f(l[0])} ${f(l[1])}`;
  return closed ? `${d}Z` : d;
}

/** Distancia de un punto al segmento ab. */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker. El remuestreo deja decenas de puntos casi colineales que no
 * aportan forma y sí engordan el archivo. Con un epsilon chico se van sin que se
 * note: en un viewBox de ~148 unidades, 0.06 es menos de un milésimo del ancho.
 */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** La pluma ancha. Devuelve el contorno relleno y su caja. */
function nib(spine, nibW, nibDeg, { floor = 0, taperEnds = TAPER, step = 2.8, eps = 0.06 } = {}) {
  const P = resample(crSpline(spine), step);
  const A = (nibDeg * Math.PI) / 180;
  const left = [], right = [];
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const prev = P[Math.max(0, i - 1)], next = P[Math.min(n - 1, i + 1)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const dir = Math.atan2(dy, dx);
    const t = i / (n - 1);
    const inner = Math.max(0.08, Math.min(1, Math.min(t, 1 - t) / taperEnds));
    let hw = (nibW * Math.abs(Math.sin(A - dir))) / 2;
    hw *= inner;
    hw = Math.max(hw, (nibW / 2) * floor * inner);   // <- el piso
    hw = Math.max(0.3, hw);
    left.push([P[i][0] - dy * hw, P[i][1] + dx * hw]);
    right.push([P[i][0] + dy * hw, P[i][1] - dx * hw]);
  }
  // La caja se mide sobre el contorno completo, antes de simplificar.
  const full = [...left, ...right.slice().reverse()];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of full) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // Se simplifican los dos lados por separado para no romper el cierre.
  const ring = [...simplify(left, eps), ...simplify(right, eps).reverse()];
  return { d: smooth([...ring, ring[0]], true), box: [x0, y0, x1 - x0, y1 - y0] };
}

/* -------------------------------------------------------------------- salida */
const L = nib(SPINE, NIB_W, NIB_DEG, { floor: FLOOR });
const vb = [
  (L.box[0] - PAD).toFixed(2),
  (L.box[1] - PAD).toFixed(2),
  (L.box[2] + PAD * 2).toFixed(2),
  (L.box[3] + PAD * 2).toFixed(2),
].join(' ');
const ratio = (L.box[3] + PAD * 2) / (L.box[2] + PAD * 2);

// currentColor: el color lo pone quien lo usa, así la misma marca sirve sobre
// papel, sobre carbón y sobre terracota sin duplicar el archivo.
const svg = `<!-- Marca de Latte. Fuente de verdad: este archivo.
     La geometría se genera con scripts/make-mark.mjs — no la edites a mano.
     currentColor: el color lo define quien la usa. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none" role="img" aria-label="Latte">
  <path d="${L.d}" fill="currentColor"/>
</svg>
`;

const target = process.argv[2] || path.join(dir, 'latte-mark.svg');
fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
fs.writeFileSync(target, svg, 'utf8');

console.log(`latte-mark.svg -> ${target}`);
console.log(`viewBox ${vb}`);
console.log(`relación alto/ancho ${ratio.toFixed(4)}`);
console.log(`tamaño ${(Buffer.byteLength(svg) / 1024).toFixed(2)} KB`);
