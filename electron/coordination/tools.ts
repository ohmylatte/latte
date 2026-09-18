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

async function wrap<T>(engine: CoordinationEngine, grant: CoordinationGrant, requireCoordinator: boolean, fn: () => Promise<T> | T, requiresRun = false): Promise<ToolEnvelope<T>> {
  const authority = engine.readAuthorityForEnvelope(grant.workId);
  const budget = engine.budgetBlockForEnvelope(grant.runId);
  if (requireCoordinator && grant.role !== 'coordinator') {
    return { ok: false, authority, budget, data: null, error: { code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE } };
  }
  // `latte_report`/`check`/`ask` need a live run to act against; a grant
  // lazily resolved to `runId:null` (task 6.3) fails cleanly here instead of
  // reaching the engine at all — nothing is mutated because nothing runs.
  if (requiresRun && grant.runId == null) {
    return { ok: false, authority, budget, data: null, error: { code: 'NO_ACTIVE_RUN', message: 'This Work has no active coordination run yet.' } };
  }
  try {
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

    latte_dispatch: (grant: CoordinationGrant, args: { taskId: string; approvedGateId?: string }) =>
      // Caller-supplied bypass fields (e.g. a claimed `approved`/`status`) are
      // dropped here at the schema boundary: only `taskId` is read from `args`.
      wrap(engine, grant, true, () => engine.startDispatch({ grant, taskId: args.taskId })),

    latte_team_list: (grant: CoordinationGrant, _args: Record<string, never>) =>
      wrap(engine, grant, true, () => engine.teamList(grant.workId)),

    latte_report: (grant: CoordinationGrant, args: { taskId: string; outcome: 'succeeded' | 'failed'; summary: string; files?: string | null }) =>
      wrap(engine, grant, false, () => engine.report(grant, args.taskId, args.outcome, args.summary, args.files ?? null), true),

    // Sin `wait`: el servidor nunca esperó y el buzón todavía no tiene productor.
    latte_check: (grant: CoordinationGrant, _args: Record<string, never>) =>
      wrap(engine, grant, false, () => engine.check(grant.memberId), true),

    latte_ask: (grant: CoordinationGrant, args: { question: string; ttlMinutes?: number; taskId?: string }) =>
      wrap(engine, grant, false, () => engine.ask(grant, args.question, args.ttlMinutes, args.taskId), true),

    // The sentence becomes a gate (task 6.5): callable by ANY member, not
    // just a coordinator (`requireCoordinator:false`) — this is precisely
    // the tool the FORBIDDEN message above points a rejected worker toward.
    // Needs no active run (`requiresRun` left at its default `false`): the
    // whole point is that no run exists yet.
    latte_request_coordination: (grant: CoordinationGrant, args: CoordinationProposal) =>
      wrap(engine, grant, false, () => engine.requestCoordination(grant, args)),
  };
}
