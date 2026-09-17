import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Typography contract — `densidad-tipografica` Pass 3a (the type floor).
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
 * FLOOR INVARIANT — NOW ASSERTED (Pass 3a, "the type floor").
 * Brief 02 sets a 12px minimum type size. Pass 2 deliberately did NOT assert it:
 * ~159 sub-12px declarations would have needed a ~159-entry allowlist — a test
 * that cannot fail. Pass 3a raises the floor on the shell, the document chrome
 * and the daily lists, and the assertion becomes honest in two pieces:
 *
 *   A8 — the SCOPED floor. Every Pass 3a surface resolves to >= 12px in EVERY
 *        block (base + media), except a 4-entry allowlist capped at 11px. Global
 *        in-blocks, which is what makes the `@media(max-width:*)` shrinks
 *        visible — A7 is base-only on purpose.
 *   A9 — the DEBT RATCHET. The *total* sub-12px declaration count must stay at
 *        or below SUB12_DEBT and may only go down. 144 remain: the agent / chat /
 *        context internals, the secondary panels and the gate are Pass 3b/3c.
 *        This is what turns the remaining debt into a number in a test instead
 *        of a note in a proposal — and it fails on any NEW sub-12px declaration,
 *        anywhere in the file.
 *
 * A7 stays as the narrow row guard: rows may only be tightened when their label
 * is already >= 12px, i.e. density comes from padding, never from shrinking type.
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

/**
 * The Pass 3 queue, written down where it cannot be forgotten. May only go down.
 * `.doc-row` lands at 12 in Pass 3a, PAIRED with the floor raise on its meta:
 * `padding:9px 10px -> 6px 10px` while `.doc-row small` goes 10 -> 12 and
 * `.doc-row em` goes 9 -> 12. That pairing is the condition of the whole pass —
 * unpaired, the raise makes the doc list LESS dense than before.
 */
const ROW_PADDING_BUDGET: Record<string, number> = {
  '.sidebar button': 16, // Pass 2: 6 + 6 = 12px (row ~29px)
  '.tabs>button:not(.icon-button)': 20, // Pass 3 queue (vertical padding is 0 today; the bar height is the lever)
  '.doc-row': 12, // Pass 3a: 6 + 6, paired with the 12px meta
  '.folder-row': 12, // already 6 + 0
};

/**
 * Pass 3a surfaces — every selector the floor raise touched, plus the 4-entry
 * micro allowlist. A8 asserts these resolve to >= 12px in EVERY block, so the
 * `@media(max-width:*)` shrinks (`.alpha` 7px @850, `.statusbar` 8px @850,
 * `.sidebar button` 11px @850, `.breadcrumb` 11px @1100) are all visible.
 */
const FLOOR_SELECTORS = new Set([
  // the shell
  '.sidebar button',
  '.breadcrumb',
  '.sidebar-add',
  '.nav-label',
  '.profile small',
  '.local-badge',
  '.tabs button span',
  '.statusbar',
  // document chrome
  '.document-toolbar>span',
  '.document-toolbar small',
  '.document-toolbar button',
  '.document-kicker',
  '.document-footer',
  '.document-actions button',
  '.modal .document-kicker',
  // the doc list and the folders — the daily driver
  '.doc-kind',
  '.doc-add',
  '.doc-folder',
  '.doc-folder code',
  '.doc-folder button',
  '.doc-list>header h2 small',
  '.doc-list>header button',
  '.doc-list-filters select',
  '.doc-list-review',
  '.doc-list-review small',
  '.doc-row small',
  '.doc-row em',
  '.doc-list-footer',
  '.doc-list-footer code',
  '.doc-list-footer button:not(.icon-button)',
  '.folder-row>span',
  '.folder-row em',
  '.folder-row button',
  '.folder-contents>header small',
  '.folder-contents .footnote',
  '.folder-group h4',
  // badges that carry meaning ("Principal", counts) — NOT exempt
  '.tag',
  '.agent-mode-tabs .tag.count',
  // the 17px lede both earlier passes skipped (it passed the 22px ratchet)
  '.markdown>p:first-of-type',
  // the micro allowlist — see MICRO_ALLOWLIST
  '.alpha',
  '.status-version',
  '.onboarding-brand .alpha',
  '.team-tab .team-avatar',
]);

/**
 * The ONLY sub-12px type Pass 3a leaves behind, at 11px and NEVER 9px, each with
 * a one-line reason. Brief 02 L260 puts the secondary minimum at 12px, so this is
 * a declared deviation, not a default. Capped at 4 entries so the list cannot
 * silently grow into the tautology Pass 2's FLOOR-INVARIANT note warned about.
 */
const MICRO_ALLOWLIST: Record<string, number> = {
  '.alpha': 11, // "ALPHA" badge; the 20px wordmark sits immediately next to it
  '.onboarding-brand .alpha': 11, // the same badge on the gate, next to an 18px wordmark
  '.status-version': 11, // "0.5.4 · ALPHA" build stamp in the status bar
  '.team-tab .team-avatar': 11, // single-glyph avatar; the full name is adjacent at 12px
};

