import { describe, expect, it } from 'vitest';
import type { BrandContextProposal, BrandContextRevision } from '../shared/contracts';
import { contextDiff } from './context-diff';
import { CONTEXT_STATE_KEYS, REVISION_PAGE, REVISION_SOURCE_KEYS, contextSaveNotice, contextState, decidedReasonKey, deriveContextView, isCurrentRevision, revisionList, revisionPreview } from './context-view';

const proposal = (patch: Partial<BrandContextProposal> = {}): BrandContextProposal => ({
  id: 'p1',
  brandId: 'b1',
  workId: 'w1',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  text: 'Audiencia: 25-40.',
  rationale: 'La investigación lo sugiere.',
  mode: 'append',
  status: 'pending',
  fingerprint: 'f',
  baseFingerprint: '',
  stale: false,
  clientRequestId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  decidedAt: null,
  ...patch,
});

describe('contextState', () => {
  it('is empty with no context and no proposal', () => {
    expect(contextState({ context: '   ', hasPending: false })).toBe('empty');
  });

  it('is defined when there is context', () => {
    expect(contextState({ context: 'Tono cercano', hasPending: false })).toBe('defined');
  });

  it('is pending while a proposal waits, even with context already written', () => {
    expect(contextState({ context: 'Tono cercano', hasPending: true })).toBe('pending');
    expect(contextState({ context: '', hasPending: true })).toBe('pending');
  });
});

describe('deriveContextView', () => {
  const base = { context: 'Tono cercano', draft: 'Tono cercano', proposals: [], liveCount: 0, hasWork: true, busy: false };

  it('is clean and not saveable until the draft differs', () => {
    expect(deriveContextView(base)).toMatchObject({ dirty: false, canSave: false, state: 'defined' });
    expect(deriveContextView({ ...base, draft: 'Tono cercano y preciso' })).toMatchObject({ dirty: true, canSave: true });
  });

  it('blocks save, clear and ask while a write is in flight', () => {
    expect(deriveContextView({ ...base, draft: 'otro', busy: true })).toMatchObject({ canSave: false, canClear: false, canAsk: false });
  });

  it('offers clear only when there is context to clear', () => {
    expect(deriveContextView({ ...base, context: '', draft: '' }).canClear).toBe(false);
    expect(deriveContextView(base).canClear).toBe(true);
  });

  it('needs a work to ask the strategist', () => {
    expect(deriveContextView({ ...base, hasWork: false }).canAsk).toBe(false);
    expect(deriveContextView(base).canAsk).toBe(true);
  });

  it('previews an append proposal with the shared diff, not a private one', () => {
    const view = deriveContextView({ ...base, proposals: [proposal()] });
    expect(view.state).toBe('pending');
    expect(view.pendingPreview).toBe('Tono cercano\n\nAudiencia: 25-40.');
    expect(view.diff).toEqual(contextDiff('Tono cercano', 'Tono cercano\n\nAudiencia: 25-40.', 'append').lines);
  });

  it('previews a replace proposal', () => {
    const view = deriveContextView({ ...base, proposals: [proposal({ mode: 'replace', text: 'Solo esto.' })] });
    expect(view.pendingPreview).toBe('Solo esto.');
    expect(view.diff).toEqual(contextDiff('Tono cercano', 'Solo esto.', 'replace').lines);
  });

  it('ignores decided proposals and reports a stale pending one', () => {
    const decided = proposal({ id: 'old', status: 'approved' });
    expect(deriveContextView({ ...base, proposals: [decided] })).toMatchObject({ state: 'defined', diff: [], pendingPreview: null, stalePending: false });
    expect(deriveContextView({ ...base, proposals: [proposal({ stale: true })] }).stalePending).toBe(true);
  });

  it('carries the live-session count through', () => {
    expect(deriveContextView({ ...base, liveCount: 2 }).liveCount).toBe(2);
  });
});

