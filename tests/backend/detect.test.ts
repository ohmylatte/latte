import { describe, expect, it } from 'vitest';
import { RuntimeDetector } from '../../electron/runtime/detect';
import { spawnSpecFor } from '../../electron/runtime/commandRunner';
import { resolveOpenCodeBinary } from '../../electron/opencode/server';
import { resolveCodexBinary } from '../../electron/agents/codex/appServer';
import { PROVIDERS, isProvider } from '../../electron/runtime/providers';
import { fakeRunner } from './helpers';

describe('providers allowlist', () => {
  it('only accepts the three known CLIs', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex', 'opencode']);
    expect(isProvider('claude')).toBe(true);
    expect(isProvider('bash')).toBe(false);
    expect(isProvider('claude; rm -rf /')).toBe(false);
  });
});

describe('RuntimeDetector', () => {
  it('finds CLIs on Windows, prefers .exe over .cmd and reports versions', async () => {
    const runner = fakeRunner((file, args) => {
      if (file === 'where.exe') {
        if (args[0] === 'claude') return { code: 0, stdout: 'C:\\Users\\me\\.local\\bin\\claude.exe\r\n' };
        if (args[0] === 'codex') return { code: 0, stdout: 'C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\n' };
        return { code: 1, stderr: 'INFO: Could not find files' };
      }
      if (args[0] === '--version') {
        if (file.includes('claude')) return { code: 0, stdout: '2.1.0 (Claude Code)\n' };
        if (file.includes('codex')) return { code: 0, stdout: 'codex-cli 0.50.0\n' };
      }
      return { code: 1 };
    });
    const detector = new RuntimeDetector({
      runner,
      terminalAvailability: () => ({ available: true }),
      platform: 'win32',
      env: {},
    });

    const status = await detector.status();
    expect(status).toEqual([
      { provider: 'claude', available: true, detail: expect.stringContaining('Claude Code 2.1.0 (Claude Code)') },
      { provider: 'codex', available: true, detail: expect.stringContaining('C:\\npm\\codex.cmd') },
      { provider: 'opencode', available: false, detail: 'OpenCode not found on PATH' },
    ]);
    expect((await detector.resolve('codex'))?.executable).toBe('C:\\npm\\codex.cmd');
    expect(runner.calls.every((c) => c.args.every((a) => !a.includes(';')))).toBe(true);
  });

  it('marks providers unavailable when the terminal backend is missing, keeping the reason', async () => {
    const runner = fakeRunner((file) => (file === 'which' ? { code: 0, stdout: '/usr/local/bin/claude\n' } : { code: 0, stdout: '1.0.0\n' }));
    const detector = new RuntimeDetector({
      runner,
      terminalAvailability: () => ({ available: false, reason: 'node-pty binary missing' }),
      platform: 'linux',
      env: {},
    });
    const [claude] = await detector.status();
    expect(claude.available).toBe(false);
    expect(claude.detail).toMatch(/found, but the terminal backend is unavailable: node-pty binary missing/);
  });

  it('coalesces concurrent lookups for one provider and caches the settled result', async () => {
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const runner = fakeRunner(async (file) => {
      if (file === 'which') {
        await lookupGate;
        return { code: 0, stdout: '/bin/opencode\n' };
      }
      return { code: 0, stdout: 'opencode 1.2.3\n' };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {}, ttlMs: 60_000 });

    const pending = [detector.resolve('opencode'), detector.resolve('opencode'), detector.resolve('opencode')];
    expect(runner.calls).toEqual([{ file: 'which', args: ['opencode'], timeoutMs: 4_000 }]);

    releaseLookup();
    const [first, second, third] = await Promise.all(pending);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(runner.calls).toEqual([
      { file: 'which', args: ['opencode'], timeoutMs: 4_000 },
      { file: '/bin/opencode', args: ['--version'], timeoutMs: 8_000 },
    ]);

    expect(await detector.resolve('opencode')).toBe(first);
    expect(runner.calls).toHaveLength(2);
  });

  it('does not serialize detection across different providers', async () => {
    let releaseOpenCode!: () => void;
    const openCodeGate = new Promise<void>((resolve) => { releaseOpenCode = resolve; });
    const runner = fakeRunner(async (file, args) => {
      if (file === 'which' && args[0] === 'opencode') {
        await openCodeGate;
        return { code: 0, stdout: '/bin/opencode\n' };
      }
      if (file === 'which') return { code: 0, stdout: `/bin/${args[0]}\n` };
      return { code: 0, stdout: '1.0.0\n' };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {} });

    const openCodePending = detector.resolve('opencode');
    await expect(detector.resolve('codex')).resolves.toEqual({ provider: 'codex', executable: '/bin/codex', version: '1.0.0' });
    releaseOpenCode();
    await expect(openCodePending).resolves.toEqual({ provider: 'opencode', executable: '/bin/opencode', version: '1.0.0' });
  });

  it('clears a rejected in-flight lookup so a later call can retry', async () => {
    let attempts = 0;
    const runner = fakeRunner((file) => {
      if (file === 'which') {
        attempts += 1;
        if (attempts === 1) throw new Error('unexpected runner failure');
        return { code: 0, stdout: '/bin/opencode\n' };
      }
      return { code: 0, stdout: 'opencode 1.2.3\n' };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {} });

    const rejected = await Promise.allSettled([detector.resolve('opencode'), detector.resolve('opencode')]);
    expect(rejected).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'unexpected runner failure' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'unexpected runner failure' }) },
    ]);

    await expect(detector.resolve('opencode')).resolves.toEqual({
      provider: 'opencode',
      executable: '/bin/opencode',
      version: 'opencode 1.2.3',
    });
    expect(attempts).toBe(2);
  });

  it('prevents an older in-flight result from repopulating the cache after invalidate', async () => {
    let releaseOld!: () => void;
    let releaseFresh!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const freshGate = new Promise<void>((resolve) => { releaseFresh = resolve; });
    let lookups = 0;
    const runner = fakeRunner(async (file) => {
      if (file === 'which') {
        lookups += 1;
        if (lookups === 1) {
          await oldGate;
          return { code: 0, stdout: '/bin/opencode-old\n' };
        }
        await freshGate;
        return { code: 0, stdout: '/bin/opencode-fresh\n' };
      }
      return { code: 0, stdout: `${file} 1.0.0\n` };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {}, ttlMs: 60_000 });

    const oldPending = detector.resolve('opencode');
    detector.invalidate();
    const freshPending = detector.resolve('opencode');
    expect(runner.calls.filter((call) => call.file === 'which')).toHaveLength(2);

    releaseFresh();
    const fresh = await freshPending;
    releaseOld();
    const old = await oldPending;
    expect(old?.executable).toBe('/bin/opencode-old');
    expect(fresh?.executable).toBe('/bin/opencode-fresh');
    expect(await detector.resolve('opencode')).toBe(fresh);
    expect(runner.calls.filter((call) => call.file === 'which')).toHaveLength(2);
  });

  it('caches lookups within the ttl and refreshes after invalidate', async () => {
    let hits = 0;
    const runner = fakeRunner((file) => {
      if (file === 'which') { hits += 1; return { code: 0, stdout: '/bin/claude\n' }; }
      return { code: 0, stdout: 'v\n' };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {}, ttlMs: 60_000 });
    await detector.status();
    await detector.status();
    expect(hits).toBe(3);
    detector.invalidate();
    await detector.status();
    expect(hits).toBe(6);
  });

  it('treats timeouts and spawn errors as not found', async () => {
    const runner = fakeRunner(() => ({ code: null, timedOut: true, error: 'ETIMEDOUT' }));
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {} });
    expect((await detector.status()).every((s) => !s.available)).toBe(true);
  });

  it('keeps POSIX paths with spaces intact from which output', async () => {
    const runner = fakeRunner((file, args) => {
      if (file === 'which') return { code: 0, stdout: '/opt/my tools/claude\n' };
      expect(file).toBe('/opt/my tools/claude');
      expect(args).toEqual(['--version']);
      return { code: 0, stdout: '2.1.0 (Claude Code)\n' };
    });
    const detector = new RuntimeDetector({ runner, terminalAvailability: () => ({ available: true }), platform: 'linux', env: {} });
    expect((await detector.resolve('claude'))?.executable).toBe('/opt/my tools/claude');
    const [claude] = await detector.status();
    expect(claude.available).toBe(true);
    expect(claude.detail).toContain('/opt/my tools/claude');
  });

  it('spawnSpecFor passes the executable through untouched on POSIX', () => {
    expect(spawnSpecFor('/opt/my tools/claude', ['--version'], 'linux')).toEqual({ file: '/opt/my tools/claude', args: ['--version'] });
    expect(spawnSpecFor('/x/foo.cmd', ['serve'], 'linux')).toEqual({ file: '/x/foo.cmd', args: ['serve'] });
    expect(spawnSpecFor('/x/foo.cmd', ['serve'], 'darwin')).toEqual({ file: '/x/foo.cmd', args: ['serve'] });
  });

  it('binary resolvers are no-ops outside win32', () => {
    const failExists = (_p: string): boolean => { throw new Error('exists must not be called on POSIX'); };
    const failReaddir = (_p: string): string[] => { throw new Error('readdir must not be called on POSIX'); };
    expect(resolveOpenCodeBinary('/x/opencode.cmd', 'linux', failExists)).toBe('/x/opencode.cmd');
    expect(resolveOpenCodeBinary('/x/opencode.cmd', 'darwin', failExists)).toBe('/x/opencode.cmd');
    expect(resolveCodexBinary('/x/codex.cmd', 'linux', failExists, failReaddir)).toBe('/x/codex.cmd');
    expect(resolveCodexBinary('/x/codex.cmd', 'darwin', failExists, failReaddir)).toBe('/x/codex.cmd');
  });
});