/**
 * Sub-12px debt history. Every entry must be <= the one before it; the ratchet is
 * the last one. Append-only, downwards — nobody raises it.
 *   184 — measured at HEAD 3a8c19a (Pass 2 shipped 184 sub-12px declarations)
 *   144 — measured after Pass 3a: 34 raised to 12px + 4 `max-width` shrinks
 *         deleted + 2 meaningful badges raised = 40 removals.
 */
const SUB12_DEBT_HISTORY = [184, 144];
const SUB12_DEBT = SUB12_DEBT_HISTORY[SUB12_DEBT_HISTORY.length - 1];

/**
 * The 8-step ladder, declared once in `:root`. Range 12 -> 22px (1.83x): Pass 1
 * lowered the ceiling to 22px, Pass 2 tightened the spacing, Pass 3a raises the
 * floor to 12px. `--text-xs` is the declared-allowlist tier and may only be used
 * by the selectors in MICRO_ALLOWLIST — A10 enforces that.
 */
const TEXT_LADDER: Record<string, number> = {
  '--text-xs': 11,
  '--text-sm': 12,
  '--text-base': 13,
  '--text-md': 14,
  '--text-lg': 16,
  '--text-xl': 18,
  '--text-2xl': 20,
  '--text-3xl': 22,
};

/**
 * Line-height ceiling for text BELOW the floor. The `< 12px` condition is
 * deliberate: it exempts the 13px prose (`.markdown p,li` 13/1.8 and `.intro`
 * 13/1.8), where 1.8 is a genuine reading-comfort choice, and the 12px 1.7-1.8
 * cluster. Lowering a line-height only shrinks line boxes — zero floor risk.
 */
const LINE_HEIGHT_MAX = 1.65;

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
 * The `--text-*` ladder read out of `:root`, so `maxPx` can resolve
 * `var(--text-sm)` to 12. Resolving (rather than treating a token as "no size")
 * is what keeps the debt ratchet honest: a `var(--text-xs)` declaration must
 * still count as sub-12px debt, and a `var(--text-sm)` one must still satisfy
 * the floor. Lazy so it can read the module-level `rules` without a cycle.
 */
let textLadder: Map<string, number> | null = null;
function textTokens(): Map<string, number> {
  if (textLadder !== null) return textLadder;
  const map = new Map<string, number>();
  for (const rule of rules) {
    if (!selectorTokens(rule.selectorText).includes(':root')) continue;
    for (const decl of rule.body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim();
      if (!prop.startsWith('--text-')) continue;
      const m = /^(\d+(?:\.\d+)?)px$/.exec(decl.slice(colon + 1).trim());
      if (m) map.set(prop, Number(m[1]));
    }
  }
  textLadder = map;
  return map;
}

/** Substitute every declared `--text-*` token for its px value. */
function resolveTokens(value: string): string {
  const ladder = textTokens();
  return value.replace(
    /var\((--text-[a-z0-9-]+)\)/g,
    (whole, name: string) => (ladder.has(name) ? `${ladder.get(name)}px` : whole),
  );
}

/**
 * Max `px` literal in a value, after resolving the `--text-*` ladder. Taking the
 * MAX handles `clamp(38px,3.5vw,57px)` (-> 57), `46px/1.1` (-> 46) and
 * `9px 'DM Sans'` (-> 9) uniformly; `var(--text-sm)` resolves to 12 first.
 * Returns null for values with no px literal (`0`, `inherit`) — an undeclared
 * token resolves to itself and therefore reads as null, which A10 fails on.
 */
