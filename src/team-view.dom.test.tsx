import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B3.1: EL EQUIPO TIENE SU PROPIA VISTA.
 *
 * Tras B1 el buzón quedó APILADO encima de la conversación, en la columna del
 * chat, entre las pestañas de miembros y los mensajes: le robaba el alto justo
 * a lo único que esa columna tiene que hacer. El dueño lo dijo con la captura
 * en la mano — "no puede estar ahí".
 *
 * Su referencia es un inbox multi-bot: la lista de bots a la izquierda con su
 * último mensaje, y al abrir uno, su hilo. Eso es esta vista, y vive en la
 * barra de pestañas del Trabajo, con el ancho entero, donde una lista y un
 * hilo caben sin pelearse con nada.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type {
  CoordinationAskView, CoordinationGateView, CoordinationHireView, CoordinationLogEntryView,
  CoordinationMessageView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, patch: Partial<TeamMember> = {}): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const team = [member('coord', 'Coordinador'), member('cm', 'CM'), member('paid', 'Paid Media')];

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 3, tasksFailed: 1, tasksInFlight: 0, tasksPending: 2, ...patch,
});

const dispatchRow = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'cm', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir 3 posts\nsegunda línea', summaryPreview: 'Quedaron los 3 posts',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', settledAt: '2026-09-01T11:00:00.000Z', ...patch,
});
const message = (patch: Partial<CoordinationMessageView> = {}): CoordinationMessageView => ({
  id: 'msg1', runId: 'run1', from: { memberId: 'paid', roleId: 'paid' }, to: { memberId: 'cm', roleId: 'cm' },
  text: 'Necesito el copy para el anuncio', readAt: null, createdAt: '2026-09-01T12:00:00.000Z', ...patch,
});
const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'paid', question: '¿Cuál es el presupuesto diario?',
  answer: null, deadlineAt: '', answeredAt: null, createdAt: '2026-09-01T13:00:00.000Z', ...patch,
});
const hire = (patch: Partial<CoordinationHireView> = {}): CoordinationHireView => ({
  memberId: 'paid', roleId: 'paid', roleName: 'Paid Media', hiredAt: '2026-09-01T09:00:00.000Z', ...patch,
});
const gate: CoordinationGateView = { id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' };

/** C1: las cuatro tareas del pedido real, con el `#` de Markdown que el motor deja entrar. */
const task = (id: string, roleId: string, spec: string, status: CoordinationRunTaskView['status']): CoordinationRunTaskView =>
  ({ id, roleId, spec, status, inPlan: true, dependsOn: [], attempts: 0, assignedMemberId: null });
const tasks: CoordinationRunTaskView[] = [
  task('t1', 'paid', 'Piezas publicitarias Meta', 'done'),
  task('t2', 'cm', '# Producir 14 piezas Feed y Story', 'running'),
  task('t3', 'cm', 'Calendario de la semana 1', 'ready'),
  // La pregunta abierta de Paid Media apunta a esta tarea: su ficha lo dice.
  task('t4', 'paid', 'Campañas A y B en Meta Ads', 'dispatched'),
];

const base: TeamViewProps = {
  work, team, roles: [], mode: 'simple', busy: false,
  selectedMemberId: null, onSelectMember: () => {},
};

const wired = {
  coordinationRun: run(),
  coordinationLog: [dispatchRow()],
  coordinationMessages: [message()],
  coordinationAsks: [ask()],
  coordinationHires: [hire()],
  coordinationGates: [gate],
};

const mount = (props: Partial<TeamViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamView, { ...base, formatDate: (v: string) => v, ...props }));
};

/**
 * C2: LA MISMA ANATOMÍA EN TODA FILA.
 *
 * Estado (avatar con punto) · nombre · qué hace ahora · cuándo. Y la fila ES
 * la acción: un `<button>` entero, sin un "Abrir chat" repetido al costado de
 * cada nombre. El chip con la palabra ("conectado", "arrancando") se fue: una
 * frase adentro de una pastilla es justo lo que el criterio 5 prohíbe.
 */
