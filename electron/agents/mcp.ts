import type { AccountLoginStart, AgentSession, McpServer, McpRuntimeTools, ChatRuntime } from '../../shared/contracts';
import type { CommandRunner } from '../runtime/commandRunner';
import type { RuntimeDetector } from '../runtime/detect';
import type { StartSessionInput } from '../runtime/terminalManager';
import { UnavailableError, ValidationError } from '../core/errors';

/**
 * MCP servers, as each runtime already manages them.
 *
 * Latte does not implement MCP and does not store a single credential: it runs
 * each runtime's own `mcp` command and shows the result. What a runtime cannot
 * do without a human at a prompt, Latte does not pretend to do either.
 *
 * | Runtime     | List | Add | Remove |
 * | Claude Code | yes (with a health check) | yes | yes |
 * | Codex       | yes (JSON)               | yes | yes |
 * | OpenCode    | yes (text)               | no: its `mcp add` is interactive | no |
 */
export interface McpDeps {
  runner: CommandRunner;
  detector: RuntimeDetector;
  /** Environment overlay per account (managed profiles). */
  accountEnv: (runtime: 'claude' | 'codex', accountId: string | null) => Record<string, string>;
  /**
   * La cuenta cuyo perfil hay que LEER, que es la del agente primario: el
   * perfil que los runs de Latte usan de verdad.
   *
   * Esto arregla el 1.5 del brief de conexiones. Todo `mcp.ts` leía
   * `accountEnv(runtime, null)` —el perfil **system**— mientras el login
   * corría en el `CLAUDE_CONFIG_DIR` de la cuenta del primario. Con una cuenta
   * gestionada, el servidor se listaba de un perfil y el token vivía en otro:
   * la pantalla decía "necesita autenticación" para siempre, sin que nada
   * estuviera mal. El camino de login ya no existe (decisión D), pero la
   * lectura mentirosa sí, y es la misma línea.
   *
   * Ausente = el perfil `system`, que es exactamente lo que hacía antes.
   */
  primaryAccountId?: (runtime: 'claude' | 'codex') => string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Codex app-server methods; absent when this build has no Codex adapter. */
  codex?: {
    listMcpStatus(accountId: string): Promise<Array<{ name: string; authStatus: string }>>;
    startMcpLogin(accountId: string, name: string): Promise<{ url: string }>;
  };
  /** Live Claude stream-json `system/init` mcp_servers, if a chat is open. */
  claudeMcpFromInit?: () => Array<{ name: string; status: string }>;
  startTerminal?: (input: StartSessionInput) => AgentSession;
}

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

export class McpCatalog {
  constructor(private readonly deps: McpDeps) {}

  private get timeout(): number {
    return this.deps.timeoutMs ?? 30_000;
  }

  /** What every runtime has configured, plus what Latte can and cannot do with it. */
  /** One runtime, so the UI can show each card as it lands instead of waiting for the slowest. */
  async listOne(runtime: ChatRuntime): Promise<McpRuntimeTools> {
    const found = await this.deps.detector.resolve(runtime as 'claude' | 'codex' | 'opencode');
    if (!found) return { runtime, installed: false, canEdit: false, detail: 'No está instalado o no está en el PATH.', servers: [] };
    try {
      return await this.listFor(runtime, found.executable);
    } catch (error) {
      return { runtime, installed: true, canEdit: canEdit(runtime), detail: describe(error), servers: [] };
    }
  }

  async list(): Promise<McpRuntimeTools[]> {
    // In parallel: Claude Code health-checks every server, so asking one after
    // the other took as long as all three timeouts stacked up.
    return Promise.all((['claude', 'codex', 'opencode'] as ChatRuntime[]).map((runtime) => this.listOne(runtime)));
  }

  private async listFor(runtime: ChatRuntime, executable: string): Promise<McpRuntimeTools> {
    const env = this.envFor(runtime);
    if (runtime === 'codex') {
      const result = await this.deps.runner(executable, ['mcp', 'list', '--json'], { timeoutMs: this.timeout, env });
      if (result.error || result.timedOut) throw new UnavailableError(result.error ?? 'la consulta demoró demasiado');
      const servers = parseCodex(result.stdout);
      let detail = 'Configurados en tu Codex.';
      if (this.deps.codex) {
        try {
          const statuses = await this.deps.codex.listMcpStatus('system');
          applyCodexAuth(servers, statuses);
        } catch (error) {
          detail = describe(error);
        }
      }
      return { runtime, installed: true, canEdit: true, detail, servers };
    }
    if (runtime === 'claude') {
      // This one health-checks every server, so it is slower and worth it.
      const result = await this.deps.runner(executable, ['mcp', 'list'], { timeoutMs: this.timeout, env });
      if (result.error || result.timedOut) throw new UnavailableError(result.error ?? 'la consulta demoró demasiado');
      const servers = parseClaude(result.stdout);
      applyClaudeInit(servers, this.deps.claudeMcpFromInit?.() ?? []);
      return { runtime, installed: true, canEdit: true, detail: 'Configurados en tu Claude Code, con estado real de conexión.', servers };
    }
    const result = await this.deps.runner(executable, ['mcp', 'list'], { timeoutMs: this.timeout, env });
    if (result.error || result.timedOut) throw new UnavailableError(result.error ?? 'la consulta demoró demasiado');
    return {
      runtime,
      installed: true,
      canEdit: false,
      detail: 'Solo lectura: el comando para agregar de OpenCode es interactivo, así que se agrega desde su CLI.',
      servers: parseOpenCode(result.stdout),
    };
  }

