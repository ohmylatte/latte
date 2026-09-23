import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F6, F7 y F8: las tres puertas por las que una tarea (o un gate) entraba sin
 * que nadie mirara el estado del run.
 *
 * F6. `latte_task_create` no chequeaba el estado del run. Con el permiso de
 *     coordinador escrito por IPC y un run todavía en `planning`, el agente
 *     colaba tareas que la persona NO leyó en la propuesta que está por
 *     aprobar. `latte_plan_submit` exige `running` desde siempre; esto no.
 * F7. `bridgeHandoffToTask` llamaba a `createTaskRow` directo, salteando
 *     `assertRoleCreatable`: la tarea nacía, el despacho moría con
 *     `ROLE_NOT_APPROVED`, quedaba una tarea `failed` en la bitácora y la
 *     excepción subía hasta la interfaz. El docstring promete degradar al
 *     borrador, y eso es lo que hace.
 * F8. `listGates` hacía `JSON.parse(run.planJson)` sin guarda sobre un run
 *     `planning`: una fila ilegible tumbaba la pantalla de Decisiones entera,
 *     justo donde está el único botón que puede sacarla de ahí.
 */
describe('F6/F7/F8: las puertas que no miraban el estado', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let dir: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    dir = path.join(b.dir, 'brands', brandId, 'works', workId);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => true,
    });
    tokens = new CoordinationTokenRegistry();
    b.repo.insertMember({
      id: 'mem_coordinator', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function planningRun(): Promise<string> {
    const run = await engine.requestCoordination(
      { workId, runId: null, memberId: 'mem_coordinator', role: 'worker' },
      {
        plan: [{ roleId: 'strategist', spec: 'Lo que la persona SÍ va a leer' }],
        estimatedDispatches: 5,
        rationale: 'Propongo coordinar.',
      },
    );
    return run.id;
  }

  it('F6: `latte_task_create` sobre un run en `planning` no crea nada', async () => {
    const runId = await planningRun();
    await b.service.setCoordinatorGrant(workId, 'mem_coordinator');
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const token = tokens.mint(workId, 'mem_coordinator');

    const result = await server.handleMcpRequest(
      rpc('latte_task_create', { roleId: 'strategist', spec: 'Lo que la persona NUNCA leyó' }),
      `Bearer ${token}`, '127.0.0.1',
    );

    const env = envelope(result);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('RUN_NOT_ACTIVE');
    expect(b.repo.listCoordinationTasks(runId)).toEqual([]);
  });

  it('F6: con el run `running` sigue creando tareas como siempre', async () => {
    const run = await engine.startRun(workId, null);
    approveCoordinationRoles(b, run.id, 'strategist');
    await b.service.setCoordinatorGrant(workId, 'mem_coordinator');
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const token = tokens.mint(workId, 'mem_coordinator');

    const result = await server.handleMcpRequest(
      rpc('latte_task_create', { roleId: 'strategist', spec: 'Trabajo legítimo' }),
      `Bearer ${token}`, '127.0.0.1',
    );

    expect(envelope(result).ok).toBe(true);
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(1);
  });

  it('F7: un handoff de un rol sin aprobar no se puentea, sin tarea ni excepción, y dice por qué', async () => {
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist'); // `analyst` NO
    fs.writeFileSync(path.join(dir, 'para-analyst.md'), '---\npara: analyst\n---\nMedí la campaña\n');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-analyst.md');

    // H1: el motivo viaja. Con la coordinación prendida no hay borrador al que caer.
    expect(result).toEqual({ bridged: false, task: null, outcome: null, reason: 'ROLE_NOT_APPROVED' });
    expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
    expect(b.repo.listCoordinationDispatches(run.id)).toEqual([]);
    // El pedido sigue sobre la mesa: no se consumió nada.
    expect(fs.existsSync(path.join(dir, 'para-analyst.md'))).toBe(true);
  });

  it('F8: un `plan_json` ilegible en `planning` no tumba la lista de decisiones', async () => {
    const runId = await planningRun();
    b.repo.setCoordinationPlan(runId, '{esto no es json', '2026-01-01T00:00:00.000Z');

    const gates = await b.service.listCoordinationGates(runId);

    const proposal = gates.find((g) => g.kind === 'proposal');
    expect(proposal).toBeDefined();
    // El JSON crudo viaja igual: es lo que hace que la UI dibuje la tarjeta
    // ilegible con su única acción, "Rechazar".
    expect(proposal!.proposalJson).toBe('{esto no es json');
    expect(proposal!.aggregate).toBeUndefined();
  });
});
