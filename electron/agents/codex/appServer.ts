import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree, spawnInOwnProcessGroup } from '../../core/processTree';
import { spawnSpecFor } from '../../runtime/commandRunner';

export type JsonValue = unknown;
/** Return true when the request was taken (answered now or later); unclaimed requests get an error reply. */
export type ServerRequestHandler = (method: string, params: Record<string, unknown>, respond: (result: unknown) => void, fail: (message: string) => void) => boolean;
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export interface AppServerOptions {
  executable: string;
  env: Record<string, string>;
  cwd: string;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  clientVersion?: string;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/**
 * npm installs `codex.cmd` -> node wrapper -> platform binary. Latte spawns the
 * binary directly (same env the wrapper would pass) so the process tree stays
 * killable and no cmd.exe shim is left behind.
 */
export function resolveCodexBinary(executable: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync, readdir: (p: string) => string[] = safeReaddir): string {
  if (platform !== 'win32') return executable;
  const ext = path.win32.extname(executable).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return executable;
  const roots = [
    path.win32.join(path.win32.dirname(executable), 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
    path.win32.join(path.win32.dirname(executable), 'node_modules', '@openai'),
  ];
  for (const root of roots) {
    for (const pkg of readdir(root)) {
      if (!pkg.startsWith('codex-')) continue;
      const vendor = path.win32.join(root, pkg, 'vendor');
      for (const triple of readdir(vendor)) {
        const candidate = path.win32.join(vendor, triple, 'bin', 'codex.exe');
        if (exists(candidate)) return candidate;
      }
    }
  }
  return executable;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * One `codex app-server` process: newline-delimited JSON-RPC 2.0 over stdio.
 * Handles request/response correlation, server->client requests (approvals,
 * questions) and notifications. One instance per Codex account (CODEX_HOME).
 */
export class CodexAppServer {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private starting: Promise<void> | null = null;
  private initialised = false;
  private readonly platform: NodeJS.Platform;
  readonly notifications = new Set<NotificationHandler>();
  readonly serverRequests = new Set<ServerRequestHandler>();
  onExit: ((reason: string) => void) | null = null;

  constructor(private readonly options: AppServerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.initialised;
  }

  async ensure(): Promise<void> {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.initialised = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server stopped'));
    }
    this.pending.clear();
    if (child) {
      try { child.stdin?.end(); } catch { /* ignore */ }
      killProcessTree(child, this.platform);
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensure();
    return this.rawRequest(method, params);
  }

  private rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} within ${this.options.requestTimeoutMs ?? 30_000} ms`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  private write(payload: unknown): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.options.log?.(`[codex] write failed: ${describe(error)}`);
    }
  }

  private async launch(): Promise<void> {
    const binary = resolveCodexBinary(this.options.executable, this.platform);
    const spec = spawnSpecFor(binary, ['app-server'], this.platform, this.options.env);
    const env = { ...this.options.env, CODEX_MANAGED_BY_NPM: '1' };
    let child: ChildProcess;
    try {
      child = spawnInOwnProcessGroup(this.options.spawnImpl ?? spawn, spec.file, spec.args, { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, this.platform);
    } catch (error) {
      throw new Error(`Could not start Codex: ${describe(error)}`);
    }
    this.child = child;
    this.buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.options.log?.(`[codex] ${chunk.toString('utf8').trim().slice(0, 300)}`));
    child.on('error', (error) => {
      this.options.log?.(`[codex] process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.initialised = false;
      const reason = `Codex app-server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.onExit?.(reason);
    });
    const result = await this.rawRequest('initialize', { clientInfo: { name: 'latte', title: 'Latte', version: this.options.clientVersion ?? '0.1.0' }, capabilities: { experimentalApi: true } });
    if (!isRecord(result)) throw new Error('Codex initialize returned nothing');
    this.initialised = true;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf('\n');
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.options.log?.(`[codex] non-json: ${line.slice(0, 120)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (hasId && typeof msg.method === 'string') {
      // Server -> client request: must be answered.
      const id = msg.id as number | string;
      const params = isRecord(msg.params) ? msg.params : {};
      let answered = false;
      let claimed = false;
      const respond = (result: unknown) => { if (!answered) { answered = true; this.respond(id, result); } };
      const fail = (message: string) => { if (!answered) { answered = true; this.respondError(id, message); } };
      for (const handler of this.serverRequests) {
        try { if (handler(msg.method, params, respond, fail)) claimed = true; } catch (error) { this.options.log?.(`[codex] request handler failed: ${describe(error)}`); }
      }
      if (!claimed && !answered) fail(`Latte does not handle ${msg.method}`);
      return;
    }
    if (hasId) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pending.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const error = isRecord(msg.error) ? String(msg.error.message ?? 'error') : String(msg.error);
        pending.reject(new Error(error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const params = isRecord(msg.params) ? msg.params : {};
      for (const handler of this.notifications) {
        try { handler(msg.method, params); } catch (error) { this.options.log?.(`[codex] notification handler failed: ${describe(error)}`); }
      }
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
