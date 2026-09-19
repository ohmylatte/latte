import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { ActiveTeamsStrip } from './ActiveTeamsStrip';
import type { CoordinationActiveRunSummary } from '../shared/contracts';

/**
 * The active-teams strip (autonomous-coordination Phase 7 task 7.8): a
 * sidebar strip under the brand `<select>` in `src/App.tsx`, fed by
 * `listActiveCoordinationRuns()`. One row per active run. It OBSERVES and
 * NAVIGATES only — approval always happens inside the Work whose money and
 * team it commits (`AGENTS.md`'s propose/approve/execute/verify separation).
 * Empty list ⇒ renders nothing, same honesty rule as HomeView's card.
 */

const run = (patch: Partial<CoordinationActiveRunSummary> = {}): CoordinationActiveRunSummary => ({
  runId: 'run1', workId: 'w1', workTitle: 'Lanzamiento', brandId: 'b1', brandName: 'Casa Oliva',
  status: 'running', dispatchesUsed: 3, maxDispatches: 10, pendingGates: 0, budgetInvalid: false, updatedAt: '2026-09-02T00:00:00.000Z', lastSeenAt: null, ...patch,
});

const mount = (runs: readonly CoordinationActiveRunSummary[], onOpen = vi.fn()) =>
  ({ onOpen, ...render(<I18nProvider><ActiveTeamsStrip runs={runs} onOpen={onOpen} /></I18nProvider>) });

describe('the active-teams strip (task 7.8)', () => {
  it('renders nothing for an empty list — never a zero, same as HomeView', () => {
    const { container } = mount([]);
    expect(container.querySelector('.active-teams-strip')).toBeNull();
  });

  it('renders one row per active run: brand, work, status, dispatches used/cap and pending gates', () => {
    const { container } = mount([run({ workTitle: 'Lanzamiento', brandName: 'Casa Oliva', dispatchesUsed: 3, maxDispatches: 10, pendingGates: 2 })]);
    const row = container.querySelector('.active-teams-strip-row');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Casa Oliva');
    expect(row!.textContent).toContain('Lanzamiento');
    expect(row!.textContent).toContain('3');
    expect(row!.textContent).toContain('10');
    expect(row!.textContent).toContain('2');
  });

  it('an unlimited run shows an honest infinity mark, never a fabricated cap', () => {
    const { container } = mount([run({ maxDispatches: null, dispatchesUsed: 4 })]);
    expect(container.querySelector('.active-teams-strip-row')!.textContent).toContain('∞');
  });

  it('a run with no pending gates shows no gate count at all', () => {
    const { container } = mount([run({ pendingGates: 0 })]);
    expect(container.querySelector('.active-teams-strip-gates')).toBeNull();
  });

  it('clicking a row selects that Brand + Work and navigates to decisions — it never approves or rejects anything itself', () => {
    const onOpen = vi.fn();
    const oneRun = run({ runId: 'run-xyz' });
    const { container } = mount([oneRun], onOpen);
    fireEvent.click(container.querySelector('.active-teams-strip-row')!);
    expect(onOpen).toHaveBeenCalledWith(oneRun);
  });

  it('renders NO approve/reject control anywhere in the strip — it observes and navigates only', () => {
    const { container } = mount([run({ pendingGates: 3 })]);
    const strip = container.querySelector('.active-teams-strip')!;
    expect(strip.textContent).not.toContain('Aprobar');
    expect(strip.textContent).not.toContain('Rechazar');
    // Exactly one interactive control per row: the row itself.
    expect(strip.querySelectorAll('button').length).toBe(1);
  });

  it('renders several runs, each independently clickable', () => {
    const onOpen = vi.fn();
    const runA = run({ runId: 'run-a', workId: 'wa', workTitle: 'A' });
    const runB = run({ runId: 'run-b', workId: 'wb', workTitle: 'B' });
    const { container } = mount([runA, runB], onOpen);
    const rows = container.querySelectorAll('.active-teams-strip-row');
    expect(rows.length).toBe(2);
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(runB);
  });
});
