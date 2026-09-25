import fs from 'node:fs';
import path from 'node:path';
import { hermesModelForTier } from '../../tiers';
import type { AdapterStartInput } from '../../types';
import type { AcpEnvContext, AcpProfile, AcpSessionSetup, AcpSessionSetupResult } from '../profiles';
import { isRecord } from '../types';
import { isolatedHome } from './grok';

/**
 * El arreglo del cuelgue de Hermes en Windows (brief 7.1, punto 8).
 *
 * `tools/environments/local.py:_bash_starts` corre `bash` con
 * `subprocess.run(..., capture_output=True)` y SIN `stdin`: el hijo hereda el
 * pipe de ACP mientras el lector de Hermes tiene un `ReadFile` sincrónico
 * pendiente sobre ese mismo pipe, y Windows serializa las dos cosas. Hermes se
 * queda para siempre en "Creating new local environment" al primer archivo.
 *
 * Python importa `sitecustomize` solo al arrancar. Éste apunta el handle de
 * entrada estándar del PROCESO a `NUL`: el descriptor 0 de Python ya quedó
 * atado al pipe (ACP sigue leyendo de ahí) y los hijos que no piden stdin
 * heredan `NUL`. No toca nada fuera de Windows.
 */
export const HERMES_STDIN_FIX = [
  '# Latte: los hijos de Hermes no heredan el pipe de ACP como stdin (Windows).',
  '# Ver electron/agents/acp/profiles/hermes.ts en el repo de Latte.',
  'import os',
  "if os.name == 'nt':",
  '    try:',
  '        import ctypes, msvcrt',
  "        _latte_nul = open(os.devnull, 'rb')",
  '        ctypes.windll.kernel32.SetStdHandle(-10, msvcrt.get_osfhandle(_latte_nul.fileno()))',
  '    except Exception:',
  '        pass',
  '',
].join('\n');

const STDIN_FIX_DIR = 'hermes-stdin-fix';

/**
 * Lo que Latte exige del `config.yaml` de una cuenta de Hermes: que los
 * comandos peligrosos le pregunten a la persona. El default de Hermes es
 * `smart`, un LLM auxiliar que los aprueba solo (medido: aprobó un `rm -rf`).
 */
const APPROVALS_BLOCK = 'approvals:\n  mode: manual\n';

/**
 * Hermes Agent 0.21 como agente ACP (`hermes acp`, el `hermes.exe` del venv,
 * nunca `hermes.cmd`).
 *
 * - Aislamiento: `HERMES_HOME` de la cuenta y `USERPROFILE`/`HOME` a un
 *   directorio vacío; el home nuevo trae su `SOUL.md` de fábrica y nada más.
 * - Prompt de rol: ACP no tiene dónde, así que va antes del primer mensaje
 *   (decisión 3). Cómo medir cuánto sobrevive a la compactación: brief 7.1.
 * - Modelo: `session/set_model` pierde los MCP inyectados por ACP, así que
 *   después va un `session/load` con los mismos `mcpServers` (workaround
 *   verificado). Si Hermes rechaza el modelo, la sesión sigue con el suyo y
 *   la persona se entera.
 * - Permisos: modo `default` (o `accept_edits` con la carpeta confiada, que
 *   Hermes acota al workspace y /tmp). Niega solo un permiso a los 60 s.
 * - Sin preguntas nativas: `clarify` no está en el toolset de ACP.
 * - MCP: no confirma por ACP (sólo en su stderr); tools `mcp__<servidor>__<tool>`.
 * - Uso: el `usage` estándar del `PromptResponse` y `usage_update.used` como
 *   contexto; sin costo.
 */
