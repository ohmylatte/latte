import { describe, expect, it, vi } from 'vitest';
import type { CoordinationRunRecord } from '../../electron/storage/repository';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import {
  CoordinationInjectionPlanner,
  type CoordinationInjectionDeps,
  type MemberInjectionInput,
} from '../../electron/coordination/injection';
import {
  MAX_ACTIVE_COORDINATION_RUNS,
  MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK,
  MAX_CODEX_APP_SERVERS_TOTAL,
  MAX_COORDINATED_CODEX_MEMBERS_PER_RUN,
  MAX_COORDINATED_CODEX_PROCESSES,
} from '../../electron/coordination/limits';
import { mcpFingerprint } from '../../electron/agents/codex/mcpFingerprint';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult } from '../../electron/agents/types';
import { makeBackend } from './helpers';

// Tasks 6.28-6.32: the assembly logic hub wiring calls on every member
// open/close -- who gets `latte_coordination`, who gets `latte_memory`, and
// the app-wide Codex process ceilings that degrade one without ever starving
// the other. Tested directly against `CoordinationInjectionPlanner`, the
// module hub.ts's `open()`/`stop()`/`shutdown()` delegate to (see
// `tests/backend/hub-coordination-injection.test.ts` for proof hub actually
// wires it): this file is deliberately hub-free so the ceiling arithmetic is
// fast and precise, never touching a real adapter, socket or process.

