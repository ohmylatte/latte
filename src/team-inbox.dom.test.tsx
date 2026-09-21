import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B1.2: EL PANEL DEL EQUIPO ES UN BUZÓN.
 *
 * "Cada bot se concentra en lo suyo aislado, otro consolida, y si uno necesita
 * algo se lo pide a otro." Eso ya pasaba —despachos, reportes, `latte_message`
 * entre miembros, preguntas— y no había una sola pantalla donde se viera: el
 * panel mostraba el nombre del miembro y su estado de proceso, que no dice
 * nada de lo que el equipo estuvo haciendo.
 *
 * Todo sale de filas persistidas. Nada se narra: sin fila, no hay renglón.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
const { inboxEvents, lastInboxEvent, pendingForMember } = await import('./coordination/inbox');
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type {
  CoordinationAskView, CoordinationGateView, CoordinationHireView, CoordinationLogEntryView,
  CoordinationMessageView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador'), member('cm', 'CM'), member('paid', 'Paid Media')];

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 3, tasksFailed: 1, tasksPending: 2, ...patch,
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

const base: TeamPanelProps = {
  work, team, chats: {}, selectedId: null, roles: [], primaryLabel: 'Claude', primaryDetail: '', primaryReady: true,
  checking: false, primaryRuntime: 'claude', primaryAccountId: null, primaryModel: null, choices: [], busy: false,
  isDesktop: true, mode: 'simple',
  onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
};

const mount = (props: Partial<TeamPanelProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamPanel, { ...base, formatDate: (v: string) => v, ...props }));
};

