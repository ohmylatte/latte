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

/**
 * Cuántos despachos pueden estar en vuelo a la vez cuando nadie eligió un
 * número.
 *
 * Es estructural, no económico: no acota lo que la persona gasta —para eso está
 * `maxDispatches`— sino cuántos procesos de agente Latte tiene corriendo A LA
 * VEZ. Aprobar una propuesta en un Trabajo sin presupuesto previo dejaba
 * `maxConcurrent` en `null`, o sea SIN tope de concurrencia: el único limitador
 * en vuelo que existe quedaba apagado justo en el camino más común, y un
 * coordinador podía tener a todo el equipo trabajando en paralelo hasta el
 * techo de procesos de la app.
 */
export const DEFAULT_MAX_CONCURRENT = 3;

/** `latte_ask` TTL when the caller omits one. */
export const ASK_TTL_DEFAULT_MINUTES = 30;

/** `latte_ask` TTL ceiling; a caller-supplied TTL above this is clamped. */
export const ASK_TTL_MAX_MINUTES = 1440;

/**
 * At most this many coordinated Codex members may share ONE coordination run
 * (one `codex app-server` process each, re-keyed by account+fingerprint).
 * Renamed from the original `MAX_COORDINATED_CODEX_MEMBERS` by
 * design-v2-conversational: a single app-wide 3 would starve parallel
 * brands, so the run-scoped cap and the app-wide cap below are now split.
 * Enforcing THIS cap needs run-membership knowledge (which member belongs to
 * which run) that `CodexChatAdapter` alone does not have -- that belongs to
 * Phase 6's hub wiring (task 6.29), which decides who gets `mcpServers` in
 * the first place. Defined here now so Phase 6 does not have to rename it
 * again.
 */
export const MAX_COORDINATED_CODEX_MEMBERS_PER_RUN = 3;

/**
 * App-wide hard ceiling on coordination-injected `codex app-server`
 * processes, across every Work and every Brand. Unlike the per-run cap
 * above, `CodexChatAdapter` IS a single app-scoped instance, so it can (and
 * does, Phase 5 task 5.7) enforce this one itself: past it, a member
 * degrades to no MCP injection rather than spawning an Nth process --
 * visibly logged, never a silent failure. Unrelated (non-coordinated) Codex
 * members are never counted: they keep sharing one process per account, as
 * before this change.
 */
export const MAX_COORDINATED_CODEX_PROCESSES = 6;

/**
 * A Codex-only Work with no coordinated member yet may still bootstrap ONE
 * coordination-injected member, so a proposal can be made at all within one
 * bounded process. Counted against `MAX_COORDINATED_CODEX_PROCESSES` above,
 * never on top of it. Enforcement lives with Phase 6's hub wiring, same as
 * the per-run cap: deciding "is this the Work's first coordinated member"
 * needs Work/run knowledge the adapter does not have.
 */
export const MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK = 1;

/**
 * App-wide ceiling on SIMULTANEOUSLY ACTIVE coordination runs (`planning`/
 * `running`/`suspended`), across every Work and every Brand. Never a silent
 * queue (task 6.15): a 5th `startRun` or `latte_request_coordination`
 * rejects `TOO_MANY_ACTIVE_RUNS` naming the busy Works, rather than
 * accepting the attempt and leaving it waiting invisibly for a slot.
 */
export const MAX_ACTIVE_COORDINATION_RUNS = 4;

/**
 * App-wide ceiling on `codex app-server` processes Latte itself spawns, of
 * EITHER kind: coordination-injected (bounded by
 * `MAX_COORDINATED_CODEX_PROCESSES` above) or engram-only (memory ships to
 * every Codex member by default once Phase 6e/6f wires it, independent of
 * coordination). At most `MAX_COORDINATED_CODEX_PROCESSES` of these ten may
 * carry a coordination injection; the rest are memory-only, sharing one
 * process per Brand+account (task 6.30).
 */
export const MAX_CODEX_APP_SERVERS_TOTAL = 10;
