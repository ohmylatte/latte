import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R4: VENCER UNA PREGUNTA Y CONTESTAR UNA PREGUNTA SON DECISIONES SOBRE EL RUN.
 *
 * `refreshAsks` corre desde `listGates`, `listOpenAsks` y `resumeRun`, y
 * ninguno de los tres volvía a `finishRunIfComplete`: un run con todo su
 * trabajo terminado y una sola pregunta abierta quedaba `running` para
 * siempre, porque la pregunta lo retenía hasta vencer y, una vez vencida,
 * nadie volvía a preguntarse si ya no quedaba nada.
 *
 * Y del otro lado: `answerAsk` levantaba la suspensión `all_blocked_on_ask`
 * por el solo hecho de que ALGUIEN contestara ALGO. Con tres preguntas
 * abiertas, contestar la que no traba ninguna tarea devolvía el run a
 * `running` con todas sus tareas todavía `blocked`: un equipo que dice estar
 * trabajando y no tiene una sola tarea que pueda despachar.
 *
 * El reloj del motor del test arranca DIEZ MINUTOS ATRÁS del real —el que usa
 * el motor del servicio—, así que una pregunta de 1 minuto ya está vencida
 * cuando la lectura por IPC la mira, y una de 60 todavía no.
 */
describe('R4: el cierre y la suspensión se re-evalúan cuando las preguntas cambian', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;
  const CLOCK_OFFSET_MS = 10 * 60_000;
  let now = Date.now() - CLOCK_OFFSET_MS;
  const clock = () => new Date(now).toISOString();

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }
  function worker(memberId: string): CoordinationGrant {
    return { workId, runId, memberId, role: 'worker' };
  }

  beforeEach(async () => {
    b = await makeBackend();
    now = Date.now() - CLOCK_OFFSET_MS;
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock,
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => true,
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // Q7: estas dos entraban por `listCoordinationGates`/`listOpenCoordinationAsks`
  // porque el barrido de vencimientos vivía adentro de esas LECTURAS. Vivía
  // mal: `refreshAsks` llama a `finishRunIfComplete`, que llama a `closeRun`,
  // que le borra el permiso al coordinador — o sea que abrir Decisiones podía
  // terminar el equipo. El barrido ahora tiene dueño propio, el tick periódico
  // del servicio, y es por ahí por donde estos escenarios entran. Lo que se
  // prueba no cambió: una pregunta vencida deja de retener y el run cierra.
  it('todo terminado y una pregunta sin tarea que vence: el tick cierra el run', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
    // Una pregunta SIN tarea: no traba a nadie, pero retiene el cierre —
    // es trabajo pendiente de la PERSONA.
    engine.ask(worker(memberId), '¿Lo publicamos hoy?', 1);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.listCoordinationTasks(runId).every((t) => t.status === 'done')).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // la pregunta lo retiene

    // Diez minutos después corre el tick. El plazo ya pasó.
    b.service.sweepCoordination();

    expect(await b.service.listOpenCoordinationAsks(runId)).toEqual([]);
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('y abrir Decisiones NO lo cierra: leer es leer', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
    engine.ask(worker(memberId), '¿Lo publicamos hoy?', 1);
    await engine.report(worker(memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    // Las dos lecturas que antes escribían, una detrás de la otra: el run sigue
    // vivo y el permiso del coordinador sigue en su lugar.
    await b.service.listCoordinationGates(runId);
    await b.service.listOpenCoordinationAsks(runId);

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getMeta('coordination_coordinator:' + workId)).not.toBe('');

    // Y el tick, que es el que sí escribe, lo cierra.
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('contestar la pregunta que no traba ninguna tarea NO levanta la suspensión', async () => {
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const second = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    engine.ask(worker('mem_a1'), '¿Con qué tono?', 60, first.id);
    engine.ask(worker('mem_b1'), '¿Con qué extensión?', 60, second.id);
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');
    // La tercera no traba ninguna tarea: es una consulta suelta.
    const loose = engine.ask(worker('mem_a1'), '¿Firmamos con el nombre de la marca?', 60);

    await b.service.answerCoordinationAsk(loose.id, 'Sí, con el nombre completo');

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('all_blocked_on_ask');
    expect(b.repo.getCoordinationTask(first.id).status).toBe('blocked');
    expect(b.repo.getCoordinationTask(second.id).status).toBe('blocked');
  });

  it('y contestar la ÚLTIMA que sí trababa sí la levanta: la salida existe', async () => {
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const askOne = engine.ask(worker('mem_a1'), '¿Con qué tono?', 60, first.id);
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');

    await b.service.answerCoordinationAsk(askOne.id, 'Cercano');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationTask(first.id).status).toBe('ready');
  });
});