function activeRun(workId: string): CoordinationRunRecord {
  return {
    id: 'crn_' + workId, workId, status: 'running', coordinatorMemberId: null,
    budgetJson: '{"maxDispatches":10}', planJson: null, planApprovedAt: null, suspendReason: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePlanner(opts: {
  activeRuns?: Set<string>;
  claudeVersion?: string | null;
  engramBinary?: string | null;
} = {}) {
  const tokens = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
  let port = 50999;
  const listenCalls: number[] = [];
  const server = {
    ensureStarted: vi.fn(async () => { listenCalls.push(1); }),
    stopIfIdle: vi.fn(),
    get boundPort() { return port; },
  };
  const deps: CoordinationInjectionDeps = {
    repo: { findActiveCoordinationRun: (workId: string) => (opts.activeRuns?.has(workId) ? activeRun(workId) : null) },
    tokens,
    server,
    resolveClaudeVersion: async () => (opts.claudeVersion === undefined ? '2.1.263' : opts.claudeVersion),
    resolveEngramBinary: async () => (opts.engramBinary === undefined ? '/usr/bin/engram' : opts.engramBinary),
  };
  return { planner: new CoordinationInjectionPlanner(deps), tokens, server };
}

function member(over: Partial<MemberInjectionInput> = {}): MemberInjectionInput {
  return { memberId: 'mem_1', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex', accountId: 'sys', ...over };
}

describe('CoordinationInjectionPlanner — mint for every member (task 6.28)', () => {
  it('mints a token for a member of a Work with NO run at all', async () => {
    const { planner, tokens } = makePlanner();
    expect(tokens.size).toBe(0);
    await planner.assign(member({ runtime: 'claude' }));
    expect(tokens.size).toBe(1);
  });

  it('mints even for a member that never receives the token (a second OpenCode member past its bootstrap slot)', async () => {
    const { planner, tokens } = makePlanner();
    await planner.assign(member({ runtime: 'opencode', memberId: 'mem_first' }));
    const { servers } = await planner.assign(member({ runtime: 'opencode', memberId: 'mem_second' }));
    expect(servers?.some((s) => s.kind === 'http')).toBe(false);
    expect(tokens.size).toBe(2); // minted, just never delivered to the second
  });

  it('release() revokes the token', async () => {
    const { planner, tokens } = makePlanner();
    await planner.assign(member({ runtime: 'claude' }));
    expect(tokens.size).toBe(1);
    planner.release('mem_1');
    expect(tokens.size).toBe(0);
  });

  it('a second mint for the same member replaces the first (reopen)', async () => {
    const { planner, tokens } = makePlanner();
    await planner.assign(member({ runtime: 'claude' }));
    await planner.assign(member({ runtime: 'claude' }));
    expect(tokens.size).toBe(1);
  });
});

describe('CoordinationInjectionPlanner — two INDEPENDENT injection policies (task 6.29)', () => {
  it('a Claude member of a Work with NO run and NO coordination flag still gets latte_memory', async () => {
    const { planner } = makePlanner({ activeRuns: new Set() });
    const { servers, status } = await planner.assign(member({ runtime: 'claude' }));
    expect(status.memoryInjected).toBe(true);
    expect(servers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
  });

  it('a Codex member with no run and no room for even the bootstrap slot still gets latte_memory, never latte_coordination', async () => {
    const { planner } = makePlanner({ activeRuns: new Set() });
    // Consume the one bootstrap slot for this Work first.
    await planner.assign(member({ memberId: 'mem_bootstrap' }));
    const { servers, status } = await planner.assign(member({ memberId: 'mem_2' }));
    expect(status.coordinationInjected).toBe(false);
    expect(status.reason).toBe('codex_run_cap');
    expect(status.memoryInjected).toBe(true);
    expect(servers?.some((s) => s.kind === 'http')).toBe(false);
    expect(servers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
  });

  it('the asymmetry is never reversed: no member ever carries coordination without memory when memory is available', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    const { servers } = await planner.assign(member());
    const kinds = servers?.map((s) => s.kind) ?? [];
    if (kinds.includes('http')) expect(kinds).toContain('stdio');
  });

  it('engram missing: coordination still works, memory is simply omitted (never a broken entry)', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']), engramBinary: null });
    const { servers, status } = await planner.assign(member());
    expect(status.coordinationInjected).toBe(true);
    expect(status.memoryInjected).toBe(false);
    expect(status.reason).toBe('engram_not_installed');
    expect(servers?.some((s) => s.kind === 'stdio')).toBe(false);
    expect(servers?.some((s) => s.kind === 'http')).toBe(true);
  });
});

describe('CoordinationInjectionPlanner — engram-only Codex members SHARE one process (task 6.30)', () => {
  it('two engram-only members of the SAME brand+account fingerprint identically', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    // Fill this Work's per-run coordination cap (3) with other members first,
    // so the next two genuinely degrade to memory-only rather than winning a
    // coordination slot themselves.
    await planner.assign(member({ memberId: 'mem_fill_1', accountId: 'acct_a' }));
    await planner.assign(member({ memberId: 'mem_fill_2', accountId: 'acct_b' }));
    await planner.assign(member({ memberId: 'mem_fill_3', accountId: 'acct_c' }));
    const b = await planner.assign(member({ memberId: 'mem_b', accountId: 'acct_x', brandId: 'brd_shared' }));
    const c = await planner.assign(member({ memberId: 'mem_c', accountId: 'acct_x', brandId: 'brd_shared' }));
    expect(b.status.coordinationInjected).toBe(false);
    expect(c.status.coordinationInjected).toBe(false);
    expect(b.status.memoryInjected).toBe(true);
    expect(c.status.memoryInjected).toBe(true);
    expect(mcpFingerprint(b.servers)).toBe(mcpFingerprint(c.servers));
  });

  it('a coordination-injected member (unique token) never shares a fingerprint with a memory-only member', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    const coordinated = await planner.assign(member({ memberId: 'mem_coord', accountId: 'acct_x' }));
    // Fill the per-run cap so the next same-account member degrades to memory-only.
    await planner.assign(member({ memberId: 'mem_coord2', accountId: 'acct_x' }));
    await planner.assign(member({ memberId: 'mem_coord3', accountId: 'acct_x' }));
    const memoryOnly = await planner.assign(member({ memberId: 'mem_memory_only', accountId: 'acct_x' }));
    expect(memoryOnly.status.coordinationInjected).toBe(false);
    expect(mcpFingerprint(coordinated.servers)).not.toBe(mcpFingerprint(memoryOnly.servers));
  });

  it('MAX_CODEX_APP_SERVERS_TOTAL = 10 across both kinds, degrading with codex_process_ceiling', async () => {
    const { planner } = makePlanner({ activeRuns: new Set() });
    // Fresh Work per member: each is its own bootstrap slot, so the first 6
    // legitimately win coordination (MAX_COORDINATED_CODEX_PROCESSES=6); once
    // that global cap is hit, the next 4 (still fresh Works, still eligible
    // by run-cap) degrade to their OWN distinct memory-only slot instead --
    // 6 + 4 = 10 distinct processes, exactly the total ceiling.
    for (let i = 0; i < MAX_CODEX_APP_SERVERS_TOTAL; i += 1) {
      const res = await planner.assign(member({ memberId: `mem_slot_${i}`, workId: `wrk_slot_${i}`, brandId: `brd_${i}`, accountId: `acct_${i}` }));
      expect(res.status.coordinationInjected || res.status.memoryInjected).toBe(true);
    }
    const eleventh = await planner.assign(member({ memberId: 'mem_eleventh', workId: 'wrk_eleventh', brandId: 'brd_new', accountId: 'acct_new' }));
    expect(eleventh.status.coordinationInjected).toBe(false);
    expect(eleventh.status.memoryInjected).toBe(false);
    expect(eleventh.status.reason).toBe('codex_process_ceiling');
  });
});

describe('CoordinationInjectionPlanner — ceilings degrade, never starve silently (task 6.31)', () => {
  it('the 7th coordination-injected Codex member app-wide gets no latte_coordination but KEEPS latte_memory', async () => {
    expect(MAX_COORDINATED_CODEX_PROCESSES).toBe(6);
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_a', 'wrk_b', 'wrk_c']) });
    // Six coordination-injected members across three Works/Brands (2 each, within the per-run cap of 3).
    for (let i = 0; i < 6; i += 1) {
      const workId = ['wrk_a', 'wrk_b', 'wrk_c'][i % 3];
      const res = await planner.assign(member({ memberId: `mem_c${i}`, workId, brandId: `brd_${workId}`, accountId: `acct_${i}` }));
      expect(res.status.coordinationInjected).toBe(true);
    }
    const seventh = await planner.assign(member({ memberId: 'mem_c7', workId: 'wrk_a', brandId: 'brd_wrk_a', accountId: 'acct_7' }));
    expect(seventh.status.coordinationInjected).toBe(false);
    expect(seventh.status.reason).toBe('codex_global_cap');
    expect(seventh.status.memoryInjected).toBe(true);
    expect(seventh.servers?.some((s) => s.kind === 'stdio')).toBe(true);
    expect(seventh.servers?.some((s) => s.kind === 'http')).toBe(false);
  });
});

// Task 6.32 said OpenCode got neither kind, because Latte ran ONE OpenCode
// server for every member and the inline config is per process. Each member
// now has its own process (`opencode-per-member.test.ts`), so OpenCode gets
// both, under its own twin caps (`opencode-mcp-injection.test.ts`).
describe('CoordinationInjectionPlanner — OpenCode gets both kinds, like Codex', () => {
  it('an OpenCode member with an active run receives coordination and memory', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    const { servers, status } = await planner.assign(member({ runtime: 'opencode', accountId: null }));
    expect(servers?.map((s) => s.name)).toEqual(['latte_coordination', 'latte_memory']);
    expect(status.coordinationInjected).toBe(true);
    expect(status.memoryInjected).toBe(true);
    expect(status.reason).toBeNull();
  });
});

