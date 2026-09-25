import { DEFAULT_EFFORT_TIER, EFFORT_TIERS, type EffortTier } from '../../shared/contracts';

/**
 * The single place where "how hard should this member work" becomes runtime
 * flags. The human picks light / balanced / deep once; every runtime reads
 * that same choice and says it in its own words, so the concept stays in the
 * hub and the dialect stays in the adapter.
 *
 * Two rules hold across all three runtimes:
 * - Never a full model ID. Aliases only, because a pinned `claude-sonnet-4-5`
 *   is a promise that expires the day the alias moves on.
 * - An explicit model the human chose is never replaced. The tier then only
 *   contributes the effort, which is the part they did not pick.
 */
export function isEffortTier(value: unknown): value is EffortTier {
  return typeof value === 'string' && (EFFORT_TIERS as readonly string[]).includes(value);
}

/** Anything unknown (an old row, a hand-edited front matter) lands on the default rather than failing. */
export function asEffortTier(value: unknown): EffortTier {
  return isEffortTier(value) ? value : DEFAULT_EFFORT_TIER;
}

/**
 * Claude Code takes both parts as process arguments: `--model` with an alias
 * and `--effort` with one of low|medium|high|xhigh|max (verified against
 * `claude --help` on 2.1.269). `balanced` is deliberately `sonnet` at high
 * effort rather than a bigger model: thinking longer on the everyday model is
 * what a marketing turn usually needs, and it keeps the plan affordable.
 */
const CLAUDE: Record<EffortTier, { model: string; effort: string }> = {
  light: { model: 'sonnet', effort: 'low' },
  balanced: { model: 'sonnet', effort: 'high' },
  deep: { model: 'opus', effort: 'xhigh' },
};

/**
 * `--effort` is not in every Claude Code: it appeared around 2.1.205. Passing
 * it to an older CLI is not a degraded answer, it is a process that refuses to
 * start, so a version we can read and that is older gets the model alone.
 * A version we cannot read is not evidence of an old CLI, so the flag is kept.
 */
const EFFORT_SINCE = [2, 1, 205] as const;

export function claudeSupportsEffort(cliVersion: string | null): boolean {
  const parsed = parseVersion(cliVersion);
  if (!parsed) return true;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] !== EFFORT_SINCE[i]) return parsed[i] > EFFORT_SINCE[i];
  }
  return true;
}

/** `claude --version` prints `2.1.269 (Claude Code)`; only the leading triple is read. */
function parseVersion(value: string | null): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * `--mcp-config`/`--strict-mcp-config` exist earlier, but 2.1.246 is the
 * first release documented to skip the approval prompt for a project-scoped
 * server outside `--strict-mcp-config` (code.claude.com/docs/en/mcp). Below
 * it, a headless `-p` process has no human to answer that prompt and would
 * hang forever — worse than simply not offering coordination that session.
 * Unlike `claudeSupportsEffort`, an unreadable version is treated as NOT
 * supported: a flag that only fails fast is safe to guess on, a flag that
 * can hang a child process forever is not.
 */
const MCP_INJECTION_SINCE = [2, 1, 246] as const;

export function claudeSupportsMcpInjection(cliVersion: string | null): boolean {
  const parsed = parseVersion(cliVersion);
  if (!parsed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] !== MCP_INJECTION_SINCE[i]) return parsed[i] > MCP_INJECTION_SINCE[i];
  }
  return true;
}

export function claudeArgsForTier(tier: EffortTier, explicitModel: string | null, cliVersion: string | null): string[] {
  const mapping = CLAUDE[asEffortTier(tier)];
  const chosen = explicitModel && explicitModel.trim() ? explicitModel.trim() : mapping.model;
  const args = ['--model', chosen];
  if (claudeSupportsEffort(cliVersion)) args.push('--effort', mapping.effort);
  return args;
}

/**
 * Codex names the same idea `effort`, and its app-server takes it on
 * `turn/start` ("Override the reasoning effort for this turn and subsequent
 * turns", generated protocol schema). Per turn is what Latte needs: one server
 * is shared by every member of an account, so a launch-time `-c
 * model_reasoning_effort=` would put one member's choice on all of them.
 */
