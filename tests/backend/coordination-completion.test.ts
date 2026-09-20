import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { MAX_ACTIVE_COORDINATION_RUNS } from '../../electron/coordination/limits';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * El estado final del run: hasta acá NINGÚN camino escribía `done`, así que un
 * equipo que terminaba todo su trabajo quedaba `running` para siempre —
 * ocupando uno de los cuatro cupos app-wide, sumando su gasto al tope global,
 * bloqueando un segundo equipo en el mismo Trabajo por el índice único parcial
 * y apareciendo vivo en la tira de equipos activos. La única salida era
 * "Cancelar", que la interfaz presenta como aborto de emergencia.
 *
 * Los tests entran por donde entra la realidad: el último reporte llega por
 * `latte_report` sobre el servidor MCP real (JSON-RPC, token minteado, grant
 * resuelto fresco), no llamando al motor de costado.
 */
describe('CoordinationEngine — un run termina cuando no queda nada por hacer', () => {
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

  function worker(memberId: string, run = runId, work = workId): CoordinationGrant {
    return { workId: work, runId: run, memberId, role: 'worker' };
  }

  function makeEngine(): CoordinationEngine {
    return new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  }

  /** El `{tool,args}` real que manda un cliente MCP, en JSON-RPC 2.0. */
  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined(); // nunca un 500 ni un error de protocolo
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  /** Despacha la tarea y devuelve el id del miembro al que le tocó. */
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
    engine = makeEngine();
    tokens = new CoordinationTokenRegistry();
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
    await b.service.setCoordinationAuthority(workId, 'auto');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- 1: el último reporte, por el camino real de `latte_report` -------------

  it('la última tarea reportada por `latte_report` sobre MCP deja el run `done` y libera su cupo', async () => {
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'la única tarea' });
    const memberId = await dispatchTo(task.id);
    const token = tokens.mint(workId, memberId);
    expect(b.repo.countActiveCoordinationRuns()).toBe(1);

    const result = await server.handleMcpRequest(
      rpc('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'listo' }),
      `Bearer ${token}`,
      '127.0.0.1',
    );

    expect(result.status).toBe(200);
    expect(envelope(result).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    expect(b.repo.listActiveCoordinationRuns().map((r) => r.id)).not.toContain(runId);
    expect(b.repo.countActiveCoordinationRuns()).toBe(0);
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  // --- 2: el índice único parcial ya no bloquea el Trabajo --------------------

  it('con el run terminado se puede arrancar otro equipo en el MISMO Trabajo', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');

    const second = await engine.startRun(workId, null);

    expect(second.id).not.toBe(runId);
    expect(second.status).toBe('running');
  });

  // --- 3: el cupo app-wide se libera -----------------------------------------

  it(`${MAX_ACTIVE_COORDINATION_RUNS} runs terminados no impiden el siguiente`, async () => {
    // El run del beforeEach es el primero; se completan ése y tres más.
    const works = [workId];
    for (let i = 1; i < MAX_ACTIVE_COORDINATION_RUNS; i += 1) {
      const work = await b.service.createWork(brandId, `Trabajo ${i}`);
      await b.service.setCoordinationBudget(work.id, { maxDispatches: 20 });
      await b.service.setCoordinationAuthority(work.id, 'auto');
      works.push(work.id);
    }
    expect(works).toHaveLength(MAX_ACTIVE_COORDINATION_RUNS);
    for (const work of works) {
      const run = work === workId ? b.repo.getCoordinationRun(runId) : await engine.startRun(work, null);
      approveCoordinationRoles(b, run.id, 'role_a');
      const task = engine.taskCreate(run.id, { roleId: 'role_a', spec: 'a' });
      const outcome = await engine.startDispatch({ grant: { workId: work, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' }, taskId: task.id });
      const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
      await engine.report(worker(memberId, run.id, work), task.id, 'succeeded', 'listo');
      expect(b.repo.getCoordinationRun(run.id).status).toBe('done');
    }
    expect(b.repo.countActiveCoordinationRuns()).toBe(0);

    const extra = await b.service.createWork(brandId, 'Uno más');
    await b.service.setCoordinationBudget(extra.id, { maxDispatches: 5 });

    const fifth = await engine.startRun(extra.id, null);

    expect(fifth.status).toBe('running');
  });

  // --- 4: la última tarea se resuelve por el barrido de inciertos -------------

  it('una tarea que llega al tope de intentos por muerte de proceso termina el run', async () => {
    const done = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const flaky = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    await engine.report(worker(await dispatchTo(done.id)), done.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // todavía queda una

    // Dos muertes de proceso: la tarea vuelve a `ready` con un intento cobrado.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await engine.startDispatch({ grant: coordinator(), taskId: flaky.id });
      engine.settleUncertain(outcome.dispatchId, { incrementAttempts: true });
      expect(b.repo.getCoordinationTask(flaky.id).status).toBe('ready');
    }
    const third = await engine.startDispatch({ grant: coordinator(), taskId: flaky.id });

    engine.settleUncertain(third.dispatchId, { incrementAttempts: true });

    expect(b.repo.getCoordinationTask(flaky.id).status).toBe('failed');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  // --- 5: una tarea fallida no impide terminar, y la bitácora lo dice ---------

  it('una tarea que agota sus intentos queda `failed`, el run termina y la bitácora dice 1 fallida', async () => {
    const ok = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const bad = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    await engine.report(worker(await dispatchTo(ok.id)), ok.id, 'succeeded', 'listo');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const memberId = await dispatchTo(bad.id);
      await engine.report(worker(memberId), bad.id, 'failed', 'no salió');
    }

    expect(b.repo.getCoordinationTask(bad.id).status).toBe('failed');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    const finished = engine.listLog(runId).filter((entry) => entry.kind === 'run_done');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ tasksDone: 1, tasksFailed: 1 });
  });

  // --- 6: lo bloqueado POR UNA PREGUNTA no es terminal: el run sigue vivo -----

  /**
   * D1: `blocked` dejó de significar "condenada" — una dependencia caída o un
   * rol sin contratar terminan `failed`, que SÍ es terminal. Lo único que queda
   * bajo `blocked` es lo que todavía se destraba de verdad: una tarea esperando
   * la respuesta a un `latte_ask`. Ése es el caso que tiene que mantener el run
   * vivo, porque la salida existe y es de la persona.
   */
  it('un run con una tarea bloqueada por una pregunta NO termina: espera a la persona', async () => {
    members.push({ id: 'mem_w', workId, roleId: 'role_a', status: 'idle' });
    const answered = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const waiting = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    await engine.report(worker(await dispatchTo(answered.id)), answered.id, 'succeeded', 'listo');

    const ask = engine.ask(worker('mem_w'), '¿Con qué tono?', 30, waiting.id);

    expect(b.repo.getCoordinationTask(waiting.id).status).toBe('blocked');
    expect(b.repo.getCoordinationRun(runId).status).not.toBe('done');
    expect(b.repo.listActiveCoordinationRuns().map((r) => r.id)).toContain(runId);

    // Y la salida existe: contestar la devuelve a la cola.
    engine.answerAsk(ask.id, 'Cercano');

    expect(b.repo.getCoordinationTask(waiting.id).status).toBe('ready');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  // --- 7: reparación de bases existentes, idempotente ------------------------

  it('el barrido de arranque termina un run viejo cuyas tareas ya estaban todas terminales', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    // La base que dejó la versión anterior: la tarea terminó, el run no.
    b.repo.updateCoordinationTask(task.id, { status: 'done' }, new Date().toISOString());
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    b.service.sweepUncertainCoordinationDispatches();

    const afterFirst = b.repo.getCoordinationRun(runId);
    expect(afterFirst.status).toBe('done');

    b.service.sweepUncertainCoordinationDispatches();

    const afterSecond = b.repo.getCoordinationRun(runId);
    expect(afterSecond.status).toBe('done');
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt); // idempotente: no reescribe nada
  });

  it('un run con un despacho en vuelo NO se da por terminado, aunque sus otras tareas estén listas', async () => {
    const inFlight = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    await dispatchTo(inFlight.id);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    // Una base inconsistente: la tarea figura terminal pero el despacho y su
    // reserva siguen abiertos. Un run así NO está terminado.
    b.repo.updateCoordinationTask(inFlight.id, { status: 'done' }, new Date().toISOString());

    engine.sweepFinishedRuns();

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  it('un run sin ninguna tarea nunca se da por terminado: el coordinador todavía no planificó', () => {
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0);

    engine.sweepFinishedRuns();

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  // --- 8: después de `done`, las herramientas responden con un error claro ----

  it('con el run terminado, `latte_check` responde NO_ACTIVE_RUN y no una excepción', async () => {
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const memberId = await dispatchTo(task.id);
    const token = tokens.mint(workId, memberId);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');

    const checked = await server.handleMcpRequest(rpc('latte_check', {}), `Bearer ${token}`, '127.0.0.1');
    const reported = await server.handleMcpRequest(
      rpc('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'de nuevo' }),
      `Bearer ${token}`,
      '127.0.0.1',
    );

    expect(checked.status).toBe(200);
    expect(envelope(checked).ok).toBe(false);
    expect(envelope(checked).error?.code).toBe('NO_ACTIVE_RUN');
    expect(reported.status).toBe(200);
    expect(envelope(reported).ok).toBe(false);
    expect(envelope(reported).error?.code).toBe('NO_ACTIVE_RUN');
    // Las herramientas del coordinador tampoco pueden seguir gastando. Esto
    // asertaba `toBeTypeOf('function')` sobre `latte_dispatch`: una tautología
    // que pasaba con el motor entero roto — lo único que probaba es que
    // `createCoordinationTools` devuelve funciones. Lo que hay que probar es
    // que un despacho sobre un run terminado se niega Y no escribe gasto.
    const spentBefore = engine.budgetBlockForEnvelope(runId).dispatchesUsed;
    const dispatched = await server.handleMcpRequest(rpc('latte_dispatch', { taskId: task.id }), `Bearer ${token}`, '127.0.0.1');

    expect(dispatched.status).toBe(200);
    expect(envelope(dispatched).ok).toBe(false);
    expect(envelope(dispatched).error?.code).toBe('NO_ACTIVE_RUN');
    expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(spentBefore);
    expect(b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched')).toHaveLength(0);
  });
});
