import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 7 (N1) + ronda 8 (M1): LA VIDA DE UN DESPACHO LA DICE EL ADAPTADOR.
 *
 * La ronda 7 acertó el diagnóstico —un reloj no sabe si alguien está
 * trabajando— y erró la señal: preguntó por la TABLA de miembros
 * (`hub.listTeam`, o sea `repo.listMembers` + `describe()`). La tabla sobrevive
 * a la muerte del proceso. Para un miembro muerto sin `closed`, o pausado por
 * la persona, `describe()` devuelve `status:'paused'` —la fila sigue ahí— y el
 * viejo `status !== 'ended'` daba `true`. O sea: TODO despacho abierto contaba
 * como trabajo vivo para siempre. El run no podía suspenderse ni cerrar, y
 * `settleOrphanDispatches` no liquidaba nunca nada.
 *
 * La señal honesta es la del ADAPTADOR: `hub.liveMemberIds(workId)` = los
 * miembros que algún adaptador posee. `working`/`idle` ⇒ hay alguien adentro;
 * `paused`/`ended` ⇒ no hay nadie, aunque la fila siga en la tabla. Por eso
 * acá NINGÚN test borra una fila de `members`: se le pone `status:'paused'`,
 * que es lo que el hub real publica cuando el proceso se fue.
 */
