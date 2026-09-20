import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { CoordinationMcpServer, MCP_TOOL_DEFINITIONS, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Crítico 4: un `null` rompía la interfaz de TODAS las marcas.
 *
 * El esquema publicado de `latte_request_coordination` permitía
 * `estimatedDispatches: null` y el motor no lo validaba, así que un agente
 * podía escribir un `budget_json` que `requireCoordinationBudget` rechaza.
 * A partir de ahí: la tira global de equipos activos —app-wide, de todas las
 * marcas— tiraba al mapear esa fila, y como `tools.ts` leía el bloque de
 * presupuesto FUERA de su propio try, toda llamada MCP posterior de ese
 * Trabajo escapaba como HTTP 500.
 *
 * Tres invariantes, una por capa:
 *  1. nunca se inserta un run con un presupuesto ilegible;
 *  2. un presupuesto ilegible es un error DE ESA llamada (HTTP 200), nunca un 500;
 *  3. una fila rota no tumba la lista: se marca, y las demás marcas se ven.
 */
describe('un presupuesto ilegible no tumba la tira de las demás marcas (crítico 4)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let server: CoordinationMcpServer;
  let members: FakeTeamMember[];
  let brandA: string;
  let brandB: string;
  let workA: string;
  let workB: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  function rpc(method: string, params?: unknown, id: number | string = 1): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
  }

  function toolEnvelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent?: unknown } };
    expect(parsed.result).toBeDefined();
    return parsed.result!.structuredContent as ReturnType<typeof toolEnvelope>;
  }

  function proposalWith(estimatedDispatches: unknown) {
    return {
      plan: [{ roleId: 'strategist', spec: 'Armar el plan del mes' }],
      estimatedDispatches,
      // Q6: con quién haga el rol. Sin el alta, `requestCoordination` la rechaza
      // por cumplibilidad y este test dejaría de medir el presupuesto ilegible.
      membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }],
      rationale: 'El pedido fue coordinar al equipo.',
    };
  }

  /** Una fila de run con `budget_json` ilegible, insertada directo por el repo. */
  function insertCorruptRun(workId: string, memberId: string): string {
    const now = '2026-01-01T00:00:00.000Z';
    const run = b.repo.insertCoordinationRun({
      id: 'crn_corrupt_row',
      workId,
      status: 'running',
      coordinatorMemberId: memberId,
      budgetJson: '{"maxDispatches": null}', // ni ilimitado confirmado ni entero: ilegible para el validador
      planJson: null,
      planApprovedAt: now,
      suspendReason: null,
      createdAt: now,
      updatedAt: now,
    });
    return run.id;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const a = await b.service.createBrand('Marca A');
    const bb = await b.service.createBrand('Marca B');
    brandA = a.id;
    brandB = bb.id;
    workA = (await b.service.createWork(brandA, 'Trabajo A')).id;
    workB = (await b.service.createWork(brandB, 'Trabajo B')).id;
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: b.repo.getWork(id).brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tokens = new CoordinationTokenRegistry();
    server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
  });
  afterEach(() => b.cleanup());

  // --- 1. nunca se inserta un run con un presupuesto ilegible -----------------

  describe('el handler valida antes de tocar la base', () => {
    // `null` era el caso que el esquema publicaba como legal. Los demás son
    // todo lo que un cliente MCP puede mandar contra un `integer` y que el
    // validador de presupuesto rechaza igual de fuerte.
    const rejected: Array<[string, unknown]> = [
      ['null', null],
      ['cero', 0],
      ['negativo', -1],
      ['fraccionario', 1.5],
      ['string', '3'],
      ['ausente', undefined],
    ];

    for (const [label, value] of rejected) {
      it(`${label}: la llamada JSON-RPC devuelve ok:false con código, y no queda ningún run nuevo`, async () => {
        const token = tokens.mint(workA, 'mem_proposer');
        const result = await server.handleMcpRequest(
          rpc('tools/call', { name: 'latte_request_coordination', arguments: proposalWith(value) }),
          `Bearer ${token}`,
          '127.0.0.1',
        );

        expect(result.status).toBe(200);
        const envelope = toolEnvelope(result);
        expect(envelope.ok).toBe(false);
        // R6: el rechazo llega UNA CAPA ANTES que antes. El esquema publicado
        // dice `integer, minimum 1`, y ahora `tools/call` lo hace cumplir, así
        // que estos seis valores mueren en la frontera con `INVALID_ARGUMENT`
        // en vez de llegar hasta el `VALIDATION` del motor. El código cambió;
        // la invariante que este test cuida —que la base quede intacta— no.
        expect(envelope.error?.code).toBe('INVALID_ARGUMENT');
        expect(envelope.error?.message).toContain('estimatedDispatches');
        // Lo que de verdad importa: la base quedó intacta.
        expect(b.repo.findActiveCoordinationRun(workA)).toBeNull();
        expect(b.repo.listActiveCoordinationRuns()).toEqual([]);
        // Y el motor SIGUE siendo la defensa de fondo: la frontera es la
        // primera puerta, no la única. Sin esto, mover la validación a la
        // frontera habría dejado al motor sin un solo test que lo cubra.
        await expect(engine.requestCoordination(
          { workId: workA, runId: null, memberId: 'mem_proposer', role: 'worker' },
          proposalWith(value) as never,
        )).rejects.toThrow(/estimatedDispatches/);
        expect(b.repo.listActiveCoordinationRuns()).toEqual([]);
      });
    }

    it('un entero positivo sigue entrando, con su run en planning', async () => {
      const token = tokens.mint(workA, 'mem_proposer');
      const result = await server.handleMcpRequest(
        rpc('tools/call', { name: 'latte_request_coordination', arguments: proposalWith(8) }),
        `Bearer ${token}`,
        '127.0.0.1',
      );

      expect(toolEnvelope(result).ok).toBe(true);
      expect(b.repo.findActiveCoordinationRun(workA)?.status).toBe('planning');
    });

    it('el esquema publicado ya no ofrece `null` como valor legal de estimatedDispatches', () => {
      const tool = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_request_coordination');
      expect(tool).toBeDefined();
      const properties = (tool!.inputSchema as { properties: Record<string, { type: unknown; minimum?: number }> }).properties;
      expect(properties.estimatedDispatches.type).toBe('integer');
      expect(properties.estimatedDispatches.minimum).toBe(1);
    });
  });

  // --- 2. un presupuesto ilegible es un error de ESA llamada, no un 500 -------

  describe('una fila rota no convierte las llamadas MCP siguientes en HTTP 500', () => {
    it('latte_check sobre un run con budget_json ilegible responde 200 con ok:false', async () => {
      insertCorruptRun(workA, 'mem_worker');
      const token = tokens.mint(workA, 'mem_worker');

      const result = await server.handleMcpRequest(
        rpc('tools/call', { name: 'latte_check', arguments: {} }),
        `Bearer ${token}`,
        '127.0.0.1',
      );

      expect(result.status).toBe(200);
      expect(toolEnvelope(result).ok).toBe(false);
    });

    it('latte_dispatch sobre ese mismo run responde 200 con ok:false y una razón nombrada, no una excepción opaca', async () => {
      const runId = insertCorruptRun(workA, 'mem_coordinator');
      b.repo.insertMember({ id: 'mem_coordinator', workId: workA, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      members.push({ id: 'mem_coordinator', workId: workA, roleId: 'strategist', status: 'idle' });
      await b.service.setCoordinatorGrant(workA, 'mem_coordinator');
      const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Hacer algo' });
      const token = tokens.mint(workA, 'mem_coordinator');

      const result = await server.handleMcpRequest(
        rpc('tools/call', { name: 'latte_dispatch', arguments: { taskId: task.id } }),
        `Bearer ${token}`,
        '127.0.0.1',
      );

      expect(result.status).toBe(200);
      const envelope = toolEnvelope(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('COORDINATION_BUDGET_INVALID');
      expect(b.hub.send).not.toHaveBeenCalled();
    });
  });

  // --- 3. la tira global tolera la fila rota ----------------------------------

  describe('la tira global de equipos activos lista las demás marcas igual', () => {
    it('la marca A con budget_json ilegible aparece marcada, y la marca B sana se lista normal', async () => {
      insertCorruptRun(workA, 'mem_worker');
      await b.service.setCoordinationBudget(workB, { maxDispatches: 5 });
      await engine.startRun(workB, null);

      const rows = await b.service.listActiveCoordinationRuns();

      expect(rows).toHaveLength(2);
      const rowA = rows.find((r) => r.brandId === brandA);
      const rowB = rows.find((r) => r.brandId === brandB);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      // La marca rota se DECLARA rota; no se disfraza de "sin tope".
      expect(rowA!.budgetInvalid).toBe(true);
      expect(rowA!.maxDispatches).toBeNull();
      // Y la marca sana sigue viéndose entera: una fila ilegible no es una
      // pantalla vacía para todo el mundo.
      expect(rowB!.budgetInvalid).toBe(false);
      expect(rowB!.maxDispatches).toBe(5);
      expect(rowB!.workTitle).toBe('Trabajo B');
    });
  });
});
