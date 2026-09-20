import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from '../backend/helpers';

/**
 * Task 6.16 — the definitive answer to "can coordination run in parallel
 * across Brands". Two Brands, one Work each, both with an active run driven
 * through the SAME `CoordinationEngine` instance (exactly how the real app
 * wires it: one engine, many Works) — fake hub, fake runner, ZERO real
 * spawns. Every assertion below proves isolation end to end: dispatch,
 * budget, mailbox, asks, team roster.
 *
 * NOT proven here, deliberately: per-brand engram project pinning
 * (`memoryProjectFor(brandId)`, tasks 6.21-6.32) — that machinery does not
 * exist in this slice (6c/6d only). `memberContext` below already carries a
 * distinct `brandId` per Work, ready for 6-C to build on, but nothing reads
 * it into an engram project yet. Deferred honestly, not faked.
 */
describe('coordination parallel brands: two Brands, two Works, two active runs, zero real spawns', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tools: ReturnType<typeof createCoordinationTools>;
  let members: FakeTeamMember[];

  let brandAId: string;
  let workA: string;
  let runA: string;
  let brandBId: string;
  let workB: string;
  let runB: string;

  function coordA(): CoordinationGrant {
    return { workId: workA, runId: runA, memberId: 'mem_coord_a', role: 'coordinator' };
  }
  function coordB(): CoordinationGrant {
    return { workId: workB, runId: runB, memberId: 'mem_coord_b', role: 'coordinator' };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brandA = await b.service.createBrand('Marca A');
    const wA = await b.service.createWork(brandA.id, 'Trabajo A');
    const brandB = await b.service.createBrand('Marca B');
    const wB = await b.service.createWork(brandB.id, 'Trabajo B');
    brandAId = brandA.id;
    workA = wA.id;
    brandBId = brandB.id;
    workB = wB.id;

    members = [];
    fakeCoordinationHub(b, members);

    await b.service.setCoordinationAuthority(workA, 'auto');
    await b.service.setCoordinationAuthority(workB, 'auto');
    // A's cap is intentionally tiny so it can be driven to suspend on its own
    // budget without ever touching B's.
    await b.service.setCoordinationBudget(workA, { maxDispatches: 1 });
    await b.service.setCoordinationBudget(workB, { maxDispatches: 5 });

    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({
        workId: id,
        brandId: id === workA ? brandAId : brandBId,
        directory: b.dir,
        title: 'x',
        extraEnv: {},
      }),
    });
    tools = createCoordinationTools(engine);

    const rA = await engine.startRun(workA, null);
    runA = rA.id;
    const rB = await engine.startRun(workB, null);
    runB = rB.id;
    // Ronda 4, juicio #3: sin propuesta aprobada el alta automatica queda
    // acotada. Lo que se prueba aca es el aislamiento entre Marcas.
    approveCoordinationRoles(b, runA, 'strategist', 'copywriter');
    approveCoordinationRoles(b, runB, 'strategist', 'copywriter');
  });
  afterEach(() => b.cleanup());

  it('both runs dispatch independently through the SAME engine instance, interleaved', async () => {
    const taskA = engine.taskCreate(runA, { roleId: 'strategist', spec: 'A1' });
    const taskB = engine.taskCreate(runB, { roleId: 'strategist', spec: 'B1' });

    const outcomeA = await engine.startDispatch({ grant: coordA(), taskId: taskA.id });
    const outcomeB = await engine.startDispatch({ grant: coordB(), taskId: taskB.id });

    expect(outcomeA.status).toBe('dispatched');
    expect(outcomeB.status).toBe('dispatched');
    expect(b.repo.getCoordinationDispatch(outcomeA.dispatchId).runId).toBe(runA);
    expect(b.repo.getCoordinationDispatch(outcomeB.dispatchId).runId).toBe(runB);
  });

  it('each budget is consumed only by its own dispatches — A hitting its cap suspends A and never touches B', async () => {
    const taskA = engine.taskCreate(runA, { roleId: 'strategist', spec: 'A1' });
    // A2 se crea ANTES de reportar A1: un run cuyas tareas quedaron todas
    // terminales ahora termina (`done`), y un run terminado ya no despacha
    // nada — lo que este test mide es el tope de A, no el cierre del run.
    const taskA2 = engine.taskCreate(runA, { roleId: 'strategist', spec: 'A2' });
    const outcomeA = await engine.startDispatch({ grant: coordA(), taskId: taskA.id });
    const memberA = b.repo.getCoordinationDispatch(outcomeA.dispatchId).memberId;
    // El único despacho permitido de A ya quedó consumido al reservarlo
    // (maxDispatches cuenta despachos, no reportes); esto libera al miembro
    // para que la segunda tarea del mismo rol llegue al chequeo de tope.
    await engine.report({ workId: workA, runId: runA, memberId: memberA, role: 'worker' }, taskA.id, 'succeeded', 'done');

    await expect(engine.startDispatch({ grant: coordA(), taskId: taskA2.id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(engine.getRun(runA)).toMatchObject({ status: 'suspended', suspendReason: 'max_dispatches' });

    // B is completely unaffected: still running, its own budget untouched.
    expect(engine.getRun(runB).status).toBe('running');
    expect(engine.budgetBlockForEnvelope(runB).dispatchesUsed).toBe(0);
    const taskB = engine.taskCreate(runB, { roleId: 'strategist', spec: 'B1' });
    const outcomeB = await engine.startDispatch({ grant: coordB(), taskId: taskB.id });
    expect(outcomeB.status).toBe('dispatched');
  });

  it('check()/ask() for a brand-A member never see brand-B rows', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({ id: 'mem_worker_a', workId: workA, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: now, updatedAt: now });
    b.repo.insertMember({ id: 'mem_worker_b', workId: workB, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: now, updatedAt: now });

    b.repo.insertCoordinationMessage({ id: 'cms_a', runId: runA, toMemberId: 'mem_worker_a', fromMemberId: null, kind: 'note', body: 'For A only', deliveredAt: null, createdAt: now });
    b.repo.insertCoordinationMessage({ id: 'cms_b', runId: runB, toMemberId: 'mem_worker_b', fromMemberId: null, kind: 'note', body: 'For B only', deliveredAt: null, createdAt: now });

    expect(engine.check('mem_worker_a').map((m) => m.body)).toEqual(['For A only']);
    expect(engine.check('mem_worker_b').map((m) => m.body)).toEqual(['For B only']);

    const askA = engine.ask({ workId: workA, runId: runA, memberId: 'mem_worker_a', role: 'worker' }, '¿A?');
    const askB = engine.ask({ workId: workB, runId: runB, memberId: 'mem_worker_b', role: 'worker' }, '¿B?');
    expect(b.repo.listOpenCoordinationAsks(runA).map((a) => a.id)).toEqual([askA.id]);
    expect(b.repo.listOpenCoordinationAsks(runB).map((a) => a.id)).toEqual([askB.id]);
  });

  it('latte_team_list for a brand-A grant never returns a brand-B member, and vice versa', async () => {
    const taskA = engine.taskCreate(runA, { roleId: 'strategist', spec: 'A1' });
    const taskB = engine.taskCreate(runB, { roleId: 'copywriter', spec: 'B1' });
    await engine.startDispatch({ grant: coordA(), taskId: taskA.id }); // opens a fake member on A via addMember
    await engine.startDispatch({ grant: coordB(), taskId: taskB.id }); // opens a fake member on B via addMember

    const listA = await tools.latte_team_list(coordA(), {});
    const listB = await tools.latte_team_list(coordB(), {});

    expect(listA.ok).toBe(true);
    expect(listB.ok).toBe(true);
    const idsA = (listA.data as Array<{ id: string; workId: string }>).map((m) => m.id);
    const idsB = (listB.data as Array<{ id: string; workId: string }>).map((m) => m.id);
    // EL LARGO PRIMERO. `.every()` sobre una lista vacía es `true` y
    // `.some()` es `false`: con las dos listas vacías las tres aserciones de
    // abajo pasaban juntas, y el test que prueba que la marca A no ve a la B
    // pasaba sin haber visto NADA. Cada despacho de arriba abrió un miembro,
    // así que cada lista tiene que traer al menos uno.
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    expect((listA.data as Array<{ workId: string }>).every((m) => m.workId === workA)).toBe(true);
    expect((listB.data as Array<{ workId: string }>).every((m) => m.workId === workB)).toBe(true);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });
});
