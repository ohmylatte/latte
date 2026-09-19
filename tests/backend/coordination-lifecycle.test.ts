import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../electron/bootstrap';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ciclo de vida y contabilidad del despacho: lo que pasa cuando algo se corta
 * en el medio — la app se cae con despachos en vuelo, `hub.send` rechaza
 * después del commit, la transacción tira desde adentro, se cancela un run con
 * reservas abiertas — y lo que pasa con el tope app-wide, que era un contador
 * de por vida imposible de bajar. Cada test de acá abajo reproduce un agujero
 * confirmado por dos jueces independientes.
 */
describe('CoordinationEngine — ciclo de vida del despacho', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    // Ronda 4, juicio #3: el alta automatica quedo acotada a lo que la
    // persona aprobo. Este run nace de `startRun`, sin propuesta, asi que
    // declara aca los roles que su persona hubiera aprobado -- lo que se
    // esta probando es otra cosa.
    approveCoordinationRoles(b, runId, 'role_a', 'role_b', 'role_c');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- 1: nadie reconciliaba los despachos en vuelo --------------------------

  describe('barrido de despachos inciertos', () => {
    it('al arrancar, un despacho que quedó en vuelo por una caída se liquida y libera su cupo', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);

      // La caída: el proceso se va sin pasar por `shutdown()`.
      b.repo.close();

      const revived = await createBackend({
        dataDir: b.dir, version: '0.0.0-test', emit: () => {}, chooseExportPath: async () => null, seedDemo: false,
      });
      try {
        expect(revived.repo.getCoordinationDispatch(outcome.dispatchId).status).toBe('cancelled');
        expect(revived.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
        expect(revived.repo.getCoordinationTask(task.id).status).toBe('ready');
      } finally {
        revived.service.shutdown();
      }
    });

    it('al cerrar, `shutdown()` liquida lo que quedó en vuelo en vez de dejarlo colgado', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      b.service.shutdown();

      // El repo ya está cerrado: se reabre para leer lo que quedó escrito.
      const revived = await createBackend({
        dataDir: b.dir, version: '0.0.0-test', emit: () => {}, chooseExportPath: async () => null, seedDemo: false,
      });
      try {
        expect(revived.repo.getCoordinationDispatch(outcome.dispatchId).status).toBe('cancelled');
        expect(revived.repo.countOpenCoordinationCostReservations()).toBe(0);
      } finally {
        revived.service.shutdown();
      }
    });
  });

  // --- 2: `hub.send` corre después del commit, sin red ------------------------

  describe('`hub.send` que rechaza', () => {
    it('un envío que falla no deja la reserva abierta ni la tarea despachada para siempre', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      vi.spyOn(b.hub, 'send').mockRejectedValue(new Error('NotFoundError: Chat'));
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toThrow();

      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
      const dispatches = b.repo.listCoordinationDispatches(runId);
      expect(dispatches).toHaveLength(1);
      expect(dispatches.every((d) => d.status !== 'dispatched')).toBe(true);
      // Nada se ejecutó: el cupo no se cobra.
      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(0);
      // Y la reserva queda `settled`, NO `uncertain`. La diferencia no es
      // cosmética: `uncertain` es la palabra que usa `settleUncertain` para
      // "el proceso se murió y no sabemos si llegó a correr", y ahí sí se
      // asienta el gasto. Acá `hub.send` TIRÓ: no salió nada, se sabe con
      // certeza, y el registro tiene que decir eso. Medido: cerrar esta
      // reserva como `uncertain` pasaba la suite entera en verde.
      const reservationId = dispatches[0].reservationId;
      expect(reservationId).toBeTruthy();
      expect(b.repo.getCoordinationCostReservation(reservationId!)?.state).toBe('settled');
    });
  });

  // --- 3: un throw adentro de la transacción deja el reclamo colgado ----------

  describe('la transacción de despacho que tira', () => {
    it('un `budget_json` corrupto no deja la tarea reclamada para siempre', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      b.repo.updateActiveCoordinationRunBudget(workId, 'null', new Date().toISOString());
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toThrow();

      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
      expect(b.hub.send).not.toHaveBeenCalled();
    });
  });

  // --- 4: el tope app-wide era un contador de por vida -----------------------

  describe('tope global de despachos', () => {
    it('no cuenta el gasto de runs ya terminados: no es un contador de por vida', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationGlobalBudget({ maxDispatches: 1 });
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      await engine.report({ workId, runId, memberId, role: 'worker' }, task.id, 'succeeded', 'listo');
      // El reporte de la última tarea ya cerró el run solo (`done`). Cancelar
      // encima ahora tira `RUN_NOT_ACTIVE` (D3): un run terminado no acepta una
      // mutación más. Lo que este test mide es el tope global, y para eso lo
      // que importa es que el run haya dejado de estar activo — que ya pasó.
      expect(engine.getRun(runId).status).toBe('done');

      // Otro Trabajo, otro run: el tope global vuelve a estar disponible.
      const otherWork = await b.service.createWork(brandId, 'Otro');
      await b.service.setCoordinationBudget(otherWork.id, { maxDispatches: 10 });
      await b.service.setCoordinationAuthority(otherWork.id, 'auto');
      const otherRun = await engine.startRun(otherWork.id, null);
      // Ronda 4, juicio #3: este run tampoco nace de una propuesta.
      approveCoordinationRoles(b, otherRun.id, 'role_a', 'role_b', 'role_c', 'role_z');
      const theirs = engine.taskCreate(otherRun.id, { roleId: 'role_b', spec: 'b' });

      await expect(engine.startDispatch({
        grant: { workId: otherWork.id, runId: otherRun.id, memberId: 'mem_other', role: 'coordinator' },
        taskId: theirs.id,
      })).resolves.toMatchObject({ status: 'dispatched' });
    });

    it('se puede borrar desde la interfaz: `null` saca el tope', async () => {
      await b.service.setCoordinationGlobalBudget({ maxDispatches: 1 });
      expect(await b.service.getCoordinationGlobalBudget()).toMatchObject({ state: 'set', budget: { maxDispatches: 1 } });

      expect(await b.service.setCoordinationGlobalBudget(null)).toBeNull();

      expect(await b.service.getCoordinationGlobalBudget()).toEqual({ state: 'unset' });
    });
  });

  // --- 5: cancelar dejaba reservas abiertas para siempre ---------------------

  describe('cancelar y pausar', () => {
    it('cancelar liquida las reservas abiertas del run en vez de erosionar el tope global para siempre', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      expect(b.repo.countOpenCoordinationCostReservations()).toBe(1);

      engine.cancelRun(runId);

      expect(b.repo.countOpenCoordinationCostReservations()).toBe(0);
      expect(b.repo.getCoordinationTask(task.id).status).not.toBe('dispatched');
    });

    it('pausar NO liquida nada: el despacho en vuelo sigue vivo y su reporte sigue entrando', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;

      engine.pauseRun(runId);

      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
      await expect(engine.report({ workId, runId, memberId, role: 'worker' }, task.id, 'succeeded', 'listo'))
        .resolves.toMatchObject({ status: 'done' });
    });
  });

  // --- 6: contratar y spawnear ANTES del gate --------------------------------

  describe('el gate va antes de contratar', () => {
    it('bajo autoridad `manual` un despacho pendiente no contrata ni spawnea a nadie', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      const gate = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      expect(gate.status).toBe('pending_approval');
      expect(members).toHaveLength(0);
      expect(b.hub.addMember).not.toHaveBeenCalled();
    });

    it('rechazar el gate tampoco deja un miembro contratado atrás', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const gate = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      await engine.resolveGate(gate.dispatchId, 'reject');

      expect(members).toHaveLength(0);
      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    });

    it('recién al aprobar se contrata, y el despacho queda anotado contra ese miembro', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const gate = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      await engine.resolveGate(gate.dispatchId, 'approve');

      expect(members).toHaveLength(1);
      const dispatch = b.repo.getCoordinationDispatch(gate.dispatchId);
      expect(dispatch.status).toBe('dispatched');
      expect(dispatch.memberId).toBe(members[0].id);
    });
  });

  // --- 7: liquidación y asiento, dos escrituras sueltas ----------------------

  describe('liquidar y asentar son una sola escritura', () => {
    it('si el asiento falla, la reserva NO queda cerrada sin gasto', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      vi.spyOn(b.repo, 'insertCoordinationCostLedger').mockImplementation(() => { throw new Error('disco lleno'); });

      await expect(engine.report({ workId, runId, memberId, role: 'worker' }, task.id, 'succeeded', 'listo')).rejects.toThrow();

      // La reserva sigue abierta: el despacho sigue contando, que es
      // exactamente lo que el tope necesita para no sub-contar.
      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    });

    it('lo mismo en `settleUncertain`', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      vi.spyOn(b.repo, 'insertCoordinationCostLedger').mockImplementation(() => { throw new Error('disco lleno'); });

      expect(() => engine.settleUncertain(outcome.dispatchId, { incrementAttempts: false })).toThrow();

      expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    });
  });

  // --- 8: el motor leía presupuestos sin validar -----------------------------

  describe('el presupuesto se lee con el mismo validador que lo escribe', () => {
    it('`{"maxDispatches": null}` sin confirmación humana NIEGA, no habilita ilimitado', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      b.repo.updateActiveCoordinationRunBudget(workId, JSON.stringify({ maxDispatches: null }), new Date().toISOString());
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toThrow();

      expect(b.hub.send).not.toHaveBeenCalled();
      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    });

    it('un tope global corrupto NIEGA, no desaparece', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      b.repo.setMeta('coordination_budget_global', '{"maxDispatches": null}');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toThrow();

      expect(b.hub.send).not.toHaveBeenCalled();
      expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    });
  });

  // --- 9: un gate aprobado que el tope niega no es un rechazo ----------------

  describe('la bitácora no miente sobre quién dijo que no', () => {
    it('aprobar un despacho que el tope niega NO queda anotado como rechazo humano', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 1 });
      b.repo.updateActiveCoordinationRunBudget(workId, JSON.stringify({ maxDispatches: 1 }), new Date().toISOString());
      const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const second = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
      const firstGate = await engine.startDispatch({ grant: coordinator(), taskId: first.id });
      await engine.resolveGate(firstGate.dispatchId, 'approve');
      const secondGate = await engine.startDispatch({ grant: coordinator(), taskId: second.id });

      await expect(engine.resolveGate(secondGate.dispatchId, 'approve')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

      const denied = b.repo.getCoordinationDispatch(secondGate.dispatchId);
      expect(denied.status).not.toBe('rejected');
      expect(denied.outcome).toBe('denied');
      expect(denied.summary).toBe('max_dispatches');
    });
  });
});
