import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree, spawnInOwnProcessGroup } from '../core/processTree';
import { spawnSpecFor } from '../runtime/commandRunner';
import { scrubEnv } from '../runtime/terminalManager';

export interface OpenCodeServerOptions {
  /** Absolute path of the opencode executable (resolved by RuntimeDetector). */
  executable: string;
  /** Working directory for the server process itself (neutral, app-managed). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  log?: (line: string) => void;
  /** Injectable process launcher for bounded tests. */
  spawnImpl?: typeof spawn;
}

export interface OpenCodeEndpoint {
  baseUrl: string;
  /** Value for the Authorization header. Never log it. */
  authorization: string;
}

const URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/;

/**
 * npm installs `opencode.cmd`, a cmd.exe shim around the real binary. Killing
 * the shim leaves the server orphaned, so on Windows we launch the binary the
 * shim points to when it is where npm puts it. Anything else keeps the shim.
 */
export function resolveOpenCodeBinary(executable: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string {
  if (platform !== 'win32') return executable;
  const ext = path.win32.extname(executable).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return executable;
  const candidate = path.win32.join(path.win32.dirname(executable), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return exists(candidate) ? candidate : executable;
}

/**
 * Runs `opencode serve` as a child: loopback only, random port, random Basic
 * auth credentials passed through the environment (never on the command
 * line, never logged), no external plugins. One instance serves every work
 * directory through the protocol's per-request `directory` parameter.
 */
export class OpenCodeServer {
  private child: ChildProcess | null = null;
  private endpoint: OpenCodeEndpoint | null = null;
  private starting: Promise<OpenCodeEndpoint> | null = null;
  private exitReason: string | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: OpenCodeServerOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  get running(): boolean {
    return this.endpoint !== null && this.child !== null && this.child.exitCode === null;
  }

  get lastExitReason(): string | null {
    return this.exitReason;
  }

  async ensure(): Promise<OpenCodeEndpoint> {
    if (this.running && this.endpoint) return this.endpoint;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    if (child) killProcessTree(child, this.platform);
  }

  private launch(): Promise<OpenCodeEndpoint> {
    const username = 'latte';
    const password = randomBytes(24).toString('hex');
    const binary = resolveOpenCodeBinary(this.options.executable, this.platform);
    const spec = spawnSpecFor(binary, ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'], this.platform, this.env);
    const env = scrubEnv(this.env);
    env.OPENCODE_SERVER_USERNAME = username;
    env.OPENCODE_SERVER_PASSWORD = password;
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    this.exitReason = null;

    return new Promise<OpenCodeEndpoint>((resolve, reject) => {
      let settled = false;
      let output = '';
      let child: ChildProcess;
      try {
        child = spawnInOwnProcessGroup(this.options.spawnImpl ?? spawn, spec.file, spec.args, { cwd: this.options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, this.platform);
      } catch (error) {
        reject(new Error(`Could not start OpenCode: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error(`OpenCode did not announce a listening address within ${timeoutMs} ms`));
      }, timeoutMs);

      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-8_000);
        this.options.log?.(redact(text, password));
        if (settled) return;
        const match = output.match(URL_PATTERN);
        if (match) {
          settled = true;
          clearTimeout(timer);
          this.endpoint = { baseUrl: match[0].replace('localhost', '127.0.0.1'), authorization };
          resolve(this.endpoint);
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        reject(new Error(`Could not start OpenCode: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        this.exitReason = `OpenCode server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
        if (this.child === child) {
          this.child = null;
          this.endpoint = null;
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.exitReason}: ${redact(output, password).trim().slice(-400)}`));
        }
      });
    });
  }
}

function redact(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join('[redacted]') : text;
}
