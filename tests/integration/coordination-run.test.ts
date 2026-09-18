import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from '../backend/helpers';

/**
 * End-to-end: `latte_plan_submit → latte_dispatch → latte_report → done`
 * under manual authority, driving the run lifecycle through the real IPC
 * surface (`LatteService`) and the dispatch protocol through `tools.ts` —
 * exactly the two halves Phase 3 ships (IPC for the human, tools.ts for the
 * coordinator/worker protocol MCP will carry in Phase 6). Fake hub, fake
 * runner: zero real spawns anywhere in this test.
 */
describe('coordination run: plan_submit -> dispatch -> report -> done (manual authority)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tools: ReturnType<typeof createCoordinationTools>;
  let workId: string;
  let members: FakeTeamMember[];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
    await b.service.setCoordinationAuthority(workId, 'manual');
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tools = createCoordinationTools(engine);
  });
  afterEach(() => b.cleanup());

  it('runs a two-task plan end to end with zero real spawns', async () => {
    // 1. A human starts the run through the real IPC surface.
    const run = await b.service.startCoordinationRun(workId);
    expect(run.status).toBe('running');

    const coordinatorGrant = { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' as const };

    // 2. The coordinator submits a two-task plan (independent tasks, both
    // ready immediately) — `latte_plan_submit`.
    const submitted = await tools.latte_plan_submit(coordinatorGrant, {
      tasks: [
        { roleId: 'strategist', spec: 'Draft the brief' },
        { roleId: 'copywriter', spec: 'Write the headline' },
      ],
    });
    expect(submitted.ok).toBe(true);
    const [taskA, taskB] = submitted.data as Array<{ taskId: string }>;

    // 3. Dispatching under manual authority always gates first.
    const dispatchA = await tools.latte_dispatch(coordinatorGrant, { taskId: taskA.taskId });
    expect(dispatchA.data).toMatchObject({ status: 'pending_approval' });
    expect(b.hub.send).not.toHaveBeenCalled();

    // 4. A human approves the gate over IPC.
    const gatesBefore = await b.service.listCoordinationGates(run.id);
    expect(gatesBefore).toHaveLength(1);
    await b.service.resolveCoordinationGate(gatesBefore[0].id, 'approve');
    expect(b.hub.send).toHaveBeenCalledTimes(1);

    const memberId = b.repo.getCoordinationTask(taskA.taskId).assignedMemberId!;

    // 5. The worker reports success — `latte_report`.
    const workerGrant = { workId, runId: run.id, memberId, role: 'worker' as const };
    const reported = await tools.latte_report(workerGrant, { taskId: taskA.taskId, outcome: 'succeeded', summary: 'Brief drafted' });
    expect(reported.ok).toBe(true);
    expect((reported.data as { status: string }).status).toBe('done');

    // 6. The bitácora reflects exactly this one completed dispatch lifecycle.
    const log = await b.service.listCoordinationLog(run.id);
    expect(log.filter((l) => l.taskId === taskA.taskId)).toHaveLength(1);
    expect(log.find((l) => l.taskId === taskA.taskId)?.status).toBe('reported');

    // 7. Second task follows the identical gate -> approve -> report path.
    const dispatchB = await tools.latte_dispatch(coordinatorGrant, { taskId: taskB.taskId });
    expect(dispatchB.data).toMatchObject({ status: 'pending_approval' });
    const gatesForB = await b.service.listCoordinationGates(run.id);
    expect(gatesForB).toHaveLength(1); // A's gate is resolved, only B's remains
    await b.service.resolveCoordinationGate(gatesForB[0].id, 'approve');
    const memberIdB = b.repo.getCoordinationTask(taskB.taskId).assignedMemberId!;
    const reportedB = await tools.latte_report({ workId, runId: run.id, memberId: memberIdB, role: 'worker' }, { taskId: taskB.taskId, outcome: 'succeeded', summary: 'Headline written' });
    expect((reportedB.data as { status: string }).status).toBe('done');

    // Both tasks done; nothing left pending. Zero real spawns: the fake
    // runner/pty from `makeBackend()` were never touched by any of this.
    const tasks = b.repo.listCoordinationTasks(run.id);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
  });
});
