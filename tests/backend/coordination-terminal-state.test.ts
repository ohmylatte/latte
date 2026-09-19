import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda final, jueces adversariales:
 *
 * D1. No existe `blocked` permanente. Una dependencia caída o un rol que nadie
 *     contrató terminan la tarea en `failed` con su outcome; `blocked` queda
 *     SOLO para "bloqueada por una pregunta", y responderla la devuelve a la cola.
 * D2. Un run con preguntas abiertas no cierra, ni con reservas abiertas.
 * D3. Un run terminal (`done`/`cancelled`) no acepta una sola mutación más.
 * D17. El cierre del run no le pasa por debajo al coordinador que está en turno.
 * D18. La vista del run lleva `lastEventAt`, y la tira incluye lo recién terminado.
 */
describe('el estado terminal de un run y sus tareas', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  function worker(memberId: string): CoordinationGrant {
    return { workId, runId, memberId, role: 'worker' };
  }

  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  async function dispatchTo(taskId: string): Promise<string> {
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId });
    return b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tokens = new CoordinationTokenRegistry();
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
    await b.service.setCoordinationAuthority(workId, 'auto');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- D1: la dependencia caída FALLA a sus dependientes ----------------------

  it('D1: una tarea cuya dependencia terminó `failed` queda `failed` con outcome `dependency_failed`, y el run cierra', async () => {
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const second = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b', dependsOn: [first.id] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const memberId = await dispatchTo(first.id);
      await engine.report(worker(memberId), first.id, 'failed', 'no salió');
    }

    expect(b.repo.getCoordinationTask(first.id).status).toBe('failed');
    expect(b.repo.getCoordinationTask(second.id).status).toBe('failed');
    const row = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === second.id);
    expect(row).toBeDefined();
    expect(row!.outcome).toBe('dependency_failed');
    // Terminal de verdad: el run puede cerrarse en vez de quedar vivo para siempre.
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('D1: el rol que nadie contrató deja la tarea `failed` con outcome `role_not_approved`', async () => {
    approveCoordinationRoles(b, runId); // nadie aprobado
    const task = engine.taskCreate(runId, { roleId: 'role_z', spec: 'z' });

    await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });

    expect(b.repo.getCoordinationTask(task.id).status).toBe('failed');
    const row = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === task.id);
    expect(row!.outcome).toBe('role_not_approved');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('D1: `blocked` es SOLO por una pregunta, y responderla devuelve la tarea a `ready`', async () => {
    members.push({ id: 'mem_w', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    const ask = engine.ask(worker('mem_w'), '¿Qué tono usamos?', 30, task.id);

    expect(b.repo.getCoordinationTask(task.id).status).toBe('blocked');
    // D2: con una pregunta abierta el run NO cierra, aunque no quede nada más.
    expect(b.repo.getCoordinationRun(runId).status).not.toBe('done');

    engine.answerAsk(ask.id, 'Cercano y directo');

    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  // --- D2: preguntas abiertas y reservas abiertas frenan el cierre ------------

  it('D2: una pregunta abierta sin tarea asociada también impide cerrar el run', async () => {
    members.push({ id: 'mem_w', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    const ask = engine.ask(worker(memberId), '¿Sigo?', 30);

    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    engine.answerAsk(ask.id, 'sí');

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('D2: una reserva abierta SIN despacho abierto tampoco cierra el run', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    b.repo.updateCoordinationTask(task.id, { status: 'done' }, new Date().toISOString());
    // Una reserva huérfana: contabilidad abierta sin ninguna fila de despacho en vuelo.
    b.repo.insertCoordinationCostReservation({
      id: 'crs_orphan', runId, dispatchId: null, memberId: 'mem_x', runtime: 'codex', model: 'default',
      maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: 0, state: 'reserved', usageJson: null,
      createdAt: new Date().toISOString(), settledAt: null,
    });

    engine.sweepFinishedRuns();

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  // --- D3: un run terminal no acepta ninguna mutación -------------------------

  it('D3: sobre un run `done`, cancelar/pausar/reanudar/responder devuelven RUN_NOT_ACTIVE sin escribir', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    const done = b.repo.getCoordinationRun(runId);
    expect(done.status).toBe('done');

    expect(() => engine.cancelRun(runId)).toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }));
    expect(() => engine.pauseRun(runId)).toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }));
    expect(() => engine.resumeRun(runId)).toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }));
    expect(() => engine.planSubmit(runId, [{ roleId: 'role_a', spec: 'tarde' }])).toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }));

    const after = b.repo.getCoordinationRun(runId);
    expect(after.status).toBe('done');
    expect(after.updatedAt).toBe(done.updatedAt);
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(1);
    // Y `listGates` no ofrece decisiones sobre algo terminado.
    expect(engine.listGates(runId)).toEqual([]);
  });

  it('D3: cerrar el run limpia el permiso de coordinador para que no se arrastre al siguiente', async () => {
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);

    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    expect(b.repo.getMeta('coordination_coordinator:' + workId) || '').toBe('');
  });

  it('D3: cancelar también cancela los gates de despacho pendientes, con outcome `run_cancelled`', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const pending = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    expect(pending.status).toBe('pending_approval');

    engine.cancelRun(runId);

    const row = b.repo.getCoordinationDispatch(pending.dispatchId);
    expect(row.status).toBe('cancelled');
    expect(row.outcome).toBe('run_cancelled');
    expect(engine.listGates(runId)).toEqual([]);
  });

  it('D3: `planSubmit` sobre un run `planning` no pisa la propuesta: exige `running`', async () => {
    const second = await b.service.createWork(b.repo.getWork(workId).brandId, 'Otro');
    await b.service.setCoordinationBudget(second.id, { maxDispatches: 5 });
    const planning = await engine.requestCoordination(
      { workId: second.id, runId: null, memberId: 'mem_proposer', role: 'worker' },
      { plan: [{ roleId: 'role_a', spec: 'a' }], estimatedDispatches: 3, rationale: 'porque sí' },
    );

    expect(() => engine.planSubmit(planning.id, [{ roleId: 'role_a', spec: 'colado' }]))
      .toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }));

    const saved = JSON.parse(b.repo.getCoordinationRun(planning.id).planJson ?? '{}') as { plan?: unknown };
    expect(Array.isArray(saved.plan)).toBe(true); // la propuesta sigue siendo una propuesta
  });

  it('D2/D3: con el run terminado, `latte_dispatch` responde NO_ACTIVE_RUN y no escribe gasto', async () => {
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    const token = tokens.mint(workId, memberId);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    const spentBefore = engine.budgetBlockForEnvelope(runId).dispatchesUsed;
    const sendCalls = (b.hub.send as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const dispatched = await server.handleMcpRequest(rpc('latte_dispatch', { taskId: task.id }), `Bearer ${token}`, '127.0.0.1');

    expect(dispatched.status).toBe(200);
    expect(envelope(dispatched).ok).toBe(false);
    expect(envelope(dispatched).error?.code).toBe('NO_ACTIVE_RUN');
    expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(spentBefore);
    expect((b.hub.send as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(sendCalls);
  });

  // --- D17: el coordinador en turno ------------------------------------------

  /** Un run cuyo coordinador es un miembro de verdad: el del `beforeEach` no tiene ninguno. */
  async function restartWithCoordinator(): Promise<void> {
    engine.cancelRun(runId);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    const run = await engine.startRun(workId, 'mem_coordinator');
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  }

  it('D17: el run no cierra mientras el coordinador tiene un turno en curso; al terminarlo, cierra', async () => {
    await restartWithCoordinator();
    members.push({ id: 'mem_coordinator', workId, roleId: 'role_coord', status: 'working' });
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockReturnValue(true);
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);

    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    busy.mockReturnValue(false);
    engine.noteTurnEnded('mem_coordinator');

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('D17: si el coordinador crea una tarea nueva en ese turno, el run sigue vivo con ella', async () => {
    await restartWithCoordinator();
    members.push({ id: 'mem_coordinator', workId, roleId: 'role_coord', status: 'working' });
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockReturnValue(true);
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    const extra = engine.taskCreate(runId, { roleId: 'role_b', spec: 'lo que falta' });
    busy.mockReturnValue(false);
    engine.noteTurnEnded('mem_coordinator');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationTask(extra.id).status).toBe('ready');
  });

  // --- D18: el dato de "desde tu última visita" -------------------------------

  it('D18: la vista del run publica `lastEventAt`, y no es anterior a su `updatedAt`', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');

    const view = await b.service.getCoordinationRun(workId);

    expect(view).not.toBeNull();
    expect(typeof view!.lastEventAt).toBe('string');
    expect(view!.lastEventAt >= view!.updatedAt).toBe(true);
  });

  it('D18: un run recién terminado sigue apareciendo en la tira, con su estado', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');

    const strip = await b.service.listActiveCoordinationRuns();

    const row = strip.find((r) => r.runId === runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('done');
    expect(typeof row!.lastEventAt).toBe('string');
  });
});
