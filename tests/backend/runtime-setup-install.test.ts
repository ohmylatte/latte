import { describe, expect, it } from 'vitest';
import type { RuntimeInstallJob } from '../../shared/contracts';
import { RuntimeSetupService } from '../../electron/runtime/setup/runtimeSetup';
import { RUNTIME_INSTALL_CATALOG } from '../../electron/runtime/runtime-install-catalog';
import { LIMITS, settleAll, setupHarness } from './runtime-setup-fakes';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CLAUDE_EXE = 'C:\\Users\\ana\\.local\\bin\\claude.exe';

function states(events: Array<{ kind: string; state: unknown }>): unknown[] {
  return events.filter((e) => e.kind === 'install').map((e) => e.state);
}

describe('RuntimeSetupService: install', () => {
  it('ends at found without installing anything when the runtime is already there', async () => {
    const h = setupHarness();
    h.resolved.set('claude', { executable: CLAUDE_EXE, version: '2.1.211 (Claude Code)' });
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    expect(h.launched).toHaveLength(0);
    expect(states(h.events)).toEqual([{ state: 'detecting' }, { state: 'found', version: '2.1.211 (Claude Code)', executable: CLAUDE_EXE }]);
    expect(setup.getJob(job.jobId)).toMatchObject({ done: true, state: { state: 'found' } });
    // "Buscar de nuevo" asks the detector fresh, never a 30 s old cache.
    expect(h.invalidations).toBeGreaterThan(0);
  });

  it('runs the official Windows one-liner in a hidden PowerShell with Bypass scoped to that process, then verifies and pins the absolute path', async () => {
    const h = setupHarness({ runner: (file, args) => (file === CLAUDE_EXE && args[0] === '--version' ? { code: 0, stdout: '2.1.211 (Claude Code)\n' } : { code: 1 }) });
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    expect(h.launched).toHaveLength(1);
    const proc = h.launched[0];
    expect(proc.file).toBe(POWERSHELL);
    expect(proc.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RUNTIME_INSTALL_CATALOG.claude.install.win32!.script]);
    expect(proc.args).toContain('irm https://claude.ai/install.ps1 | iex');

    proc.print('\u001b[32mDownloading Claude Code…\u001b[0m\r\n');
    h.files.add(CLAUDE_EXE); // the installer left the binary where the docs say
    proc.exit(0);
    await settleAll();

    expect(states(h.events)).toEqual([
      { state: 'detecting' },
      { state: 'installing', phase: 'downloading' },
      { state: 'installing', phase: 'checking' },
      { state: 'installed', version: '2.1.211 (Claude Code)', executable: CLAUDE_EXE },
    ]);
    // Absolute path remembered: nothing depends on this process' stale PATH.
    expect(h.pins.get('claude')).toBe(CLAUDE_EXE);
    expect(setup.transcript(job.jobId)).toContain('Downloading Claude Code…');
    expect(setup.transcript(job.jobId)).not.toContain('\u001b[');
  });

  it('finds an executable the docs do not locate through the fresh user PATH (Codex)', async () => {
    const npmDir = 'C:\\Users\\ana\\.codex\\bin';
    const h = setupHarness({
      runner: (file, args) => {
        if (file === POWERSHELL && args.join(' ').includes("GetEnvironmentVariable('Path','User')")) return { code: 0, stdout: `C:\\Windows\\system32;${npmDir}\r\nC:\\Program Files\\Git\\cmd\r\n` };
        if (file === `${npmDir}\\codex.exe` && args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.90.0\n' };
        return { code: 1 };
      },
    });
    const setup = new RuntimeSetupService(h.deps);
    await setup.startInstall('codex', null);
    await settleAll();
    expect(h.launched[0].args).toContain('irm https://chatgpt.com/codex/install.ps1 | iex');
    h.files.add(`${npmDir}\\codex.exe`);
    h.launched[0].exit(0);
    await settleAll();
    expect(states(h.events).at(-1)).toEqual({ state: 'installed', version: 'codex-cli 0.90.0', executable: `${npmDir}\\codex.exe` });
    expect(h.pins.get('codex')).toBe(`${npmDir}\\codex.exe`);
  });

  it('uses bash and the POSIX one-liner on macOS', async () => {
    const h = setupHarness({ platform: 'darwin', arch: 'arm64', env: { HOME: '/Users/ana' } });
    const setup = new RuntimeSetupService(h.deps);
    await setup.startInstall('grok', null);
    await settleAll();
    expect(h.launched[0].file).toBe('/bin/bash');
    expect(h.launched[0].args).toEqual(['-c', 'curl -fsSL https://x.ai/cli/install.sh | bash']);
  });

  it.each([
    ['blocked_by_policy', 'iex : File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system.\r\n    + FullyQualifiedErrorId : UnauthorizedAccess'],
    ['blocked_by_antivirus', 'Operation did not complete successfully because the file contains a virus or potentially unwanted software.'],
    ['network', "irm : The remote name could not be resolved: 'claude.ai'"],
    ['unknown', 'Something odd happened'],
  ] as const)('maps a failed installer to %s with a short detail, never the whole dump', async (code, output) => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    h.launched[0].print(`${'noise line\n'.repeat(50)}${output}\n`);
    h.launched[0].exit(1);
    await settleAll();
    const last = setup.getJob(job.jobId) as RuntimeInstallJob;
    expect(last.done).toBe(true);
    expect(last.state).toMatchObject({ state: 'failed', code, guideUrl: 'https://code.claude.com/docs/en/setup' });
    if (last.state.state !== 'failed') throw new Error('unreachable');
    expect(last.state.detail.length).toBeLessThanOrEqual(301);
    expect(last.state.detail).not.toContain('noise line · noise line · noise line · noise line');
    expect(setup.transcript(job.jobId)).toContain(output.split('\r\n')[0].slice(0, 40));
  });

  it('reports not_found_after_install when the installer exits 0 but nothing runs afterwards', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    h.launched[0].exit(0);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'not_found_after_install' });
  });

  it('never runs an unverified installer: it points at the official guide instead', async () => {
    const h = setupHarness();
    const catalog = { ...RUNTIME_INSTALL_CATALOG, grok: { ...RUNTIME_INSTALL_CATALOG.grok, install: { win32: { ...RUNTIME_INSTALL_CATALOG.grok.install.win32!, verified: false } } } };
    const setup = new RuntimeSetupService({ ...h.deps, catalog });
    const job = await setup.startInstall('grok', null);
    await settleAll();
    expect(h.launched).toHaveLength(0);
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'unverified_installer', guideUrl: 'https://docs.x.ai/build/overview' });
  });

  it('refuses platforms the official installer does not support (Hermes on Intel macOS)', async () => {
    const h = setupHarness({ platform: 'darwin', arch: 'x64', env: { HOME: '/Users/ana' } });
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('hermes', null);
    await settleAll();
    expect(h.launched).toHaveLength(0);
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'unsupported_platform' });
  });

  it('stops at needs_prereq for a required prerequisite, and fails as prereq_missing if Latte cannot install it', async () => {
    const h = setupHarness(); // no npm anywhere
    const setup = new RuntimeSetupService(h.deps);
    const first = await setup.startInstall('opencode', null);
    await settleAll();
    expect(h.launched).toHaveLength(0);
    expect(setup.getJob(first.jobId)).toMatchObject({ done: true, state: { state: 'needs_prereq', prereq: 'node', canInstall: false, guideUrl: 'https://nodejs.org/en/download' } });
    const second = await setup.startInstall('opencode', { installPrereqs: true });
    await settleAll();
    expect(h.launched).toHaveLength(0);
    expect(setup.getJob(second.jobId).state).toMatchObject({ state: 'failed', code: 'prereq_missing' });
  });

  it('never blocks on Git for Windows (optional for Claude Code), and installs it with winget only when asked', async () => {
    const h = setupHarness({ runner: (file, args) => (file === 'where.exe' && args[0] === 'winget' ? { code: 0, stdout: 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe\r\n' } : { code: 1 }) });
    const setup = new RuntimeSetupService(h.deps);
    await setup.startInstall('claude', null);
    await settleAll();
    expect(h.launched).toHaveLength(1);
    expect(h.launched[0].file).toBe(POWERSHELL);
    h.launched[0].exit(1);
    await settleAll();

    h.events.length = 0;
    await setup.startInstall('claude', { installPrereqs: true });
    await settleAll();
    expect(h.launched[1].file).toBe('C:\\Users\\ana\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe');
    expect(h.launched[1].args.slice(0, 6)).toEqual(['install', '--id', 'Git.Git', '-e', '--source', 'winget']);
    expect(states(h.events)).toContainEqual({ state: 'installing', phase: 'prereq' });
    h.launched[1].exit(0);
    await settleAll();
    expect(h.launched[2].file).toBe(POWERSHELL);
  });

  it('cancels: kills the installer tree and ignores its late exit', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    const cancelled = setup.cancelInstall(job.jobId);
    expect(h.launched[0].killed).toBe(true);
    expect(cancelled).toMatchObject({ done: true, state: { state: 'cancelled' } });
    h.launched[0].exit(1);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toEqual({ state: 'cancelled' });
  });

  it('times out a hung installer', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startInstall('claude', null);
    await settleAll();
    h.scheduler.fire(LIMITS.installTimeoutMs);
    await settleAll();
    expect(h.launched[0].killed).toBe(true);
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'timeout' });
  });

  it('returns the running job instead of starting a second installer', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const a = await setup.startInstall('claude', null);
    await settleAll();
    const b = await setup.startInstall('claude', null);
    expect(b.jobId).toBe(a.jobId);
    expect(h.launched).toHaveLength(1);
  });

  it('detectRuntime answers found / not_found without installing', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    expect(await setup.detect('claude')).toEqual({ state: 'not_found', canInstall: true, guideUrl: 'https://code.claude.com/docs/en/setup' });
    h.resolved.set('claude', { executable: CLAUDE_EXE, version: '2.1.211' });
    expect(await setup.detect('claude')).toEqual({ state: 'found', version: '2.1.211', executable: CLAUDE_EXE });
    expect(h.launched).toHaveLength(0);
  });

  it('describes what it can do per runtime on this OS', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const info = await setup.catalogInfo();
    expect(info.map((i) => i.runtime)).toEqual(['claude', 'codex', 'opencode', 'grok', 'hermes']);
    expect(info.find((i) => i.runtime === 'claude')).toMatchObject({ canInstall: true, browserLogin: true, prereqs: [{ prereq: 'git_for_windows', required: false, present: false, canInstall: false }] });
    expect(info.find((i) => i.runtime === 'hermes')).toMatchObject({ browserLogin: false });
    expect(info.find((i) => i.runtime === 'opencode')).toMatchObject({ browserLogin: false, prereqs: [{ prereq: 'node', required: true }] });
    for (const entry of info) expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('runtime install catalog', () => {
  it('keeps every command an https one-liner with a source and a date', () => {
    for (const entry of Object.values(RUNTIME_INSTALL_CATALOG)) {
      expect(entry.guideUrl).toMatch(/^https:\/\//);
      for (const command of Object.values(entry.install)) {
        expect(command!.source).toMatch(/^https:\/\//);
        expect(command!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(command!.script).not.toMatch(/http:\/\//);
      }
    }
  });
});
