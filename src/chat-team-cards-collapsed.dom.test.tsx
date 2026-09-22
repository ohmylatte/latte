import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B3.2: EL CHAT ES SOLO CHAT.
 *
 * Las tarjetas del equipo viven arriba del composer desde B1.1, y ahí tienen
 * que estar: una aprobación dentro del scroll se va hacia arriba con el primer
 * mensaje nuevo. Pero DESPLEGADAS le comen hasta 46vh a la conversación, todo
 * el tiempo, aunque la persona no esté por aprobar nada en este segundo.
 *
 * Plegadas son UNA línea que dice qué hay —"El equipo te espera: 1 propuesta"—
 * y se abren al tocarla. Sin nada para este miembro no se dibuja nada: la
 * línea que promete pendientes que no existen es peor que el silencio.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { fireEvent, render } = await import('@testing-library/react');
const { ChatPane } = await import('./ChatPane');
const { chatStore } = await import('./browser-api');
import type { ChatSession, CoordinationAskView, CoordinationGateView, CoordinationRunView } from '../shared/contracts';

let sessionId = '';
const session = (): ChatSession => ({
  id: sessionId, workId: 'w1', provider: 'claude', model: null, accountId: null,
  label: 'Claude Code', resumed: false, roleId: 'strategist', roleName: 'Estrategia', historyRecovered: true,
});
const run = (coordinatorMemberId: string): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId,
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
});
const gate = (id: string, kind: CoordinationGateView['kind']): CoordinationGateView => ({ id, kind, runId: 'run1', prompt: 'Escribir el copy', createdAt: '' });
const ask = (id: string, memberId: string): CoordinationAskView => ({
  id, runId: 'run1', taskId: null, memberId, question: '¿Seguimos?', answer: null, deadlineAt: '', answeredAt: null, createdAt: '',
});

let index = 0;
beforeEach(() => { sessionId = `chat-collapsed-${++index}`; ui.locale = 'es-AR'; });
afterEach(() => { chatStore.forget(sessionId); });

const mount = (coordination: Record<string, unknown>) => render(
  <ChatPane session={session()} onStop={() => undefined} onError={() => undefined} coordination={coordination as never} />,
);

