import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F4: lo que entra por MCP se valida como lo que entra por IPC.
 *
 * La propuesta EDITADA pasaba por `requireCoordinationProposal`; la ORIGINAL,
 * la que el agente manda con `latte_request_coordination`, no: sólo se miraba
 * `estimatedDispatches`. `mcpServer` no valida contra el `inputSchema` que
 * publica y `tools.ts` pasa `args` tal cual, así que `plan[].spec`,
 * `plan[].roleId`, `membersToHire[].why` y `rationale` se guardaban crudos en
 * `plan_json`. La tarjeta de Decisiones los renderiza como hijos de React, y
 * un objeto ahí tira "Objects are not valid as a React child": sin
 * ErrorBoundary, la app quedaba EN BLANCO con el run `planning` ocupando el
 * único cupo del Trabajo, o sea sin forma de rechazarlo.
 *
 * Se entra por la capa real: JSON-RPC `tools/call` sobre el servidor MCP.
 */
describe('F4: la propuesta original se valida antes de escribir el run', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let workId: string;
  let server: CoordinationMcpServer;
  let token: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined(); // nunca un error de protocolo ni un 500
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function goodProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      plan: [{ roleId: 'strategist', spec: 'Armar el plan del mes' }],
      estimatedDispatches: 8,
      membersToHire: [{ roleId: 'analyst', why: 'Nadie mide todavía' }],
      rationale: 'El pedido fue coordinar al equipo.',
      ...overrides,
    };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => true,
    });
    tokens = new CoordinationTokenRegistry();
    b.repo.insertMember({
      id: 'mem_proposer', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    token = tokens.mint(workId, 'mem_proposer');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('una propuesta con `rationale` objeto se rechaza y no escribe un solo run', async () => {
    const result = await server.handleMcpRequest(
      rpc('latte_request_coordination', goodProposal({ rationale: {} })),
      `Bearer ${token}`, '127.0.0.1',
    );

    expect(result.status).toBe(200);
    expect(envelope(result).ok).toBe(false);
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('una propuesta con `spec` objeto se rechaza y no escribe un solo run', async () => {
    const result = await server.handleMcpRequest(
      rpc('latte_request_coordination', goodProposal({ plan: [{ roleId: 'strategist', spec: {} }] })),
      `Bearer ${token}`, '127.0.0.1',
    );

    expect(envelope(result).ok).toBe(false);
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('un `why` objeto en un alta se rechaza: es lo único que la persona lee para aprobarla', async () => {
    const result = await server.handleMcpRequest(
      rpc('latte_request_coordination', goodProposal({ membersToHire: [{ roleId: 'analyst', why: { texto: 'x' } }] })),
      `Bearer ${token}`, '127.0.0.1',
    );

    expect(envelope(result).ok).toBe(false);
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('la propuesta bien formada sigue entrando igual', async () => {
    const result = await server.handleMcpRequest(rpc('latte_request_coordination', goodProposal()), `Bearer ${token}`, '127.0.0.1');

    expect(envelope(result).ok).toBe(true);
    expect(b.repo.findActiveCoordinationRun(workId)?.status).toBe('planning');
  });

  it('aprobar por IPC una propuesta guardada ilegible no contrata ni crea nada', async () => {
    await server.handleMcpRequest(rpc('latte_request_coordination', goodProposal()), `Bearer ${token}`, '127.0.0.1');
    const run = b.repo.findActiveCoordinationRun(workId)!;
    // La fila queda ilegible (una escrita por una versión sin validación, o
    // rota por cualquier otra razón). Aprobarla parseaba a ciegas.
    // Con `membersToHire` adentro a propósito: las contrataciones corren ANTES
    // de la transacción, así que sin este validador aprobar una propuesta
    // ilegible ya había spawneado gente cuando el parse ciego reventaba.
    b.repo.setCoordinationPlan(
      run.id,
      '{"plan":[{"roleId":"strategist","spec":{}}],"estimatedDispatches":8,"membersToHire":[{"roleId":"analyst","why":"x"}],"rationale":{}}',
      '2026-01-01T00:00:00.000Z',
    );
    const addMember = vi.spyOn(b.hub, 'addMember');

    await expect(b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve')).rejects.toThrow();

    expect(addMember).not.toHaveBeenCalled();
    expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('planning'); // sigue sobre la mesa, para rechazarla
  });

  it('rechazar una propuesta ilegible sigue siendo posible: es la única salida', async () => {
    await server.handleMcpRequest(rpc('latte_request_coordination', goodProposal()), `Bearer ${token}`, '127.0.0.1');
    const run = b.repo.findActiveCoordinationRun(workId)!;
    b.repo.setCoordinationPlan(run.id, '{no es json', '2026-01-01T00:00:00.000Z');

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'reject');

    expect(b.repo.getCoordinationRun(run.id).status).toBe('cancelled');
  });
});
