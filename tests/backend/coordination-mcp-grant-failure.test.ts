import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F12: resolver el grant estaba FUERA del try que convierte un fallo en un
 * sobre.
 *
 * `resolveGrant` lee la base (el run activo del Trabajo, el meta del
 * coordinador). Si esa lectura tira —la base bloqueada, un archivo corrupto—,
 * la excepción escapaba de `handleMcpRequest` entero y el transporte la
 * devolvía como HTTP 500: un cliente MCP lee un 500 como "el servidor está
 * roto", no como "esta llamada falló". Es exactamente el crítico que `wrap`
 * ya resolvió para las dos lecturas del sobre, una capa más arriba.
 */
describe('F12: un `resolveGrant` que falla sale como sobre, no como 500', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let workId: string;

  const listen: ListenFn = async () => ({ port: 4242, close: () => {} });

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tokens = new CoordinationTokenRegistry();
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('HTTP 200 con un `ok:false` que el agente puede leer', async () => {
    vi.spyOn(engine, 'resolveGrant').mockImplementation(() => { throw new Error('database is locked'); });
    const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
    const token = tokens.mint(workId, 'mem_x');

    const result = await server.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'latte_check', arguments: {} } }),
      `Bearer ${token}`, '127.0.0.1',
    );

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body) as { jsonrpc: string; id: number; result?: { isError: boolean; structuredContent: { ok: boolean; error?: { message: string } } } };
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result?.isError).toBe(true);
    expect(parsed.result?.structuredContent.ok).toBe(false);
    expect(parsed.result?.structuredContent.error?.message).toContain('database is locked');
  });
});
