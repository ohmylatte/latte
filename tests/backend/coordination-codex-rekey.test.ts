import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { CodexAppServer } from '../../electron/agents/codex/appServer';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { codexMcpConfigEnv, codexMcpConfigOverrides, mcpFingerprint } from '../../electron/agents/codex/mcpFingerprint';
import { MAX_COORDINATED_CODEX_PROCESSES } from '../../electron/coordination/limits';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function coordServer(token: string, url = 'http://127.0.0.1:59999/mcp'): AdapterMcpServer[] {
  return [{ name: 'latte_coordination', url, token }];
}

function makeAdapter(events: ChatEvent[], dir: string, spawned?: Array<{ args: string[]; env: Record<string, string | undefined> }>, opts?: { maxChats?: number }) {
  return new CodexChatAdapter({
    resolveExecutable: async () => ({ executable: process.execPath, version: '0.154.0' }),
    emit: (e) => events.push(e),
    accountEnv: () => ({}),
    serverCwd: dir,
    platform: 'linux',
    env: { PATH: process.env.PATH ?? '' },
    spawnImpl: ((file: string, args: string[], options: { env?: Record<string, string> }) => {
      spawned?.push({ args, env: options.env ?? {} });
      return spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
    }) as typeof spawn,
    requestTimeoutMs: 5_000,
    maxChats: opts?.maxChats,
  });
}

// --- 5.1-adjacent pure helpers (mcpFingerprint.ts), test-first alongside the impl -----

describe('mcpFingerprint: pure, no I/O', () => {
  it('a non-coordinated member (no mcpServers) fingerprints to the empty string', () => {
    expect(mcpFingerprint(undefined)).toBe('');
    expect(mcpFingerprint([])).toBe('');
  });

  it('two coordinated members with the SAME url but DIFFERENT per-member tokens fingerprint DIFFERENTLY', () => {
    const a = mcpFingerprint(coordServer('tok_member_a'));
    const b = mcpFingerprint(coordServer('tok_member_b'));
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });

  it('the same server list fingerprints identically regardless of key order (stable)', () => {
    const a = mcpFingerprint(coordServer('tok_x'));
    const b = mcpFingerprint([...coordServer('tok_x')]);
    expect(a).toBe(b);
  });
});

describe('codexMcpConfigOverrides / codexMcpConfigEnv: the -c translation', () => {
  it('builds mcp_servers.<name>.url and .bearer_token_env_var, never the token itself', () => {
    const servers = coordServer('tok_secret_abc', 'http://127.0.0.1:54111/mcp');
    const args = codexMcpConfigOverrides(servers);
    expect(args).toEqual([
      '-c', 'mcp_servers.latte_coordination.url=http://127.0.0.1:54111/mcp',
      '-c', 'mcp_servers.latte_coordination.bearer_token_env_var=LATTE_COORD_TOKEN',
    ]);
    expect(args.join(' ')).not.toContain('tok_secret_abc');
    expect(codexMcpConfigEnv(servers)).toEqual({ LATTE_COORD_TOKEN: 'tok_secret_abc' });
  });
});

// --- 5.5: appServer.ts accepts extraArgs instead of a hardcoded ['app-server'] --------

describe('CodexAppServer: extraArgs (task 5.5)', () => {
  it('appends extraArgs after app-server itself', async () => {
    let captured: string[] | undefined;
    const server = new CodexAppServer({
      executable: process.execPath,
      env: {},
      cwd: process.cwd(),
      platform: 'linux',
      extraArgs: ['-c', 'mcp_servers.latte_coordination.url=http://127.0.0.1:1/mcp'],
      spawnImpl: ((file: string, args: string[]) => {
        captured = args;
        throw new Error('spawn captured');
      }) as unknown as typeof spawn,
    });
    await expect(server.ensure()).rejects.toThrow(/spawn captured/);
    expect(captured).toEqual(['app-server', '-c', 'mcp_servers.latte_coordination.url=http://127.0.0.1:1/mcp']);
  });

  it('defaults to plain app-server with no extraArgs (unchanged behaviour)', async () => {
    let captured: string[] | undefined;
    const server = new CodexAppServer({
      executable: process.execPath,
      env: {},
      cwd: process.cwd(),
      platform: 'linux',
      spawnImpl: ((file: string, args: string[]) => {
        captured = args;
        throw new Error('spawn captured');
      }) as unknown as typeof spawn,
    });
    await expect(server.ensure()).rejects.toThrow(/spawn captured/);
    expect(captured).toEqual(['app-server']);
  });
});

// --- 5.3 (regression, written first) + 5.4 (the fix) + 5.6 + 5.7 ----------------------

