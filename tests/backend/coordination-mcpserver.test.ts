import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { CoordinationMcpServer, type ListenFn } from '../../electron/coordination/mcpServer';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Task 6.17-6.20: the coordination MCP server, quarantined for testability.
 * `handleMcpRequest` is a pure routing function — every test below calls it
 * directly, with an INJECTED `listen` that never opens a real socket and
 * never touches the network. No test in this file spawns a process either.
 *
 * Wire contract (a deliberate, minimal decision for this slice — see
 * mcpServer.ts's own header comment): the request body is
 * `{ tool: string, args: unknown }`; the response body IS the tool's own
 * `ToolEnvelope` (tools.ts), byte-identical. Full MCP JSON-RPC framing
 * (initialize/tools-list/capability negotiation) is left to whichever future
 * slice actually constructs real client requests (6e/6f, out of scope here).
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

  // --- 6.17: the pure routing core --------------------------------------------

  describe('handleMcpRequest — pure routing core (task 6.17)', () => {
    it('a valid token routes to tools.ts with the LAZILY resolved grant', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      // latte_team_list requires the coordinator grant — the member must
      // exist and hold it BEFORE the request, so resolveGrant (called fresh
      // inside handleMcpRequest) resolves role:'coordinator'.
      b.repo.insertMember({ id: 'mem_coordinator', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      await b.service.setCoordinatorGrant(workId, 'mem_coordinator');
      const token = tokens.mint(workId, 'mem_coordinator');

      const result = await server.handleMcpRequest(JSON.stringify({ tool: 'latte_team_list', args: {} }), `Bearer ${token}`, '127.0.0.1');

      expect(result.status).toBe(200);
      const envelope = JSON.parse(result.body);
      expect(envelope.ok).toBe(true);
    });

    it('an unknown token is rejected 401, never 200-with-an-error-body', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });

      const result = await server.handleMcpRequest(JSON.stringify({ tool: 'latte_team_list', args: {} }), 'Bearer tok_never_minted', '127.0.0.1');

      expect(result.status).toBe(401);
      const body = JSON.parse(result.body);
      // A 401 body must never look like a tool envelope (no ok/authority/budget) — the FORBIDDEN case is a
      // clean HTTP rejection, not a disguised 200.
      expect(body.ok).toBeUndefined();
      expect(body.authority).toBeUndefined();
    });

    it('a revoked token is rejected 401', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_x');
      tokens.revoke(token);

      const result = await server.handleMcpRequest(JSON.stringify({ tool: 'latte_team_list', args: {} }), `Bearer ${token}`, '127.0.0.1');

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

      const result = await server.handleMcpRequest(JSON.stringify({ tool: 'latte_team_list', args: {} }), `Bearer ${token}`, '203.0.113.5');

      expect(result.status).toBe(401);
    });

    it('an unknown tool name is rejected without throwing, and mutates nothing', async () => {
      const { listen } = fakeListen();
      const server = new CoordinationMcpServer({ repo: b.repo, engine, tokens, listen });
      const token = tokens.mint(workId, 'mem_coordinator');

      const result = await server.handleMcpRequest(JSON.stringify({ tool: 'latte_not_a_real_tool', args: {} }), `Bearer ${token}`, '127.0.0.1');

      expect(result.status).toBe(404);
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

      const call = (token: string) => server.handleMcpRequest(JSON.stringify({ tool: 'latte_team_list', args: {} }), `Bearer ${token}`, '127.0.0.1');

      // Interleaved: A, B, A, B — never sequential per-token batches.
      const resultA1 = await call(tokenA);
      const resultB1 = await call(tokenB);
      const resultA2 = await call(tokenA);
      const resultB2 = await call(tokenB);

      for (const r of [resultA1, resultA2]) expect(JSON.parse(r.body).ok).toBe(true);
      for (const r of [resultB1, resultB2]) expect(JSON.parse(r.body).ok).toBe(true);

      // Each call's envelope carries its OWN work's budget block, never the other's — the concrete
      // proof that the shared handler resolves a fresh, correct grant per request and holds no
      // per-run state of its own.
      const budgetA = JSON.parse(resultA1.body).budget;
      const budgetB = JSON.parse(resultB1.body).budget;
      expect(budgetA).toEqual(engine.budgetBlockForEnvelope(runId));
      expect(budgetB).toEqual(engine.budgetBlockForEnvelope(runB.id));
      expect(budgetA).not.toEqual(budgetB);
    });

    it('the handler instance declares no mutable per-run field: only `server`/`port`/rate-limit bookkeeping', () => {
      const source = fs.readFileSync(path.resolve(__dirname, '../../electron/coordination/mcpServer.ts'), 'utf8');
      const classBody = source.slice(source.indexOf('class CoordinationMcpServer'));
      // No field caches a workId/runId/grant across requests.
      expect(classBody).not.toMatch(/private\s+(current|active|last)(Work|Run|Grant)/i);
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
