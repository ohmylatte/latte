import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Typography contract — `densidad-tipografica` Pass 1.
 *
 * This file reads `src/styles.css` as TEXT and never imports it. The stylesheet
 * is imported only by `src/main.tsx`; vitest never transforms it, so a corrupted
 * minified line would not fail any other test. These assertions are the only
 * structural net for that file.
 *
 * The stylesheet is minified (line 2 is ~14.7k chars). `fs.readFileSync` has no
 * 2,000-char truncation, which is why it is the only safe way to read it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLOOR INVARIANT — DELIBERATELY NOT ASSERTED HERE.
 * Brief 02 sets a 12px minimum type size. Pass 1 does NOT enforce it, on
 * purpose: 159 of 265 font declarations sit below 12px today, so asserting the
 * floor now would need a ~159-entry allowlist — a test that cannot fail. Pass 3
 * raises the floor and owns that assertion, when its allowlist is small and
 * meaningful. Its absence here is intentional, not forgotten.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CSS_PATH = path.resolve('src/styles.css');

/** Pass 1 display surfaces: the headings whose ceiling dropped to 24px. */
const PASS_1_SELECTORS = new Set([
  '.document-scroll h1',
  '.empty-state h1',
  '.markdown h1',
  '.modal h2',
  '.document-kicker',
]);

const CEILING_PX = 24; // Pass 1 display ceiling
const RATCHET_PX = 34; // global hard ceiling; Pass 2 tightens it to 20

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
 * make the monotonicity check (A3) impossible.
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

function describeRule(rule: Rule, size: number): string {
  return `${rule.selectorText} => ${size}px${rule.mediaQuery ? ` @ ${rule.mediaQuery}` : ''}`;
}

const raw = fs.readFileSync(CSS_PATH, 'utf8');
const stripped = stripComments(raw);
const rules = tokenize(stripped);

describe('typography contract (Pass 1)', () => {
  it('parses the stylesheet without losing it (smoke)', () => {
    expect(rules.length).toBeGreaterThan(300);
    expect(stripped).toContain('.document-scroll h1');
  });

  it('A1 — no Pass 1 display surface exceeds the 24px ceiling (base and media)', () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      if (!selectorTokens(rule.selectorText).some(token => PASS_1_SELECTORS.has(token))) continue;
      const size = declarationSize(rule.body);
      if (size !== null && size > CEILING_PX) offenders.push(describeRule(rule, size));
    }
    expect(offenders).toEqual([]);
  });

  it('A1 — ratchet: no font declaration anywhere exceeds 34px', () => {
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

  // A5 — the floor invariant is documented at the top of this file on purpose:
  // Pass 3 owns it, and asserting it here today would be a test that cannot fail.
});
