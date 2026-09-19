import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R9 y R10: dos puertas que decían que sí sin hacer nada.
 *
 * R9 — `answerCoordinationAsk` escribía `answer` y `answered_at` sin mirar si
 * la pregunta seguía esperando. Una pregunta ya contestada (dos personas, dos
 * pestañas) se pisaba en silencio, y una CERRADA POR VENCIMIENTO se
 * "contestaba" igual: la persona escribía una respuesta que nadie iba a leer
 * —el vencimiento ya había devuelto la tarea a la cola— y la interfaz le
 * decía que había salido bien. El UPDATE lleva `AND answered_at IS NULL` y
 * cero filas es un error con nombre.
 *
 * R10 — `pauseRun` sobre un run que no está corriendo devolvía el run tal cual,
 * o sea un éxito. Sobre un `planning` eso es especialmente falso: no hay nada
 * que pausar, la propuesta sigue esperando una decisión, y quien apretó
 * "Pausar" se queda creyendo que el equipo quedó detenido.
 */
describe('R9/R10: contestar y pausar dicen la verdad', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    fakeCoordinationHub(b, members);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function runWithAsk() {
    const run = await b.service.startCoordinationRun(workId);
    const ask = b.service.coordinationEngine.ask(
      { workId, runId: run.id, memberId: 'mem_a1', role: 'worker' },
      '¿Con qué tono?',
      60,
    );
    return { run, ask };
  }

  // --- R9 --------------------------------------------------------------------

  it('contestar dos veces la misma pregunta: la segunda se rechaza y no pisa la primera', async () => {
    const { ask } = await runWithAsk();
    await b.service.answerCoordinationAsk(ask.id, 'Cercano');

    await expect(b.service.answerCoordinationAsk(ask.id, 'Formal')).rejects.toMatchObject({ code: 'ASK_CLOSED' });

    expect(b.repo.getCoordinationAsk(ask.id).answer).toBe('Cercano');
  });

  it('contestar una pregunta VENCIDA se rechaza: ya no esperaba respuesta', async () => {
    const { ask } = await runWithAsk();
    b.repo.expireCoordinationAsk(ask.id, '2999-01-01T00:00:00.000Z');

    await expect(b.service.answerCoordinationAsk(ask.id, 'Tarde')).rejects.toMatchObject({ code: 'ASK_CLOSED' });

    // El cierre por vencimiento queda intacto: nadie contestó, y eso es lo que dice.
    const stored = b.repo.getCoordinationAsk(ask.id);
    expect(stored.answer).toBeNull();
    expect(stored.answeredAt).toBe('2999-01-01T00:00:00.000Z');
  });

  it('y la primera respuesta sigue entrando normalmente', async () => {
    const { ask } = await runWithAsk();

    const answered = await b.service.answerCoordinationAsk(ask.id, 'Cercano');

    expect(answered.answer).toBe('Cercano');
    expect(answered.answeredAt).not.toBeNull();
  });

  // --- R10 -------------------------------------------------------------------

  it('pausar un run en `planning` se rechaza con `RUN_NOT_RUNNING`, y el run no se toca', async () => {
    const run = await b.service.coordinationEngine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proponente', role: 'worker' },
      { plan: [{ roleId: 'strategist', spec: 'algo' }], estimatedDispatches: 3, rationale: 'porque sí' },
    );
    expect(run.status).toBe('planning');

    await expect(b.service.pauseCoordinationRun(run.id)).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });

    const after = b.repo.getCoordinationRun(run.id);
    expect(after.status).toBe('planning');
    expect(after.suspendReason).toBeNull();
    // La propuesta sigue sobre la mesa: pausar no se la comió.
    expect((await b.service.listCoordinationGates(run.id)).map((g) => g.kind)).toContain('proposal');
  });

  it('pausar un run ya suspendido también lo dice, en vez de fingir que lo pausó', async () => {
    const run = await b.service.startCoordinationRun(workId);
    await b.service.pauseCoordinationRun(run.id);
    expect(b.repo.getCoordinationRun(run.id).suspendReason).toBe('paused_by_human');

    await expect(b.service.pauseCoordinationRun(run.id)).rejects.toMatchObject({ code: 'RUN_NOT_RUNNING' });

    expect(b.repo.getCoordinationRun(run.id).suspendReason).toBe('paused_by_human');
  });

  it('pausar un run corriendo sigue funcionando', async () => {
    const run = await b.service.startCoordinationRun(workId);

    const view = await b.service.pauseCoordinationRun(run.id);

    expect(view.status).toBe('suspended');
    expect(b.repo.getCoordinationRun(run.id).suspendReason).toBe('paused_by_human');
  });
});