  /**
   * Adds a server through the runtime's own CLI. Values the user typed are
   * passed as separate arguments, never as a shell string, and nothing is
   * stored by Latte: the credential lives in the runtime's config.
   */
  async add(runtime: 'claude' | 'codex', input: { name: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string; env: string[] }): Promise<void> {
    if (!SERVER_NAME.test(input.name)) throw new ValidationError('El nombre solo admite letras, números, punto, guion y dos puntos');
    for (const pair of input.env) if (!ENV_PAIR.test(pair)) throw new ValidationError(`Variable inválida: ${pair.slice(0, 40)}`);
    const executable = await this.executable(runtime);
    const args = runtime === 'claude' ? claudeAddArgs(input) : codexAddArgs(input);
    const result = await this.deps.runner(executable, args, { timeoutMs: this.timeout, env: this.envFor(runtime) });
    if (result.error || result.timedOut) throw new UnavailableError(result.error ?? 'el comando demoró demasiado');
    if (result.code !== 0) throw new UnavailableError(firstLine(result.stderr || result.stdout) || 'el runtime rechazó la configuración');
  }

  async loginCodex(name: string): Promise<AccountLoginStart> {
    if (!SERVER_NAME.test(name)) throw new ValidationError('Nombre inválido');
    if (!this.deps.codex) throw new UnavailableError('Este build no incluye el adaptador de Codex');
    const { url } = await this.deps.codex.startMcpLogin('system', name);
    return {
      mode: 'browser',
      url,
      instructions: 'Iniciá sesión en el servidor MCP en el navegador. Cuando termine, volvé y actualizá la lista.',
    };
  }

  async authenticateClaude(cwd: string, accountId: string | null): Promise<AccountLoginStart> {
    if (!this.deps.startTerminal) throw new UnavailableError('La terminal embebida no está disponible');
    const executable = await this.executable('claude');
    const extraEnv = this.deps.accountEnv('claude', accountId);
    const session = this.deps.startTerminal({
      workId: 'mcp-auth',
      brandId: 'mcp-auth',
      provider: 'claude',
      executable,
      args: [],
      cwd,
      extraEnv,
    });
    return {
      mode: 'terminal',
      sessionId: session.id,
      instructions: 'En la terminal escribí /mcp, elegí el servidor, completá el login en el navegador y cerrá con /exit. El token queda en el perfil de esta cuenta.',
    };
  }

  async remove(runtime: 'claude' | 'codex', name: string): Promise<void> {
    if (!SERVER_NAME.test(name)) throw new ValidationError('Nombre inválido');
    const executable = await this.executable(runtime);
    const result = await this.deps.runner(executable, ['mcp', 'remove', name], { timeoutMs: this.timeout, env: this.envFor(runtime) });
    if (result.error || result.timedOut) throw new UnavailableError(result.error ?? 'el comando demoró demasiado');
    if (result.code !== 0) throw new UnavailableError(firstLine(result.stderr || result.stdout) || 'no se pudo quitar');
  }

  private async executable(runtime: 'claude' | 'codex'): Promise<string> {
    const found = await this.deps.detector.resolve(runtime);
    if (!found) throw new UnavailableError(`${runtime} no está instalado o no está en el PATH`);
    return found.executable;
  }

  private envFor(runtime: ChatRuntime): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) if (typeof v === 'string') base[k] = v;
    if (runtime === 'claude' || runtime === 'codex') Object.assign(base, this.deps.accountEnv(runtime, this.deps.primaryAccountId?.(runtime) ?? null));
    return base;
  }
}

function canEdit(runtime: ChatRuntime): boolean {
  return runtime !== 'opencode';
}

export function claudeAddArgs(input: { name: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string; env: string[] }): string[] {
  const args = ['mcp', 'add', '--scope', 'user'];
  if (input.transport === 'http') {
    args.push('--transport', 'http', input.name, input.url);
    return args;
  }
  for (const pair of input.env) args.push('-e', pair);
  args.push(input.name, '--', input.command, ...input.args);
  return args;
}

