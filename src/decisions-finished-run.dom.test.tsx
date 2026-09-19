import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen } = await import('@testing-library/react');
const { DecisionsView } = await import('./DecisionsView');
import type { DecisionsViewProps } from './DecisionsView';
import type { CoordinationGateView, CoordinationRunView, Work } from '../shared/contracts';

/**
 * U1: Decisiones tiene que SABER si el equipo sigue vivo.
 *
 * `DecisionsViewProps` no recibía el run, así que la pantalla donde la persona
 * aprueba y rechaza no tenía forma de distinguir un equipo trabajando de uno
 * que ya cerró. Un run terminado se veía exactamente igual que uno vivo, con
 * sus tarjetas de gate y sus botones de Aprobar/Rechazar sobre algo que el
 * motor no va a ejecutar nunca más.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0, ...patch,
});

const base: DecisionsViewProps = {
  work, decisions: [], team: [], roles: [], permissions: 'ask', handoffs: [], decisionAuthority: 'suggest',
  draft: '', busy: false, formatDate: () => 'hace un rato', titlesByWork: { w1: 'Lanzamiento' },
  onDraftChange: () => {}, onAdd: () => {}, onApprove: () => {}, onEditApprove: () => {},
  onReject: () => {}, onArchive: () => {}, onAuthorityChange: () => {},
};

const mount = (props: Partial<DecisionsViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(DecisionsView, { ...base, ...props }));
};

const gate = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'dispatch', runId: 'run1', prompt: 'Escribir el copy', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});

describe('un run terminado, visto desde Decisiones', () => {
  it('dice cómo terminó, con las tres cuentas separadas', () => {
    const { container } = mount({ coordinationRun: run({ status: 'done', active: false, tasksDone: 4, tasksFailed: 1, tasksPending: 0 }) });
    const banner = container.querySelector('.decision-coordination-finished');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('4');
    expect(banner!.textContent).toContain('1');
    expect(banner!.textContent?.toLowerCase()).toContain('termin');
  });

  it('un run cancelado lo dice con sus propias palabras, no con las del terminado', () => {
    const { container } = mount({ coordinationRun: run({ status: 'cancelled', active: false, tasksDone: 1, tasksFailed: 0, tasksPending: 2 }) });
    const banner = container.querySelector('.decision-coordination-finished');
    expect(banner).not.toBeNull();
    expect(banner!.textContent?.toLowerCase()).toContain('cancel');
  });

  it('sobre un run terminado no queda una sola acción de run vivo', () => {
    mount({
      coordinationRun: run({ status: 'done', active: false, tasksDone: 1, tasksFailed: 0, tasksPending: 0 }),
      // Aunque el backend devolviera gates (no lo hace), la interfaz no depende de eso.
      gates: [gate(), gate({ id: 'g2', kind: 'proposal', proposalJson: JSON.stringify({ plan: [{ roleId: 'copywriter', spec: 'x' }], estimatedDispatches: 3, membersToHire: [], rationale: 'y' }) })],
      onResolveGate: () => {},
    });
    for (const label of [/^Aprobar$/, /^Rechazar$/, /^Editar y aprobar$/]) {
      expect(screen.queryAllByRole('button', { name: label })).toHaveLength(0);
    }
  });

  it('las tarjetas de gate no se renderizan sobre un run terminado', () => {
    const { container } = mount({
      coordinationRun: run({ status: 'cancelled', active: false }),
      gates: [gate(), gate({ id: 'g2', kind: 'plan' })],
      onResolveGate: () => {},
    });
    expect(container.querySelectorAll('.decision-gate')).toHaveLength(0);
  });

  it('un run VIVO sigue mostrando sus gates y sus botones, y no muestra el banner', () => {
    const { container } = mount({
      coordinationRun: run({ status: 'running', active: true }),
      gates: [gate()],
      onResolveGate: () => {},
    });
    expect(container.querySelector('.decision-coordination-finished')).toBeNull();
    expect(container.querySelectorAll('.decision-gate')).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: /^Aprobar$/ }).length).toBeGreaterThan(0);
  });

  it('sin `coordinationRun` (un llamador sin cablear) nada cambia: los gates se dibujan igual', () => {
    const { container } = mount({ gates: [gate()], onResolveGate: () => {} });
    expect(container.querySelector('.decision-coordination-finished')).toBeNull();
    expect(container.querySelectorAll('.decision-gate')).toHaveLength(1);
  });
});

describe('una propuesta que no se puede leer', () => {
  it('un `proposalJson` sin `plan` muestra "propuesta ilegible" en vez de romper', () => {
    const { container } = mount({
      coordinationRun: run(),
      gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: JSON.stringify({ rationale: 'sin plan ninguno' }) })],
      onResolveGate: () => {},
    });
    const card = container.querySelector('.decision-gate-proposal');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.decision-gate-unreadable')).not.toBeNull();
  });

  it('un `proposalJson` que ni siquiera es JSON tampoco tira', () => {
    const { container } = mount({
      coordinationRun: run(),
      gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: '{esto no es json' })],
      onResolveGate: () => {},
    });
    expect(container.querySelector('.decision-gate-unreadable')).not.toBeNull();
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
      const { container } = mount({
        coordinationRun: run(),
        gates: [gate({ id: 'gp', kind: 'proposal', proposalJson: JSON.stringify(payload) })],
        onResolveGate: () => {},
      });
      const card = container.querySelector('.decision-gate-proposal');
      expect(card).not.toBeNull();
      expect(card!.querySelector('.decision-gate-unreadable')).not.toBeNull();
    });
  }

  it('una propuesta ilegible no ofrece Aprobar ni Editar: no hay nada que aprobar', () => {
    mount({
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

/**
 * U4: el presupuesto de este Trabajo se puede ESCRIBIR.
 *
 * `setCoordinationBudget` existia en la IPC y no tenia un solo llamador en el
 * renderer. Peor: el copy del estado `invalid` promete "hasta que lo escribas
 * de nuevo, cada despacho se deniega" y no habia donde escribirlo. La persona
 * quedaba encerrada, con cada despacho denegado y una frase que la mandaba a
 * un campo que no existia.
 */
