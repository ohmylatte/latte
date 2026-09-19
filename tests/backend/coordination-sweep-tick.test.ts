import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q7: LEER NO ESCRIBE. LOS VENCIMIENTOS Y LOS CIERRES LOS CORRE UN TICK.
 *
 * `listGates` y `listOpenAsks` —dos LECTURAS, las dos alcanzables por IPC cada
 * vez que alguien abre Decisiones— llamaban a `refreshAsks`, que llama a
 * `finishRunIfComplete`, que llama a `closeRun`, que BORRA el permiso del
 * coordinador. O sea: mirar las decisiones de un equipo podía cerrarlo. Y la
 * tira global publicaba el `status` de la foto que había tomado ANTES de que
 * ese `listGates` escribiera, así que decía "en curso" sobre un run que ella
 * misma acababa de terminar.
 *
 * La razón por la que ese barrido vivía ahí era real: a un run suspendido por
 * preguntas vencidas no lo llamaba nadie. La respuesta correcta no es que las
 * lecturas escriban, es que haya QUIÉN corra el barrido sin que nadie mire: un
 * tick periódico del servicio. Los caminos que ya escribían (`report`,
 * `answerAsk`, `resumeRun`, `noteTurnEnded`, el barrido de arranque) siguen
 * corriéndolo igual.
 *
 * El reloj se mueve con `toFake: ['Date']`: sólo `Date`, para que los `await`
 * y los `setTimeout` del backend sigan siendo los de verdad.
 */
describe('Q7: las lecturas son puras y el tick es el que vence y cierra', () => {
  let b: TestBackend;
  let workId: string;
  let members: FakeTeamMember[];

  const TZERO = new Date('2026-09-18T10:00:00.000Z');
  const TWO_HOURS_LATER = new Date('2026-09-18T12:00:00.000Z');

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TZERO);
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); b.cleanup(); });

  /** Un run con TODO su trabajo terminado y una única pregunta —sin tarea— reteniéndolo. */
  async function runHeldByAnExpiringAsk() {
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist');
    const task = b.service.coordinationEngine.taskCreate(run.id, { roleId: 'strategist', spec: 'escribir' });
    await b.service.coordinationEngine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_c', role: 'coordinator' }, taskId: task.id });
    // La pregunta del coordinador ANTES del último reporte: sin `taskId`, así
    // que no traba ninguna tarea — pero SÍ retiene el cierre hasta que vence, y
    // el reporte que termina el trabajo la encuentra abierta.
    b.service.coordinationEngine.ask({ workId, runId: run.id, memberId: 'mem_c', role: 'coordinator' }, '¿seguimos?', 30);
    await b.service.settleCoordinationDispatch(task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(run.id).status).toBe('running');
    return run;
  }

  it('leer los gates NO escribe: con la pregunta ya vencida, el run sigue `running` y su fila queda intacta', async () => {
    const run = await runHeldByAnExpiringAsk();
    const before = b.repo.getCoordinationRun(run.id);
    vi.setSystemTime(TWO_HOURS_LATER); // el TTL de 30' venció hace rato

    const gates = await b.service.listCoordinationGates(run.id);

    expect(gates).toEqual([]);
    const after = b.repo.getCoordinationRun(run.id);
    expect(after.status).toBe('running');
    expect(after.updatedAt).toBe(before.updatedAt);
    // Y el permiso del coordinador sigue en pie: `closeRun` lo borra, y una
    // lectura no puede quitarle a nadie su permiso.
    expect(b.repo.getMeta('coordination_coordinator:' + workId)).not.toBe('');
    // La pregunta tampoco se cerró por haberla mirado.
    expect(b.repo.listOpenCoordinationAsks(run.id)).toHaveLength(1);
  });

  it('leer las preguntas abiertas tampoco escribe', async () => {
    const run = await runHeldByAnExpiringAsk();
    const before = b.repo.getCoordinationRun(run.id);
    vi.setSystemTime(TWO_HOURS_LATER);

    const asks = await b.service.listOpenCoordinationAsks(run.id);

    // Vencida pero todavía abierta: nadie la cerró, porque nadie escribió.
    expect(asks).toHaveLength(1);
    expect(b.repo.getCoordinationRun(run.id).updatedAt).toBe(before.updatedAt);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('running');
  });

  it('un tick vence la pregunta y cierra el run', async () => {
    const run = await runHeldByAnExpiringAsk();
    vi.setSystemTime(TWO_HOURS_LATER);

    b.service.sweepCoordination();

    expect(b.repo.getCoordinationRun(run.id).status).toBe('done');
    expect(b.repo.listOpenCoordinationAsks(run.id)).toHaveLength(0);
  });

  it('el tick es idempotente y no toca lo que todavía no vence', async () => {
    const run = await runHeldByAnExpiringAsk();

    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(run.id).status).toBe('running');

    vi.setSystemTime(TWO_HOURS_LATER);
    b.service.sweepCoordination();
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(run.id).status).toBe('done');
  });

  it('el tick levanta una suspensión por preguntas que ya no retienen a nadie', async () => {
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist');
    const task = b.service.coordinationEngine.taskCreate(run.id, { roleId: 'strategist', spec: 'escribir' });
    // Una pregunta SOBRE esa tarea: la traba, y con ella todo lo despachable.
    b.service.coordinationEngine.ask({ workId, runId: run.id, memberId: 'mem_w', role: 'worker' }, '¿en qué tono?', 30, task.id);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('suspended');
    expect(b.repo.getCoordinationRun(run.id).suspendReason).toBe('all_blocked_on_ask');

    vi.setSystemTime(TWO_HOURS_LATER);
    b.service.sweepCoordination();

    // La pregunta venció: ya no espera a nadie, la tarea volvió a la cola y el
    // equipo puede seguir. Sin el tick esto no pasaba hasta el próximo arranque.
    expect(b.repo.getCoordinationRun(run.id).status).toBe('running');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  it('el timer del servicio es real: se arranca cada 30s, dispara `sweepCoordination` y `shutdown` lo apaga', async () => {
    const ticks: Array<() => void> = [];
    const everyMs: number[] = [];
    let cancelled = 0;
    const timed = await makeBackend({
      sweepTimer: (tick, ms) => { ticks.push(tick); everyMs.push(ms); return () => { cancelled += 1; }; },
    });
    try {
      expect(ticks).toHaveLength(1);
      expect(everyMs).toEqual([30_000]);
      const spy = vi.spyOn(timed.service, 'sweepCoordination');
      ticks[0]!();
      expect(spy).toHaveBeenCalledTimes(1);
      timed.service.shutdown();
      expect(cancelled).toBe(1);
    } finally {
      timed.cleanup();
    }
  });
});
