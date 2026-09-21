import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render, within } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
import type { TeamCardsProps } from './coordination/TeamCards';
import type { CoordinationGateView, CoordinationProposal, CoordinationRunView, Work } from '../shared/contracts';

/**
 * Ronda 8 (M4): LA MISMA REGLA EN LAS CINCO TARJETAS.
 *
 * `TeamCards` renderiza cinco tarjetas de decisión —plan, presupuesto,
 * despacho, propuesta legible y propuesta ilegible— y sólo UNA (la propuesta
 * legible, por N10) escondía sus botones cuando no había `onResolveGate`. Las
 * otras cuatro ofrecían "Aprobar" y "Rechazar" que no hacían absolutamente
 * nada: un clic en el vacío, sin un solo aviso. Y la que sí los escondía los
 * escondía en silencio, sin decir que la tarjeta era de sólo lectura.
 *
 * La regla, una sola para las cinco:
 *
 *  - sin `onResolveGate`: NINGÚN botón de acción, y una nota que dice por qué;
 *  - con `onResolveGate`: "Rechazar" está SIEMPRE. Descartar algo que no se
 *    puede aprobar —o que no se puede leer— es la salida que nunca puede
 *    faltar.
 */

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
  plan: [{ roleId: 'copywriter', spec: 'Escribir 3 posts para el lanzamiento' }],
  estimatedDispatches: 8,
  membersToHire: [],
  rationale: 'El equipo actual no alcanza para el volumen del mes.',
  ...patch,
});


/**
 * Las tarjetas se mudaron al chat del miembro al que le corresponden (B1.1).
 * Un gate es una conversación con el COORDINADOR, así que el run de este
 * archivo lo nombra y el chat que se monta es el suyo. Las aserciones son las
 * mismas: lo que cambió es la casa, no la regla.
 */
const runView: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0,
};

const base: TeamCardsProps = { memberId: 'coord', coordinationRun: runView, team: [], roles: [], formatDate: () => 'hace un rato' };

beforeEach(() => { ui.locale = 'es-AR'; });

function renderGate(gate: CoordinationGateView, onResolveGate?: TeamCardsProps['onResolveGate']) {
  return render(createElement(TeamCards, { ...base, gates: [gate], onResolveGate }));
}

const gate = (patch: Partial<CoordinationGateView>): CoordinationGateView => ({
  id: 'g1', kind: 'plan', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});

/** Las cinco, cada una con su gate y su selector. */
const CARDS = [
  { name: 'plan', gate: gate({ kind: 'plan' }), selector: '.team-card-plan' },
  { name: 'presupuesto', gate: gate({ kind: 'budget' }), selector: '.team-card-budget' },
  { name: 'despacho', gate: gate({ kind: 'dispatch', prompt: 'Escribí los posts' }), selector: '.team-card-dispatch' },
  { name: 'propuesta legible', gate: gate({ kind: 'proposal', proposalJson: JSON.stringify(proposal()) }), selector: '.team-card-proposal' },
  { name: 'propuesta ilegible', gate: gate({ kind: 'proposal', proposalJson: '{ esto no es json' }), selector: '.team-card-proposal' },
] as const;

describe('M4: sin handler, las cinco tarjetas son de sólo lectura y lo dicen', () => {
  // Un test que depende de encontrar algo tiene que fallar cuando no lo encuentra.
  it('las cinco tarjetas se renderizan de verdad', () => {
    expect(CARDS).toHaveLength(5);
    for (const { name, gate: g, selector } of CARDS) {
      const { container, unmount } = renderGate(g, vi.fn());
      expect(container.querySelector(selector), name).not.toBeNull();
      unmount();
    }
  });

  it.each(CARDS.map((c) => [c.name, c] as const))('%s: sin `onResolveGate` no hay ningún botón de acción', (_name, card) => {
    const { container } = renderGate(card.gate);
    const el = container.querySelector(card.selector)!;
    expect(within(el as HTMLElement).queryByRole('button')).toBeNull();
  });

  it.each(CARDS.map((c) => [c.name, c] as const))('%s: sin `onResolveGate` se explica que es de sólo lectura', (_name, card) => {
    const { container } = renderGate(card.gate);
    const el = container.querySelector(card.selector)!;
    expect(el.querySelector('.team-card-readonly')).not.toBeNull();
    expect(el.textContent).toContain('sólo lectura');
  });

  it.each(CARDS.map((c) => [c.name, c] as const))('%s: CON `onResolveGate`, "Rechazar" está y la nota no', (_name, card) => {
    const { container } = renderGate(card.gate, vi.fn());
    const el = container.querySelector(card.selector)! as HTMLElement;
    expect(within(el).getByRole('button', { name: 'Rechazar' })).toBeTruthy();
    expect(el.querySelector('.team-card-readonly')).toBeNull();
  });

  it('la nota existe en inglés también', () => {
    ui.locale = 'en-US';
    const { container } = renderGate(CARDS[0].gate);
    const note = container.querySelector('.team-card-readonly')!;
    expect(note.textContent?.trim().length).toBeGreaterThan(0);
    expect(note.textContent).not.toContain('sólo lectura');
  });
});
