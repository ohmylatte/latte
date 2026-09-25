import fs from 'node:fs';
import type { ChatQuestionItem, ChatQuestionOption } from '../../../../shared/contracts';
import { tokenCount } from '../../../core/usage';
import { grokEffortForTier } from '../../tiers';
import type { AdapterStartInput } from '../../types';
import { AcpRpcError } from '../connection';
import { isolatedHome, type AcpEnvContext, type AcpProfile, type AcpQuestionBridge, type AcpSessionSetup, type AcpSessionSetupResult, type AcpUsageReading } from '../profiles';
import { isRecord } from '../types';

/** Lo que Grok importa de otras herramientas si no se le dice que no (sus docs y el binario: `GROK_<FUENTE>_<COSA>_ENABLED`). */
const FOREIGN_SOURCES = ['CLAUDE', 'CURSOR', 'CODEX'];
const FOREIGN_THINGS = ['MCPS', 'HOOKS', 'RULES', 'AGENTS', 'SKILLS', 'SESSIONS'];

/**
 * Grok Build 1.0.41 como agente ACP (`grok agent --no-leader stdio`).
 *
 * - Aislamiento: `GROK_HOME` de la cuenta, `USERPROFILE`/`HOME` a un
 *   directorio vacío (sin eso seguía leyendo `~/.claude/settings.json` y
 *   `~/.agents`), las importaciones de Claude/Cursor/Codex apagadas y el
 *   autoupdater quieto. `--no-leader`: sin él se cuelga del leader compartido.
 * - Prompt de sistema: `_meta.rules`, que se AGREGA a sus reglas (decisión 4).
 * - Permisos: `yoloMode:false`. La carpeta confiada no se traduce: el "accept
 *   edits" de Grok no está acotado a la carpeta, así que Grok sigue preguntando.
 * - Preguntas: `_x.ai/ask_user_question`, con la respuesta medida en B1.
 * - MCP: los confirma con `_x.ai/mcp/server_status`; las tools se llaman
 *   `<servidor>__<tool>` y están detrás de `search_tool`/`use_tool`.
 * - Uso: `_meta` del `PromptResponse`, con costo en `costUsdTicks` (1e10 = US$ 1).
 */
export const grokProfile: AcpProfile = {
  runtime: 'grok',
  label: 'Grok',
  args: ['agent', '--no-leader', 'stdio'],
  startupTimeoutMs: 45_000,
  env: (ctx: AcpEnvContext) => {
    const home = isolatedHome(ctx.accountHome);
    const env: Record<string, string> = {
      GROK_HOME: ctx.accountHome,
      USERPROFILE: home,
      HOME: home,
      GROK_DISABLE_AUTOUPDATER: '1',
    };
    for (const source of FOREIGN_SOURCES) for (const thing of FOREIGN_THINGS) env[`GROK_${source}_${thing}_ENABLED`] = '0';
    return env;
  },
  prepareHome: (ctx) => {
    fs.mkdirSync(isolatedHome(ctx.accountHome), { recursive: true });
  },
  sessionMeta: (input) => ({ rules: grokRules(input), yoloMode: false }),
  setupSession: setupGrokSession,
  readUsage: readGrokUsage,
  questions: grokQuestions(),
  permissionTimeoutMs: null,
  confirmsMcpInjection: true,
  mcpSignal: (method, params) => {
    const body = isRecord(params) ? params : {};
    if (method === '_x.ai/mcp/server_status' && typeof body.name === 'string') return { kind: 'status', name: body.name, ready: body.status === 'ready' };
    if (method === '_x.ai/mcp_initialized') return { kind: 'initialized' };
    return null;
  },
  mcpToolName: (server, tool) => `${server}__${tool}`,
};

/**
 * Las reglas que se suman a las de Grok: el rol, y cómo encontrar las tools
 * de Latte. Grok esconde los MCP detrás de `search_tool` (brief, riesgos), así
 * que nombrarlas acá es lo que hace que el modelo las busque.
 */
export function grokRules(input: AdapterStartInput): string {
  const parts: string[] = [];
  const instructions = input.instructions?.trim();
  if (instructions) parts.push(instructions);
  const servers = (input.mcpServers ?? []).map((s) => s.name);
  if (servers.length > 0) {
    parts.push([
      'Latte tools: they come from MCP servers and are named `<server>__<tool>`',
      `(servers here: ${servers.map((s) => `\`${s}\``).join(', ')}; for example \`${servers[0]}__${servers[0] === 'latte_coordination' ? 'latte_report' : 'tool'}\`).`,
      'If you do not see one, find it with `search_tool` using the word "latte" and call it with `use_tool`.',
    ].join(' '));
  }
  return parts.join('\n\n---\n\n');
}

