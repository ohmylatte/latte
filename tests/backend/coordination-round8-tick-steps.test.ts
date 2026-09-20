import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 8 (M3): EL TICK NO DEJA PASOS REHENES.
 *
 * `sweepActiveRuns` hace cuatro cosas por run activo y las hacía dentro de UN
 * solo `try`. Un fallo en la primera —liquidar huérfanos, que escribe en la
 * base y consulta al hub— se llevaba puestas las otras tres: no se vencían
 * preguntas, no se cerraban runs terminados y no se re-evaluaba la
 * auto-suspensión. Y como el `catch` se lo tragaba en silencio, el equipo
 * quedaba congelado sin que nadie se enterara, hasta el próximo arranque.
 *
 * Los cuatro pasos son independientes entre sí y todos idempotentes: cada uno
 * en su propio `try`, igual que el `guard` de la rama `closed` de
 * `bootstrap.ts`.
 */
describe('Ronda 8 / M3: los cuatro pasos del tick son independientes', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;

  interface TickSteps {
    settleOrphanDispatches: (run: unknown, now: string) => void;
    refreshAsks: (runId: string, now: string) => number;
    finishRunIfComplete: (runId: string, now: string) => void;
    maybeSelfSuspendOnAsks: (runId: string, now: string) => void;
  }
  const steps = (): TickSteps => b.service.coordinationEngine as unknown as TickSteps;

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

  let logged: string[];

  beforeEach(async () => {
    logged = [];
    b = await makeBackend({ log: (line) => { logged.push(line); } });
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

  it('si el primer paso TIRA, los otros tres corren igual', () => {
    const engine = steps();
    vi.spyOn(engine, 'settleOrphanDispatches').mockImplementation(() => { throw new Error('la base está trabada'); });
    const refresh = vi.spyOn(engine, 'refreshAsks');
    const finish = vi.spyOn(engine, 'finishRunIfComplete');
    const suspend = vi.spyOn(engine, 'maybeSelfSuspendOnAsks');

    b.service.sweepCoordination();

    expect(refresh).toHaveBeenCalled();
    expect(finish).toHaveBeenCalled();
    expect(suspend).toHaveBeenCalled();
    // Y el fallo no se traga en silencio.
    expect(logged.some((line) => line.includes('la base está trabada'))).toBe(true);
  });

  it('si el segundo paso TIRA, los dos de abajo corren igual', () => {
    const engine = steps();
    vi.spyOn(engine, 'refreshAsks').mockImplementation(() => { throw new Error('bitácora ilegible'); });
    const orphans = vi.spyOn(engine, 'settleOrphanDispatches');
    const finish = vi.spyOn(engine, 'finishRunIfComplete');
    const suspend = vi.spyOn(engine, 'maybeSelfSuspendOnAsks');

    b.service.sweepCoordination();

    expect(orphans).toHaveBeenCalled();
    expect(finish).toHaveBeenCalled();
    expect(suspend).toHaveBeenCalled();
  });

  it('si el tercer paso TIRA, el cuarto corre igual', () => {
    const engine = steps();
    vi.spyOn(engine, 'finishRunIfComplete').mockImplementation(() => { throw new Error('fila que ya no está'); });
    const suspend = vi.spyOn(engine, 'maybeSelfSuspendOnAsks');

    b.service.sweepCoordination();

    expect(suspend).toHaveBeenCalled();
  });

  it('y se ve de verdad: con el primer paso tirando, el run terminado igual CIERRA', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la única' }));
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);
    const workerToken = b.coordinationTokens.mint(workId, 'mem_worker');
    const reported = await b.coordinationMcpServer.handleMcpRequest(
      rpc('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }), `Bearer ${workerToken}`, '127.0.0.1');
    expect(envelope(reported).ok).toBe(true);
    // El cierre quedó aparcado o no; lo que importa es que el tick pueda
    // terminarlo aunque el primer paso se caiga.
    b.repo.updateCoordinationRunStatus(runId, 'running', new Date().toISOString(), null);

    vi.spyOn(steps(), 'settleOrphanDispatches').mockImplementation(() => { throw new Error('la base está trabada'); });
    b.service.sweepCoordination();

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });
});
