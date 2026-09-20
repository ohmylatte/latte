import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * Los DOS finales del run, en la bitácora. `run_done` ya se dibujaba; un run
 * `cancelled` no tenía entrada de cierre de ninguna clase, así que la última
 * línea que leía la persona era el despacho que quedó a medio camino — se leía
 * como si el equipo siguiera trabajando. Acá se afirman los tres estados
 * posibles de la lista (un despacho suelto, el cierre por terminado, el cierre
 * por cancelado) en los DOS idiomas.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ResumenView } = await import('./ResumenView');
const { EMPTY_USAGE } = await import('../shared/contracts');
import type { ResumenViewProps } from './ResumenView';
import type { Brand, CoordinationLogEntryView, Work } from '../shared/contracts';

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null };
const work: Work = {
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.', folder: null,
  expectedOutput: null, resultPath: null, updatedAt: '2026-09-01T00:00:00.000Z',
};

const base: ResumenViewProps = {
  brand, work, documents: [], decisions: [], states: {}, checking: false,
  team: [], permissions: 'ask', live: false, brandContextDefined: true,
  formatDate: () => 'hace un rato', onOpenBrief: () => {},
};

const dispatch: CoordinationLogEntryView = {
  id: 'log1', taskId: 'task1', memberId: 'm1', status: 'reported',
  createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', settledAt: '2026-09-01T00:01:00.000Z',
};
const runDone: CoordinationLogEntryView = {
  kind: 'run_done', id: 'run-done:r1', runId: 'r1', tasksDone: 2, tasksFailed: 1, createdAt: '2026-09-01T00:02:00.000Z',
};
const runCancelled: CoordinationLogEntryView = {
  // U9: las tres cuentas separadas. `tasksPending` ya no se traga las
  // `failed`: una tarea que se intento y no salio no es una que nunca empezo.
  kind: 'run_cancelled', id: 'run-cancelled:r1', runId: 'r1', tasksDone: 2, tasksFailed: 1, tasksPending: 3, createdAt: '2026-09-01T00:02:00.000Z',
};

function render(locale: 'es-AR' | 'en-US', log: CoordinationLogEntryView[]): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(ResumenView, { ...base, coordinationLog: log }));
}

/** Las filas de la bitácora, en el orden en que se dibujan. */
function rows(html: string): string[] {
  const matches = [...html.matchAll(/<li class="resumen-bitacora-row">(.*?)<\/li>/gs)].map((m) => m[1]);
  // El largo primero: sin filas, cualquier aserción `not.toContain` de abajo
  // pasaría por vacío sin haber mirado un solo renglón.
  expect(matches.length).toBeGreaterThan(0);
  return matches;
}

describe('la bitácora dibuja los DOS finales del run, no sólo el feliz', () => {
  it('un run cancelado cierra con su propia línea, en castellano', () => {
    const html = render('es-AR', [dispatch, runCancelled]);
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('Se canceló la coordinación: 2 tareas listas, 1 fallidas, 3 sin empezar');
    // Nunca la del otro final: cancelar no es terminar.
    expect(html).not.toContain('El equipo terminó');
  });

  it('un run cancelado cierra con su propia línea, en inglés', () => {
    const html = render('en-US', [dispatch, runCancelled]);
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain('Coordination was cancelled: 2 tasks done, 1 failed, 3 never started');
    expect(html).not.toContain('The team finished');
    // Y nada quedó en castellano.
    expect(html).not.toContain('Se canceló');
  });

  it('un run terminado sigue cerrando con `run_done`, en los dos idiomas', () => {
    const es = render('es-AR', [dispatch, runDone]);
    expect(rows(es)).toHaveLength(2);
    expect(es).toContain('El equipo terminó: 2 tareas listas, 1 fallidas');
    expect(es).not.toContain('Se canceló la coordinación');

    const en = render('en-US', [dispatch, runDone]);
    expect(en).toContain('The team finished: 2 tasks done, 1 failed');
    expect(en).not.toContain('Coordination was cancelled');
  });

  it('un run vivo no dibuja ninguna línea de cierre: sólo sus despachos', () => {
    const html = render('es-AR', [dispatch]);
    expect(rows(html)).toHaveLength(1);
    expect(html).not.toContain('El equipo terminó');
    expect(html).not.toContain('Se canceló la coordinación');
  });

  it('la línea de cierre por cancelación no ofrece los botones de liquidar: no hay nada en vuelo que liquidar', () => {
    const html = renderToStaticMarkup(createElement(ResumenView, {
      ...base, coordinationLog: [runCancelled], onSettleDispatch: () => {},
    }));
    expect(html).toContain('resumen-bitacora-row');
    expect(html).not.toContain('resumen-bitacora-settle');
  });
});

/** El contrato de la fila: nada de esto se guarda, todo se deriva. */
describe('bitacoraRows traduce la entrada derivada sin inventar nada', () => {
  it('mapea `run_cancelled` a una fila `runCancelled` con sus TRES cuentas', async () => {
    const { bitacoraRows } = await import('./resumen-summary');
    const out = bitacoraRows([runCancelled], []);
    expect(out).toEqual([{ kind: 'runCancelled', id: 'run-cancelled:r1', tasksDone: 2, tasksFailed: 1, tasksPending: 3, at: '2026-09-01T00:02:00.000Z' }]);
  });

  it('ordena el cierre por cancelación después de los despachos, como cualquier otra fila', async () => {
    const { bitacoraRows } = await import('./resumen-summary');
    const out = bitacoraRows([runCancelled, dispatch], []);
    expect(out.map((r) => r.kind)).toEqual(['dispatch', 'runCancelled']);
  });
});

// `EMPTY_USAGE` se importa por el mismo motivo que en los otros tests de esta
// vista: mantener el módulo de contratos cargado antes que el componente.
void EMPTY_USAGE;