describe('CoordinationInjectionPlanner — Claude below the version floor', () => {
  it('below-floor Claude gets neither server, reason claude_below_floor', async () => {
    const { planner } = makePlanner({ claudeVersion: '2.0.0' });
    const { servers, status } = await planner.assign(member({ runtime: 'claude' }));
    expect(servers).toBeUndefined();
    expect(status.coordinationInjected).toBe(false);
    expect(status.memoryInjected).toBe(false);
    expect(status.reason).toBe('claude_below_floor');
  });

  it('a null (not installed) Claude version also counts as below floor', async () => {
    const { planner } = makePlanner({ claudeVersion: null });
    const { status } = await planner.assign(member({ runtime: 'claude' }));
    expect(status.reason).toBe('claude_below_floor');
  });
});

describe('CoordinationInjectionPlanner — preview() is read-only and reflects live claims', () => {
  it('preview() for a live (already-assigned) member reflects its actual committed status, not a fresh recompute', async () => {
    const { planner } = makePlanner({ activeRuns: new Set() });
    await planner.assign(member({ memberId: 'mem_a' })); // consumes the bootstrap slot
    const live = await planner.preview(member({ memberId: 'mem_a' }));
    expect(live.coordinationInjected).toBe(true);
    // A SECOND member previewed (not yet assigned) sees the bootstrap slot as taken.
    const hypothetical = await planner.preview(member({ memberId: 'mem_b' }));
    expect(hypothetical.coordinationInjected).toBe(false);
    expect(hypothetical.reason).toBe('codex_run_cap');
  });

  it('preview() never mints a token or mutates the ledger', async () => {
    const { planner, tokens } = makePlanner();
    await planner.preview(member({ runtime: 'claude' }));
    expect(tokens.size).toBe(0);
    await planner.preview(member());
    await planner.preview(member({ memberId: 'mem_2' }));
    expect(tokens.size).toBe(0);
  });
});

// Sanity: the ceiling constants this file exercises really are what the
// design doc says (regression guard against a future accidental rename).
describe('ceiling constants this planner relies on', () => {
  it('match design-v2-conversational exactly', () => {
    expect(MAX_COORDINATED_CODEX_MEMBERS_PER_RUN).toBe(3);
    expect(MAX_COORDINATED_CODEX_PROCESSES).toBe(6);
    expect(MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK).toBe(1);
    expect(MAX_CODEX_APP_SERVERS_TOTAL).toBe(10);
    expect(MAX_ACTIVE_COORDINATION_RUNS).toBe(4);
  });
});