export function codexAddArgs(input: { name: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string; env: string[] }): string[] {
  const args = ['mcp', 'add'];
  if (input.transport === 'http') {
    args.push(input.name, '--url', input.url);
    return args;
  }
  for (const pair of input.env) args.push('--env', pair);
  args.push(input.name, '--', input.command, ...input.args);
  return args;
}

/** `codex mcp list --json` is the only structured output of the three. */
export function parseCodex(stdout: string): McpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const servers: McpServer[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    if (!name) continue;
    const transport = typeof e.transport === 'object' && e.transport !== null ? (e.transport as Record<string, unknown>) : {};
    const type = transport.type === 'http' || transport.type === 'sse' ? 'http' : 'stdio';
    const command = typeof transport.command === 'string' ? transport.command : '';
    const args = Array.isArray(transport.args) ? transport.args.filter((a): a is string => typeof a === 'string') : [];
    const url = typeof transport.url === 'string' ? transport.url : '';
    servers.push({
      name,
      transport: type,
      target: type === 'http' ? url : [command, ...args].filter(Boolean).join(' '),
      status: e.enabled === false ? 'disabled' : 'configured',
      detail: typeof e.disabled_reason === 'string' && e.disabled_reason ? e.disabled_reason : '',
    });
  }
  return servers;
}

/** `claude mcp list` prints `name: command - ✔ Connected` (or a failure reason). */
export function parseClaude(stdout: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line || line.startsWith('Checking')) continue;
    // A server name may contain colons (a plugin one reads 'plugin:engram:engram'),
    // so the separator is the first ': ' with a space, never the first colon.
    const colon = line.indexOf(': ');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!SERVER_NAME.test(name)) continue;
    const rest = line.slice(colon + 2).trim();
    const split = rest.lastIndexOf(' - ');
    const target = (split === -1 ? rest : rest.slice(0, split)).trim();
    const stateText = split === -1 ? '' : rest.slice(split + 3).trim();
    const status = statusFromClaude(stateText);
    servers.push({
      name,
      transport: /^https?:\/\//.test(target) ? 'http' : 'stdio',
      target,
      status,
      detail: cleanDetail(stateText),
      needsAuth: status === 'needsAuth',
    });
  }
  return servers;
}

function statusFromClaude(text: string): McpServer['status'] {
  const plain = text.toLowerCase();
  if (plain.includes('needs authentication') || plain.includes('authentication')) return 'needsAuth';
  if (plain.includes('connected')) return 'connected';
  if (plain.includes('pending')) return 'pending';
  if (plain.includes('fail') || plain.includes('error')) return 'failed';
  return 'configured';
}

function applyCodexAuth(servers: McpServer[], statuses: Array<{ name: string; authStatus: string }>): void {
  const byName = new Map(statuses.map((s) => [s.name, s.authStatus]));
  for (const server of servers) {
    const auth = byName.get(server.name);
    if (!auth) continue;
    server.needsAuth = auth === 'notLoggedIn';
    if (auth === 'notLoggedIn') {
      server.status = 'needsAuth';
      if (!server.detail) server.detail = 'Requiere iniciar sesión';
    }
  }
}

function applyClaudeInit(servers: McpServer[], init: Array<{ name: string; status: string }>): void {
  const byName = new Map(init.map((s) => [s.name, s.status]));
  for (const server of servers) {
    const status = byName.get(server.name);
    if (!status) continue;
    const mapped = mapClaudeInitStatus(status);
    if (mapped === 'needsAuth') {
      server.status = 'needsAuth';
      server.needsAuth = true;
    } else if (mapped) server.status = mapped;
  }
}

function mapClaudeInitStatus(status: string): McpServer['status'] | null {
  const plain = status.toLowerCase();
  if (plain === 'needs-auth' || plain === 'needsauth') return 'needsAuth';
  if (plain === 'connected') return 'connected';
  if (plain === 'failed') return 'failed';
  if (plain === 'pending') return 'pending';
  if (plain === 'disabled') return 'disabled';
  return null;
}

/** OpenCode prints a decorated tree; only the name, state and target matter. */
export function parseOpenCode(stdout: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = stripAnsi(stdout).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^[^A-Za-z0-9✓✗×]*/u, '').trim();
    const match = /^(✓|✗|×)\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, mark, name, state] = match;
    const next = lines[i + 1] ? stripAnsi(lines[i + 1]).replace(/^[^A-Za-z0-9]*/u, '').trim() : '';
    const target = /^(https?:\/\/|[A-Za-z]:\\|\/|npx|node|python|uvx|bun)/.test(next) ? next : '';
    servers.push({
      name,
      transport: /^https?:\/\//.test(target) ? 'http' : 'stdio',
      target,
      status: mark === '✓' ? 'connected' : 'failed',
      detail: state.trim(),
    });
  }
  return servers;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function cleanDetail(text: string): string {
  return text.replace(/[✔✘✓✗×⏸]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function firstLine(text: string): string {
  return stripAnsi(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