function maxPx(value: string): number | null {
  const v = resolveTokens(value.trim());
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

/** How many declarations in the stylesheet sit below the 12px floor. The debt. */
function countSub12(stylesheet: string): number {
  return tokenize(stripComments(stylesheet)).filter(rule => {
    const size = declarationSize(rule.body);
    return size !== null && size < 12;
  }).length;
}

/**
 * Unitless line-height from `line-height`, else from the `font` shorthand
 * (`font:11px/1.8 Consolas`). `line-height` wins when both are present, matching
 * `declarationSize`. Returns null for `normal`, `px`/`em` values and absent ones.
 */
function declarationLineHeight(body: string): number | null {
  let longhand: number | null = null;
  let shorthand: number | null = null;
  for (const decl of body.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (prop === 'line-height' && longhand === null) {
      const m = /^(\d+(?:\.\d+)?)$/.exec(value);
      if (m) longhand = Number(m[1]);
    } else if (prop === 'font' && shorthand === null) {
      const m = /\/\s*(\d+(?:\.\d+)?)/.exec(value);
      if (m) shorthand = Number(m[1]);
    }
  }
  return longhand ?? shorthand;
}

const raw = fs.readFileSync(CSS_PATH, 'utf8');
const stripped = stripComments(raw);
const rules = tokenize(stripped);

describe('typography contract (Pass 3a — the type floor)', () => {
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
    // Base rules only, on purpose: this is the narrow guard that proves density
    // comes from padding, never from shrinking type. Pass 3a deleted the
    // `@media(max-width:850px)` `.sidebar button{font-size:11px}` shrink, so the
    // row labels are now 13/12px in every block; the global, all-blocks version
    // of this check is A8 below.
    const offenders: string[] = [];
    for (const rule of rules) {
      if (rule.mediaQuery !== null) continue;
      if (!selectorTokens(rule.selectorText).some(token => token in ROW_PADDING_BUDGET)) continue;
      const size = declarationSize(rule.body);
      if (size !== null && size < 12) offenders.push(describeRule(rule, size));
    }
    expect(offenders).toEqual([]);
  });

  it('A8 — every Pass 3a surface clears the floor in every block (base and media)', () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      for (const token of selectorTokens(rule.selectorText)) {
        if (!FLOOR_SELECTORS.has(token)) continue;
        const size = declarationSize(rule.body);
        if (size === null) continue;
        const floor = MICRO_ALLOWLIST[token] ?? 12;
        if (size < floor) {
          offenders.push(`${token} => ${size}px < ${floor}px${rule.mediaQuery ? ` @ ${rule.mediaQuery}` : ''}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('A8 — the micro allowlist is capped at 4 entries and never drops below 11px', () => {
    // Brief 02 L260 puts the secondary minimum at 12px, so 11px is a declared
    // deviation with a per-selector reason — not a default. The cap is what stops
    // the list from growing back into the tautology this file used to warn about.
    const entries = Object.entries(MICRO_ALLOWLIST);
    expect(entries.length).toBeLessThanOrEqual(4);
    expect(entries.filter(([, px]) => px < 11).map(([selector, px]) => `${selector} => ${px}px`)).toEqual([]);
  });

  it(`A9 — sub-12px declarations stay at or below the debt ratchet (${SUB12_DEBT})`, () => {
    // Monotonic by construction: the history may only go down, and the ratchet is
    // its last entry. Measured 184 at HEAD (Pass 2 shipped 184); 144 after Pass 3a.
    const nonIncreasing = SUB12_DEBT_HISTORY.every((value, i) => i === 0 || value <= SUB12_DEBT_HISTORY[i - 1]);
    expect(nonIncreasing).toBe(true);
    expect(SUB12_DEBT).toBeLessThan(SUB12_DEBT_HISTORY[0]);

    // The real net. Fails on today's 184; fails on any NEW sub-12px declaration
    // anywhere in the file; Pass 3b/3c may only lower it.
    expect(countSub12(stripped)).toBeLessThanOrEqual(SUB12_DEBT);
  });

  it('A10 — the --text-* ladder is declared, monotonic, and actually used', () => {
    const ladder = textTokens();

    const wrong = Object.entries(TEXT_LADDER)
      .filter(([name, px]) => ladder.get(name) !== px)
      .map(([name, px]) => `${name}: ${ladder.get(name) ?? 'undeclared'} (expected ${px}px)`);
    expect(wrong).toEqual([]);

    const names = Object.keys(TEXT_LADDER);
    const notIncreasing = names.filter(
      (name, i) => i > 0 && !((ladder.get(name) ?? 0) > (ladder.get(names[i - 1]) ?? 0)),
    );
    expect(notIncreasing).toEqual([]);

    // `--text-xs` is the declared-allowlist tier: 11px, never 9px.
    expect(ladder.get('--text-xs')).toBeGreaterThanOrEqual(11);
    expect(ladder.get('--text-xs')).toBeLessThan(12);

    // Every reference must name a declared token — a typo would silently make the
    // whole declaration invalid at computed-value time.
    const references = [...stripped.matchAll(/var\((--text-[a-z0-9-]+)\)/g)].map(m => m[1]);
    expect([...new Set(references)].filter(name => !ladder.has(name))).toEqual([]);
    expect(references).toContain('--text-sm');

    // ...and `--text-xs` may only appear on the allowlisted selectors.
    const misused = rules
      .filter(rule => rule.body.includes('var(--text-xs)'))
      .flatMap(rule => selectorTokens(rule.selectorText))
      .filter(token => !(token in MICRO_ALLOWLIST));
    expect(misused).toEqual([]);
  });

  it(`A11 — no line-height above ${LINE_HEIGHT_MAX} on text below the floor`, () => {
    // Parses BOTH `line-height` and the `font` shorthand (`11px/1.8`). The
    // `< 12px` scope is what exempts the deliberate 13px/1.8 prose.
    const offenders: string[] = [];
    for (const rule of rules) {
      const size = declarationSize(rule.body);
      if (size === null || size >= 12) continue;
      const lineHeight = declarationLineHeight(rule.body);
      if (lineHeight !== null && lineHeight > LINE_HEIGHT_MAX) {
        offenders.push(
          `${rule.selectorText} => ${size}px / ${lineHeight}${rule.mediaQuery ? ` @ ${rule.mediaQuery}` : ''}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
