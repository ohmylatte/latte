import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F5: una pregunta vencida deja de retener.
 *
 * `expireOverdueAsks` devolvía la tarea a `ready` y NO cerraba la pregunta:
 * `listOpenCoordinationAsks` filtra sólo por `answered_at IS NULL`, así que la
 * interfaz la seguía ofreciendo y `maybeSelfSuspendOnAsks` la seguía contando
 * como bloqueo — una pregunta nueva suspendía el run entero aunque hubiera
 * tareas `ready` para despachar. Y el barrido corría SÓLO dentro de
 * `finishRunIfComplete`, al que nadie llama en un run ya suspendido por
 * `all_blocked_on_ask`: el equipo quedaba parado para siempre esperando una
 * respuesta cuyo plazo ya había pasado.
 *
 * El vencimiento CIERRA la pregunta: `answered_at` con la marca del cierre y
 * `answer` en `null`. Es la forma más simple que no toca el esquema
 * (SCHEMA_VERSION se queda donde está) y es la única combinación que no puede
 * confundirse con una respuesta real — `answerCoordinationAsk` siempre escribe
 * un texto. `askStatus` la lee como "sin responder", que es la verdad.
 */
describe('F5: preguntas vencidas', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;
  /**
   * El reloj del motor del test arranca DIEZ MINUTOS ATRÁS del reloj real, que
   * es el que usa el motor del servicio: así una pregunta de 1 minuto ya está
   * vencida cuando la lectura por IPC la mira, y una de 60 todavía no. Las dos
   * mitades del escenario tienen que ser reproducibles contra el mismo reloj
   * real, que no se puede mover.
   */
  const CLOCK_OFFSET_MS = 10 * 60_000;
  let now = Date.now() - CLOCK_OFFSET_MS;

  const clock = () => new Date(now).toISOString();
  const advanceMinutes = (minutes: number) => { now += minutes * 60_000; };

  function worker(memberId = 'mem_a1'): CoordinationGrant {
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

  it('vencida: se cierra, deja de publicarse y su tarea vuelve a la cola', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const ask = engine.ask(worker(), '¿Seguimos?', 1, task.id);
    expect(b.repo.getCoordinationTask(task.id).status).toBe('blocked');

    advanceMinutes(5);
    // Por la capa real: la lista que alimenta la pantalla.
    const open = await b.service.listOpenCoordinationAsks(runId);

    expect(open).toEqual([]);
    expect(b.repo.getCoordinationAsk(ask.id).answeredAt).not.toBeNull();
    expect(b.repo.getCoordinationAsk(ask.id).answer).toBeNull(); // nadie contestó: no se inventa una respuesta
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    // Y sigue leyéndose como SIN responder, que es lo que pasó.
    expect(engine.askStatus(ask.id).answered).toBe(false);
  });

  it('una pregunta nueva no suspende el run si hay trabajo despachable', () => {
    const blocked = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    engine.ask(worker(), 'la primera', 1, blocked.id);

    advanceMinutes(5);
    const other = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    engine.ask(worker('mem_b1'), 'la segunda, legítima', 30, other.id);

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationTask(blocked.id).status).toBe('ready');
  });

  it('un run suspendido por preguntas vencidas vuelve a correr al listar los gates por IPC', () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    engine.ask(worker(), '¿Seguimos?', 1, task.id);
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');

    advanceMinutes(5);
    void b.service.listCoordinationGates(runId);

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  it('y también al reanudarlo por IPC, sin esperar al próximo arranque', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    engine.ask(worker(), '¿Seguimos?', 1, task.id);
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');

    advanceMinutes(5);
    const view = await b.service.resumeCoordinationRun(runId);

    expect(view.status).toBe('running');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
    expect(await b.service.listOpenCoordinationAsks(runId)).toEqual([]);
  });

  it('una pregunta VIGENTE sigue reteniendo: nada de esto vence lo que no venció', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const ask = engine.ask(worker(), '¿Seguimos?', 60, task.id);

    advanceMinutes(5);
    const open = await b.service.listOpenCoordinationAsks(runId);

    expect(open.map((a) => a.id)).toEqual([ask.id]);
    expect(b.repo.getCoordinationTask(task.id).status).toBe('blocked');
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
  });
});
