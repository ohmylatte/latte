import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Crítico 6: el interruptor no apagaba lo que ya estaba andando.
 *
 * `feature:coordination` gateaba sólo la CREACIÓN de un run (`startRun`,
 * `requestCoordination`) y el despacho. Las RESOLUCIONES de gate no lo
 * consultaban: con la bandera bajada a mitad de vuelo, aprobar una propuesta
 * pendiente igual contrataba gente, levantaba procesos y escribía el permiso,
 * el presupuesto y la autoridad. Sólo el despacho siguiente se frenaba —
 * después de que todo el daño ya estaba hecho.
 *
 * Un interruptor que sólo impide encender no es un interruptor.
 */
describe('el interruptor apagado también frena las aprobaciones (crítico 6)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let addMember: ReturnType<typeof vi.spyOn>;
  let openMember: ReturnType<typeof vi.spyOn>;
  let workId: string;
  let runId: string;

  const proposal = () => ({
    plan: [{ roleId: 'copywriter', spec: 'Escribir los posteos del mes' }],
    membersToHire: [{ roleId: 'copywriter', why: 'nadie escribe copy todavía' }],
    estimatedDispatches: 4,
    rationale: 'El pedido fue coordinar al equipo.',
  });

  /** Las cuatro llaves que una aprobación escribe. Ninguna puede existir con la bandera baja. */
  function metaKeysWritten(): string[] {
    return [
      'coordination_coordinator:' + workId,
      'coordination_budget:' + workId,
      'coordination_authority:' + workId,
      'coordination_approved_roles:' + runId,
      // Vacío es "no concedido": cerrar un run BORRA el permiso de coordinador
      // escribiendo `''` (D3), y eso no es una concesión — es su contrario.
    ].filter((key) => (b.repo.getMeta(key) ?? '') !== '');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    const fake = fakeCoordinationHub(b, members);
    void fake;
    addMember = vi.spyOn(b.hub, 'addMember');
    openMember = vi.spyOn(b.hub, 'openMember');
    // La bandera ARRANCA prendida: la propuesta nace legítima, con el
    // interruptor arriba. Lo que se prueba es qué pasa cuando baja DESPUÉS.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.requestCoordination({ workId, runId: null, memberId: 'mem_proposer', role: 'worker' }, proposal());
    runId = run.id;
    addMember.mockClear();
    openMember.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  /** La bandera baja: se borra la meta (el default del repo es apagado). */
  function turnFlagOff(): void {
    b.repo.deleteMeta(FEATURE_KEYS.coordination);
  }

  it('con la bandera baja, aprobar la propuesta por IPC no concede NADA y el gate queda pendiente', async () => {
    const membersBefore = b.repo.listMembers(workId).length;
    turnFlagOff();

    // La UI manda el id sintético con `:` — el mismo que `listGates` publica.
    await expect(b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve'))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    expect(b.repo.listMembers(workId)).toHaveLength(membersBefore);
    expect(addMember).not.toHaveBeenCalled();
    expect(openMember).not.toHaveBeenCalled();
    expect(metaKeysWritten()).toEqual([]);
    // El gate NO se consume: al volver a prender el interruptor, la persona
    // todavía tiene la decisión sobre la mesa.
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('planning');
    expect(run.planApprovedAt).toBeNull();
    const gates = await b.service.listCoordinationGates(runId);
    expect(gates.map((g) => g.id)).toContain(`proposal:${runId}`);
  });

  it('volver a prender el interruptor devuelve la aprobación exactamente como era', async () => {
    turnFlagOff();
    await expect(b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve')).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(metaKeysWritten()).toHaveLength(4);
  });

  it('con la bandera baja tampoco se resuelve un gate de despacho pendiente', async () => {
    // Autoridad `manual` elegida a propósito: cada despacho pasa por un gate,
    // así que hay una fila `pending_approval` real contra la cual probar.
    await b.service.setCoordinationAuthority(workId, 'manual');
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    const task = b.repo.listCoordinationTasks(runId)[0];
    expect(task).toBeDefined();
    const pending = await engineWithRealFlag().startDispatch({
      grant: { workId, runId, memberId: 'mem_proposer', role: 'coordinator' },
      taskId: task.id,
    });
    expect(pending.status).toBe('pending_approval');
    (b.hub.send as unknown as ReturnType<typeof vi.fn>).mockClear();

    turnFlagOff();
    await expect(b.service.resolveCoordinationGate(pending.dispatchId, 'approve'))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    expect(b.hub.send).not.toHaveBeenCalled();
    expect(b.repo.getCoordinationDispatch(pending.dispatchId).status).toBe('pending_approval');
  });

  it('el puente de handoff tampoco crea tareas ni despacha con la bandera baja', async () => {
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    const tasksBefore = b.repo.listCoordinationTasks(runId).length;
    turnFlagOff();

    await expect(engineWithRealFlag().bridgeHandoffToTask(workId, 'copywriter', 'Algo nuevo'))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(tasksBefore);
    expect(b.hub.send).not.toHaveBeenCalled();
  });

  /**
   * D4: el MOTOR se niega (arriba), pero la puerta que aprieta la persona
   * —`acceptHandoffAsTask` por IPC— degrada al borrador de chat, exactamente
   * como promete su docstring. Bajar la bandera no puede convertir "aceptar un
   * pedido" en un error: antes de que coordinación existiera, eso abría un chat.
   */
  it('`acceptHandoffAsTask` por IPC degrada con la bandera baja en vez de tirar', async () => {
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    const tasksBefore = b.repo.listCoordinationTasks(runId).length;
    turnFlagOff();

    const result = await b.service.acceptHandoffAsTask(workId, 'pedido-que-no-existe.md');

    expect(result).toEqual({ bridged: false, task: null });
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(tasksBefore);
    expect(b.hub.send).not.toHaveBeenCalled();
  });

  /**
   * D4: un interruptor que sólo impide encender no es un interruptor — pero uno
   * que también impide APAGAR es peor. `reject` y `cancelRun` son salidas.
   */
  it('con la bandera baja, RECHAZAR la propuesta sigue funcionando: apaga, no enciende', async () => {
    turnFlagOff();

    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'reject');

    expect(b.repo.getCoordinationRun(runId).status).toBe('cancelled');
    expect(addMember).not.toHaveBeenCalled();
    expect(metaKeysWritten()).toEqual([]);
  });

  function engineWithRealFlag(): CoordinationEngine {
    return new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: b.repo.getWork(id).brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => b.repo.getMeta(FEATURE_KEYS.coordination) === FEATURE_ON,
    });
  }
});
