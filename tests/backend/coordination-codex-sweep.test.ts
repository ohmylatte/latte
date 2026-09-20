import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskkillExecFile } from '../../electron/core/processTree';
import { createBackend, type Backend } from '../../electron/bootstrap';
import { forgetServerPid, recordServerPid, strayServerDir, sweepStrayCodexServers } from '../../electron/agents/codex/staleServers';
import { notFoundRunner, brokenPtyLoader, makeTempDir, removeDir } from './helpers';

/**
 * sdd/autonomous-coordination, task 5.8: a crash (or a force-quit) can leave
 * a `codex app-server` process running after Latte itself is gone. The
 * marker is "this Latte data directory recorded the pid", never a
 * system-wide process-list guess -- so a user's own manually-run
 * `codex app-server` (VS Code, a terminal) is never touched. See
 * staleServers.ts for the full rationale.
 */
describe('staleServers: recordServerPid / forgetServerPid / sweepStrayCodexServers (pure, injectable)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { removeDir(dir); });

  it('records a pid file under codex-app-servers/ and forgetServerPid removes it', () => {
    recordServerPid(dir, 'system|abc123', 4242);
    const files = fs.readdirSync(strayServerDir(dir));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(strayServerDir(dir), files[0]), 'utf8')).toBe('4242');

    forgetServerPid(dir, 'system|abc123');
    expect(fs.readdirSync(strayServerDir(dir))).toEqual([]);
  });

  it('sweeps every recorded pid on startup: reaps each one via taskkill/killProcessTree and always removes the record', () => {
    recordServerPid(dir, 'system|', 1111);
    recordServerPid(dir, 'system|coordfingerprint', 2222);
    const killed: Array<{ pid: string }> = [];
    const taskkillImpl: TaskkillExecFile = (file, args, options, callback) => {
      killed.push({ pid: args[args.indexOf('/PID') + 1] });
      callback(null);
      return {} as ReturnType<TaskkillExecFile>;
    };
    const reaped = sweepStrayCodexServers(dir, { platform: 'win32', taskkillImpl });
    expect(reaped.sort()).toEqual([1111, 2222]);
    expect(killed.map((k) => k.pid).sort()).toEqual(['1111', '2222']);
    // Every record is gone, whether or not the pid was still alive.
    expect(fs.readdirSync(strayServerDir(dir))).toEqual([]);
  });

  it('a fresh data directory (no prior run) sweeps nothing and never creates the directory itself', () => {
    expect(sweepStrayCodexServers(dir)).toEqual([]);
    expect(fs.existsSync(strayServerDir(dir))).toBe(false);
  });

  it('ignores non-pid files and a corrupt pid value without throwing', () => {
    fs.mkdirSync(strayServerDir(dir), { recursive: true });
    fs.writeFileSync(path.join(strayServerDir(dir), 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(strayServerDir(dir), 'garbage.pid'), 'not-a-number');
    const reaped = sweepStrayCodexServers(dir, { platform: 'win32', taskkillImpl: (f, a, o, cb) => { cb(null); return {} as never; } });
    expect(reaped).toEqual([]);
    expect(fs.existsSync(path.join(strayServerDir(dir), 'notes.txt'))).toBe(true); // untouched, not a pid record
    expect(fs.existsSync(path.join(strayServerDir(dir), 'garbage.pid'))).toBe(false); // removed even though unusable
  });
});

describe('bootstrap wiring: createBackend sweeps stray codex app-servers on startup', () => {
  let backend: Backend | undefined;
  let dir: string;
  afterEach(() => { try { backend?.service.shutdown(); } catch { /* already closed */ } removeDir(dir); });

  it('reaps a pid file left by a previous crashed run before the fresh backend is usable', async () => {
    dir = makeTempDir();
    recordServerPid(dir, 'system|stale', 987654);
    const killed: string[] = [];
    backend = await createBackend({
      dataDir: dir,
      version: '0.0.0-test',
      emit: () => {},
      chooseExportPath: async () => null,
      seedDemo: false,
      runner: notFoundRunner,
      loadPty: brokenPtyLoader,
      // La plataforma es del test, no del runner: en win32 la muerte entera
      // pasa por el `taskkillImpl` inyectado acá, así que lo que se observa no
      // depende de si el pid 987654 existe en esta máquina. Sin fijarla, un
      // runner POSIX entraba por `process.kill(-pid)`, cobraba ESRCH contra un
      // pid inexistente y no llamaba a taskkill nunca: `killed` quedaba vacío
      // en Linux y lleno en Windows por el sistema operativo, no por el test.
      platform: 'win32',
      taskkillImpl: (file, args, options, callback) => {
        killed.push(args[args.indexOf('/PID') + 1]);
        callback(null);
        return {} as never;
      },
    });
    expect(killed).toEqual(['987654']);
    expect(fs.readdirSync(strayServerDir(dir))).toEqual([]);
  });
});
