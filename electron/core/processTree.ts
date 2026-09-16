import { execFile, type ChildProcess, type SpawnOptions, type spawn } from 'node:child_process';

export type TaskkillExecFile = (
  file: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null) => void,
) => ChildProcess;

/**
 * Spawns a runtime as the leader of its own POSIX process group. Windows uses
 * taskkill for tree termination, so detached must remain unset there.
 */
export function spawnInOwnProcessGroup(
  spawnImpl: typeof spawn,
  file: string,
  args: string[],
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  if (platform === 'win32') {
    const { detached: _detached, ...windowsOptions } = options;
    return spawnImpl(file, args, windowsOptions);
  }
  return spawnImpl(file, args, { ...options, detached: true });
}

/** Stops a child and the descendants in the process tree it owns. */
export function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  taskkillImpl: TaskkillExecFile = execFile as TaskkillExecFile,
): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) return;

  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killWindowsProcessTree(child, pid, taskkillImpl);
    return;
  }

  let groupExisted = true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (!isEsrch(error)) return;
    groupExisted = false;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  const timer = setTimeout(() => {
    if (!groupExisted) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!isEsrch(error)) return;
    }
  }, 3_000);
  timer.unref();
}

function killWindowsProcessTree(
  child: ChildProcess,
  pid: number,
  taskkillImpl: TaskkillExecFile,
): void {
  const fallback = (): void => {
    try { child.kill(); } catch { /* already gone */ }
  };

  try {
    taskkillImpl(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      (error) => { if (error) fallback(); },
    );
  } catch {
    fallback();
  }
}

function isEsrch(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH';
}
