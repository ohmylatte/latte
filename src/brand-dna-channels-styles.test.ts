import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * OTROS CANALES — el contrato de estilo en la hoja.
 *
 * jsdom no aplica `styles.css`, así que lo que se VE se prueba donde vive: en
 * el texto del bloque `ADN · canales`, el que cierra la hoja. Cada regla con la
 * corrección exacta que cumple — si alguien la toca, esto se pone rojo en vez
 * de dejarlo pasar como "un detalle de estilo".
 *
 * El bloque se corta por su marcador: nada de lo que está arriba, de otras
 * entregas, puede hacer pasar estas aserciones.
 */
const MARKER = '/* ADN · canales */';
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const start = css.indexOf(MARKER);
const block = start >= 0 ? css.slice(start) : '';

const has = (fragment: string) => expect(block, fragment).toContain(fragment);

describe('otros canales — la hoja respeta el encargo', () => {
  it('el bloque existe una sola vez y cierra la hoja', () => {
    expect(start, 'falta el bloque `/* ADN · canales */`').toBeGreaterThan(-1);
    expect(css.lastIndexOf(MARKER)).toBe(start);
    expect(css.trimEnd().endsWith('}'), 'el bloque cierra la hoja').toBe(true);
  });

  it('1 — el campo es de varios renglones y la tarjeta toma el ancho de la grilla, debajo de web y archivos', () => {
    has('.dna-source-card.is-channels{grid-column:1/-1;order:3}');
    has('.dna-source-grid{grid-template-columns:repeat(2,minmax(0,1fr))}');
    has('.dna-channels{width:100%;min-height:96px');
    has('resize:vertical');
  });

  it('2 — cada canal es una fila con el nombre propio, el link y su ícono', () => {
    has('.dna-channel-list{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding:0;list-style:none}');
    has('.dna-channel-row{display:flex;align-items:center;gap:var(--space-2);min-width:0');
    has('.dna-channel-name{font-family:var(--mono);flex-shrink:0');
    has('.dna-channel-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;');
  });

  it('3 — lo que no entra se ve distinto de lo que entra', () => {
    has('.dna-channel-invalid .dna-channel-name{color:var(--danger)}');
    has('.dna-channels-note{margin:0;font-size:var(--text-sm);color:var(--muted)}');
  });

  it('todo sigue saliendo de tokens: ni un color literal en el bloque', () => {
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const values = [...rules.matchAll(/:([^;}]+)[;}]/g)].map((match) => match[1].trim());
    expect(values.length).toBeGreaterThan(8);
    for (const value of values) expect(value, value).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
