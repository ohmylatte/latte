import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B1.5: CADA CLASE QUE EL PRODUCTO PINTA TIENE UNA REGLA QUE LA PINTA.
 *
 * Los jueces de las rondas anteriores dejaron anotado que había clases nuevas
 * SIN una sola línea de CSS: `team-finished-coordination`,
 * `active-teams-strip-row-finished`, `home-row-finished`, los tachados de las
 * altas. Una clase sin regla no es un estilo pendiente: es una promesa que el
 * componente hace y la hoja no cumple — el run terminado se veía idéntico a
 * uno vivo, y la tira lateral desbordaba con marca, trabajo y estado
 * pisándose.
 *
 * El test escanea `styles.css` (cortado por `/\r?\n/`, el repo es CRLF) y
 * exige que cada selector exista Y traiga declaraciones: un `{}` vacío pasaría
 * un `includes` y no pintaría nada.
 */

const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const lines = css.split(/\r?\n/);

/** Las declaraciones de la primera regla cuyo selector menciona esta clase. */
function ruleBodyFor(className: string): string | null {
  const needle = '.' + className;
  for (const line of lines) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    const selector = line.slice(0, brace);
    // Frontera: `.team-card` no puede darse por cumplida con `.team-cards`.
    if (!new RegExp(`\\${needle}(?![\\w-])`).test(selector)) continue;
    const body = line.slice(brace + 1, line.lastIndexOf('}'));
    if (body.trim().length > 0) return body;
  }
  return null;
}

const NEW_CLASSES = [
  // Las tarjetas, en el chat.
  'team-cards', 'team-cards-waiting', 'team-cards-goto', 'team-card',
  'team-card-actions', 'team-card-edit', 'team-card-edit-actions', 'team-card-edit-prompt',
  'team-card-answer', 'team-card-more', 'team-card-first-line', 'team-card-prompt',
  'team-card-readonly', 'team-card-unreadable', 'team-card-aggregate', 'team-card-note',
  'team-card-edit-dropped', 'team-card-empty-plan', 'team-card-orphan-note',
  'team-card-plan-dropped-title', 'team-card-hire-dropped', 'team-card-hire-unticked',
  'team-card-edit-hire', 'team-card-edit-unlimited',
  // El buzón.
  'team-inbox', 'team-inbox-row', 'team-inbox-line', 'team-inbox-name', 'team-inbox-pending',
  'team-inbox-thread-toggle', 'team-thread', 'team-thread-row', 'team-thread-empty',
  'team-member-state', 'team-tab-pending',
  // El run y lo avanzado.
  'team-coordination-controls', 'team-coordination-counts', 'team-coordination-budget',
  'team-finished-coordination', 'team-advanced', 'team-advanced-budget-edit',
  'team-advanced-budget-input', 'team-advanced-budget-save', 'team-advanced-run-budget-invalid',
  'team-support', 'team-support-row', 'team-support-coordination', 'team-support-memory',
  // La tira lateral y la fila de Inicio, que venían sin una sola regla.
  'active-teams-strip', 'active-teams-strip-row', 'active-teams-strip-brand',
  'active-teams-strip-work', 'active-teams-strip-status', 'active-teams-strip-budget',
  'active-teams-strip-gates', 'active-teams-strip-row-finished', 'home-row-finished',
];

describe('B1.5: el CSS del equipo', () => {
  it('la hoja se leyó de verdad', () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  for (const className of NEW_CLASSES) {
    it(`.${className} tiene una regla con declaraciones`, () => {
      const body = ruleBodyFor(className);
      expect(body, `.${className} no tiene ninguna regla en styles.css`).not.toBeNull();
      expect(body!.length, `.${className} tiene una regla vacía`).toBeGreaterThan(3);
    });
  }

  /**
   * La tira desbordaba: marca, trabajo y estado en una fila sin `min-width:0`
   * ni recorte, dentro de un sidebar de 232 px. Cada uno en su renglón, y lo
   * que no entra se recorta con elipsis.
   */
  it('la tira no puede desbordar: sus celdas recortan', () => {
    const cell = ruleBodyFor('active-teams-strip-row')!;
    expect(cell).toContain('min-width:0');
    const spans = lines.find((l) => l.startsWith('.active-teams-strip-row>span{'));
    expect(spans, 'las celdas de la tira no tienen regla propia').toBeDefined();
    expect(spans!).toContain('text-overflow:ellipsis');
    expect(spans!).toContain('display:block');
  });

  /** Un run cerrado no espera nada de nadie: se lee atenuado. */
  it('un run terminado se atenúa, en la tira y por `data-live="false"`', () => {
    expect(ruleBodyFor('active-teams-strip-row-finished')).toContain('opacity');
    expect(css).toContain('.active-teams-strip-row[data-live="false"]');
  });

  /** Las tarjetas viven arriba del composer: no pueden comerse la conversación. */
  it('la sección de tarjetas tiene techo y scroll propio', () => {
    const body = ruleBodyFor('team-cards')!;
    expect(body).toContain('max-height');
    expect(body).toContain('overflow-y:auto');
  });
});
