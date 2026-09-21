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
  CoordinationMessageView, CoordinationRunView, TeamMember, Work,
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
const gate: CoordinationGateView = { id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' };

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

describe('B3.1: la lista de miembros', () => {
  it('una línea por miembro con su último intercambio y su hora', () => {
    const { container } = mount(wired);
    const rows = [...container.querySelectorAll('.team-inbox-row')];
    expect(rows.map((r) => r.getAttribute('data-member-id'))).toEqual(['coord', 'cm', 'paid']);
    const cm = container.querySelector('[data-member-id="cm"] .team-inbox-line')!;
    expect(cm.textContent).toContain('← Paid Media');
    expect(cm.textContent).toContain('Necesito el copy');
    expect(cm.querySelector('time')!.getAttribute('dateTime')).toBe('2026-09-01T12:00:00.000Z');
  });

  it('un miembro sin un solo hecho lo dice, en vez de dejar el renglón vacío', () => {
    const { container } = mount(wired);
    expect(container.querySelector('[data-member-id="coord"] .team-inbox-line')!.textContent).toBe('Sin novedades');
  });

  /**
   * B3.1: y sin NINGUNA fuente cableada la lista sigue estando.
   *
   * Es el cambio de casa respecto de B1: el buzón era una sección encima de la
   * conversación y ahí callarse era lo correcto. Acá la lista ES la navegación
   * de la vista; esconderla dejaría la pantalla del equipo en blanco. Lo que no
   * se inventa sigue sin inventarse: cada miembro dice que no tiene novedades.
   */
  it('sin ninguna fuente cableada la lista sigue estando, sin inventar un renglón', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelectorAll('.team-inbox-row')).toHaveLength(3);
    expect(container.querySelector('.team-inbox-line')!.textContent).toBe('Sin novedades');
  });

  it('el contador de pendientes del miembro sale del MISMO ruteo que las tarjetas', () => {
    const { container } = mount(wired);
    const badge = (id: string) => container.querySelector(`[data-member-id="${id}"] .team-inbox-pending`);
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
    fireEvent.click(container.querySelector('[data-member-id="paid"] .team-inbox-name')!);
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

  it('"Abrir chat" lleva a la conversación de ESE miembro', () => {
    const onOpenChat = vi.fn();
    const { container } = mount({ ...wired, onOpenChat });
    fireEvent.click(container.querySelector('[data-member-id="cm"] .team-inbox-open-chat')!);
    expect(onOpenChat).toHaveBeenCalledWith('cm');
  });

  it('sin handler no se ofrece un "Abrir chat" que no abre nada', () => {
    const { container } = mount(wired);
    expect(container.querySelector('.team-inbox-open-chat')).toBeNull();
  });
});

describe('B3.1: el run, arriba y con sus salidas', () => {
  it('el estado del run vive compacto arriba, con sus tres cuentas y su presupuesto', () => {
    const { container } = mount({ ...wired, coordinationRun: run({ status: 'suspended' }) });
    const controls = container.querySelector('.team-coordination-controls')!;
    expect(controls.querySelector('.team-coordination-counts')!.textContent).toContain('3');
    expect(controls.querySelector('.team-coordination-budget')!.textContent).toContain('10');
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
    expect(text).toContain('Nothing new');
    expect(text).not.toContain('Sin novedades');
    expect(text).not.toContain('Abrir chat');
  });
});
