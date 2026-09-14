import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatUsage } from '../../shared/contracts';
import { EMPTY_USAGE } from '../../shared/contracts';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { RoleCatalog } from '../../electron/agents/roles';
import { asEffortTier, claudeArgsForTier, claudeSupportsEffort, codexEffortForTier, isEffortTier, opencodeVariantForTier } from '../../electron/agents/tiers';
import { addUsage, parseUsage } from '../../electron/core/usage';
import { API_ARITY, API_METHODS } from '../../electron/ipc/channels';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { loadInstructionPack, parseRole } from '../../electron/workspace/packs';
import { fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

const PACKS_DIR = path.resolve(__dirname, '..', '..', 'packs');
const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');
const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const usageEvents = (events: ChatEvent[]): Array<Extract<ChatEvent, { type: 'usage' }>> =>
  events.filter((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage');

describe('Effort tiers: one human choice, three dialects', () => {
  it('maps every tier to Claude Code arguments and keeps an explicit model', () => {
    // Aliases only. A full model id would be a promise that expires the day
    // the alias moves to the next model.
    expect(claudeArgsForTier('light', null, '2.1.269 (Claude Code)')).toEqual(['--model', 'sonnet', '--effort', 'low']);
    expect(claudeArgsForTier('balanced', null, '2.1.269 (Claude Code)')).toEqual(['--model', 'sonnet', '--effort', 'high']);
    expect(claudeArgsForTier('deep', null, '2.1.269 (Claude Code)')).toEqual(['--model', 'opus', '--effort', 'xhigh']);

    // The human picked the model: the tier contributes the effort only.
    expect(claudeArgsForTier('deep', 'haiku', '2.1.269')).toEqual(['--model', 'haiku', '--effort', 'xhigh']);
    expect(claudeArgsForTier('light', '  sonnet  ', '2.1.269')).toEqual(['--model', 'sonnet', '--effort', 'low']);
  });

  it('omits --effort on a Claude Code that predates the flag, and keeps it when the version is unreadable', () => {
    // Passing an unknown flag is not a worse answer, it is a CLI that refuses
    // to start: an older version gets the model on its own.
    expect(claudeArgsForTier('deep', null, '2.1.204')).toEqual(['--model', 'opus']);
    expect(claudeArgsForTier('deep', null, '2.0.999')).toEqual(['--model', 'opus']);
    expect(claudeSupportsEffort('2.1.205')).toBe(true);
    expect(claudeSupportsEffort('2.1.204')).toBe(false);
    expect(claudeSupportsEffort('3.0.0')).toBe(true);
    // Unreadable is not evidence of an old CLI.
    expect(claudeSupportsEffort(null)).toBe(true);
    expect(claudeSupportsEffort('vendor build')).toBe(true);
  });

  it('maps the same tier to Codex effort and to an OpenCode variant', () => {
    expect(['light', 'balanced', 'deep'].map((t) => codexEffortForTier(t as never))).toEqual(['low', 'medium', 'high']);
    expect(['light', 'balanced', 'deep'].map((t) => opencodeVariantForTier(t as never))).toEqual(['low', 'medium', 'high']);
  });

  it('never lets an unknown tier through', () => {
    expect(isEffortTier('deep')).toBe(true);
    expect(isEffortTier('turbo')).toBe(false);
    expect(isEffortTier(null)).toBe(false);
    expect(asEffortTier('turbo')).toBe('balanced');
    expect(asEffortTier(undefined)).toBe('balanced');
    expect(claudeArgsForTier('turbo' as never, null, null)).toEqual(['--model', 'sonnet', '--effort', 'high']);
  });
});

describe('Roles declare the effort their work needs', () => {
  it('reads the tier from the front matter and defaults anything else to balanced', () => {
    expect(parseRole('x', '---\nname: Copy\ntier: deep\n---\nDo copy.')).toMatchObject({ tier: 'deep' });
    expect(parseRole('x', '---\nname: Copy\ntier: TURBO\n---\nDo copy.')).toMatchObject({ tier: 'balanced' });
    // A pack written before tiers existed still loads, at the default effort.
    expect(parseRole('x', '---\nname: Copy\n---\nDo copy.')).toMatchObject({ tier: 'balanced' });
  });

  it('ships each marketing role at the effort its job actually needs', () => {
    const pack = loadInstructionPack(PACKS_DIR, 'marketing-core');
    const byId = new Map((pack?.roles ?? []).map((r) => [r.id, r.tier]));
    expect(byId.get('researcher')).toBe('light');
    expect(byId.get('reviewer')).toBe('light');
    expect(byId.get('analyst')).toBe('balanced');
    expect(byId.get('paid-media')).toBe('balanced');
    expect(byId.get('strategist')).toBe('deep');

    const catalog = new RoleCatalog(pack);
    const roles = new Map(catalog.list().map((r) => [r.id, r.tier]));
    expect(roles.get('assistant')).toBe('balanced');
    expect(roles.get('strategist')).toBe('deep');
    expect(new Map(catalog.listProfiles().map((p) => [p.id, p.tier])).get('researcher')).toBe('light');
  });
});

describe('Usage arithmetic', () => {
  it('sums what is spent, keeps the latest context and never invents a price', () => {
    const first: ChatUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7, turns: 1, costUsd: null, contextTokens: 117 };
    const second: ChatUsage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 200, cacheWriteTokens: 0, turns: 1, costUsd: 0.02, contextTokens: 203 };
    const total = addUsage(addUsage(EMPTY_USAGE, first), second);
    expect(total).toEqual({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 300, cacheWriteTokens: 7, turns: 2, costUsd: 0.02, contextTokens: 203 });
    // A turn with no price does not erase the price of the ones that had one.
    expect(addUsage(total, first).costUsd).toBe(0.02);
  });

  it('reads a row written before the column existed as nothing measured', () => {
    expect(parseUsage(null)).toEqual(EMPTY_USAGE);
    expect(parseUsage('')).toEqual(EMPTY_USAGE);
    expect(parseUsage('not json')).toEqual(EMPTY_USAGE);
    expect(parseUsage('[1,2]')).toEqual(EMPTY_USAGE);
    expect(parseUsage('{"inputTokens":"mucho","costUsd":"caro"}')).toEqual(EMPTY_USAGE);
  });
});

describe('Team member storage: tier and lifetime usage', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('adds the columns to a database that already ran the latest schema, without a version bump', async () => {
    const file = path.join(dir, 'latte.db');
    const { driver } = await openDriver(file, 'sql.js');
    // The team_members table exactly as schema 7 shipped it, before tiers.
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', dir TEXT, updated_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE team_members (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, role_id TEXT NOT NULL, role_name TEXT NOT NULL, initial TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT, account_id TEXT, session_id TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, continued_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '', null, '2026-01-01T00:00:00.000Z']);
    driver.run(
      "INSERT INTO team_members(id, work_id, role_id, role_name, initial, runtime, session_id, done, created_at, updated_at) VALUES ('mem_old', 'wrk_1', 'strategist', 'Strategist', 'S', 'claude', 'sess-old', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.migrate();

    // The member is still there, at the default effort and with an honest
    // "nothing measured": Latte never back-fills consumption it did not see.
    const old = repo.getMember('mem_old');
    expect(old).toMatchObject({ tier: 'balanced', sessionId: 'sess-old' });
    expect(old.usage).toEqual(EMPTY_USAGE);
    // No bump: an older build must keep opening this database.
    expect(repo.getMeta('schema_version')).toBe('8');
    repo.close();
  });

  it('stores the tier, accumulates measured turns and answers with the new total', async () => {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), 'sql.js');
    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    repo.insertMember({
      id: 'mem_a', workId: 'wrk_1', roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'claude',
      model: null, accountId: SYSTEM_ACCOUNT_ID, sessionId: '', done: false, tier: 'deep',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(repo.getMember('mem_a')).toMatchObject({ tier: 'deep' });
    expect(repo.getMember('mem_a').usage).toEqual(EMPTY_USAGE);

    const turn: ChatUsage = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30, turns: 1, costUsd: 0.01, contextTokens: 1050 };
    expect(repo.addMemberUsage('mem_a', turn, '2026-01-02T00:00:00.000Z')).toEqual(turn);
    const after = repo.addMemberUsage('mem_a', turn, '2026-01-03T00:00:00.000Z');
    expect(after).toMatchObject({ inputTokens: 240, cacheReadTokens: 1800, turns: 2, costUsd: 0.02, contextTokens: 1050 });
    // It survives the read back, which is the whole point of persisting it.
    expect(repo.getMember('mem_a').usage).toEqual(after);
    expect(repo.getMember('mem_a').updatedAt).toBe('2026-01-03T00:00:00.000Z');

    repo.setMemberTier('mem_a', 'light', '2026-01-04T00:00:00.000Z');
    expect(repo.getMember('mem_a')).toMatchObject({ tier: 'light', updatedAt: '2026-01-04T00:00:00.000Z' });
    expect(() => repo.addMemberUsage('mem_nope', turn, '2026-01-05T00:00:00.000Z')).toThrow(/Team member/);
    repo.close();
  });
});

