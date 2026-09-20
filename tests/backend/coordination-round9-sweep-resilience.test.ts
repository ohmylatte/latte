import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, fakeMemberIsLive, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 9 (L7, L10, L11): EL BARRIDO NO DEJA FILAS REHENES, LEE EL HUB COMO
 * PROMETE, Y EL FAKE DEL HUB DICE LA VERDAD.
 */
describe('Ronda 9: el barrido no deja filas rehenes y lee el hub como promete', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let logged: string[];
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

  const call = (name: string, args: unknown) =>
    b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');

  async function createTask(spec: string): Promise<string> {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec }));
    expect(created.ok, spec).toBe(true);
    return (created.data as { taskId: string }).taskId;
  }

  const openDispatches = () => b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched' || d.status === 'running');

  beforeEach(async () => {
    logged = [];
    b = await makeBackend({ log: (line) => logged.push(line) });
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
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); b.cleanup(); });

  // --- L7: un `try` por fila y otro por bloque -------------------------------

  it('una fila que tira no impide liquidar la siguiente, y el fallo queda en el log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const first = await createTask('la primera');
    const second = await createTask('la segunda');
    expect(envelope(await call('latte_dispatch', { taskId: first })).ok).toBe(true);
    expect(envelope(await call('latte_dispatch', { taskId: second })).ok).toBe(true);
    const rows = openDispatches();
    expect(rows).toHaveLength(2);
    const [broken, healthy] = rows;
    // Los dos miembros se van: nadie adentro de ninguna de las dos filas.
    for (const m of members) if (m.roleId === 'role_a') m.status = 'paused';

    // La PRIMERA fila tira al liquidarse. Con un solo `try`, la segunda —y el
    // bloque del caso 3— se iban con ella, en silencio y para siempre: el
    // defecto que la hace tirar no se arregla solo, así que el tick siguiente
    // se traba en la misma fila.
    const real = b.repo.getCoordinationDispatch.bind(b.repo);
    vi.spyOn(b.repo, 'getCoordinationDispatch').mockImplementation((id: string) => {
      if (id === broken!.id) throw new Error('fila ilegible');
      return real(id);
    });

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    // ASSERT DESPUÉS del punto donde la segunda quedaba rehén.
    const stillOpen = openDispatches();
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.id).toBe(broken!.id);
    expect(b.repo.getCoordinationTask(healthy!.taskId).status).toBe('ready');
    // Y el fallo se dice, no se traga.
    expect(logged.some((line) => line.includes(broken!.id) && line.includes('fila ilegible'))).toBe(true);
  });

  it('el bloque del caso 3 corre aunque una fila haya tirado', async () => {
    const hold = deferred();
    let spawns = 0;
    vi.restoreAllMocks();
    fakeCoordinationHub(b, members, { hold: () => (spawns++ === 0 ? Promise.resolve() : hold.promise) });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const settled = await createTask('la que tiene fila');
    expect(envelope(await call('latte_dispatch', { taskId: settled })).ok).toBe(true);
    const row = openDispatches()[0]!;
    for (const m of members) if (m.roleId === 'role_a') m.status = 'paused';

    // Y una tarea reclamada cuyo despacho nunca nació (el caso 3).
    const hung = await createTask('la del spawn colgado');
    const inFlight = call('latte_dispatch', { taskId: hung });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.repo.getCoordinationTask(hung).status).toBe('dispatched');

    const real = b.repo.getCoordinationDispatch.bind(b.repo);
    vi.spyOn(b.repo, 'getCoordinationDispatch').mockImplementation((id: string) => {
      if (id === row.id) throw new Error('fila ilegible');
      return real(id);
    });

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    // El caso 3 corrió igual: el reclamo huérfano se soltó.
    expect(b.repo.getCoordinationTask(hung).status).toBe('ready');

    hold.resolve();
    await inFlight;
  });

  // --- L10: un hub que tira se lee como "ocupado" ----------------------------

  it('`isMemberBusy` que tira NO liquida la fila: no saber no es una razón para actuar', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const taskId = await createTask('la del miembro incierto');
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    for (const m of members) if (m.roleId === 'role_a') m.status = 'paused';

    // SÓLO `isMemberBusy` tira: `liveMemberIds` contesta, así que el barrido
    // no sale por la puerta de "no se pudo saber" de arriba y llega hasta acá.
    vi.spyOn(b.hub, 'isMemberBusy').mockImplementation(() => { throw new Error('adaptador caído'); });

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    // ASSERT DESPUÉS del punto donde el `catch { return false }` liquidaba.
    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
  });

  // --- L11: el fake del hub declara vivo recién al terminar el spawn ---------

  it('el fake del hub no declara vivo a un miembro a mitad de spawn', async () => {
    const hold = deferred();
    vi.restoreAllMocks();
    fakeCoordinationHub(b, members, { hold: () => hold.promise });
    // Sin nadie de `role_b`: el despacho tiene que CONTRATAR.
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));

    const created = envelope(await call('latte_task_create', { roleId: 'role_b', spec: 'la del alta nueva' }));
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    const inFlight = call('latte_dispatch', { taskId });
    await vi.advanceTimersByTimeAsync(0);

    // La fila ya existe —`insertMember` es sincrónico, como en el hub real—
    // pero NO hay adaptador adentro todavía.
    const hired = members.find((m) => m.roleId === 'role_b');
    expect(hired).toBeDefined();
    expect(b.hub.listTeam(workId).some((m) => m.id === hired!.id)).toBe(true);
    expect(fakeMemberIsLive(hired!)).toBe(false);
    expect(b.hub.liveMemberIds(workId).has(hired!.id)).toBe(false);

    // Y recién cuando el spawn termina, está vivo.
    hold.resolve();
    expect(envelope(await inFlight).ok).toBe(true);
    expect(fakeMemberIsLive(hired!)).toBe(true);
    expect(b.hub.liveMemberIds(workId).has(hired!.id)).toBe(true);
  });
});