describe('orientation labels', () => {
  it('names each context state', () => {
    expect(CONTEXT_STATE_KEYS.empty).toBe('context.state.empty');
    expect(CONTEXT_STATE_KEYS.pending).toBe('context.state.pending');
    expect(CONTEXT_STATE_KEYS.defined).toBe('context.state.defined');
  });

  it('says why a proposal was decided, superseded included', () => {
    expect(decidedReasonKey(proposal({ status: 'rejected', decidedReason: 'superseded' }))).toBe('context.decided.superseded');
    expect(decidedReasonKey(proposal({ status: 'approved', decidedReason: 'approved' }))).toBe('context.decided.approved');
    expect(decidedReasonKey(proposal({ status: 'approved', decidedReason: 'auto-recorded' }))).toBe('context.decided.auto');
    expect(decidedReasonKey(proposal({ status: 'rejected', decidedReason: 'rejected' }))).toBe('context.decided.rejected');
    // A row from before the trail existed still gets an honest label.
    expect(decidedReasonKey(proposal({ status: 'approved', decidedReason: null }))).toBe('context.decided.approved');
    expect(decidedReasonKey(proposal({ status: 'rejected', decidedReason: null }))).toBe('context.decided.rejected');
  });
});

const revision = (patch: Partial<BrandContextRevision> = {}): BrandContextRevision => ({
  id: 'r1',
  brandId: 'b1',
  source: 'human',
  origin: null,
  content: 'Tono cercano',
  fingerprint: 'f1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

describe('revisionList', () => {
  it('shows the newest entries in order and counts the rest', () => {
    const many = Array.from({ length: REVISION_PAGE + 3 }, (_, index) => revision({ id: `r${index}` }));
    const { shown, hidden } = revisionList(many);
    expect(shown).toHaveLength(REVISION_PAGE);
    // The caller passes newest-first, so the head is the newest.
    expect(shown[0].id).toBe('r0');
    expect(hidden).toBe(3);
  });

  it('hides nothing when the history fits', () => {
    expect(revisionList([revision(), revision({ id: 'r2' })])).toMatchObject({ hidden: 0 });
    expect(revisionList([])).toEqual({ shown: [], hidden: 0 });
  });

  it('names why each revision exists', () => {
    expect(REVISION_SOURCE_KEYS).toEqual({
      human: 'context.revision.human',
      proposal: 'context.revision.proposal',
      clear: 'context.revision.clear',
      restore: 'context.revision.restore',
    });
  });

  it('previews what restoring a revision would bring back', () => {
    expect(revisionPreview('Tono cercano')).toBe('Tono cercano');
    expect(revisionPreview('Linea uno\nLinea dos')).toBe('Linea uno Linea dos');
    // An explicit clear has nothing to preview; the source label says why.
    expect(revisionPreview('   ')).toBe('');
    expect(revisionPreview('A'.repeat(100))).toHaveLength(60);
    expect(revisionPreview('A'.repeat(100)).endsWith('…')).toBe(true);
  });

  it('knows which revision is already the live context', () => {
    // The newest revision IS the current value, so offering "Restaurar" on it
    // is a button that does nothing: the view has to say so instead.
    expect(isCurrentRevision({ content: 'Tono cercano' }, 'Tono cercano')).toBe(true);
    expect(isCurrentRevision({ content: 'Tono viejo' }, 'Tono cercano')).toBe(false);
    // A restore can leave the same text twice; both are no-ops, and the one the
    // human means is decided by content, not by position.
    expect(isCurrentRevision({ content: 'Tono cercano' }, 'Tono cercano')).toBe(true);
    expect(isCurrentRevision({ content: '' }, '')).toBe(true);
  });
});

describe('contextSaveNotice', () => {
  it('says the context was saved when nothing is running', () => {
    expect(contextSaveNotice(null)).toEqual({ key: 'ui.auto.005', params: {} });
    expect(contextSaveNotice({ updated: ['w1'], unchanged: [], live: [], userOwned: [] })).toEqual({ key: 'ui.auto.005', params: {} });
  });

  it('falls back to the new-sessions line when a work has a live session', () => {
    expect(contextSaveNotice({ live: ['w2'] }).key).toBe('ui.auto.052');
  });
});
