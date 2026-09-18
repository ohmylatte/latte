import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { claudeSupportsMcpInjection } from '../../electron/agents/tiers';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

/**
 * Task 4.1-4.4 of sdd/autonomous-coordination: Claude is the first runtime
 * that can receive Latte's own coordination MCP server, scoped to one chat.
 * These tests never spawn the real `claude` binary — `fakeClaude.cjs` stands
 * in, exactly like `prompts.test.ts` does for the base prompt. What is
 * asserted is the argv Latte builds and the config file Latte writes, never
 * a live MCP round trip (that needs the real server, Phase 6).
 */
const SERVERS: AdapterMcpServer[] = [
  { name: 'latte_coordination', url: 'http://127.0.0.1:54823/mcp', token: 'tok_abc123' },
];

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
