// Latte print kit — the single source of every printed brand image.
//
// Paper with fibers, flat inks with grain, halftone and slight misregistration, plus the
// canonical marks: the L, the printed app icon and the cup seen from above. Everything that
// "prints" the brand draws through here: the launch splash, the installer sidebar, the large
// app icons and the website plates. A variation is a framing (position, size, crop, timing),
// never a redrawn mark.
//
// This file is the source of truth. latte-web keeps a byte-identical copy in
// public/print-kit.js whose header records this body's hash; its `npm run check` fails if the
// copy drifts. Change it here, then copy it over.
//
// Browser canvas only, no dependencies. Loads as a classic <script> (window.LattePrint) or
// through require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LattePrint = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const INK = '#292a24', RUST = '#aa4e31', SOFT = '#e9c4aa', GREEN = '#293c32', PAPER = '#f6f3ed', FOAM = '#fbf8f1';
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const frac = (v) => v - Math.floor(v);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  /* ---------- press ---------- */

  // Scenes draw in a `unit`-wide coordinate space; the press scales it to the canvas.
  function makePress(w, h, seed, unit = 1000) {
    const rnd = mulberry(seed), k = w / unit;
    const phases = Array.from({ length: 64 }, () => rnd() * TAU);
    const paper = document.createElement('canvas'); paper.width = w; paper.height = h;
    const pc = paper.getContext('2d');
    pc.fillStyle = PAPER; pc.fillRect(0, 0, w, h);
    const img = pc.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 8; d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.9; }
    pc.putImageData(img, 0, 0);
    for (let i = 0; i < (w * h) / 1300; i++) {
      const x = rnd() * w, y = rnd() * h, a = rnd() * TAU, l = 4 + rnd() * w * 0.011;
      pc.strokeStyle = rnd() < 0.8 ? 'rgba(160,150,135,.2)' : 'rgba(170,78,49,.1)';
      pc.lineWidth = 0.6 + rnd() * 0.5;
      pc.beginPath(); pc.moveTo(x, y); pc.quadraticCurveTo(x + Math.cos(a + 1) * l * 0.6, y + Math.sin(a + 1) * l * 0.6, x + Math.cos(a) * l, y + Math.sin(a) * l); pc.stroke();
    }
    // Grain: the spots where ink fails to take.
    const grain = document.createElement('canvas'); grain.width = w + 64; grain.height = h + 64;
    const gc = grain.getContext('2d'), gi = gc.createImageData(w + 64, h + 64), g = gi.data;
    for (let i = 0; i < g.length; i += 4) { const r = rnd(); g[i + 3] = r < 0.15 ? 90 + rnd() * 165 : r < 0.42 ? 28 : 0; }
    gc.putImageData(gi, 0, 0);
    const layer = document.createElement('canvas'); layer.width = w; layer.height = h;
    const lc = layer.getContext('2d');
    const reg = {};
    [INK, RUST, SOFT, GREEN, FOAM].forEach((c) => { reg[c] = [(rnd() - 0.5) * w * 0.0035, (rnd() - 0.5) * w * 0.0035]; });
    return {
      paper,
      noise(u, key, boil) { let s = 0; for (let j = 1; j <= 3; j++) s += Math.sin(u * TAU * (2 * j + 1) + phases[(key * 3 + j) % 64] + boil * 0.9 * j) / j; return s / 1.8; },
      // One ink per call. Dark inks multiply like overprint; light inks knock out, as they would on press.
      ink(ctx, color, fn, { boil = 0, grainAmt = 1, knockout = color === FOAM } = {}) {
        lc.setTransform(1, 0, 0, 1, 0, 0); lc.globalCompositeOperation = 'source-over'; lc.globalAlpha = 1;
        lc.clearRect(0, 0, w, h);
        lc.save(); lc.translate(reg[color][0], reg[color][1]); lc.scale(k, k);
        lc.fillStyle = color; lc.strokeStyle = color; lc.lineCap = 'round'; lc.lineJoin = 'round';
        fn(lc);
        lc.restore();
        lc.globalCompositeOperation = 'destination-out'; lc.globalAlpha = grainAmt;
        lc.drawImage(grain, -((boil * 17) % 64), -((boil * 29) % 64));
        lc.globalCompositeOperation = 'source-over'; lc.globalAlpha = 1;
        ctx.save(); ctx.globalCompositeOperation = knockout ? 'source-over' : 'multiply'; ctx.globalAlpha = knockout ? 1 : 0.94;
        ctx.drawImage(layer, 0, 0); ctx.restore();
      },
    };
  }

  /* ---------- drawing ---------- */

  // A hand-drawn path: parametric fn(u) -> [x, y], nudged by noise that "boils" a few times per second.
  function trace(c, P, fn, { amp = 3, key = 0, boil = 0, from = 0, to = 1, closed = true, n = 160 } = {}) {
    c.beginPath();
    const steps = Math.max(2, Math.round(n * (to - from)));
    for (let i = 0; i <= steps; i++) {
      const u = from + (to - from) * (i / steps), [x, y] = fn(u);
      const px = x + P.noise(u, key, boil) * amp, py = y + P.noise(u, key + 7, boil) * amp;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    if (closed && to - from >= 1) c.closePath();
  }
  const poly = (pts) => (u) => { const n = pts.length, f = u * n, i = Math.floor(f) % n, t = f - Math.floor(f), a = pts[i], b = pts[(i + 1) % n]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
  const ellipse = (cx, cy, rx, ry, rot = 0) => (u) => { const a = u * TAU, x = Math.cos(a) * rx, y = Math.sin(a) * ry; return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; };
  const roundRectFn = (x, y, w, h, r) => (u) => {
    const sx = w - 2 * r, sy = h - 2 * r, q = (Math.PI * r) / 2;
    let d = u * (2 * sx + 2 * sy + 4 * q);
    const edges = [[x + r, y, 1, 0, sx], [x + w, y + r, 0, 1, sy], [x + w - r, y + h, -1, 0, sx], [x, y + h - r, 0, -1, sy]];
    const corners = [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]];
    for (let i = 0; i < 4; i++) {
      const e = edges[i];
      if (d <= e[4]) return [e[0] + e[2] * d, e[1] + e[3] * d];
      d -= e[4];
      if (d <= q) { const [kx, ky, a0] = corners[i], a = a0 + d / r; return [kx + Math.cos(a) * r, ky + Math.sin(a) * r]; }
      d -= q;
    }
    return [x + r, y];
  };

  // Halftone dots inside a clip; tone(x, y) in 0..1 sets each dot's area.
  function halftone(c, clipFn, tone, step, box, angle = 0.26) {
    c.save(); clipFn(); c.clip(); c.beginPath();
    const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2 + step;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let gy = -R; gy <= R; gy += step) {
      for (let gx = -R; gx <= R; gx += step) {
        const x = cx + gx * ca - gy * sa, y = cy + gx * sa + gy * ca;
        if (x < x0 - step || x > x1 + step || y < y0 - step || y > y1 + step) continue;
        const r = Math.sqrt(clamp(tone(x, y))) * step * 0.62;
        if (r > 0.35) { c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); }
      }
    }
    c.fill(); c.restore();
  }

  /* ---------- canonical marks ---------- */

  // The L from the app icon, on its 256 grid.
  const L_PTS = [[56, 96], [104, 57], [104, 152], [201, 152], [160, 198], [56, 198]];
  const lMark = (cx, cy, s) => poly(L_PTS.map(([x, y]) => [cx + (x - 128) * s, cy + (y - 128) * s]));

  // The printed app icon: ink square, rust L with a cream halftone, three wisps of steam (one per agent).
  // `from`/`to` pick the visible stretch of each wisp, so the steam can flow.
  function printedIcon(ctx, P, cx, cy, S, { boil = 0, time = 0, from = () => 0, to = () => 1 } = {}) {
    const k = S / 520, box = [cx - S / 2, cy - S / 2, cx + S / 2, cy + S / 2];
    P.ink(ctx, INK, (c) => { trace(c, P, roundRectFn(cx - S / 2, cy - S / 2, S, S, 96 * k), { amp: 2.5 * k, key: 1, boil, n: 300 }); c.fill(); }, { boil, grainAmt: 0.3 });
    const lm = lMark(cx, cy, 2.03 * k);
    P.ink(ctx, RUST, (c) => { trace(c, P, lm, { amp: 2.5 * k, key: 2, boil, n: 240 }); c.fill(); }, { boil, grainAmt: 0.45, knockout: true });
    P.ink(ctx, SOFT, (c) => halftone(c, () => trace(c, P, lm, { amp: 2.5 * k, key: 2, boil, n: 240 }), (x, y) => smooth(cy + 110 * k, cy - 190 * k, y) * 0.6, 9 * k + 2, box, 0.5), { boil, knockout: true });
    P.ink(ctx, SOFT, (c) => {
      c.lineWidth = 13 * k;
      [0, 1, 2].forEach((i) => {
        const f = (u) => [cx + (20 + 50 * i) * k + Math.sin(u * 6 + time * 1.3 + i * 1.1) * 12 * k * u, cy + 34 * k - u * 190 * k];
        const a = from(i), b = to(i);
        if (b > a) { trace(c, P, f, { amp: 2 * k, key: 30 + i, boil, from: a, to: b, closed: false, n: 40 }); c.stroke(); }
      });
    }, { boil, grainAmt: 0.4, knockout: true });
  }

  // The cup seen from above: foam rim, handle to the right, rust coffee with an ink halftone
  // that darkens toward the rim, and the L in the foam.
  // For animation only: `fill` grows the coffee from the centre, `drawOn` draws the rim and
  // brings in the handle, `lGrow` scales the L. At their defaults the cup is the finished mark.
  function cupFromAbove(ctx, P, cx, cy, R, { boil = 0, lGrow = 1, fill = 1, drawOn = 1 } = {}) {
    const box = [cx - R, cy - R, cx + R, cy + R], rc = R * 0.82, coffee = rc * fill;
    P.ink(ctx, FOAM, (c) => { trace(c, P, ellipse(cx, cy, R, R), { amp: R * 0.008, key: 4, boil }); c.fill(); }, { boil, grainAmt: 0.2 });
    P.ink(ctx, INK, (c) => {
      c.lineWidth = R * 0.03; trace(c, P, ellipse(cx, cy, R, R), { amp: R * 0.008, key: 4, boil, to: drawOn, closed: drawOn >= 1 }); c.stroke();
      c.globalAlpha = smooth(0.5, 1, drawOn);
      c.lineWidth = R * 0.14; c.beginPath(); c.moveTo(cx + R * 1.02, cy); c.lineTo(cx + R * 1.24, cy); c.stroke();
    }, { boil });
    if (fill > 0) {
      P.ink(ctx, RUST, (c) => { trace(c, P, ellipse(cx, cy, coffee, coffee), { amp: R * 0.008, key: 6, boil }); c.fill(); }, { boil });
      P.ink(ctx, INK, (c) => halftone(c, () => { c.beginPath(); c.arc(cx, cy, coffee + 2, 0, TAU); }, (x, y) => smooth(0.6, 1, Math.hypot(x - cx, y - cy) / rc) * 0.7 + 0.04, R * 0.036 + 1, box, 0.6), { boil });
    }
    if (lGrow > 0) P.ink(ctx, FOAM, (c) => { trace(c, P, lMark(cx + R * 0.03, cy + R * 0.015, R * 0.0045 * lGrow), { amp: R * 0.009, key: 3, boil, n: 240 }); c.fill(); }, { boil, grainAmt: 0.3 });
  }

  return {
    colors: { INK, RUST, SOFT, GREEN, PAPER, FOAM },
    TAU, clamp, smooth, lerp, frac, easeOut, easeInOut, mulberry,
    makePress, trace, poly, ellipse, roundRectFn, halftone,
    L_PTS, lMark, printedIcon, cupFromAbove,
  };
});