describe('B1.2: la derivación del buzón, sin montar nada', () => {
  it('un despacho produce DOS hechos: le llegó, y después reportó', () => {
    const events = inboxEvents({ log: [dispatchRow()] }, 'cm');
    expect(events.map((e) => e.kind)).toEqual(['dispatched', 'reported']);
    expect(events[0]!.text).toBe('Escribir 3 posts'); // la primera línea, no el texto entero
    expect(events[1]!.text).toBe('Quedaron los 3 posts');
  });

  it('un despacho que falló NO se cuenta como un reporte: son dos hechos distintos', () => {
    const events = inboxEvents({ log: [dispatchRow({ outcome: 'failed', summaryPreview: 'el runtime se cayó' })] }, 'cm');
    expect(events.map((e) => e.kind)).toEqual(['dispatched', 'dispatchFailed']);
  });

  it('un despacho en vuelo no inventa un final', () => {
    const events = inboxEvents({ log: [dispatchRow({ status: 'running', outcome: null, summaryPreview: null, settledAt: null })] }, 'cm');
    expect(events.map((e) => e.kind)).toEqual(['dispatched']);
  });

  it('un mensaje se lee de los dos lados, con el otro extremo nombrado', () => {
    const sent = inboxEvents({ messages: [message()] }, 'paid');
    expect(sent[0]).toMatchObject({ kind: 'sent', otherMemberId: 'cm' });
    const received = inboxEvents({ messages: [message()] }, 'cm');
    expect(received[0]).toMatchObject({ kind: 'received', otherMemberId: 'paid' });
  });

  it('un mensaje de Latte (sin remitente) llega igual, y su remitente queda sin nombrar en vez de inventado', () => {
    const received = inboxEvents({ messages: [message({ from: null })] }, 'cm');
    expect(received[0]).toMatchObject({ kind: 'received' });
    expect(received[0]!.otherMemberId).toBeUndefined();
  });

  it('la pregunta y su respuesta son dos hechos, en su orden', () => {
    const events = inboxEvents({ asks: [ask({ answer: '200 por día', answeredAt: '2026-09-01T14:00:00.000Z' })] }, 'paid');
    expect(events.map((e) => e.kind)).toEqual(['ask', 'answer']);
  });

  it('el hilo va del más viejo al más nuevo, mezclando las cuatro fuentes', () => {
    const events = inboxEvents({ log: [dispatchRow({ memberId: 'paid' })], messages: [message()], asks: [ask()], hires: [hire()] }, 'paid');
    expect(events.map((e) => e.kind)).toEqual(['hired', 'dispatched', 'reported', 'sent', 'ask']);
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it('sin un solo hecho no hay último: nunca un renglón inventado', () => {
    expect(lastInboxEvent({ log: [dispatchRow()] }, 'coord')).toBeNull();
  });

  it('el contador de pendientes usa el MISMO ruteo que las tarjetas del chat', () => {
    const gates: CoordinationGateView[] = [{ id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' }];
    expect(pendingForMember('coord', gates, [ask()], run())).toBe(1);
    expect(pendingForMember('paid', gates, [ask()], run())).toBe(1);
    expect(pendingForMember('cm', gates, [ask()], run())).toBe(0);
  });

  it('un run que cerró no espera nada de nadie', () => {
    const gates: CoordinationGateView[] = [{ id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' }];
    expect(pendingForMember('coord', gates, [ask()], run({ status: 'done', active: false }))).toBe(0);
  });
});

describe('B1.2: el buzón, dibujado', () => {
  const wired = {
    coordinationRun: run(),
    coordinationLog: [dispatchRow()],
    coordinationMessages: [message()],
    coordinationAsks: [ask()],
    coordinationHires: [hire()],
    coordinationGates: [{ id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' } as CoordinationGateView],
  };

  it('una línea por miembro con su último intercambio y su hora', () => {
    const { container } = mount(wired);
    const rows = [...container.querySelectorAll('.team-inbox-row')];
    expect(rows.map((r) => r.getAttribute('data-member-id'))).toEqual(['coord', 'cm', 'paid']);
    // `cm` recibió un despacho, lo reportó, y después le llegó un mensaje de Paid Media.
    const cm = container.querySelector('[data-member-id="cm"] .team-inbox-line')!;
    expect(cm.textContent).toContain('← Paid Media');
    expect(cm.textContent).toContain('Necesito el copy');
    expect(cm.querySelector('time')!.getAttribute('dateTime')).toBe('2026-09-01T12:00:00.000Z');
  });

  it('un miembro sin un solo hecho lo dice, en vez de dejar el renglón vacío', () => {
    const { container } = mount(wired);
    expect(container.querySelector('[data-member-id="coord"] .team-inbox-line')!.textContent).toBe('Sin novedades');
  });

  it('sin ninguna fuente cableada el buzón no se dibuja — cero filas nunca es un cero', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelector('.team-inbox')).toBeNull();
  });

  it('"Hilo" despliega la lista cronológica de ese miembro, y sólo de ese miembro', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.team-thread')).toBeNull();
    fireEvent.click(container.querySelector('[data-member-id="paid"] .team-inbox-thread-toggle')!);
    const kinds = [...container.querySelectorAll('.team-thread-row')].map((r) => r.getAttribute('data-kind'));
    expect(kinds).toEqual(['hired', 'sent', 'ask']);
    // Un solo hilo abierto: el de `paid`, dentro de su propia fila.
    expect(container.querySelectorAll('.team-thread')).toHaveLength(1);
    expect(container.querySelector('[data-member-id="paid"] .team-thread')).not.toBeNull();
  });

  it('el contador de pendientes va en la pestaña del miembro al que le tocan', () => {
    const { container } = mount({ ...wired, chats: {} });
    const tabs = [...container.querySelectorAll('.team-tab')];
    const withCount = tabs.filter((tab) => tab.querySelector('.team-tab-pending'));
    expect(withCount).toHaveLength(2); // el coordinador (su gate) y quien pregunto
    expect(container.querySelectorAll('.team-tab-pending')[0]!.textContent).toBe('1');
  });

  it('el estado del run vive compacto en la cabecera, con sus tres cuentas y su presupuesto', () => {
    const { container } = mount({ ...wired, coordinationRun: run({ status: 'suspended' }) });
    const controls = container.querySelector('.team-coordination-controls')!;
    expect(controls.querySelector('.team-coordination-counts')!.textContent).toContain('3');
    expect(controls.querySelector('.team-coordination-counts')!.textContent).toContain('1');
    expect(controls.querySelector('.team-coordination-counts')!.textContent).toContain('2');
    expect(controls.querySelector('.team-coordination-budget')!.textContent).toContain('10');
  });

  it('un presupuesto ILEGIBLE no se dibuja como un número', () => {
    const { container } = mount({ ...wired, coordinationRun: run({ budgetInvalid: true, budget: null }) });
    const budget = container.querySelector('.team-coordination-budget')!.textContent ?? '';
    expect(budget.toLowerCase()).toContain('no se pudo leer');
    expect(budget).not.toContain('∞');
  });

  it('el mismo buzón en inglés, sin nada en castellano', () => {
    const { container } = mount(wired, 'en-US');
    const text = container.querySelector('.team-inbox')!.textContent ?? '';
    expect(text).toContain('Thread');
    expect(text).toContain('Nothing new');
    expect(text).not.toContain('Hilo');
    expect(text).not.toContain('Sin novedades');
  });
});
