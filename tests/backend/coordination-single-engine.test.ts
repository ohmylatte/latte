import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R1: UN SOLO `CoordinationEngine` POR PROCESO.
 *
 * Había dos sobre el mismo repo: el privado del servicio (todo lo que entra
 * por IPC) y el que `bootstrap.ts` construía aparte para el servidor MCP (todo
 * lo que entra por `tools/call`). El comentario que justificaba la duplicación
 * decía que eran "proxies sin estado", y dejó de ser cierto en cuanto el motor
 * ganó estado EN MEMORIA:
 *
 * - `pendingClose`: el último `latte_report` llega por MCP y aparca el cierre
 *   en el motor MCP; el fin de turno del coordinador llega por `emitChat` →
 *   `service.noteCoordinationTurnEnded`, o sea al motor DEL SERVICIO, cuyo
 *   `pendingClose` está vacío. El run se queda `running` para siempre.
 * - `assigning`: un despacho por MCP y una aprobación de gate por IPC del
 *   mismo rol leen cada uno su propia reserva, así que los dos eligen al MISMO
 *   miembro ocioso y el segundo `hub.send` pisa al primero.
 *
 * Los tres tests entran por donde entra la realidad: el servidor MCP que
 * construye `createBackend` (no uno de costado) y la fachada IPC del servicio.
 */
describe('R1: el motor de coordinación es único por proceso', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  /** El `tools/call` real que manda un cliente MCP, en JSON-RPC 2.0. */
  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined(); // nunca un 500 ni un error de protocolo
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: Record<string, unknown>, token: string) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    void brandId;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- (a) identidad ---------------------------------------------------------

  it('el motor del servidor MCP ES el motor del servicio, no una segunda instancia', () => {
    expect(b.coordinationMcpServer.engine).toBe(b.service.coordinationEngine);
  });

  // --- (b) el cierre aparcado por MCP se destraba por el fin de turno --------

  it('último `latte_report` por MCP con el coordinador a mitad de turno: `running` hasta el `idle`, y ahí `done`', async () => {
    fakeCoordinationHub(b, members);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'working' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');

    // La tarea y su despacho entran por las herramientas del coordinador.
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la única tarea' }, coordinatorToken));
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    expect(envelope(await call('latte_dispatch', { taskId }, coordinatorToken)).ok).toBe(true);
    const workerId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.memberId;
    expect(workerId).toBe('mem_a1');
    const workerToken = b.coordinationTokens.mint(workId, workerId);

    // El coordinador está pensando cuando entra el último reporte.
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockReturnValue(true);
    expect(envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }, workerToken)).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // el cierre queda APARCADO

    // Y el turno termina: el evento entra por el chokepoint de siempre.
    busy.mockReturnValue(false);
    b.emitChat({ chatId: 'mem_coordinator', type: 'status', status: 'idle', detail: '' });

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  // --- (c) la reserva de miembro la comparten MCP e IPC ----------------------

  it('un `latte_dispatch` por MCP y una aprobación de gate por IPC del mismo rol no eligen al mismo miembro', async () => {
    const spawn = deferred<void>();
    const { send } = fakeCoordinationHub(b, members, { hold: () => spawn.promise });
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    // DOS miembros del mismo rol, los dos ociosos: con una sola reserva
    // compartida el segundo despacho encuentra al segundo miembro; con dos
    // reservas separadas los dos se llevan al primero.
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    members.push({ id: 'mem_a2', workId, roleId: 'role_a', status: 'idle' });
    const coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');

    // Un gate pendiente, creado bajo autoridad `manual`; después se afloja a
    // `auto` para que el despacho por MCP no gatee también.
    await b.service.setCoordinationAuthority(workId, 'manual');
    const gated = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la de la aprobación' }, coordinatorToken));
    const gatedTaskId = (gated.data as { taskId: string }).taskId;
    expect(envelope(await call('latte_dispatch', { taskId: gatedTaskId }, coordinatorToken)).data).toMatchObject({ status: 'pending_approval' });
    const gateId = (await b.service.listCoordinationGates(runId)).find((g) => g.kind === 'dispatch')!.id;
    await b.service.setCoordinationAuthority(workId, 'auto');
    const direct = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'la del despacho directo' }, coordinatorToken));
    const directTaskId = (direct.data as { taskId: string }).taskId;

    // Los dos despachos, en vuelo a la vez, parados en el spawn.
    const viaMcp = call('latte_dispatch', { taskId: directTaskId }, coordinatorToken);
    const viaIpc = b.service.resolveCoordinationGate(gateId, 'approve');
    await settle();
    spawn.resolve();
    expect(envelope(await viaMcp).ok).toBe(true);
    await viaIpc;

    const assigned = [gatedTaskId, directTaskId].map(
      (taskId) => b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId && d.status === 'dispatched')!.memberId,
    );
    expect(assigned).toHaveLength(2);
    expect(new Set(assigned).size).toBe(2);
    // Y ningún miembro recibió dos prompts distintos pisándose.
    const targets = send.mock.calls.map((c) => c[0]);
    expect(targets).toHaveLength(2);
    expect(new Set(targets).size).toBe(2);
  });
});
