import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Typography contract — `densidad-tipografica` Pass 2 (row density).
 *
 * This file reads `src/styles.css` as TEXT and never imports it. The stylesheet
 * is imported only by `src/main.tsx`; vitest never transforms it, so a corrupted
 * minified line would not fail any other test. These assertions are the only
 * structural net for that file.
 *
 * The stylesheet is minified (line 2 is ~14.7k chars, line 464 ~13.4k).
 * `fs.readFileSync` has no 2,000-char truncation, which is why it is the only
 * safe way to read it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLOOR INVARIANT — DELIBERATELY NOT ASSERTED HERE.
 * Brief 02 sets a 12px minimum type size. Pass 2 adds ZERO sub-12px declarations
 * and does not enforce the floor, on purpose: ~159 font declarations sit below
 * 12px today, so asserting the floor now would need a ~159-entry allowlist — a
 * test that cannot fail. Pass 3 raises the floor (including the `<=850px`
 * shrinks) and owns that assertion, when its allowlist is small and meaningful.
 * A7 below is the *narrow* guard that is assertable today: rows may only be
 * tightened when their label is already >= 12px, i.e. density comes from
 * padding, never from shrinking type. The absence of the full floor is
 * intentional, not forgotten.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CSS_PATH = path.resolve('src/styles.css');

/**
 * Display surfaces: the headings whose ceiling is the global one. Pass 1
 * lowered the first five to 24px; Pass 2 drops the ceiling to 22px (one ceiling
 * for the whole product) and adds every surface the ratchet sweep touched.
 */
const DISPLAY_SELECTORS = new Set([
  // Pass 1 — the display ceiling
  '.document-scroll h1',
  '.empty-state h1',
  '.markdown h1',
  '.modal h2',
  '.document-kicker',
  // Pass 2 — the ratchet sweep (all land at or below 22px)
  '.wordmark',
  '.onboarding-content h1',
  '.funnel-head h2',
  '.onboarding-brand',
  '.agent-idle h3',
  '.explorer-heading h2',
  '.team-resume h3',
  '.profile-editor-heading h3',
  '.team-avatar.large',
  '.doc-list>header h2',
  '.settings-topbar h1',
]);

/** ONE ceiling: nothing in the product is bigger than the surface hero. */
const CEILING_PX = 22; // Pass 2 display ceiling
const RATCHET_PX = 22; // global hard ceiling — identical to the display ceiling

/** The Pass 3 queue, written down where it cannot be forgotten. May only go down. */
const ROW_PADDING_BUDGET: Record<string, number> = {
  '.sidebar button': 16, // Pass 2: 6 + 6 = 12px (row ~29px)
  '.tabs>button:not(.icon-button)': 20, // Pass 3 queue (vertical padding is 0 today; the bar height is the lever)
  '.doc-row': 18, // Pass 3 queue — blocked on its 10px / 9px meta text
  '.folder-row': 12, // already 6 + 0
};

/** Chrome metrics and their ceilings. Pass 2 lowers every one of them. */
interface ChromeBudgetEntry {
  selector: string;
  metric: string;
  ceiling: number;
}

const CHROME_BUDGET: ChromeBudgetEntry[] = [
  { selector: '.app-shell', metric: 'grid-template-rows:first', ceiling: 54 },
  { selector: '.app-shell', metric: 'grid-template-rows:last', ceiling: 30 },
  { selector: '.tabs', metric: 'height', ceiling: 42 },
  { selector: '.document-toolbar', metric: 'min-height', ceiling: 44 },
  { selector: '.wordmark', metric: 'height', ceiling: 56 },
  { selector: '.document-scroll', metric: 'padding-top', ceiling: 32 },
  { selector: '.sidebar-bottom', metric: 'padding-top', ceiling: 14 },
];

interface Rule {
  selectorText: string;
  body: string;
  mediaQuery: string | null;
}

