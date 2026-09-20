import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 9 (L2): ESPERAR UNA RESPUESTA NO ES UN INTENTO FALLIDO.
 *
 * El caso 2 del barrido de la ronda 8 liquida —cobrando el intento— toda fila
 * abierta cuyo miembro esté vivo y `!isBusy` pasado el umbral. Un worker que
 * llamó a `latte_ask` MIENTRAS trabajaba está exactamente en ese estado: su
 * tarea sigue `dispatched` a propósito (para que su reporte pueda entrar), su
 * turno terminó, y hace poll con `latte_ask_status` hasta que alguien le
 * conteste — hasta `ASK_TTL_MAX_MINUTES`, o sea un día entero. A los treinta y
 * un minutos el barrido lo declaraba un agente que se fue sin reportar.
 */
describe('Ronda 9: el barrido no castiga al que espera una respuesta', () => {
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

  function callAs(bearer: string, name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${bearer}`, '127.0.0.1');
  }
  const call = (name: string, args: unknown) => callAs(token, name, args);

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

  it('un worker vivo y ocioso con una pregunta VIGENTE no es huérfano: nada se liquida, nada se cobra, y su reporte entra', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const taskId = await createTask('la que generó una duda a mitad de camino');
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    const workerToken = b.coordinationTokens.mint(workId, 'mem_worker');

    // El worker pregunta MIENTRAS trabaja: su tarea sigue `dispatched` a
    // propósito, y su turno termina (queda `idle`) mientras espera.
    expect(envelope(await callAs(workerToken, 'latte_ask', { question: '¿uso la voz vieja o la nueva?', taskId, ttlMinutes: 1440 })).ok).toBe(true);
    worker().status = 'idle';

    vi.setSystemTime(at(IN_FLIGHT_DISPATCH_STALE_MINUTES + 1));
    b.service.sweepCoordination();

    // ASSERT DESPUÉS del punto donde el caso 2 lo liquidaba.
    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(0);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);
    // Y el equipo no se suspende: hay alguien adentro esperando una respuesta.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    // Le contestan, y su reporte entra: la fila que lo autoriza sigue viva.
    const ask = b.repo.listOpenCoordinationAsks(runId)[0]!;
    await b.service.answerCoordinationAsk(ask.id, 'la nueva');
    const reported = envelope(await callAs(workerToken, 'latte_report', { taskId, outcome: 'succeeded', summary: 'hecho' }));
    expect(reported.error?.code).toBeUndefined();
    expect(reported.ok).toBe(true);
  });

  it('la antigüedad se mide desde que la pregunta dejó de esperar, no desde el despacho', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const taskId = await createTask('la que preguntó y nadie contestó');
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    const workerToken = b.coordinationTokens.mint(workId, 'mem_worker');
    // Una hora de plazo: vence en T+60.
    expect(envelope(await callAs(workerToken, 'latte_ask', { question: '¿seguimos?', taskId, ttlMinutes: 60 })).ok).toBe(true);
    worker().status = 'idle';

    // T+80: la pregunta venció hace veinte minutos. Todavía no hay huérfano,
    // aunque el DESPACHO tenga ochenta minutos.
    vi.setSystemTime(at(80));
    b.service.sweepCoordination();
    expect(openDispatches()).toHaveLength(1);
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(0);

    // T+91: treinta y un minutos DESDE EL VENCIMIENTO. Recién ahí se liquida,
    // y recién ahí se cobra el intento.
    vi.setSystemTime(at(91));
    b.service.sweepCoordination();
    expect(openDispatches()).toEqual([]);
    const task = b.repo.getCoordinationTask(taskId);
    expect(task.status).toBe('ready');
    expect(task.attempts).toBe(1);
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
  });
});
