import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * E1: "PARA EL CLIENTE" SE VE DONDE SE DECIDE Y DONDE SE TRABAJA.
 *
 * La tarjeta de la propuesta (donde la persona aprueba), la tira de tareas y
 * el detalle del miembro dicen qué tarea es para el cliente, con un ícono y
 * una palabra. Lo interno va sin adorno: es el caso de siempre. La persona
 * cambia la audiencia al editar la propuesta.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationGateView, CoordinationLogEntryView, CoordinationProposal, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'working', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 1, tasksPending: 1,
};
const task = (id: string, title: string, patch: Partial<CoordinationRunTaskView> = {}): CoordinationRunTaskView =>
  ({ id, roleId: 'strat', spec: title, title, status: 'running', inPlan: true, dependsOn: [], attempts: 0, assignedMemberId: 'strat', ...patch });
const dispatch = (id: string, taskId: string): CoordinationLogEntryView => ({
  id, taskId, memberId: 'strat', status: 'running', outcome: null, promptPreview: 'x', summaryPreview: null,
  createdAt: '2026-09-25T12:00:00.000Z', startedAt: '2026-09-25T12:00:00.000Z', settledAt: null,
});

const mountTeam = (props: Partial<TeamViewProps> = {}) => render(createElement(TeamView, {
  work, team: [member('coord', 'Asistente'), member('strat', 'Strategist')], roles: [], mode: 'simple', busy: false,
  selectedMemberId: 'strat', onSelectMember: () => {}, coordinationRun: run,
  coordinationTasks: [task('t1', 'Análisis de canales'), task('t2', 'Propuesta para Vane', { audience: 'client', status: 'ready', assignedMemberId: null })],
  coordinationLog: [dispatch('d1', 't1'), dispatch('d2', 't2')],
  formatTime: (v: string) => v.slice(11, 16), formatDate: (v: string) => v, ...props,
}));

describe('E1: la tira de tareas y el detalle', () => {
  it('sólo la ficha de la tarea para el cliente lleva la marca, con su nombre', () => {
    ui.locale = 'es-AR';
    const { container } = mountTeam();
    const chips = [...container.querySelectorAll('.coord-task')];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector('.coord-audience')).toBeNull();
    const badge = chips[1]!.querySelector('.coord-audience')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Para el cliente');
    expect(chips[1]!.getAttribute('title')).toContain('Para el cliente');
  });

  it('el despacho de la tarea para el cliente lo dice en el detalle; el interno no', () => {
    ui.locale = 'es-AR';
    const { container } = mountTeam();
    const cards = [...container.querySelectorAll('.coord-event-card')];
    const byTitle = (title: string) => cards.find((card) => card.querySelector('.coord-event-task')!.textContent!.includes(title))!;
    expect(byTitle('Propuesta para Vane').querySelector('.coord-audience')!.textContent).toBe('Para el cliente');
    expect(byTitle('Análisis de canales').querySelector('.coord-audience')).toBeNull();
  });

  it('en inglés dice For the client', () => {
    ui.locale = 'en-US';
    const { container } = mountTeam();
    expect(container.querySelector('.coord-task .coord-audience')!.getAttribute('aria-label')).toBe('For the client');
  });
});

const runView: CoordinationRunView = { ...run };
const proposal: CoordinationProposal = {
  plan: [
    { roleId: 'strat', title: 'Análisis de canales', spec: 'Analizá.' },
    { roleId: 'strat', title: 'Propuesta para Vane', spec: 'Escribí.', audience: 'client' },
  ],
  estimatedDispatches: 4,
  membersToHire: [],
  rationale: 'Propuesta mayorista',
};
const gate: CoordinationGateView = { id: 'g-prop', kind: 'proposal', runId: 'run1', proposalJson: JSON.stringify(proposal), createdAt: '2026-09-25T00:00:00.000Z' };

describe('E1: la tarjeta de la propuesta', () => {
  it('marca la tarea para el cliente y deja la interna sin adorno', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(TeamCards, { memberId: 'coord', coordinationRun: runView, gates: [gate], team: [], roles: [], onResolveGate: vi.fn() }));
    const rows = [...container.querySelectorAll('.coord-plan-task')];
    expect(rows[0]!.querySelector('.coord-audience')).toBeNull();
    expect(rows[1]!.querySelector('.coord-audience')!.textContent).toBe('Para el cliente');
  });

  it('al editar, la persona cambia la audiencia de cada tarea y eso es lo que se aprueba', () => {
    ui.locale = 'es-AR';
    const onResolveGate = vi.fn().mockResolvedValue(true);
    const { container } = render(createElement(TeamCards, { memberId: 'coord', coordinationRun: runView, gates: [gate], team: [], roles: [], onResolveGate }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.team-card-edit-audience input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([false, true]);
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    // El "Aprobar" simple manda lo GUARDADO: con la audiencia tocada deja de ofrecerse.
    expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar edición y aprobar' }));
    const sent = JSON.parse(onResolveGate.mock.calls[0]![2] as string) as CoordinationProposal;
    expect(sent.plan.map((item) => item.audience ?? 'internal')).toEqual(['client', 'internal']);
  });
});
