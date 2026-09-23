import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { RunOutput } from './coordination/TeamOutcome';
import { whenOf } from './coordination/time';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationRunView, TeamMember } from '../shared/contracts';

/**
 * H2: "LO QUE PRODUJO EL EQUIPO" CADUCA.
 *
 * Uso real (2026-09-23, 9 de la mañana): el modo Equipo seguía encabezado por
 * el reporte fallido de un run CANCELADO ayer a las 18:50 ("No pude producir
 * ninguna de las 12 piezas…"), cuando el contenido ya se había producido en
 * otra conversación. "Esas notificaciones deberían caducar en algún momento."
 *
 * - Un run cancelado no produjo: una sola línea, sin encabezar reportes.
 * - Un reporte fallido que la misma tarea superó después no encabeza.
 * - Pasadas 24 h del cierre, el panel se pliega a una línea que se despliega a
 *   pedido; y las horas de otro día dicen "ayer HH:MM" o la fecha, nunca sólo
 *   la hora.
 *
 * Las fechas se arman con el constructor LOCAL: "ayer" es un día del
 * calendario de la persona, no de UTC.
 */

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 23, 9, 0).getTime();

const team: TeamMember[] = [{
  id: 'cm', workId: 'w1', roleId: 'community-manager', roleName: 'Community Manager', initial: 'C', avatar: null,
  runtime: 'claude', model: null, accountId: null, label: 'Claude', status: 'idle', tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
}];

const run = (patch: Partial<CoordinationRunView>): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'done', coordinatorMemberId: 'cm',
  budget: { maxDispatches: 6, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: false, createdAt: at(22, 17), updatedAt: at(22, 19, 32), lastEventAt: '',
  tasksDone: 4, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const report = (id: string, taskId: string, settledAt: string, patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id, taskId, memberId: 'cm', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Piezas del mes', summaryPreview: `Listo ${id}`,
  createdAt: settledAt, startedAt: settledAt, settledAt, ...patch,
});

const failed = (id: string, taskId: string, settledAt: string) => report(id, taskId, settledAt, {
  status: 'failed', outcome: 'failed', summaryPreview: 'No pude producir ninguna de las 12 piezas',
});

const mount = (props: { run: CoordinationRunView; log: CoordinationLogEntryView[]; now?: number }) =>
  render(<RunOutput run={props.run} log={props.log} team={team} formatTime={(v) => new Date(v).toTimeString().slice(0, 5)} now={props.now ?? NOW} />);

describe('H2: lo que produjo el equipo caduca', () => {
  it('un run cancelado ayer es UNA línea: sin título de lo producido y sin el reporte fallido', () => {
    const cancelled = run({ status: 'cancelled', updatedAt: at(22, 23, 19), tasksDone: 0, tasksFailed: 1, tasksPending: 11 });
    const { container } = mount({ run: cancelled, log: [failed('d1', 't1', at(22, 18, 50))] });

    const line = container.querySelector('.coord-output-line');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('Cancelado ayer 23:19');
    expect(line!.textContent).toContain('Bitácora · 1 evento');
    expect(container.querySelector('.coord-output-title')).toBeNull();
    expect(container.querySelectorAll('.coord-output-row')).toHaveLength(0);
    expect(container.textContent).not.toContain('No pude producir');
    // La bitácora sigue a un clic.
    fireEvent.click(line!.querySelector('button')!);
    expect(container.querySelectorAll('.coord-log-row')).toHaveLength(1);
  });

  it('un run terminado hoy se ve completo', () => {
    const today = run({ updatedAt: at(23, 8, 30) });
    const { container } = mount({ run: today, log: [report('d1', 't1', at(23, 8, 10)), report('d2', 't2', at(23, 8, 30))] });

    expect(container.querySelector('.coord-output-line')).toBeNull();
    expect(container.querySelector('.coord-output-title')!.textContent).toBe('Lo que produjo el equipo');
    expect(container.querySelectorAll('.coord-output-row')).toHaveLength(2);
  });

  it('un run terminado hace dos días está plegado a una línea, y se despliega a pedido', () => {
    const old = run({ updatedAt: at(21, 19, 32) });
    const { container } = mount({ run: old, log: [report('d1', 't1', at(21, 19, 0))] });

    const line = container.querySelector('.coord-output-line');
    expect(line).not.toBeNull();
    // Otro día: la fecha, nunca sólo la hora.
    expect(line!.textContent).toContain(`Terminado ${whenOf(at(21, 19, 32), { now: NOW })}`);
    expect(line!.textContent).not.toMatch(/Terminado 19:32/);
    expect(line!.textContent).toContain('4 de 4');
    expect(container.querySelectorAll('.coord-output-row')).toHaveLength(0);

    fireEvent.click([...line!.querySelectorAll('button')].find((b) => b.textContent === 'Ver lo producido')!);
    expect(container.querySelectorAll('.coord-output-row')).toHaveLength(1);
  });

  it('terminado ayer hace menos de 24 h: completo, y la hora de ayer dice "ayer"', () => {
    const yesterday = run({ updatedAt: at(22, 19, 32) });
    const { container } = mount({ run: yesterday, log: [report('d1', 't1', at(22, 19, 30))] });

    expect(container.querySelector('.coord-output-line')).toBeNull();
    expect(container.querySelector('.coord-output-row time')!.textContent).toBe('ayer 19:30');
  });

  it('un reporte fallido que la misma tarea superó después no encabeza', () => {
    const today = run({ updatedAt: at(23, 8, 30) });
    const { container } = mount({ run: today, log: [failed('d1', 't1', at(23, 8, 0)), report('d2', 't1', at(23, 8, 20))] });

    const rows = [...container.querySelectorAll('.coord-output-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classList.contains('is-failed')).toBe(false);
    expect(container.textContent).not.toContain('No pude producir');
  });

  it('un fallido que nadie superó sigue a la vista', () => {
    const today = run({ updatedAt: at(23, 8, 30), tasksDone: 1, tasksFailed: 1 });
    const { container } = mount({ run: today, log: [report('d1', 't1', at(23, 8, 0)), failed('d2', 't2', at(23, 8, 20))] });

    expect(container.querySelectorAll('.coord-output-row.is-failed')).toHaveLength(1);
  });
});

describe('whenOf: la hora dice de qué día es', () => {
  it('hoy es la hora; ayer es "ayer HH:MM"; antes, fecha corta y hora', () => {
    expect(whenOf(at(23, 8, 5), { now: NOW })).toBe('08:05');
    expect(whenOf(at(22, 23, 19), { now: NOW })).toBe('ayer 23:19');
    expect(whenOf(at(22, 23, 19), { now: NOW, locale: 'en-US', yesterday: 'yesterday' })).toBe('yesterday 23:19');
    const older = whenOf(at(20, 7, 0), { now: NOW });
    expect(older).toMatch(/20/);
    expect(older).toMatch(/07:00$/);
    expect(older).not.toBe('07:00');
    expect(whenOf('no-es-fecha', { now: NOW })).toBe('');
  });
});