async function setupGrokSession(setup: AcpSessionSetup): Promise<AcpSessionSetupResult> {
  const options = Array.isArray(setup.opened.configOptions) ? setup.opened.configOptions.filter(isRecord) : [];
  const current = (id: string): string | null => {
    const option = options.find((o) => o.id === id);
    return option && typeof option.currentValue === 'string' ? option.currentValue : null;
  };
  let model = current('model');
  const wanted = setup.input.model?.trim() || setup.tierModel?.trim() || null;
  let notice: string | undefined;
  if (wanted && wanted !== model) {
    try {
      await setup.connection.request('session/set_config_option', { sessionId: setup.sessionId, configId: 'model', value: wanted }, setup.timeoutMs);
      model = wanted;
    } catch (error) {
      notice = `Grok did not accept the model "${wanted}" (${error instanceof Error ? error.message : String(error)}); it keeps ${model ?? 'its default model'}.`;
    }
  }
  const effort = grokEffortForTier(setup.tier);
  if (current('reasoning_effort') !== effort) {
    try {
      // El valor va como string: la forma `{value:{value}}` de los docs da -32602 (medido).
      await setup.connection.request('session/set_config_option', { sessionId: setup.sessionId, configId: 'reasoning_effort', value: effort }, setup.timeoutMs);
    } catch (error) {
      // Un modelo sin esfuerzo configurable no es motivo para no arrancar.
      setup.log(`reasoning_effort ${effort} refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { model, ...(notice ? { notice } : {}) };
}

/**
 * `_meta` del `PromptResponse` (medido): `inputTokens` es el contexto de la
 * ÚLTIMA llamada (entrada + caché) y `usage` el acumulado del turno, con
 * `costUsdTicks` en diez mil millonésimas de dólar.
 */
export function readGrokUsage(result: Record<string, unknown>): AcpUsageReading | null {
  const meta = isRecord(result._meta) ? result._meta : null;
  const usage = meta && isRecord(meta.usage) ? meta.usage : null;
  if (!meta || !usage) return null;
  const ticks = typeof usage.costUsdTicks === 'number' && Number.isFinite(usage.costUsdTicks) ? usage.costUsdTicks : null;
  const lastCall = tokenCount(meta.inputTokens);
  return {
    inputTokens: tokenCount(usage.inputTokens),
    cachedReadTokens: tokenCount(usage.cachedReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheCreationTokens),
    outputTokens: tokenCount(usage.outputTokens),
    costUsd: ticks !== null ? ticks / 1e10 : null,
    lastCallContext: lastCall > 0 ? lastCall : null,
  };
}

/**
 * `_x.ai/ask_user_question` (medido en B1): `questions[{question,
 * options[{label, description}], multiSelect}]`, y la respuesta que Grok
 * acepta es `{outcome:'accepted', answers:{"<pregunta>":"<etiqueta>"},
 * annotations:{}}`. Descartar no está medido: se contesta con un error, que
 * Grok le devuelve al modelo como la tool fallida.
 */
export function grokQuestions(): AcpQuestionBridge {
  return {
    method: '_x.ai/ask_user_question',
    parse: (params) => {
      const body = isRecord(params) ? params : {};
      const raw = Array.isArray(body.questions) ? body.questions : [];
      const items: ChatQuestionItem[] = [];
      for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.question !== 'string' || !entry.question.trim()) continue;
        const options: ChatQuestionOption[] = (Array.isArray(entry.options) ? entry.options : [])
          .filter(isRecord)
          .filter((o) => typeof o.label === 'string' && o.label)
          .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : '' }));
        items.push({ header: typeof entry.header === 'string' ? entry.header : '', question: entry.question, options, multiple: entry.multiSelect === true, custom: true });
      }
      return items.length > 0 ? items : null;
    },
    answer: (items, answers) => {
      const map: Record<string, string> = {};
      items.forEach((item, index) => {
        const chosen = (answers[index] ?? []).map((a) => a.trim()).filter(Boolean);
        if (chosen.length > 0) map[item.question] = chosen.join(', ');
      });
      return { outcome: 'accepted', answers: map, annotations: {} };
    },
    dismissed: () => new AcpRpcError(-32000, 'The user dismissed these questions in Latte. Continue without an answer, or ask again if you cannot.'),
  };
}