/**
 * Remove `/* ... *\/` comments while preserving every newline, so line indices
 * still line up with the raw file. (No comment in this stylesheet contains a
 * brace, but stripping is still the honest thing to do before parsing.)
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
}

/**
 * Depth-counting tokenizer: one pass, a frame stack, `{` pushes and `}` pops.
 * A global regex over the raw text would mix base rules with media rules and
 * make the monotonicity checks (A3, A6) impossible.
 */
function tokenize(css: string): Rule[] {
  interface Frame {
    prelude: string;
    body: string;
    isAtRule: boolean;
    isMedia: boolean;
  }

  const rules: Rule[] = [];
  const stack: Frame[] = [{ prelude: '', body: '', isAtRule: true, isMedia: false }];
  let pending = '';

  const nearestMedia = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].isMedia) return stack[i].prelude;
    return null;
  };

  for (const ch of css) {
    if (ch === '{') {
      const prelude = pending.trim();
      pending = '';
      stack.push({
        prelude,
        body: '',
        isAtRule: prelude.startsWith('@'),
        isMedia: /^@media\b/.test(prelude),
      });
    } else if (ch === '}') {
      const frame = stack.pop();
      if (!frame) continue;
      const body = pending.trim();
      pending = '';
      if (!frame.isAtRule && frame.prelude) {
        rules.push({ selectorText: frame.prelude, body, mediaQuery: nearestMedia() });
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.body += `${frame.prelude}{${body}}`;
    } else {
      pending += ch;
    }
  }

  return rules;
}

function selectorTokens(selectorText: string): string[] {
  return selectorText
    .split(',')
    .map(token => token.trim())
    .filter(Boolean);
}

/**
 * Max `px` literal in a value. Taking the MAX handles `clamp(38px,3.5vw,57px)`
 * (-> 57), `46px/1.1` (-> 46) and `9px 'DM Sans'` (-> 9) uniformly.
 * Returns null for values with no px literal (`0`, `inherit`, `var(--x)`), which
 * is exactly how unresolved `--text-*` tokens will read in Pass 3.
 */
function maxPx(value: string): number | null {
  const v = value.trim();
  if (!v || v === '0' || /^(inherit|initial|unset|revert)$/.test(v)) return null;
  const matches = [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  if (matches.length === 0) return null;
  return Math.max(...matches);
}

/** `font-size` wins over the `font` shorthand when both are present. */
function declarationSize(body: string): number | null {
  let shorthand: number | null = null;
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (prop === 'font-size') {
      const size = maxPx(value);
      if (size !== null) return size;
    } else if (prop === 'font' && shorthand === null) {
      shorthand = maxPx(value);
    }
  }
  return shorthand;
}

/** First value for an exact property name, or null when the rule omits it. */
function declarationValue(body: string, property: string): string | null {
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim() !== property) continue;
    return decl.slice(colon + 1).trim();
  }
  return null;
}

/** A single length token as a number. `0` is 0; anything not `Npx` is null. */
function pxToken(token: string | undefined): number | null {
  if (token === undefined) return null;
  const v = token.trim();
  if (v === '0') return 0;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve `padding` shorthand + longhands to the vertical edges.
 * `padding:6px 10px` -> {top:6, bottom:6}; `padding:42px clamp(...) 30px` ->
 * {top:42, bottom:30}; `padding:0 15px` -> {top:0, bottom:0}. Longhands win.
 */
function paddingEdges(body: string): { top: number | null; bottom: number | null } {
  let top: number | null = null;
  let bottom: number | null = null;

  const shorthand = declarationValue(body, 'padding');
  if (shorthand !== null) {
    const parts = shorthand.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      top = pxToken(parts[0]);
      bottom = pxToken(parts.length >= 3 ? parts[2] : parts[0]);
    }
  }

  const topLonghand = declarationValue(body, 'padding-top');
  if (topLonghand !== null) top = pxToken(topLonghand);
  const bottomLonghand = declarationValue(body, 'padding-bottom');
  if (bottomLonghand !== null) bottom = pxToken(bottomLonghand);

  return { top, bottom };
}

