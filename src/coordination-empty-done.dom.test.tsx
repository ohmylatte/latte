import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * C5: EL VACÍO TIENE PROPÓSITO, Y LO TERMINADO TIENE QUÉ MOSTRAR.
 *
 * Criterio 6: o la pantalla muestra algo entero, o dice qué hacer. Nunca un
 * titular con una sola línea gris debajo.
 *
 * Y el límite honesto queda anotado acá, en un test: el modelo de datos NO
 * tiene una lista de archivos producidos. Lo único que el motor guarda de un
 * reporte es su resumen. Así que "Lo que produjo el equipo" muestra resúmenes,
 * y una ficha de archivo sólo cuando el resumen NOMBRA uno.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
const { outcomeRows } = await import('./coordination/TeamOutcome');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Piezas para el primer encendido', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Asistente'), member('cm', 'Community Manager'), member('paid', 'Paid Media')];

const done: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'done', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: false, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '2026-09-13T19:32:00.000Z', lastEventAt: '',
  tasksDone: 4, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};

const dispatchRow = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'paid', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Piezas publicitarias Meta', summaryPreview: '14 piezas numeradas, en piezas-para-produccion-cm.md',
  createdAt: '2026-09-13T17:18:00.000Z', startedAt: '2026-09-13T17:18:00.000Z', settledAt: '2026-09-13T17:48:00.000Z', ...patch,
});

const mount = (props: Partial<TeamViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamView, {
    work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: null, onSelectMember: () => {},
    // H2: lo producido caduca a las 24 h del cierre; estos tests miran el run
    // la misma noche en que terminó.
    formatTime: (v: string) => v, formatDate: (v: string) => v, now: Date.parse('2026-09-13T20:00:00.000Z'), ...props,
  }));
};

describe('C5: sin run, el panel derecho dice qué hacer', () => {
  it('ícono, frase en serif, explicación, ejemplo y una acción', () => {
    const { container } = mount({ coordinatorGrant: 'coord', onNewRequest: () => {} });
    const empty = container.querySelector('.coord-empty')!;
    expect(empty.querySelector('.coord-empty-title')!.textContent).toBe('El equipo trabaja cuando se lo pedís.');
    expect(empty.querySelector('.coord-empty-body')!.textContent).toContain('Asistente');
    expect(empty.querySelector('.coord-empty-example')!.textContent).toBe('Coordiná al equipo y preparen el contenido del mes');
    expect(empty.querySelector('.coord-empty-action')!.textContent).toBe('Pedirlo en el chat');
  });

  it('sin coordinador nombrado no se inventa un nombre', () => {
    const { container } = mount({ onNewRequest: () => {} });
    expect(container.querySelector('.coord-empty-body')!.textContent).not.toContain('undefined');
    expect(container.querySelector('.coord-empty-body')!.textContent).toContain('Sumá a alguien');
  });

  it('"Pedirlo en el chat" llama a quien abre esa conversación', () => {
    const onNewRequest = vi.fn();
    const { container } = mount({ onNewRequest });
    fireEvent.click(container.querySelector('.coord-empty-action')!);
    expect(onNewRequest).toHaveBeenCalled();
  });

  it('sin handler no se ofrece un botón que no lleva a ningún lado', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-empty')).not.toBeNull();
    expect(container.querySelector('.coord-empty-action')).toBeNull();
  });

  /** La lista sigue teniendo la anatomía, y "Sumar un rol" es una fila más. */
  it('"Sumar un rol" es una fila con la misma anatomía, y abre el alta que ya existe', () => {
    const onAddMember = vi.fn();
    const { container } = mount({ onAddMember });
    const row = container.querySelector('.coord-add-row .coord-row')!;
    expect(row.querySelector('.coord-av')).not.toBeNull();
    expect(row.querySelector('.coord-row-name')!.textContent).toBe('Sumar un rol');
    fireEvent.click(row);
    expect(onAddMember).toHaveBeenCalled();
  });

  it('sin handler la fila no se ofrece', () => {
    const { container } = mount();
    expect(container.querySelector('.coord-add-row')).toBeNull();
  });

  /** Abrir a un miembro es una decisión de la persona: el vacío no se la tapa. */
  it('con un miembro abierto manda el detalle, no la bienvenida', () => {
    const { container } = mount({ selectedMemberId: 'cm' });
    expect(container.querySelector('.coord-empty')).toBeNull();
    expect(container.querySelector('.coord-detail')).not.toBeNull();
  });
});

