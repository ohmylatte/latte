import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 10: DESPUÉS DEL `await`, NINGUNA ESCRITURA SOBRE LA TAREA SIN EL TOKEN.
 *
 * La ronda 9 le puso un compare-and-set a UNA de las tres salidas del mismo
 * `await`: la que commitea. Las otras dos seguían escribiendo a ciegas sobre
 * `coordination_task`, y las dos pisan a quien haya llegado primero:
 *
 *  - la rama `RUN_NOT_ACTIVE` relee el RUN antes de confirmar el reclamo, y
 *    suelta la tarea con un CAS que sólo exige `status='dispatched'` — o sea
 *    que devuelve a `ready` la tarea que OTRO miembro ya reclamó y está
 *    trabajando;
 *  - el `catch` del spawn suelta el reclamo con un UPDATE pelado, así que un
 *    spawn que rechaza media hora tarde devuelve a `ready` una tarea que ya
 *    está `done`, con su `result_summary` puesto.
 */
describe('Ronda 10: el reclamo se confirma primero, y soltarlo exige el token', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let hub: ReturnType<typeof fakeCoordinationHub>;
  let removed: string[];
  let workId: string;
  let runId: string;
  let token: string;
  /** Lo que la pantalla recibiría: `touch` sale por acá, y sin cablearlo es un no-op. */
  let emitted: Array<{ brandId: string; workId: string; runId: string | null }>;

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

  function callAs(bearer: string, name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${bearer}`, '127.0.0.1');
  }
  const call = (name: string, args: unknown) => callAs(token, name, args);

  function rewire(hold?: () => Promise<void> | void): void {
    vi.restoreAllMocks();
    hub = fakeCoordinationHub(b, members, hold ? { hold } : {});
    removed = [];
    vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
      removed.push(memberId);
      const index = members.findIndex((m) => m.id === memberId);
      if (index >= 0) members.splice(index, 1);
    });
  }

  async function createTask(spec: string, roleId = 'role_a'): Promise<string> {
    const created = envelope(await call('latte_task_create', { roleId, spec }));
    expect(created.ok, spec).toBe(true);
    return (created.data as { taskId: string }).taskId;
  }

  const openDispatches = () => b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched' || d.status === 'running');

  beforeEach(async () => {
    emitted = [];
    b = await makeBackend({ emitCoordination: (event) => emitted.push(event) });
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    rewire();
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); b.cleanup(); });

  // --- K1: la rama `RUN_NOT_ACTIVE` no puede soltar la tarea de otro --------

  it('el spawn que vuelve con el run pausado NO devuelve a la cola la tarea que ya es de otro miembro', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que se reclamó dos veces');
    const hung = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.listCoordinationDispatches(runId)).toEqual([]);

    // El caso 3 del barrido suelta el reclamo: el despacho nunca llegó a nacer.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');

    // Y el coordinador la re-despacha: ÉSTE es el despacho legítimo.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 2));
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    const legit = openDispatches()[0]!;
    expect(legit.memberId).not.toBe('');

    // La persona pausa el run mientras el legítimo trabaja.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 3));
    await b.service.pauseCoordinationRun(runId);
    expect(b.repo.getCoordinationRun(runId).status).not.toBe('running');

    // Y AHORA vuelve el spawn colgado. ASSERT DESPUÉS del punto del defecto.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 4));
    const eventsBefore = emitted.length;
    first.resolve();
    const late = envelope(await hung);
    expect(late.ok).toBe(false);
    // El reclamo se confirma ANTES de releer el run: lo que este despacho
    // perdió es la tarea, y ése es el motivo que se reporta.
    expect(late.error?.code).toBe('CLAIM_LOST');

    // La tarea de mem_a2 quedó INTACTA: nadie la devolvió a la cola.
    const after = b.repo.getCoordinationTask(taskId);
    expect(after.status).toBe('dispatched');
    expect(after.assignedMemberId).toBe(legit.memberId);
    // Una sola fila abierta, la del legítimo, y ninguna reserva de más.
    expect(openDispatches()).toHaveLength(1);
    expect(openDispatches()[0]!.id).toBe(legit.id);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    expect(hub.send).toHaveBeenCalledTimes(1);

    // La bitácora lo anota UNA vez, y el intento es el que le tocaba al
    // reclamarlo: el 1, no un número posterior al despacho que lo reemplazó.
    const lost = b.repo.listCoordinationDispatches(runId).filter((d) => d.outcome === 'claim_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.attempt).toBe(1);
    expect(lost[0]!.settledAt! >= lost[0]!.createdAt).toBe(true);
    // Y la pantalla se entera de que el despacho se cerró: esta salida escribe
    // una fila de bitácora y se iba por el `throw` sin avisarle a nadie.
    expect(emitted.length).toBeGreaterThan(eventsBefore);
  });

  // --- K2: el `catch` del spawn tampoco escribe sin el token ---------------

  it('un spawn que RECHAZA tarde no revive una tarea que el re-despacho ya dejó `done`', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que ya está hecha');
    const hung = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 2));
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    const legit = openDispatches()[0]!;

    // El legítimo reporta: la tarea queda `done`, con su resumen.
    const workerToken = b.coordinationTokens.mint(workId, legit.memberId);
    expect(envelope(await callAs(workerToken, 'latte_report', { taskId, outcome: 'succeeded', summary: 'hecho' })).ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('done');

    // Media hora después, el spawn colgado RECHAZA.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 40));
    first.reject(new Error('el runtime nunca levantó'));
    const late = envelope(await hung);
    expect(late.ok).toBe(false);

    // La tarea terminada sigue terminada, con su resumen.
    const after = b.repo.getCoordinationTask(taskId);
    expect(after.status).toBe('done');
    expect(after.resultSummary).toBe('hecho');
    expect(after.assignedMemberId).toBe(legit.memberId);
    // Y no quedó ninguna fila abierta ni ninguna reserva viva.
    expect(openDispatches()).toEqual([]);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);

    // La bitácora anota el reclamo perdido, fechado cuando se escribió.
    const lost = b.repo.listCoordinationDispatches(runId).filter((d) => d.outcome === 'claim_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.settledAt! >= lost[0]!.createdAt).toBe(true);
  });

  // --- K3: el camino por gate confirma la TAREA, y no duplica asientos ------

  it('el camino por gate no le pisa el dueño a la tarea, y liquida SU fila en vez de abrir otra', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    await b.service.setCoordinationAuthority(workId, 'manual');
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que pasa por gate');
    const gated = envelope(await call('latte_dispatch', { taskId }));
    const gateId = (gated.data as { dispatchId: string }).dispatchId;

    // La persona aprueba y el spawn se cuelga con la FILA ya reclamada.
    const approving = b.service.resolveCoordinationGate(gateId, 'approve');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.getCoordinationDispatch(gateId).status).toBe('dispatched');

    // Y en esa ventana OTRO se queda con la tarea. La fila sigue abierta y
    // sigue siendo la suya: confirmarla a ella no dice NADA sobre la tarea.
    vi.setSystemTime(at(5));
    expect(b.repo.confirmCoordinationTaskClaim(taskId, 'mem_otro', null, at(5).toISOString())).toBe(true);

    vi.setSystemTime(at(6));
    first.resolve();
    await expect(approving).rejects.toMatchObject({ code: 'CLAIM_LOST' });

    // La tarea sigue siendo de quien la tomó: el gate no le escribió encima.
    expect(b.repo.getCoordinationTask(taskId).assignedMemberId).toBe('mem_otro');
    expect(hub.send).not.toHaveBeenCalled();
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    // UN solo asiento: SU fila, liquidada. No una fila nueva al lado de una
    // `pending_approval` que ya nadie iba a cerrar.
    const trail = b.repo.listCoordinationDispatches(runId);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.id).toBe(gateId);
    expect(trail[0]!).toMatchObject({ status: 'cancelled', outcome: 'claim_lost' });
  });

  // --- K4: los cierres se fechan cuando se escriben -------------------------

  it('la fila que `hub.send` no pudo mandar no se cierra cuarenta minutos antes de haber nacido', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const slow = deferred();
    rewire(() => slow.promise);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que no se pudo mandar');
    const inFlight = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);

    // Cuarenta minutos de spawn, y recién ahí `hub.send` falla.
    vi.setSystemTime(at(40));
    hub.send.mockRejectedValueOnce(new Error('el proceso se murió en el medio'));
    slow.resolve();
    expect(envelope(await inFlight).ok).toBe(false);

    const row = b.repo.listCoordinationDispatches(runId)[0]!;
    expect(row).toMatchObject({ status: 'cancelled', outcome: 'not_sent' });
    // El reloj de la fila es el del commit (ronda 9) y el del cierre es el de
    // AHORA: una fila no se liquida antes de existir.
    expect(row.createdAt).toBe(at(40).toISOString());
    expect(row.settledAt!>= row.createdAt).toBe(true);
    // Y la tarea sí vuelve a la cola: el reclamo seguía siendo suyo.
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
  });

  // --- K6: el compare-and-set también protege lo TERMINAL ------------------

  /**
   * `blockOnUnapprovedRole` escribe `failed`, que es terminal, y se lo alcanza
   * desde el mismo `catch` del spawn que a `releaseDispatchClaim`. Hoy no tiene
   * ventana —`ROLE_NOT_APPROVED` lo tira `reserveTargetMember`, que corre
   * sincrónicamente ANTES del `await`—, así que el escenario no se puede armar
   * desde afuera sin inventar una asincronía que el motor no tiene. Lo que sí
   * se prueba es la guarda misma, que es lo que lo vuelve seguro el día que
   * algo de ese camino espere: con el token roto, nada se marca terminal.
   */
  it('marcar una tarea `failed` con un token que ya no vale no la toca', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const taskId = await createTask('la del rol sin aprobar');
    const claimed = b.repo.claimCoordinationTaskForDispatch(taskId, '2026-09-19T10:00:00.000Z')!;
    expect(claimed).not.toBeNull();

    // Otro se la queda mientras este despacho levantaba su proceso.
    expect(b.repo.confirmCoordinationTaskClaim(taskId, 'mem_otro', claimed, '2026-09-19T10:05:00.000Z')).toBe(true);

    // Y el que llega tarde con el token viejo no la marca terminal.
    const failed = b.repo.releaseCoordinationTaskFromDispatch(taskId, '2026-09-19T10:06:00.000Z', { token: claimed, memberId: null }, 'failed');
    expect(failed).toBe(false);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.getCoordinationTask(taskId).assignedMemberId).toBe('mem_otro');

    // Con el token bueno sí, que es lo que hace que la guarda no sea un muro.
    const ok = b.repo.releaseCoordinationTaskFromDispatch(taskId, '2026-09-19T10:07:00.000Z', { token: '2026-09-19T10:05:00.000Z', memberId: 'mem_otro' }, 'failed');
    expect(ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('failed');
  });
});