const CODEX: Record<EffortTier, string> = { light: 'low', balanced: 'medium', deep: 'high' };

export function codexEffortForTier(tier: EffortTier): string {
  return CODEX[asEffortTier(tier)];
}

/**
 * OpenCode calls it a `variant` on the prompt body (its OpenAPI lists
 * `variant: string` on POST /session/{id}/prompt_async). The server decides
 * what a variant means for the provider behind the model; Latte only says
 * which of the three it wants.
 */
const OPENCODE: Record<EffortTier, string> = { light: 'low', balanced: 'medium', deep: 'high' };

export function opencodeVariantForTier(tier: EffortTier): string {
  return OPENCODE[asEffortTier(tier)];
}

/**
 * The nearest step each tier accepts when the model lacks its own, in order.
 * `deep` stays `high` even on a model that offers `xhigh`/`max`, the same
 * ceiling Codex uses: the tier promises "think harder", not "the most
 * expensive setting this provider sells".
 */
const OPENCODE_LADDER: Record<EffortTier, readonly string[]> = {
  light: ['low', 'minimal', 'medium'],
  balanced: ['medium', 'high', 'low'],
  deep: ['high', 'xhigh', 'max', 'medium'],
};

/**
 * The tier, said in the variants THIS model has. OpenCode lists them per
 * model in `GET /config/providers` (`models[id].variants`), and they differ a
 * lot: measured on 1.18.32, one free model offers low/medium/high, another
 * low..max, and the default one offers none at all.
 *
 * - `null` catalog (unknown): the tier's own word, as before.
 * - An empty list: the model has no effort knob, so nothing is sent.
 * - Otherwise the first step of the tier's ladder the model lists, or nothing
 *   rather than a word the model never offered.
 *
 * The MODEL never comes from the tier on OpenCode: its providers are
 * arbitrary (any API key, any local server), so there is no alias like
 * Claude's `sonnet`/`opus` to map to. The member's own `model` is sent on every
 * prompt when set; otherwise OpenCode's default model answers. Nothing about
 * the model goes into the inline config.
 */
export function opencodeVariantFor(tier: EffortTier, available: readonly string[] | null): string | null {
  const safeTier = asEffortTier(tier);
  if (available === null) return OPENCODE[safeTier];
  return OPENCODE_LADDER[safeTier].find((step) => available.includes(step)) ?? null;
}

/**
 * Grok Build lo llama `reasoning_effort` y lo cambia en vivo con
 * `session/set_config_option` (medido en 1.0.41: el valor va como string; una
 * sesión nueva arranca en `high`). El modelo no se toca: la cuenta ofrece uno
 * solo (`grok-4.7`), así que el nivel sólo mueve el esfuerzo.
 */
const GROK: Record<EffortTier, string> = { light: 'low', balanced: 'medium', deep: 'high' };

export function grokEffortForTier(tier: EffortTier): string {
  return GROK[asEffortTier(tier)];
}

/**
 * Hermes es multiproveedor: el nivel elige `proveedor:modelo`. Los defaults
 * salen de lo que la instalación del dueño tiene logueado (brief 2026-09-25,
 * decisión 2): su suscripción de ChatGPT por `openai-codex`, sin costo por
 * token. Son de la familia GPT-5.6 y no GPT-6 a propósito: Hermes 0.21 no
 * puede cambiar por ACP a un modelo del mismo proveedor que no esté en su
 * catálogo estático (lo reencamina a OpenRouter y falla), y `gpt-6-*` todavía
 * no está (brief 7.1, punto 10). Ajustes los pisa por nivel.
 */
export const HERMES_DEFAULT_TIER_MODELS: Record<EffortTier, string> = {
  light: 'openai-codex:gpt-5.6-luna',
  balanced: 'openai-codex:gpt-5.6-terra',
  deep: 'openai-codex:gpt-5.6-sol',
};

/** El modelo que el humano eligió gana siempre; si no, el de Ajustes para ese nivel; si no, el default. */
export function hermesModelForTier(tier: EffortTier, explicitModel: string | null, configured: string | null): string {
  const chosen = explicitModel?.trim() || configured?.trim();
  return chosen || HERMES_DEFAULT_TIER_MODELS[asEffortTier(tier)];
}
