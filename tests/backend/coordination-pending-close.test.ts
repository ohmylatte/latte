import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult } from '../../electron/agents/types';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F1: el cierre pendiente no puede depender de que el coordinador siga vivo.
 *
 * `finishRunIfComplete` aparca el run en `pendingClose` cuando el coordinador
 * está a mitad de turno (D17), y el ÚNICO destrabador era `noteTurnEnded`,
 * llamado sólo desde un `status:'idle'`. Un coordinador que se muere —o al que
 * la persona pausa— nunca emite `idle`: emite `closed`, y esa rama de
 * `createBackend` hacía `return` antes de avisarle al motor. El run quedaba
 * `running` para siempre, ocupando uno de los cupos app-wide, con todo su
 * trabajo terminado.
 *
 * R1: los dos tests entran ENTEROS por el camino de producción. Antes creaban
 * su propio `CoordinationEngine` de costado y reportaban por
 * `settleCoordinationDispatch` —el motor DEL SERVICIO—, y el docstring lo
 * admitía: así nunca se habría visto que el motor del servidor MCP era otra
 * instancia, con su propio `pendingClose`. Acá la tarea se crea, se despacha y
 * se reporta por `handleMcpRequest` sobre el servidor que construye
 * `createBackend`, y el fin del turno llega por `b.emitChat` (el chokepoint
 * por el que pasa TODO evento de adaptador) o por `pauseTeamMember` por IPC.
 */
describe('F1: un cierre pendiente se destraba aunque el coordinador no vuelva', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  /** El `tools/call` real que manda un cliente MCP, en JSON-RPC 2.0. */
  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: Record<string, unknown>, token: string) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  /** Crea, despacha y devuelve `{taskId, memberId}` — todo por las herramientas MCP del coordinador. */
  async function dispatchViaMcp(roleId: string, coordinatorToken: string): Promise<{ taskId: string; memberId: string }> {
    const created = envelope(await call('latte_task_create', { roleId, spec: 'a' }, coordinatorToken));
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    const dispatched = envelope(await call('latte_dispatch', { taskId }, coordinatorToken));
    expect(dispatched.ok).toBe(true);
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId && d.status === 'dispatched')!.memberId;
    return { taskId, memberId };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // se entra por IPC y por MCP: la bandera tiene que estar arriba
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el coordinador se muere a mitad de turno: el `closed` destraba el cierre', async () => {
    fakeCoordinationHub(b, members);
    // El permiso de coordinador, escrito donde el motor lo lee. No pasa por
    // `setCoordinatorGrant` porque el miembro del hub falso no tiene fila.
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'working' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');
    const { taskId, memberId } = await dispatchViaMcp('role_a', coordinatorToken);

    // El coordinador está pensando cuando entra el último reporte, que llega
    // por `latte_report` sobre el servidor MCP de producción.
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockReturnValue(true);
    const workerToken = b.coordinationTokens.mint(workId, memberId);
    expect(envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }, workerToken)).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // el cierre queda pendiente

    // Y se muere: nunca va a emitir un `idle`.
    busy.mockReturnValue(false);
    b.emitChat({ chatId: 'mem_coordinator', type: 'closed', reason: 'Codex app-server exited (code 1)' });

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('la persona pausa al coordinador por IPC: el run igual termina', async () => {
    // Un adaptador de verdad, con filas de miembro de verdad: `pauseTeamMember`
    // pasa por `hub.pauseMember`, que exige la fila, y `stop` sólo emite el
    // `closed` si un adaptador es dueño del chat.
    const open = new Set<string>();
    vi.spyOn(b.claude, 'owns').mockImplementation((chatId: string) => open.has(chatId));
    vi.spyOn(b.claude, 'isBusy').mockReturnValue(true);
    vi.spyOn(b.claude, 'stop').mockImplementation((chatId: string) => {
      open.delete(chatId);
      b.emitChat({ chatId, type: 'closed', reason: 'stopped' });
    });
    vi.spyOn(b.claude, 'start').mockImplementation(async (input: AdapterStartInput): Promise<AdapterStartResult> => {
      open.add(input.chatId ?? '');
      return { session: sessionFrom(input, 'claude', null, null, input.label, false), runtimeSessionId: 'sess_fake' };
    });
    vi.spyOn(b.hub, 'send').mockResolvedValue(undefined);
    b.hub.setPrimary({ runtime: 'claude', model: null, accountId: null });

    const coord = await b.service.addTeamMember(workId, 'strategist');
    await b.service.setCoordinatorGrant(workId, coord.id);
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'analyst');
    const coordinatorToken = b.coordinationTokens.mint(workId, coord.id);
    const { taskId, memberId } = await dispatchViaMcp('analyst', coordinatorToken);

    const workerToken = b.coordinationTokens.mint(workId, memberId);
    expect(envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }, workerToken)).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // el coordinador sigue ocupado

    await b.service.pauseTeamMember(coord.id);

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });
});
