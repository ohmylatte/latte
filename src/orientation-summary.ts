import type { MessageKey } from './i18n';
import { CONTEXT_STATE_KEYS } from './context-view';

/**
 * The pure core of the orientation strip.
 *
 * The strip is a thin renderer; every decision it makes — which of the four
 * loaded facts wins, how an absent one is told without inventing it — lives
 * here, so it can be tested without a document and so the ladder has exactly
 * ONE implementation.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window. It imports `MessageKey` as a type (erased)
 * and `CONTEXT_STATE_KEYS`, which is proven window-free by `context-view.test.ts`.
 * It must never import `./document-organizer` (that one pulls `./i18n`).
 */

/** The five rungs of the ladder, in precedence order. */
export type OrientationStep = 'brand' | 'decisions' | 'review' | 'checking' | 'none';

export const ORIENTATION_STEP_KEYS: Record<OrientationStep, MessageKey> = {
  brand: 'orientation.next.brand',
  decisions: 'orientation.next.decisions',
  review: 'orientation.next.review',
  checking: 'orientation.next.checking',
  none: 'orientation.next.none',
};

/** The four signals the strip composes. Every field is already loaded elsewhere. */
export interface OrientationInput {
  brandContextDefined: boolean;
  pendingDecisions: number;
  reviewDocuments: number;
  /** `work.expectedOutput`; '' when the work has none. */
  expectedOutput: string;
  /** True while the first document-state sweep is still running. */
  checking: boolean;
}

export interface OrientationSummary {
  /** `context.state.defined` | `context.state.empty`. */
  brandStateKey: MessageKey;
  /** Trimmed value, or null when the work has none (`outcome.unset`). */
  expectedOutput: string | null;
  /** Count, or null while the first read has not answered. */
  reviewDocuments: number | null;
  pendingDecisions: number;
  step: OrientationStep;
  stepKey: MessageKey;
  /** Numbers, so the `{count, plural, …}` formatter can pick the branch. */
  stepParams: Record<string, string | number>;
}

/**
 * The ladder alone: the acceptance-critical bit, testable in isolation.
 *
 * An empty brand context outranks everything, because it poisons every agent
 * turn. `checking` sits after the facts and before `none`: claiming "Sin
 * pendientes" while the review sweep has not answered would be a lie of the
 * same family this project forbids.
 */
export function orientationStep(
  input: Pick<OrientationInput, 'brandContextDefined' | 'pendingDecisions' | 'reviewDocuments' | 'checking'>,
): OrientationStep {
  if (!input.brandContextDefined) return 'brand';
  if (input.pendingDecisions > 0) return 'decisions';
  if (input.reviewDocuments > 0) return 'review';
  if (input.checking && input.reviewDocuments === 0) return 'checking';
  return 'none';
}

/** The ladder plus every cell, ready to render. */
export function orientationSummary(input: OrientationInput): OrientationSummary {
  const step = orientationStep(input);
  const count = step === 'decisions' ? input.pendingDecisions : input.reviewDocuments;
  return {
    brandStateKey: input.brandContextDefined ? CONTEXT_STATE_KEYS.defined : CONTEXT_STATE_KEYS.empty,
    expectedOutput: input.expectedOutput.trim() || null,
    reviewDocuments: input.checking && input.reviewDocuments === 0 ? null : input.reviewDocuments,
    pendingDecisions: input.pendingDecisions,
    step,
    stepKey: ORIENTATION_STEP_KEYS[step],
    stepParams: step === 'decisions' || step === 'review' ? { count } : {},
  };
}
