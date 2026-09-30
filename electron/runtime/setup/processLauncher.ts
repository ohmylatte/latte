import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { killProcessTree } from '../../core/processTree';
import type { SetupOs } from '../runtime-install-catalog';

/** A hidden process whose stdout and stderr arrive as one stream. Installers need no TTY; logins use the PTY instead. */
export interface LaunchedProcess {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, spawnError?: string) => void): void;
  /** Stops the process and everything it started (the installer's children too). */
  kill(): void;
}

export type ProcessLauncher = (file: string, args: readonly string[], options: { env: Record<string, string>; cwd: string }) => LaunchedProcess;

/** `child_process.spawn`, windowless, merged output, tree kill. The only real launcher; tests pass a fake. */
export function childProcessLauncher(spawnImpl: typeof nodeSpawn = nodeSpawn, platform: NodeJS.Platform = process.platform): ProcessLauncher {
  return (file, args, options) => {
    const dataListeners: Array<(c: string) => void> = [];
    const exitListeners: Array<(code: number | null, spawnError?: string) => void> = [];
    let finished = false;
    const finish = (code: number | null, spawnError?: string) => {
      if (finished) return;
      finished = true;
      for (const l of exitListeners) l(code, spawnError);
    };
    const child = spawnImpl(file, [...args], { env: options.env, cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32' });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { for (const l of dataListeners) l(c); });
    child.stderr?.on('data', (c: string) => { for (const l of dataListeners) l(c); });
    child.on('error', (error) => finish(null, `${(error as NodeJS.ErrnoException).code ?? 'ERROR'}: ${error.message}`));
    child.on('close', (code) => finish(code));
    return {
      onData: (l) => { dataListeners.push(l); },
      onExit: (l) => { exitListeners.push(l); },
      kill: () => { try { killProcessTree(child, platform); } catch { /* already gone */ } },
    };
  };
}

/**
 * How an official one-liner is run. On Windows: the system PowerShell by
 * ABSOLUTE path (a `powershell.exe` earlier on PATH is not trusted), no
 * profile, and `-ExecutionPolicy Bypass` for THIS process only — the machine
 * and user policies are left as they are. Elsewhere, `/bin/bash -c`.
 */
export function shellFor(os: SetupOs, script: string, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (os === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    return {
      file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    };
  }
  return { file: '/bin/bash', args: ['-c', script] };
}
