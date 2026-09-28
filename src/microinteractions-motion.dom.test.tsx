import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrato de movimiento de la Entrega 4.
 *
 * jsdom no calcula animaciones, así que "con movimiento reducido no hay
 * animación" se prueba donde vive la animación: en la hoja. Cada una de las
 * cinco microinteracciones tiene SU corte en `prefers-reduced-motion`, y el
 * bloque nuevo de la entrega quedó al final del archivo —CSS nuevo después
 * del viejo, para que la cascada se lea en el orden en que se escribió—.
 *
 * Ese "al final" es relativo a CUANDO se escribió: cada entrega cierra la hoja
 * con SU bloque, y la Entrega 4 dejó de ser la última cuando "ADN · interfaz"
 * se agregó detrás. Lo que sigue vigente es que el bloque de la Entrega 4
 * exista, esté una sola vez y que la hoja la cierre el bloque de la última
 * entrega, nunca reglas sueltas apiladas encima.
 */

const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

/** El bloque que agrupa lo nuevo de esta entrega. */
const BLOCK = '/* Entrega 4 · microinteracciones */';
/** El último bloque de entrega agregado a la hoja (las ideas del ADN, ronda 3). */
const LAST_BLOCK = '/* ADN · ideas */';

const GUARD = '@media (prefers-reduced-motion: reduce)';

/** Cada bloque de movimiento reducido, con las llaves balanceadas. */
const reducedGuards = (): string[] => {
  const out: string[] = [];
  for (let at = css.indexOf(GUARD); at !== -1; at = css.indexOf(GUARD, at + 1)) {
    const open = css.indexOf('{', at + GUARD.length);
    let depth = 0;
    let end = css.length - 1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    out.push(css.slice(open + 1, end));
  }
  return out;
};

/** La declaración de `selector` dentro de la media query, o `null` si no corta. */
const reducedRule = (selector: string): string | null =>
  reducedGuards().find(guard => guard.includes(selector + '{')) ?? null;

describe('Entrega 4 — movimiento', () => {
  it('el bloque de la Entrega 4 está entero, y la hoja la cierra la última entrega', () => {
    const at = css.indexOf(BLOCK);
    expect(at, 'falta el bloque comentado `/* Entrega 4 · microinteracciones */`').toBeGreaterThan(-1);
    expect(css.lastIndexOf(BLOCK)).toBe(at);
    const last = css.indexOf(LAST_BLOCK);
    expect(last, 'falta el bloque `/* ADN · ideas */`').toBeGreaterThan(at);
    expect(css.lastIndexOf(LAST_BLOCK)).toBe(last);
    expect(css.length - last, 'el bloque del ADN no cierra la hoja').toBeLessThan(16_000);
  });

  it('M1: la L en la espuma escala 400 ms con el rebote de marca, y se detiene', () => {
    expect(css).toMatch(/\.approval-stamp\{[^}]*animation:stamp-pop var\(--dur-slow\) var\(--ease-brand\)/);
    expect(css).toMatch(/--dur-slow:400ms/);
    expect(css).toMatch(/@keyframes stamp-pop\{from\{transform:scale\(0\)\}to\{transform:scale\(1\)\}\}/);
    expect(reducedRule('.approval-stamp'), 'el sello no se detiene con movimiento reducido').toContain('animation:none');
    // El texto va en la serif de marca, en itálica y en óxido.
    const copy = css.match(/\.approval-badge em\{[^}]*\}/)?.[0] ?? '';
    expect(copy).toContain('font-family:var(--serif)');
    expect(copy).toContain('font-style:italic');
    expect(copy).toContain('color:var(--rust)');
  });

  it('M2: la taza se llena en un loop de 2,6 s y se detiene', () => {
    expect(css).toMatch(/\.loading-cup-coffee\{[^}]*animation:cup-fill 2\.6s/);
    expect(reducedRule('.loading-cup-coffee'), 'la taza no se detiene con movimiento reducido').toContain('animation:none');
  });

  it('M3: el hilo de vapor sube en loop de 1,6 s con stroke-dasharray, y se detiene', () => {
    const wisp = css.match(/\.team-steam path\{[^}]*\}/)?.[0] ?? '';
    expect(wisp, 'el hilo de vapor no tiene regla de trazo').not.toBe('');
    expect(wisp).toContain('stroke-dasharray');
    expect(wisp).toContain('animation:steam-rise 1.6s');
    expect(css).toContain('@keyframes steam-rise');
    expect(reducedRule('.team-steam path'), 'el vapor no se detiene con movimiento reducido').toContain('animation:none');
  });

  it('M4: el anillo se dibuja en 300 ms, se detiene, y las versiones viejas bajan al 35 %', () => {
    expect(css).toMatch(/\.version-ring\.drawing circle\{[^}]*animation:ring-draw \.3s/);
    expect(css).toContain('@keyframes ring-draw');
    expect(reducedRule('.version-ring.drawing circle'), 'el anillo no se detiene con movimiento reducido').toContain('animation:none');
    expect(css).toMatch(/\.version-ring\{[^}]*opacity:\.35/);
    expect(css).toMatch(/\.version-ring\.filled\{opacity:1\}/);
  });

  it('M5: la etapa vacía no se anima: forma y texto, nada más', () => {
    const gap = css.match(/\.funnel-gap\{[^}]*\}/)?.[0] ?? '';
    expect(gap, '.funnel-gap no tiene regla').not.toBe('');
    expect(gap).toContain('border:1.5px dotted var(--rust)');
    expect(gap, 'la etapa vacía no debería animarse').not.toContain('animation');
    const label = css.match(/\.funnel-gap-empty\{[^}]*\}/)?.[0] ?? '';
    expect(label).toContain('font-family:var(--serif)');
    expect(label).toContain('font-style:italic');
    expect(label).toContain('color:var(--rust)');
    const note = css.match(/\.funnel-gap-unattended\{[^}]*\}/)?.[0] ?? '';
    expect(note).toContain('font-family:var(--mono)');
    expect(note).toContain('color:var(--muted)');
    // La segunda aparición: borde punteado de tinta, para que no se lea duplicada.
    const repeat = css.match(/\.funnel-card\.repeat\{[^}]*\}/)?.[0] ?? '';
    expect(repeat).toContain('dotted var(--ink)');
  });

  it('las dos animaciones de una sola vez son cortas: 400 ms y 300 ms', () => {
    expect(css).toMatch(/animation:stamp-pop var\(--dur-slow\)/);
    expect(css).toMatch(/animation:ring-draw \.3s/);
    expect(css).toMatch(/--dur-slow:400ms/);
    // Los otros dos son loops de un estado que sigue existiendo.
    expect(css).toMatch(/animation:steam-rise 1\.6s linear infinite/);
    expect(css).toMatch(/animation:cup-fill 2\.6s ease-in-out infinite/);
  });
});