describe('C2: la lista de miembros', () => {
  const line = (container: HTMLElement, id: string) => container.querySelector(`[data-member-id="${id}"] .coord-row-line`)!;

  it('una línea por miembro, con su punto, su nombre y su hora', () => {
    const { container } = mount(wired);
    const rows = [...container.querySelectorAll('.team-inbox-row')];
    expect(rows.map((r) => r.getAttribute('data-member-id'))).toEqual(['coord', 'cm', 'paid']);
    const cm = container.querySelector('[data-member-id="cm"]')!;
    expect(cm.querySelector('.coord-row-name')!.textContent).toBe('CM');
    expect(cm.querySelector('.coord-av')).not.toBeNull();
    // Lo ultimo que le paso a CM es el mensaje de Paid Media, no su reporte.
    expect(cm.querySelector('.coord-row-line')!.textContent).toBe('Le escribió Paid Media');
    expect(cm.querySelector('.coord-time')!.getAttribute('dateTime')).toBe('2026-09-01T12:00:00.000Z');
  });

  /** Criterio 4: cada fila es un botón. Ningún verbo repetido al costado. */
  it('la fila entera es la acción, y "Abrir chat" no existe', () => {
    const onSelectMember = vi.fn();
    const { container } = mount({ ...wired, onSelectMember, onOpenChat: () => {} });
    const rows = [...container.querySelectorAll('.team-inbox-row')];
    for (const row of rows) expect(row.querySelector('button.coord-row')).not.toBeNull();
    expect(container.querySelector('.team-inbox-open-chat')).toBeNull();
    expect([...container.querySelectorAll('.team-view-list button')].map((b) => b.textContent)).not.toContain('Abrir chat');
    fireEvent.click(container.querySelector('[data-member-id="paid"] .coord-row')!);
    expect(onSelectMember).toHaveBeenCalledWith('paid');
  });

  /** El coordinador lleva su ícono al lado del nombre; nadie más. */
  it('el coordinador se nombra con un ícono, no con una pastilla', () => {
    const { container } = mount(wired);
    expect(container.querySelector('[data-member-id="coord"] .coord-row-coordinator')).not.toBeNull();
    expect(container.querySelector('[data-member-id="cm"] .coord-row-coordinator')).toBeNull();
    expect(container.querySelector('.team-member-state')).toBeNull();
  });

  /** El que reportó y está ocioso se lee verde; el que tiene un despacho en vuelo, en el acento. */
  it('el punto dice el estado: reportó en verde, en vuelo en el acento', () => {
    const { container } = mount({
      ...wired,
      coordinationMessages: [],
      coordinationAsks: [],
      coordinationLog: [dispatchRow(), dispatchRow({ id: 'd2', taskId: 't4', memberId: 'paid', status: 'running', outcome: null, summaryPreview: null, settledAt: null })],
    });
    expect(container.querySelector('[data-member-id="cm"] .coord-dot-ok')).not.toBeNull();
    expect(container.querySelector('[data-member-id="paid"] .coord-dot-live')).not.toBeNull();
    expect(line(container, 'cm').textContent).toContain('Reportó');
  });

  /** El coordinador no tiene despacho propio: lo suyo es esperar los ajenos, y se nombra a quién. */
  it('el coordinador dice a quién espera', () => {
    const { container } = mount({
      ...wired,
      coordinationAsks: [],
      coordinationLog: [dispatchRow({ status: 'running', outcome: null, summaryPreview: null, settledAt: null })],
    });
    expect(line(container, 'coord').textContent).toBe('Espera el reporte de CM');
  });

  /** Criterio 2: una pregunta abierta es lo único que se lee en el acento. */
  it('una pregunta abierta pone la línea en el acento y un badge en vez de la hora', () => {
    const { container } = mount(wired);
    const paid = container.querySelector('[data-member-id="paid"]')!;
    expect(paid.querySelector('.coord-row-line.is-urgent')!.textContent).toContain('presupuesto diario');
    expect(paid.querySelector('.coord-badge')!.textContent).toBe('1');
    expect(paid.querySelector('.coord-time')).toBeNull();
  });

  it('un miembro sin un solo hecho lo dice, en vez de dejar el renglón vacío', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelectorAll('.team-inbox-row')).toHaveLength(3);
    expect(line(container, 'cm').textContent).toBe('Sin novedades');
  });

  it('el contador de pendientes del miembro sale del MISMO ruteo que las tarjetas', () => {
    const { container } = mount(wired);
    const badge = (id: string) => container.querySelector(`[data-member-id="${id}"] .coord-badge`);
    expect(badge('coord')).not.toBeNull(); // su gate
    expect(badge('paid')).not.toBeNull();  // su pregunta
    expect(badge('cm')).toBeNull();
  });
});

describe('B3.1: el hilo del miembro seleccionado', () => {
  it('con run, arranca en el coordinador', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.team-inbox-row.is-selected')!.getAttribute('data-member-id')).toBe('coord');
  });

  it('sin run, arranca en el primero', () => {
    const { container } = mount({ ...wired, coordinationRun: null });
    expect(container.querySelector('.team-inbox-row.is-selected')!.getAttribute('data-member-id')).toBe('coord');
  });

  it('elegir un miembro avisa hacia afuera: la selección la manda quien la guarda', () => {
    const onSelectMember = vi.fn();
    const { container } = mount({ ...wired, onSelectMember });
    fireEvent.click(container.querySelector('[data-member-id="paid"] .coord-row')!);
    expect(onSelectMember).toHaveBeenCalledWith('paid');
  });

  it('el hilo es el del seleccionado, cronológico, y sólo hay uno', () => {
    const { container } = mount({ ...wired, selectedMemberId: 'paid' });
    const kinds = [...container.querySelectorAll('.team-thread-row')].map((r) => r.getAttribute('data-kind'));
    expect(kinds).toEqual(['hired', 'sent', 'ask']);
    expect(container.querySelectorAll('.team-thread')).toHaveLength(1);
  });

  it('un miembro sin un solo hecho tiene un hilo que lo dice', () => {
    const { container } = mount({ ...wired, selectedMemberId: 'coord' });
    expect(container.querySelector('.team-thread-empty')).not.toBeNull();
  });


});

