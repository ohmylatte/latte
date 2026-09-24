import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * N2: LA TAREA TIENE UN TÍTULO, y si el coordinador no lo manda, se deriva
 * del spec sin el bloque de contexto. Backend y renderer usan la MISMA
 * función (`shared/taskTitle`).
 */
const AYULEM = 'CONTEXTO. Ayulem Pastelería, cliente nuevo (arranque 2026-09-14). Hoy es 2026-09-24. Mes 1 prioriza el canal mayorista, '
  + 'la segmentación en Meta y un calendario de lanzamiento que no compita con las fiestas de fin de año ni con la temporada alta.\n\n'
  + 'Tarea: Estrategia de captación mayorista para Meta Ads';

describe('N2: `latte_plan_submit` acepta `title` por tarea', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;

  const call = async (name: string, args: unknown) => {
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: { ok: boolean } } }).result.structuredContent;
  };

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 50 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members = [];
    fakeCoordinationHub(b, members);
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el esquema publicado lo ofrece, opcional, y la descripción pide mandarlo', () => {
    const planSubmit = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_plan_submit')!;
    const items = (planSubmit.inputSchema as { properties: { tasks: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.tasks.items;
    expect(items.properties.title).toMatchObject({ type: 'string' });
    expect(items.required).not.toContain('title');
    expect(planSubmit.description).toContain('`title`');
    for (const name of ['latte_task_create', 'latte_request_coordination']) {
      expect(JSON.stringify(MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.inputSchema)).toContain('"title"');
    }
  });

  it('con título: se guarda y la lista lo devuelve', async () => {
    expect((await call('latte_plan_submit', { tasks: [{ roleId: 'role_a', title: 'Estrategia mayorista', spec: AYULEM }] })).ok).toBe(true);
    expect(b.repo.listCoordinationTasks(runId)[0]!.title).toBe('Estrategia mayorista');
    const [view] = await b.service.listCoordinationTasks(runId);
    expect(view!.title).toBe('Estrategia mayorista');
  });

  it('sin título: se deriva del spec ENTERO, saltando el CONTEXTO (el recorte de 200 no alcanza)', async () => {
    expect((await call('latte_plan_submit', { tasks: [{ roleId: 'role_a', spec: AYULEM }] })).ok).toBe(true);
    expect(b.repo.listCoordinationTasks(runId)[0]!.title).toBeNull();
    const [view] = await b.service.listCoordinationTasks(runId);
    expect(view!.spec.startsWith('CONTEXTO.')).toBe(true);
    expect(view!.title).toBe('Estrategia de captación mayorista para Meta Ads');
  });

  it('un título que no es texto se rechaza en la frontera del esquema', async () => {
    expect((await call('latte_plan_submit', { tasks: [{ roleId: 'role_a', title: 42, spec: 'x' }] })).ok).toBe(false);
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0);
  });
});