/** Read one chrome metric out of a rule body. */
function chromeMetric(body: string, metric: string): number | null {
  if (metric === 'padding-top') return paddingEdges(body).top;
  if (metric === 'grid-template-rows:first' || metric === 'grid-template-rows:last') {
    const value = declarationValue(body, 'grid-template-rows');
    if (value === null) return null;
    const tracks = value.split(/\s+/).filter(Boolean);
    if (tracks.length === 0) return null;
    return pxToken(metric === 'grid-template-rows:first' ? tracks[0] : tracks[tracks.length - 1]);
  }
  return pxToken(declarationValue(body, metric) ?? undefined);
}

function describeRule(rule: Rule, size: number): string {
  return `${rule.selectorText} => ${size}px${rule.mediaQuery ? ` @ ${rule.mediaQuery}` : ''}`;
}

const raw = fs.readFileSync(CSS_PATH, 'utf8');
const stripped = stripComments(raw);
const rules = tokenize(stripped);

describe('typography contract (Pass 2)', () => {
  it('parses the stylesheet without losing it (smoke)', () => {
    expect(rules.length).toBeGreaterThan(300);
    expect(stripped).toContain('.document-scroll h1');
  });

  it(`A1 — no display surface exceeds the ${CEILING_PX}px ceiling (base and media)`, () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      if (!selectorTokens(rule.selectorText).some(token => DISPLAY_SELECTORS.has(token))) continue;
      const size = declarationSize(rule.body);
      if (size !== null && size > CEILING_PX) offenders.push(describeRule(rule, size));
    }
    expect(offenders).toEqual([]);
  });

  it(`A1 — ratchet: no font declaration anywhere exceeds ${RATCHET_PX}px`, () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      const size = declarationSize(rule.body);
      if (size !== null && size > RATCHET_PX) offenders.push(describeRule(rule, size));
    }
    expect(offenders).toEqual([]);
  });

  it('A2 — the stale .document-scroll h1{font-size:38px} override is gone', () => {
    expect(stripped.includes('.document-scroll h1{font-size:38px}')).toBe(false);
  });

  it('A2 — .document-scroll h1 never appears inside a @media block', () => {
    const offenders = rules
      .filter(rule => rule.mediaQuery !== null)
      .filter(rule => selectorTokens(rule.selectorText).includes('.document-scroll h1'))
      .map(rule => `${rule.mediaQuery} :: ${rule.selectorText}`);
    expect(offenders).toEqual([]);
  });

  it('A3 — no max-width override makes a heading larger than its base', () => {
    const base = new Map<string, number>();
    for (const rule of rules) {
      if (rule.mediaQuery !== null) continue;
      const size = declarationSize(rule.body);
      if (size === null) continue;
      for (const token of selectorTokens(rule.selectorText)) base.set(token, size);
    }

    // Group overrides per media block: a selector repeated inside one block
    // (`.statusbar` appears twice in max-width:850px) merges, last wins.
    const blocks = new Map<string, Map<string, number>>();
    for (const rule of rules) {
      if (rule.mediaQuery === null) continue;
      if (!/\(max-width:\s*\d+(?:\.\d+)?px\)/.test(rule.mediaQuery)) continue;
      const size = declarationSize(rule.body);
      if (size === null) continue;
      const block = blocks.get(rule.mediaQuery) ?? new Map<string, number>();
      for (const token of selectorTokens(rule.selectorText)) block.set(token, size);
      blocks.set(rule.mediaQuery, block);
    }

    const violations: string[] = [];
    for (const [query, overrides] of blocks) {
      for (const [token, px] of overrides) {
        const basePx = base.get(token);
        if (basePx !== undefined && px > basePx) violations.push(`${query} ${token}: ${px}px > base ${basePx}px`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('A4 — braces are balanced (line 2 and whole file)', () => {
    const count = (text: string, ch: string): number => text.split(ch).length - 1;
    const line2 = stripped.split('\n')[1] ?? '';
    expect(count(line2, '{')).toBe(count(line2, '}'));
    expect(count(stripped, '{')).toBe(count(stripped, '}'));
  });

  it('A5 — row padding never exceeds its declared budget (base rules only)', () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      if (rule.mediaQuery !== null) continue;
      for (const token of selectorTokens(rule.selectorText)) {
        const budget = ROW_PADDING_BUDGET[token];
        if (budget === undefined) continue;
        const { top, bottom } = paddingEdges(rule.body);
        const total = (top ?? 0) + (bottom ?? 0);
        if (total > budget) offenders.push(`${token} => ${total}px > budget ${budget}px`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('A6 — chrome budget and chrome monotonicity', () => {
    const key = (selector: string, metric: string): string => `${selector}|${metric}`;

    // Part 1 — monotonicity inside `max-width` blocks (same rule as A3/D5):
    // no narrower block may declare a value LARGER than its base. This is the
    // net for the coupled base/override pairs.
    const base = new Map<string, number>();
    for (const rule of rules) {
      if (rule.mediaQuery !== null) continue;
      for (const entry of CHROME_BUDGET) {
        if (!selectorTokens(rule.selectorText).includes(entry.selector)) continue;
        const value = chromeMetric(rule.body, entry.metric);
        if (value !== null) base.set(key(entry.selector, entry.metric), value);
      }
    }

    interface Override {
      selector: string;
      metric: string;
      px: number;
    }

    const blocks = new Map<string, Map<string, Override>>();
    for (const rule of rules) {
      if (rule.mediaQuery === null) continue;
      if (!/\(max-width:\s*\d+(?:\.\d+)?px\)/.test(rule.mediaQuery)) continue;
      for (const entry of CHROME_BUDGET) {
        if (!selectorTokens(rule.selectorText).includes(entry.selector)) continue;
        const value = chromeMetric(rule.body, entry.metric);
        if (value === null) continue;
        const block = blocks.get(rule.mediaQuery) ?? new Map<string, Override>();
        block.set(key(entry.selector, entry.metric), { selector: entry.selector, metric: entry.metric, px: value });
        blocks.set(rule.mediaQuery, block);
      }
    }

    const regressions: string[] = [];
    for (const [query, overrides] of blocks) {
      for (const [k, override] of overrides) {
        const basePx = base.get(k);
        if (basePx !== undefined && override.px > basePx) {
          regressions.push(`${query} ${override.selector} ${override.metric}: ${override.px}px > base ${basePx}px`);
        }
      }
    }
    expect(regressions).toEqual([]);

    // Part 2 — ceiling across ALL blocks, including `min-width`. Part 1 ignores
    // wider breakpoints by design, so this is what catches a `min-width:1600px`
    // override that never came down with its base.
    const over: string[] = [];
    for (const rule of rules) {
      for (const entry of CHROME_BUDGET) {
        if (!selectorTokens(rule.selectorText).includes(entry.selector)) continue;
        const value = chromeMetric(rule.body, entry.metric);
        if (value === null) continue;
        if (value > entry.ceiling) {
          const where = rule.mediaQuery ? ` @ ${rule.mediaQuery}` : '';
          over.push(`${entry.selector} ${entry.metric} = ${value}px > ${entry.ceiling}px${where}`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('A7 — row labels stay at or above the 12px floor (base rules only)', () => {
    // Base rules only, on purpose: the `@media(max-width:850px)`
    // `.sidebar button{font-size:11px}` shrink is Pass 3's allowlist item, and
    // this guard exists to prove density comes from padding, never from type.
    const offenders: string[] = [];
    for (const rule of rules) {
      if (rule.mediaQuery !== null) continue;
      if (!selectorTokens(rule.selectorText).some(token => token in ROW_PADDING_BUDGET)) continue;
      const size = declarationSize(rule.body);
      if (size !== null && size < 12) offenders.push(describeRule(rule, size));
    }
    expect(offenders).toEqual([]);
  });
});