describe('Claude Code reports what it spent', () => {
  let events: ChatEvent[];
  let dir: string;
  let adapter: ClaudeChatAdapter;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
    adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.269 (Claude Code)' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CLAUDE, ...args], options)) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
  });

  afterEach(() => {
    adapter.shutdown();
    removeDir(dir);
  });

  it('reads the runtime numbers and charges each turn only the cost it added', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null, tier: 'light' });
    await adapter.send(session.id, 'Hola');
    await waitFor(() => usageEvents(events).length === 1);

    const first = usageEvents(events)[0];
    expect(first.turn).toEqual({
      inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30, turns: 1, costUsd: 0.01,
      // What the model re-read: fresh input plus everything the cache handed it.
      contextTokens: 1050,
    });
    expect(first.total).toEqual(first.turn);

    await adapter.send(session.id, 'Otra vez');
    await waitFor(() => usageEvents(events).length === 2);
    const second = usageEvents(events)[1];
    // The CLI reported 0.02 for the process; the turn cost the difference, not
    // the whole process again.
    expect(second.turn.costUsd).toBeCloseTo(0.01, 6);
    expect(second.total).toMatchObject({ inputTokens: 240, outputTokens: 90, cacheReadTokens: 1800, turns: 2 });
    expect(second.total.costUsd).toBeCloseTo(0.02, 6);
  });

  it('starts the CLI at the tier the member works on', async () => {
    const argvFor = async (tier: 'light' | 'balanced' | 'deep') => {
      const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null, tier });
      await adapter.send(session.id, 'dame el argv');
      await waitFor(() => adapter.listMessages(session.id).some((m) => m.parts.some((p) => p.type === 'text' && p.text.startsWith('ARGV'))));
      const part = adapter.listMessages(session.id).flatMap((m) => m.parts).find((p) => p.type === 'text' && p.text.startsWith('ARGV')) as { text: string };
      adapter.stop(session.id);
      return part.text;
    };
    expect(await argvFor('light')).toContain('--model sonnet --effort low');
    expect(await argvFor('deep')).toContain('--model opus --effort xhigh');
  });
});

