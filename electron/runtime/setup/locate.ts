import path from 'node:path';
import type { Provider } from '../../../shared/contracts';
import type { CommandRunner } from '../commandRunner';
import { expandCatalogPath, RUNTIME_INSTALL_CATALOG, setupOs, type RuntimeCatalogEntry } from '../runtime-install-catalog';

/** Where Latte remembers the absolute executable it installed and verified. */
export interface ExecutablePins {
  get(runtime: Provider): string | null;
  set(runtime: Provider, executable: string): void;
  clear(runtime: Provider): void;
}

const PIN_KEY = 'runtime_executable:';

/** Pins kept in the app's meta table: they survive restarts, and a missing file is simply skipped. */
export function metaPins(meta: { getMeta(key: string): string | null; setMeta(key: string, value: string): void; deleteMeta?(key: string): void }): ExecutablePins {
  return {
    get: (runtime) => {
      const value = meta.getMeta(PIN_KEY + runtime);
      return value && value.length > 0 ? value : null;
    },
    set: (runtime, executable) => meta.setMeta(PIN_KEY + runtime, executable),
    clear: (runtime) => { if (meta.deleteMeta) meta.deleteMeta(PIN_KEY + runtime); else meta.setMeta(PIN_KEY + runtime, ''); },
  };
}

/** The catalog's install locations for this OS, expanded, that exist on disk. */
export function knownInstallPaths(runtime: Provider, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean, catalog: Readonly<Record<Provider, RuntimeCatalogEntry>> = RUNTIME_INSTALL_CATALOG): string[] {
  const os = setupOs(platform);
  if (!os) return [];
  const out: string[] = [];
  for (const template of catalog[runtime].paths[os] ?? []) {
    const expanded = expandCatalogPath(template, env, platform);
    if (expanded && exists(expanded)) out.push(expanded);
  }
  return out;
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];

/**
 * The executable as a NEW shell would find it. An installer adds its folder to
 * the user's PATH, but a running app keeps the PATH it started with, so asking
 * `where` would say "not installed" until Latte restarts. On Windows the fresh
 * PATH is read from the registry through PowerShell (User + Machine); on
 * macOS/Linux a login shell answers `command -v`. `command` comes from the
 * catalog, never from input.
 */
export async function locateOnFreshPath(command: string, deps: { runner: CommandRunner; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; exists: (p: string) => boolean }): Promise<string | null> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(command)) return null;
  if (deps.platform === 'win32') {
    const root = deps.env.SystemRoot ?? deps.env.SYSTEMROOT ?? 'C:\\Windows';
    const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await deps.runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::GetEnvironmentVariable('Path','Machine')"], { timeoutMs: 8_000, env: deps.env });
    if (result.error || result.timedOut) return null;
    const dirs = result.stdout.split(/[\r\n;]+/).map((d) => d.trim()).filter((d) => d.length > 0 && path.win32.isAbsolute(d));
    for (const dir of dirs) {
      for (const ext of WINDOWS_EXTENSIONS) {
        const candidate = path.win32.join(dir, command + ext);
        if (deps.exists(candidate)) return candidate;
      }
    }
    return null;
  }
  const shell = deps.env.SHELL && path.posix.isAbsolute(deps.env.SHELL) ? deps.env.SHELL : '/bin/bash';
  const result = await deps.runner(shell, ['-lc', `command -v ${command}`], { timeoutMs: 8_000, env: deps.env });
  if (result.error || result.timedOut || result.code !== 0) return null;
  const line = result.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => path.posix.isAbsolute(l));
  return line && deps.exists(line) ? line : null;
}
