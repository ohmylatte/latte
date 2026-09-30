import path from 'node:path';
import type { Provider, RuntimeStatus } from '../../shared/contracts';
import type { CommandRunner } from './commandRunner';
import { PROVIDER_LABEL, PROVIDERS } from './providers';

export interface ResolvedRuntime {
  provider: Provider;
  /** Absolute path of the executable as found on PATH. */
  executable: string;
  version: string | null;
}

export interface TerminalAvailability {
  available: boolean;
  reason?: string;
}

export interface RuntimeDetectorDeps {
  runner: CommandRunner;
  terminalAvailability: () => TerminalAvailability;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  ttlMs?: number;
  lookupTimeoutMs?: number;
  versionTimeoutMs?: number;
  /** The absolute executable Latte installed and verified (onboarding sin terminal). Tried first; a file that is gone or no longer runs is dropped. */
  pinned?: (provider: Provider) => string | null;
  /** Forgets a pin that points at a dead executable, so the next lookup starts from PATH and the official locations. */
  clearPinned?: (provider: Provider) => void;
  /** The official installers' own locations that exist, for a PATH this process has not seen yet. Tried after PATH. */
  knownPaths?: (provider: Provider) => string[];
  exists?: (target: string) => boolean;
}

const WINDOWS_PREFERENCE = ['.exe', '.cmd', '.bat', ''];

function rankWindowsCandidate(candidate: string): number {
  const ext = path.win32.extname(candidate).toLowerCase();
  const index = WINDOWS_PREFERENCE.indexOf(ext);
  return index === -1 ? WINDOWS_PREFERENCE.length : index;
}

/**
 * Finds allowlisted CLIs on PATH and checks the terminal backend. Results are
 * cached briefly because the UI may poll and `where`/`--version` cost real time.
 */
export class RuntimeDetector {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ttlMs: number;
  private cache = new Map<Provider, { at: number; value: ResolvedRuntime | null }>();
  private inflight = new Map<Provider, Promise<ResolvedRuntime | null>>();
  private generation = 0;

  constructor(private readonly deps: RuntimeDetectorDeps) {
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
    this.ttlMs = deps.ttlMs ?? 30_000;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.inflight.clear();
  }

  async status(): Promise<RuntimeStatus[]> {
    const terminal = this.deps.terminalAvailability();
    const resolved = await Promise.all(PROVIDERS.map((p) => this.resolve(p)));
    return PROVIDERS.map((provider, i) => {
      const found = resolved[i];
      const label = PROVIDER_LABEL[provider];
      if (!found) {
        return { provider, available: false, code: 'not_installed', detail: `${label} not installed` };
      }
      const version = found.version ? ` ${found.version}` : '';
      if (!terminal.available) {
        return {
          provider,
          available: false,
          code: 'terminal_unavailable',
          detail: `${label}${version} found, but the terminal backend is unavailable: ${terminal.reason ?? 'unknown reason'}`,
        };
      }
      return { provider, available: true, detail: `${label}${version} · ${found.executable}` };
    });
  }

  async resolve(provider: Provider): Promise<ResolvedRuntime | null> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.value;
    const existing = this.inflight.get(provider);
    if (existing) return existing;

    const generation = this.generation;
    const pending = this.detect(provider)
      .then((value) => {
        if (this.generation === generation) this.cache.set(provider, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(provider) === pending) this.inflight.delete(provider);
      });
    this.inflight.set(provider, pending);
    return pending;
  }

  /**
   * Pin, then PATH, then the official installers' own folders. Every candidate
   * is run with `--version` on every lookup: a stored path is a hint, never
   * proof. A pin whose file is gone or that no longer runs is dropped (and
   * forgotten); a PATH or known candidate that cannot even start is skipped.
   * A version check that only timed out still counts: a first run under a
   * virus scan can be slow, and the file is there.
   */
  private async detect(provider: Provider): Promise<ResolvedRuntime | null> {
    const pinned = this.deps.pinned?.(provider) ?? null;
    if (pinned) {
      const probe = this.pinnedIsAbsolute(pinned) && (this.deps.exists?.(pinned) ?? false) ? await this.probe(pinned) : null;
      if (probe && probe.alive && probe.exitedCleanly) return { provider, executable: pinned, version: probe.version };
      this.deps.clearPinned?.(provider);
    }
    const onPath = await this.locate(provider);
    if (onPath) {
      const probe = await this.probe(onPath);
      if (probe.alive) return { provider, executable: onPath, version: probe.version };
    }
    for (const known of this.deps.knownPaths?.(provider) ?? []) {
      if (known === onPath) continue;
      const probe = await this.probe(known);
      if (probe.alive) return { provider, executable: known, version: probe.version };
    }
    return null;
  }

  private pinnedIsAbsolute(pinned: string): boolean {
    return (this.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute)(pinned);
  }

  private async locate(command: string): Promise<string | null> {
    const isWindows = this.platform === 'win32';
    const result = await this.deps.runner(isWindows ? 'where.exe' : 'which', [command], {
      timeoutMs: this.deps.lookupTimeoutMs ?? 4_000,
      env: this.env,
    });
    if (result.error || result.timedOut || result.code !== 0) return null;
    const isAbsolute = isWindows ? path.win32.isAbsolute : path.posix.isAbsolute;
    const candidates = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && isAbsolute(line));
    if (candidates.length === 0) return null;
    if (!isWindows) return candidates[0];
    return [...candidates].sort((a, b) => rankWindowsCandidate(a) - rankWindowsCandidate(b))[0];
  }

  /** `--version` once. `alive` = the file started; `exitedCleanly` = it answered with exit 0. */
  private async probe(executable: string): Promise<{ alive: boolean; exitedCleanly: boolean; version: string | null }> {
    const result = await this.deps.runner(executable, ['--version'], {
      timeoutMs: this.deps.versionTimeoutMs ?? 8_000,
      env: this.env,
    });
    if (result.timedOut) return { alive: true, exitedCleanly: true, version: null };
    if (result.error) return { alive: false, exitedCleanly: false, version: null };
    const line = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return { alive: true, exitedCleanly: result.code === 0, version: line ? line.slice(0, 120) : null };
  }
}
