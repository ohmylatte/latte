import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

// Spec: "Non-Coordinator Tool Rejection" + "Dispatch Is Always Callable" +
// "Gate cannot be bypassed by the caller". tools.ts is a thin (grant, args) =>
// envelope layer over engine.ts: these tests call the handlers directly with
// a fake token (a plain grant object), exactly as the design's testing
// strategy prescribes for Phase 3 (no HTTP, no MCP).

describe('coordination tools: grant enforcement and envelope stability', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tools: ReturnType<typeof createCoordinationTools>;
  let workId: string;
  let runId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    const members: FakeTeamMember[] = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    tools = createCoordinationTools(engine);
  });
  afterEach(() => b.cleanup());

  const workerGrant = () => ({ workId, runId, memberId: 'mem_worker', role: 'worker' as const });
  const coordinatorGrant = () => ({ workId, runId, memberId: 'mem_coord', role: 'coordinator' as const });

  it('rejects latte_plan_submit from a non-coordinator without mutating run state', async () => {
    const envelope = await tools.latte_plan_submit(workerGrant(), { tasks: [{ roleId: 'strategist', spec: 'Draft' }] });
    expect(envelope.ok).toBe(false);
    expect(b.repo.listCoordinationTasks(runId)).toEqual([]);
  });

  it('rejects latte_task_create from a non-coordinator without mutating run state', async () => {
    const envelope = await tools.latte_task_create(workerGrant(), { roleId: 'strategist', spec: 'Draft' });
    expect(envelope.ok).toBe(false);
    expect(b.repo.listCoordinationTasks(runId)).toEqual([]);
  });

  it('rejects latte_dispatch from a non-coordinator without creating a dispatch row', async () => {
    const created = await tools.latte_task_create(coordinatorGrant(), { roleId: 'strategist', spec: 'Draft' });
    const taskId = (created.data as { taskId: string }).taskId;
    const envelope = await tools.latte_dispatch(workerGrant(), { taskId });
    expect(envelope.ok).toBe(false);
    expect(b.repo.listCoordinationDispatches(runId)).toEqual([]);
  });

  it('rejects latte_team_list from a non-coordinator', async () => {
    const envelope = await tools.latte_team_list(workerGrant(), {});
    expect(envelope.ok).toBe(false);
  });

  // Task 6.4: a rejection that does not teach the path is the bug this task
  // exists for. The FORBIDDEN envelope must NAME latte_request_coordination.
  it('the FORBIDDEN rejection names latte_request_coordination as the path to the grant', async () => {
    const envelope = await tools.latte_dispatch(workerGrant(), { taskId: 'ctk_whatever' });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('FORBIDDEN');
    expect(envelope.error?.message).toContain('latte_request_coordination');
  });

  it('the dispatch envelope shape is stable across manual and auto authority, differing only in data.status', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const manualTask = await tools.latte_task_create(coordinatorGrant(), { roleId: 'strategist', spec: 'A' });
    const manualId = (manualTask.data as { taskId: string }).taskId;
    const manualDispatch = await tools.latte_dispatch(coordinatorGrant(), { taskId: manualId });
    expect(manualDispatch.ok).toBe(true);
    expect(manualDispatch.data).toMatchObject({ status: 'pending_approval' });
    expect(manualDispatch).toEqual(expect.objectContaining({ ok: true, authority: 'manual', budget: expect.any(Object), data: expect.any(Object) }));

    await b.service.setCoordinationAuthority(workId, 'auto');
    const autoTask = await tools.latte_task_create(coordinatorGrant(), { roleId: 'strategist', spec: 'B' });
    const autoId = (autoTask.data as { taskId: string }).taskId;
    const autoDispatch = await tools.latte_dispatch(coordinatorGrant(), { taskId: autoId });
    expect(autoDispatch.ok).toBe(true);
    expect(autoDispatch.data).toMatchObject({ status: 'dispatched' });
    expect(autoDispatch).toEqual(expect.objectContaining({ ok: true, authority: 'auto', budget: expect.any(Object), data: expect.any(Object) }));

    // Same keys on both envelopes; only data.status differs.
    expect(Object.keys(manualDispatch).sort()).toEqual(Object.keys(autoDispatch).sort());
  });

  it('a caller-supplied auto-approval override is ignored under manual authority (gate cannot be bypassed)', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const created = await tools.latte_task_create(coordinatorGrant(), { roleId: 'strategist', spec: 'Draft' });
    const taskId = (created.data as { taskId: string }).taskId;
    const envelope = await tools.latte_dispatch(coordinatorGrant(), {
      taskId,
      // @ts-expect-error -- deliberately supplying a bypass field the schema does not define
      approved: true,
      status: 'dispatched',
    });
    expect(envelope.data).toMatchObject({ status: 'pending_approval' });
  });
});
