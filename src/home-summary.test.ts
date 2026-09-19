import { describe, expect, it } from 'vitest';
import { HOME_STEP_KEYS, homeStep, homeSummary, sinceLastVisitFromActiveRuns, type HomeInput, type HomeLadderInput } from './home-summary';
import type { CoordinationActiveRunSummary, Decision, DocumentState, WorkDocument } from '../shared/contracts';

/**
 * The pure core of Inicio: which of the loaded facts wins, how the three cards
 * are shaped, and how an absent signal is told without inventing a zero.
 *
 * No DOM, no window: this module only decides, `HomeView` only renders.
 */

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una campaña con nombre', fileName: 'oferta.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '', decidedAt: null, ...patch,
});

const ladder = (patch: Partial<HomeLadderInput> = {}): HomeLadderInput => ({
  hasBrand: true,
  brandContextDefined: true,
  pendingDecisions: 0,
  pendingContextProposals: 0,
  reviewDocuments: 0,
  checking: false,
  liveWorkIds: [],
  workCount: 1,
  ...patch,
});

const input = (patch: Partial<HomeInput> = {}): HomeInput => ({
  hasBrand: true,
  brandContextDefined: true,
  works: [{ id: 'w1', title: 'Lanzamiento', updatedAt: '2026-09-01T00:00:00.000Z' }],
  liveWorkIds: [],
  decisions: [],
  pendingContextProposals: 0,
  documents: [],
  states: {},
  checking: false,
  ...patch,
});

describe('the Inicio next-step ladder', () => {
  it('starts with the brand when there is none', () => {
    expect(homeStep(ladder({ hasBrand: false, workCount: 0 }))).toBe('start');
  });

  it('puts an empty brand context right after the brand itself', () => {
    expect(homeStep(ladder({ brandContextDefined: false, pendingDecisions: 3, reviewDocuments: 2 }))).toBe('brand');
  });

  it('puts pending decisions above a pending context proposal', () => {
    expect(homeStep(ladder({ pendingDecisions: 1, pendingContextProposals: 2 }))).toBe('decisions');
  });

  it('asks to review the context proposal when that is the only pending thing', () => {
    expect(homeStep(ladder({ pendingContextProposals: 1 }))).toBe('context');
  });

  it('asks for a review only when nothing else is pending', () => {
    expect(homeStep(ladder({ reviewDocuments: 2 }))).toBe('review');
  });

  it('says it is checking instead of claiming there is nothing pending', () => {
    expect(homeStep(ladder({ checking: true }))).toBe('checking');
  });

  it('never lets a running sweep mask a review that is already known', () => {
    expect(homeStep(ladder({ checking: true, reviewDocuments: 3 }))).toBe('review');
  });

  it('never lets a running sweep outrank the brand, the decisions or the proposal', () => {
    expect(homeStep(ladder({ hasBrand: false, checking: true, workCount: 0 }))).toBe('start');
    expect(homeStep(ladder({ brandContextDefined: false, checking: true }))).toBe('brand');
    expect(homeStep(ladder({ checking: true, pendingDecisions: 2 }))).toBe('decisions');
    expect(homeStep(ladder({ checking: true, pendingContextProposals: 1 }))).toBe('context');
  });

  it('names a work with activity before asking for a brand-new work', () => {
    expect(homeStep(ladder({ liveWorkIds: ['w1'] }))).toBe('live');
  });

  it('asks for the first work only when the brand has none', () => {
    expect(homeStep(ladder({ workCount: 0 }))).toBe('works');
  });

  it('is none only when every fact is known and clear', () => {
    expect(homeStep(ladder())).toBe('none');
  });

  it('names every rung with a catalog key of its own', () => {
    expect(HOME_STEP_KEYS).toEqual({
      start: 'home.next.start',
      brand: 'orientation.next.brand',
      decisions: 'orientation.next.decisions',
      context: 'home.next.context',
      review: 'orientation.next.review',
      checking: 'orientation.next.checking',
      live: 'home.next.live',
      works: 'home.next.works',
      none: 'orientation.next.none',
    });
  });
});

