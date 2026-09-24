import type { ChatUsage, UiLocale } from '../shared/contracts';
import { formatMessage } from './i18n';

/**
 * Renderer-only display math for what a conversation has consumed. Every
 * number comes straight from `ChatUsage`, itself sourced from the runtime and
 * never estimated (see shared/contracts.ts) — this module only decides how to
 * say it in a way a non-technical marketer reads at a glance, in their own
 * language. It never says "tokens" in anything meant as a primary line; that
 * word is explained once, in help text, by the caller.
 */

/** Every token this usage represents, regardless of flavor (fresh, cached read/write, or generated). */
export function totalTokens(usage: ChatUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * A big count in plain words instead of a raw integer: below a thousand, the
 * number itself; below a million, "12 mil" / "12K"; above it, "1,2 M" / "1.2M".
 * The decimal mark and thousands grouping follow the locale via `Intl`; only
 * the "mil"/"K"/"M" suffix is chosen by hand, since that is not something
 * `Intl.NumberFormat`'s compact notation phrases the way a marketer expects.
 */
export function formatTokens(n: number, locale: UiLocale): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
  const million = abs >= 1_000_000;
  const value = n / (million ? 1_000_000 : 1_000);
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const suffix = locale === 'es-AR' ? (million ? ' M' : ' mil') : (million ? 'M' : 'K');
  return formatted + suffix;
}

/**
 * Share (0..1) of this conversation's input that was served from the prompt
 * cache instead of processed fresh. Cache reads are what keeps a long
 * conversation affordable, so this is the number that explains why one turn
 * was cheap and another was not. Zero when there is no input yet to share.
 */
export function cacheShare(usage: ChatUsage): number {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return input > 0 ? usage.cacheReadTokens / input : 0;
}

export type ContextWeight = 'light' | 'medium' | 'heavy';

/** How much a conversation's own memory now costs to re-read on every new message. */
export function contextWeight(contextTokens: number | null): ContextWeight {
  const n = contextTokens ?? 0;
  if (n < 30_000) return 'light';
  if (n < 100_000) return 'medium';
  return 'heavy';
}

/** The warning is about the NEXT message: only the context as it stands now counts, never a sum. */
export function isHeavyConversation(usage: ChatUsage): boolean {
  return contextWeight(usage.contextTokens) === 'heavy';
}

function formatUsd(value: number, locale: UiLocale): string {
  const digits = value < 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 3 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', ...digits }).format(value);
}

/**
 * The one line a marketer sees about a conversation, with two honest numbers.
 *
 * N3: it used to be the grand total of every token, cache reads at full
 * weight: "15,9 M" after a short morning, 94% of it the same context re-read
 * turn after turn. Now it says (1) how big the context is right now — what
 * the next message re-reads — and (2) what was actually spent: the price when
 * the runtime gave one, otherwise the new tokens (fresh input plus output) as
 * "generated". Empty before the first turn: nothing honest to report yet.
 */
export function describeUsage(usage: ChatUsage, locale: UiLocale): string {
  if (usage.turns <= 0) return '';
  const parts: string[] = [];
  if (usage.contextTokens != null && usage.contextTokens > 0) parts.push(formatMessage(locale, 'usage.context', { tokens: formatTokens(usage.contextTokens, locale) }));
  parts.push(usage.costUsd != null
    ? formatMessage(locale, 'usage.spent', { cost: formatUsd(usage.costUsd, locale) })
    : formatMessage(locale, 'usage.generated', { tokens: formatTokens(usage.inputTokens + usage.outputTokens, locale) }));
  return parts.join(' · ');
}

/** The detail behind the line (its tooltip): how much of the input the cache served. */
export function describeUsageDetail(usage: ChatUsage, locale: UiLocale): string {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(cacheShare(usage));
  return formatMessage(locale, 'usage.help') + ' ' + formatMessage(locale, 'usage.cacheShare', { percent });
}
