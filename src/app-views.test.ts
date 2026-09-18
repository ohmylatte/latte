import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The source-level half of the Contexto guard.
 *
 * `ContextView.dom.test.tsx` proves the view renders; this proves the list of
 * views and the branches that render them cannot drift apart, and that the
 * assets the shipped regression orphaned are referenced again. It reads the
 * files instead of importing them, because importing `App` pulls in the
 * terminal and the browser API, which a Node test has no business booting.
 *
 * The branch guard is deliberately narrow. A bare `toContain("view === 'context'")`
 * is satisfied by the nav button's className, so renaming only the render branch
 * left it green: a guard that cannot fail is worse than no guard. It now asserts
 * a `view === '<v>' … && <` pattern INSIDE `<main>`, which is where a render
 * branch lives and where the sidebar nav does not.
 */

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const app = read('./App.tsx');
const contextView = read('./ContextView.tsx');

const listed = [...app.matchAll(/^export const VIEWS = \[([^\]]+)\] as const;$/gm)]
  .flatMap((match) => match[1].split(','))
  .map((part) => part.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

const mainStart = app.indexOf('<main className="workspace"');
const mainEnd = app.indexOf('</main>', mainStart);
const main = mainStart >= 0 && mainEnd > mainStart ? app.slice(mainStart, mainEnd) : '';

describe('workspace views', () => {
  it('enumerates every workspace view in one list', () => {
    // `home` is first on purpose: it is the landing of a returning user, and the
    // list order is what the render-branch guard below walks.
    expect(listed).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'decisions', 'resultados']);
  });

  it('renders a branch for each of them inside <main>', () => {
    expect(main, '<main> not found in App.tsx').not.toBe('');
    for (const view of listed) {
      expect(main, `${view} has no render branch`).toMatch(new RegExp(`view === '${view}'[^\\n]*&&\\s*<`));
    }
  });

  it('keeps the dead duplicate diff out of App', () => {
    expect(app).not.toContain('function diffLines');
    expect(app).not.toContain('function proposedContext');
  });
});

/**
 * `useCoordination` wiring (autonomous-coordination Phase 7 task 7.11):
 * source-level, for the same reason `app-views.test.ts` itself is
 * source-level — importing `App` pulls in the terminal and the browser API,
 * which a Node test has no business booting. The task's own explicit ask:
 * "failing test asserting no new VIEWS entry" — this hook wires FOUR
 * pre-existing views plus the strip and the notice, it adds no view of its
 * own.
 */
describe('useCoordination wiring adds no new VIEWS entry (task 7.11)', () => {
  it('the workspace view list is unchanged by the coordination wiring', () => {
    // Byte-for-byte the same list `app-views.test.ts` already pins above —
    // repeated here as its own assertion so a future edit that adds a
    // coordination-only view fails THIS test with a name that says why.
    expect(listed).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'decisions', 'resultados']);
  });

  it('calls the hook exactly once, unconditionally, scoped to the open Work', () => {
    expect(app).toContain('useCoordination(work?.id ?? null,');
    expect(app.match(/useCoordination\(/g) ?? []).toHaveLength(1);
  });

  it('renders the active-teams strip and the memory notice', () => {
    expect(app).toContain('<ActiveTeamsStrip');
    expect(app).toContain('<MemoryNotice');
  });

  it('wires the coordination gates and the settle action into the real IPC verbs, not a reinvention', () => {
    expect(app).toMatch(/DecisionsView[\s\S]{0,2000}gates=\{work \? coordination\.gates/);
    expect(app).toMatch(/DecisionsView[\s\S]{0,2000}onResolveGate=\{coordination\.resolveGate\}/);
    expect(app).toMatch(/ResumenView[\s\S]{0,2000}onSettleDispatch=\{coordination\.settleDispatch\}/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}coordinationRun=\{work \? coordination\.run/);
    expect(app).toMatch(/TeamPanel[\s\S]{0,4000}onPauseCoordination=\{coordination\.pauseRun\}/);
  });
});

describe('orphaned context assets', () => {
  it('uses the context.* keys the restored view was meant to show', () => {
    for (const key of ['context.ask', 'context.ask.needWork', 'context.proposal', 'context.accept', 'context.editAccept', 'context.reject', 'context.diff', 'context.mode.replace', 'context.mode.append', 'context.changedSince', 'context.acceptStale']) {
      expect(contextView, `${key} is orphaned`).toContain(`'${key}'`);
    }
    expect(app, 'context.staleDraft is orphaned').toContain("'context.staleDraft'");
  });

  it('renders the line diff with the shipped .context-diff styles', () => {
    expect(contextView).toContain('context-diff-line context-diff-');
  });
});
