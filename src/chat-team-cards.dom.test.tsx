import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ChatSession, CoordinationGateView, CoordinationRunView } from '../shared/contracts';
import { ChatPane } from './ChatPane';
import { chatStore } from './browser-api';

/**
 * B1.1: LA SECCIÓN "DEL EQUIPO" VIVE ARRIBA DEL COMPOSER, FUERA DEL SCROLL.
 *
 * Una aprobación dibujada dentro de la conversación se va hacia arriba con el
 * primer mensaje nuevo: es exactamente la aprobación que la persona no ve. Va
 * fija, entre el scroll y el campo de escribir, que es donde la persona ya
 * está mirando cuando el equipo le pide algo.
 */

let sessionId = '';
const session = (): ChatSession => ({
  id: sessionId, workId: 'w1', provider: 'claude', model: null, accountId: null,
  label: 'Claude Code', resumed: false, roleId: 'strategist', roleName: 'Estrategia', historyRecovered: true,
});

const run = (coordinatorMemberId: string): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId,
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0,
});
const gate: CoordinationGateView = { id: 'g1', kind: 'dispatch', runId: 'run1', prompt: 'Escribir el copy', createdAt: '' };

let index = 0;
beforeEach(() => { sessionId = `chat-cards-${++index}`; });
afterEach(() => { chatStore.forget(sessionId); });

describe('las tarjetas del equipo en el chat', () => {
  // B3.2: ya no nacen desplegadas — la línea plegada vive en el mismo lugar
  // y las tarjetas se abren debajo de ella, entre el scroll y el composer.
  it('se renderizan entre el scroll de la conversación y el formulario de escribir', () => {
    const { container } = render(<ChatPane session={session()} onStop={() => undefined} onError={() => undefined}
      coordination={{ coordinationRun: run(sessionId), gates: [gate], onResolveGate: () => {}, initiallyExpanded: true }} />);
    const pane = container.querySelector('.chat-pane')!;
    const kids = [...pane.children];
    const cards = container.querySelector('section.team-cards')!;
    expect(cards).not.toBeNull();
    expect(kids.indexOf(cards)).toBeGreaterThan(kids.indexOf(container.querySelector('.chat-scroll')!));
    expect(kids.indexOf(cards)).toBeLessThan(kids.indexOf(container.querySelector('form.prompt-form')!));
    expect(kids.indexOf(container.querySelector('.team-cards-collapsed')!)).toBeGreaterThan(kids.indexOf(container.querySelector('.chat-scroll')!));
    // B4.3a: la sección la NOMBRA el encabezado plegable, y sólo él. El título
    // de adentro decía lo mismo un renglón más abajo y se comía el alto que
    // las tarjetas necesitan para verse.
    expect(container.querySelector('.team-cards-collapsed')!.textContent).toContain('El equipo te espera');
    expect(cards.querySelector('.team-cards-title')).toBeNull();
  });

  it('sin la prop de coordinación el chat queda exactamente como estaba', () => {
    const { container } = render(<ChatPane session={session()} onStop={() => undefined} onError={() => undefined} />);
    expect(container.querySelector('.team-cards')).toBeNull();
  });

  it('el chat de OTRO miembro del mismo Trabajo muestra la línea de espera, no la tarjeta', () => {
    const { container } = render(<ChatPane session={session()} onStop={() => undefined} onError={() => undefined}
      coordination={{ coordinationRun: run('otro-miembro'), gates: [gate], onResolveGate: () => {} }} />);
    expect(container.querySelector('[data-gate-kind="dispatch"]')).toBeNull();
    expect(container.querySelector('.team-cards-waiting')).not.toBeNull();
  });
});
