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

/**
 * N1 (ronda 7): EL RESPALDO PARA UNA FILA SIN DUEÑO. NO ES LA DEFINICIÓN DE
 * ZOMBI.
 *
 * Esta constante NO decide si un despacho está vivo. Eso lo dice el HUB, que
 * es quien tiene los procesos: `allBlockedOnAsks` cuenta como trabajo vivo
 * toda fila abierta cuyo miembro el hub conozca, tenga la edad que tenga. Un
 * reloj no sabe si alguien está trabajando, y la versión anterior de este
 * comentario decía lo contrario: pasado el umbral una tarea legítima de 31
 * minutos dejaba de contar, el run se suspendía con un miembro adentro y el
 * coordinador se comía un `RUN_NOT_ACTIVE`.
 *
 * M1 (ronda 8): y la señal de vida es la del ADAPTADOR
 * (`hub.liveMemberIds`), no la de la tabla de miembros. La tabla sobrevive a
 * la muerte del proceso: esa fila sigue ahí con `status:'paused'`.
 *
 * Lo único que este número decide es cuánto espera `settleOrphanDispatches`
 * (el tick de `sweepActiveRuns`) antes de recoger los TRES huérfanos que
 * existen de verdad:
 *
 *  1. Fila de despacho abierta y NADIE ADENTRO (proceso muerto sin `closed`, o
 *     miembro pausado por la persona) → se liquida sin cobrar el intento.
 *  2. Fila abierta con el miembro VIVO pero NO OCUPADO: terminó su turno sin
 *     llamar a `latte_report` → se liquida COBRANDO el intento, porque eso sí
 *     es un fracaso de este intento.
 *  3. Tarea `dispatched` SIN fila de despacho abierta: el spawn se colgó entre
 *     el CAS que reclamó la tarea y el `insert` de la fila → la tarea vuelve a
 *     `ready` con el CAS inverso. Su reloj es el `updatedAt` de la tarea.
 *
 * El margen NO existe para "esperar a un alta que el hub todavía no publicó":
 * ese estado no existe. La fila de despacho se inserta DESPUÉS del spawn, así
 * que cuando hay fila el miembro ya fue publicado. Existe por lo de siempre —
 * no actuar sobre una foto de hace un instante— y por el caso 3, donde el
 * único dato disponible es la edad.
 *
 * `sweepUncertainDispatches` es otra cosa y sigue sin mirar la antigüedad:
 * corre al arrancar la app, cuando cualquier despacho en vuelo es por
 * definición huérfano. Estructural, no económico: no acota gasto.
 */
export const IN_FLIGHT_DISPATCH_STALE_MINUTES = 30;

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

/**
 * Cuántos avisos sin entregar puede acumular un miembro. Un aviso es un turno
 * de usuario que no se le pudo mandar porque estaba en medio de otro: se
 * guarda en memoria hasta su próximo `idle`. Un miembro que se murió sin
 * volver nunca dejaría la cola creciendo para siempre, así que la cola olvida
 * el más viejo en vez de crecer.
 */
export const MAX_PENDING_NOTICES = 20;

/**
 * Cuánto `spec` publica `latte_task_list` por tarea. La lista existe para que
 * el coordinador VEA las tareas que la aprobación ya creó y las despache en
 * vez de recrearlas; el texto completo de cada una es suyo —lo escribió él en
 * la propuesta— y mandarlo entero por cada listado le quema el contexto.
 */
export const TASK_LIST_SPEC_PREVIEW = 200;
