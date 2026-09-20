/**
 * Tool schemas + handlers: `(grant, args) => envelope`. No HTTP here — that
 * is Phase 6's `mcpServer.ts`. Every coordinator-only tool rejects a caller
 * without the `coordinator` grant with `{ok:false}` and no mutation; every
 * envelope carries the same shape (`ok`, `authority`, `budget`, `data`),
 * differing only in `data` — the mode never changes the tool's availability
 * or response shape, only `data.status` for `latte_dispatch`.
 */
import type { CoordinationAuthorityMode } from '../../shared/contracts';
import { LatteError } from '../core/errors';
import type { CoordinationBudgetBlock, CoordinationEngine, CoordinationGrant, CoordinationProposal } from './engine';

export interface ToolEnvelope<T> {
  ok: boolean;
  authority: CoordinationAuthorityMode;
  budget: CoordinationBudgetBlock;
  data: T | null;
  error?: { code: string; message: string };
}

/**
 * Names the door, not just the lock (task 6.4): a rejection that only says
 * "no" leaves a worker stuck. Proposing IS how a worker asks — the human
 * approves it once and gets the grant, the budget and the authority
 * together (design-v2-conversational, D1).
 */
const FORBIDDEN_MESSAGE =
  "You don't hold the coordinator grant for this Work. To coordinate, propose a plan with latte_request_coordination — the human approves it once and you get the grant, the budget and the authority together.";

/** El bloque que viaja cuando el presupuesto del run NO se pudo leer: ceros y `null`, nunca un número inventado. */
const UNREADABLE_BUDGET_BLOCK: CoordinationBudgetBlock = { dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null };

async function wrap<T>(engine: CoordinationEngine, grant: CoordinationGrant, requireCoordinator: boolean, fn: () => Promise<T> | T, requiresRun = false): Promise<ToolEnvelope<T>> {
  // Crítico 4: estas dos lecturas vivían FUERA del try. `budgetBlockForEnvelope`
  // tira cuando el `budget_json` del run es ilegible, así que un solo run roto
  // hacía escapar la excepción de `handleMcpRequest` entero y TODA llamada MCP
  // posterior de ese Trabajo —incluso un `latte_check` que no toca nada—
  // terminaba como HTTP 500. Adentro del try, un presupuesto ilegible es un
  // error DE ESTA llamada: HTTP 200, `ok:false`, con su código.
  let authority: CoordinationAuthorityMode = 'manual';
  let budget: CoordinationBudgetBlock = UNREADABLE_BUDGET_BLOCK;
  try {
    authority = engine.readAuthorityForEnvelope(grant.workId);
    budget = engine.budgetBlockForEnvelope(grant.runId);
    // "No hay run" va PRIMERO, antes que "no sos el coordinador": cuando el run
    // termina, el permiso de coordinador se borra con él (D3), así que el mismo
    // agente que venía coordinando pasaba a recibir FORBIDDEN —"no tenés el
    // permiso, proponé un plan"— cuando el hecho real es que su equipo ya
    // terminó. Se responde el hecho, no su consecuencia.
    if (requiresRun && grant.runId == null) {
      return { ok: false, authority, budget, data: null, error: { code: 'NO_ACTIVE_RUN', message: 'This Work has no active coordination run yet.' } };
    }
    if (requireCoordinator && grant.role !== 'coordinator') {
      return { ok: false, authority, budget, data: null, error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };
    }
    const data = await fn();
    return { ok: true, authority, budget, data };
  } catch (error) {
    const code = error instanceof LatteError ? error.code : 'INTERNAL';
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, authority, budget, data: null, error: { code, message } };
  }
}

