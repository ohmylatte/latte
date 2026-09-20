import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 9 (L1 + L4): LA CONFIRMACIÓN TAMBIÉN RELEE LA TAREA.
 *
 * `runTransaction` releía el RUN y el presupuesto, nunca la TAREA. Desde la
 * ronda 8 hay un escritor de la tarea DURANTE el `await` que levanta el
 * proceso: el caso 3 de `settleOrphanDispatches` devuelve a `ready` la tarea
 * reclamada cuyo despacho nunca nació. Con eso, un spawn que tardó más que el
 * umbral volvía y escribía reserva, fila y `hub.send` sobre una tarea que ya
 * era de otro — o de nadie. `report()` asume a lo sumo UNA fila abierta por
 * tarea, así que el miembro legítimo recibía `FORBIDDEN`.
 *
 * Y el reloj de la fila (L4): `createdAt`/`startedAt` se tomaban ANTES del
 * `await`, así que una fila commiteada tras un spawn largo nacía vencida y el
 * tick siguiente la liquidaba.
 */
describe('Ronda 9: el reclamo se confirma releyendo la tarea, y la fila no nace vencida', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let hub: ReturnType<typeof fakeCoordinationHub>;
  let removed: string[];
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

  function callAs(bearer: string, name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${bearer}`, '127.0.0.1');
  }
  const call = (name: string, args: unknown) => callAs(token, name, args);

  /** Vuelve a cablear el fake del hub, esta vez con la espera del spawn bajo control del test. */
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
    b = await makeBackend();
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

  // --- L1(a)(b): el reclamo que el barrido soltó no vuelve a despacharse -----

  it('el spawn que vuelve tarde NO despacha sobre un reclamo que el barrido soltó, y deshace su alta', async () => {
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que se reclamó dos veces');
    const hung = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);
    // La premisa exacta del hallazgo: la tarea ya está reclamada y todavía no
    // existe ninguna fila de despacho — la fila se inserta DESPUÉS del spawn.
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.listCoordinationDispatches(runId)).toEqual([]);
    expect(members.some((m) => m.roleId === 'role_a')).toBe(true); // `addMember` contrató de verdad

    // El caso 3 del barrido devuelve la tarea a `ready`: el reclamo se perdió.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');

    // Y ahora vuelve el spawn colgado. ASSERT DESPUÉS del punto del defecto.
    first.resolve();
    const late = envelope(await hung);
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe('CLAIM_LOST');
    // Nada se escribió sobre la tarea de nadie, nada se reservó, nada salió.
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');
    expect(b.repo.getCoordinationTask(taskId).assignedMemberId).toBeNull();
    expect(openDispatches()).toEqual([]);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(hub.send).not.toHaveBeenCalled();
    // Y la contratación fresca se deshizo: nadie queda contratado para un
    // despacho que no salió.
    expect(removed).toHaveLength(1);
    // La bitácora lo dice: sin una fila, la persona vería una tarea que vuelve
    // sola a la cola y ninguna explicación.
    const trail = b.repo.listCoordinationDispatches(runId);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.status).toBe('cancelled');
    expect(trail[0]!.outcome).toBe('claim_lost');
  });

  it('el escenario completo del hallazgo: UNA fila abierta, UNA reserva, UN send, y el report del segundo miembro entra', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que se despachó dos veces');
    const hung = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.listCoordinationDispatches(runId)).toEqual([]);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');

    // El coordinador la vuelve a despachar: ÉSTE es el despacho legítimo.
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    expect(openDispatches()).toHaveLength(1);
    const legit = openDispatches()[0]!;
    expect(legit.memberId).not.toBe('');

    // Y recién ahí vuelve el spawn colgado.
    first.resolve();
    expect(envelope(await hung).ok).toBe(false);

    expect(openDispatches()).toHaveLength(1);
    expect(openDispatches()[0]!.id).toBe(legit.id);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    expect(hub.send).toHaveBeenCalledTimes(1);
    expect(b.repo.getCoordinationTask(taskId).assignedMemberId).toBe(legit.memberId);

    // El miembro legítimo reporta y su reporte ENTRA: sin la confirmación,
    // `report()` encontraba primero la fila del despacho tardío —más vieja por
    // `created_at`— y le respondía `FORBIDDEN`.
    const workerToken = b.coordinationTokens.mint(workId, legit.memberId);
    const reported = envelope(await callAs(workerToken, 'latte_report', { taskId, outcome: 'succeeded', summary: 'hecho' }));
    expect(reported.error?.code).toBeUndefined();
    expect(reported.ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('done');
  });

  // --- L1(c): el camino por gate confirma que la fila sigue siendo la suya ---

  it('una fila `pending_approval` que el barrido liquidó no revive cuando el spawn vuelve', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    await b.service.setCoordinationAuthority(workId, 'manual');
    const first = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? first.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la que pasa por gate');
    const gated = envelope(await call('latte_dispatch', { taskId }));
    expect(gated.ok).toBe(true);
    const gateId = (gated.data as { dispatchId: string }).dispatchId;
    expect(b.repo.getCoordinationDispatch(gateId).status).toBe('pending_approval');

    // La persona aprueba, y el spawn se cuelga con la fila ya reclamada.
    const approving = b.service.resolveCoordinationGate(gateId, 'approve');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.getCoordinationDispatch(gateId).status).toBe('dispatched');
    expect(b.repo.getCoordinationDispatch(gateId).memberId).toBe(''); // todavía nadie

    // El caso 1 del barrido la liquida: no hay nadie adentro de esa fila.
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationDispatch(gateId).status).toBe('cancelled');
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');

    first.resolve();
    await expect(approving).rejects.toMatchObject({ code: 'CLAIM_LOST' });

    // La fila liquidada NO revive, y nada se reservó ni salió.
    expect(b.repo.getCoordinationDispatch(gateId).status).toBe('cancelled');
    expect(openDispatches()).toEqual([]);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(hub.send).not.toHaveBeenCalled();
  });

  // --- L4: el reloj de la fila se toma al COMMITEAR, no antes del `await` ---

  it('una fila commiteada tras un spawn de 40 minutos no nace vencida: el tick siguiente no la liquida', async () => {
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const slow = deferred();
    let spawns = 0;
    rewire(() => (spawns++ === 0 ? slow.promise : Promise.resolve()));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const taskId = await createTask('la del spawn lento');
    const inFlight = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);

    // Cuarenta minutos de spawn, sin que nadie barra en el medio: el reclamo
    // sigue siendo suyo, así que el despacho SÍ tiene que commitear.
    vi.setSystemTime(at(40));
    slow.resolve();
    expect(envelope(await inFlight).ok).toBe(true);

    const born = openDispatches();
    expect(born).toHaveLength(1);
    // El reloj de la fila es el del COMMIT, no el de antes del `await`.
    expect(born[0]!.startedAt).toBe(at(40).toISOString());
    expect(born[0]!.createdAt).toBe(at(40).toISOString());

    // Y el tick siguiente no la liquida: tiene un minuto de vida, no cuarenta.
    vi.setSystemTime(at(41));
    b.service.sweepCoordination();
    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(0);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
  });
});
