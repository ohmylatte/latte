import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from '../backend/helpers';

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
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // task 8.1: this test drives startCoordinationRun through the real IPC surface
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
    // Ronda 4, juicio #3: la persona arranco el run y aprobo este equipo. Un
    // run sin propuesta ya no contrata roles que nadie vio; aca los declara.
    approveCoordinationRoles(b, run.id, 'strategist', 'copywriter');

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
    // El largo primero, igual que el test de abajo: `.every()` sobre una lista
    // vacía es `true`, y "todas las tareas terminaron" sobre cero tareas no
    // afirma nada.
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
  });
});

/**
 * The full conversational path (autonomous-coordination Phase 7 task 7.14):
 * a worker's `latte_request_coordination` -> ONE proposal gate ->
 * ONE `resolveCoordinationGate('approve')` -> grant + budget + authority +
 * hires + tasks land together -> the first dispatch fires. Fake hub, fake
 * runner, zero real spawns anywhere in this test — this is the scenario a
 * person triggers by typing "Coordina al equipo y preparen el contenido
 * del mes" (`latte/coordination-wow-entrypoint`).
 */
describe('conversational entry: latte_request_coordination -> proposal gate -> approve -> first dispatch (task 7.14)', () => {
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
    // A real member row: `getCoordinatorGrant` only reports a meta-key value
    // back when it resolves to an actual member of this Work.
    b.repo.insertMember({ id: 'mem_proposer', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    members = [];
    fakeCoordinationHub(b, members);
    // Crítico 6: `resolveGate` ahora consulta `feature:coordination` PRIMERO —
    // el interruptor tiene que apagar también lo que ya está andando, no sólo
    // impedir encender. Este escenario aprueba por IPC, así que la bandera
    // tiene que estar arriba, igual que en una instalación donde la persona
    // la prendió.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tools = createCoordinationTools(engine);
  });
  afterEach(() => b.cleanup());

  it('goes from a worker\'s proposal to the first real dispatch in one approval, with zero real spawns', async () => {
    // 1. A worker proposes — no grant, no run, no prior configuration. This
    // is the sentence: "Coordina al equipo y preparen el contenido del mes."
    const proposerGrant = { workId, runId: null, memberId: 'mem_proposer', role: 'worker' as const };
    const proposed = await tools.latte_request_coordination(proposerGrant, {
      plan: [
        { roleId: 'strategist', spec: 'Draft the monthly content plan' },
        { roleId: 'copywriter', spec: 'Write the launch post', dependsOn: [0] },
      ],
      estimatedDispatches: 6,
      membersToHire: [{ roleId: 'copywriter', why: 'Nobody on the team can write copy yet' }],
      rationale: 'El pedido fue coordinar al equipo y preparar el contenido del mes.',
    });
    expect(proposed.ok).toBe(true);
    expect(b.hub.send).not.toHaveBeenCalled();

    // 2. Exactly ONE gate: the proposal itself.
    const runBefore = await b.service.getCoordinationRun(workId);
    expect(runBefore?.status).toBe('planning');
    const gates = await b.service.listCoordinationGates(runBefore!.id);
    expect(gates).toHaveLength(1);
    expect(gates[0].kind).toBe('proposal');

    // 3. ONE approval grants everything together: coordinator + budget +
    // authority + hires + tasks.
    await b.service.resolveCoordinationGate(gates[0].id, 'approve');
    expect(await b.service.getCoordinatorGrant(workId)).toBe('mem_proposer');
    expect(await b.service.getCoordinationBudget(workId)).toMatchObject({ state: 'set', budget: { maxDispatches: 6 } });
    expect(await b.service.getCoordinationAuthority(workId)).toBe('plan');
    expect(members.some((m) => m.roleId === 'copywriter')).toBe(true);
    const runAfter = await b.service.getCoordinationRun(workId);
    expect(runAfter?.status).toBe('running');
    const tasks = b.repo.listCoordinationTasks(runAfter!.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.inPlan)).toBe(true);
    expect(await b.service.listCoordinationGates(runAfter!.id)).toEqual([]);

    // 4. The first dispatch: the approved plan's ready task (no unmet
    // dependency) dispatches WITHOUT a new gate — `inPlan` + an approved
    // plan skip it by design (task 3.5) — and `hub.send` actually fires.
    const readyTask = tasks.find((t) => t.status === 'ready')!;
    expect(readyTask.roleId).toBe('strategist');
    const coordinatorGrant = { workId, runId: runAfter!.id, memberId: 'mem_proposer', role: 'coordinator' as const };
    const dispatch = await tools.latte_dispatch(coordinatorGrant, { taskId: readyTask.id });
    expect(dispatch.ok).toBe(true);
    expect(dispatch.data).toMatchObject({ status: 'dispatched' });
    expect(b.hub.send).toHaveBeenCalledTimes(1);

    // Zero real spawns: the fake runner/pty from `makeBackend()` was never touched.
    expect(await b.service.listCoordinationGates(runAfter!.id)).toEqual([]);
  });
});
