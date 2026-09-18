import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import {
  CoordinationInjectionPlanner,
  type CoordinationInjectionDeps,
  type MemberInjectionInput,
} from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { sessionFrom } from '../../electron/agents/types';
import { fakeCoordinationHub, fakeRunner, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Task 8.1 (rollout gate): coordination lives behind `featureFlags('coordination')`.
 *
 * Two corrections carried over from the tasks-doc addendum, both load-bearing
 * for how this file reads:
 * - No flag mechanism existed for coordination before this task. The generic
 *   one (`electron/core/features.ts`, `generation`/`brandKits`/`learning`,
 *   off by default) already existed -- this task extends it, it does not
 *   invent a parallel mechanism.
 * - "Zero behaviour change with the flag off" means zero COORDINATION
 *   behaviour change. Engram injection (task 6.29, `latte/mcp-y-engram-por-defecto`)
 *   ships BY DEFAULT, flag on or off -- a test asserting literal zero
 *   injection with the flag off would contradict that product decision.
 *   Every describe below that turns the flag off also asserts memory
 *   survives it.
 */

function claudeAndEngramResolvable(claudeVersion = '2.1.263') {
  return fakeRunner((file, args) => {
    if (args[0] === 'claude') return { code: 0, stdout: 'C:\\fake\\claude.exe\r\n' };
    if (file.endsWith('claude.exe') && args[0] === '--version') return { code: 0, stdout: claudeVersion };
    if (args[0] === 'engram') return { code: 0, stdout: 'C:\\fake\\engram.exe\r\n' };
    return { code: 1, stdout: '', stderr: 'not found' };
  });
}

// -- CoordinationEngine: the two entry points that can ever create a run ----
// (`startRun`, IPC-facing; `requestCoordination`, the conversational entry).
// Every OTHER coordination surface (report/check/ask/settle/gates) already
// requires an active run (task 6.3's NO_ACTIVE_RUN guard) -- with these two
// gated, nothing downstream is reachable either, by construction.

describe('CoordinationEngine — isCoordinationEnabled gates run creation (task 8.1)', () => {
  let b: TestBackend;
  let workId: string;
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    brandId = brand.id;
    fakeCoordinationHub(b, [] as FakeTeamMember[]);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
  });
  afterEach(() => b.cleanup());

  function engineWith(enabled?: boolean): CoordinationEngine {
    return new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      ...(enabled === undefined ? {} : { isCoordinationEnabled: () => enabled }),
    });
  }

  it('startRun rejects FEATURE_DISABLED when disabled, and writes no run row', async () => {
    const engine = engineWith(false);
    await expect(engine.startRun(workId, null)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('requestCoordination rejects FEATURE_DISABLED when disabled, and writes no run row (no proposal gate can ever appear)', async () => {
    const engine = engineWith(false);
    const grant: CoordinationGrant = { workId, runId: null, memberId: 'mem_proposer', role: 'worker' };
    await expect(
      engine.requestCoordination(grant, {
        plan: [{ roleId: 'strategist', spec: 'Draft the brief' }],
        estimatedDispatches: 3,
        rationale: 'x',
      }),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
    expect(b.hub.send).not.toHaveBeenCalled();
  });

  it('omitting the dep defaults to enabled -- every pre-8.1 direct-engine test (Phases 1-7) stays valid unchanged', async () => {
    const engine = engineWith(undefined);
    const run = await engine.startRun(workId, null);
    expect(run.status).toBe('running');
  });

  it('an explicit true behaves identically to the default', async () => {
    const engine = engineWith(true);
    const run = await engine.startRun(workId, null);
    expect(run.status).toBe('running');
  });
});

// -- CoordinationInjectionPlanner: no coordination server, memory unaffected --

function makePlanner(opts: {
  isCoordinationEnabled?: () => boolean;
  engramBinary?: string | null;
  hasActiveRun?: boolean;
} = {}) {
  const tokens = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
  const server = {
    ensureStarted: vi.fn(async () => {}),
    stopIfIdle: vi.fn(),
    boundPort: 55555,
  };
  const deps: CoordinationInjectionDeps = {
    repo: { findActiveCoordinationRun: () => (opts.hasActiveRun ? ({} as never) : null) },
    tokens,
    server,
    resolveClaudeVersion: async () => '2.1.263',
    resolveEngramBinary: async () => (opts.engramBinary === undefined ? '/usr/bin/engram' : opts.engramBinary),
    ...(opts.isCoordinationEnabled ? { isCoordinationEnabled: opts.isCoordinationEnabled } : {}),
  };
  return { planner: new CoordinationInjectionPlanner(deps), tokens, server };
}

function member(over: Partial<MemberInjectionInput> = {}): MemberInjectionInput {
  return { memberId: 'mem_1', workId: 'wrk_1', brandId: 'brd_1', runtime: 'claude', accountId: null, ...over };
}

describe('CoordinationInjectionPlanner — flag off: no coordination server, memory still injected (task 8.1)', () => {
  it('a Claude member above the floor gets ONLY latte_memory, never latte_coordination, and the server never starts', async () => {
    const { planner, server } = makePlanner({ isCoordinationEnabled: () => false });
    const { servers, status } = await planner.assign(member({ runtime: 'claude' }));
    expect(servers?.some((s) => s.kind === 'http')).toBe(false);
    expect(servers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
    expect(status).toMatchObject({ coordinationInjected: false, canPropose: false, memoryInjected: true });
    expect(server.ensureStarted).not.toHaveBeenCalled();
  });

  it('a Codex member with an active run and room under every ceiling still gets ONLY latte_memory, never latte_coordination', async () => {
    const { planner, server } = makePlanner({ isCoordinationEnabled: () => false, hasActiveRun: true });
    const { servers, status } = await planner.assign(member({ runtime: 'codex' }));
    expect(servers?.some((s) => s.kind === 'http')).toBe(false);
    expect(servers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
    expect(status.coordinationInjected).toBe(false);
    expect(server.ensureStarted).not.toHaveBeenCalled();
  });

  it('flag off AND engram missing: no server at all -- the reason stays honestly about memory, never invents a coordination-flag reason', async () => {
    const { planner } = makePlanner({ isCoordinationEnabled: () => false, engramBinary: null });
    const { servers, status } = await planner.assign(member({ runtime: 'claude' }));
    expect(servers).toBeUndefined();
    expect(status).toMatchObject({ coordinationInjected: false, memoryInjected: false, reason: 'engram_not_installed' });
  });

  it('omitting the dep defaults to enabled -- the pre-8.1 behaviour (task 6.29 headline) is unchanged', async () => {
    const { planner } = makePlanner({ hasActiveRun: true });
    const { servers, status } = await planner.assign(member({ runtime: 'claude' }));
    expect(status.coordinationInjected).toBe(true);
    expect(servers?.some((s) => s.kind === 'http')).toBe(true);
  });
});

// -- Real production wiring: bootstrap.ts reads the actual meta flag --------

describe('LatteService — real bootstrap wiring: the flag gates the run/proposal path end to end (task 8.1)', () => {
  let b: TestBackend;
  afterEach(() => b?.cleanup());

  it('a fresh install (flag unset) cannot start a run, but the Claude member above the floor still gets engram', async () => {
    b = await makeBackend({ runner: claudeAndEngramResolvable() });
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });

    await expect(b.service.startCoordinationRun(work.id)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(await b.service.getCoordinationRun(work.id)).toBeNull();
    expect(await b.service.listActiveCoordinationRuns()).toEqual([]);

    vi.spyOn(b.claude, 'start').mockImplementation(async (input) => ({
      session: sessionFrom(input, 'claude', input.model ?? null, input.accountId ?? null, input.label, false),
      runtimeSessionId: 'sess_fake',
    }));
    await b.service.addTeamMember(work.id, 'strategist', { runtime: 'claude' });

    const rows = await b.service.coordinationRuntimeSupport(work.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].canPropose).toBe(false);
    expect(rows[0].memoryInjected).toBe(true); // engram ships regardless of the flag (task 6.29)
  });

  it('flipping feature:coordination on restores the run path exactly as Phases 1-7 built it', async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);

    const run = await b.service.startCoordinationRun(work.id);
    expect(run.status).toBe('running');
  });
});
