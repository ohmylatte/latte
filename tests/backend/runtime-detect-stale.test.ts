import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeDetector } from '../../electron/runtime/detect';
import { knownInstallPaths } from '../../electron/runtime/setup/locate';
import { AccountStore, SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import type { Provider } from '../../shared/contracts';
import { fakeRunner, makeTempDir, removeDir } from './helpers';

/**
 * QA del dueño (2026-09-28): "desinstalé Codex con npm y la tarjeta sigue en
 * Conectado". Un camino guardado es una pista, nunca una prueba: cada
 * detección lo vuelve a correr, y "Conectado" pide un ejecutable que
 * funciona Y una sesión que ese ejecutable confirma.
 */

const HOME = 'C:\\Users\\ana';
const LOCAL = `${HOME}\\AppData\\Local`;
const VISIBLE_BIN = `${LOCAL}\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
const CURRENT = `${HOME}\\.codex\\packages\\standalone\\current\\bin\\codex.exe`;
const RELEASES = `${HOME}\\.codex\\packages\\standalone\\releases`;
const ENV = { USERPROFILE: HOME, LOCALAPPDATA: LOCAL };

function detectorWith(opts: { files: string[]; dirs?: Record<string, string[]>; pin?: string | null; where?: string | null; versions?: Record<string, string> }) {
  let pin = opts.pin ?? null;
  const cleared: Provider[] = [];
  const files = new Set(opts.files);
  const runner = fakeRunner((file, args) => {
    if (file === 'where.exe') return opts.where && args[0] === 'codex' ? { code: 0, stdout: `${opts.where}\r\n` } : { code: 1, stderr: 'INFO: Could not find files' };
    if (args[0] === '--version') {
      // A deleted file cannot start: the spawn itself fails, as in production.
      if (!files.has(file)) return { code: null, error: `spawn ${file} ENOENT` };
      return { code: 0, stdout: `${opts.versions?.[file] ?? 'codex-cli 0.158.0'}\n` };
    }
    return { code: 1 };
  });
  const exists = (p: string) => files.has(p);
  const detector = new RuntimeDetector({
    runner,
    terminalAvailability: () => ({ available: true }),
    platform: 'win32',
    env: ENV,
    pinned: (p) => (p === 'codex' ? pin : null),
    clearPinned: (p) => { cleared.push(p); pin = null; },
    knownPaths: (p) => knownInstallPaths(p, ENV, 'win32', exists, undefined, (dir) => opts.dirs?.[dir] ?? []),
    exists,
  });
  return { detector, runner, cleared, files, pin: () => pin };
}

describe('Codex detection after the npm copy is gone', () => {
  it('(a) drops a stored path whose file was deleted and re-locates, forgetting the pin', async () => {
    const npmShim = 'C:\\Users\\ana\\AppData\\Roaming\\npm\\codex.cmd';
    const h = detectorWith({ files: [], pin: npmShim });
    expect(await h.detector.resolve('codex')).toBeNull();
    expect(h.cleared).toEqual(['codex']);
    expect(h.pin()).toBeNull();
    // Never probed a file that is not there as if it were the runtime.
    expect(h.runner.calls.some((c) => c.file === npmShim)).toBe(false);
  });

  it('(a) drops a stored path that is still on disk but no longer runs, and uses the next real one', async () => {
    const broken = 'C:\\old\\codex.exe';
    const cleared: Provider[] = [];
    // The broken file is on disk, but its --version fails.
    const exists = new Set([broken, VISIBLE_BIN]);
    const detector = new RuntimeDetector({
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe') return { code: 1 };
        if (args[0] === '--version') return file === broken ? { code: 1, stderr: 'The system cannot execute the specified program.' } : { code: 0, stdout: 'codex-cli 0.158.0\n' };
        return { code: 1 };
      }),
      terminalAvailability: () => ({ available: true }),
      platform: 'win32',
      env: ENV,
      pinned: () => broken,
      clearPinned: (p) => { cleared.push(p); },
      knownPaths: (p) => knownInstallPaths(p, ENV, 'win32', (f) => exists.has(f)),
      exists: (f) => exists.has(f),
    });
    expect(await detector.resolve('codex')).toEqual({ provider: 'codex', executable: VISIBLE_BIN, version: 'codex-cli 0.158.0' });
    expect(cleared).toEqual(['codex']);
  });

  it('(a) re-validates on every lookup: a file removed after the first detection is not reported installed', async () => {
    const h = detectorWith({ files: [VISIBLE_BIN] });
    expect((await h.detector.resolve('codex'))?.executable).toBe(VISIBLE_BIN);
    h.files.delete(VISIBLE_BIN);
    h.detector.invalidate();
    expect(await h.detector.resolve('codex')).toBeNull();
  });

  it('(c) finds the official standalone install outside PATH, with its version', async () => {
    const h = detectorWith({ files: [VISIBLE_BIN, CURRENT] });
    const status = await h.detector.status();
    const codex = status.find((s) => s.provider === 'codex')!;
    expect(codex.available).toBe(true);
    expect(codex.detail).toBe(`Codex CLI codex-cli 0.158.0 · ${VISIBLE_BIN}`);
  });

  it('(c) without the visible bin or `current`, prefers the newest unpacked release', async () => {
    const older = `${RELEASES}\\0.99.1-x86_64-pc-windows-msvc\\bin\\codex.exe`;
    const newer = `${RELEASES}\\0.158.0-x86_64-pc-windows-msvc\\bin\\codex.exe`;
    const h = detectorWith({
      files: [older, newer],
      dirs: { [RELEASES]: ['0.99.1-x86_64-pc-windows-msvc', '.staging.0.160.0-x86_64-pc-windows-msvc.123', '0.158.0-x86_64-pc-windows-msvc'] },
      versions: { [older]: 'codex-cli 0.99.1', [newer]: 'codex-cli 0.158.0' },
    });
    expect(await h.detector.resolve('codex')).toEqual({ provider: 'codex', executable: newer, version: 'codex-cli 0.158.0' });
  });

  it('(c) the catalog lists the installer folders in order, honoring CODEX_HOME and CODEX_INSTALL_DIR', () => {
    const custom = { ...ENV, CODEX_HOME: 'D:\\codex-home', CODEX_INSTALL_DIR: 'D:\\bin' };
    const all = () => true;
    expect(knownInstallPaths('codex', custom, 'win32', all)).toEqual([
      'D:\\bin\\codex.exe',
      VISIBLE_BIN,
      'D:\\codex-home\\packages\\standalone\\current\\bin\\codex.exe',
      CURRENT,
    ]);
    expect(knownInstallPaths('codex', { HOME: '/home/ana' }, 'linux', all)).toEqual([
      '/home/ana/.local/bin/codex',
      '/home/ana/.codex/packages/standalone/current/bin/codex',
    ]);
  });
});

describe('"Conectado" needs a working Codex, not just auth.json', () => {
  let root: string | null = null;
  afterEach(() => { if (root) removeDir(root); root = null; });

  it('(b) auth.json present but no executable → not logged in, and no status command runs', async () => {
    root = makeTempDir();
    const codexHome = path.join(root, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
    const h = detectorWith({ files: [], pin: 'C:\\gone\\codex.exe' });
    const accounts = new AccountStore({
      root: path.join(root, 'accounts'),
      runner: h.runner,
      resolveExecutable: async (runtime) => (await h.detector.resolve(runtime))?.executable ?? null,
      env: { CODEX_HOME: codexHome },
    });
    const described = await accounts.describe('codex');
    expect(described).toEqual([expect.objectContaining({ id: SYSTEM_ACCOUNT_ID, loggedIn: false })]);
    expect(h.runner.calls.some((c) => c.args[0] === 'login')).toBe(false);
  });
});
