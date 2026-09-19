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
import { ValidationError } from '../core/errors';
import { requireInt } from '../services/validation';
import type { CoordinationBudget } from '../../shared/contracts';
export type { CoordinationBudget };

/**
 * Validates a `CoordinationBudget` on write: `maxDispatches` must be a
 * positive integer, unless it is explicitly `null` alongside a non-empty
 * `unlimitedConfirmedAt` — an unlimited budget is always a human choice,
 * never an implicit default (spec: "No Implicit Unlimited Budget"). Every
 * secondary cap is optional but, when present, a non-negative integer.
 * Returns a normalized object (every optional field present as `null` when
 * omitted) so a stored round-trip is byte-for-byte stable.
 *
 * Moved here from `latteService.ts` (Phase 6, task 6.11): the proposal
 * approval path (`engine.ts`'s `resolveGate` on a `proposal` gate) needs the
 * exact same validator "no implicit unlimited" re-applies to an edited
 * proposal's budget, and `engine.ts` cannot import from `latteService.ts`
 * without a cycle. `latteService.ts` re-exports/imports this one, so every
 * call site (Phase 2's `setCoordinationBudget` included) keeps behaving
 * identically.
 */
export function requireCoordinationBudget(value: unknown): CoordinationBudget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Invalid coordination budget');
  const b = value as Record<string, unknown>;
  const optionalNonNegativeInt = (v: unknown, name: string): number | null =>
    v === null || v === undefined ? null : requireInt(v, name, 0, Number.MAX_SAFE_INTEGER);
  let maxDispatches: number | null;
  let unlimitedConfirmedAt: string | null = null;
  if (b.maxDispatches === null) {
    if (typeof b.unlimitedConfirmedAt !== 'string' || b.unlimitedConfirmedAt.trim().length === 0) {
      throw new ValidationError('An unlimited coordination budget requires an explicit unlimitedConfirmedAt');
    }
    maxDispatches = null;
    unlimitedConfirmedAt = b.unlimitedConfirmedAt;
  } else {
    maxDispatches = requireInt(b.maxDispatches, 'maxDispatches', 1, Number.MAX_SAFE_INTEGER);
  }
  return {
    maxDispatches,
    unlimitedConfirmedAt,
    maxTokens: optionalNonNegativeInt(b.maxTokens, 'maxTokens'),
    maxCostMicros: optionalNonNegativeInt(b.maxCostMicros, 'maxCostMicros'),
    maxWallMinutes: optionalNonNegativeInt(b.maxWallMinutes, 'maxWallMinutes'),
    maxConcurrent: optionalNonNegativeInt(b.maxConcurrent, 'maxConcurrent'),
  };
}

/**
 * El resultado de leer el tope app-wide (`coordination_budget_global`), en
 * TRES estados, no dos.
 *
 * Crítico 8: había DOS lectores de estos mismos bytes con semánticas
 * opuestas. El getter que alimenta la pantalla devolvía `null` —"sin tope"—
 * ante un JSON ilegible; el lector del camino de despacho TIRABA ante esos
 * mismos bytes, y tirar deniega. O sea: la pantalla decía "sin tope global"
 * mientras cada despacho fallaba con un error opaco, y no había forma de que
 * la persona relacionara una cosa con la otra.
 *
 * "Ausente" e "ilegible" son estados DISTINTOS y ninguno de los dos es "sin
 * tope": ausente es una elección humana explícita (no hay cap extra),
 * ilegible es un dato roto que hay que mirar. Este parser es el único lugar
 * donde esos bytes se interpretan, y los dos lectores lo llaman.
 */
export type CoordinationGlobalBudgetRead =
  | { kind: 'unset' }
  | { kind: 'set'; budget: CoordinationBudget }
  | { kind: 'invalid'; raw: string };

export function readCoordinationGlobalBudget(raw: string | null | undefined): CoordinationGlobalBudgetRead {
  if (raw == null || raw.trim().length === 0) return { kind: 'unset' };
  try {
    return { kind: 'set', budget: requireCoordinationBudget(JSON.parse(raw)) };
  } catch {
    return { kind: 'invalid', raw };
  }
}

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
