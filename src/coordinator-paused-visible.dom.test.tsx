import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { ActiveTeamsStrip } from './ActiveTeamsStrip';
import { RunHeader } from './coordination/RunHeader';
import type { CoordinationActiveRunSummary, CoordinationRunView } from '../shared/contracts';

/**
 * O2: `suspended:coordinator_paused` SE VE, en el encabezado y en la tira.
 *
 * El motor ya no se queda callado cuando el coordinador está en pausa: suspende
 * el run con ese motivo. Del lado de la pantalla eso tiene que leerse como lo
 * que es —el equipo te espera— y la salida tiene que ser la que lo destraba:
 * reanudar AL COORDINADOR, no sólo al run.
 */

const summary = (patch: Partial<CoordinationActiveRunSummary> = {}): CoordinationActiveRunSummary => ({
  runId: 'run1', workId: 'w1', workTitle: 'Plan de medios', brandId: 'b1', brandName: 'Casa Oliva',
  status: 'suspended', dispatchesUsed: 2, maxDispatches: 3, pendingGates: 0, budgetInvalid: false,
  updatedAt: '2026-09-24T00:00:00.000Z', lastEventAt: '2026-09-24T00:00:00.000Z', lastSeenAt: null, ...patch,
});

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'suspended', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: 'coordinator_paused', request: null, active: true,
  createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z', lastEventAt: '2026-09-24T10:00:00.000Z',
  tasksDone: 2, tasksFailed: 0, tasksInFlight: 0, tasksPending: 1, ...patch,
});

describe('O2: la tira de equipos', () => {
  it('un equipo quieto por su coordinador en pausa te necesita, y lo dice en palabras', () => {
    const { container } = render(<I18nProvider><ActiveTeamsStrip runs={[summary({ suspendReason: 'coordinator_paused' })]} onOpen={() => {}} onOpenHome={() => {}} /></I18nProvider>);
    expect(container.querySelector('.active-teams-strip-dot')!.getAttribute('data-tone')).toBe('needs');
    expect(container.querySelector('.active-teams-strip-paused')!.textContent).toBe('El coordinador está en pausa');
  });

  it('una suspensión por otro motivo sigue en gris', () => {
    const { container } = render(<I18nProvider><ActiveTeamsStrip runs={[summary({ suspendReason: 'paused_by_human' })]} onOpen={() => {}} onOpenHome={() => {}} /></I18nProvider>);
    expect(container.querySelector('.active-teams-strip-dot')!.getAttribute('data-tone')).toBe('idle');
    expect(container.querySelector('.active-teams-strip-paused')).toBeNull();
  });
});

describe('O2: el encabezado', () => {
  it('"Reanudar equipo" sobre un coordinador en pausa reanuda al coordinador', () => {
    const onResume = vi.fn();
    const onResumeCoordinator = vi.fn();
    const { container } = render(<I18nProvider>
      <RunHeader run={run()} title="Trabajo" coordinatorName="Asistente" formatTime={(v) => v} onResume={onResume} onResumeCoordinator={onResumeCoordinator} />
    </I18nProvider>);
    fireEvent.click(container.querySelector('.team-resume-coordination')!);
    expect(onResumeCoordinator).toHaveBeenCalledWith('coord');
    expect(onResume).not.toHaveBeenCalled();
    // Y la línea "Ahora" lo dice aunque el equipo no haya refrescado su estado.
    expect(container.querySelector('.coord-now')!.getAttribute('data-now')).toBe('coordinatorPaused');
  });

  it('una pausa del equipo hecha por la persona se reanuda como siempre', () => {
    const onResume = vi.fn();
    const onResumeCoordinator = vi.fn();
    const { container } = render(<I18nProvider>
      <RunHeader run={run({ suspendReason: 'paused_by_human' })} title="Trabajo" coordinatorName="Asistente" formatTime={(v) => v} onResume={onResume} onResumeCoordinator={onResumeCoordinator} />
    </I18nProvider>);
    fireEvent.click(container.querySelector('.team-resume-coordination')!);
    expect(onResume).toHaveBeenCalledWith('run1');
    expect(onResumeCoordinator).not.toHaveBeenCalled();
  });
});
