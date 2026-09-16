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
        return { provider, available: false, detail: `${label} not found on PATH` };
      }
      const version = found.version ? ` ${found.version}` : '';
      if (!terminal.available) {
        return {
          provider,
          available: false,
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

  private async detect(provider: Provider): Promise<ResolvedRuntime | null> {
    const executable = await this.locate(provider);
    if (!executable) return null;
    const version = await this.readVersion(executable);
    return { provider, executable, version };
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

  private async readVersion(executable: string): Promise<string | null> {
    const result = await this.deps.runner(executable, ['--version'], {
      timeoutMs: this.deps.versionTimeoutMs ?? 8_000,
      env: this.env,
    });
    if (result.error || result.timedOut) return null;
    const line = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ? line.slice(0, 120) : null;
  }
}