export function createCoordinationTools(engine: CoordinationEngine) {
  return {
    // `latte_plan_submit`/`task_create` also need a live run (the same
    // `runId == null` guard `latte_report`/`check`/`ask` got in task 6.3):
    // a coordinator grant can be lazily resolved with no active run (the
    // run just ended, or the grant was set without ever starting one), and
    // there is nothing to submit a plan or create a task INTO.
    latte_plan_submit: (grant: CoordinationGrant, args: { tasks: Array<{ roleId: string; spec: string; dependsOn?: number[] }> }) =>
      wrap(engine, grant, true, () => engine.planSubmit(grant.runId as string, args.tasks).map((t) => ({ taskId: t.id, seq: t.seq })), true),

    latte_task_create: (grant: CoordinationGrant, args: { roleId: string; spec: string; dependsOn?: string[] }) =>
      wrap(engine, grant, true, () => {
        const task = engine.taskCreate(grant.runId as string, args);
        return { taskId: task.id, status: task.status };
      }, true),

    latte_dispatch: (grant: CoordinationGrant, args: { taskId: string }) =>
      // Caller-supplied bypass fields (e.g. a claimed `approved`/`status`, o
      // el `approvedGateId` que el esquema publicaba y este handler nunca
      // leyó) are dropped here at the schema boundary: only `taskId` is read
      // from `args`.
      // `requiresRun` prendido (D2): sin él, un `latte_dispatch` sobre un run ya
      // terminado entraba al motor y sólo fallaba tres chequeos más adentro,
      // después de leer el run y la tarea. Con el run cerrado no hay nada que
      // despachar, y decirlo acá no escribe una sola fila.
      wrap(engine, grant, true, () => engine.startDispatch({ grant, taskId: args.taskId }), true),

    latte_team_list: (grant: CoordinationGrant, _args: Record<string, never>) =>
      wrap(engine, grant, true, () => engine.teamList(grant.workId)),

    latte_report: (grant: CoordinationGrant, args: { taskId: string; outcome: 'succeeded' | 'failed'; summary: string; files?: string | null }) =>
      wrap(engine, grant, false, () => engine.report(grant, args.taskId, args.outcome, args.summary, args.files ?? null), true),

    // Sin `wait`: el servidor nunca esperó y el buzón todavía no tiene productor.
    latte_check: (grant: CoordinationGrant, _args: Record<string, never>) =>
      wrap(engine, grant, false, () => engine.check(grant.memberId), true),

    // R7: devuelve el `askId` explícitamente. Antes devolvía la fila entera y
    // el id venía de rebote, como un `id` entre otros campos: el agente no
    // tenía cómo saber que ESO era lo que después le pide `latte_ask_status`.
    // Lo que se necesita para seguir la conversación se nombra.
    latte_ask: (grant: CoordinationGrant, args: { question: string; ttlMinutes?: number; taskId?: string }) =>
      wrap(engine, grant, false, () => {
        const ask = engine.ask(grant, args.question, args.ttlMinutes, args.taskId);
        return { askId: ask.id, deadlineAt: ask.deadlineAt };
      }, true),

    // R7: la otra mitad de preguntar. Una pregunta CON tarea se responde sola —
    // la tarea vuelve a la cola y el prompt del re-despacho lleva la respuesta
    // adentro—, pero una pregunta SIN tarea (la del coordinador, que no está
    // despachado a nada) no tenía camino de vuelta: `latte_check` devuelve `[]`
    // por diseño y no existía nada más. El agente consulta y sigue.
    latte_ask_status: (grant: CoordinationGrant, args: { askId: string }) =>
      wrap(engine, grant, false, () => engine.askStatus(grant, args.askId), true),

    // The sentence becomes a gate (task 6.5): callable by ANY member, not
    // just a coordinator (`requireCoordinator:false`) — this is precisely
    // the tool the FORBIDDEN message above points a rejected worker toward.
    // Needs no active run (`requiresRun` left at its default `false`): the
    // whole point is that no run exists yet.
    latte_request_coordination: (grant: CoordinationGrant, args: CoordinationProposal) =>
      wrap(engine, grant, false, () => engine.requestCoordination(grant, args)),
  };
}
