import type { AgentAccount, AgentSession, RuntimeSetupEvent } from '../../shared/contracts';
import type { ProcessLauncher } from '../../electron/runtime/setup/processLauncher';
import type { RuntimeSetupDeps } from '../../electron/runtime/setup/runtimeSetup';
import type { StartSessionInput } from '../../electron/runtime/terminalManager';
import { UnavailableError } from '../../electron/core/errors';
import { fakeRunner, type FakeCommand } from './helpers';

/** A launched installer that never runs anything: the test drives its output and exit. */
export class FakeProcess {
  readonly data: Array<(c: string) => void> = [];
  readonly exits: Array<(code: number | null, err?: string) => void> = [];
  killed = false;
  constructor(readonly file: string, readonly args: readonly string[], readonly env: Record<string, string>) {}
  print(chunk: string): void { for (const l of this.data) l(chunk); }
  exit(code: number | null, err?: string): void { for (const l of this.exits) l(code, err); }
}

export function fakeLauncher(): { launch: ProcessLauncher; launched: FakeProcess[] } {
  const launched: FakeProcess[] = [];
  const launch: ProcessLauncher = (file, args, options) => {
    const proc = new FakeProcess(file, args, options.env);
    launched.push(proc);
    return {
      onData: (l) => { proc.data.push(l); },
      onExit: (l) => { proc.exits.push(l); },
      kill: () => { proc.killed = true; },
    };
  };
  return { launch, launched };
}

/** A hidden login terminal: records what was started and lets the test print into it. */
export class FakeLoginTerminal {
  readonly started: Array<StartSessionInput & { id: string }> = [];
  readonly stopped: string[] = [];
  readonly written: Array<[string, string]> = [];
  unavailable = false;
  private counter = 0;

  start(input: StartSessionInput): AgentSession {
    if (this.unavailable) throw new UnavailableError('Terminal backend unavailable: node-pty missing (fake)');
    this.counter += 1;
    const id = `ses_fake${this.counter}`;
    this.started.push({ ...input, id });
    return { id, provider: input.provider, workId: input.workId };
  }
  stop(id: string): void { this.stopped.push(id); }
  write(id: string, data: string): void { this.written.push([id, data]); }
  print(index: number, data: string): void { this.started[index].observer?.onData?.(data); }
  exit(index: number, code: number): void { this.started[index].observer?.onExit?.(code); }
}

/** Timers the test fires by hand: no real waiting, no flake. */
export function fakeScheduler() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  /** Fires every live timer with this delay, once. */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) {
      t.cancelled = true;
      t.fn();
    }
  };
  const pending = (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).length;
  return { schedule, fire, pending, timers };
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function settleAll(): Promise<void> { for (let i = 0; i < 10; i += 1) await flush(); }

export interface SetupHarness {
  deps: RuntimeSetupDeps;
  events: RuntimeSetupEvent[];
  launched: FakeProcess[];
  terminal: FakeLoginTerminal;
  scheduler: ReturnType<typeof fakeScheduler>;
  opened: string[];
  pins: Map<string, string>;
  files: Set<string>;
  resolved: Map<string, { executable: string; version: string | null } | null>;
  invalidations: number;
  statusQueue: Map<string, Array<{ loggedIn: boolean; detail: string; displayName?: string | null }>>;
  runnerCalls: () => Array<{ file: string; args: string[] }>;
}

export const LIMITS = { installTimeoutMs: 600_000, urlTimeoutMs: 30_000, loginTimeoutMs: 900_000, statusPollMs: 3_000 };

export function setupHarness(options: { platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; runner?: FakeCommand; accounts?: AgentAccount[]; codexUrl?: string } = {}): SetupHarness {
  const events: RuntimeSetupEvent[] = [];
  const { launch, launched } = fakeLauncher();
  const terminal = new FakeLoginTerminal();
  const scheduler = fakeScheduler();
  const opened: string[] = [];
  const pins = new Map<string, string>();
  const files = new Set<string>();
  const resolved = new Map<string, { executable: string; version: string | null } | null>();
  const statusQueue = new Map<string, Array<{ loggedIn: boolean; detail: string; displayName?: string | null }>>();
  const runner = fakeRunner(options.runner ?? (() => ({ code: 1, stdout: '' })));
  const harness: SetupHarness = {
    events, launched, terminal, scheduler, opened, pins, files, resolved, invalidations: 0, statusQueue,
    runnerCalls: () => runner.calls.map((c) => ({ file: c.file, args: c.args })),
    deps: undefined as unknown as RuntimeSetupDeps,
  };
  harness.deps = {
    platform: options.platform ?? 'win32',
    arch: options.arch ?? 'x64',
    env: options.env ?? { USERPROFILE: 'C:\\Users\\ana', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', APPDATA: 'C:\\Users\\ana\\AppData\\Roaming', HOME: '/home/ana' },
    detector: {
      resolve: async (provider) => {
        const hit = resolved.get(provider);
        return hit ? { provider, executable: hit.executable, version: hit.version } : null;
      },
      invalidate: () => { harness.invalidations += 1; },
    },
    runner,
    launch,
    terminal,
    accounts: {
      envFor: (runtime, accountId) => ({ [runtime === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'GROK_HOME']: `C:\\data\\accounts\\${runtime}\\${accountId}` }),
      status: async (runtime, _exe, accountId) => {
        const queue = statusQueue.get(`${runtime}:${accountId}`) ?? [];
        return queue.length > 1 ? queue.shift()! : queue[0] ?? { loggedIn: false, detail: 'Sin sesión iniciada' };
      },
      describe: async (runtime) => (options.accounts ?? []).filter((a) => a.runtime === runtime),
    },
    codexLogin: async () => options.codexUrl ?? 'https://auth.openai.com/oauth/authorize?client_id=x&state=y',
    openExternal: async (url) => { opened.push(url); },
    pins: { get: (r) => pins.get(r) ?? null, set: (r, e) => { pins.set(r, e); }, clear: (r) => { pins.delete(r); } },
    exists: (p) => files.has(p),
    emit: (e) => events.push(JSON.parse(JSON.stringify(e)) as RuntimeSetupEvent),
    cwd: 'C:\\data',
    appVersion: '9.9.9',
    schedule: scheduler.schedule,
    now: () => new Date('2026-09-28T12:00:00Z'),
    limits: LIMITS,
  };
  return harness;
}
