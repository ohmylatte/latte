import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * E1: LA AUDIENCIA SE DECLARA EN LA TAREA, NO SE ADIVINA.
 *
 * El caso real (2026-09-25): el equipo le entregó a la clienta un documento
 * analítico —rótulos internos, 18 pedidos numerados, notas para la agencia—
 * porque nada distinguía "esto es para nosotros" de "esto lo lee el cliente
 * para decidir". Cada tarea dice ahora para quién es: `internal` (el default)
 * o `client`. Lo decide el coordinador al proponer; la persona lo cambia al
 * editar la propuesta.
 */

type Envelope = { ok: boolean; data: unknown; error?: { code: string; message: string } };

describe('E1: `audience` en las tres herramientas que crean tareas', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;
  let send: ReturnType<typeof fakeCoordinationHub>['send'];

  const call = async (name: string, args: unknown): Promise<Envelope> => {
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 50 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members = [];
    send = fakeCoordinationHub(b, members).send;
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_writer', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el esquema publicado lo ofrece en las tres, opcional y cerrado a internal/client', () => {
    const planSubmit = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_plan_submit')!;
    const items = (planSubmit.inputSchema as { properties: { tasks: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.tasks.items;
    expect(items.properties.audience).toMatchObject({ type: 'string', enum: ['internal', 'client'] });
    expect(items.required).not.toContain('audience');
    const taskCreate = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_task_create')!;
    expect((taskCreate.inputSchema as { properties: Record<string, unknown> }).properties.audience).toMatchObject({ enum: ['internal', 'client'] });
    const request = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_request_coordination')!;
    const planItems = (request.inputSchema as { properties: { plan: { items: { properties: Record<string, unknown> } } } }).properties.plan.items;
    expect(planItems.properties.audience).toMatchObject({ enum: ['internal', 'client'] });
    // Y la descripción dice para qué sirve: el coordinador lo decide.
    for (const tool of [planSubmit, taskCreate, request]) expect(tool.description).toContain('`audience`');
  });

  it('sin audiencia, la tarea es interna; con `client`, se guarda y la lista la devuelve', async () => {
    expect((await call('latte_plan_submit', { tasks: [
      { roleId: 'role_a', title: 'Análisis de canales', spec: 'Analizá los canales.' },
      { roleId: 'role_a', title: 'Propuesta para Vane', spec: 'Escribí la propuesta.', audience: 'client' },
    ] })).ok).toBe(true);
    const [internal, client] = b.repo.listCoordinationTasks(runId);
    expect(internal!.audience).toBe('internal');
    expect(client!.audience).toBe('client');
    const views = await b.service.listCoordinationTasks(runId);
    expect(views.map((v) => v.audience)).toEqual(['internal', 'client']);
  });

  it('`latte_task_create` también la acepta', async () => {
    const created = await call('latte_task_create', { roleId: 'role_a', spec: 'La propuesta.', audience: 'client' });
    expect(created.ok).toBe(true);
    expect(b.repo.getCoordinationTask((created.data as { taskId: string }).taskId).audience).toBe('client');
  });

  it('un valor fuera de la lista se rechaza en la frontera del esquema y no escribe nada', async () => {
    const rejected = await call('latte_plan_submit', { tasks: [{ roleId: 'role_a', spec: 'x', audience: 'cliente' }] });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_ARGUMENT');
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0);
  });

  it('el despacho de una tarea para el cliente se lo dice al miembro', async () => {
    const created = await call('latte_task_create', { roleId: 'role_a', spec: 'La propuesta.', audience: 'client' });
    const taskId = (created.data as { taskId: string }).taskId;
    expect((await call('latte_dispatch', { taskId })).ok).toBe(true);
    const prompt = String(send.mock.calls.at(-1)![1]);
    expect(prompt).toMatch(/Audience: the client/);
    // Y una interna no lleva la línea: lo interno no necesita adorno.
    const internal = await call('latte_task_create', { roleId: 'role_a', spec: 'Un análisis.' });
    members.find((m) => m.id === 'mem_writer')!.status = 'idle';
    await b.service.settleCoordinationDispatch(taskId, 'succeeded', 'listo');
    expect((await call('latte_dispatch', { taskId: (internal.data as { taskId: string }).taskId })).ok).toBe(true);
    expect(String(send.mock.calls.at(-1)![1])).not.toMatch(/Audience:/);
  });

  it('la migración es idempotente: correrla otra vez no rompe ni duplica la columna', () => {
    b.repo.migrate();
    b.repo.migrate();
    const columns = (b.repo as unknown as { db: { all<T>(sql: string): T[] } }).db
      .all<{ name: string }>("SELECT name FROM pragma_table_info('coordination_task')").map((c) => c.name);
    expect(columns.filter((c) => c === 'audience')).toHaveLength(1);
  });
});

describe('E1: la propuesta trae la audiencia y la persona la cambia al editarla', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    fakeCoordinationHub(b, members);
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_writer', workId, roleId: 'role_a', status: 'idle' });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  const propose = async () => {
    const run = await b.service.coordinationEngine.requestCoordination(
      { workId, runId: null, memberId: 'mem_coordinator', role: 'worker' },
      {
        plan: [
          { roleId: 'role_a', title: 'Análisis', spec: 'Analizá.' },
          { roleId: 'role_a', title: 'Propuesta para Vane', spec: 'Escribí.', audience: 'client' },
        ],
        estimatedDispatches: 4,
        rationale: 'Propuesta mayorista',
      },
    );
    return run.id;
  };

  it('aprobada tal cual, cada tarea nace con la audiencia que propuso el coordinador', async () => {
    const runId = await propose();
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    expect(b.repo.listCoordinationTasks(runId).map((t) => t.audience)).toEqual(['internal', 'client']);
  });

  it('editada por la persona, manda lo que la persona eligió', async () => {
    const runId = await propose();
    const edited = JSON.parse(b.repo.getCoordinationRun(runId).planJson!) as { plan: Array<{ audience?: string }> };
    edited.plan[0]!.audience = 'client';
    edited.plan[1]!.audience = 'internal';
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve', JSON.stringify(edited));
    await settle();
    expect(b.repo.listCoordinationTasks(runId).map((t) => t.audience)).toEqual(['client', 'internal']);
  });

  it('una audiencia inválida en la propuesta editada se rechaza', async () => {
    const runId = await propose();
    const edited = JSON.parse(b.repo.getCoordinationRun(runId).planJson!) as { plan: Array<{ audience?: string }> };
    edited.plan[0]!.audience = 'todos';
    await expect(b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve', JSON.stringify(edited))).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