export const hermesProfile: AcpProfile = {
  runtime: 'hermes',
  label: 'Hermes',
  args: ['acp'],
  // En frío, `session/new` tardó 53,7 s en un home recién creado (medido).
  startupTimeoutMs: 120_000,
  env: (ctx: AcpEnvContext) => {
    const home = isolatedHome(ctx.accountHome);
    const env: Record<string, string> = {
      HERMES_HOME: ctx.accountHome,
      USERPROFILE: home,
      HOME: home,
      PYTHONIOENCODING: 'utf-8',
    };
    if (ctx.platform === 'win32' && ctx.supportDir) env.PYTHONPATH = path.join(ctx.supportDir, STDIN_FIX_DIR);
    return env;
  },
  prepareHome: (ctx) => {
    fs.mkdirSync(isolatedHome(ctx.accountHome), { recursive: true });
    ensureManualApprovals(ctx.accountHome);
    if (ctx.platform === 'win32' && ctx.supportDir) {
      const dir = path.join(ctx.supportDir, STDIN_FIX_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sitecustomize.py');
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== HERMES_STDIN_FIX) fs.writeFileSync(file, HERMES_STDIN_FIX);
    }
  },
  firstPromptPreamble: hermesPreamble,
  setupSession: setupHermesSession,
  questions: null,
  permissionTimeoutMs: 60_000,
  confirmsMcpInjection: false,
  mcpToolName: (server, tool) => `mcp__${server}__${tool}`,
};

/**
 * Agrega `approvals: {mode: manual}` si la cuenta no dice nada de aprobaciones.
 * Si la persona ya eligió un modo en ESTA cuenta, se respeta: es suya.
 */
export function ensureManualApprovals(accountHome: string): void {
  const file = path.join(accountHome, 'config.yaml');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^approvals\s*:/m.test(current)) return;
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${current}${separator}${APPROVALS_BLOCK}`);
}

/** El rol y cómo encontrar las tools de Latte, antes del primer mensaje. */
export function hermesPreamble(input: AdapterStartInput): string | null {
  const parts: string[] = [];
  const instructions = input.instructions?.trim();
  if (instructions) parts.push(instructions);
  const servers = (input.mcpServers ?? []).map((s) => s.name);
  if (servers.length > 0) {
    parts.push([
      'Latte tools come from MCP servers and are named `mcp__<server>__<tool>`',
      `(servers here: ${servers.map((s) => `\`${s}\``).join(', ')}).`,
      'If you do not see one, find it with `tool_search` using the word "latte", then `tool_describe` and `tool_call`.',
    ].join(' '));
  }
  if (parts.length === 0) return null;
  return ['[Latte: your role and rules for this whole conversation]', ...parts].join('\n\n');
}

async function setupHermesSession(setup: AcpSessionSetup): Promise<AcpSessionSetupResult> {
  const mode = setup.input.trustedFolder ? 'accept_edits' : 'default';
  try {
    await setup.connection.request('session/set_mode', { sessionId: setup.sessionId, modeId: mode }, setup.timeoutMs);
  } catch (error) {
    setup.log(`session/set_mode ${mode} refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  const models = isRecord(setup.opened.models) ? setup.opened.models : {};
  const current = typeof models.currentModelId === 'string' ? models.currentModelId : null;
  const wanted = hermesModelForTier(setup.tier, setup.input.model ?? null, setup.tierModel);
  if (current && (current === wanted || current.endsWith(`:${wanted}`))) return { model: current };
  try {
    await setup.connection.request('session/set_model', { sessionId: setup.sessionId, modelId: wanted }, setup.timeoutMs);
  } catch (error) {
    return {
      model: current,
      notice: `Hermes did not switch to ${wanted} (${error instanceof Error ? error.message : String(error)}); this conversation keeps ${current ?? 'the model of its account'}.`,
    };
  }
  // El bug de `set_model`: reconstruye el agente sin los MCP de ACP. Un
  // `session/load` con los mismos servidores los vuelve a registrar.
  await setup.quietly(() => setup.connection.request('session/load', { sessionId: setup.sessionId, cwd: setup.cwd, mcpServers: setup.mcpServers }, setup.timeoutMs));
  return { model: wanted };
}
