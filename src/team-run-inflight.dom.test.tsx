import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RunHeader } from './coordination/RunHeader';
import { I18nProvider } from './i18n';
import type { CoordinationRunView } from '../shared/contracts';

/**
 * B5.3: la cabecera del equipo dice lo que está en curso.
 *
 * Con una tarea despachada y dos en la cola, las dos frases de la línea vieja
 * mentían a la vez: "3 sin empezar" (había una trabajándose) y "Despachos:
 * 0 / 3" (ya había una comprometida contra el tope). La cuenta de vuelo viaja
 * aparte desde el motor.
 *
 * C1: y esas dos frases ya no existen. Lo que hay es una barra con tres tramos
 * —listas en verde, en curso en el acento, el resto gris— y el presupuesto en
 * una pastilla. La regla de B5.3 se conserva ENTERA: lo despachado no se
 * cuenta como "sin empezar", y lo comprometido cuenta contra el tope.
 */

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 3, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const mount = (view: CoordinationRunView) =>
  render(<I18nProvider><RunHeader run={view} title="Trabajo" coordinatorName="Estratega" formatTime={(v) => v} /></I18nProvider>);

const bar = (container: HTMLElement) => container.querySelector('[role="progressbar"]')!;
const widths = (container: HTMLElement) => [...bar(container).children].map((el) => (el as HTMLElement).style.width);
const budget = (container: HTMLElement) => container.querySelector('.coord-pill-dispatches')!.textContent ?? '';

describe('B5.3 + C1: la barra dice lo que está en vuelo', () => {
  it('lo despachado NO se cuenta como sin empezar: tiene su propio tramo', () => {
    const { container } = mount(run({ tasksInFlight: 1, tasksPending: 2 }));
    // 3 tareas: 0 listas, 1 en curso, 2 sin empezar.
    expect(bar(container).getAttribute('aria-valuemax')).toBe('3');
    expect(bar(container).getAttribute('aria-valuenow')).toBe('0');
    expect(widths(container)).toEqual(['0%', `${(1 / 3) * 100}%`, '0%']);
    expect(container.querySelector('.coord-progress-rest')!.textContent).toBe('1 en curso');
  });

  it('el presupuesto cuenta lo comprometido contra el tope', () => {
    const { container } = mount(run({ tasksInFlight: 1, tasksPending: 2 }));
    expect(budget(container)).toBe('0 / 3 despachos');
  });

  it('un despacho que termina pasa al tramo verde y al presupuesto usado', () => {
    const { container } = mount(run({ tasksDone: 1, tasksInFlight: 0, tasksPending: 2 }));
    expect(bar(container).getAttribute('aria-valuenow')).toBe('1');
    expect(container.querySelector('.coord-progress-done')!.textContent).toBe('1 de 3 listas');
    expect(container.querySelector('.coord-progress-rest')!.textContent).toBe('0 en curso');
    expect(budget(container)).toBe('1 / 3 despachos');
  });

  it('un despacho que falló tiene su propio tramo, y no es una tarea lista', () => {
    const { container } = mount(run({ tasksDone: 1, tasksFailed: 1, tasksPending: 1 }));
    expect(bar(container).getAttribute('aria-valuenow')).toBe('1');
    expect(widths(container)[2]).toBe(`${(1 / 3) * 100}%`);
    // Un intento que fracasó igual se gastó del presupuesto.
    expect(budget(container)).toBe('2 / 3 despachos');
  });

  it('un presupuesto ilegible sigue sin dibujarse como número', () => {
    const { container } = mount(run({ budgetInvalid: true, budget: null, tasksInFlight: 1 }));
    expect(budget(container)).toBe('Presupuesto ilegible');
    expect(budget(container)).not.toMatch(/\d/);
  });

  it('sin tope, el presupuesto cuenta sin prometer un límite que no hay', () => {
    const { container } = mount(run({ budget: { maxDispatches: null, unlimitedConfirmedAt: '2026-09-01T00:00:00.000Z' }, tasksDone: 2 }));
    expect(budget(container)).toBe('2 despachos');
  });
});

/**
 * R3: EL ENCABEZADO DICE EL PEDIDO, NO EL NOMBRE DEL TRABAJO.
 *
 * El nombre del Trabajo puede ser "Campaña Q4" mientras lo que la persona
 * pidió fue "armar el calendario de octubre". El pedido queda guardado al
 * aprobar la propuesta y el encabezado lo prefiere; el nombre del Trabajo
 * queda de respaldo para el run que no nació de un pedido.
 */
describe('R3: el encabezado prefiere el pedido sobre el nombre del Trabajo', () => {
  const name = (container: HTMLElement) => container.querySelector('.coord-head-name')?.textContent ?? '';

  it('muestra el pedido guardado cuando el run lo tiene', () => {
    const { container } = mount(run({ request: 'Armar el calendario de octubre' }));
    expect(name(container)).toBe('Armar el calendario de octubre');
    expect(name(container)).not.toBe('Trabajo');
  });

  it('cae al nombre del Trabajo cuando el run no nació de un pedido', () => {
    const { container } = mount(run({ request: null }));
    expect(name(container)).toBe('Trabajo');
  });
});
