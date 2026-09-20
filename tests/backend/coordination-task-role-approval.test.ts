import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * U10: la tarea de un rol que nadie contrató se rechaza AL CREARLA.
 *
 * `latte_plan_submit` y `latte_task_create` aceptaban cualquier `roleId` del
 * catálogo. La tarea nacía, se quedaba en la cola, y recién el despacho la
 * mataba con `role_not_approved`: una fila `failed` y una entrada de bitácora
 * por cada invención del coordinador, sobre un run que la persona aprobó con
 * otro equipo. El mismo lookup que ya usa el despacho —la foto de contratables
 * de la aprobación MÁS el equipo vivo de hoy— tiene que correr acá.
 *
 * Se entra por el protocolo real (`handleMcpRequest`), que es por donde entra
 * el agente coordinador.
 */
describe('crear una tarea de un rol que nadie aprobó', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let server: CoordinationMcpServer;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;
  let token: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  const call = (name: string, args: Record<string, unknown>) =>
    server.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    b.repo.insertMember({
      id: 'mem_coordinator', workId, roleId: 'role_coord', roleName: 'Coord', initial: 'C', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    members = [{ id: 'mem_coordinator', workId, roleId: 'role_coord', status: 'idle' }];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tokens = new CoordinationTokenRegistry();
    server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    const run = await engine.startRun(workId, 'mem_coordinator');
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = tokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  const taskCount = () => b.repo.listCoordinationTasks(runId).length;

  it('`latte_task_create` de un rol sin aprobar responde ROLE_NOT_APPROVED y no crea ni una tarea', async () => {
    const before = taskCount();

    const result = await call('latte_task_create', { roleId: 'role_z', spec: 'Algo que nadie aprobó' });

    expect(result.status).toBe(200);
    expect(envelope(result).ok).toBe(false);
    expect(envelope(result).error?.code).toBe('ROLE_NOT_APPROVED');
    expect(taskCount()).toBe(before);
  });

  it('`latte_task_create` de un rol APROBADO sigue funcionando', async () => {
    const result = await call('latte_task_create', { roleId: 'role_a', spec: 'Lo que sí se aprobó' });

    expect(envelope(result).ok).toBe(true);
    expect(taskCount()).toBe(1);
    expect(b.repo.listCoordinationTasks(runId)[0].roleId).toBe('role_a');
  });

  it('un rol que YA es miembro del Trabajo se acepta sin estar en la foto: no se contrata, se reutiliza', async () => {
    b.repo.insertMember({
      id: 'mem_present', workId, roleId: 'role_present', roleName: 'Presente', initial: 'P', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    members.push({ id: 'mem_present', workId, roleId: 'role_present', status: 'idle' });

    const result = await call('latte_task_create', { roleId: 'role_present', spec: 'Para quien ya está' });

    expect(envelope(result).ok).toBe(true);
    expect(taskCount()).toBe(1);
  });

  it('`latte_plan_submit` con un rol sin aprobar se rechaza ENTERO: ni la tarea válida que venía antes queda', async () => {
    const before = taskCount();

    const result = await call('latte_plan_submit', {
      tasks: [
        { roleId: 'role_a', spec: 'Esta sí' },
        { roleId: 'role_z', spec: 'Esta no' },
      ],
    });

    expect(result.status).toBe(200);
    expect(envelope(result).ok).toBe(false);
    expect(envelope(result).error?.code).toBe('ROLE_NOT_APPROVED');
    // Un plan a medias es peor que ninguno: la bitácora quedaría con la mitad
    // de un plan que el coordinador cree que mandó entero.
    expect(taskCount()).toBe(before);
  });

  it('`latte_plan_submit` con todos los roles aprobados crea las tareas', async () => {
    const result = await call('latte_plan_submit', { tasks: [{ roleId: 'role_a', spec: 'Una' }, { roleId: 'role_a', spec: 'Otra' }] });

    expect(envelope(result).ok).toBe(true);
    expect(taskCount()).toBe(2);
  });
});
