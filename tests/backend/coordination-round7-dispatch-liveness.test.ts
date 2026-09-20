import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 7, N1: LA ANTIGÜEDAD NO ES EVIDENCIA DE MUERTE.
 *
 * La ronda 6 decidió que un despacho más viejo que `IN_FLIGHT_DISPATCH_STALE_MINUTES`
 * dejaba de contar como trabajo vivo. Un reloj no sabe si alguien está
 * trabajando: una tarea legítima de 31 minutos hacía que el run se suspendiera
 * `all_blocked_on_ask` CON un miembro adentro, el coordinador recibía
 * `RUN_NOT_ACTIVE` al crear la tarea siguiente, y "Reanudar" se deshacía en el
 * tick siguiente. Y el zombi de verdad quedaba igual de trabado: seguía
 * reteniendo el CIERRE, con el equipo suspendido por un motivo falso.
 *
 * La vida de un despacho la dice el HUB, que es quien tiene los procesos:
 *
 *  - `inFlight` = fila abierta cuyo miembro el hub CONOCE. Sin mirar el reloj.
 *  - el umbral queda sólo de respaldo para la fila SIN DUEÑO en el hub, y en
 *    ese caso el tick la LIQUIDA (reserva cerrada, tarea de vuelta a `ready`)
 *    en vez de dejarla reteniendo el cierre.
 */
describe('Ronda 7 / N1: la vida de un despacho la dice el hub', () => {
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

  it('una tarea legítima de 31 minutos sigue siendo trabajo vivo: el run no se suspende y el coordinador puede seguir', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que tarda de verdad');
    const blocked = await createTask('la que espera una respuesta');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);
    // El hub lo conoce y además dice que está ocupado: hay alguien adentro.
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockImplementation((id: string) => id === 'mem_worker');

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    expect(openDispatches()).toHaveLength(1); // la premisa: sigue en vuelo
    expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 120 })).ok).toBe(true);

    // Ni la pregunta ni el tick lo suspenden: el hub dice que hay alguien.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    // Y el coordinador puede seguir armando el plan: nada de `RUN_NOT_ACTIVE`.
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la siguiente' }));
    expect(created.ok).toBe(true);
    expect(busy).toHaveBeenCalled();
  });

  it('reanudar no se deshace en el tick siguiente mientras el hub tenga a alguien trabajando', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const working = await createTask('la que tarda de verdad');
    const blocked = await createTask('la que espera una respuesta');
    expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);
    vi.spyOn(b.hub, 'isMemberBusy').mockImplementation((id: string) => id === 'mem_worker');
    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 120 })).ok).toBe(true);

    await b.service.pauseCoordinationRun(runId);
    await b.service.resumeCoordinationRun(runId);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    b.service.sweepCoordination();
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  it('la fila SIN DUEÑO en el hub y más vieja que el umbral la LIQUIDA el tick: reserva cerrada, tarea de vuelta a `ready`', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la del proceso que se murió sin avisar');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1); // la premisa
    // El proceso murió y el hub ya no lo conoce: ni en `listTeam` ni ocupado.
    members.splice(members.findIndex((m) => m.id === 'mem_worker'), 1);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    expect(openDispatches()).toEqual([]);
    expect(b.repo.getCoordinationTask(orphan).status).toBe('ready');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    // Y el intento NO se le cobra a la tarea: el proceso se murió, no falló.
    expect(b.repo.getCoordinationTask(orphan).attempts).toBe(0);
  });

  it('liquidada la huérfana, el run suspende con el motivo VERDADERO cuando la tarea queda esperando una respuesta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const orphan = await createTask('la del proceso que se murió sin avisar');
    expect(envelope(await call('latte_dispatch', { taskId: orphan })).ok).toBe(true);
    members.splice(members.findIndex((m) => m.id === 'mem_worker'), 1);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationTask(orphan).status).toBe('ready');

    expect(envelope(await call('latte_ask', { question: '¿y ahora?', taskId: orphan, ttlMinutes: 120 })).ok).toBe(true);
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('all_blocked_on_ask');
  });

  it('la fila reciente sin dueño en el hub no se toca todavía', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const recent = await createTask('la que recién salió');
    expect(envelope(await call('latte_dispatch', { taskId: recent })).ok).toBe(true);
    members.splice(members.findIndex((m) => m.id === 'mem_worker'), 1);

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES - 5));
    b.service.sweepCoordination();

    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(recent).status).toBe('dispatched');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
  });
});