describe('Codex reports what it spent', () => {
  let events: ChatEvent[];
  let dir: string;
  let adapter: CodexChatAdapter;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
    adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: 'codex-cli 0.154.0' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      serverCwd: dir,
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CODEX, ...args.slice(1)], options)) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      requestTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    adapter.shutdown();
    removeDir(dir);
  });

  it('turns the thread running totals into one turn each, and never invents a price', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: null, tier: 'deep' });
    await adapter.send(session.id, 'Hola');
    await waitFor(() => usageEvents(events).length === 1);
    const first = usageEvents(events)[0];
    // Codex counts cached tokens inside inputTokens, so the fresh part is the
    // difference: 1000 read, 800 of them from cache.
    expect(first.turn).toEqual({ inputTokens: 200, outputTokens: 60, cacheReadTokens: 800, cacheWriteTokens: 50, turns: 1, costUsd: null, contextTokens: 1050 });

    await adapter.send(session.id, 'Otra vez');
    await waitFor(() => usageEvents(events).length === 2);
    const second = usageEvents(events)[1];
    // The notification carries the thread total again; only the growth counts.
    expect(second.turn).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, turns: 1 });
    expect(second.total).toMatchObject({ inputTokens: 400, outputTokens: 120, cacheReadTokens: 1600, turns: 2, costUsd: null });
  });

  it('sends the tier as reasoning effort on every turn, not on the shared server', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: null, tier: 'light' });
    await adapter.send(session.id, 'dame el effort');
    await waitFor(() => adapter.listMessages(session.id).some((m) => m.parts.some((p) => p.type === 'text' && p.text.startsWith('EFFORT'))));
    const part = adapter.listMessages(session.id).flatMap((m) => m.parts).find((p) => p.type === 'text' && p.text.startsWith('EFFORT')) as { text: string };
    expect(part.text).toBe('EFFORT low');
  });
});

