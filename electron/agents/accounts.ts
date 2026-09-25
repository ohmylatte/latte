import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EFFORT_TIERS, type AccountRuntimeName, type AgentAccount } from '../../shared/contracts';
import { isolatedHome } from './acp/profiles';
import { HERMES_DEFAULT_TIER_MODELS } from './tiers';
import { writeFileAtomic, readTextIfExists } from '../core/atomicFile';
import { NotFoundError, ValidationError } from '../core/errors';
import { safeJoin } from '../core/paths';
import type { CommandRunner } from '../runtime/commandRunner';
import { scrubEnv } from '../runtime/terminalManager';

export type AccountRuntime = AccountRuntimeName;

/** Los runtimes que sólo corren con cuentas gestionadas por Latte: sin "mi sesión". */
export function managedOnly(runtime: AccountRuntime): boolean {
  return runtime === 'grok' || runtime === 'hermes';
}

const RUNTIME_NAME: Record<AccountRuntime, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', hermes: 'Hermes' };

export const SYSTEM_ACCOUNT_ID = 'system';
const ACCOUNT_ID = /^acc_[a-f0-9]{16}$/;
/** The aliases `claude --model` documents. Each one points at the latest model of its tier. */
const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet'] as const;

interface AccountRecord { id: string; label: string; createdAt: string }

export interface AccountStoreDeps {
  /** <dataDir>/accounts */
  root: string;
  runner: CommandRunner;
  resolveExecutable: (runtime: AccountRuntime) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Environment variable each CLI reads to relocate its profile (auth + settings). */
export const PROFILE_ENV: Record<AccountRuntime, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME', hermes: 'HERMES_HOME' };

/**
 * Orca-style account management: every Latte-managed account is a directory
 * the CLI treats as its home (CLAUDE_CONFIG_DIR / CODEX_HOME). The CLI does
 * its own OAuth into that directory; Latte only lists, labels and probes.
 * The "system" pseudo-account points at the user's regular CLI profile.
 */
export class AccountStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(private readonly deps: AccountStoreDeps) {
    this.env = deps.env ?? process.env;
    this.timeoutMs = deps.timeoutMs ?? 12_000;
  }

  static isValidId(value: unknown): value is string {
    return value === SYSTEM_ACCOUNT_ID || (typeof value === 'string' && ACCOUNT_ID.test(value));
  }

  dir(runtime: AccountRuntime, accountId: string): string {
    if (accountId === SYSTEM_ACCOUNT_ID) throw new ValidationError('The system profile has no managed directory');
    if (!ACCOUNT_ID.test(accountId)) throw new ValidationError('Invalid account id');
    return safeJoin(this.deps.root, runtime, accountId);
  }

  /** Environment overlay that points the CLI at the account's profile (empty for the system profile). */
  envFor(runtime: AccountRuntime, accountId: string | null): Record<string, string> {
    if (!accountId || accountId === SYSTEM_ACCOUNT_ID) return {};
    const dir = this.dir(runtime, accountId);
    if (!managedOnly(runtime)) return { [PROFILE_ENV[runtime]]: dir };
    // Grok y Hermes también leen `~`: el login y el estado ven lo mismo que el
    // agente, un home vacío adentro de la cuenta (brief 7.1, punto 1).
    const home = isolatedHome(dir);
    fs.mkdirSync(home, { recursive: true });
    return { [PROFILE_ENV[runtime]]: dir, USERPROFILE: home, HOME: home };
  }

  /** El directorio de una cuenta gestionada que existe, o `null` (el perfil del sistema, un id que no es de nadie). */
  managedHome(runtime: AccountRuntime, accountId: string | null): string | null {
    if (!accountId || accountId === SYSTEM_ACCOUNT_ID || !ACCOUNT_ID.test(accountId)) return null;
    const dir = this.dir(runtime, accountId);
    return fs.existsSync(dir) ? dir : null;
  }