describe('CodexChatAdapter: re-keying by account+mcpFingerprint (Phase 5)', () => {
  let events: ChatEvent[];
  let adapter: CodexChatAdapter;
  let dir: string;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
  });

  afterEach(() => {
    adapter?.shutdown();
    removeDir(dir);
  });

  it(
    'task 5.3/5.4: two coordinated members sharing one accountId get SEPARATE processes; one crashing leaves the other chat untouched',
    async () => {
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      adapter = makeAdapter(events, dir, spawned);

      const a = await adapter.start({
        workId: 'wrk_1', chatId: 'mem_a', roleId: 'strategist', roleName: 'Strategist',
        directory: dir, title: 't', label: 'Codex · A', accountId: SYSTEM_ACCOUNT_ID,
        mcpServers: coordServer('tok_member_a'),
      });
      const b = await adapter.start({
        workId: 'wrk_1', chatId: 'mem_b', roleId: 'copywriter', roleName: 'Copywriter',
        directory: dir, title: 't', label: 'Codex · B', accountId: SYSTEM_ACCOUNT_ID,
        mcpServers: coordServer('tok_member_b'),
      });

      // Two coordinated members, same account, DIFFERENT tokens -> two distinct
      // app-server processes. Under the unmodified (pre-5.4) code there is no
      // re-keying at all, so this is exactly 1 (both share the one account-keyed
      // server) and the assertion below fails -- that failure IS the regression proof.
      expect(spawned).toHaveLength(2);

      // A crashes (the whole app-server process dies mid-turn).
      await adapter.send(a.session.id, 'crash-server');
      await waitFor(() => events.some((e) => e.type === 'closed' && e.chatId === 'mem_a'));

      // B must be completely unaffected: still owned by the adapter, no
      // 'closed'/'error' event for it. Pre-fix, B shares A's single
      // account-keyed server, so A's crash sweeps B too and this fails.
      expect(adapter.owns('mem_b')).toBe(true);
      expect(events.some((e) => e.chatId === 'mem_b' && (e.type === 'closed' || e.type === 'error'))).toBe(false);

      // B's chat still works after A's crash.
      await adapter.send(b.session.id, 'still here?');
      await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle' && e.chatId === 'mem_b'));
      const reply = adapter.listMessages('mem_b')[1];
      expect(reply.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Echo: still here?') });
    },
  );

  it('a non-coordinated member (no mcpServers) fingerprints to \'\' and keeps sharing one process per account with other non-coordinated members', async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    adapter = makeAdapter(events, dir, spawned);
    await adapter.start({ workId: 'wrk_1', chatId: 'mem_x', roleId: 'copywriter', roleName: 'Copywriter', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID });
    await adapter.start({ workId: 'wrk_1', chatId: 'mem_y', roleId: 'copywriter', roleName: 'Copywriter', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID });
    expect(spawned).toHaveLength(1); // one shared ordinary process, as before this change
    expect(spawned[0].args).not.toContain('-c');
  });

  it('task 5.6: pushes the two -c overrides and puts the token ONLY in env.LATTE_COORD_TOKEN, absent from argv', async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    adapter = makeAdapter(events, dir, spawned);
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_super_secret', 'http://127.0.0.1:54222/mcp'),
    });
    const { args, env } = spawned[0];
    expect(args).toEqual(['app-server', '-c', 'mcp_servers.latte_coordination.url=http://127.0.0.1:54222/mcp', '-c', 'mcp_servers.latte_coordination.bearer_token_env_var=LATTE_COORD_TOKEN']);
    expect(args.join(' ')).not.toContain('tok_super_secret'); // never on argv
    expect(env.LATTE_COORD_TOKEN).toBe('tok_super_secret'); // only in env
  });

  it('task 5.7: beyond the app-wide coordinated-process ceiling, a member degrades to no injection instead of spawning an Nth process', async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    adapter = makeAdapter(events, dir, spawned, { maxChats: MAX_COORDINATED_CODEX_PROCESSES + 2 });
    for (let i = 0; i < MAX_COORDINATED_CODEX_PROCESSES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await adapter.start({
        workId: 'wrk_1', chatId: `mem_c${i}`, roleId: 'copywriter', roleName: 'Copywriter',
        directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
        mcpServers: coordServer(`tok_${i}`),
      });
    }
    expect(spawned).toHaveLength(MAX_COORDINATED_CODEX_PROCESSES);

    // The (N+1)th coordinated member: the chat still starts (never a hard
    // failure), but it must NOT push -c overrides or spawn an Nth process --
    // it shares the ordinary, uninjected process instead.
    const before = spawned.length;
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_over_cap', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_over_cap'),
    });
    expect(spawned).toHaveLength(before + 1); // the ordinary shared process, not a coordinated one
    expect(spawned.at(-1)?.args).not.toContain('-c');
  });

  it('revert-safety: with no mcpServers anywhere (as the app behaves today, Phase 6 not wired), Codex members behave exactly as before this change', async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    adapter = makeAdapter(events, dir, spawned);
    const { session, runtimeSessionId } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID });
    expect(spawned[0].args).toEqual(['app-server']);
    expect(runtimeSessionId).toMatch(/^thr_/);
    await adapter.send(session.id, 'Hola Codex');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(adapter.listMessages(session.id)[1].parts[0]).toMatchObject({ text: 'Echo: Hola Codex' });
  });

  it('pid files: a coordinated member records one on start and the record is gone once its process stops', async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    adapter = makeAdapter(events, dir, spawned);
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_pid', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_pid'),
    });
    const pidDir = path.join(dir, 'codex-app-servers');
    await waitFor(() => fs.existsSync(pidDir) && fs.readdirSync(pidDir).length > 0);
    expect(fs.readdirSync(pidDir).filter((f) => f.endsWith('.pid'))).toHaveLength(1);

    adapter.stop('mem_pid');
    await waitFor(() => !fs.existsSync(pidDir) || fs.readdirSync(pidDir).filter((f) => f.endsWith('.pid')).length === 0);
  });
});
