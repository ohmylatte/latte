import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { claudeSupportsMcpInjection } from '../../electron/agents/tiers';
import { codexMcpConfigEnv, codexMcpConfigOverrides, mcpFingerprint } from '../../electron/agents/codex/mcpFingerprint';
import { memoryMcpServerFor, memoryProjectFor } from '../../electron/memory/engram';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

/**
 * Task 4.1-4.4 of sdd/autonomous-coordination: Claude is the first runtime
 * that can receive Latte's own coordination MCP server, scoped to one chat.
 * These tests never spawn the real `claude` binary — `fakeClaude.cjs` stands
 * in, exactly like `prompts.test.ts` does for the base prompt. What is
 * asserted is the argv Latte builds and the config file Latte writes, never
 * a live MCP round trip (that needs the real server, Phase 6).
 *
 * Tasks 6.21-6.27 (slice 6e, this file extended): `AdapterMcpServer` is now
 * a discriminated union (`http` | `stdio`) and engram ships BY DEFAULT — see
 * the describes below this point.
 */
const SERVERS: AdapterMcpServer[] = [
  { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:54823/mcp', token: 'tok_abc123' },
];

const MEMORY_SERVER: AdapterMcpServer = {
  kind: 'stdio',
  name: 'latte_memory',
  command: '/opt/latte/bin/engram',
  args: ['mcp', '--tools=agent', `--project=${memoryProjectFor('brd_1')}`],
  env: { ENGRAM_PROJECT: memoryProjectFor('brd_1') },
};

function makeAdapter(dir: string, spawned: string[][], version: string | null) {
  return new ClaudeChatAdapter({
    resolveExecutable: async () => ({ executable: process.execPath, version }),
    emit: () => {},
    accountEnv: () => ({}),
    promptDir: path.join(dir, 'prompts'),
    spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      spawned.push(args);
      return spawn(file, [FAKE_CLAUDE, ...args], options);
    }) as typeof spawn,
    platform: 'linux',
    env: { PATH: process.env.PATH ?? '' },
  });
}

describe('claudeSupportsMcpInjection: the version floor is a pure function', () => {
  it('requires 2.1.246 and treats an unreadable version as NOT supported', () => {
    expect(claudeSupportsMcpInjection('2.1.246')).toBe(true);
    expect(claudeSupportsMcpInjection('2.1.247')).toBe(true);
    expect(claudeSupportsMcpInjection('2.2.0')).toBe(true);
    expect(claudeSupportsMcpInjection('3.0.0')).toBe(true);
    expect(claudeSupportsMcpInjection('2.1.245')).toBe(false);
    expect(claudeSupportsMcpInjection('2.0.999')).toBe(false);
    expect(claudeSupportsMcpInjection('1.9.999')).toBe(false);
    // Unlike claudeSupportsEffort, an unknown version does NOT get the flag:
    // a stuck approval prompt on a headless process is worse than skipping it.
    expect(claudeSupportsMcpInjection(null)).toBe(false);
    expect(claudeSupportsMcpInjection('vendor build')).toBe(false);
  });
});

describe('Claude adapter: coordination MCP injection', () => {
  let dir: string;
  let adapter: ClaudeChatAdapter;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { adapter?.shutdown(); removeDir(dir); });

  it('writes the mcp-config file (mode 0600) and pushes --mcp-config only, never --strict-mcp-config', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: SERVERS,
    });
    const args = spawned[0];
    const flag = args.indexOf('--mcp-config');
    expect(flag).toBeGreaterThan(-1);
    expect(args).not.toContain('--strict-mcp-config');

    const file = args[flag + 1];
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toEqual({
      mcpServers: {
        latte_coordination: {
          type: 'http',
          url: 'http://127.0.0.1:54823/mcp',
          headers: { Authorization: 'Bearer tok_abc123' },
        },
      },
    });

    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('deletes the config file when the chat stops', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: SERVERS,
    });
    const flag = spawned[0].indexOf('--mcp-config');
    const file = spawned[0][flag + 1];
    expect(fs.existsSync(file)).toBe(true);

    adapter.stop('mem_coord');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('injects nothing for a Claude Code that predates 2.1.246', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.245');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: SERVERS,
    });
    expect(spawned[0]).not.toContain('--mcp-config');
    expect(spawned[0]).not.toContain('--strict-mcp-config');
    const promptsDir = path.join(dir, 'prompts');
    const written = fs.existsSync(promptsDir) ? fs.readdirSync(promptsDir) : [];
    expect(written.filter((f) => f.endsWith('.mcp.json'))).toEqual([]);
  });

  it('injects nothing when the start input carries no coordination server at all', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_worker', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Claude Code',
    });
    expect(spawned[0]).not.toContain('--mcp-config');
    expect(fs.existsSync(path.join(dir, 'prompts'))).toBe(false);
  });
});

