import type { MessageKey } from './i18n';
import type { CoordinationActiveRunSummary, Decision, DocumentState, Work, WorkDocument } from '../shared/contracts';
import { needsReview } from './document-organizer';

/**
 * The pure core of Inicio.
 *
 * Inicio is a decision-first landing: it answers "what should I do now" from
 * state the shell already loaded, and every signal it shows leads to an action.
 * The rendering lives in `HomeView`; every decision — which rung of the ladder
 * wins, how a work is sorted, which documents ask for a look, and how an absent
 * signal is told without inventing a zero — lives here, so it can be tested
 * without a document and so the ladder has exactly ONE implementation.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window. It imports `MessageKey` as a type (erased)
 * and `needsReview` from `./document-organizer`, which is window-free — that
 * file's unused `./i18n` import was removed with this change so the property is
 * owned by the source, not by the bundler eliding a dead import.
 *
 * It deliberately does NOT import `./orientation-summary` or mutate
 * `OrientationStrip`: the strip is read-only by design and the global ladder is
 * a sibling, not a replacement. It reuses the strip's already-global-true
 * sentences instead of restating them.
 */

/** The nine rungs of the global ladder, in precedence order. */
export type HomeStep = 'start' | 'brand' | 'decisions' | 'context' | 'review' | 'checking' | 'live' | 'works' | 'none';

/**
 * Four new keys for the rungs Inicio adds, five reused from the strip.
 *
 * `orientation.next.*` already states sentences that are true of the whole
 * product, so only the rungs the strip never had get a key of their own.
 */
export const HOME_STEP_KEYS: Record<HomeStep, MessageKey> = {
  start: 'home.next.start',
  brand: 'orientation.next.brand',
  decisions: 'orientation.next.decisions',
  context: 'home.next.context',
  review: 'orientation.next.review',
  checking: 'orientation.next.checking',
  live: 'home.next.live',
  works: 'home.next.works',
  none: 'orientation.next.none',
};

/** Everything the ladder needs, already reduced to what it decides on. */
export interface HomeLadderInput {
  hasBrand: boolean;
  brandContextDefined: boolean;
  /** Pending decisions across the brand's works. */
  pendingDecisions: number;
  /** Pending brand-context proposals. */
  pendingContextProposals: number;
  /** Documents of the brand that ask for a look. */
  reviewDocuments: number;
  /** True while the first document-state sweep is still running. */
  checking: boolean;
  /** Works with a running agent session (`contextStatus.works[].live`). */
  liveWorkIds: readonly string[];
  workCount: number;
}

/** The signals Inicio composes. Every field is already loaded elsewhere. */
export interface HomeInput {
  hasBrand: boolean;
  brandContextDefined: boolean;
  works: ReadonlyArray<Pick<Work, 'id' | 'title' | 'updatedAt'>>;
  /** Work ids from `contextStatus.works` whose `live` is true. */
  liveWorkIds: readonly string[];
  /** Pending decisions only; the caller narrows the list before calling. */
  decisions: ReadonlyArray<Pick<Decision, 'id' | 'workId' | 'text' | 'createdAt'>>;
  pendingContextProposals: number;
  documents: readonly WorkDocument[];
  states: Readonly<Record<string, DocumentState>>;
  checking: boolean;
  /** Additive, optional (autonomous-coordination Phase 7 task 7.2): `undefined` means the caller has not wired coordination state yet — see `HomeSinceLastVisitInput`. */
  coordinationSinceLastVisit?: readonly HomeSinceLastVisitInput[];
}

export interface HomeContinueRow {
  id: string;
  title: string;
  updatedAt: string;
  live: boolean;
}

export interface HomeDecisionRow {
  id: string;
  workId: string;
  /** '' when the work is not in the list handed over: never an invented title. */
  workTitle: string;
  text: string;
}

export interface HomeReviewRow {
  id: string;
  workId: string;
  /** '' when the work is not in the list handed over. */
  workTitle: string;
  title: string;
}

/**
 * What "since your last visit" can report about a coordination run, kept to
 * exactly what a persisted `coordination_dispatch`/run row can answer — never
 * a narrative guess. `awaitingYou` is a pending gate; the other three are
 * lifecycle facts (autonomous-coordination, Phase 7 task 7.2).
 */
export type SinceLastVisitKind = 'done' | 'failed' | 'awaitingYou' | 'budgetConsumed';

/** What the caller hands over, already reduced to persisted facts. `undefined` means unwired (Phase 2's `!== undefined` pattern) — the card renders exactly like an empty list. */
export interface HomeSinceLastVisitInput {
  id: string;
  workId: string;
  kind: SinceLastVisitKind;
  /**
   * Si esta fila se mide contra una visita REAL (`markCoordinationSeen`) o
   * contra el arranque de la coordinación, porque nunca se registró ninguna.
   * El título de la tarjeta se elige con esto: prometer "desde tu última
   * visita" sin ninguna visita medida era la mentira original.
   */
  sinceVisit: boolean;
}

export interface HomeSinceLastVisitRow {
  id: string;
  workId: string;
  /** '' when the work is not in the list handed over: never an invented title. */
  workTitle: string;
  kind: SinceLastVisitKind;
  sinceVisit: boolean;
}

