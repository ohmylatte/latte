import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { RunHeader, type RunHeaderProps } from './coordination/RunHeader';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationAskView, CoordinationRunTaskView, CoordinationRunView, TeamMember } from '../shared/contracts';

/**
 * O1: LA LÍNEA "AHORA" EN EL ENCABEZADO.
 *
 * La captura del dueño: "2 de 3 listas · 0 en curso · 2/3 despachos", la
 * tercera tarea sin empezar y nada que dijera qué pasa ni qué esperan de él.
 * Acá se montan los tres casos que le importan a la persona: algo te espera
 * (con el enlace al hilo), el coordinador en pausa (con "Reanudar" que llama
 * al reanudar de siempre) y lo que falta sin que nadie lo tenga.
 */

const member = (id: string, roleName: string, patch: Partial<TeamMember> = {}): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const team = [member('coord', 'Asistente'), member('paid', 'Paid Media'), member('strategist', 'Strategist')];

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: 'Plan de medios Q4', active: true,
  createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z', lastEventAt: '2026-09-24T10:00:00.000Z',
  tasksDone: 2, tasksFailed: 0, tasksInFlight: 0, tasksPending: 1, ...patch,
});

const tasks: CoordinationRunTaskView[] = [
  { id: 't1', roleId: 'paid', spec: 'Auditoría de cuentas', status: 'done', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'paid' },
  { id: 't2', roleId: 'strategist', spec: 'Posicionamiento', status: 'done', inPlan: true, dependsOn: [], attempts: 1, assignedMemberId: 'strategist' },
  { id: 't3', roleId: 'paid', spec: 'Plan de pauta de octubre', status: 'ready', inPlan: true, dependsOn: ['t1'], attempts: 0, assignedMemberId: null },
];

const ask = (id: string, memberId: string): CoordinationAskView => ({
  id, runId: 'run1', taskId: null, memberId, question: '¿Conector o exports?', answer: null,
  deadlineAt: '2026-09-24T12:00:00.000Z', answeredAt: null, createdAt: '2026-09-24T11:00:00.000Z',
});

const mount = (props: Partial<RunHeaderProps> = {}) => render(<I18nProvider>
  <RunHeader run={run()} title="Trabajo" coordinatorName="Asistente" tasks={tasks} team={team} roles={[]} formatTime={(v) => v} {...props} />
</I18nProvider>);

const now = (container: HTMLElement) => container.querySelector('.coord-now');

describe('O1: la línea "Ahora" en el encabezado', () => {
  it('1. algo te espera: quién, y el enlace abre su hilo', () => {
    const onOpenMember = vi.fn();
    const { container } = mount({ asks: [ask('a1', 'paid')], onOpenMember });
    expect(now(container)!.getAttribute('data-now')).toBe('waiting');
    const link = container.querySelector<HTMLButtonElement>('.coord-now-link')!;
    expect(link.textContent).toBe('Paid Media espera tu respuesta');
    fireEvent.click(link);
    expect(onOpenMember).toHaveBeenCalledWith('paid');
  });

  it('1. varios esperan: los nombra a todos en una frase', () => {
    const { container } = mount({ asks: [ask('a1', 'paid'), ask('a2', 'strategist')], onOpenMember: () => {} });
    expect(container.querySelector('.coord-now-link')!.textContent).toBe('2 cosas te esperan: Paid Media y Strategist');
  });

  it('2. el coordinador en pausa con el run activo: lo dice y ofrece reanudarlo', () => {
    const onResumeCoordinator = vi.fn();
    const { container } = mount({ coordinatorPaused: true, coordinatorUnread: 1, onResumeCoordinator });
    expect(now(container)!.getAttribute('data-now')).toBe('coordinatorPaused');
    expect(container.querySelector('.coord-now-text')!.textContent).toBe('Asistente está en pausa y tiene 1 mensaje sin leer');
    const resume = container.querySelector<HTMLButtonElement>('.coord-now-action')!;
    expect(resume.textContent).toBe('Reanudar');
    fireEvent.click(resume);
    expect(onResumeCoordinator).toHaveBeenCalledWith('coord');
  });

  it('3. falta una tarea y nadie la tiene: "Falta: … · sin despachar"', () => {
    const { container } = mount({ run: run({ budget: { maxDispatches: 5, unlimitedConfirmedAt: null } }) });
    expect(now(container)!.getAttribute('data-now')).toBe('missing');
    expect(now(container)!.textContent).toBe('Falta: Plan de pauta de octubre · sin despachar');
  });

  it('3. con los despachos agotados lo dice', () => {
    const { container } = mount({ run: run({ tasksDone: 2, tasksFailed: 1 }) });
    expect(now(container)!.textContent).toBe('Falta: Plan de pauta de octubre · sin despachos disponibles');
  });

  it('una sola línea, sin ids: nunca aparece un memberId ni un taskId', () => {
    const { container } = mount({ asks: [ask('a1', 'paid')], onOpenMember: () => {} });
    expect(container.querySelectorAll('.coord-now')).toHaveLength(1);
    expect(now(container)!.textContent).not.toMatch(/\b(paid|coord|t3|a1)\b/);
  });

  it('un run terminado no tiene línea: el subtítulo ya dice "Terminamos"', () => {
    const { container } = mount({ run: run({ status: 'done', active: false, tasksDone: 3, tasksPending: 0 }) });
    expect(now(container)).toBeNull();
  });
});
