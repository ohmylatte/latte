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
