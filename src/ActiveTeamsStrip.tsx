import { translate as t } from './i18n';
import type { CoordinationActiveRunSummary } from '../shared/contracts';

/**
 * The active-teams strip (autonomous-coordination Phase 7 task 7.8): a
 * global, sidebar strip under the brand `<select>` in `src/App.tsx`, fed by
 * `listActiveCoordinationRuns()` — the only app-scoped read in the whole
 * change. One row per active run, across every Brand.
 *
 * It OBSERVES and NAVIGATES only: clicking a row selects that Brand + Work
 * and opens the Work's team, where the real approve/reject controls live. It
 * renders no approve/reject control of its own — that is what keeps
 * propose/approve/execute/verify visually and logically separate, as
 * `AGENTS.md` requires: approval always happens inside the Work whose money
 * and team it commits, never from a global list.
 *
 * H2: Y NO CRECE HASTA EL INFINITO.
 *
 * Pintaba cada equipo en CUATRO renglones —marca, trabajo, estado, conteo—,
 * sin tope y con los runs ya cerrados adentro: con tres o cuatro equipos, la
 * tira empujaba "Inicio" fuera de la pantalla. Es una BARRA LATERAL, no una
 * pantalla: su trabajo es decir qué hay vivo y llevar ahí, no contarlo todo.
 *
 * Tres reglas, las mismas de la superficie de equipo:
 *
 *  1. UNA fila por equipo, con la anatomía de fila: el estado como señal (un
 *     punto, un solo acento), el trabajo en una línea, la marca como segunda,
 *     y el conteo en mono a la derecha. Dos líneas por fila, nunca más;
 *  2. sólo lo VIVO. `done` y `cancelled` no son equipos activos: su lugar es
 *     Inicio, que es la pantalla donde se cuenta lo que pasó;
 *  3. tope de tres, y una línea "y N más" que lleva a Inicio.
 *
 * Empty list ⇒ renders nothing, the same honesty rule `HomeView`'s
 * since-last-visit card uses: zero rows is never a zero.
 */

/** Cuántas filas entran antes de que la tira empiece a comerse la navegación. */
const MAX_ROWS = 3;

/**
 * VIVO ES LO QUE EL MOTOR LLAMA ACTIVO: `planning`, `running`, `suspended` —
 * el mismo trío que `idx_coordination_run_active` deja tener uno por Trabajo.
 *
 * El filtro vive ACÁ y no en el backend porque el contrato IPC no es sólo de
 * la tira: desde D18, `listActiveCoordinationRuns` (el del servicio, no el del
 * repositorio) agrega el último run TERMINADO de cada Trabajo mientras la
 * persona no haya pasado por ahí, y de eso vive la tarjeta "desde tu última
 * visita" de Inicio. Sacarlos de la fuente le apagaría a Inicio lo único que
 * tiene para contar; sacarlos de la tira es decisión de ESTA superficie.
 */
const isLive = (run: CoordinationActiveRunSummary) =>
  run.status === 'planning' || run.status === 'running' || run.status === 'suspended';

export interface ActiveTeamsStripProps {
  runs: readonly CoordinationActiveRunSummary[];
  onOpen: (run: CoordinationActiveRunSummary) => void;
  /** "y N más" lleva a Inicio, que es donde están TODOS los equipos, vivos y cerrados. */
  onOpenHome: () => void;
}

export function ActiveTeamsStrip({ runs, onOpen, onOpenHome }: ActiveTeamsStripProps) {
  const live = runs.filter(isLive);
  if (live.length === 0) return null;
  const shown = live.slice(0, MAX_ROWS);
  const rest = live.length - shown.length;
  return <nav className="active-teams-strip" aria-label={t('coordination.teams.kicker')}>
    <div className="document-kicker">{t('coordination.teams.kicker')}</div>
    <ul>
      {shown.map((run) => {
        /**
         * UN SOLO ACENTO, Y GANA LO QUE TE NECESITA. Un equipo con una
         * aprobación esperando pide algo de la persona; uno en curso sólo
         * está vivo; uno suspendido no está haciendo nada ahora mismo y se
         * lee en gris. Tres tonos, ningún texto de estado ocupando renglón.
         */
        // O2: un equipo quieto porque su coordinador está en pausa también te
        // necesita: nada se mueve hasta que lo reanudes.
        const coordinatorPaused = run.status === 'suspended' && run.suspendReason === 'coordinator_paused';
        const tone = run.pendingGates > 0 || coordinatorPaused ? 'needs' : run.status === 'suspended' ? 'idle' : 'live';
        return <li key={run.runId}>
          <button type="button" className="active-teams-strip-row" data-status={run.status} data-live="true" title={run.workTitle} onClick={() => onOpen(run)}>
            <span className="active-teams-strip-dot" data-tone={tone} aria-hidden="true" />
            <span className="active-teams-strip-work">{run.workTitle}</span>
            <span className="active-teams-strip-brand">{run.brandName}</span>
            {/* Un presupuesto que no se pudo leer NO se dibuja como "∞": eso
                sería exactamente la mentira que el `null` de esta fila produce. */}
            <span className="active-teams-strip-budget">
              {run.budgetInvalid ? t('coordination.teams.budgetInvalid') : `${run.dispatchesUsed}/${run.maxDispatches ?? '∞'}`}
            </span>
            {/* El punto es una señal, y una señal no se lee en voz alta: el
                estado y lo pendiente siguen estando, en palabras, para quien
                no ve el color. */}
            <span className="active-teams-strip-status visually-hidden">{t(`coordination.teams.status.${run.status}` as 'coordination.teams.status.running')}</span>
            {coordinatorPaused && <span className="active-teams-strip-paused visually-hidden">{t('coordination.teams.coordinatorPaused')}</span>}
            {run.pendingGates > 0 && <span className="active-teams-strip-gates visually-hidden">{t('coordination.teams.gatesWaiting', { count: run.pendingGates })}</span>}
          </button>
        </li>;
      })}
      {rest > 0 && <li>
        <button type="button" className="active-teams-strip-more" onClick={onOpenHome}>{t('coordination.teams.more', { count: rest })}</button>
      </li>}
    </ul>
  </nav>;
}