// --- 6.21: AdapterMcpServer becomes http | stdio ------------------------------------

describe('AdapterMcpServer union (task 6.21)', () => {
  let dir: string;
  let adapter: ClaudeChatAdapter;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { adapter?.shutdown(); removeDir(dir); });

  it('regression: the phase-4 http translation is BYTE-IDENTICAL after the union refactor', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: SERVERS,
    });
    const flag = spawned[0].indexOf('--mcp-config');
    const written = JSON.parse(fs.readFileSync(spawned[0][flag + 1], 'utf8'));
    // Exactly the same shape phase 4 produced for a flat { name, url, token } — the new
    // `kind: 'http'` discriminant changes nothing about what Claude receives on disk.
    expect(written).toEqual({
      mcpServers: {
        latte_coordination: {
          type: 'http',
          url: 'http://127.0.0.1:54823/mcp',
          headers: { Authorization: 'Bearer tok_abc123' },
        },
      },
    });
  });
});

// --- 6.22 / 6.23: Claude writes BOTH servers into ONE mcp-config file, and now by default ----

describe('Claude: both servers in one mcp-config file, engram by default (tasks 6.22-6.23)', () => {
  let dir: string;
  let adapter: ClaudeChatAdapter;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { adapter?.shutdown(); removeDir(dir); });

  it('mcpInjection flipped to per-member (task 6.23, phase 4\'s flagged open decision)', () => {
    adapter = makeAdapter(dir, [], '2.1.263');
    expect(adapter.mcpInjection).toBe('per-member');
  });

  it('writes latte_coordination AND latte_memory into the SAME file, still one --mcp-config flag, never --strict-mcp-config', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_both', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: [SERVERS[0], MEMORY_SERVER],
    });

    const args = spawned[0];
    const flags = args.filter((a) => a === '--mcp-config');
    expect(flags).toHaveLength(1); // one flag, one file, for both servers
    expect(args).not.toContain('--strict-mcp-config');

    const file = args[args.indexOf('--mcp-config') + 1];
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toEqual({
      mcpServers: {
        latte_coordination: {
          type: 'http',
          url: 'http://127.0.0.1:54823/mcp',
          headers: { Authorization: 'Bearer tok_abc123' },
        },
        latte_memory: {
          type: 'stdio',
          command: '/opt/latte/bin/engram',
          args: ['mcp', '--tools=agent', '--project=latte-brd_1'],
          env: { ENGRAM_PROJECT: 'latte-brd_1' },
        },
      },
    });
  });

  it('the brand project is pinned in BOTH the --project argv AND env.ENGRAM_PROJECT, from the same memoryProjectFor(brandId)', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    const memoryOnly: AdapterMcpServer = {
      kind: 'stdio', name: 'latte_memory', command: '/opt/latte/bin/engram',
      args: ['mcp', '--tools=agent', `--project=${memoryProjectFor('brd_pinned')}`],
      env: { ENGRAM_PROJECT: memoryProjectFor('brd_pinned') },
    };
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_pin', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: [memoryOnly],
    });
    const args = spawned[0];
    const file = args[args.indexOf('--mcp-config') + 1];
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.mcpServers.latte_memory.args).toContain(`--project=${memoryProjectFor('brd_pinned')}`);
    expect(written.mcpServers.latte_memory.env.ENGRAM_PROJECT).toBe(memoryProjectFor('brd_pinned'));
  });

  it('a Claude member of ANY Work — no run, no coordination server at all — still receives latte_memory (task 6.23: engram is not gated on coordination)', async () => {
    const spawned: string[][] = [];
    adapter = makeAdapter(dir, spawned, '2.1.263');
    await adapter.start({
      workId: 'wrk_uncoordinated', chatId: 'mem_memory_only', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Claude Code', mcpServers: [MEMORY_SERVER], // no latte_coordination entry at all
    });
    const args = spawned[0];
    expect(args).toContain('--mcp-config');
    const file = args[args.indexOf('--mcp-config') + 1];
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.mcpServers.latte_memory).toBeDefined();
    expect(written.mcpServers.latte_coordination).toBeUndefined();
  });
});

// --- 6.24: Codex stdio translation ---------------------------------------------------