describe('OpenCode usage and variant, through the hub', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;
  let chatEvents: ChatEvent[];

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    chatEvents = [];
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
        return { code: 0, stdout: '1.0.0\n' };
      }),
      emitChat: (e) => chatEvents.push(e),
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('persists the turn on the member and forwards the lifetime total, not the process one', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    // The researcher ships as `light`, so the member opens there without anyone asking.
    const member = await b.service.addTeamMember(work.id, 'researcher');
    expect((await b.service.listTeam(work.id))[0]).toMatchObject({ tier: 'light' });
    expect((await b.service.listTeam(work.id))[0].usage).toEqual(EMPTY_USAGE);

    await b.service.sendChat(member.id, 'Hola');
    const prompt = fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1);
    expect((prompt?.body as { variant?: string }).variant).toBe('low');

    // The server settling an assistant message is what says a turn is measured.
    const ocSessionId = b.repo.getMember(member.id).sessionId;
    const reply = (id: string) => ({
      sessionID: ocSessionId,
      info: {
        id, sessionID: ocSessionId, role: 'assistant', time: { created: Date.now(), completed: Date.now() },
        modelID: 'fake-model', providerID: 'fake-provider', cost: 0.004,
        tokens: { input: 80, output: 40, reasoning: 12, cache: { read: 500, write: 20 } },
      },
    });
    fake.emit('', 'message.updated', reply('msg_done_1'));
    await waitFor(() => usageEvents(chatEvents).length === 1);
    const first = usageEvents(chatEvents)[0];
    // `reasoning` is a breakdown of `output`, not tokens to charge twice.
    expect(first.turn).toEqual({ inputTokens: 80, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 20, turns: 1, costUsd: 0.004, contextTokens: 600 });

    // The same message settling again is the same turn, not a second one.
    fake.emit('', 'message.updated', reply('msg_done_1'));
    fake.emit('', 'message.updated', reply('msg_done_2'));
    await waitFor(() => usageEvents(chatEvents).length === 2);
    const second = usageEvents(chatEvents)[1];
    expect(second.total).toMatchObject({ inputTokens: 160, outputTokens: 80, cacheReadTokens: 1000, turns: 2 });

    // What the interface reads comes from the database, so it outlives the process.
    const stored = (await b.service.listTeam(work.id))[0].usage;
    expect(stored).toEqual(second.total);
    expect(stored.costUsd).toBeCloseTo(0.008, 6);
  });

  it('changes the effort of a live conversation and leaves a paused one for later', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const member = await b.service.addTeamMember(work.id, 'strategist');
    // The strategist decides, so it ships deep.
    expect((await b.service.listTeam(work.id))[0].tier).toBe('deep');

    const changed = await b.service.setTeamMemberTier(member.id, 'light');
    expect(changed.member).toMatchObject({ id: member.id, tier: 'light' });
    expect(changed.session).not.toBeNull();
    expect(changed.resumed).toBe(true);
    await b.service.sendChat(member.id, 'Hola');
    expect((fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1)?.body as { variant?: string }).variant).toBe('low');

    // Same value twice is not a restart.
    expect((await b.service.setTeamMemberTier(member.id, 'light')).member.tier).toBe('light');

    // Paused: the change is recorded, nothing is woken up to apply it.
    await b.service.pauseTeamMember(member.id);
    const paused = await b.service.setTeamMemberTier(member.id, 'deep');
    expect(paused.session).toBeNull();
    expect(paused.resumed).toBe(false);
    expect((await b.service.listTeam(work.id))[0]).toMatchObject({ tier: 'deep', status: 'paused' });

    await expect(b.service.setTeamMemberTier(member.id, 'turbo' as never)).rejects.toThrow(/esfuerzo/i);
    await expect(b.service.setTeamMemberTier('mem_nope', 'light')).rejects.toThrow();
  });

  it('lets the human override the role default when adding a member, and refuses nonsense', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const member = await b.service.addTeamMember(work.id, 'researcher', { tier: 'deep' });
    expect((await b.service.listTeam(work.id)).find((m) => m.id === member.id)).toMatchObject({ tier: 'deep' });
    await expect(b.service.addTeamMember(work.id, 'researcher', { tier: 'turbo' } as never)).rejects.toThrow(/tier/i);
  });
});

describe('The tier reaches the renderer through the same door as the model', () => {
  it('exposes setTeamMemberTier with the arity the preload repeats', () => {
    expect(API_METHODS).toContain('setTeamMemberTier');
    expect(API_ARITY.setTeamMemberTier).toBe(2);
    // Next to the model change it mirrors, so the two stay together.
    expect(API_METHODS.indexOf('setTeamMemberTier')).toBe(API_METHODS.indexOf('setTeamMemberModel') + 1);
  });
});