describe('C5: el run terminado muestra lo que el equipo dejó', () => {
  const wired = { coordinationRun: done, coordinationLog: [dispatchRow()] };

  it('el encabezado cierra el pedido: bandera, hora y la barra llena', () => {
    const { container } = mount(wired);
    const head = container.querySelector('.coord-head')!;
    expect(head.querySelector('.coord-tic-ok')).not.toBeNull();
    expect(head.querySelector('.coord-head-sub')!.textContent).toBe('Terminamos · 4 de 4');
    // El rotulo de la barra se fue: "4 de 4 listas" decia, palabra por palabra,
    // lo que el subtitulo ya dice. La barra llena lo muestra sin escribirlo.
    expect(head.querySelector('.coord-progress-done')).toBeNull();
    expect(head.querySelector('.coord-progress-rest')!.textContent).toBe('0 fallidas');
    const bar = head.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(bar.getAttribute('aria-valuemax')).toBe('4');
  });

  it('un run cerrado no ofrece pausar ni cancelar', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.team-pause-coordination')).toBeNull();
    expect(container.querySelector('.team-cancel-coordination')).toBeNull();
  });

  it('"Nuevo pedido" abre el chat del coordinador', () => {
    const onNewRequest = vi.fn();
    const { container } = mount({ ...wired, onNewRequest });
    const button = [...container.querySelectorAll('.coord-head button')].find((b) => b.textContent === 'Nuevo pedido')!;
    fireEvent.click(button);
    expect(onNewRequest).toHaveBeenCalled();
  });

  it('cada reporte es una fila: resumen, dueño y hora', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.coord-output-title')!.textContent).toBe('Lo que produjo el equipo');
    const row = container.querySelector('.coord-output-row')!;
    expect(row.querySelector('.coord-output-summary')!.textContent).toBe('14 piezas numeradas, en piezas-para-produccion-cm.md');
    // D5: el dueno de la fila es su cara, con su nombre en el aria-label.
    const owner = row.querySelector('.coord-av')!;
    expect(owner.getAttribute('aria-label')).toBe('Paid Media');
    expect(owner.querySelector('.av-face')).not.toBeNull();
    expect(row.querySelector('.coord-time')!.getAttribute('dateTime')).toBe('2026-09-13T17:48:00.000Z');
  });

  /**
   * EL LÍMITE, ANOTADO: si el resumen nombra un archivo hay ficha; si no lo
   * nombra, no se inventa ninguna. No existe una lista de archivos producidos
   * en el modelo de datos.
   */
  it('la ficha de archivo sale del resumen, y sólo si el resumen lo nombra', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.coord-output-files .coord-file')!.textContent).toBe('piezas-para-produccion-cm.md');
  });

  it('un resumen que no nombra archivos no produce ninguna ficha', () => {
    const { container } = mount({ ...wired, coordinationLog: [dispatchRow({ summaryPreview: 'Las 14 piezas quedaron listas' })] });
    expect(container.querySelector('.coord-file')).toBeNull();
    expect(container.querySelector('.coord-output-summary')!.textContent).toBe('Las 14 piezas quedaron listas');
  });

  it('sin un solo reporte lo dice, en vez de dejar la lista vacía', () => {
    const { container } = mount({ coordinationRun: done, coordinationLog: [] });
    expect(container.querySelector('.coord-output-empty')!.textContent).toBe('El equipo no dejó ningún reporte.');
  });

  it('la bitácora está plegada y se despliega con su botón', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.coord-log')).toBeNull();
    const toggle = container.querySelector('.coord-output-log')!;
    expect(toggle.textContent).toBe('Bitácora · 1 evento');
    fireEvent.click(toggle);
    expect(container.querySelectorAll('.coord-log-row')).toHaveLength(1);
  });
});

describe('C5: la derivación de lo producido, sin montar nada', () => {
  it('sólo los despachos que se liquidaron con un resumen', () => {
    const rows = outcomeRows([
      dispatchRow(),
      dispatchRow({ id: 'd2', status: 'cancelled', outcome: null, summaryPreview: null }),
      dispatchRow({ id: 'd3', status: 'dispatched', outcome: null, summaryPreview: null, settledAt: null }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['d1']);
  });

  it('un despacho que falló se cuenta, y se marca', () => {
    const rows = outcomeRows([dispatchRow({ status: 'failed', outcome: 'failed', summaryPreview: 'el runtime se cayó' })]);
    expect(rows[0]!.failed).toBe(true);
  });

  it('la entrada de cierre del run no es un reporte de nadie', () => {
    const rows = outcomeRows([{ kind: 'run_done', id: 'r1', runId: 'run1', tasksDone: 4, tasksFailed: 0, createdAt: '' }]);
    expect(rows).toEqual([]);
  });
});
