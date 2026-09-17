// Printed launch splash. The cup is the canonical mark from brand/print-kit.js; this file
// only frames and times it: the pour, the cup filling, the L in the foam, three wisps of
// steam, the name and the real start-up stage reported by electron/splash.ts.
(() => {
  const K = window.LattePrint;
  const canvas = document.getElementById('splash');
  if (!K || !canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { INK, RUST, SOFT, GREEN } = K.colors;
  const { clamp, smooth, easeOut } = K;
  const params = new URLSearchParams(location.search);
  const COPY = {
    es: { data: 'ABRIENDO TUS MARCAS…', interface: 'PREPARANDO TU ESPACIO…', ready: 'LISTO.' },
    en: { data: 'OPENING YOUR BRANDS…', interface: 'PREPARING YOUR WORKSPACE…', ready: 'READY.' },
  }[params.get('lang') === 'en' ? 'en' : 'es'];
  const VERSION = (params.get('v') || '').replace(/[^\w.-]/g, '');
  const SERIF = '"Latte Serif", Georgia, serif';
  const MONO = 'Consolas, Menlo, "DejaVu Sans Mono", monospace';
  const easeBack = (t) => 1 + 2.9 * Math.pow(t - 1, 3) + 1.9 * Math.pow(t - 1, 2);
  const text = (c, s, x, y, font, align = 'center') => { c.font = font; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(s, x, y); };

  const P = K.makePress(W, H, 42, W);
  const CX = 330, CY = 300, R = 150;
  const INTRO_S = 1.6;

  let stage = 'data', stageAt = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();

  // `t` walks the intro from 0 to 0.7 and stays there; `time` keeps the steam alive.
  function frame(t, time) {
    const boil = reduce ? 0 : Math.floor(time * 6);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.drawImage(P.paper, 0, 0);

    // The cup: rim draws on, coffee fills from the centre (your brands open), the L bounces into the foam.
    K.cupFromAbove(ctx, P, CX, CY, R, {
      boil,
      drawOn: easeOut(clamp(t / 0.12)),
      fill: easeOut(smooth(0.08, 0.34, t)),
      lGrow: easeBack(smooth(0.36, 0.5, t)),
    });

    // The pour lands in the middle and narrows as it falls, like the funnel.
    const pour = smooth(0, 0.06, t) * (1 - smooth(0.3, 0.36, t));
    if (pour > 0) P.ink(ctx, SOFT, (c) => {
      const w = (y) => (30 - 20 * (y / CY)) * pour;
      c.beginPath();
      for (let y = 0; y <= CY; y += 8) c.lineTo(CX - w(y) / 2 + Math.sin(y * 0.03 + time * 4) * 3, y);
      for (let y = CY; y >= 0; y -= 8) c.lineTo(CX + w(y) / 2 + Math.sin(y * 0.03 + time * 4) * 3, y);
      c.fill();
    }, { boil, knockout: true });

    // Three wisps, one per agent, rising off the rim.
    [[RUST, -46], [GREEN, 0], [INK, 46]].forEach(([color, dx], i) => {
      const k = smooth(0.46 + i * 0.03, 0.62 + i * 0.03, t);
      if (k <= 0) return;
      const head = easeOut(k), flow = reduce ? 0 : ((time * 0.35 + i * 0.2) % 1) * 0.2;
      P.ink(ctx, color, (c) => {
        c.lineWidth = 8;
        K.trace(c, P, (u) => [CX + dx + Math.sin(u * 6 + time * 1.4 + i * 2) * 11 * u, CY - R - 16 - u * 110], { amp: 1.5, key: 20 + i, boil, from: flow * head, to: Math.max(flow * head + 0.05, head), closed: false, n: 50 });
        c.stroke();
      }, { boil, grainAmt: 0.45 });
    });

    // The name, in two inks slightly out of register.
    const wk = smooth(0.56, 0.68, t);
    if (wk > 0) {
      P.ink(ctx, RUST, (c) => { c.globalAlpha = wk; text(c, 'latte', 703, 302, `italic 400 104px ${SERIF}`); }, { boil });
      P.ink(ctx, INK, (c) => { c.globalAlpha = wk; text(c, 'latte', 700, 299, `italic 400 104px ${SERIF}`); }, { boil, grainAmt: 0.6 });
    }
    P.ink(ctx, INK, (c) => {
      c.globalAlpha = reduce ? 1 : clamp((performance.now() - stageAt) / 250);
      if (stage === 'ready') c.fillStyle = GREEN;
      text(c, COPY[stage], W / 2, 530, `600 15px ${MONO}`);
      c.fillStyle = INK; c.globalAlpha = 0.6;
      text(c, 'OH MY LATTE', 28, 574, `600 12px ${MONO}`, 'left');
    }, { boil, grainAmt: 0.3 });
    if (VERSION) P.ink(ctx, RUST, (c) => text(c, VERSION, W - 28, 574, `600 12px ${MONO}`, 'right'), { boil, grainAmt: 0.3 });
  }

  // Called by electron/splash.ts with 'data' | 'interface' | 'ready'.
  window.latteSplash = (next) => {
    if (!(next in COPY) || next === stage) return;
    stage = next;
    stageAt = performance.now();
    if (reduce) frame(0.7, 0);
  };

  let last = 0;
  function loop(now) {
    if (now - last > 33) {
      const time = (now - started) / 1000;
      frame(Math.min(1, time / INTRO_S) * 0.7, time);
      last = now;
    }
    requestAnimationFrame(loop);
  }
  if (reduce) {
    frame(0.7, 0);
    document.fonts.ready.then(() => frame(0.7, 0));
  } else {
    requestAnimationFrame(loop);
  }
})();
