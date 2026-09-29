import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ronda 4 · EL PULIDO DE IDEAS EN INICIO, EN LA HOJA.
 *
 * jsdom no aplica `styles.css`, así que lo que se VE se prueba donde vive: en
 * el texto del bloque final de la hoja, el que se abre con el marcador
 * `ADN · ideas`. Cada corrección con la regla exacta que la cumple — si alguien
 * la toca, esto se pone rojo en vez de dejarlo pasar como "un detalle de
 * estilo".
 *
 * El bloque se corta por su marcador: nada de lo que está arriba, de otras
 * entregas, puede hacer pasar estas aserciones.
 */
const MARKER = '/* ADN \u00b7 ideas */';
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const start = css.indexOf(MARKER);
const block = start >= 0 ? css.slice(start) : '';

const has = (fragment: string) => expect(block, fragment).toContain(fragment);

describe('las ideas de Inicio — la hoja respeta el encargo', () => {
  it('1 · el título de la tarjeta ocupa hasta 2 líneas y el motivo, una con elipsis', () => {
    has('.home-ideas .home-suggest-text strong{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}');
    has('.home-ideas .home-suggest-text small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}');
  });

  it('2 · las tarjetas de la fila se estiran a la misma altura', () => {
    has('.home-ideas{align-items:stretch}');
    has('.home-ideas .home-suggest{height:100%}');
  });

  it('3 · el encabezado discreto: título sans, --text-sm, --muted, y el botón de 32 px a su derecha', () => {
    has('.home-ideas-head{display:flex;align-items:center;justify-content:flex-start;gap:var(--space-2) var(--space-3);flex-wrap:wrap}');
    has('.home-ideas-title{font-family:var(--sans);font-size:var(--text-sm);color:var(--muted)');
    has('.home-ideas-refresh{margin-top:0;height:var(--control-h-sm);min-height:var(--control-h-sm);display:inline-flex;align-items:center;gap:var(--space-2)}');
  });

  it('4 · el motivo sin IA es una línea sans --muted, nunca mono', () => {
    has('.home-ideas-note{flex-basis:100%;margin:0;font-family:var(--sans);font-size:var(--text-sm);color:var(--muted)}');
    expect(block).not.toContain('.home-ideas-note{font-family:var(--mono)');
    expect(block).not.toContain('letter-spacing:.4px;color:var(--muted)}');
  });

  it('todo sigue saliendo de tokens: ni un color literal en el bloque', () => {
    expect(start, 'falta el bloque `/* ADN · ideas */`').toBeGreaterThan(-1);
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...rules.matchAll(/:([^;}]+)[;}]/g)].map((match) => match[1].trim());
    expect(values.length).toBeGreaterThan(10);
    for (const value of values) expect(value, value).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
