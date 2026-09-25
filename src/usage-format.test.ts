import { describe, expect, it, vi } from 'vitest';
// usage-format imports formatMessage from './i18n', which in turn imports the
// real './browser-api' for its locale getters; that module reaches for
// `window` at module scope, which does not exist under the node test
// environment. Same workaround as optional-mcp-view.test.ts and
// work-outcome-view.test.ts.
vi.mock('./browser-api', () => ({ api: {} }));
const { EMPTY_USAGE } = await import('../shared/contracts');
type ChatUsage = import('../shared/contracts').ChatUsage;
const { cacheShare, contextWeight, describeUsage, describeUsageDetail, formatTokens, isHeavyConversation, totalTokens } = await import('./usage-format');

const usage = (patch: Partial<ChatUsage>): ChatUsage => ({ ...EMPTY_USAGE, ...patch });

describe('formatTokens', () => {
  it('shows small counts as plain numbers in both locales', () => {
    expect(formatTokens(0, 'es-AR')).toBe('0');
    expect(formatTokens(850, 'es-AR')).toBe('850');
    expect(formatTokens(850, 'en-US')).toBe('850');
  });

  it('abbreviates thousands the way a marketer would say them out loud', () => {
    expect(formatTokens(12_000, 'es-AR')).toBe('12 mil');
    expect(formatTokens(12_000, 'en-US')).toBe('12K');
  });

  it('abbreviates millions with one decimal, locale-aware', () => {
    expect(formatTokens(1_200_000, 'es-AR')).toBe('1,2 M');
    expect(formatTokens(1_200_000, 'en-US')).toBe('1.2M');
  });

  it('drops a decimal that would just be zero', () => {
    expect(formatTokens(12_000, 'es-AR')).not.toContain(',0');
    expect(formatTokens(2_000_000, 'en-US')).toBe('2M');
  });
});

describe('totalTokens', () => {
  it('sums every flavor of token the runtime reported', () => {
    expect(totalTokens(usage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }))).toBe(20);
    expect(totalTokens(EMPTY_USAGE)).toBe(0);
  });
});

describe('cacheShare', () => {
  it('is the fraction of input tokens served from the prompt cache', () => {
    expect(cacheShare(usage({ inputTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50 }))).toBeCloseTo(0.85);
  });

  it('is zero when there is no input to share, never a division error', () => {
    expect(cacheShare(EMPTY_USAGE)).toBe(0);
  });

  it('ignores output tokens: only input flavors count', () => {
    expect(cacheShare(usage({ inputTokens: 0, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 1000 }))).toBe(1);
  });
});

describe('contextWeight', () => {
  it('is light below 30K and treats an unknown context as light', () => {
    expect(contextWeight(null)).toBe('light');
    expect(contextWeight(0)).toBe('light');
    expect(contextWeight(29_999)).toBe('light');
  });

  it('is medium from 30K up to (not including) 100K', () => {
    expect(contextWeight(30_000)).toBe('medium');
    expect(contextWeight(99_999)).toBe('medium');
  });

  it('is heavy at 100K and above', () => {
    expect(contextWeight(100_000)).toBe('heavy');
    expect(contextWeight(500_000)).toBe('heavy');
  });
});

describe('describeUsage', () => {
  // The total `ChatManager` reports for a REAL opencode 1.18.32 turn with one
  // tool (two model calls, free model, cost 0): see
  // tests/backend/opencode-usage-tier.test.ts for how it is added up.
  it('an OpenCode member reads "Contexto: X · Y generados", context from the last call', () => {
    const opencodeTurn = usage({ inputTokens: 19_216, outputTokens: 310, cacheReadTokens: 23_244, cacheWriteTokens: 0, turns: 2, costUsd: null, contextTokens: 21_429 });
    expect(describeUsage(opencodeTurn, 'es-AR')).toBe('Contexto: 21,4 mil · 19,5 mil generados');
    expect(describeUsage(opencodeTurn, 'en-US')).toBe('Context: 21.4K · 19.5K generated');
  });

  it('says nothing before the first turn', () => {
    expect(describeUsage(EMPTY_USAGE, 'es-AR')).toBe('');
    expect(describeUsage(usage({ turns: 0, inputTokens: 500 }), 'en-US')).toBe('');
  });

  it('never mentions "tokens" in the primary line', () => {
    const line = describeUsage(usage({ turns: 1, inputTokens: 15_000, cacheReadTokens: 85_000, outputTokens: 20_000, contextTokens: 100_000 }), 'es-AR');
    expect(line.toLowerCase()).not.toContain('token');
  });

  /**
   * N3: DOS COSAS HONESTAS, NO UN TOTAL QUE CUENTA LA CACHÉ A PESO COMPLETO.
   *
   * "Consumo: 15,9 M · 94% vino de la memoria" sumaba cada relectura de caché
   * como si fuera trabajo nuevo. Ahora: el tamaño del contexto actual y, sin
   * precio, lo nuevo (entrada sin caché + salida) como "generado".
   */
  it('says the current context and what was generated, per locale', () => {
    const data = usage({ turns: 4, inputTokens: 15_000, cacheReadTokens: 15_800_000, cacheWriteTokens: 0, outputTokens: 20_000, contextTokens: 120_000 });
    expect(describeUsage(data, 'es-AR')).toBe('Contexto: 120 mil · 35 mil generados');
    expect(describeUsage(data, 'en-US')).toBe('Context: 120K · 35K generated');
  });

  it('with a price, the price instead of the generated count', () => {
    const data = usage({ turns: 2, inputTokens: 15_000, outputTokens: 20_000, contextTokens: 40_000, costUsd: 0.42 });
    expect(describeUsage(data, 'en-US')).toBe('Context: 40K · spent $0.42');
    expect(describeUsage(data, 'es-AR')).toMatch(/^Contexto: 40 mil · gastó US\$\s?0,42$/);
  });

  it('without a context reading, only the spend', () => {
    expect(describeUsage(usage({ turns: 1, inputTokens: 500, outputTokens: 500 }), 'en-US')).toBe('1K generated');
  });

  it('the cache share stays, as the detail', () => {
    const data = usage({ turns: 4, inputTokens: 15_000, cacheReadTokens: 85_000, outputTokens: 20_000, contextTokens: 100_000 });
    expect(describeUsageDetail(data, 'es-AR')).toContain('85% vino de la memoria de la conversación');
    expect(describeUsageDetail(data, 'en-US')).toContain("85% came from the conversation's memory");
  });
});

describe('N3: el aviso de conversación pesada', () => {
  it('sale sólo con el contexto de la última lectura en 100 mil o más', () => {
    // Tres turnos de 90 mil: el total que llega del backend dice 90 mil, no 270.
    expect(isHeavyConversation(usage({ turns: 3, cacheReadTokens: 267_000, contextTokens: 90_000 }))).toBe(false);
    expect(contextWeight(90_000)).toBe('medium');
    expect(isHeavyConversation(usage({ turns: 4, cacheReadTokens: 367_000, contextTokens: 100_000 }))).toBe(true);
  });
});
