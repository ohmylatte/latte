import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { MAX_ACTIVE_COORDINATION_RUNS } from '../../electron/coordination/limits';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * engine.ts is the single dispatch choke point. These tests exercise it
 * directly (not through IPC/MCP, which do not exist yet in Phase 3) — the
 * design's own testing strategy: "tools.ts handlers called directly with a
 * fake token"; here the engine itself is called with a fake grant.
 */
describe('CoordinationEngine — the dispatch choke point', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let clockValue: string;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }
  function worker(memberId: string): CoordinationGrant {
    return { workId, runId, memberId, role: 'worker' };
  }
  function advanceClock(iso: string) { clockValue = iso; }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    members = [];
    fakeCoordinationHub(b, members);
    clockValue = '2026-01-01T00:00:00.000Z';
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => clockValue,
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    // Ronda 4, juicio #3: el alta automatica quedo acotada a lo que la
    // persona aprobo. Este run nace de `startRun`, sin propuesta, asi que
    // declara aca los roles que su persona hubiera aprobado -- lo que se
    // esta probando es otra cosa.
    approveCoordinationRoles(b, runId, 'strategist', 'copywriter');
  });
  afterEach(() => b.cleanup());

  // --- 3.3/3.4: choke-point order + manual gate -----------------------------

  it('under manual authority, dispatch creates a pending_approval gate and does not invoke the member', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft the brief' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    expect(outcome.status).toBe('pending_approval');
    const dispatch = b.repo.getCoordinationDispatch(outcome.dispatchId);
    expect(dispatch.status).toBe('pending_approval');
    expect(b.hub.send).not.toHaveBeenCalled();
    expect(b.repo.getCoordinationTask(task.id).status).toBe('dispatched');
  });

  it('approving a manual gate starts the dispatch and sends the prompt', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft the brief' });
    const first = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const resolved = await engine.resolveGate(first.dispatchId, 'approve');
    expect((resolved as { status: string }).status).toBe('dispatched');
    expect(b.hub.send).toHaveBeenCalledTimes(1);
    expect(b.repo.getCoordinationDispatch(first.dispatchId).status).toBe('dispatched');
  });

  it('rejecting a manual gate returns the task to ready and never invokes the member', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft the brief' });
    const first = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    await engine.resolveGate(first.dispatchId, 'reject');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    expect(b.hub.send).not.toHaveBeenCalled();
    expect(b.repo.getCoordinationDispatch(first.dispatchId).status).toBe('rejected');
  });

  // --- 3.5: plan mode --------------------------------------------------------

  describe('plan authority', () => {
    beforeEach(async () => {
      await b.service.setCoordinationAuthority(workId, 'plan');
    });

    it('gates a dispatch before the plan is approved', async () => {
      const [task] = engine.planSubmit(runId, [{ roleId: 'strategist', spec: 'A' }]);
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(outcome.status).toBe('pending_approval');
    });

    it('dispatches directly once the plan is approved, for a task in the snapshot', async () => {
      const [task] = engine.planSubmit(runId, [{ roleId: 'strategist', spec: 'A' }]);
      const run = engine.getRun(runId);
      await engine.resolveGate(`plan:${run.id}`, 'approve');
      expect(b.repo.getCoordinationTask(task.id).inPlan).toBe(true);
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(outcome.status).toBe('dispatched');
    });

    it('still gates a task created after plan approval', async () => {
      const [task] = engine.planSubmit(runId, [{ roleId: 'strategist', spec: 'A' }]);
      await engine.resolveGate(`plan:${runId}`, 'approve');
      const later = engine.taskCreate(runId, { roleId: 'strategist', spec: 'B (added later)' });
      expect(later.inPlan).toBe(false);
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: later.id });
      expect(outcome.status).toBe('pending_approval');
      // The snapshot task is unaffected by the later task's own gate.
      expect(b.repo.getCoordinationTask(task.id).inPlan).toBe(true);
    });
  });

  // --- 3.6: auto mode ---------------------------------------------------------

  it('under auto authority, dispatch proceeds immediately with no gate row', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    expect(outcome.status).toBe('dispatched');
    const dispatches = b.repo.listCoordinationDispatches(runId).filter((d) => d.taskId === task.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('dispatched');
    expect(b.hub.send).toHaveBeenCalledTimes(1);
  });

  // --- 3.7: attempt cap --------------------------------------------------------

  it('a task blocks after its 3rd consecutive failure', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Flaky' });
    for (let i = 0; i < 2; i += 1) {
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const dispatch = b.repo.getCoordinationDispatch(outcome.dispatchId);
      const updated = await engine.report(worker(dispatch.memberId), task.id, 'failed', 'nope');
      expect(updated.status).toBe('ready');
    }
    const third = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const dispatch3 = b.repo.getCoordinationDispatch(third.dispatchId);
    const final = await engine.report(worker(dispatch3.memberId), task.id, 'failed', 'still nope');
    expect(final.status).toBe('blocked');
    expect(final.attempts).toBe(3);
  });

  // --- 3.8: busy member --------------------------------------------------------

  it('a busy member fails the dispatch cleanly and leaves the task ready', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    members.push({ id: 'mem_busy', workId, roleId: 'strategist', status: 'working' });
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft' });
    await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toMatchObject({ code: 'MEMBER_BUSY' });
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    expect(b.hub.send).not.toHaveBeenCalled();
  });

  // --- 3.9: report outcome -----------------------------------------------------

  describe('report', () => {
    beforeEach(async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
    });

    it('a successful report unblocks a dependent task', async () => {
      const upstream = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Upstream' });
      const downstream = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Downstream', dependsOn: [upstream.id] });
      expect(downstream.status).toBe('pending');
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: upstream.id });
      const dispatch = b.repo.getCoordinationDispatch(outcome.dispatchId);
      await engine.report(worker(dispatch.memberId), upstream.id, 'succeeded', 'done');
      expect(b.repo.getCoordinationTask(upstream.id).status).toBe('done');
      expect(b.repo.getCoordinationTask(downstream.id).status).toBe('ready');
    });

    it('a duplicate success report is a no-op', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Once' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const dispatch = b.repo.getCoordinationDispatch(outcome.dispatchId);
      const first = await engine.report(worker(dispatch.memberId), task.id, 'succeeded', 'done');
      const dispatchCountBefore = b.repo.listCoordinationDispatches(runId).length;
      const second = await engine.report(worker(dispatch.memberId), task.id, 'succeeded', 'done again');
      expect(second).toEqual(first);
      expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(dispatchCountBefore);
    });

    it('a report from a member other than the current dispatch target is rejected without mutation', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Assigned' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const before = b.repo.getCoordinationTask(task.id);
      await expect(engine.report(worker('mem_impostor'), task.id, 'succeeded', 'nice try')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(b.repo.getCoordinationTask(task.id)).toEqual(before);
      void outcome;
    });
  });

  // --- 3.10: maxConcurrent — reject, never queue; coordinator exemption ------

  describe('maxConcurrent', () => {
    it('denies a dispatch at the cap: a denied ledger row is written, no dispatch row is created, task stays ready', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 10, maxConcurrent: 1 });
      const run = engine.getRun(runId);
      expect(JSON.parse(run.budgetJson).maxConcurrent).toBe(1); // raising propagated to the active run's own snapshot

      const taskA = engine.taskCreate(runId, { roleId: 'strategist', spec: 'A' });
      await engine.startDispatch({ grant: coordinator(), taskId: taskA.id }); // occupies the one slot

      const taskB = engine.taskCreate(runId, { roleId: 'copywriter', spec: 'B' });
      const before = b.repo.listCoordinationDispatches(runId).length;
      await expect(engine.startDispatch({ grant: coordinator(), taskId: taskB.id })).rejects.toMatchObject({ code: 'MAX_CONCURRENT' });
      expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(before); // no dispatch row for B
      expect(b.repo.getCoordinationTask(taskB.id).status).toBe('ready');
      const ledger = b.repo.listCoordinationCostLedger(runId);
      expect(ledger.some((l) => l.kind === 'denied')).toBe(true);
    });

    it('the coordinator is exempt from maxConcurrent: it never occupies a dispatch slot itself', async () => {
      // Proven, not assumed: the coordinator dispatches tasks to WORKERS, so it
      // never has a coordination_dispatch row of its own. With maxConcurrent:1
      // fully occupied by one worker's dispatch, the coordinator's own grant
      // still lets it keep calling tools (team_list here — a coordinator-only,
      // non-dispatching tool) without being blocked by the very cap it must
      // enforce on dispatch targets.
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 10, maxConcurrent: 1 });
      const tools = createCoordinationTools(engine);
      const taskA = engine.taskCreate(runId, { roleId: 'strategist', spec: 'A' });
      await engine.startDispatch({ grant: coordinator(), taskId: taskA.id });
      expect(b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched')).toHaveLength(1);

      const list = await tools.latte_team_list(coordinator(), {});
      expect(list.ok).toBe(true); // the coordinator's own call is never rejected by the concurrency cap
      expect(list.budget).toMatchObject({ inFlight: 1, maxConcurrent: 1 });

      // And the coordinator itself never appears as a dispatch's member.
      const dispatches = b.repo.listCoordinationDispatches(runId);
      expect(dispatches.every((d) => d.memberId !== coordinator().memberId)).toBe(true);
    });
  });

  // --- 3.11: mailbox -----------------------------------------------------------

  it('the mailbox delivers undelivered messages in FIFO order exactly once', () => {
    b.repo.insertCoordinationMessage({ id: 'cms_a', runId, toMemberId: 'mem_x', fromMemberId: null, kind: 'note', body: 'A', deliveredAt: null, createdAt: '2026-01-01T00:00:00.000Z' });
    b.repo.insertCoordinationMessage({ id: 'cms_b', runId, toMemberId: 'mem_x', fromMemberId: null, kind: 'note', body: 'B', deliveredAt: null, createdAt: '2026-01-01T00:00:01.000Z' });
    b.repo.insertMember({ id: 'mem_x', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(engine.check('mem_x').map((m) => m.body)).toEqual(['A', 'B']);
    expect(engine.check('mem_x')).toEqual([]);
  });

  it('latte_check never actually blocks: ya no publica ningun `wait` que ignorar', () => {
    b.repo.insertMember({ id: 'mem_y', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const started = Date.now();
    const result = engine.check('mem_y');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual([]);
  });

  // --- 3.12: ask TTL -------------------------------------------------------------

  it('an ask defaults to a 30-minute TTL and clamps an oversized one to 1440 minutes', () => {
    const withDefault = engine.ask(worker('mem_a'), '¿Tono?');
    expect(withDefault.deadlineAt).toBe('2026-01-01T00:30:00.000Z');
    const withCap = engine.ask(worker('mem_b'), '¿Tono largo?', 999999);
    expect(withCap.deadlineAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('an expired, unanswered ask reports {answered:false, deadline} on the next poll', () => {
    const ask = engine.ask(worker('mem_a'), '¿Tono?', 30);
    advanceClock('2026-01-01T00:31:00.000Z'); // 31 minutes later, past the deadline
    expect(engine.askStatus(ask.id)).toEqual({ answered: false, deadline: ask.deadlineAt });
  });

  // --- 3.13: self-suspend -----------------------------------------------------

  it('self-suspends when every ready-eligible task is blocked on a distinct unanswered ask', () => {
    const taskA = engine.taskCreate(runId, { roleId: 'strategist', spec: 'A' });
    const taskB = engine.taskCreate(runId, { roleId: 'copywriter', spec: 'B' });
    engine.ask(worker('mem_a'), '¿A?', 30, taskA.id);
    expect(engine.getRun(runId).status).toBe('running'); // only one of two blocked so far
    engine.ask(worker('mem_b'), '¿B?', 30, taskB.id);
    const run = engine.getRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('all_blocked_on_ask');
  });

  // --- 3.14: crash settlement --------------------------------------------------

  describe('crash settlement', () => {
    it('an app-restart crash settles the reservation uncertain and leaves attempts unchanged', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      engine.settleUncertain(outcome.dispatchId, { incrementAttempts: false });
      expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
      const dispatch = b.repo.getCoordinationDispatch(outcome.dispatchId);
      expect(b.repo.getCoordinationCostReservation(dispatch.reservationId!)).toMatchObject({ state: 'uncertain' });
    });

    it('a member-process death settles the reservation uncertain and increments attempts', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      engine.settleUncertain(outcome.dispatchId, { incrementAttempts: true });
      expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 1 });
    });
  });

  // --- 3.19: manual dispatch settlement — the missing "close" half of the
  // safety line. `latte_report` is called by the WORKER; without MCP no
  // worker has tools, so nothing settles a dispatch. `settleDispatch` lets a
  // human (who already reads the worker's chat under manual authority) close
  // it directly, entering through `report()` — the exact function
  // `latte_report` calls — so every rule it enforces applies unchanged.

  describe('settleDispatch — manual settlement, reuses report()', () => {
    beforeEach(async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
    });

    it('reuses report(): calling settleDispatch invokes the same report() function latte_report calls, not a parallel path', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Draft' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      const reportSpy = vi.spyOn(engine, 'report');

      await engine.settleDispatch(task.id, 'succeeded', 'Done by hand');

      expect(reportSpy).toHaveBeenCalledTimes(1);
      const [grantArg, taskIdArg, outcomeArg, summaryArg] = reportSpy.mock.calls[0];
      expect(grantArg).toMatchObject({ memberId, role: 'worker' });
      expect(taskIdArg).toBe(task.id);
      expect(outcomeArg).toBe('succeeded');
      expect(summaryArg).toBe('Done by hand');
    });

    it('a succeeded settlement unblocks dependents and settles the budget reservation as spend, same as latte_report', async () => {
      const upstream = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Upstream' });
      const downstream = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Downstream', dependsOn: [upstream.id] });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: upstream.id });
      expect(b.repo.getCoordinationDispatch(outcome.dispatchId).settledAt).toBeNull();

      const updated = await engine.settleDispatch(upstream.id, 'succeeded', 'Done by hand');

      expect(updated.status).toBe('done');
      expect(b.repo.getCoordinationTask(downstream.id).status).toBe('ready');
      const dispatchAfter = b.repo.getCoordinationDispatch(outcome.dispatchId);
      expect(dispatchAfter.status).toBe('reported');
      expect(dispatchAfter.settledAt).not.toBeNull(); // the dispatch's settling timestamp — the bitácora's only source
      expect(b.repo.getCoordinationCostReservation(dispatchAfter.reservationId!)).toMatchObject({ state: 'settled' });
      expect(b.repo.listCoordinationCostLedger(runId).some((l) => l.kind === 'spend')).toBe(true);
    });

    it('a failed settlement returns the task to ready, same as an agent-reported failure', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Flaky' });
      await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      const updated = await engine.settleDispatch(task.id, 'failed', 'nope');

      expect(updated.status).toBe('ready');
      expect(updated.attempts).toBe(1);
    });

    it('a 3rd manually-settled failure blocks the task — the same attempt cap latte_report enforces', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Flaky' });
      for (let i = 0; i < 2; i += 1) {
        await engine.startDispatch({ grant: coordinator(), taskId: task.id });
        const updated = await engine.settleDispatch(task.id, 'failed', 'nope');
        expect(updated.status).toBe('ready');
      }
      await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      const final = await engine.settleDispatch(task.id, 'failed', 'still nope');

      expect(final.status).toBe('blocked');
      expect(final.attempts).toBe(3);
    });

    it('a repeated settlement of an already-done task is a no-op — identical to latte_report\'s own repeat semantics', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Once' });
      await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const first = await engine.settleDispatch(task.id, 'succeeded', 'done');
      const dispatchCountBefore = b.repo.listCoordinationDispatches(runId).length;

      const second = await engine.settleDispatch(task.id, 'succeeded', 'done again');

      expect(second).toEqual(first);
      expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(dispatchCountBefore);
    });

    it('settling a task with no active dispatch is rejected without mutation — only the assigned dispatch can be settled', async () => {
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Never dispatched' });
      const before = b.repo.getCoordinationTask(task.id);

      await expect(engine.settleDispatch(task.id, 'succeeded', 'nice try')).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(b.repo.getCoordinationTask(task.id)).toEqual(before);
    });
  });

  // --- 3.19 (test-hardening): resolveGate's budget-gate branch was
  // implemented in Phase 3 but only ever exercised indirectly. Focused test
  // for both directions — exactly the moment the product exists for: the
  // human coming back to a suspended run.

  describe("resolveGate — the budget gate branch (approve=resume, reject=cancel)", () => {
    async function suspendOnBudget(): Promise<{ budgetGateId: string }> {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 1 });
      // maxDispatches counts SETTLED spend (usage.dispatchesUsed), not merely
      // in-flight reservations — task A must be reported before the cap bites.
      const taskA = engine.taskCreate(runId, { roleId: 'strategist', spec: 'A' });
      const outcomeA = await engine.startDispatch({ grant: coordinator(), taskId: taskA.id });
      const memberIdA = b.repo.getCoordinationDispatch(outcomeA.dispatchId).memberId;
      await engine.report(worker(memberIdA), taskA.id, 'succeeded', 'done'); // consumes the only allowed dispatch
      const taskB = engine.taskCreate(runId, { roleId: 'strategist', spec: 'B' });
      await expect(engine.startDispatch({ grant: coordinator(), taskId: taskB.id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(engine.getRun(runId)).toMatchObject({ status: 'suspended', suspendReason: 'max_dispatches' });
      const gates = engine.listGates(runId);
      const budgetGate = gates.find((g) => g.kind === 'budget');
      expect(budgetGate).toBeDefined();
      return { budgetGateId: budgetGate!.id };
    }

    it('approving the budget gate resumes the suspended run', async () => {
      const { budgetGateId } = await suspendOnBudget();

      const resolved = await engine.resolveGate(budgetGateId, 'approve');

      expect((resolved as { status: string }).status).toBe('running');
      expect(engine.getRun(runId).status).toBe('running');
    });

    it('rejecting the budget gate cancels the run', async () => {
      const { budgetGateId } = await suspendOnBudget();

      const resolved = await engine.resolveGate(budgetGateId, 'reject');

      expect((resolved as { status: string }).status).toBe('cancelled');
      expect(engine.getRun(runId).status).toBe('cancelled');
    });
  });

  // --- 6.2: resolveGrant — LAZY resolution, never frozen at mint -------------
  // (design-v2-conversational overrules v1). `tokens.ts` binds only
  // {workId, memberId}; this is the per-request resolver that derives runId
  // and role fresh every call — no re-mint, no respawn, no revocation.

  describe('resolveGrant — the grant is resolved per request, never frozen at mint', () => {
    it('(i) with no run yet, resolves runId:null and role:worker', async () => {
      const brand2 = await b.service.createBrand('Otra marca');
      const otherWork = await b.service.createWork(brand2.id, 'Otro trabajo');

      const grant = engine.resolveGrant(otherWork.id, 'mem_x');

      expect(grant).toEqual({ workId: otherWork.id, memberId: 'mem_x', runId: null, role: 'worker' });
    });

    it('(ii) a run starts afterward: the same member id now resolves to it, no re-mint, no respawn', async () => {
      const brand2 = await b.service.createBrand('Otra marca 2');
      const work2 = await b.service.createWork(brand2.id, 'Otro trabajo 2');
      await b.service.setCoordinationBudget(work2.id, { maxDispatches: 5 });

      const before = engine.resolveGrant(work2.id, 'mem_y');
      expect(before.runId).toBeNull();

      const startedRun = await engine.startRun(work2.id, null);
      const after = engine.resolveGrant(work2.id, 'mem_y');

      expect(after.runId).toBe(startedRun.id);
      expect(after.role).toBe('worker');
    });

    it('(iii) the coordinator meta key is set to this member: role flips to coordinator', async () => {
      b.repo.insertMember({ id: 'mem_z', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

      await b.service.setCoordinatorGrant(workId, 'mem_z');

      expect(engine.resolveGrant(workId, 'mem_z').role).toBe('coordinator');
    });

    it('(iv) the grant is transferred away: the same member flips back to worker with no revocation step', async () => {
      b.repo.insertMember({ id: 'mem_z', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      b.repo.insertMember({ id: 'mem_other', workId, roleId: 'copywriter', roleName: 'Copywriter', initial: 'C', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

      await b.service.setCoordinatorGrant(workId, 'mem_z');
      expect(engine.resolveGrant(workId, 'mem_z').role).toBe('coordinator');

      await b.service.setCoordinatorGrant(workId, 'mem_other'); // no revoke() call anywhere — the meta write alone is enough
      expect(engine.resolveGrant(workId, 'mem_z').role).toBe('worker');
      expect(engine.resolveGrant(workId, 'mem_other').role).toBe('coordinator');
    });
  });

  // --- 6.3: a grant with no active run ----------------------------------------
  // `CoordinationGrant.runId` widens to `string | null`;
  // `budgetBlockForEnvelope(null)` must answer honestly instead of throwing;
  // `latte_report`/`check`/`ask` with a null-run grant must fail cleanly.

  describe('a grant with no active run', () => {
    it('budgetBlockForEnvelope(null) returns the honest zeroed block instead of throwing NotFound', () => {
      const block = engine.budgetBlockForEnvelope(null);
      expect(block).toEqual({ dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null });
    });

    it('latte_report / latte_check / latte_ask each return {ok:false, error.code:NO_ACTIVE_RUN} and mutate nothing', async () => {
      const tools = createCoordinationTools(engine);
      const grant: CoordinationGrant = { workId, runId: null, memberId: 'mem_no_run', role: 'worker' };
      const asksBefore = b.repo.listOpenCoordinationAsks(runId);

      const reportEnvelope = await tools.latte_report(grant, { taskId: 'ctk_whatever', outcome: 'succeeded', summary: 'x' });
      expect(reportEnvelope).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_RUN' } });

      const checkEnvelope = await tools.latte_check(grant, {});
      expect(checkEnvelope).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_RUN' } });

      const askEnvelope = await tools.latte_ask(grant, { question: '¿Qué hago?' });
      expect(askEnvelope).toMatchObject({ ok: false, error: { code: 'NO_ACTIVE_RUN' } });

      // Nothing was mutated anywhere, including the real active run from beforeEach.
      expect(b.repo.listOpenCoordinationAsks(runId)).toEqual(asksBefore);
    });

    it('engine.report/ask throw NO_ACTIVE_RUN directly too, for any caller that bypasses tools.ts', async () => {
      const grant: CoordinationGrant = { workId, runId: null, memberId: 'mem_no_run', role: 'worker' };
      await expect(engine.report(grant, 'ctk_whatever', 'succeeded', 'x')).rejects.toMatchObject({ code: 'NO_ACTIVE_RUN' });
      expect(() => engine.ask(grant, '¿Qué hago?')).toThrowError(expect.objectContaining({ code: 'NO_ACTIVE_RUN' }));
    });
  });

  // --- 6.15: the app-wide active-run ceiling — never a silent queue ----------
  // With MAX_ACTIVE_COORDINATION_RUNS active runs spread across several
  // Brands, a 5th attempt (either a plain startRun OR a worker's proposal)
  // must FAIL naming the busy Works, never queue invisibly.

  describe('the app-wide active-run ceiling (task 6.15)', () => {
    async function fillCeilingWithBusyWorks(): Promise<Array<{ workId: string; title: string }>> {
      // The outer beforeEach already started ONE active run (runId, on
      // `workId`) — cancel it first so the arithmetic below is exact: after
      // this, filling MAX_ACTIVE_COORDINATION_RUNS more active runs reaches
      // the ceiling precisely.
      engine.cancelRun(runId);
      const busy: Array<{ workId: string; title: string }> = [];
      for (let i = 0; i < MAX_ACTIVE_COORDINATION_RUNS; i += 1) {
        const brand = await b.service.createBrand(`Marca ocupada ${i}`);
        const work = await b.service.createWork(brand.id, `Trabajo ocupado ${i}`);
        await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
        await engine.startRun(work.id, null);
        busy.push({ workId: work.id, title: work.title });
      }
      return busy;
    }

    it('a 5th startRun fails TOO_MANY_ACTIVE_RUNS, naming every busy Work', async () => {
      const busy = await fillCeilingWithBusyWorks();
      const brandN = await b.service.createBrand('Marca nueva');
      const workN = await b.service.createWork(brandN.id, 'Trabajo nuevo');
      await b.service.setCoordinationBudget(workN.id, { maxDispatches: 5 });

      let caught: unknown;
      try {
        await engine.startRun(workN.id, null);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: 'TOO_MANY_ACTIVE_RUNS' });
      const message = (caught as Error).message;
      for (const w of busy) expect(message).toContain(w.title);
      // And nothing was written for the rejected 5th Work.
      expect(b.repo.findActiveCoordinationRun(workN.id)).toBeNull();
    });

    it('a 5th requestCoordination (a worker\'s proposal) fails identically, naming every busy Work', async () => {
      const busy = await fillCeilingWithBusyWorks();
      const brandN = await b.service.createBrand('Marca nueva 2');
      const workN = await b.service.createWork(brandN.id, 'Trabajo nuevo 2');
      const proposerGrant: CoordinationGrant = { workId: workN.id, runId: null, memberId: 'mem_proposer', role: 'worker' };

      let caught: unknown;
      try {
        await engine.requestCoordination(proposerGrant, { plan: [], estimatedDispatches: 1, rationale: 'Propongo coordinar' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: 'TOO_MANY_ACTIVE_RUNS' });
      const message = (caught as Error).message;
      for (const w of busy) expect(message).toContain(w.title);
      expect(b.repo.findActiveCoordinationRun(workN.id)).toBeNull();
    });

    it('does not reject a Work at exactly the ceiling minus one busy Work — only the (N+1)th attempt fails', async () => {
      // MAX_ACTIVE_COORDINATION_RUNS - 1 busy Works, plus the outer
      // beforeEach's own already-active run on `workId`, is exactly the
      // ceiling: a 5th Work should still start cleanly.
      engine.cancelRun(runId);
      for (let i = 0; i < MAX_ACTIVE_COORDINATION_RUNS - 1; i += 1) {
        const brand = await b.service.createBrand(`Marca llena ${i}`);
        const work = await b.service.createWork(brand.id, `Trabajo lleno ${i}`);
        await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
        await engine.startRun(work.id, null);
      }
      const brandLast = await b.service.createBrand('Marca justo a tiempo');
      const workLast = await b.service.createWork(brandLast.id, 'Trabajo justo a tiempo');
      await b.service.setCoordinationBudget(workLast.id, { maxDispatches: 5 });

      const run = await engine.startRun(workLast.id, null);

      expect(run.status).toBe('running');
      expect(b.repo.countActiveCoordinationRuns()).toBe(MAX_ACTIVE_COORDINATION_RUNS);
    });
  });
});

// Task 6.37: the `latte:coordination-event` channel's underlying trigger --
// an optional `emit` dep, called on run/task/dispatch/gate changes, carrying
// `{brandId, workId, runId}`. A separate engine instance (`b`'s own hub, a
// fresh `CoordinationEngine`) so this file's existing fixtures are untouched.
describe('CoordinationEngine — emits a coordination event on state changes (task 6.37)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let emitted: Array<{ brandId: string; workId: string; runId: string | null }>;
  let workId: string;
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    brandId = brand.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    fakeCoordinationHub(b, []);
    emitted = [];
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
      emit: (event) => emitted.push(event),
    });
  });
  afterEach(() => b.cleanup());

  it('fires on startRun with {brandId, workId, runId}', async () => {
    const run = await engine.startRun(workId, null);
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
  });

  it('fires on requestCoordination (a run created with no run yet)', async () => {
    const run = await engine.requestCoordination(
      { workId, runId: null, memberId: 'mem_worker', role: 'worker' },
      { plan: [{ roleId: 'strategist', spec: 'x' }], estimatedDispatches: 3, rationale: 'y' },
    );
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
  });

  it('fires on pauseRun/resumeRun/cancelRun', async () => {
    const run = await engine.startRun(workId, null);
    emitted.length = 0;
    engine.pauseRun(run.id);
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
    emitted.length = 0;
    engine.resumeRun(run.id);
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
    emitted.length = 0;
    engine.cancelRun(run.id);
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
  });

  it('fires on resolveGate (a dispatch gate approval)', async () => {
    const run = await engine.startRun(workId, null);
    // Ronda 4, juicio #3: un run de `startRun` no trae roles aprobados, y el
    // alta automatica quedo acotada a ellos. Lo que se prueba aca es otra cosa.
    approveCoordinationRoles(b, run.id, 'strategist');
    await b.service.setCoordinationAuthority(workId, 'manual');
    const task = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'Draft the brief' });
    const dispatch = await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' }, taskId: task.id });
    emitted.length = 0;
    await engine.resolveGate(dispatch.dispatchId, 'approve');
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
  });

  it('fires on report/startDispatch (a task/dispatch change) and on settleDispatch', async () => {
    const run = await engine.startRun(workId, null);
    // Ronda 4, juicio #3: un run de `startRun` no trae roles aprobados, y el
    // alta automatica quedo acotada a ellos. Lo que se prueba aca es otra cosa.
    approveCoordinationRoles(b, run.id, 'strategist');
    await b.service.setCoordinationAuthority(workId, 'auto');
    const task = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'Draft the brief' });
    emitted.length = 0;
    await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' }, taskId: task.id });
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
    emitted.length = 0;
    await engine.settleDispatch(task.id, 'succeeded', 'done');
    expect(emitted).toContainEqual({ brandId, workId, runId: run.id });
  });

  it('never throws or fires when no emit dep was supplied (existing tests, no behaviour change)', async () => {
    const bare = new CoordinationEngine({ repo: b.repo, hub: b.hub, clock: () => '2026-01-01T00:00:00.000Z', memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }) });
    await expect(bare.startRun(workId, null)).resolves.toBeTruthy();
  });
});