describe('B3.2: la línea plegada', () => {
  it('por defecto las tarjetas están plegadas en UNA línea, no desplegadas', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'proposal')], onResolveGate: () => {} });
    const line = container.querySelector('.team-cards-collapsed')!;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain('El equipo te espera');
    expect(line.textContent).toContain('1 propuesta');
    expect(container.querySelector('[data-gate-kind="proposal"]')).toBeNull();
  });

  it('nombra QUÉ hay, por tipo, y con su número', () => {
    const cases: Array<[CoordinationGateView['kind'], string]> = [
      ['proposal', '1 propuesta'], ['dispatch', '1 despacho'], ['plan', '1 plan'], ['budget', '1 presupuesto'],
    ];
    for (const [kind, phrase] of cases) {
      const { container, unmount } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', kind)], onResolveGate: () => {} });
      expect(container.querySelector('.team-cards-collapsed')!.textContent, kind).toContain(phrase);
      unmount();
    }
  });

  it('en plural lleva el número', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'dispatch'), gate('g2', 'dispatch')], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards-collapsed')!.textContent).toContain('2 despachos');
  });

  it('una pregunta es una pregunta, no un despacho', () => {
    const { container } = mount({ coordinationRun: run('otro'), openAsks: [ask('a1', sessionId)], onAnswerAsk: () => {} });
    expect(container.querySelector('.team-cards-collapsed')!.textContent).toContain('1 pregunta');
  });

  it('mezclando tipos no se elige uno al azar: se dice cuántos pendientes hay', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'dispatch')], openAsks: [ask('a1', sessionId)], onResolveGate: () => {} });
    const text = container.querySelector('.team-cards-collapsed')!.textContent ?? '';
    expect(text).toContain('2 pendientes');
    expect(text).not.toContain('despacho');
  });

  it('al tocarla se despliegan las tarjetas, y al tocarla de nuevo se vuelven a plegar', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'dispatch')], onResolveGate: () => {} });
    const line = () => container.querySelector('.team-cards-collapsed') as HTMLButtonElement;
    expect(line().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(line());
    expect(container.querySelector('[data-gate-kind="dispatch"]')).not.toBeNull();
    expect(line().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(line());
    expect(container.querySelector('[data-gate-kind="dispatch"]')).toBeNull();
  });

  /**
   * B3.5: llegar desde un pendiente ES pedir ver ese pendiente. La fila de
   * Inicio "te espera una aprobación" y la tira lateral abren la conversación
   * del coordinador justamente para eso; hacerle tocar otra línea más sería
   * cobrarle un clic por lo que ya pidió.
   */
  it('llegando desde un pendiente, arrancan DESPLEGADAS', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'dispatch')], onResolveGate: () => {}, initiallyExpanded: true });
    expect(container.querySelector('[data-gate-kind="dispatch"]')).not.toBeNull();
    expect(container.querySelector('.team-cards-collapsed')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('y el aviso llega tambien con el chat YA montado', () => {
    const props = { coordinationRun: run(sessionId), gates: [gate('g1', 'dispatch')], onResolveGate: () => {} };
    const { container, rerender } = render(
      <ChatPane session={session()} onStop={() => undefined} onError={() => undefined} coordination={props as never} />,
    );
    expect(container.querySelector('[data-gate-kind="dispatch"]')).toBeNull();
    rerender(<ChatPane session={session()} onStop={() => undefined} onError={() => undefined} coordination={{ ...props, initiallyExpanded: true } as never} />);
    expect(container.querySelector('[data-gate-kind="dispatch"]')).not.toBeNull();
  });

  /** C6: sin pendientes no hay linea PLEGABLE; hay la linea del plan aprobado. */
  it('sin pendientes para este miembro no hay nada que plegar', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [], openAsks: [], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards-collapsed')).toBeNull();
    expect(container.querySelector('.team-card-proposal')).toBeNull();
    expect(container.querySelector('.coord-approved')).not.toBeNull();
  });

  it('lo que espera en OTRO chat sigue siendo una sola línea, sin tarjeta y sin plegado', () => {
    const { container } = mount({ coordinationRun: run('otro-miembro'), gates: [gate('g1', 'dispatch')], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards-collapsed')).toBeNull();
    expect(container.querySelector('.team-cards-waiting')).not.toBeNull();
    expect(container.querySelector('[data-gate-kind="dispatch"]')).toBeNull();
  });

  it('la misma línea en inglés, sin nada en castellano', () => {
    ui.locale = 'en-US';
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'proposal')], onResolveGate: () => {} });
    const text = container.querySelector('.team-cards-collapsed')!.textContent ?? '';
    expect(text).toContain('1 proposal');
    expect(text).not.toContain('propuesta');
    expect(text).not.toContain('El equipo');
  });
  /**
   * B4.3a: EL TITULO NO SE DICE DOS VECES.
   *
   * Con el encabezado plegable presente, la seccion desplegada repetia «Del
   * equipo» adentro: el mismo rotulo, dos renglones seguidos, y uno de ellos
   * comiendose el alto que las tarjetas necesitan para verse.
   */
  it('desplegada bajo el encabezado plegable, no repite el titulo adentro', () => {
    const { container } = mount({ coordinationRun: run(sessionId), gates: [gate('g1', 'proposal')], onResolveGate: () => {} });
    fireEvent.click(container.querySelector('.team-cards-collapsed')!);
    expect(container.querySelector('[data-gate-kind="proposal"]')).not.toBeNull();
    expect(container.querySelector('.team-cards .team-cards-title')).toBeNull();
  });

  /** Sin encabezado plegable el titulo sigue siendo lo unico que nombra la seccion. */
  it('la linea de "esto espera en otro chat" no depende del titulo', () => {
    const { container } = mount({ coordinationRun: run('otro-miembro'), gates: [gate('g1', 'dispatch')], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards-waiting')).not.toBeNull();
  });
});
