import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CoordinationRunControls } from './TeamPanel';
import { I18nProvider } from './i18n';
import type { CoordinationRunView } from '../shared/contracts';

/**
 * B5.3: la cabecera del equipo dice lo que está en curso.
 *
 * Con una tarea despachada y dos en la cola, las dos frases de esta línea
 * mentían a la vez: "3 sin empezar" (había una trabajándose) y "Despachos:
 * 0 / 3" (ya había una comprometida contra el tope). La cuenta de vuelo viaja
 * aparte desde el motor y las dos frases la muestran.
 */

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const mount = (view: CoordinationRunView) =>
  render(<I18nProvider><CoordinationRunControls run={view} busy={false} /></I18nProvider>);

describe('B5.3: los contadores del run dicen lo que está en vuelo', () => {
  it('la línea de cuentas separa en curso de sin empezar', () => {
    const { container } = mount(run({ tasksInFlight: 1, tasksPending: 2 }));
    const counts = container.querySelector('.team-coordination-counts')!.textContent ?? '';
    expect(counts).toContain('1 en curso');
    expect(counts).toContain('2 sin empezar'); // ya no las 3
    expect(counts).not.toContain('3 sin empezar');
  });

  it('el presupuesto muestra lo usado Y lo comprometido', () => {
    const { container } = mount(run({ tasksInFlight: 1, tasksPending: 2 }));
    const budget = container.querySelector('.team-coordination-budget')!.textContent ?? '';
    expect(budget).toContain('0 usados');
    expect(budget).toContain('1 en curso');
    expect(budget).toContain('3'); // el tope
  });

  it('un despacho que termina deja de contarse en vuelo', () => {
    const { container } = mount(run({ tasksDone: 1, tasksInFlight: 0, tasksPending: 2 }));
    const counts = container.querySelector('.team-coordination-counts')!.textContent ?? '';
    expect(counts).toContain('1 listas');
    expect(counts).toContain('0 en curso');
    const budget = container.querySelector('.team-coordination-budget')!.textContent ?? '';
    expect(budget).toContain('1 usados');
  });

  it('un presupuesto ilegible sigue sin dibujarse como número', () => {
    const { container } = mount(run({ budgetInvalid: true, budget: null, tasksInFlight: 1 }));
    const budget = container.querySelector('.team-coordination-budget')!.textContent ?? '';
    expect(budget).not.toContain('en curso');
  });
});
