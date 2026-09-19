import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationLogEntry } from '../../electron/coordination/engine';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * La carrera del camino de despacho, reproducida de verdad: el motor lee un
 * estado, espera a que un proceso de agente se levante —segundos— y actúa. Cada
 * test de acá abajo PARA esa espera en el medio, cambia el mundo mientras el
 * despacho está en vuelo, y exige que el motor no actúe sobre lo que leyó antes.
 *
 * Sin la espera controlable (`hold`, en `helpers.ts`) estos tests corren las dos
 * mitades pegadas y pasan sin probar nada, que es exactamente cómo la suite
 * convivió con el agujero.
 */
describe('CoordinationEngine — el mundo cambia durante el spawn', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let brandId: string;
  /** La espera del spawn; cada test la reemplaza por una promesa que resuelve cuando quiere. */
  let hold: (() => Promise<void>) | null;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  function dispatchEntries(entries: CoordinationLogEntry[]) {
    // Por presencia de `taskId`, no enumerando las entradas de cierre: la
    // bitácora ya deriva dos (`run_done`, `run_cancelled`) y este filtro las
    // dejaba pasar de a una cada vez que aparecía otra.
    return entries.filter((e) => 'taskId' in e);
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    members = [];
    hold = null;
    fakeCoordinationHub(b, members, { hold: () => hold?.() });
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- S1: la confirmación relee el run --------------------------------------

  describe('cancelar durante el spawn (crítico 3)', () => {
    it('no manda nada, no deja reserva abierta y devuelve la tarea a la cola', async () => {
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      const spawn = deferred();
      hold = () => spawn.promise;
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      const dispatching = engine.startDispatch({ grant: coordinator(), taskId: task.id });
      await settle();
      // El despacho está parado esperando al proceso, con la tarea ya reclamada.
      expect(b.repo.getCoordinationTask(task.id).status).toBe('dispatched');

      // EL MUNDO CAMBIA: la persona aprieta Cancelar.
      engine.cancelRun(runId);
      expect(engine.getRun(runId).status).toBe('cancelled');

      spawn.resolve();
      await expect(dispatching).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });

      // El JSON del brief era `{"hubSendCalls":1,"openReservations":1}`.
      expect(b.hub.send).toHaveBeenCalledTimes(0);
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
      expect(b.repo.getCoordinationTask(task.id).assignedMemberId).toBeNull();
      // Y la persona puede LEER por qué la tarea volvió sola a la cola.
      const aborted = dispatchEntries(engine.listLog(runId));
      expect(aborted).toHaveLength(1);
      expect(b.repo.getCoordinationDispatch(aborted[0].id)).toMatchObject({ status: 'cancelled', outcome: 'run_not_active' });
    });

    it('pausar durante el spawn frena el despacho igual, contra su propia documentación', async () => {
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      const spawn = deferred();
      hold = () => spawn.promise;
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      const dispatching = engine.startDispatch({ grant: coordinator(), taskId: task.id });
      await settle();
      engine.pauseRun(runId);
      spawn.resolve();

      await expect(dispatching).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
      expect(b.hub.send).toHaveBeenCalledTimes(0);
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
      // Una pausa se reanuda: la tarea tiene que estar lista para salir de nuevo.
      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(0);
    });

    it('el camino por gate tampoco despacha: aprobar y cancelar a la vez no manda nada', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const gate = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(gate.status).toBe('pending_approval');

      const spawn = deferred();
      hold = () => spawn.promise;
      const approving = engine.resolveGate(gate.dispatchId, 'approve');
      await settle();
      engine.cancelRun(runId);
      spawn.resolve();

      await expect(approving).rejects.toMatchObject({ code: 'RUN_NOT_ACTIVE' });
      expect(b.hub.send).toHaveBeenCalledTimes(0);
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
      expect(b.repo.getCoordinationDispatch(gate.dispatchId)).toMatchObject({ status: 'cancelled', outcome: 'run_not_active' });
    });
  });

  // --- S2: la reserva del miembro --------------------------------------------

  describe('dos despachos concurrentes del mismo rol (variante del crítico 10)', () => {
    it('no eligen al mismo miembro ocioso', async () => {
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
      const spawn = deferred();
      hold = () => spawn.promise;
      const one = engine.taskCreate(runId, { roleId: 'role_a', spec: 'uno' });
      const two = engine.taskCreate(runId, { roleId: 'role_a', spec: 'dos' });

      const both = Promise.all([
        engine.startDispatch({ grant: coordinator(), taskId: one.id }),
        engine.startDispatch({ grant: coordinator(), taskId: two.id }),
      ]);
      await settle();
      spawn.resolve();
      const outcomes = await both;

      const assigned = outcomes.map((o) => b.repo.getCoordinationDispatch(o.dispatchId).memberId);
      expect(assigned).toHaveLength(2);
      // Antes los dos elegían a `mem_a1` y el segundo `hub.send` pisaba al primero.
      expect(new Set(assigned).size).toBe(2);
      expect([...assigned].sort()).toEqual(['mem_a1', 'mem_a2']);
      expect(b.hub.send).toHaveBeenCalledTimes(2);
    });

    it('la reserva se suelta cuando el despacho termina: el miembro se puede reutilizar después', async () => {
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'uno' });
      // La segunda tarea existe desde antes: si el run se quedara sin nada
      // pendiente, `finishRunIfComplete` lo cerraría y el segundo despacho
      // fallaría por otro motivo, tapando lo que este test mide.
      const next = engine.taskCreate(runId, { roleId: 'role_a', spec: 'dos' });
      const first = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      await engine.report({ workId, runId, memberId: 'mem_a1', role: 'worker' }, task.id, 'succeeded', 'listo');

      const second = await engine.startDispatch({ grant: coordinator(), taskId: next.id });

      expect(b.repo.getCoordinationDispatch(first.dispatchId).memberId).toBe('mem_a1');
      expect(b.repo.getCoordinationDispatch(second.dispatchId).memberId).toBe('mem_a1');
    });

    it('un spawn que falla tampoco deja al miembro reservado para siempre', async () => {
      members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
      const boom = deferred();
      hold = () => boom.promise;
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'uno' });
      const failing = engine.startDispatch({ grant: coordinator(), taskId: task.id });
      await settle();
      boom.reject(new Error('el proceso no arrancó'));
      await expect(failing).rejects.toThrow('el proceso no arrancó');

      hold = null;
      const retried = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(b.repo.getCoordinationDispatch(retried.dispatchId).memberId).toBe('mem_a1');
    });
  });
});
