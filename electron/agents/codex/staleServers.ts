import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree, type TaskkillExecFile } from '../../core/processTree';

/** One pid file per live `codex app-server` this Latte data directory has spawned, named by the same `serverKey` `codexAdapter.ts` uses. */
export function strayServerDir(dataRoot: string): string {
  return path.join(dataRoot, 'codex-app-servers');
}

function pidFile(dataRoot: string, serverKey: string): string {
  // serverKey looks like "<accountId>|<fingerprint-or-empty>"; '|' is not a valid filename char on Windows.
  const safe = serverKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(strayServerDir(dataRoot), `${safe}.pid`);
}

/** Called once a server is confirmed running. Best-effort: a failed write only means a stray from THIS run would not be swept next launch, never a functional failure now. */
export function recordServerPid(dataRoot: string, serverKey: string, pid: number): void {
  try {
    fs.mkdirSync(strayServerDir(dataRoot), { recursive: true });
    fs.writeFileSync(pidFile(dataRoot, serverKey), String(pid));
  } catch { /* best-effort */ }
}

/** Called on every clean stop and on the server's own exit notification, so a graceful shutdown leaves nothing for the next sweep. */
export function forgetServerPid(dataRoot: string, serverKey: string): void {
  try { fs.rmSync(pidFile(dataRoot, serverKey), { force: true }); } catch { /* ignore */ }
}

export interface SweepDeps {
  platform?: NodeJS.Platform;
  taskkillImpl?: TaskkillExecFile;
  log?: (line: string) => void;
}

/**
 * Startup sweep (sdd/autonomous-coordination, task 5.8): every pid file left
 * in `codex-app-servers/` names a process THIS Latte data directory spawned
 * in an earlier run that never cleaned up (a crash, a force-quit, a killed
 * window). Nothing here scans the system's whole process list or guesses
 * from a command line: the marker is "Latte's own data directory recorded
 * this pid", so a user's own manually-run `codex app-server` (VS Code
 * extension, a terminal) is never touched. Each entry is reaped with the
 * same `killProcessTree` / `taskkill /T /F` Latte already uses for its own
 * live children, then the record is removed either way -- a dead pid or one
 * the OS has since reassigned to something unrelated must not linger and be
 * "reaped" again on the next launch.
 *
 * Known limitation, same class as any pidfile scheme: if the OS reused the
 * pid for an unrelated process between the crash and this sweep, that
 * process is what gets signalled. Accepted here the same way the design
 * doc's own residual-unknowns table accepts it -- narrow window, no
 * alternative that does not scan (and potentially kill) processes Latte
 * never spawned at all.
 */
export function sweepStrayCodexServers(dataRoot: string, deps: SweepDeps = {}): number[] {
  const dir = strayServerDir(dataRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const reaped: number[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    const file = path.join(dir, entry);
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch { /* file vanished between readdir and read; nothing to reap */ }
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    deps.log?.(`[codex] reaping stray app-server pid ${pid} left by a previous run`);
    // killProcessTree wants a ChildProcess; a stray from an earlier process
    // is never one -- a minimal stand-in carries just what it reads.
    const fake = { pid, exitCode: null, signalCode: null, kill: () => {} } as unknown as Parameters<typeof killProcessTree>[0];
    killProcessTree(fake, deps.platform ?? process.platform, deps.taskkillImpl);
    reaped.push(pid);
  }
  return reaped;
}
