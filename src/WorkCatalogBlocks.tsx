import type { ComponentType } from 'react';
import {
  ArrowLeftRight, CalendarDays, ChartColumn, Compass, FileText, Gauge, Layers, type LucideProps,
  Megaphone, PenLine, Presentation, Repeat, SlidersHorizontal, Target, Wallet,
} from 'lucide-react';
import { useI18n } from './i18n';
import { intentGroups, workTypesForIntent, type IntentId, type WorkType } from './work-catalog';

type Icon = ComponentType<LucideProps>;

/** One icon per funnel block. Decorative: the block name is the label. */
const BLOCK_ICON: Record<IntentId, Icon> = {
  plan: Compass,
  produce: PenLine,
  operate: SlidersHorizontal,
  measure: ChartColumn,
};

/** One icon per start option; a new work type without one falls back to its block's. */
const WORK_ICON: Record<string, Icon> = {
  'campaign-new': Megaphone,
  strategy: Target,
  'content-calendar': CalendarDays,
  'copy-pieces': PenLine,
  'adapt-pieces': Layers,
  presentation: Presentation,
  'campaign-ops': Repeat,
  'campaign-optimize': Gauge,
  'budget-review': Wallet,
  'paid-media-audit': ChartColumn,
  'period-compare': ArrowLeftRight,
  'report-build': FileText,
};

/**
 * QA1 · A: the catalog like a paid-ads platform — four funnel blocks side by
 * side, each with two or three compact start options (icon + short label, the
 * whole row clickable, no description text). ONE component, used by the
 * onboarding intent step and by the "Nuevo trabajo" modal, so the two can
 * never drift apart. The description survives only as a one-line tooltip.
 */
export function WorkCatalogBlocks({ onSelect, disabled = false }: { onSelect: (workType: WorkType) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return <div className="catalog">
    <div className="catalog-blocks">
      {intentGroups.map((group) => {
        const BlockIcon = BLOCK_ICON[group.id];
        const headingId = `catalog-block-${group.id}`;
        return <section className="catalog-block" key={group.id} aria-labelledby={headingId}>
          <h2 id={headingId}><BlockIcon size={16} aria-hidden="true" />{t(group.nameKey)}</h2>
          <ul>
            {workTypesForIntent(group.id).map((w) => {
              const RowIcon = WORK_ICON[w.id] ?? BlockIcon;
              return <li key={w.id}>
                <button type="button" className="catalog-row" title={t(w.descriptionKey)} disabled={disabled} onClick={() => onSelect(w)}>
                  <RowIcon size={16} aria-hidden="true" /><span>{t(w.titleKey)}</span>
                </button>
              </li>;
            })}
          </ul>
        </section>;
      })}
    </div>
  </div>;
}
