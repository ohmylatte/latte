import { translate as t } from './i18n';
import type { CoordinationActiveRunSummary } from '../shared/contracts';

/**
 * The active-teams strip (autonomous-coordination Phase 7 task 7.8): a
 * global, sidebar strip under the brand `<select>` in `src/App.tsx`, fed by
 * `listActiveCoordinationRuns()` — the only app-scoped read in the whole
 * change. One row per active run, across every Brand.
 *
 * It OBSERVES and NAVIGATES only: clicking a row selects that Brand + Work
 * and opens Decisiones, where the real approve/reject controls live. It
 * renders no approve/reject control of its own — that is what keeps
 * propose/approve/execute/verify visually and logically separate, as
 * `AGENTS.md` requires: approval always happens inside the Work whose money
 * and team it commits, never from a global list.
 *
 * Empty list ⇒ renders nothing, the same honesty rule `HomeView`'s
 * since-last-visit card uses: zero rows is never a zero.
 */
export interface ActiveTeamsStripProps {
  runs: readonly CoordinationActiveRunSummary[];
  onOpen: (run: CoordinationActiveRunSummary) => void;
}

export function ActiveTeamsStrip({ runs, onOpen }: ActiveTeamsStripProps) {
  if (runs.length === 0) return null;
  return <nav className="active-teams-strip" aria-label={t('coordination.teams.kicker')}>
    <div className="document-kicker">{t('coordination.teams.kicker')}</div>
    <ul>
      {runs.map((run) => <li key={run.runId}>
        <button type="button" className="active-teams-strip-row" data-status={run.status} onClick={() => onOpen(run)}>
          <span className="active-teams-strip-brand">{run.brandName}</span>
          <span className="active-teams-strip-work">{run.workTitle}</span>
          <span className="active-teams-strip-status">{t(`coordination.teams.status.${run.status}` as 'coordination.teams.status.running')}</span>
          {/* Un presupuesto que no se pudo leer NO se dibuja como "∞": eso
              sería exactamente la mentira que el `null` de esta fila produce. */}
          <span className="active-teams-strip-budget">
            {run.budgetInvalid ? t('coordination.teams.budgetInvalid') : `${run.dispatchesUsed} / ${run.maxDispatches ?? '∞'}`}
          </span>
          {run.pendingGates > 0 && <span className="active-teams-strip-gates">{t('coordination.teams.gatesWaiting', { count: run.pendingGates })}</span>}
        </button>
      </li>)}
    </ul>
  </nav>;
}
