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
import type { CoordinationBudgetBlock, CoordinationEngine, CoordinationGrant } from './engine';

export interface ToolEnvelope<T> {
  ok: boolean;
  authority: CoordinationAuthorityMode;
  budget: CoordinationBudgetBlock;
  data: T | null;
  error?: { code: string; message: string };
}

async function wrap<T>(engine: CoordinationEngine, grant: CoordinationGrant, requireCoordinator: boolean, fn: () => Promise<T> | T): Promise<ToolEnvelope<T>> {
  const authority = engine.readAuthorityForEnvelope(grant.workId);
  const budget = engine.budgetBlockForEnvelope(grant.runId);
  if (requireCoordinator && grant.role !== 'coordinator') {
    return { ok: false, authority, budget, data: null, error: { code: 'FORBIDDEN', message: 'This tool requires the coordinator grant' } };
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
    latte_plan_submit: (grant: CoordinationGrant, args: { tasks: Array<{ roleId: string; spec: string; dependsOn?: number[] }> }) =>
      wrap(engine, grant, true, () => engine.planSubmit(grant.runId, args.tasks).map((t) => ({ taskId: t.id, seq: t.seq }))),

    latte_task_create: (grant: CoordinationGrant, args: { roleId: string; spec: string; dependsOn?: string[] }) =>
      wrap(engine, grant, true, () => {
        const task = engine.taskCreate(grant.runId, args);
        return { taskId: task.id, status: task.status };
      }),

    latte_dispatch: (grant: CoordinationGrant, args: { taskId: string; approvedGateId?: string }) =>
      // Caller-supplied bypass fields (e.g. a claimed `approved`/`status`) are
      // dropped here at the schema boundary: only `taskId` is read from `args`.
      wrap(engine, grant, true, () => engine.startDispatch({ grant, taskId: args.taskId })),

    latte_team_list: (grant: CoordinationGrant, _args: Record<string, never>) =>
      wrap(engine, grant, true, () => engine.teamList(grant.workId)),

    latte_report: (grant: CoordinationGrant, args: { taskId: string; outcome: 'succeeded' | 'failed'; summary: string; files?: string | null }) =>
      wrap(engine, grant, false, () => engine.report(grant, args.taskId, args.outcome, args.summary, args.files ?? null)),

    latte_check: (grant: CoordinationGrant, args: { wait?: number }) =>
      wrap(engine, grant, false, () => engine.check(grant.memberId, args.wait)),

    latte_ask: (grant: CoordinationGrant, args: { question: string; ttlMinutes?: number; taskId?: string }) =>
      wrap(engine, grant, false, () => engine.ask(grant, args.question, args.ttlMinutes, args.taskId)),
  };
}
