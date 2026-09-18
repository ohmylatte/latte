/**
 * Structural constants only: the numbers that protect Latte's own integrity
 * (memory, disk, process budget, protocol liveness) regardless of what any
 * human chooses to spend. Economic limits — what a run may spend in
 * dispatches, tokens, cost or wall-clock time — never live here; they live in
 * `coordination_run.budget_json` (see `budget.ts`), because that is the
 * human's money and the human's clock, not Latte's.
 *
 * Pure: no I/O, no DB, no clock. Just numbers.
 */

/** A run may not exceed this many tasks. Protects the store and the UI, not the budget. */
export const MAX_TASKS_PER_RUN = 200;

/** A dependency chain may not exceed this depth. */
export const MAX_DEPENDENCY_DEPTH = 20;

/** A task blocks (never retries indefinitely) after this many consecutive failed reports. */
export const MAX_ATTEMPTS_PER_TASK = 3;

/** `latte_check(wait)` never actually blocks longer than this, no matter what was requested. */
export const MAX_CHECK_WAIT_SECONDS = 30;

/** `latte_ask` TTL when the caller omits one. */
export const ASK_TTL_DEFAULT_MINUTES = 30;

/** `latte_ask` TTL ceiling; a caller-supplied TTL above this is clamped. */
export const ASK_TTL_MAX_MINUTES = 1440;

/**
 * At most this many `codex app-server` processes may exist for coordination at
 * once (one per coordinated member, re-keyed by account+fingerprint). Beyond
 * it, a member degrades to `mcpInjection: 'none'` rather than spawning an Nth
 * process. Unrelated (non-coordinated) Codex members are not counted: they
 * keep sharing one process per account, as before this change.
 */
export const MAX_COORDINATED_CODEX_MEMBERS = 3;
