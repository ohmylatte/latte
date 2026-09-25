import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * N2: LA TIRA DE TAREAS DICE LA TAREA, NO EL CONTEXTO.
 *
 * La captura del dueño: cada ficha decía "CONTEXTO. Ayulem Pastelería,
 * cliente nuevo (arranque 2026-09-14)…", porque el título salía de la primera
 * línea del spec y el coordinador arranca sus pedidos con un bloque de
 * contexto.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { cleanup, render } = await import('@testing-library/react');
const { TeamView } = await import('./TeamView');
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const AYULEM = [
  'CONTEXTO. Ayulem Pastelería, cliente nuevo (arranque 2026-09-14). Hoy es 2026-09-24. Mes 1 prioriza el canal mayorista.',
  '',
  'Tarea: Estrategia de captación mayorista para Meta Ads',
].join('\n');

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
const task = (id: string, spec: string, patch: Partial<CoordinationRunTaskView> = {}): CoordinationRunTaskView =>
  ({ id, roleId: 'strat', spec, status: 'running', inPlan: true, dependsOn: [], attempts: 0, assignedMemberId: 'strat', ...patch });
const dispatch: CoordinationLogEntryView = {
  id: 'd1', taskId: 't1', memberId: 'strat', status: 'running', outcome: null, promptPreview: AYULEM, summaryPreview: null,
  createdAt: '2026-09-24T19:18:00.000Z', startedAt: '2026-09-24T19:18:00.000Z', settledAt: null,
};

const mount = (props: Partial<TeamViewProps> = {}) => {
  ui.locale = 'es-AR';
  return render(createElement(TeamView, {
    work, team: [member('coord', 'Asistente'), member('strat', 'Strategist')], roles: [], mode: 'simple', busy: false,
    selectedMemberId: 'strat', onSelectMember: () => {}, coordinationRun: run, coordinationLog: [dispatch],
    formatTime: (v: string) => v.slice(11, 16), formatDate: (v: string) => v, ...props,
  }));
};

describe('N2: títulos de tarea sin el bloque de contexto', () => {
  it('la ficha de la tira, la fila y el despacho dicen la tarea', () => {
    const { container } = mount({ coordinationTasks: [task('t1', AYULEM)] });
    expect(container.querySelector('.coord-task-title')!.textContent).toBe('Estrategia de captación mayorista para Meta Ads');
    expect(container.querySelector('[data-member-id="strat"] .coord-row-line')!.textContent).toBe('Estrategia de captación mayorista para Meta Ads');
    expect(container.querySelector('.coord-event-task')!.textContent).toBe('Estrategia de captación mayorista para Meta Ads');
    expect(container.textContent).not.toMatch(/^CONTEXTO|CONTEXTO\. Ayulem Pastelería, cliente nuevo \(arranque 2026-09-14\)…/);
  });

  it('el título que trajo la propuesta gana, recortado a 60 en la ficha', () => {
    const long = 'Estrategia mayorista de Ayulem para Meta Ads, con segmentos, presupuesto y calendario';
    const { container } = mount({ coordinationTasks: [task('t1', AYULEM, { title: long })] });
    const chip = container.querySelector('.coord-task-title')!.textContent!;
    expect(chip).toBe(long.slice(0, 60).trimEnd() + '…');
  });
});
