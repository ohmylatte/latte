import { translate as t } from './i18n';
import type { CyclePhase } from './resumen-summary';

/**
 * The cycle as a status map, never a wizard.
 *
 * Five phases in a fixed, non-sequential order — Observar, Entender, Decidir,
 * Actuar, Medir — each naming the surface that feeds it. There is no next/back,
 * no step index and no enforced linear flow: a work can be in several phases at
 * once, so the only honest rendering is a map. Props only, no state, no ref and
 * no handler: every phase is a read-only fact from `CYCLE_PHASES`.
 */
export function CycleMap({ phases }: { phases: readonly CyclePhase[] }) {
  return <ol className="cycle-map">
    {phases.map((phase) => (
      <li key={phase.id} className="cycle-phase" data-phase={phase.id}>
        <strong className="cycle-phase-label">{t(phase.labelKey)}</strong>
        <span className="cycle-phase-feed">{t(phase.feedKey)}</span>
      </li>
    ))}
  </ol>;
}
