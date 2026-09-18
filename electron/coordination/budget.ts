/**
 * Pure reserve/settle/deny budget arithmetic. No I/O, no DB, no clock: every
 * function takes a plain budget and a plain usage snapshot and returns a
 * plain decision. The caller (the repository, later `engine.ts`) is the one
 * that reads the snapshot from `coordination_run`/`coordination_cost_ledger`,
 * acts on the decision (write a reservation row, write a `denied` ledger row,
 * flip the run to `suspended`), and persists the result.
 *
 * `maxDispatches` is the primary, required unit: it is always countable
 * (`SUM(dispatches) WHERE kind='spend'`) with zero cost data. The other caps
 * are optional and secondary because `ChatUsage.costUsd` is nullable per
 * runtime — `maxCostMicros` is inherently best-effort, never authoritative.
 *
 * Budget exhaustion suspends the run; it never kills in-flight work. That
 * policy is enforced by the caller reacting to `{ ok: false }` — this module
 * only ever answers the question "may one more dispatch be reserved right
 * now", it never writes `coordination_run.status` itself.
 */

/**
 * The per-run budget snapshot (`coordination_run.budget_json`), also the
 * per-Work default (meta key `coordination_budget:<workId>`).
 *
 * Promoted to `shared/contracts.ts` in Phase 2 (task 2.1): once
 * `get/setCoordinationBudget` exist as IPC methods, this type crosses the
 * process boundary, so it can no longer stay local to this pure module. It
 * is re-exported here so every Phase 1 import site keeps working unchanged.
 *
 * `maxConcurrent` (how many dispatches may be in flight at once) lives in the
 * same JSON blob as every other cap, but Phase 1/2 do not enforce it here:
 * counting in-flight dispatches requires reading `coordination_dispatch`
 * rows, which makes the check impure by definition. That enforcement belongs
 * to `engine.ts` (Phase 3, task 3.10) — see the note on `reserveDispatch`
 * below.
 */
import type { CoordinationBudget } from '../../shared/contracts';
export type { CoordinationBudget };

/** Running totals for one run, maintained by the caller and passed in fresh each time. */
export interface BudgetUsage {
  dispatchesUsed: number;
  tokensUsed?: number;
  costMicrosUsed?: number;
  wallMinutesUsed?: number;
}

export type BudgetDenyReason = 'max_dispatches' | 'max_tokens' | 'max_cost' | 'max_wall_minutes';

export type BudgetDecision = { ok: true } | { ok: false; reason: BudgetDenyReason };

/** Thrown when no budget was ever configured. Never treated as unlimited — that is always an explicit choice (see `CoordinationBudget.unlimitedConfirmedAt`). */
export class BudgetUnsetError extends Error {
  readonly code = 'BUDGET_UNSET';
  constructor(message = 'No coordination budget is configured for this Work') {
    super(message);
    this.name = 'BudgetUnsetError';
  }
}

/** Throws BUDGET_UNSET for `null`/`undefined`; otherwise returns the budget unchanged. */
export function assertBudgetConfigured(budget: CoordinationBudget | null | undefined): CoordinationBudget {
  if (budget == null) throw new BudgetUnsetError();
  return budget;
}

/**
 * May one more dispatch be reserved right now? Checks the required primary
 * cap first, then every secondary cap that is actually set. A cap left
 * `null`/`undefined` is simply not checked — the primary cap is the only one
 * that can never be silently absent (see `assertBudgetConfigured`).
 *
 * Does NOT check `maxConcurrent`: that cap is about dispatches currently
 * in-flight (a DB read), not about a cumulative usage counter, so it cannot
 * be decided from `BudgetUsage` alone. It is the caller's (Phase 3
 * `engine.ts`) job, including excluding the coordinator's own grant from the
 * in-flight count (the coordinator dispatches; it never occupies a dispatch
 * slot itself).
 */
export function reserveDispatch(budget: CoordinationBudget | null | undefined, usage: BudgetUsage): BudgetDecision {
  const configured = assertBudgetConfigured(budget);
  if (configured.maxDispatches != null && usage.dispatchesUsed >= configured.maxDispatches) {
    return { ok: false, reason: 'max_dispatches' };
  }
  if (configured.maxTokens != null && (usage.tokensUsed ?? 0) >= configured.maxTokens) {
    return { ok: false, reason: 'max_tokens' };
  }
  if (configured.maxCostMicros != null && (usage.costMicrosUsed ?? 0) >= configured.maxCostMicros) {
    return { ok: false, reason: 'max_cost' };
  }
  if (configured.maxWallMinutes != null && (usage.wallMinutesUsed ?? 0) >= configured.maxWallMinutes) {
    return { ok: false, reason: 'max_wall_minutes' };
  }
  return { ok: true };
}

/** Pure accounting: adds a settled dispatch's spend to a usage snapshot. Never mutates its input. */
export function recordSpend(usage: BudgetUsage, delta: Partial<BudgetUsage>): BudgetUsage {
  return {
    dispatchesUsed: usage.dispatchesUsed + (delta.dispatchesUsed ?? 0),
    tokensUsed: (usage.tokensUsed ?? 0) + (delta.tokensUsed ?? 0),
    costMicrosUsed: (usage.costMicrosUsed ?? 0) + (delta.costMicrosUsed ?? 0),
    wallMinutesUsed: (usage.wallMinutesUsed ?? 0) + (delta.wallMinutesUsed ?? 0),
  };
}
