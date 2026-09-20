import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { MAX_ATTEMPTS_PER_TASK } from '../../electron/coordination/limits';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Crítico 5: un `closed` de un adaptador llegaba a `hub.stop` y a
 * `injection.release`, y ahí terminaba. El despacho que ese miembro tenía en
 * vuelo se quedaba `dispatched` con su reserva abierta por el resto de la
 * sesión: sin reintento, con el cupo de presupuesto quemado y el run sin poder
 * terminar nunca. `settleUncertain` documentaba un modo
 * `incrementAttempts:true` "para la muerte de un proceso" y no tenía un solo
 * llamador.
 *
 * Se entra por donde entra la muerte de verdad: `backend.emitChat`, el
 * chokepoint por el que pasa TODO evento de chat antes de llegar a la interfaz.
 * Nada de llamar al motor directamente.
 */
describe('la muerte de un proceso liquida su despacho en caliente (crítico 5)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let brandId: string;

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
    await b.service.setCoordinationAuthority(workId, 'auto');
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
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('cierra la reserva, devuelve la tarea a la cola y le cobra el intento', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    // Una segunda tarea abierta, para que lo que se mida acá sea la
    // liquidación y no el cierre del run.
    engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);

    // El proceso del agente se muere.
    b.emitChat({ chatId: 'mem_a1', type: 'closed', reason: 'Codex app-server exited (code 1)' });

    expect(b.repo.getCoordinationDispatch(outcome.dispatchId).status).toBe('cancelled');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 1, assignedMemberId: null });
    // El asiento se escribe igual: el miembro FUE despachado y la persona lo pagó.
    expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
  });

  it('al tope de intentos la tarea queda failed y el run, si era la última, termina', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TASK; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await engine.startDispatch({ grant: coordinator(), taskId: task.id });
      b.emitChat({ chatId: 'mem_a1', type: 'closed', reason: 'muerto otra vez' });
    }

    expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS_PER_TASK });
    // Nada quedó en vuelo y no queda tarea viva: el run puede cerrarse.
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(engine.getRun(runId).status).toBe('done');
  });

  it('un miembro sin despacho en vuelo no escribe nada: pausar a alguien ocioso no cobra un intento', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    b.emitChat({ chatId: 'mem_a1', type: 'closed', reason: 'stopped' });

    expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(0);
    expect(engine.getRun(runId).status).toBe('running');
  });
});
