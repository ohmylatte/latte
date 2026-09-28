import path from 'node:path';
import type {
  AccountRuntimeName,
  AgentAccount,
  InstallFailureCode,
  LoginFailureCode,
  Provider,
  RuntimeDiagnostic,
  RuntimeDiagnosticEntry,
  RuntimeInstallJob,
  RuntimeInstallState,
  RuntimeLoginJob,
  RuntimeLoginState,
  RuntimeSetupEvent,
  RuntimeSetupInfo,
  RuntimeSetupJob,
  SetupPrereq,
} from '../../../shared/contracts';
import { NotFoundError, UnavailableError, ValidationError } from '../../core/errors';
import { newId } from '../../core/ids';
import type { CommandRunner } from '../commandRunner';
import type { ResolvedRuntime } from '../detect';
import { PROVIDERS } from '../providers';
import { PREREQ_CATALOG, RUNTIME_INSTALL_CATALOG, setupOs, type RuntimeCatalogEntry, type SetupOs } from '../runtime-install-catalog';
import type { StartSessionInput } from '../terminalManager';
import type { AgentSession } from '../../../shared/contracts';
import { knownInstallPaths, locateOnFreshPath, type ExecutablePins } from './locate';
import { shellFor, type LaunchedProcess, type ProcessLauncher } from './processLauncher';
import { classifyInstallFailure, extractUrls, hyperlinkTargets, recognizeLoginUrl, redactHome, stripAnsi, Transcript } from './text';

export interface SetupLimits {
  /** A hung installer is stopped after this. */
  installTimeoutMs: number;
  /** No login URL (and no "opened your browser") by then → embedded terminal. */
  urlTimeoutMs: number;
  /** Nobody finished the login by then → failed{timeout}. */
  loginTimeoutMs: number;
  /** How often the runtime's own status check is asked while the browser is open. */
  statusPollMs: number;
}

const DEFAULT_LIMITS: SetupLimits = { installTimeoutMs: 10 * 60_000, urlTimeoutMs: 30_000, loginTimeoutMs: 15 * 60_000, statusPollMs: 3_000 };
/** Wide enough that an OAuth URL fits on one line; wrapped ones are joined anyway. */
const LOGIN_COLS = 500;
const LOGIN_ROWS = 50;
const MAX_JOBS = 40;

export interface RuntimeSetupDeps {
  detector: { resolve(provider: Provider): Promise<ResolvedRuntime | null>; invalidate(): void };
  runner: CommandRunner;
  /** Hidden installer processes (child_process in production). */
  launch: ProcessLauncher;
  /** The hidden login PTYs; the same manager the embedded terminal attaches to for "Ver detalle" and the fallback. */
  terminal: { start(input: StartSessionInput): AgentSession; stop(sessionId: string): void; write(sessionId: string, data: string): void };
  accounts: {
    envFor(runtime: AccountRuntimeName, accountId: string): Record<string, string>;
    status(runtime: AccountRuntimeName, executable: string, accountId: string): Promise<{ loggedIn: boolean; detail: string; displayName?: string | null }>;
    describe(runtime: AccountRuntimeName): Promise<AgentAccount[]>;
  };
  /** Codex logs in through its app-server: returns the authorize URL. */
  codexLogin?: (accountId: string) => Promise<string>;
  /** `shell.openExternal` behind an http(s) check. Injected: no test ever opens a browser. */
  openExternal: (url: string) => Promise<void>;
  pins: ExecutablePins;
  exists: (target: string) => boolean;
  emit: (event: RuntimeSetupEvent) => void;
  /** Where hidden processes run: Latte's data directory, never the inherited cwd. */
  cwd: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => Date;
  catalog?: Readonly<Record<Provider, RuntimeCatalogEntry>>;
  limits?: Partial<SetupLimits>;
  log?: (line: string) => void;
}

interface InstallRecord {
  job: RuntimeInstallJob;
  transcript: Transcript;
  process: LaunchedProcess | null;
  cancelTimer: (() => void) | null;
}

interface LoginRecord {
  job: RuntimeLoginJob;
  transcript: Transcript;
  raw: string;
  url: string | null;
  runtimeOpened: boolean;
  executable: string | null;
  timers: Array<() => void>;
  polling: boolean;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
}