// -- Proof AgentHub itself really wires the planner in (task 6.28) ----------
// The ceiling arithmetic above is proven against the planner directly, fast
// and hub-free. This section proves the OTHER half: that `hub.ts`'s
// `open()`/`stop()`/`removeMember()`/`shutdown()` genuinely call
// `assign()`/`release()`/`releaseAll()` at the right moments, and that the
// resulting `mcpServers` array really reaches the adapter's `start()` input
// -- no real process ever spawns (both real adapters' `start()` are spied
// and short-circuited).

function fakeResult(input: AdapterStartInput, provider: 'claude' | 'codex'): AdapterStartResult {
  return { session: sessionFrom(input, provider, input.model ?? null, input.accountId ?? null, input.label, false), runtimeSessionId: 'sess_fake' };
}

async function withWiredHub() {
  const b = await makeBackend();
  const tokens = new CoordinationTokenRegistry();
  const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 55555 };
  const planner = new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: (workId: string) => b.repo.findActiveCoordinationRun(workId) },
    tokens,
    server,
    resolveClaudeVersion: async () => '2.1.263',
    resolveEngramBinary: async () => '/usr/bin/engram',
  });
  b.hub.attachCoordinationInjection(planner);
  const claudeStart = vi.spyOn(b.claude, 'start').mockImplementation(async (input) => fakeResult(input, 'claude'));
  b.repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  b.repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  return { b, tokens, server, claudeStart };
}

describe('AgentHub — real wiring to CoordinationInjectionPlanner (task 6.28)', () => {
  it('mints on addMember, mints again on openMember after a pause, revokes on stop (pauseMember)', async () => {
    const { b, tokens } = await withWiredHub();
    expect(tokens.size).toBe(0);
    const session = await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    expect(tokens.size).toBe(1);
    b.hub.pauseMember(session.id);
    expect(tokens.size).toBe(0);
    await b.hub.openMember(session.id, { workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {} });
    expect(tokens.size).toBe(1);
    b.cleanup();
  });

  it('revokes on removeMember', async () => {
    const { b, tokens } = await withWiredHub();
    const session = await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    expect(tokens.size).toBe(1);
    b.hub.removeMember(session.id);
    expect(tokens.size).toBe(0);
    b.cleanup();
  });

  it('revokes every live member on shutdown()', async () => {
    const { b, tokens } = await withWiredHub();
    await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'researcher', runtime: 'claude' });
    expect(tokens.size).toBe(2);
    b.hub.shutdown();
    expect(tokens.size).toBe(0);
  });

  it('the real mcpServers array built by the planner reaches the adapter start() input', async () => {
    const { b, claudeStart } = await withWiredHub();
    await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    expect(claudeStart).toHaveBeenCalledTimes(1);
    const input = claudeStart.mock.calls[0][0];
    expect(input.mcpServers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
    expect(input.mcpServers?.some((s) => s.kind === 'http' && s.name === 'latte_coordination')).toBe(true);
    b.cleanup();
  });

  it('a Work with no coordination flag/run at all still gets latte_memory on its Claude member (task 6.29, the headline assertion)', async () => {
    const { b, claudeStart } = await withWiredHub();
    // No coordination run exists anywhere in this backend; the Work was
    // never touched by startCoordinationRun. Memory must not care.
    expect(b.repo.findActiveCoordinationRun('wrk_1')).toBeNull();
    await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    const input = claudeStart.mock.calls[0][0];
    expect(input.mcpServers?.some((s) => s.kind === 'stdio' && s.name === 'latte_memory')).toBe(true);
    b.cleanup();
  });

  it('no planner attached (the pre-Phase-6 default): open() builds no mcpServers at all', async () => {
    const b = await makeBackend();
    const claudeStart = vi.spyOn(b.claude, 'start').mockImplementation(async (input) => fakeResult(input, 'claude'));
    b.repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    b.repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    await b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' });
    expect(claudeStart.mock.calls[0][0].mcpServers).toBeUndefined();
    b.cleanup();
  });

  it('a failed open() never leaves a minted token behind (addMember rolls back)', async () => {
    const { b, tokens } = await withWiredHub();
    vi.spyOn(b.claude, 'start').mockRejectedValueOnce(new Error('spawn failed'));
    await expect(b.hub.addMember({ workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {}, roleId: 'strategist', runtime: 'claude' })).rejects.toThrow('spawn failed');
    expect(tokens.size).toBe(0);
    b.cleanup();
  });
});