describe('Codex: stdio translation for latte_memory, alongside latte_coordination (task 6.24)', () => {
  const MIXED: AdapterMcpServer[] = [
    { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:54222/mcp', token: 'tok_super_secret' },
    { kind: 'stdio', name: 'latte_memory', command: '/opt/latte/bin/engram', args: ['mcp', '--tools=agent', '--project=latte-brd_9'], env: { ENGRAM_PROJECT: 'latte-brd_9' } },
  ];

  it('builds both the http -c overrides AND the stdio .command/.args/.env -c overrides, verified TOML-array form', () => {
    const args = codexMcpConfigOverrides(MIXED);
    expect(args).toEqual([
      '-c', 'mcp_servers.latte_coordination.url=http://127.0.0.1:54222/mcp',
      '-c', 'mcp_servers.latte_coordination.bearer_token_env_var=LATTE_COORD_TOKEN',
      '-c', 'mcp_servers.latte_memory.command=/opt/latte/bin/engram',
      '-c', 'mcp_servers.latte_memory.args=["mcp","--tools=agent","--project=latte-brd_9"]',
      '-c', 'mcp_servers.latte_memory.env.ENGRAM_PROJECT=latte-brd_9',
    ]);
  });

  it('the coordination token is ONLY in env.LATTE_COORD_TOKEN, absent from argv — memory carries no token at all', () => {
    const args = codexMcpConfigOverrides(MIXED);
    expect(args.join(' ')).not.toContain('tok_super_secret');
    expect(codexMcpConfigEnv(MIXED)).toEqual({ LATTE_COORD_TOKEN: 'tok_super_secret' });
  });

  it('a memory-only array (no coordination entry) still translates, and contributes no LATTE_COORD_TOKEN', () => {
    const memoryOnly: AdapterMcpServer[] = [MIXED[1]];
    const args = codexMcpConfigOverrides(memoryOnly);
    expect(args).toEqual([
      '-c', 'mcp_servers.latte_memory.command=/opt/latte/bin/engram',
      '-c', 'mcp_servers.latte_memory.args=["mcp","--tools=agent","--project=latte-brd_9"]',
      '-c', 'mcp_servers.latte_memory.env.ENGRAM_PROJECT=latte-brd_9',
    ]);
    expect(codexMcpConfigEnv(memoryOnly)).toEqual({});
  });

  it('two engram-only members of the SAME brand fingerprint IDENTICALLY (D3\'s load-bearing invariant: one shared process per brand+account) — a coordination token makes them differ', () => {
    const memberA: AdapterMcpServer[] = [MIXED[1]];
    const memberB: AdapterMcpServer[] = [{ ...MIXED[1] }]; // structurally identical, different object
    expect(mcpFingerprint(memberA)).toBe(mcpFingerprint(memberB));

    const withCoordination: AdapterMcpServer[] = [...memberA, MIXED[0]];
    expect(mcpFingerprint(withCoordination)).not.toBe(mcpFingerprint(memberA));
  });
});

// --- 6.25: engram missing degrades honestly and visibly -------------------------------

describe('memoryMcpServerFor: honest degradation when engram is not installed (task 6.25)', () => {
  it('a null (not-found) binary omits the entry entirely — never a broken MCP entry', () => {
    expect(memoryMcpServerFor(null, 'brd_1')).toBeNull();
  });

  it('a resolved binary builds the exact pinned stdio entry', () => {
    const server = memoryMcpServerFor('/opt/latte/bin/engram', 'brd_7');
    expect(server).toEqual({
      kind: 'stdio',
      name: 'latte_memory',
      command: '/opt/latte/bin/engram',
      args: ['mcp', '--tools=agent', '--project=latte-brd_7'],
      env: { ENGRAM_PROJECT: 'latte-brd_7' },
    });
  });

  describe('Claude adapter: omission is entire, never a broken entry the agent discovers mid-turn', () => {
    let dir: string;
    let adapter: ClaudeChatAdapter;
    beforeEach(() => { dir = makeTempDir(); });
    afterEach(() => { adapter?.shutdown(); removeDir(dir); });

    it('coordination still works when only latte_coordination is present — no latte_memory key at all, not a null/broken one', async () => {
      const spawned: string[][] = [];
      adapter = makeAdapter(dir, spawned, '2.1.263');
      await adapter.start({
        workId: 'wrk_1', chatId: 'mem_no_engram', roleId: 'strategist', roleName: 'Strategist',
        directory: dir, title: 't', label: 'Claude Code', mcpServers: SERVERS, // memoryMcpServerFor(null, ...) => omitted upstream, never passed in
      });
      const args = spawned[0];
      const file = args[args.indexOf('--mcp-config') + 1];
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(written.mcpServers.latte_coordination).toBeDefined();
      expect(written.mcpServers.latte_memory).toBeUndefined();
    });

    it('no file at all when NEITHER server is present (member not coordination-eligible AND engram missing)', async () => {
      const spawned: string[][] = [];
      adapter = makeAdapter(dir, spawned, '2.1.263');
      await adapter.start({
        workId: 'wrk_1', chatId: 'mem_neither', roleId: 'copywriter', roleName: 'Copywriter',
        directory: dir, title: 't', label: 'Claude Code', // mcpServers omitted entirely
      });
      expect(spawned[0]).not.toContain('--mcp-config');
      expect(fs.existsSync(path.join(dir, 'prompts'))).toBe(false);
    });
  });
});