describe('the summary Inicio renders', () => {
  it('orders Continuar by updatedAt descending, never by the order it was handed', () => {
    const summary = homeSummary(input({
      works: [
        { id: 'w2', title: 'Segundo', updatedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'w3', title: 'Tercero', updatedAt: '2026-10-01T00:00:00.000Z' },
        { id: 'w1', title: 'Primero', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    }));
    expect(summary.continueRows.map(r => r.id)).toEqual(['w3', 'w1', 'w2']);
  });

  it('marks the live badge from the live work ids and from nothing else', () => {
    const summary = homeSummary(input({
      works: [
        { id: 'w1', title: 'Con agente', updatedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'w2', title: 'Sin agente', updatedAt: '2026-09-02T00:00:00.000Z' },
      ],
      liveWorkIds: ['w1'],
    }));
    expect(summary.continueRows.map(r => [r.id, r.live])).toEqual([['w2', false], ['w1', true]]);
  });

  it('carries the work title on every decision row, from the works it was given', () => {
    const summary = homeSummary(input({
      works: [{ id: 'w1', title: 'Lanzamiento', updatedAt: '' }],
      decisions: [decision({ id: 'd1', workId: 'w1' })],
    }));
    expect(summary.decisionRows).toEqual([{ id: 'd1', workId: 'w1', workTitle: 'Lanzamiento', text: 'Elegimos un tono cercano' }]);
  });

  it('leaves the work title empty instead of inventing one for an unknown work', () => {
    const summary = homeSummary(input({ decisions: [decision({ workId: 'nope' })] }));
    expect(summary.decisionRows[0].workTitle).toBe('');
  });

  it('lists a document to review when it waits for review, and when its base moved', () => {
    const documents = [
      doc({ id: 'a', title: 'En revisión', status: 'review' }),
      doc({ id: 'b', title: 'Base vieja', status: 'approved' }),
      doc({ id: 'c', title: 'Al día', status: 'draft' }),
    ];
    const states: Record<string, DocumentState> = {
      b: { documentId: 'b', fingerprint: 'fp', modifiedAt: null, baseOutdated: true },
      c: { documentId: 'c', fingerprint: 'fp', modifiedAt: null, baseOutdated: false },
    };
    const summary = homeSummary(input({ documents, states }));
    expect(summary.reviewRows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('renders nothing for the empty signals instead of a zero', () => {
    const summary = homeSummary(input({ works: [], documents: [], decisions: [] }));
    expect(summary.continueRows).toEqual([]);
    expect(summary.decisionRows).toEqual([]);
    expect(summary.reviewRows).toEqual([]);
    expect(summary.showNewWork).toBe(true);
  });

  it('reports no work to create while the brand already has one', () => {
    expect(homeSummary(input()).showNewWork).toBe(false);
  });

  it('carries the step, its key and the counts the plural branch reads', () => {
    const decisions = homeSummary(input({ decisions: [decision({ id: 'd1' }), decision({ id: 'd2' })] }));
    expect(decisions.step).toBe('decisions');
    expect(decisions.stepKey).toBe('orientation.next.decisions');
    expect(decisions.stepParams).toEqual({ count: 2 });

    const review = homeSummary(input({ documents: [doc({ status: 'review' })] }));
    expect(review.step).toBe('review');
    expect(review.stepKey).toBe('orientation.next.review');
    expect(review.stepParams).toEqual({ count: 1 });
  });

  it('asks for no params in the steps that take none', () => {
    expect(homeSummary(input({ hasBrand: false })).stepParams).toEqual({});
    expect(homeSummary(input({ checking: true })).stepParams).toEqual({});
    expect(homeSummary(input()).stepParams).toEqual({});
  });

  it('never counts a document whose base moved as clear just because it is a draft', () => {
    const states: Record<string, DocumentState> = {
      a: { documentId: 'a', fingerprint: 'fp', modifiedAt: null, baseOutdated: true },
    };
    const summary = homeSummary(input({ documents: [doc({ id: 'a', status: 'draft' })], states }));
    expect(summary.reviewRows.map(r => r.id)).toEqual(['a']);
    expect(summary.step).toBe('review');
  });

  it('is pure: the same facts produce the same summary', () => {
    const facts = input({ works: [], decisions: [decision()], checking: true });
    expect(homeSummary(facts)).toEqual(homeSummary(facts));
  });
});

describe('the since-last-visit card (additive, autonomous-coordination Phase 7)', () => {
  it('renders no rows when the caller has not wired coordination state', () => {
    const summary = homeSummary(input());
    expect(summary.sinceLastVisitRows).toEqual([]);
  });

  it('renders no rows for an explicitly empty list — zero rows is never a zero', () => {
    const summary = homeSummary(input({ coordinationSinceLastVisit: [] }));
    expect(summary.sinceLastVisitRows).toEqual([]);
  });

  it('resolves the work title from the works it was given, one row per event, order preserved', () => {
    const summary = homeSummary(input({
      works: [{ id: 'w1', title: 'Lanzamiento', updatedAt: '' }],
      coordinationSinceLastVisit: [
        { id: 'e1', workId: 'w1', kind: 'done', sinceVisit: true },
        { id: 'e2', workId: 'w1', kind: 'awaitingYou', sinceVisit: true },
      ],
    }));
    expect(summary.sinceLastVisitRows).toEqual([
      { id: 'e1', workId: 'w1', workTitle: 'Lanzamiento', kind: 'done', sinceVisit: true },
      { id: 'e2', workId: 'w1', workTitle: 'Lanzamiento', kind: 'awaitingYou', sinceVisit: true },
    ]);
  });

  it('leaves the work title empty instead of inventing one for an unknown work', () => {
    const summary = homeSummary(input({ coordinationSinceLastVisit: [{ id: 'e1', workId: 'nope', kind: 'failed', sinceVisit: true }] }));
    expect(summary.sinceLastVisitRows[0].workTitle).toBe('');
  });
});

/**
 * `sinceLastVisitFromActiveRuns` (task 7.11): the real, honestly-scoped
 * source `useCoordination` feeds Inicio's "since your last visit" card —
 * derived strictly from `listActiveCoordinationRuns()`, the one app-scoped
 * read this change ships, so wiring it costs no extra IPC call. Only
 * `awaitingYou` (a pending gate) and `budgetConsumed` (the cap reached) are
 * derivable from that summary alone; `done`/`failed` would need per-run
 * history no brand-scoped method exposes, so this function never invents
 * them — a deliberate, disclosed scope limit, not an oversight.
 */
describe('sinceLastVisitFromActiveRuns: honest, no extra IPC call', () => {
  const run = (patch: Partial<CoordinationActiveRunSummary> = {}): CoordinationActiveRunSummary => ({
    runId: 'run1', workId: 'w1', workTitle: 'Lanzamiento', brandId: 'b1', brandName: 'Casa Oliva',
    status: 'running', dispatchesUsed: 3, maxDispatches: 10, pendingGates: 0, budgetInvalid: false,
    updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z', lastSeenAt: null, ...patch,
  });

  it('reports nothing for a brand with no active runs', () => {
    expect(sinceLastVisitFromActiveRuns([], 'b1')).toEqual([]);
  });

  it('ignores runs of a different brand entirely', () => {
    expect(sinceLastVisitFromActiveRuns([run({ brandId: 'other' })], 'b1')).toEqual([]);
  });

  it('reports awaitingYou when the run has pending gates', () => {
    const rows = sinceLastVisitFromActiveRuns([run({ pendingGates: 2 })], 'b1');
    expect(rows).toEqual([{ id: 'run1:gates', workId: 'w1', kind: 'awaitingYou', sinceVisit: false }]);
  });

  it('reports budgetConsumed once dispatchesUsed reaches the cap', () => {
    const rows = sinceLastVisitFromActiveRuns([run({ dispatchesUsed: 10, maxDispatches: 10 })], 'b1');
    expect(rows).toEqual([{ id: 'run1:budget', workId: 'w1', kind: 'budgetConsumed', sinceVisit: false }]);
  });

  it('never reports budgetConsumed for an explicitly unlimited run, no matter how many dispatches ran', () => {
    const rows = sinceLastVisitFromActiveRuns([run({ dispatchesUsed: 999, maxDispatches: null })], 'b1');
    expect(rows).toEqual([]);
  });

  it('can report both kinds for the same run at once', () => {
    const rows = sinceLastVisitFromActiveRuns([run({ pendingGates: 1, dispatchesUsed: 5, maxDispatches: 5 })], 'b1');
    expect(rows.map((r) => r.kind).sort()).toEqual(['awaitingYou', 'budgetConsumed']);
  });

  // La tarjeta se llamaba "Desde tu última visita" sin medir ninguna visita:
  // no había timestamp persistido en ningún lado, así que mostraba el estado
  // ACTUAL con un título que hablaba del pasado. Ahora hay
  // `coordination_last_seen:<workId>`, y el run que no cambió desde esa visita
  // no es novedad.
  it('un run que NO cambió desde la última visita no es novedad', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      pendingGates: 2, updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([]);
  });

  it('un run que cambió DESPUÉS de la última visita sí lo es, y se declara medido contra una visita real', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      pendingGates: 2, updatedAt: '2026-09-03T00:00:00.000Z', lastEventAt: '2026-09-03T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([{ id: 'run1:gates', workId: 'w1', kind: 'awaitingYou', sinceVisit: true }]);
  });

  it('sin ninguna visita registrada la fila se muestra, pero NO se afirma que sea desde una visita', () => {
    const rows = sinceLastVisitFromActiveRuns([run({ pendingGates: 1, lastSeenAt: null })], 'b1');
    expect(rows).toHaveLength(1);
    expect(rows[0].sinceVisit).toBe(false);
  });

  it('el instante exacto de la visita no es novedad: se pide cambio ESTRICTAMENTE posterior', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      pendingGates: 1, updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([]);
  });
  // --- U3: la visita se mide contra el ULTIMO HECHO, no contra `updatedAt` --
  //
  // Un gate que nace no reescribe la fila del run: `updatedAt` se quedaba
  // igual y la tarjeta se perdia exactamente lo que la persona tenia que ver.
  // `lastEventAt` (D18) es el maximo entre el run y su despacho/gate mas
  // nuevo, y es contra ESO que se compara la visita.

  it('un gate que nacio DESPUES de la visita es novedad aunque la fila del run no se haya tocado', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      pendingGates: 1,
      updatedAt: '2026-09-01T00:00:00.000Z', // la fila del run no se movio
      lastEventAt: '2026-09-03T00:00:00.000Z', // pero nacio un gate
      lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([{ id: 'run1:gates', workId: 'w1', kind: 'awaitingYou', sinceVisit: true }]);
  });

  it('sin ningun hecho posterior a la visita no hay novedad, aunque `updatedAt` sea mas nuevo que la visita', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      pendingGates: 1,
      updatedAt: '2026-09-05T00:00:00.000Z',
      lastEventAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([]);
  });

  // --- U3c: un equipo que termino es la novedad mas grande que hay ---------

  it('un run `done` que la persona no vio se reporta como "el equipo termino"', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      status: 'done', lastEventAt: '2026-09-03T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([{ id: 'run1:done', workId: 'w1', kind: 'done', sinceVisit: true }]);
  });

  it('el run terminado desaparece de la tarjeta en cuanto la persona pasa por ahi', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      status: 'done', lastEventAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([]);
  });

  // Cancelar lo aprieta la persona: no puede ser una novedad PARA ella. Se
  // deja fuera a proposito, no por olvido.
  it('un run CANCELADO no se reporta: la persona misma lo cancelo', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      status: 'cancelled', lastEventAt: '2026-09-03T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows).toEqual([]);
  });

  it('un run terminado no arrastra las filas de un run vivo: sin gates pendientes no se inventa ninguna', () => {
    const rows = sinceLastVisitFromActiveRuns([run({
      status: 'done', pendingGates: 0, dispatchesUsed: 10, maxDispatches: 10,
      lastEventAt: '2026-09-03T00:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z',
    })], 'b1');
    expect(rows.map((r) => r.kind)).toEqual(['done']);
  });
});
