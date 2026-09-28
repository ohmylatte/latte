import type { AgentEvent, AgentSession, Provider } from '../../shared/contracts';
import { NotFoundError, UnavailableError, ValidationError } from '../core/errors';
import { newId } from '../core/ids';
import { spawnSpecFor } from './commandRunner';
import type { PtyLoadResult, PtyModuleLike, PtyProcessLike } from './ptyLoader';

export interface StartSessionInput {
  workId: string;
  brandId: string;
  provider: Provider;
  /** Absolute path of an allowlisted executable, resolved by RuntimeDetector. */
  executable: string;
  /** Fixed arguments chosen by Latte (never user input), e.g. ['auth', 'login']. */
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  /** Extra environment for the agent (e.g. ENGRAM_PROJECT scoped to the brand). */
  extraEnv?: Record<string, string>;
  /**
   * In-process listener for a HIDDEN session (the browser login): Latte reads
   * the output to capture the login URL. The renderer still gets the same
   * events, so "Ver detalle" and the embedded-terminal fallback attach to the
   * very same live session.
   */
  observer?: { onData?: (data: string) => void; onExit?: (exitCode: number) => void };
}

export interface TerminalManagerDeps {
  loadPty: () => PtyLoadResult;
  emit: (event: AgentEvent) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxSessions?: number;
}

interface LiveSession {
  session: AgentSession;
  pty: PtyProcessLike;
  disposables: Array<{ dispose(): void }>;
  exited: boolean;
}

export const MAX_WRITE_CHUNK = 64 * 1024;

/**
 * Variables that would bind a child agent to the session that launched Latte
 * (an Orca dispatch, a parent Claude Code run). Agents must start clean.
 */
export const SCRUBBED_ENV_PREFIXES = ['ORCA_', 'CLAUDE_CODE_'];
export const SCRUBBED_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'ENGRAM_PROJECT'];
/**
 * Profile redirections. A user may set these on purpose, so they are kept,
 * EXCEPT when Latte itself was launched from inside another orchestrator
 * (Orca sets ORCA_*): then they point at that app's private accounts and
 * would silently bind Latte's agents to someone else's profiles.
 */
export const ORCHESTRATOR_PROFILE_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR'];

export function scrubEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  const insideOrchestrator = Object.keys(source).some((key) => key.toUpperCase().startsWith('ORCA_'));
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (SCRUBBED_ENV_KEYS.includes(upper)) continue;
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    if (insideOrchestrator && ORCHESTRATOR_PROFILE_KEYS.includes(upper)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Owns real PTY sessions. Each session runs one allowlisted CLI inside an
 * app-managed work directory. Output is streamed to the renderer as events;
 * the manager never buffers output for later replay (keeps memory bounded).
 */
export class TerminalManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxSessions: number;

  constructor(private readonly deps: TerminalManagerDeps) {
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
    this.maxSessions = deps.maxSessions ?? 8;
  }

  availability(): { available: boolean; reason?: string } {
    const loaded = this.deps.loadPty();
    return loaded.ok ? { available: true } : { available: false, reason: loaded.error };
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].map((s) => s.session);
  }

  start(input: StartSessionInput): AgentSession {
    const loaded = this.deps.loadPty();
    if (!loaded.ok) {
      throw new UnavailableError(`Terminal backend unavailable: ${loaded.error}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new ValidationError(`Too many open agent sessions (max ${this.maxSessions})`);
    }
    const cols = clampInt(input.cols ?? 100, 20, 500);
    const rows = clampInt(input.rows ?? 30, 5, 300);
    const spec = spawnSpecFor(input.executable, input.args ?? [], this.platform, this.env);
    const session: AgentSession = { id: newId('ses'), provider: input.provider, workId: input.workId };

    let pty: PtyProcessLike;
    try {
      pty = (loaded.module as PtyModuleLike).spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: input.cwd,
        env: this.buildEnv(input),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UnavailableError(`Could not start ${input.provider}: ${message}`);
    }

    const live: LiveSession = { session, pty, disposables: [], exited: false };
    live.disposables.push(
      pty.onData((data) => {
        this.deps.emit({ sessionId: session.id, type: 'output', data });
        try { input.observer?.onData?.(data); } catch { /* an observer never breaks the terminal */ }
      }),
      pty.onExit(({ exitCode, signal }) => {
        live.exited = true;
        this.cleanup(session.id);
        const suffix = signal ? ` (signal ${signal})` : '';
        this.deps.emit({ sessionId: session.id, type: 'exit', data: `${exitCode}${suffix}` });
        try { input.observer?.onExit?.(exitCode); } catch { /* same */ }
      }),
    );
    this.sessions.set(session.id, live);
    return session;
  }

  write(sessionId: string, data: string): void {
    const live = this.require(sessionId);
    if (data.length > MAX_WRITE_CHUNK) throw new ValidationError('Terminal input chunk too large');
    live.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.require(sessionId);
    live.pty.resize(clampInt(cols, 20, 500), clampInt(rows, 5, 300));
  }

  stop(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return; // already gone: stopping twice is not an error
    try {
      live.pty.kill();
    } catch (error) {
      this.deps.emit({ sessionId, type: 'error', data: `Failed to stop session: ${error instanceof Error ? error.message : String(error)}` });
    }
    this.cleanup(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  /** Terminals a restart would kill. Used to warn before an update installs. */
  liveCount(): number {
    return this.sessions.size;
  }

  private require(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new NotFoundError('Agent session', sessionId);
    return live;
  }

  private cleanup(sessionId: string): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    for (const d of live.disposables) {
      try { d.dispose(); } catch { /* listener already gone */ }
    }
    this.sessions.delete(sessionId);
  }

  private buildEnv(input: StartSessionInput): Record<string, string> {
    const env = scrubEnv(this.env);
    Object.assign(env, input.extraEnv ?? {});
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.LATTE_WORK_ID = input.workId;
    env.LATTE_BRAND_ID = input.brandId;
    env.LATTE_PROVIDER = input.provider;
    return env;
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
