import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La línea "Plan aprobado · el equipo trabaja" es UNA línea, no una tarjeta.
 *
 * `.team-card` apila en columna y centra; `.coord-approved` declaraba
 * `display:flex` sin `flex-direction`, así que heredaba la columna: el ícono
 * arriba, el texto en el medio, la hora, y "Ver equipo" abajo, adentro de un
 * segundo marco con relleno. Ocupaba el alto de cuatro renglones entre el
 * chat y el cuadro de texto, y no decía nada que una línea no diga.
 */
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const lines = css.split(/\r?\n/);

function ruleBodyFor(selector: string): string | null {
  for (const line of lines) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    if (line.slice(0, brace).trim() === selector) return line.slice(brace + 1, line.indexOf('}', brace));
  }
  return null;
}

describe('la línea de plan aprobado', () => {
  it('se dibuja en fila, con el texto a la izquierda', () => {
    const body = ruleBodyFor('.team-card.coord-approved');
    expect(body).not.toBeNull();
    expect(body).toContain('flex-direction:row');
    expect(body).toContain('align-items:center');
    expect(body).toContain('text-align:left');
  });

  it('no lleva un segundo marco alrededor', () => {
    const body = ruleBodyFor('.team-cards-approved');
    expect(body).not.toBeNull();
    expect(body).toContain('padding:0');
    expect(body).toContain('border:0');
    expect(body).toContain('background:none');
  });
});
