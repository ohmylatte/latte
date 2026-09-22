import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * El run terminado y la propuesta ilegible, vistos desde las tarjetas (B1.1).
 *
 * Estos casos salieron de `decisions-finished-run.dom.test.tsx`: las mismas
 * aserciones contra `TeamCards`, que es donde viven las tarjetas desde que se
 * mudaron al chat. Un run que cerro no ofrece NADA de un run vivo, y `active`
 * se lee explicito: que el backend ya devuelva cero gates para un run
 * terminado es una segunda defensa, no la razon por la que esto funciona.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render, screen } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamCardsProps } from './coordination/TeamCards';
import type { CoordinationGateView, CoordinationRunView } from '../shared/contracts';

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  lastEventAt: '2026-09-01T00:00:00.000Z', tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});
const gate = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'dispatch', runId: 'run1', prompt: 'Escribir el copy', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});

const base: TeamCardsProps = { memberId: 'coord', team: [], roles: [], formatDate: () => 'hace un rato' };
const mountCards = (props: Partial<TeamCardsProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamCards, { ...base, ...props }));
};

describe('un run terminado, visto desde las tarjetas del chat', () => {
  it('sobre un run terminado no queda una sola acción de run vivo', () => {
    mountCards({
      coordinationRun: run({ status: 'done', active: false, tasksDone: 1, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0 }),
      // Aunque el backend devolviera gates (no lo hace), la interfaz no depende de eso.
      gates: [gate(), gate({ id: 'g2', kind: 'proposal', proposalJson: JSON.stringify({ plan: [{ roleId: 'copywriter', spec: 'x' }], estimatedDispatches: 3, membersToHire: [], rationale: 'y' }) })],
      onResolveGate: () => {},
    });
    for (const label of [/^Aprobar$/, /^Rechazar$/, /^Editar y aprobar$/]) {
      expect(screen.queryAllByRole('button', { name: label })).toHaveLength(0);
    }
  });

  it('las tarjetas de gate no se renderizan sobre un run terminado', () => {
    const { container } = mountCards({
      coordinationRun: run({ status: 'cancelled', active: false }),
      gates: [gate(), gate({ id: 'g2', kind: 'plan' })],
      onResolveGate: () => {},
    });
    expect(container.querySelectorAll('.team-card')).toHaveLength(0);
  });

  it('un run VIVO sigue mostrando sus gates y sus botones', () => {
    const { container } = mountCards({
      coordinationRun: run({ status: 'running', active: true }),
      gates: [gate()],
      onResolveGate: () => {},
    });
    expect(container.querySelectorAll('.team-card')).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: /^Aprobar$/ }).length).toBeGreaterThan(0);
  });

  /**
   * B1.1: SIN RUN NO HAY DESTINATARIO, Y SIN DESTINATARIO NO HAY TARJETA.
   *
   * La regla cambio con la mudanza, y cambio para bien. Mientras las tarjetas
   * vivian en Decisiones alcanzaba con que existiera un gate: la pantalla era
   * una sola y de la marca. Ahora una tarjeta tiene que aparecer en el chat de
   * ALGUIEN, y quien recibe un gate es el coordinador del run. Sin run -- o
   * con un run sin coordinador -- elegir un miembro cualquiera seria inventar
   * un destinatario: no se dibuja en ningun chat.
   */
  it('sin `coordinationRun` no hay coordinador a quien mostrarselo: no se dibuja en ningun chat', () => {
    const { container } = mountCards({ gates: [gate()], onResolveGate: () => {} });
    expect(container.querySelector('.team-cards')).toBeNull();
  });
});

describe('una propuesta que no se puede leer', () => {
  it('un `proposalJson` sin `plan` muestra "propuesta ilegible" en vez de romper', () => {
    const { container } = mountCards({
      coordinationRun: run(),
      gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: JSON.stringify({ rationale: 'sin plan ninguno' }) })],
      onResolveGate: () => {},
    });
    const card = container.querySelector('.team-card-proposal');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.team-card-unreadable')).not.toBeNull();
  });

  it('un `proposalJson` que ni siquiera es JSON tampoco tira', () => {
    const { container } = mountCards({
      coordinationRun: run(),
      gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: '{esto no es json' })],
      onResolveGate: () => {},
    });
    expect(container.querySelector('.team-card-unreadable')).not.toBeNull();
  });

  /**
   * F4b: un JSON válido con un campo del tipo equivocado es tan ilegible como
   * un JSON roto. `{task.spec}` y `{proposal.rationale}` se renderizan como
   * hijos de React, así que un objeto ahí tira "Objects are not valid as a
   * React child" — y no hay ErrorBoundary: eso no rompe una tarjeta, deja la
   * app EN BLANCO, con el run `planning` ocupando el único cupo del Trabajo.
   */
  const illegible: Array<[string, unknown]> = [
    ['un `rationale` que es un objeto', { plan: [{ roleId: 'strategist', spec: 'x' }], estimatedDispatches: 3, rationale: {} }],
    ['un `spec` que es un objeto', { plan: [{ roleId: 'strategist', spec: {} }], estimatedDispatches: 3, rationale: 'ok' }],
    ['un `roleId` que es un número', { plan: [{ roleId: 7, spec: 'x' }], estimatedDispatches: 3, rationale: 'ok' }],
    ['un `why` que es un objeto', { plan: [{ roleId: 'strategist', spec: 'x' }], estimatedDispatches: 3, rationale: 'ok', membersToHire: [{ roleId: 'analyst', why: {} }] }],
  ];
  for (const [name, payload] of illegible) {
    it(`${name} cae en la tarjeta ilegible, sin tirar`, () => {
      const { container } = mountCards({
        coordinationRun: run(),
        gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: JSON.stringify(payload) })],
        onResolveGate: () => {},
      });
      const card = container.querySelector('.team-card-proposal');
      expect(card).not.toBeNull();
      expect(card!.querySelector('.team-card-unreadable')).not.toBeNull();
    });
  }

  it('una propuesta ilegible no ofrece Aprobar ni Editar: no hay nada que aprobar', () => {
    mountCards({
      coordinationRun: run(),
      gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: '{roto' })],
      onResolveGate: () => {},
    });
    expect(screen.queryAllByRole('button', { name: /^Aprobar$/ })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Editar y aprobar$/ })).toHaveLength(0);
    // Rechazar SÍ: descartar una propuesta rota es la salida.
    expect(screen.queryAllByRole('button', { name: /^Rechazar$/ }).length).toBeGreaterThan(0);
  });
});
