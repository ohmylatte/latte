import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * B5.3: LO QUE ESTÁ EN VUELO SE VE.
 *
 * La vista del run traía tres cuentas y `tasksPending` se tragaba lo
 * despachado. Con la única tarea del run en manos de un miembro que ya estaba
 * trabajando, la cabecera del equipo decía "3 sin empezar" y "Despachos: 0 /
 * 3": las dos frases falsas al mismo tiempo y en la misma línea, sobre un run
 * que tenía trabajo en curso y presupuesto ya comprometido.
 */
describe('B5.3: la vista del run cuenta aparte lo despachado', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: Record<string, unknown>, token: string) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('una tarea despachada cuenta como en vuelo, no como sin empezar', async () => {
    fakeCoordinationHub(b, members);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const token = b.coordinationTokens.mint(workId, 'mem_coordinator');

    // Tres tareas: una se despacha, dos se quedan en la cola.
    const ids: string[] = [];
    for (const spec of ['a', 'b', 'c']) {
      const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec }, token));
      ids.push((created.data as { taskId: string }).taskId);
    }
    expect(envelope(await call('latte_dispatch', { taskId: ids[0] }, token)).ok).toBe(true);

    const view = (await b.service.getCoordinationRun(workId))!;
    expect(view.tasksInFlight).toBe(1);
    expect(view.tasksPending).toBe(2); // las dos que NUNCA salieron, y ninguna más
    expect(view.tasksDone).toBe(0);
    expect(view.tasksFailed).toBe(0);
    // Las cuatro cuentas parten el total sin superponerse ni perder nada.
    expect(view.tasksDone + view.tasksFailed + view.tasksInFlight + view.tasksPending).toBe(3);

    // Y cuando reporta, el vuelo se convierte en `done` y no reaparece en
    // ningún otro lado.
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === ids[0])!.memberId;
    const workerToken = b.coordinationTokens.mint(workId, memberId);
    expect(envelope(await call('latte_report', { taskId: ids[0], outcome: 'succeeded', summary: 'listo' }, workerToken)).ok).toBe(true);

    const after = (await b.service.getCoordinationRun(workId))!;
    expect(after.tasksInFlight).toBe(0);
    expect(after.tasksDone).toBe(1);
    expect(after.tasksPending).toBe(2);
  });
});