describe('Rondas 7 y 8: la vida de un despacho la dice el adaptador, no la tabla', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;

  const T0 = '2026-09-19T10:00:00.000Z';
  const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * 60_000);

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  async function createTask(spec: string): Promise<string> {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec }));
    expect(created.ok, spec).toBe(true);
    return (created.data as { taskId: string }).taskId;
  }

  const openDispatches = () => b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched' || d.status === 'running');
  const worker = () => members.find((m) => m.id === 'mem_worker')!;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_worker', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); b.cleanup(); });

  // --- Lo que la ronda 7 acertó: la antigüedad no mata a quien está adentro ---

  it('un miembro OCUPADO diez horas sigue siendo trabajo vivo: el run no se suspende y el coordinador puede seguir', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que tarda de verdad');
    const blocked = await createTask('la que espera una respuesta');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);
    // El adaptador lo posee Y dice que hay un turno en vuelo.
    worker().status = 'working';

    vi.setSystemTime(at(10 * 60));
    expect(openDispatches()).toHaveLength(1); // la premisa: sigue en vuelo
    expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 12 * 60 })).ok).toBe(true);

    // Ni la pregunta ni el tick lo suspenden: hay alguien adentro.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(openDispatches()).toHaveLength(1); // y el barrido NO lo liquidó

    // Y el coordinador puede seguir armando el plan: nada de `RUN_NOT_ACTIVE`.
    expect(envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la siguiente' })).ok).toBe(true);
  });

  it('reanudar no se deshace en el tick siguiente mientras haya alguien adentro', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que tarda de verdad');
    const blocked = await createTask('la que espera una respuesta');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);
    worker().status = 'working';
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 120 })).ok).toBe(true);

    await b.service.pauseCoordinationRun(runId);
    await b.service.resumeCoordinationRun(runId);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    b.service.sweepCoordination();
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  // --- M1, caso 1: nadie adentro (muerto sin `closed`, o pausado) -------------

  it('un miembro PAUSADO por la persona no es vida: el tick liquida su fila vieja SIN cobrar el intento', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la del proceso que ya no está');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1); // la premisa

    // La persona lo pausó: la FILA SIGUE EN LA TABLA, sin adaptador adentro.
    // Es exactamente lo que el hub real publica, y es lo que la ronda 7 leía
    // como "vivo".
    worker().status = 'paused';
    expect(b.hub.listTeam(workId).find((m) => m.id === 'mem_worker')?.status).toBe('paused');

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(openDispatches()).toEqual([]);
    expect(b.repo.getCoordinationTask(orphan).status).toBe('ready');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    // Pausar es una decisión de la PERSONA: no le cuesta un intento a la tarea.
    expect(b.repo.getCoordinationTask(orphan).attempts).toBe(0);
  });

  it('liquidada la huérfana, el run suspende con el motivo VERDADERO cuando la tarea queda esperando una respuesta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la del proceso que se murió sin avisar');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);
    worker().status = 'paused'; // murió sin `closed`: la fila queda, el proceso no

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationTask(orphan).status).toBe('ready');

    expect(envelope(await call('latte_ask', { question: '¿y ahora?', taskId: orphan, ttlMinutes: 120 })).ok).toBe(true);
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('all_blocked_on_ask');
  });

  it('la fila reciente sin nadie adentro no se toca todavía', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const recent = await createTask('la que recién salió');
    expect(envelope(await call('latte_dispatch', { taskId: recent })).ok).toBe(true);
    worker().status = 'paused';

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES - 5));
    b.service.sweepCoordination();

    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(recent).status).toBe('dispatched');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
  });

  // --- M1, caso 2: vivo pero OCIOSO. Terminó su turno y no reportó -----------

  it('un miembro VIVO y OCIOSO que nunca reportó paga el intento: la fila vieja se liquida CON cargo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const abandoned = await createTask('la que nadie reportó');
    expect(envelope(await call('latte_dispatch', { taskId: abandoned })).ok).toBe(true);
    // El proceso sigue vivo (`idle`): terminó su turno sin llamar `latte_report`.
    worker().status = 'idle';

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(openDispatches()).toEqual([]);
    const task = b.repo.getCoordinationTask(abandoned);
    expect(task.status).toBe('ready');
    expect(task.attempts).toBe(1); // terminar sin reportar SÍ es un intento fallido
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
  });

  it('un miembro VIVO y OCUPADO no paga nada, aunque su fila sea vieja', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que sigue en curso');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);
    worker().status = 'working';

    vi.setSystemTime(at(10 * 60));
    b.service.sweepCoordination();

    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(working).attempts).toBe(0);
  });

  // --- M1, caso 3: la tarea reclamada cuyo despacho nunca llegó a existir ----

  it('una tarea `dispatched` SIN fila de despacho (el spawn colgado) vuelve a `ready` pasado el umbral, y el spawn tardío no la vuelve a tomar', async () => {
    const hold = deferred();
    vi.restoreAllMocks();
    const hub = fakeCoordinationHub(b, members, { hold: () => hold.promise });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const hung = await createTask('la del spawn que se colgó');

    // La fila de despacho se inserta DESPUÉS del spawn: mientras el proceso
    // levanta, la tarea ya está reclamada y no hay ninguna fila.
    const inFlight = call('latte_dispatch', { taskId: hung });
    // El equivalente de `settle()` con los relojes falsos puestos: cede el
    // control hasta que todo lo encolado corrió, y deja al despacho parado en
    // su `await`.
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.getCoordinationTask(hung).status).toBe('dispatched');
    expect(b.repo.listCoordinationDispatches(runId)).toEqual([]);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(b.repo.getCoordinationTask(hung).status).toBe('ready');

    // L1 (ronda 9): Y EL SPAWN QUE AL FINAL VUELVE NO DESPACHA NADA.
    //
    // Acá el test terminaba en `hold.resolve()` sin assertar una sola cosa, y
    // lo que pasaba después era el crítico de la ronda 9: la transacción
    // releía el run y el presupuesto, nunca la tarea, así que escribía reserva,
    // fila y `hub.send` sobre un reclamo que este mismo barrido ya había
    // soltado. Se asserta DESPUÉS del punto donde eso ocurría.
    hold.resolve();
    const late = envelope(await inFlight);
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe('CLAIM_LOST');
    expect(b.repo.getCoordinationTask(hung).status).toBe('ready');
    expect(openDispatches()).toEqual([]);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(hub.send).not.toHaveBeenCalled();
    // La bitácora lo dice, que es lo único que este camino escribe.
    const trail = b.repo.listCoordinationDispatches(runId);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.outcome).toBe('claim_lost');
  });

  // --- M1(b): dos lecturas distintas de un hub que TIRA ----------------------

  it('si el hub TIRA, `allBlockedOnAsks` lee "hay alguien adentro": nunca se suspende sobre información que no se pudo obtener', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que tarda');
    const blocked = await createTask('la que espera una respuesta');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);

    vi.spyOn(b.hub, 'liveMemberIds').mockImplementation(() => { throw new Error('hub caído'); });
    vi.spyOn(b.hub, 'isMemberBusy').mockImplementation(() => { throw new Error('hub caído'); });

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 120 })).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  it('si el hub TIRA, `settleOrphanDispatches` lee "no liquidar en este tick": la fila queda intacta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la que no se sabe');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);
    worker().status = 'paused';

    vi.spyOn(b.hub, 'liveMemberIds').mockImplementation(() => { throw new Error('hub caído'); });
    vi.spyOn(b.hub, 'isMemberBusy').mockImplementation(() => { throw new Error('hub caído'); });

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(orphan).status).toBe('dispatched');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
  });

  // --- El PRODUCTOR REAL de huérfanas ----------------------------------------

  it('el productor real: liquidar por `closed` tira, el `guard` se lo traga, y el tick termina el trabajo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la del proceso que se cayó');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);

    // El `closed` llega y la liquidación tira: el `guard` de `bootstrap.ts` lo
    // loguea y sigue, así que la fila QUEDA ABIERTA. Éste es el huérfano real
    // que nadie recogía.
    const settleForMember = vi.spyOn(b.service, 'settleCoordinationDispatchesForMember')
      .mockImplementationOnce(() => { throw new Error('database is locked'); });
    const closed: ChatEvent = { chatId: 'mem_worker', type: 'closed', reason: 'Codex app-server exited (code 1)' };
    b.emitChat(closed);
    worker().status = 'paused'; // el proceso se fue: el adaptador ya no lo posee

    expect(settleForMember).toHaveBeenCalledTimes(1);
    expect(openDispatches()).toHaveLength(1); // la premisa: quedó abierta

    settleForMember.mockRestore();
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(openDispatches()).toEqual([]);
    expect(b.repo.getCoordinationTask(orphan).status).toBe('ready');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
  });
});