describe('B3.1: el run, arriba y con sus salidas', () => {
  /**
   * C1: EL ENCABEZADO DEL PEDIDO, NO DOS LÍNEAS DE CONTADORES.
   *
   * Lo que había eran siete números repartidos en dos frases con "·". Lo que
   * hay es el título del pedido, quién lo coordina, UNA barra y el presupuesto
   * en una pastilla.
   */
  it('el encabezado dice el pedido, el avance y el presupuesto', () => {
    const { container } = mount({ ...wired, coordinationRun: run({ status: 'suspended' }) });
    const head = container.querySelector('.coord-head')!;
    expect(head.querySelector('.coord-head-name')!.textContent).toBe('Lanzamiento');
    expect(head.querySelector('.coord-head-sub')!.textContent).toContain('Coordinador');
    // 3 listas + 1 fallida + 0 en vuelo + 2 sin empezar = 6 tareas.
    expect(head.querySelector('.coord-progress-done')!.textContent).toContain('6');
    expect(head.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('3');
    expect(head.querySelector('.coord-pill-dispatches')!.textContent).toContain('10');
    expect(container.querySelector('.team-coordination-counts')).toBeNull();
  });

  /** C1: la tira de tareas es el pedido ENTERO, también lo que todavía no salió. */
  it('la tira dibuja una ficha por tarea, con su estado y su dueño', () => {
    const { container } = mount({ ...wired, coordinationTasks: tasks, coordinationAsks: [ask({ taskId: 't4' })] });
    const chips = [...container.querySelectorAll('.coord-task')];
    expect(chips.map((c) => c.getAttribute('data-task-state'))).toEqual(['done', 'live', 'pending', 'asking']);
    expect(chips[0]!.querySelector('.coord-task-title')!.textContent).toBe('Piezas publicitarias Meta');
    // Criterio 3: el numeral de Markdown del spec no llega a la pantalla.
    expect(chips[1]!.querySelector('.coord-task-title')!.textContent).toBe('Producir 14 piezas Feed y Story');
    expect(container.querySelector('.coord-tasks')!.textContent).not.toContain('#');
  });

  it('sin tareas no se dibuja una tira vacía', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.coord-tasks')).toBeNull();
  });

  it('sin run no hay encabezado: un Trabajo sin equipo no tiene un pedido del que informar', () => {
    const { container } = mount({ ...wired, coordinationRun: null });
    expect(container.querySelector('.coord-head')).toBeNull();
  });

  it('Pausar y Cancelar son los verbos reales del run', () => {
    const onPauseCoordination = vi.fn();
    const onCancelCoordination = vi.fn();
    const { container } = mount({ ...wired, onPauseCoordination, onCancelCoordination });
    fireEvent.click(container.querySelector('.team-pause-coordination')!);
    fireEvent.click(container.querySelector('.team-cancel-coordination')!);
    expect(onPauseCoordination).toHaveBeenCalledWith('run1');
    expect(onCancelCoordination).toHaveBeenCalledWith('run1');
  });

  it('un run suspendido ofrece Reanudar', () => {
    const onResumeCoordination = vi.fn();
    const { container } = mount({ ...wired, coordinationRun: run({ status: 'suspended' }), onResumeCoordination });
    fireEvent.click(container.querySelector('.team-resume-coordination')!);
    expect(onResumeCoordination).toHaveBeenCalledWith('run1');
  });
});

describe('B3.1: lo avanzado, al pie', () => {
  it('no se renderiza en modo simple', () => {
    const { container } = mount({ ...wired, coordinationAuthority: 'manual' });
    expect(container.querySelector('.team-advanced')).toBeNull();
  });

  it('se renderiza en modo avanzado, plegado y al pie de la vista', () => {
    const { container } = mount({ ...wired, mode: 'advanced', coordinationAuthority: 'manual' });
    const details = container.querySelector('details.team-advanced') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const view = container.querySelector('.team-view')!;
    expect(view.lastElementChild).toBe(details);
  });
});

describe('B3.1: el mismo equipo en inglés', () => {
  it('sin nada en castellano', () => {
    const { container } = mount({ ...wired, onOpenChat: () => {} }, 'en-US');
    const text = container.textContent ?? '';
    expect(text).not.toContain('Abrir chat');
    expect(text).not.toContain('Espera el reporte');
  });
});