describe('el presupuesto de este Trabajo, editable', () => {
  const budgetEditor = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-edit');
  const input = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-input') as HTMLInputElement;
  const save = (container: HTMLElement) => container.querySelector('.decision-coordination-budget-save') as HTMLButtonElement;

  for (const state of ['unset', 'set', 'invalid'] as const) {
    it(`el editor esta disponible en \`${state}\``, () => {
      const budget = state === 'set' ? { state, budget: { maxDispatches: 5, unlimitedConfirmedAt: null } } as const : { state } as const;
      const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: budget, onSetCoordinationBudget: () => {} });
      expect(budgetEditor(container)).not.toBeNull();
    });
  }

  it('desde `invalid`, guardar manda el numero que la persona escribio', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' }, onSetCoordinationBudget });
    fireEvent.change(input(container), { target: { value: '12' } });
    fireEvent.click(save(container));
    expect(onSetCoordinationBudget).toHaveBeenCalledWith(12);
  });

  it('un valor que no es un entero positivo no manda nada: el boton esta deshabilitado', () => {
    const onSetCoordinationBudget = vi.fn();
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'unset' }, onSetCoordinationBudget });
    expect(save(container).disabled).toBe(true); // vacio
    for (const bad of ['0', '-3', '2.5', 'hola']) {
      fireEvent.change(input(container), { target: { value: bad } });
      fireEvent.click(save(container));
    }
    expect(onSetCoordinationBudget).not.toHaveBeenCalled();
  });

  it('sin `onSetCoordinationBudget` (un llamador sin cablear) no aparece ningun editor', () => {
    const { container } = mount({ coordinationAuthority: 'manual', coordinationBudget: { state: 'invalid' } });
    expect(budgetEditor(container)).toBeNull();
  });
});