/**
 * "Onboarding sin terminal" (brief 2026-09-27): Latte installs the agent CLI
 * with its official one-liner, finds the executable by absolute path, and logs
 * it in through the system browser — all in hidden processes. Every state is a
 * code; the renderer owns the words. Nothing here blocks the person: an
 * unverified installer points at the official guide, and a login URL Latte
 * does not recognize falls back to the embedded terminal, live.
 */
export class RuntimeSetupService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => Date;
  private readonly catalog: Readonly<Record<Provider, RuntimeCatalogEntry>>;
  private readonly limits: SetupLimits;
  private readonly installs = new Map<string, InstallRecord>();
  private readonly logins = new Map<string, LoginRecord>();
  private readonly order: string[] = [];
  private readonly lastError = new Map<Provider, InstallFailureCode | LoginFailureCode>();

  constructor(private readonly deps: RuntimeSetupDeps) {
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.env = deps.env ?? process.env;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.now = deps.now ?? (() => new Date());
    this.catalog = deps.catalog ?? RUNTIME_INSTALL_CATALOG;
    this.limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
  }

  // Catalog & detection --------------------------------------------------------

  async catalogInfo(): Promise<RuntimeSetupInfo[]> {
    const os = setupOs(this.platform);
    const out: RuntimeSetupInfo[] = [];
    for (const runtime of PROVIDERS) {
      const entry = this.catalog[runtime];
      const command = os ? entry.install[os] : undefined;
      const prereqs: RuntimeSetupInfo['prereqs'] = [];
      for (const requirement of (os ? entry.prereqs[os] : undefined) ?? []) {
        prereqs.push({
          prereq: requirement.prereq,
          required: requirement.required,
          present: await this.prereqPresent(requirement.prereq),
          canInstall: (await this.prereqInstaller(requirement.prereq)) !== null,
          guideUrl: PREREQ_CATALOG[requirement.prereq].guideUrl,
        });
      }
      out.push({
        runtime,
        canInstall: this.installableCommand(entry) !== null,
        browserLogin: Boolean(entry.login?.browser),
        prereqs,
        guideUrl: entry.guideUrl,
        verifiedAt: command?.verifiedAt ?? '',
      });
    }
    return out;
  }

  async detect(runtime: Provider): Promise<RuntimeInstallState> {
    this.requireProvider(runtime);
    this.deps.detector.invalidate();
    const found = await this.deps.detector.resolve(runtime);
    if (found) return { state: 'found', version: found.version, executable: found.executable };
    const entry = this.catalog[runtime];
    return { state: 'not_found', canInstall: this.installableCommand(entry) !== null, guideUrl: entry.guideUrl };
  }

  // Install -----------------------------------------------------------------------

  async startInstall(runtime: Provider, options: { installPrereqs?: boolean } | null | undefined): Promise<RuntimeInstallJob> {
    this.requireProvider(runtime);
    if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) throw new ValidationError('Invalid install options');
    const installPrereqs = options?.installPrereqs === true;
    for (const record of this.installs.values()) {
      if (record.job.runtime === runtime && !record.job.done) return { ...record.job };
    }
    const record: InstallRecord = {
      job: { kind: 'install', jobId: newId('job'), runtime, state: { state: 'detecting' }, done: false },
      transcript: new Transcript(),
      process: null,
      cancelTimer: null,
    };
    this.remember(record.job.jobId);
    this.installs.set(record.job.jobId, record);
    this.setInstall(record, { state: 'detecting' }, false);
    void this.runInstall(record, installPrereqs).catch((error: unknown) => {
      record.transcript.note(`internal error: ${error instanceof Error ? error.message : String(error)}`);
      this.failInstall(record, 'unknown', error instanceof Error ? error.message.slice(0, 300) : 'unknown');
    });
    return { ...record.job };
  }

  cancelInstall(jobId: string): RuntimeInstallJob {
    const record = this.installs.get(jobId);
    if (!record) throw new NotFoundError('Setup job', jobId);
    if (record.job.done) return { ...record.job };
    record.transcript.note('cancelled by the person');
    this.stopInstallProcess(record);
    this.setInstall(record, { state: 'cancelled' }, true);
    return { ...record.job };
  }

  private async runInstall(record: InstallRecord, installPrereqs: boolean): Promise<void> {
    const runtime = record.job.runtime;
    const entry = this.catalog[runtime];
    this.deps.detector.invalidate();
    const found = await this.deps.detector.resolve(runtime);
    if (this.isOver(record)) return;
    if (found) {
      record.transcript.note(`already installed: ${found.executable}`);
      this.setInstall(record, { state: 'found', version: found.version, executable: found.executable }, true);
      return;
    }
    const os = setupOs(this.platform);
    const command = os ? entry.install[os] : undefined;
    if (!os || !command || (command.arch && !command.arch.includes(this.arch))) {
      record.transcript.note(`no official installer for ${this.platform}/${this.arch}`);
      this.failInstall(record, 'unsupported_platform', `${this.platform}/${this.arch}`);
      return;
    }
    if (!command.verified) {
      record.transcript.note(`installer not verified against the official docs (${command.source}); not run`);
      this.failInstall(record, 'unverified_installer', command.source);
      return;
    }

    for (const requirement of entry.prereqs[os] ?? []) {
      if (await this.prereqPresent(requirement.prereq)) continue;
      const installer = await this.prereqInstaller(requirement.prereq);
      if (this.isOver(record)) return;
      if (!installPrereqs) {
        if (!requirement.required) { record.transcript.note(`recommended ${requirement.prereq} missing; continuing without it`); continue; }
        this.setInstall(record, { state: 'needs_prereq', prereq: requirement.prereq, canInstall: installer !== null, guideUrl: PREREQ_CATALOG[requirement.prereq].guideUrl }, true);
        return;
      }
      if (!installer) {
        if (!requirement.required) { record.transcript.note(`recommended ${requirement.prereq} missing and Latte cannot install it here; continuing`); continue; }
        this.failInstall(record, 'prereq_missing', requirement.prereq);
        return;
      }
      this.setInstall(record, { state: 'installing', phase: 'prereq' }, false);
      const code = await this.runProcess(record, installer.file, installer.args);
      if (this.isOver(record)) return;
      if (code !== 0) {
        if (requirement.required) {
          const cause = classifyInstallFailure(record.transcript.output());
          this.failInstall(record, cause === 'unknown' ? 'prereq_missing' : cause, record.transcript.tail());
          return;
        }
        record.transcript.note(`recommended ${requirement.prereq} did not install (exit ${code}); continuing`);
      }
    }

    this.setInstall(record, { state: 'installing', phase: 'downloading' }, false);
    const shell = shellFor(os, command.script, this.env);
    const exit = await this.runProcess(record, shell.file, shell.args);
    if (this.isOver(record)) return;
    if (exit !== 0) {
      this.failInstall(record, classifyInstallFailure(record.transcript.output()), record.transcript.tail());
      return;
    }

    this.setInstall(record, { state: 'installing', phase: 'checking' }, false);
    const executable = await this.locateAfterInstall(runtime);
    if (this.isOver(record)) return;
    if (!executable) {
      const cause = classifyInstallFailure(record.transcript.output());
      this.failInstall(record, cause === 'blocked_by_antivirus' || cause === 'blocked_by_policy' ? cause : 'not_found_after_install', record.transcript.tail() || 'executable not found after install');
      return;
    }
    const version = await this.readVersion(executable, entry);
    if (this.isOver(record)) return;
    if (version.failed) {
      // The file is there and does not run: on a clean Windows that is Defender holding a new binary.
      record.transcript.note(`verify failed: ${version.detail}`);
      const cause = classifyInstallFailure(`${record.transcript.output()}\n${version.detail}`);
      this.failInstall(record, cause === 'unknown' ? 'blocked_by_antivirus' : cause, version.detail);
      return;
    }
    this.deps.pins.set(runtime, executable);
    this.deps.detector.invalidate();
    record.transcript.note(`installed: ${executable}${version.value ? ` (${version.value})` : ''}`);
    this.setInstall(record, { state: 'installed', version: version.value, executable }, true);
  }

  /** Runs one hidden process to completion (or cancel/timeout). Resolves with the exit code; null = did not run. */
  private runProcess(record: InstallRecord, file: string, args: readonly string[]): Promise<number | null> {
    return new Promise((resolve) => {
      record.transcript.note(`$ ${(this.platform === 'win32' ? path.win32 : path.posix).basename(file)} ${args.join(' ')}`);
      let proc: LaunchedProcess;
      try {
        proc = this.deps.launch(file, args, { env: this.installEnv(), cwd: this.deps.cwd });
      } catch (error) {
        record.transcript.note(`could not start: ${error instanceof Error ? error.message : String(error)}`);
        resolve(null);
        return;
      }
      record.process = proc;
      record.cancelTimer = this.schedule(() => {
        if (record.job.done) return;
        record.transcript.note('installer timed out');
        this.stopInstallProcess(record);
        this.failInstall(record, 'timeout', record.transcript.tail());
        resolve(null);
      }, this.limits.installTimeoutMs);
      proc.onData((chunk) => record.transcript.append(chunk));
      proc.onExit((code, spawnError) => {
        record.cancelTimer?.();
        record.cancelTimer = null;
        record.process = null;
        if (spawnError) record.transcript.note(spawnError);
        record.transcript.note(`exit ${code ?? 'none'}`);
        resolve(spawnError ? null : code);
      });
    });
  }

  private stopInstallProcess(record: InstallRecord): void {
    record.cancelTimer?.();
    record.cancelTimer = null;
    try { record.process?.kill(); } catch { /* already gone */ }
    record.process = null;
  }

  /** The installer's environment: the app's own, minus what would bind the child to whoever launched Latte. */
  private installEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) {
      if (typeof value !== 'string') continue;
      if (/^(ORCA_|CLAUDE_CODE_)/i.test(key) || key.toUpperCase() === 'CLAUDECODE') continue;
      out[key] = value;
    }
    return out;
  }

  private async locateAfterInstall(runtime: Provider): Promise<string | null> {
    const entry = this.catalog[runtime];
    const known = knownInstallPaths(runtime, this.env, this.platform, this.deps.exists, this.catalog);
    if (known.length > 0) return known[0];
    const fresh = await locateOnFreshPath(entry.command, { runner: this.deps.runner, env: this.env, platform: this.platform, exists: this.deps.exists });
    if (fresh) return fresh;
    this.deps.detector.invalidate();
    return (await this.deps.detector.resolve(runtime))?.executable ?? null;
  }

  private async readVersion(executable: string, entry: RuntimeCatalogEntry): Promise<{ failed: false; value: string | null } | { failed: true; detail: string }> {
    const result = await this.deps.runner(executable, [...entry.versionArgs], { timeoutMs: 20_000, env: this.installEnv(), cwd: this.deps.cwd });
    if (result.error) return { failed: true, detail: result.error.slice(0, 300) };
    if (result.timedOut) return { failed: true, detail: 'version check timed out' };
    if (result.code !== 0) return { failed: true, detail: `version check exited ${result.code}: ${stripAnsi(`${result.stderr}\n${result.stdout}`).trim().slice(0, 240)}` };
    const line = stripAnsi(`${result.stdout}\n${result.stderr}`).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return { failed: false, value: line ? line.slice(0, 120) : null };
  }

  private async prereqPresent(prereq: SetupPrereq): Promise<boolean> {
    if (prereq === 'git_for_windows') {
      const configured = this.env.CLAUDE_CODE_GIT_BASH_PATH;
      if (configured && this.deps.exists(configured)) return true;
      for (const root of [this.env.ProgramFiles, this.env['ProgramFiles(x86)'], this.env.LOCALAPPDATA ? path.win32.join(this.env.LOCALAPPDATA, 'Programs') : undefined, 'C:\\Program Files']) {
        if (root && this.deps.exists(path.win32.join(root, 'Git', 'bin', 'bash.exe'))) return true;
      }
      return (await this.where('git')) !== null;
    }
    if (prereq === 'winget') return (await this.where('winget')) !== null;
    return (await this.where('npm')) !== null;
  }

  /** How Latte installs a prerequisite here, or null (then: link to its guide). Only verified commands. */
  private async prereqInstaller(prereq: SetupPrereq): Promise<{ file: string; args: readonly string[] } | null> {
    if (this.platform !== 'win32') return null;
    const spec = PREREQ_CATALOG[prereq].install.win32;
    if (!spec || !spec.verified) return null;
    const winget = await this.where('winget');
    return winget ? { file: winget, args: spec.args } : null;
  }

  private async where(command: string): Promise<string | null> {
    const isWindows = this.platform === 'win32';
    const result = await this.deps.runner(isWindows ? 'where.exe' : 'which', [command], { timeoutMs: 4_000, env: this.env });
    if (result.error || result.timedOut || result.code !== 0) return null;
    const isAbsolute = isWindows ? path.win32.isAbsolute : path.posix.isAbsolute;
    return result.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && isAbsolute(l)) ?? null;
  }

  private installableCommand(entry: RuntimeCatalogEntry) {
    const os = setupOs(this.platform);
    const command = os ? entry.install[os] : undefined;
    if (!command || !command.verified) return null;
    if (command.arch && !command.arch.includes(this.arch)) return null;
    return command;
  }

  private failInstall(record: InstallRecord, code: InstallFailureCode, detail: string): void {
    if (record.job.done) return;
    this.lastError.set(record.job.runtime, code);
    this.setInstall(record, { state: 'failed', code, detail: detail.slice(0, 300), guideUrl: this.catalog[record.job.runtime].guideUrl }, true);
  }

  private setInstall(record: InstallRecord, state: RuntimeInstallState, done: boolean): void {
    if (record.job.done) return;
    record.job = { ...record.job, state, done };
    if (done) this.stopInstallProcess(record);
    this.deps.emit({ ...record.job });
  }

  private isOver(record: InstallRecord | LoginRecord): boolean {
    return record.job.done;
  }

  // Browser login -----------------------------------------------------------------

  async startLogin(runtime: AccountRuntimeName, accountId: string): Promise<RuntimeLoginJob> {
    if (runtime !== 'claude' && runtime !== 'codex' && runtime !== 'grok' && runtime !== 'hermes') throw new ValidationError('Unknown runtime');
    for (const existing of this.logins.values()) {
      if (existing.job.runtime === runtime && existing.job.accountId === accountId && !existing.job.done) return { ...existing.job };
    }
    const record: LoginRecord = {
      job: { kind: 'login', jobId: newId('job'), runtime, accountId, state: { state: 'starting' }, done: false, sessionId: null },
      transcript: new Transcript(),
      raw: '',
      url: null,
      runtimeOpened: false,
      executable: null,
      timers: [],
      polling: false,
    };
    this.remember(record.job.jobId);
    this.logins.set(record.job.jobId, record);
    this.setLogin(record, { state: 'starting' }, false);

    const entry = this.catalog[runtime];
    const found = await this.deps.detector.resolve(runtime);
    if (!found) {
      this.failLogin(record, 'not_installed', `${runtime} not installed`);
      return { ...record.job };
    }
    record.executable = found.executable;
    record.timers.push(this.schedule(() => {
      if (record.job.done) return;
      record.transcript.note('login timed out');
      this.failLogin(record, 'timeout', record.transcript.tail() || 'timed out');
    }, this.limits.loginTimeoutMs));

    if (runtime === 'codex') {
      void this.codexLogin(record).catch((error: unknown) => this.failLogin(record, 'unknown', error instanceof Error ? error.message.slice(0, 300) : 'unknown'));
      return { ...record.job };
    }

    let session: AgentSession;
    try {
      session = this.deps.terminal.start({
        workId: 'login',
        brandId: 'login',
        provider: runtime,
        executable: found.executable,
        args: [...(entry.login?.args ?? [])],
        cwd: this.deps.cwd,
        cols: LOGIN_COLS,
        rows: LOGIN_ROWS,
        extraEnv: this.deps.accounts.envFor(runtime, accountId),
        observer: {
          onData: (data) => this.onLoginOutput(record, data),
          onExit: (code) => { void this.onLoginExit(record, code); },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failLogin(record, error instanceof UnavailableError && /terminal backend/i.test(message) ? 'terminal_unavailable' : 'unknown', message.slice(0, 300));
      return { ...record.job };
    }
    record.job = { ...record.job, sessionId: session.id };

    if (!entry.login?.browser) {
      // The CLI needs the person to choose first (Hermes: provider + model). Straight to the live terminal; Latte still confirms.
      this.setLogin(record, { state: 'needs_terminal', reason: 'needs_choice', sessionId: session.id }, false);
      this.startPolling(record);
    } else {
      record.timers.push(this.schedule(() => {
        if (record.job.done || record.url || record.runtimeOpened) return;
        record.transcript.note('no login URL recognized in time; embedded terminal');
        this.setLogin(record, { state: 'needs_terminal', reason: 'url_not_recognized', sessionId: session.id }, false);
        this.startPolling(record);
      }, this.limits.urlTimeoutMs));
    }
    return { ...record.job };
  }

  async reopenLogin(jobId: string): Promise<RuntimeLoginJob> {
    const record = this.logins.get(jobId);
    if (!record) throw new NotFoundError('Setup job', jobId);
    if (record.job.done) return { ...record.job };
    if (!record.url) throw new UnavailableError('No login URL captured for this job');
    await this.deps.openExternal(record.url);
    return { ...record.job };
  }

  cancelLogin(jobId: string): RuntimeLoginJob {
    const record = this.logins.get(jobId);
    if (!record) throw new NotFoundError('Setup job', jobId);
    if (record.job.done) return { ...record.job };
    record.transcript.note('cancelled by the person');
    this.setLogin(record, { state: 'cancelled' }, true);
    return { ...record.job };
  }

  private async codexLogin(record: LoginRecord): Promise<void> {
    if (!this.deps.codexLogin) {
      this.failLogin(record, 'unknown', 'codex login unavailable in this build');
      return;
    }
    const url = await this.deps.codexLogin(record.job.accountId);
    if (record.job.done) return;
    const recognized = recognizeLoginUrl([url], this.catalog.codex.login?.urlHosts ?? []);
    if (!recognized) {
      record.transcript.note('codex returned a login URL outside its allowlist; not opened');
      this.failLogin(record, 'unknown', 'unrecognized login URL');
      return;
    }
    record.url = recognized;
    await this.deps.openExternal(recognized);
    this.setLogin(record, { state: 'browser_opened', url: recognized, openedBy: 'latte' }, false);
    this.startPolling(record);
  }

  private onLoginOutput(record: LoginRecord, data: string): void {
    record.transcript.append(data);
    if (record.job.done) return;
    record.raw = (record.raw + data).slice(-64_000);
    const login = this.catalog[record.job.runtime].login;
    if (!login?.browser || record.url) return;
    const text = stripAnsi(record.raw);
    if (login.openedByRuntime?.test(text)) record.runtimeOpened = true;
    const url = recognizeLoginUrl(extractUrls(record.raw, LOGIN_COLS), login.urlHosts);
    if (url) {
      // A URL only counts once something follows it: an OAuth URL often arrives split across chunks.
      const lastFragment = url.slice(-16);
      const at = text.lastIndexOf(lastFragment);
      const complete = hyperlinkTargets(record.raw).includes(url) || (at !== -1 && /\s/.test(text.charAt(at + lastFragment.length)));
      if (!complete) return;
      record.url = url;
      if (record.runtimeOpened) {
        this.setLogin(record, { state: 'browser_opened', url, openedBy: 'runtime' }, false);
      } else {
        void this.deps.openExternal(url).catch((error: unknown) => record.transcript.note(`openExternal failed: ${error instanceof Error ? error.message : String(error)}`));
        this.setLogin(record, { state: 'browser_opened', url, openedBy: 'latte' }, false);
      }
      this.startPolling(record);
      return;
    }
    if (record.runtimeOpened && record.job.state.state === 'starting') {
      this.setLogin(record, { state: 'browser_opened', url: null, openedBy: 'runtime' }, false);
      this.startPolling(record);
    }
  }

  private async onLoginExit(record: LoginRecord, code: number): Promise<void> {
    record.transcript.note(`login process exit ${code}`);
    if (record.job.done) return;
    const status = await this.checkStatus(record);
    if (record.job.done) return;
    if (status?.loggedIn) {
      this.setLogin(record, { state: 'connected', displayName: status.displayName ?? null }, true);
      return;
    }
    this.failLogin(record, 'not_confirmed', record.transcript.tail() || `exit ${code}`);
  }

  private startPolling(record: LoginRecord): void {
    if (record.polling) return;
    record.polling = true;
    const tick = () => {
      if (record.job.done) return;
      void this.checkStatus(record).then((status) => {
        if (record.job.done) return;
        if (status?.loggedIn) {
          this.setLogin(record, { state: 'connected', displayName: status.displayName ?? null }, true);
          return;
        }
        if (record.job.state.state === 'browser_opened') this.setLogin(record, { state: 'waiting', url: record.url }, false);
        record.timers.push(this.schedule(tick, this.limits.statusPollMs));
      });
    };
    record.timers.push(this.schedule(tick, this.limits.statusPollMs));
  }

  private async checkStatus(record: LoginRecord): Promise<{ loggedIn: boolean; displayName?: string | null } | null> {
    if (!record.executable) return null;
    try {
      return await this.deps.accounts.status(record.job.runtime, record.executable, record.job.accountId);
    } catch (error) {
      record.transcript.note(`status check failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private failLogin(record: LoginRecord, code: LoginFailureCode, detail: string): void {
    if (record.job.done) return;
    this.lastError.set(record.job.runtime, code);
    this.setLogin(record, { state: 'failed', code, detail: detail.slice(0, 300) }, true);
  }

  private setLogin(record: LoginRecord, state: RuntimeLoginState, done: boolean): void {
    if (record.job.done) return;
    record.job = { ...record.job, state, done };
    if (done) {
      for (const cancel of record.timers.splice(0)) cancel();
      if (record.job.sessionId) {
        // "Login successful · Press Enter to continue": let the CLI finish its own write before stopping it.
        if (state.state === 'connected') { try { this.deps.terminal.write(record.job.sessionId, '\r'); } catch { /* already gone */ } }
        try { this.deps.terminal.stop(record.job.sessionId); } catch { /* already gone */ }
      }
    }
    this.deps.emit({ ...record.job });
  }

  // Jobs & diagnostic ---------------------------------------------------------------

  getJob(jobId: string): RuntimeSetupJob {
    const record = this.installs.get(jobId) ?? this.logins.get(jobId);
    if (!record) throw new NotFoundError('Setup job', jobId);
    return { ...record.job };
  }

  transcript(jobId: string): string {
    const record = this.installs.get(jobId) ?? this.logins.get(jobId);
    if (!record) throw new NotFoundError('Setup job', jobId);
    return record.transcript.toString();
  }

  async diagnose(): Promise<RuntimeDiagnostic> {
    this.deps.detector.invalidate();
    const runtimes: RuntimeDiagnosticEntry[] = [];
    for (const runtime of PROVIDERS) {
      const found = await this.deps.detector.resolve(runtime);
      let loggedIn: boolean | null = null;
      if (runtime !== 'opencode') {
        try {
          loggedIn = found ? (await this.deps.accounts.describe(runtime)).some((a) => a.loggedIn) : false;
        } catch {
          loggedIn = false;
        }
      }
      runtimes.push({
        runtime,
        installed: Boolean(found),
        version: found?.version ?? null,
        path: found ? redactHome(found.executable, this.env, this.platform) : null,
        loggedIn,
        lastError: this.lastError.get(runtime) ?? null,
      });
    }
    const generatedAt = this.now().toISOString();
    const yesNo = (value: boolean | null) => (value === null ? 'n/a' : value ? 'yes' : 'no');
    const lines = [
      `Latte ${this.deps.appVersion ?? ''} runtime report · ${generatedAt}`.replace(/\s+·/, ' ·'),
      `os: ${this.platform} ${this.arch}`,
      ...runtimes.map((r) => `${r.runtime}: installed=${yesNo(r.installed)} version=${r.version ?? '-'} path=${r.path ?? '-'} signedIn=${yesNo(r.loggedIn)} lastError=${r.lastError ?? '-'}`),
    ];
    return { generatedAt, runtimes, report: lines.join('\n') };
  }

  /** App quit: nothing hidden survives Latte. */
  shutdown(): void {
    for (const record of this.installs.values()) if (!record.job.done) this.stopInstallProcess(record);
    for (const record of this.logins.values()) {
      for (const cancel of record.timers.splice(0)) cancel();
      if (!record.job.done && record.job.sessionId) { try { this.deps.terminal.stop(record.job.sessionId); } catch { /* gone */ } }
    }
  }

  private remember(jobId: string): void {
    this.order.push(jobId);
    while (this.order.length > MAX_JOBS) {
      const oldest = this.order.find((id) => (this.installs.get(id) ?? this.logins.get(id))?.job.done);
      if (!oldest) break;
      this.order.splice(this.order.indexOf(oldest), 1);
      this.installs.delete(oldest);
      this.logins.delete(oldest);
    }
  }

  private requireProvider(runtime: unknown): asserts runtime is Provider {
    if (typeof runtime !== 'string' || !(PROVIDERS as readonly string[]).includes(runtime)) throw new ValidationError('Unknown runtime');
  }
}

export type { SetupOs };