export interface HomeSummary {
  step: HomeStep;
  stepKey: MessageKey;
  /** Numbers, so the `{count, plural, …}` formatter can pick the branch. */
  stepParams: Record<string, string | number>;
  continueRows: HomeContinueRow[];
  decisionRows: HomeDecisionRow[];
  reviewRows: HomeReviewRow[];
  /** The brand has no work yet: Continuar collapses to the one action. */
  showNewWork: boolean;
  /** Empty for both an unwired caller (`undefined` input) and a wired caller with nothing to report — zero rows is never a zero. */
  sinceLastVisitRows: HomeSinceLastVisitRow[];
}

/**
 * The ladder alone: the acceptance-critical bit, testable in isolation.
 *
 * An empty brand context outranks every pending item, because it poisons every
 * agent turn. `checking` sits after the facts and before `live`/`works`: saying
 * "Sin pendientes" while the review sweep has not answered would be a lie of the
 * same family this project forbids. It never fires on a brand with no works,
 * where "checking" would describe a sweep over an empty list.
 */
export function homeStep(input: HomeLadderInput): HomeStep {
  if (!input.hasBrand) return 'start';
  if (!input.brandContextDefined) return 'brand';
  if (input.pendingDecisions > 0) return 'decisions';
  if (input.pendingContextProposals > 0) return 'context';
  if (input.reviewDocuments > 0) return 'review';
  if (input.checking && input.reviewDocuments === 0 && input.workCount > 0) return 'checking';
  if (input.liveWorkIds.length > 0) return 'live';
  if (input.workCount === 0) return 'works';
  return 'none';
}

/**
 * Derives `HomeSinceLastVisitInput` rows straight from `listActiveCoordinationRuns()`
 * (task 6.34, the one app-scoped read the change ships) — zero extra IPC
 * calls (task 7.11's `useCoordination` already fetches this for the global
 * strip). Only `awaitingYou` (a pending gate) and `budgetConsumed` (the cap
 * reached) are honestly derivable from that summary alone: `done`/`failed`
 * would need per-run history no brand-scoped method exposes today, so they
 * are deliberately never invented here — a disclosed scope limit, not an
 * oversight (see `apply-progress-phase7b`).
 */
export function sinceLastVisitFromActiveRuns(runs: readonly CoordinationActiveRunSummary[], brandId: string): HomeSinceLastVisitInput[] {
  const rows: HomeSinceLastVisitInput[] = [];
  for (const run of runs) {
    if (run.brandId !== brandId) continue;
    // La visita, por fin medida. Un run que no cambió DESPUÉS de la última
    // visita no es novedad: la persona ya lo vio. Se pide estrictamente
    // posterior — el instante exacto de la visita es lo que se miró.
    const sinceVisit = run.lastSeenAt != null;
    if (sinceVisit && !(run.updatedAt > run.lastSeenAt!)) continue;
    if (run.pendingGates > 0) rows.push({ id: `${run.runId}:gates`, workId: run.workId, kind: 'awaitingYou', sinceVisit });
    if (run.maxDispatches != null && run.dispatchesUsed >= run.maxDispatches) rows.push({ id: `${run.runId}:budget`, workId: run.workId, kind: 'budgetConsumed', sinceVisit });
  }
  return rows;
}

/** The ladder plus every row, ready to render. */
export function homeSummary(input: HomeInput): HomeSummary {
  const titles = new Map(input.works.map((work) => [work.id, work.title]));
  const review = input.documents.filter((document) => needsReview(document, input.states[document.id]?.baseOutdated ?? false));
  const step = homeStep({
    hasBrand: input.hasBrand,
    brandContextDefined: input.brandContextDefined,
    pendingDecisions: input.decisions.length,
    pendingContextProposals: input.pendingContextProposals,
    reviewDocuments: review.length,
    checking: input.checking,
    liveWorkIds: input.liveWorkIds,
    workCount: input.works.length,
  });
  const live = new Set(input.liveWorkIds);
  // Newest first: "continuar donde lo dejaste" is a statement about recency, and
  // a stable sort is what keeps two renders of the same facts identical.
  const continueRows = [...input.works]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((work) => ({ id: work.id, title: work.title, updatedAt: work.updatedAt, live: live.has(work.id) }));
  return {
    step,
    stepKey: HOME_STEP_KEYS[step],
    stepParams: step === 'decisions' ? { count: input.decisions.length } : step === 'review' ? { count: review.length } : {},
    continueRows,
    decisionRows: input.decisions.map((decision) => ({
      id: decision.id,
      workId: decision.workId,
      workTitle: titles.get(decision.workId) ?? '',
      text: decision.text,
    })),
    reviewRows: review.map((document) => ({
      id: document.id,
      workId: document.workId,
      workTitle: titles.get(document.workId) ?? '',
      title: document.title,
    })),
    showNewWork: input.works.length === 0,
    sinceLastVisitRows: (input.coordinationSinceLastVisit ?? []).map((event) => ({
      id: event.id,
      workId: event.workId,
      workTitle: titles.get(event.workId) ?? '',
      kind: event.kind,
      sinceVisit: event.sinceVisit,
    })),
  };
}