  list(runtime: AccountRuntime): AccountRecord[] {
    const dir = safeJoin(this.deps.root, runtime);
    if (!fs.existsSync(dir)) return [];
    const records: AccountRecord[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ACCOUNT_ID.test(entry.name)) continue;
      const raw = readTextIfExists(path.join(dir, entry.name, 'latte-account.json'));
      let label = entry.name;
      let createdAt = '';
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<AccountRecord>;
          if (typeof parsed.label === 'string') label = parsed.label;
          if (typeof parsed.createdAt === 'string') createdAt = parsed.createdAt;
        } catch { /* keep defaults */ }
      }
      records.push({ id: entry.name, label, createdAt });
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  create(runtime: AccountRuntime, label: string): AccountRecord {
    const clean = label.trim().replace(/\s+/g, ' ');
    if (clean.length === 0 || clean.length > 80) throw new ValidationError('Account label must be 1-80 characters');
    const record: AccountRecord = { id: `acc_${randomBytes(8).toString('hex')}`, label: clean, createdAt: new Date().toISOString() };
    const dir = this.dir(runtime, record.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, 'latte-account.json'), JSON.stringify(record, null, 2));
    return record;
  }

  remove(runtime: AccountRuntime, accountId: string): void {
    const dir = this.dir(runtime, accountId);
    if (!fs.existsSync(dir)) throw new NotFoundError('Account', accountId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  async describe(runtime: AccountRuntime): Promise<AgentAccount[]> {
    const executable = await this.deps.resolveExecutable(runtime);
    const managed = this.list(runtime);
    const entries: Array<{ id: string; label: string; system: boolean }> = [
      ...(managedOnly(runtime) ? [] : [{ id: SYSTEM_ACCOUNT_ID, label: `Mi sesión de ${RUNTIME_NAME[runtime]}`, system: true }]),
      ...managed.map((m) => ({ id: m.id, label: m.label, system: false })),
    ];
    const results: AgentAccount[] = [];
    for (const entry of entries) {
      const models = this.suggestedModels(runtime, entry.id);
      if (!executable) {
        results.push({ runtime, ...entry, loggedIn: false, detail: `${RUNTIME_NAME[runtime]} no está instalado`, models });
        continue;
      }
      const status = await this.status(runtime, executable, entry.id);
      results.push({ runtime, ...entry, ...status, models });
    }
    return results;
  }

  /**
   * What to offer under the model field. Not a catalog: Latte cannot enumerate
   * what a subscription CLI accepts, so it suggests only what it can state as
   * fact — the aliases Claude Code's own `--model` help documents (an alias
   * always points at the latest model of that tier, so it does not go stale),
   * and the model this Codex profile already has configured.
   */
  suggestedModels(runtime: AccountRuntime, accountId: string): string[] {
    if (runtime === 'claude') return [...CLAUDE_MODEL_ALIASES];
    if (runtime === 'grok') return this.grokCachedModels(accountId);
    if (runtime === 'hermes') {
      const configured = this.hermesConfiguredModel(accountId);
      return [...new Set([...(configured ? [configured] : []), ...EFFORT_TIERS.map((tier) => HERMES_DEFAULT_TIER_MODELS[tier])])];
    }
    const configured = this.codexConfiguredModel(accountId);
    return configured ? [configured] : [];
  }

  /** Los modelos que Grok guardó en su caché la última vez que habló con su servidor (`models_cache.json`). */
  private grokCachedModels(accountId: string): string[] {
    const home = this.managedHome('grok', accountId);
    const raw = home ? readTextIfExists(path.join(home, 'models_cache.json')) : null;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { models?: Record<string, unknown> };
      return parsed.models && typeof parsed.models === 'object' ? Object.keys(parsed.models).filter((id) => /^[\w.:/-]{1,200}$/.test(id)) : [];
    } catch {
      return [];
    }
  }

  /**
   * El modelo que `hermes model` dejó en el `config.yaml` de la cuenta, como
   * `proveedor:modelo`. Se lee el bloque `model:` de arriba, con su sangría, sin
   * un parser de YAML: son dos claves planas que Hermes escribe siempre igual.
   */
  hermesConfiguredModel(accountId: string): string | null {
    const home = this.managedHome('hermes', accountId);
    const raw = home ? readTextIfExists(path.join(home, 'config.yaml')) : null;
    if (!raw) return null;
    const block = /^model:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(raw);
    if (!block) return null;
    const read = (key: string): string | null => {
      for (const line of block[1].split(/\r?\n/)) {
        const match = /^[ \t]+([\w-]+):[ \t]*['"]?([^'"#]*?)['"]?[ \t]*$/.exec(line);
        if (match && match[1] === key && match[2]) return match[2].trim();
      }
      return null;
    };
    const model = read('default');
    const provider = read('provider');
    if (!model) return null;
    return provider ? `${provider}:${model}` : model;
  }

  private codexConfiguredModel(accountId: string): string | null {
    const home = accountId === SYSTEM_ACCOUNT_ID
      ? (this.env.CODEX_HOME ?? (this.env.USERPROFILE || this.env.HOME ? path.join((this.env.USERPROFILE ?? this.env.HOME) as string, '.codex') : null))
      : this.dir('codex', accountId);
    if (!home) return null;
    const config = readTextIfExists(path.join(home, 'config.toml'));
    if (!config) return null;
    // Top-level `model = "..."` only: a value under a [profile] table belongs
    // to that profile, and Latte does not pass one.
    for (const line of config.split(/\r?\n/)) {
      const text = line.trim();
      if (text.startsWith('[')) break;
      const match = /^model\s*=\s*["']([^"']{1,200})["']$/.exec(text);
      if (match) return match[1];
    }
    return null;
  }

  async status(runtime: AccountRuntime, executable: string, accountId: string): Promise<{ loggedIn: boolean; detail: string }> {
    const env = { ...scrubEnv(this.env), ...this.envFor(runtime, accountId) };
    if (runtime === 'claude') {
      const result = await this.deps.runner(executable, ['auth', 'status', '--json'], { timeoutMs: this.timeoutMs, env });
      if (result.error || result.timedOut) return { loggedIn: false, detail: result.timedOut ? 'Claude Code no respondió a tiempo' : `No se pudo consultar Claude Code: ${result.error}` };
      try {
        const parsed = JSON.parse(result.stdout.trim()) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
        if (!parsed.loggedIn) return { loggedIn: false, detail: 'Sin sesión iniciada' };
        const bits = [parsed.subscriptionType ? `Plan ${parsed.subscriptionType}` : null, parsed.authMethod ?? null, parsed.email ?? null].filter(Boolean);
        return { loggedIn: true, detail: bits.join(' · ') || 'Sesión iniciada' };
      } catch {
        return { loggedIn: false, detail: result.code === 0 ? 'Respuesta no reconocida de Claude Code' : 'Sin sesión iniciada' };
      }
    }
    if (runtime === 'grok') return this.grokStatus(executable, env);
    if (runtime === 'hermes') return this.hermesStatus(executable, env, accountId);
    const result = await this.deps.runner(executable, ['login', 'status'], { timeoutMs: this.timeoutMs, env });
    if (result.error || result.timedOut) return { loggedIn: false, detail: result.timedOut ? 'Codex no respondió a tiempo' : `No se pudo consultar Codex: ${result.error}` };
    const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    const loggedIn = result.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
    return { loggedIn, detail: loggedIn ? text.slice(0, 120) : 'Sin sesión iniciada' };
  }

  /**
   * `grok models` dice quién está logueado sin llamar a ningún modelo (medido
   * en 1.0.41: "You are logged in with grok.com." / "You are not
   * authenticated."). El plan no lo dice: la cuenta del dueño está en el plan
   * gratis con una promo, y eso queda "por revisar" (decisión 5).
   */
  private async grokStatus(executable: string, env: Record<string, string>): Promise<{ loggedIn: boolean; detail: string }> {
    const result = await this.deps.runner(executable, ['models'], { timeoutMs: this.timeoutMs, env });
    if (result.error || result.timedOut) return { loggedIn: false, detail: result.timedOut ? 'Grok no respondió a tiempo' : `No se pudo consultar Grok: ${result.error}` };
    const text = `${result.stdout}\n${result.stderr}`;
    const login = /logged in with ([^\s]+?)\.?(?:\s|$)/i.exec(text);
    if (!login || /not authenticated/i.test(text)) return { loggedIn: false, detail: 'Sin sesión iniciada' };
    const model = /Default model:\s*(\S+)/i.exec(text)?.[1];
    return { loggedIn: true, detail: ['Sesión iniciada con ' + login[1], model ? `modelo ${model}` : null].filter(Boolean).join(' · ') };
  }

  /**
   * `hermes auth list` lista las credenciales por proveedor. Tener alguna no
   * alcanza: sin un modelo elegido en el `config.yaml` de la cuenta, ningún
   * turno responde (medido en B1), así que eso también cuenta.
   */
  private async hermesStatus(executable: string, env: Record<string, string>, accountId: string): Promise<{ loggedIn: boolean; detail: string }> {
    const result = await this.deps.runner(executable, ['auth', 'list'], { timeoutMs: this.timeoutMs, env });
    if (result.error || result.timedOut) return { loggedIn: false, detail: result.timedOut ? 'Hermes no respondió a tiempo' : `No se pudo consultar Hermes: ${result.error}` };
    const providers = [...result.stdout.matchAll(/^([\w:.-]+) \((\d+) credentials?\):/gm)].filter((m) => Number(m[2]) > 0).map((m) => m[1]);
    if (providers.length === 0) return { loggedIn: false, detail: 'Sin sesión iniciada' };
    const model = this.hermesConfiguredModel(accountId);
    if (!model) return { loggedIn: false, detail: `Credenciales de ${providers.join(', ')}, pero sin modelo elegido: volvé a iniciar sesión y elegí uno` };
    return { loggedIn: true, detail: `${providers.join(', ')} · modelo ${model}` };
  }
}
