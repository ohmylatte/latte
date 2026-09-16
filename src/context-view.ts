import { composeBrandContext } from '../shared/brandContext';
import type { BrandContextProposal, BrandContextRevision } from '../shared/contracts';
import { contextDiff, type ContextDiffLine } from './context-diff';
import type { MessageKey } from './i18n';

/**
 * The pure core of the Contexto view.
 *
 * The view itself is a thin renderer; every decision it shows — is the draft
 * dirty, can it be saved, what does approving the pending proposal produce, is
 * that proposal stale — lives here so it can be tested without a document and
 * so there is exactly ONE diff implementation (`context-diff.ts`).
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window.
 */

/** The three states the brand context can be in, as Contexto names them. */
export type ContextState = 'empty' | 'pending' | 'defined';

/**
 * A pending proposal is the brand's open question: while it waits, the state is
 * "pending" even if some context is already written, because that is the thing
 * the human has to act on.
 */
export function contextState(input: { context: string; hasPending: boolean }): ContextState {
  if (input.hasPending) return 'pending';
  return input.context.trim().length > 0 ? 'defined' : 'empty';
}

/**
 * What a brand-context write reports back about the brand's works.
 *
 * P0 writes through `updateBrand`, which reports nothing; every list is
 * optional so the notice degrades to the plain "saved" line. The propagation
 * tier fills these in.
 */
export interface ContextRefreshView {
  updated?: readonly string[];
  unchanged?: readonly string[];
  /** Works with a live agent session: the write does not reach them. */
  live?: readonly string[];
  userOwned?: readonly string[];
}

/** What Contexto knows about the brand context beyond the brand record itself. */
export interface ContextStatusView {
  /** Works of this brand with a live agent session. */
  liveCount: number;
  /** Works of this brand: the banner says the context is shared by all of them. */
  worksCount: number;
  /**
   * Fingerprint of the context the editor loaded. Every write sends it back, so
   * a change made underneath is refused instead of overwritten in silence.
   */
  fingerprint: string;
  /** The history of the context, newest first. */
  revisions: BrandContextRevision[];
}

/** How many revisions the history lists before it only counts the rest. */
export const REVISION_PAGE = 20;

/**
 * The slice of history to render, and how many older entries were left out.
 * A brand can accumulate hundreds of saves; the newest 20 are the useful ones,
 * and the count says the rest are there without pretending they are not.
 */
export function revisionList(revisions: readonly BrandContextRevision[]): { shown: BrandContextRevision[]; hidden: number } {
  return { shown: revisions.slice(0, REVISION_PAGE), hidden: Math.max(0, revisions.length - REVISION_PAGE) };
}

/** Why a revision exists, as a label. */
export const REVISION_SOURCE_KEYS: Record<BrandContextRevision['source'], MessageKey> = {
  human: 'context.revision.human',
  proposal: 'context.revision.proposal',
  clear: 'context.revision.clear',
  restore: 'context.revision.restore',
};

/**
 * A one-line preview of a revision. Restoring is a write, so the human has to
 * see what they are restoring instead of confirming a date and a label.
 */
export function revisionPreview(content: string, limit = 60): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * True when restoring this revision would change nothing, because its content is
 * already `brand.context`.
 *
 * The newest revision is ALWAYS the current value, so the first "Restaurar" the
 * view ever offered was a silent no-op: no revision recorded, no notice, no
 * change. Comparing content instead of position also covers the case where a
 * restore left the same text twice.
 */
export function isCurrentRevision(revision: Pick<BrandContextRevision, 'content'>, context: string): boolean {
  return revision.content === context;
}

/** The status chip label for each state, as Contexto names it. */
export const CONTEXT_STATE_KEYS: Record<ContextState, MessageKey> = {
  empty: 'context.state.empty',
  pending: 'context.state.pending',
  defined: 'context.state.defined',
};

/**
 * Why a decided proposal stopped being pending, as a label. A superseded one
 * must say so: it is the visible trail of a proposal that would otherwise
 * vanish silently when a newer one replaced it.
 */
export function decidedReasonKey(proposal: BrandContextProposal): MessageKey {
  if (proposal.decidedReason === 'superseded') return 'context.decided.superseded';
  if (proposal.decidedReason === 'auto-recorded') return 'context.decided.auto';
  // A row from before the trail existed has no reason; the status still tells
  // the truth, so a rejected proposal never reads as accepted.
  if (proposal.decidedReason === 'rejected' || proposal.status === 'rejected') return 'context.decided.rejected';
  return 'context.decided.approved';
}

export interface ContextViewInput {
  /** `brand.context` as persisted. */
  context: string;
  /** What the editor is holding. */
  draft: string;
  /** Proposals of this brand, any status. */
  proposals: readonly BrandContextProposal[];
  liveCount: number;
  hasWork: boolean;
  busy: boolean;
}

export interface ContextViewState {
  state: ContextState;
  dirty: boolean;
  canSave: boolean;
  canClear: boolean;
  canAsk: boolean;
  liveCount: number;
  /** Line diff of `context` → `pendingPreview`, straight from `contextDiff`. */
  diff: ContextDiffLine[];
  /** The value `brand.context` would take if the pending proposal were approved. */
  pendingPreview: string | null;
  stalePending: boolean;
}

export function deriveContextView(input: ContextViewInput): ContextViewState {
  const pending = input.proposals.find((proposal) => proposal.status === 'pending') ?? null;
  const pendingPreview = pending ? composeBrandContext(input.context, pending.text, pending.mode) : null;
  const diff = pending && pendingPreview !== null
    ? contextDiff(input.context, pendingPreview, pending.mode).lines
    : [];
  const dirty = input.draft !== input.context;
  return {
    state: contextState({ context: input.context, hasPending: Boolean(pending) }),
    dirty,
    canSave: dirty && !input.busy,
    canClear: input.context.trim().length > 0 && !input.busy,
    canAsk: input.hasWork && !input.busy,
    liveCount: input.liveCount,
    diff,
    pendingPreview,
    stalePending: Boolean(pending?.stale),
  };
}

/**
 * The notice after a brand-context write.
 *
 * When at least one work has a live session, the plain "saved" line would be a
 * half-truth: that session keeps the context it started with. The honest line
 * is already written (`ui.auto.052`), so no new string is invented here.
 */
export function contextSaveNotice(refresh: ContextRefreshView | null): { key: MessageKey; params: Record<string, string | number> } {
  if (refresh && (refresh.live?.length ?? 0) > 0) return { key: 'ui.auto.052', params: {} };
  return { key: 'ui.auto.005', params: {} };
}
