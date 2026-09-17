import { describe, expect, it } from 'vitest';
import { HOME_STEP_KEYS, homeStep, homeSummary, type HomeInput, type HomeLadderInput } from './home-summary';
import type { Decision, DocumentState, WorkDocument } from '../shared/contracts';

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
