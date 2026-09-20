import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Endurecimiento del choke point de despacho: plata y seguridad. Cada test de
 * acá abajo reproduce un agujero real que la suite anterior no cubría — el
 * tope que no topaba, dos despachos simultáneos sobre la misma tarea, una
 * propuesta aprobada dos veces, el tope global que no leía nadie,
 * contrataciones a medias sin rollback, y `latte_report` filtrando entre Marcas.
 */
describe('CoordinationEngine — endurecimiento (plata y seguridad)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }
  function worker(memberId: string): CoordinationGrant {
    return { workId, runId, memberId, role: 'worker' };
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
    approveCoordinationRoles(b, runId, 'role_a', 'role_b', 'role_c', 'role_ok');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- 1: el tope cuenta reservas abiertas, no sólo gasto liquidado ----------

  describe('maxDispatches acota DESPACHOS, no reportes del agente', () => {
    it('un coordinador que nunca reporta agota igual el tope', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 2 });
      // Roles distintos: sin MEMBER_BUSY de por medio, el tope es lo ÚNICO que
      // puede frenar al coordinador.
      const tasks = ['a', 'b', 'c'].map((r) => engine.taskCreate(runId, { roleId: `role_${r}`, spec: r }));

      await engine.startDispatch({ grant: coordinator(), taskId: tasks[0].id });
      await engine.startDispatch({ grant: coordinator(), taskId: tasks[1].id });
      await expect(engine.startDispatch({ grant: coordinator(), taskId: tasks[2].id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

      expect(b.hub.send).toHaveBeenCalledTimes(2);
      expect(engine.getRun(runId)).toMatchObject({ status: 'suspended', suspendReason: 'max_dispatches' });
    });

    it('reportar no vuelve a cobrar: la reserva abierta y el gasto liquidado son el mismo despacho', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 2 });
      const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: first.id });
      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);

      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      await engine.report(worker(memberId), first.id, 'succeeded', 'listo');

      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
    });

    it('un despacho perdido por caída sigue contando: el reintento no estrena cupo', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 1 });
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      engine.settleUncertain(outcome.dispatchId, { incrementAttempts: false });

      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    });
  });

  // --- 2: TOCTOU — chequeo y reserva a ambos lados de un await ---------------

  describe('dos despachos simultáneos', () => {
    it('dos latte_dispatch sobre la MISMA tarea lista: uno gana, el otro aborta', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

      const results = await Promise.allSettled([
        engine.startDispatch({ grant: coordinator(), taskId: task.id }),
        engine.startDispatch({ grant: coordinator(), taskId: task.id }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(1);
      expect(b.hub.send).toHaveBeenCalledTimes(1);
      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
    });

    it('dos clics en Aprobar sobre el mismo gate despachan una sola vez', async () => {
      await b.service.setCoordinationAuthority(workId, 'manual');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const gate = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

      const results = await Promise.allSettled([
        engine.resolveGate(gate.dispatchId, 'approve'),
        engine.resolveGate(gate.dispatchId, 'approve'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(1);
      expect(b.hub.send).toHaveBeenCalledTimes(1);
      expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
    });

    it('maxConcurrent tampoco se puede esquivar en paralelo', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 10, maxConcurrent: 1 });
      const one = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const two = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });

      const results = await Promise.allSettled([
        engine.startDispatch({ grant: coordinator(), taskId: one.id }),
        engine.startDispatch({ grant: coordinator(), taskId: two.id }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(b.hub.send).toHaveBeenCalledTimes(1);
    });
  });

  // --- 3/6: la aprobación de una propuesta -----------------------------------

  describe('aprobar una propuesta', () => {
    async function openProposal(proposal: Partial<CoordinationProposal> = {}): Promise<string> {
      b.repo.updateCoordinationRunStatus(runId, 'cancelled', new Date().toISOString(), null);
      const full: CoordinationProposal = {
        plan: [{ roleId: 'role_a', spec: 'a' }],
        estimatedDispatches: 5,
        membersToHire: [{ roleId: 'role_a', why: 'hace falta' }],
        rationale: 'porque sí',
        ...proposal,
      };
      const run = await engine.requestCoordination({ workId, runId: null, memberId: 'mem_proposer', role: 'worker' }, full);
      return run.id;
    }

    it('aprobar dos veces no contrata de nuevo ni recrea las tareas', async () => {
      const proposalRunId = await openProposal();
      await engine.resolveGate(`proposal:${proposalRunId}`, 'approve');
      const membersAfterFirst = members.length;
      const tasksAfterFirst = b.repo.listCoordinationTasks(proposalRunId).length;

      await expect(engine.resolveGate(`proposal:${proposalRunId}`, 'approve')).rejects.toMatchObject({ code: 'COORDINATION_NOT_APPROVED' });

      expect(members).toHaveLength(membersAfterFirst);
      expect(b.repo.listCoordinationTasks(proposalRunId)).toHaveLength(tasksAfterFirst);
    });

    it('aprobar dos veces no pisa un presupuesto que la persona ya subió', async () => {
      const proposalRunId = await openProposal();
      await engine.resolveGate(`proposal:${proposalRunId}`, 'approve');
      b.repo.updateActiveCoordinationRunBudget(workId, JSON.stringify({ maxDispatches: 50 }), new Date().toISOString());

      await expect(engine.resolveGate(`proposal:${proposalRunId}`, 'approve')).rejects.toBeTruthy();

      expect(JSON.parse(engine.getRun(proposalRunId).budgetJson).maxDispatches).toBe(50);
    });

    it('una contratación que falla a mitad deshace las que ya habían entrado', async () => {
      // Q4: el plan nombra a los dos roles que se contratan. Antes decía
      // `role_a` —un rol que esta propuesta ya no contrata— y eso hoy es una
      // aprobación incumplible que se rechaza ANTES de contratar a nadie, así
      // que no habría ninguna contratación a medias que deshacer y el test
      // pasaría sin haber probado la compensación.
      const proposalRunId = await openProposal({
        plan: [{ roleId: 'role_ok', spec: 'a' }, { roleId: 'role_inventado', spec: 'b' }],
        membersToHire: [{ roleId: 'role_ok', why: 'existe' }, { roleId: 'role_inventado', why: 'no existe' }],
      });
      const removed: string[] = [];
      vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
        removed.push(memberId);
        const idx = members.findIndex((m) => m.id === memberId);
        if (idx >= 0) members.splice(idx, 1);
      });
      vi.spyOn(b.hub, 'addMember').mockImplementation(async (input) => {
        if (input.roleId === 'role_inventado') throw new Error('NotFoundError: Role');
        const member: FakeTeamMember = { id: `mem_fake_${members.length + 1}`, workId: input.workId, roleId: input.roleId, status: 'idle' };
        members.push(member);
        return { id: member.id, provider: 'codex', model: null, label: 'x', title: 'x', messages: [], usage: null } as never;
      });

      await expect(engine.resolveGate(`proposal:${proposalRunId}`, 'approve')).rejects.toBeTruthy();

      expect(removed).toHaveLength(1);
      expect(members).toHaveLength(0);
      expect(engine.getRun(proposalRunId).status).toBe('planning');
    });
  });

  // --- 4: el tope global lo hace cumplir alguien -----------------------------

  describe('tope global de despachos', () => {
    it('frena el despacho aunque el presupuesto del Trabajo sobre', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
      await b.service.setCoordinationGlobalBudget({ maxDispatches: 1 });
      const one = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const two = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });

      await engine.startDispatch({ grant: coordinator(), taskId: one.id });
      await expect(engine.startDispatch({ grant: coordinator(), taskId: two.id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

      expect(b.hub.send).toHaveBeenCalledTimes(1);
      expect(engine.getRun(runId)).toMatchObject({ status: 'suspended', suspendReason: 'global_max_dispatches' });
      const denied = b.repo.listCoordinationCostLedger(runId).filter((r) => r.kind === 'denied');
      expect(denied.some((r) => JSON.parse(r.detailJson).reason === 'global_max_dispatches')).toBe(true);
    });

    it('cuenta el gasto de TODOS los Trabajos, y suspende sólo al que chocó', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const otherWork = await b.service.createWork(brandId, 'Otro');
      await b.service.setCoordinationBudget(otherWork.id, { maxDispatches: 10 });
      await b.service.setCoordinationAuthority(otherWork.id, 'auto');
      const otherRun = await engine.startRun(otherWork.id, null);
      // Ronda 4, juicio #3: este run tampoco nace de una propuesta.
      approveCoordinationRoles(b, otherRun.id, 'role_a', 'role_b', 'role_c', 'role_ok', 'role_z');
      await b.service.setCoordinationGlobalBudget({ maxDispatches: 1 });

      const mine = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      await engine.startDispatch({ grant: coordinator(), taskId: mine.id });

      const theirs = engine.taskCreate(otherRun.id, { roleId: 'role_b', spec: 'b' });
      await expect(engine.startDispatch({
        grant: { workId: otherWork.id, runId: otherRun.id, memberId: 'mem_other_coordinator', role: 'coordinator' },
        taskId: theirs.id,
      })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

      expect(engine.getRun(otherRun.id).status).toBe('suspended');
      expect(engine.getRun(runId).status).toBe('running');
    });

    it('sin tope global configurado no hay tope inventado', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).resolves.toMatchObject({ status: 'dispatched' });
    });
  });

  // --- 8: report no cruza Marcas y autoriza antes de contestar ----------------

  describe('latte_report', () => {
    it('una tarea de OTRO run no se lee ni se reporta con este grant', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const otherWork = await b.service.createWork(brandId, 'Otro');
      await b.service.setCoordinationBudget(otherWork.id, { maxDispatches: 10 });
      await b.service.setCoordinationAuthority(otherWork.id, 'auto');
      const otherRun = await engine.startRun(otherWork.id, null);
      // Ronda 4, juicio #3: este run tampoco nace de una propuesta.
      approveCoordinationRoles(b, otherRun.id, 'role_a', 'role_b', 'role_c', 'role_ok', 'role_z');
      const theirTask = engine.taskCreate(otherRun.id, { roleId: 'role_b', spec: 'secreto ajeno' });
      const theirOutcome = await engine.startDispatch({
        grant: { workId: otherWork.id, runId: otherRun.id, memberId: 'mem_other_coordinator', role: 'coordinator' },
        taskId: theirTask.id,
      });
      const theirMember = b.repo.getCoordinationDispatch(theirOutcome.dispatchId).memberId;
      await engine.report({ workId: otherWork.id, runId: otherRun.id, memberId: theirMember, role: 'worker' }, theirTask.id, 'succeeded', 'lo hice');

      // Un miembro de ESTE run, con un id de tarea del otro: ni el resumen ni
      // los archivos del otro Trabajo pueden volver por esta puerta.
      await expect(engine.report(worker('mem_intruso'), theirTask.id, 'succeeded', 'mío ahora')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('una tarea ya done no se devuelve a quien no la hizo', async () => {
      await b.service.setCoordinationAuthority(workId, 'auto');
      const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      await engine.report(worker(memberId), task.id, 'succeeded', 'listo');

      await expect(engine.report(worker('mem_intruso'), task.id, 'succeeded', 'mío')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Y el reporte repetido del miembro real sigue siendo idempotente.
      await expect(engine.report(worker(memberId), task.id, 'succeeded', 'de nuevo')).resolves.toMatchObject({ status: 'done', resultSummary: 'listo' });
    });
  });
});
