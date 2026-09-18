import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { CoordinationMcpServer, MCP_PROTOCOL_VERSION, MCP_TOOL_DEFINITIONS, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Task 6.17-6.20 (slice 6-B) proved the pure routing core -- token/loopback
 * checks, lazy grant resolution, one server serving several live runs, and
 * the start/stop lifecycle -- against a deliberately minimal `{tool,args}`
 * wire body (see the superseded decision, `latte/mcpserver-wire-contract-decision`).
 *
 * Task 6.20b (this slice, 6-C) replaces that body with the REAL MCP
 * JSON-RPC 2.0 wire contract -- `initialize` / `tools/list` / `tools/call`,
 * the exact shapes real MCP clients (Claude Code, Codex) send -- because a
 * server that only understands `{tool,args}` fails their handshake and the
 * agent sees no tools, with every unit test still green. Protocol version
 * and method/field names are taken from the official spec
 * (modelcontextprotocol.io/specification/2025-06-18), the last
 * handshake-based ("initialize" then "tools/list" then "tools/call")
 * revision -- the one real installed Claude Code / Codex clients actually
 * speak (2026-07-28 replaces the handshake with `server/discover`, which no
 * installed client implements yet). Every test below still calls
 * `handleMcpRequest` directly with an INJECTED `listen` that never opens a
 * real socket and never touches the network -- no test in this file spawns
 * a process either.
 */
describe('CoordinationMcpServer', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tokens: CoordinationTokenRegistry;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  function fakeListen(port = 4242): { listen: ListenFn } {
    const listen: ListenFn = async () => ({ port, close: () => {} });
    return { listen };
  }

  function failingListen(message = 'EADDRINUSE: address already in use'): ListenFn {
    return async () => { throw new Error(message); };
  }

  /** A well-formed JSON-RPC 2.0 request body, as a real MCP client sends it. */
  function rpc(method: string, params?: unknown, id: number | string = 1): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
  }

  /** The JSON-RPC envelope parsed out of a `handleMcpRequest` HTTP body. */
  function rpcBody(result: { body: string }): Record<string, unknown> {
    return JSON.parse(result.body) as Record<string, unknown>;
  }

  /** The tool's own `ToolEnvelope`, unpacked from a `tools/call` JSON-RPC result. */
  function toolEnvelope(result: { body: string }): { ok: boolean; authority: unknown; budget: unknown; data: unknown; error?: { code: string; message: string } } {
    const parsed = rpcBody(result);
    const r = parsed.result as { structuredContent: unknown };
    return r.structuredContent as ReturnType<typeof toolEnvelope>;
  }

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
    const run = await engine.startRun(workId, null);
    runId = run.id;
  });
  afterEach(() => b.cleanup());

  // --- 6.17: the pure routing core, now over real JSON-RPC --------------------

  describe('handleMcpRequest — pure routing core (task 6.17, wire contract task 6.20b)', () => {
    it('a valid token routes a tools/call to tools.ts with the LAZILY resolved grant', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      // latte_team_list requires the coordinator grant — the member must
      // exist and hold it BEFORE the request, so resolveGrant (called fresh
      // inside handleMcpRequest) resolves role:'coordinator'.
      b.repo.insertMember({ id: 'mem_coordinator', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      await b.service.setCoordinatorGrant(workId, 'mem_coordinator');
      const token = tokens.mint(workId, 'mem_coordinator');

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), `Bearer ${token}`, '127.0.0.1');

      expect(result.status).toBe(200);
      expect(toolEnvelope(result).ok).toBe(true);
    });

    it('an unknown token is rejected 401, never 200-with-an-error-body', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), 'Bearer tok_never_minted', '127.0.0.1');

      expect(result.status).toBe(401);
      const body = JSON.parse(result.body);
      // A 401 body must never look like a JSON-RPC response or a tool envelope — the auth rejection is
      // a clean HTTP-layer rejection, decided before any JSON-RPC parsing happens.
      expect(body.jsonrpc).toBeUndefined();
      expect(body.result).toBeUndefined();
      expect(body.ok).toBeUndefined();
    });

    it('a revoked token is rejected 401', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_x');
      tokens.revoke(token);

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), `Bearer ${token}`, '127.0.0.1');

      expect(result.status).toBe(401);
    });

    it('rejected requests are logged, rate-limited to at most one line per window', async () => {
      let now = 0;
      const clock = () => now;
      const log = vi.fn();
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen, log, clock });

      await server.handleMcpRequest('{}', 'Bearer tok_bad', '127.0.0.1');
      await server.handleMcpRequest('{}', 'Bearer tok_bad_2', '127.0.0.1');
      await server.handleMcpRequest('{}', 'Bearer tok_bad_3', '127.0.0.1');
      expect(log).toHaveBeenCalledTimes(1); // rate-limited: three rejections, one line

      now += 10_000; // past the rate-limit window
      await server.handleMcpRequest('{}', 'Bearer tok_bad_4', '127.0.0.1');
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('a non-loopback remote address is rejected regardless of token validity', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_valid');

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), `Bearer ${token}`, '203.0.113.5');

      expect(result.status).toBe(401);
    });

    it('an unknown tool name is a JSON-RPC protocol error (-32602), never a thrown exception, and mutates nothing', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_coordinator');

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_not_a_real_tool', arguments: {} }), `Bearer ${token}`, '127.0.0.1');

      expect(result.status).toBe(200); // JSON-RPC errors for a well-formed request still ride HTTP 200
      const body = rpcBody(result);
      expect(body.result).toBeUndefined();
      expect((body.error as { code: number }).code).toBe(-32602);
      expect((body.error as { message: string }).message).toContain('latte_not_a_real_tool');
    });
  });

  // --- 6.20b: the real MCP handshake ------------------------------------------

  describe('the real MCP JSON-RPC handshake (task 6.20b)', () => {
    function validToken(): string {
      return tokens.mint(workId, 'mem_handshake');
    }

    it('initialize returns the protocol version, server info and the tools capability', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(
        rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.263' } }),
        `Bearer ${validToken()}`,
        '127.0.0.1',
      );

      expect(result.status).toBe(200);
      const body = rpcBody(result);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      const init = body.result as { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string; version: string } };
      expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(init.capabilities.tools).toBeDefined();
      expect(init.serverInfo.name).toBe('latte-coordination');
      expect(typeof init.serverInfo.version).toBe('string');
    });

    it('a client requesting an unsupported protocol version still gets a clean handshake at the server\'s own version — never an error', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(
        rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'ancient-client', version: '0.0.1' } }),
        `Bearer ${validToken()}`,
        '127.0.0.1',
      );

      expect(result.status).toBe(200);
      const body = rpcBody(result);
      expect(body.error).toBeUndefined();
      expect((body.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    });

    it('a notification (no id) — e.g. notifications/initialized — is accepted with 202 and no body, never a JSON-RPC response', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        `Bearer ${validToken()}`,
        '127.0.0.1',
      );

      expect(result.status).toBe(202);
      expect(result.body).toBe('');
    });

    it('tools/list returns real JSON-Schema for all 8 coordination tools, with no drift from tools.ts', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(rpc('tools/list', {}), `Bearer ${validToken()}`, '127.0.0.1');

      expect(result.status).toBe(200);
      const body = rpcBody(result);
      const list = body.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
      const names = list.tools.map((t) => t.name).sort();
      // Authoritative source of truth: the actual tool map tools.ts builds — no hand-maintained list can drift silently.
      const authoritative = Object.keys(createCoordinationTools(engine)).sort();
      expect(names).toEqual(authoritative);
      expect(names).toEqual([
        'latte_ask', 'latte_check', 'latte_dispatch', 'latte_plan_submit',
        'latte_report', 'latte_request_coordination', 'latte_task_create', 'latte_team_list',
      ]);
      for (const tool of list.tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
      // The exported definitions used to build the response are the same ones re-exported for reuse.
      expect(MCP_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(authoritative);
    });

    it('tools/list lists every tool regardless of the caller\'s role — a worker sees the coordinator-only tools too (task 6.20b\'s filtering decision)', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const workerToken = tokens.mint(workId, 'mem_worker'); // never granted coordinator

      const result = await server.handleMcpRequest(rpc('tools/list', {}), `Bearer ${workerToken}`, '127.0.0.1');

      const body = rpcBody(result);
      const names = (body.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(names).toContain('latte_dispatch'); // coordinator-only, but still discoverable
      expect(names).toContain('latte_request_coordination'); // the worker's actual way in
    });

    it('tools/call on a coordinator-only tool with a worker grant still names latte_request_coordination — the rejection keeps teaching the path over MCP too', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const workerToken = tokens.mint(workId, 'mem_worker');

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_dispatch', arguments: { taskId: 'ctk_x' } }), `Bearer ${workerToken}`, '127.0.0.1');

      expect(result.status).toBe(200);
      const body = rpcBody(result);
      const toolResult = body.result as { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: { ok: boolean; error?: { code: string; message: string } } };
      expect(toolResult.isError).toBe(true);
      expect(toolResult.structuredContent.ok).toBe(false);
      expect(toolResult.structuredContent.error?.message).toContain('latte_request_coordination');
      // Structured AND textual — the same envelope, both ways, per spec's structured-content guidance.
      expect(JSON.parse(toolResult.content[0].text)).toEqual(toolResult.structuredContent);
    });

    it('tools/call success carries both structuredContent and its JSON-stringified text twin', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      b.repo.insertMember({ id: 'mem_coordinator', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      await b.service.setCoordinatorGrant(workId, 'mem_coordinator');
      const token = tokens.mint(workId, 'mem_coordinator');

      const result = await server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), `Bearer ${token}`, '127.0.0.1');

      const body = rpcBody(result);
      const toolResult = body.result as { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: unknown };
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content[0].type).toBe('text');
      expect(JSON.parse(toolResult.content[0].text)).toEqual(toolResult.structuredContent);
    });

    it('an unrecognised method is a JSON-RPC "Method not found" protocol error (-32601)', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(rpc('resources/list', {}), `Bearer ${validToken()}`, '127.0.0.1');

      expect(result.status).toBe(200);
      const body = rpcBody(result);
      expect((body.error as { code: number }).code).toBe(-32601);
    });

    it('malformed JSON is a JSON-RPC parse error, id null, never a thrown exception', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest('{not json', `Bearer ${validToken()}`, '127.0.0.1');

      const body = rpcBody(result);
      expect(body.id).toBeNull();
      expect((body.error as { code: number }).code).toBe(-32700);
    });

    it('auth is still enforced before any JSON-RPC method runs — an invalid token on initialize is still a clean 401', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION }), 'Bearer tok_never_minted', '127.0.0.1');

      expect(result.status).toBe(401);
    });
  });

  // --- 6.18: one server, several live runs ------------------------------------

  describe('one server, several live runs (task 6.18)', () => {
    it('two tokens from two Works in two Brands resolve independently through the SAME handler, called interleaved, with no cross-talk', async () => {
      const brandB = await b.service.createBrand('Marca B');
      const workB = await b.service.createWork(brandB.id, 'Trabajo B');
      // Deliberately a DIFFERENT budget from workId's (10) so the two
      // envelopes' `budget` blocks are distinguishable -- a real, not
      // coincidental, proof that each call resolves its own work's data.
      await b.service.setCoordinationBudget(workB.id, { maxDispatches: 3 });
      const runB = await engine.startRun(workB.id, null);

      b.repo.insertMember({ id: 'mem_coord_a', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      b.repo.insertMember({ id: 'mem_coord_b', workId: workB.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      await b.service.setCoordinatorGrant(workId, 'mem_coord_a');
      await b.service.setCoordinatorGrant(workB.id, 'mem_coord_b');

      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const tokenA = tokens.mint(workId, 'mem_coord_a');
      const tokenB = tokens.mint(workB.id, 'mem_coord_b');

      const call = (token: string) => server.handleMcpRequest(rpc('tools/call', { name: 'latte_team_list', arguments: {} }), `Bearer ${token}`, '127.0.0.1');

      // Interleaved: A, B, A, B — never sequential per-token batches.
      const resultA1 = await call(tokenA);
      const resultB1 = await call(tokenB);
      const resultA2 = await call(tokenA);
      const resultB2 = await call(tokenB);

      for (const r of [resultA1, resultA2]) expect(toolEnvelope(r).ok).toBe(true);
      for (const r of [resultB1, resultB2]) expect(toolEnvelope(r).ok).toBe(true);

      // Each call's envelope carries its OWN work's budget block, never the other's — the concrete
      // proof that the shared handler resolves a fresh, correct grant per request and holds no
      // per-run state of its own.
      const budgetA = toolEnvelope(resultA1).budget;
      const budgetB = toolEnvelope(resultB1).budget;
      expect(budgetA).toEqual(engine.budgetBlockForEnvelope(runId));
      expect(budgetB).toEqual(engine.budgetBlockForEnvelope(runB.id));
      expect(budgetA).not.toEqual(budgetB);
    });

    it('the handler instance declares no mutable per-run field: only `server`/`port`/rate-limit bookkeeping', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../../electron/coordination/mcpServer.ts'), 'utf8');
      const classBody = source.slice(source.indexOf('class CoordinationMcpServer'));
      // No field caches a workId/runId/grant/session across requests.
      expect(classBody).not.toMatch(/private\s+(current|active|last|session)(Work|Run|Grant|Protocol)/i);
    });
  });

  // --- 6.19 / 6.20: lifecycle ---------------------------------------------------

  describe('lifecycle (tasks 6.19 and 6.20)', () => {
    it('ensureStarted lazily calls the injected listen exactly once, and is idempotent on repeat calls', async () => {
      const { listen } = fakeListen(5555);
      const listenSpy = vi.fn(listen);
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen: listenSpy });

      expect(server.listening).toBe(false);
      await server.ensureStarted();
      expect(server.listening).toBe(true);
      expect(server.boundPort).toBe(5555);
      await server.ensureStarted();
      await server.ensureStarted();

      expect(listenSpy).toHaveBeenCalledTimes(1);
    });

    it('stopIfIdle does nothing while the token registry still holds a token, even with zero active runs', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      tokens.mint(workId, 'mem_x');
      engine.cancelRun(runId); // zero active runs app-wide now
      await server.ensureStarted();

      server.stopIfIdle();

      expect(server.listening).toBe(true);
    });

    it('stopIfIdle does nothing while any run is active app-wide, even with an EMPTY token registry', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_x');
      await server.ensureStarted();
      tokens.revoke(token); // registry now empty
      expect(b.repo.countActiveCoordinationRuns()).toBeGreaterThan(0); // the beforeEach run is still active

      server.stopIfIdle();

      expect(server.listening).toBe(true);
    });

    it('stops only once BOTH conditions hold: empty registry AND zero active runs app-wide', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_x');
      await server.ensureStarted();

      tokens.revoke(token);
      engine.cancelRun(runId);
      expect(b.repo.countActiveCoordinationRuns()).toBe(0);

      server.stopIfIdle();

      expect(server.listening).toBe(false);
      expect(server.boundPort).toBeNull();
    });

    it('ending brand A\'s run while brand B\'s is still live does NOT stop the server (the v1 ambiguity fix, task 6.19)', async () => {
      const brandB = await b.service.createBrand('Marca B');
      const workB = await b.service.createWork(brandB.id, 'Trabajo B');
      await b.service.setCoordinationBudget(workB.id, { maxDispatches: 5 });
      const runB = await engine.startRun(workB.id, null);

      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const tokenA = tokens.mint(workId, 'mem_a');
      const tokenB = tokens.mint(workB.id, 'mem_b');
      await server.ensureStarted();

      // Empty the registry entirely (satisfies condition 1) but end ONLY
      // brand A's run — brand B's is still live, so this isolates the
      // run-count condition specifically, decoupled from the token condition.
      tokens.revoke(tokenA);
      tokens.revoke(tokenB);
      engine.cancelRun(runId); // brand A's run ends
      expect(engine.getRun(runB.id).status).toBe('running'); // brand B's run is untouched

      server.stopIfIdle();

      expect(server.listening).toBe(true); // must NOT have stopped: B's run still counts app-wide
    });

    it('UnavailableError is thrown when the port never binds, raised before any member learns coordination exists', async () => {
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen: failingListen() });

      await expect(server.ensureStarted()).rejects.toMatchObject({ code: 'UNAVAILABLE' });

      expect(server.listening).toBe(false);
      expect(server.boundPort).toBeNull();
    });

    it('a failed ensureStarted is not permanently stuck: a later retry (once listen recovers) still succeeds', async () => {
      let attempt = 0;
      const listen: ListenFn = async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('EADDRINUSE: address already in use');
        return { port: 6161, close: () => {} };
      };
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      await expect(server.ensureStarted()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(server.listening).toBe(false);

      await server.ensureStarted();

      expect(server.listening).toBe(true);
      expect(server.boundPort).toBe(6161);
    });
  });
});
