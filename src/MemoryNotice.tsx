import { translate as t } from './i18n';
import { X } from 'lucide-react';
import type { CoordinationMemberSupport } from '../shared/contracts';

/**
 * The engram install docs. `Gentleman-Programming/engram` is third-party
 * (MIT, active) — see the corresponding discovery on record — not something
 * Latte bundles or auto-installs. That decision is pending from Gabriel;
 * this notice only points at where to read it, it builds no installer.
 */
export const ENGRAM_INSTALL_HREF = 'https://github.com/Gentleman-Programming/engram#readme';

/**
 * The memory notice (autonomous-coordination Phase 7 task 7.10): engram
 * ships by default, so its absence is a Brand-level fact, not a per-member
 * footnote. Takes the WHOLE Work's (or Brand's) `coordinationRuntimeSupport`
 * rows and renders ONE notice the moment any of them is degraded for
 * `engram_not_installed` — structurally impossible to duplicate per member,
 * because this component never maps over the rows to render itself.
 *
 * Dismissal is the caller's own React state (`dismissed`), never persisted
 * to disk: it "returns next launch while the condition holds" simply
 * because that state resets when the app restarts, exactly as the design
 * asks — no localStorage, no backend write for something this soft.
 */
export interface MemoryNoticeProps {
  support: readonly CoordinationMemberSupport[];
  dismissed: boolean;
  onDismiss: () => void;
}

export function MemoryNotice({ support, dismissed, onDismiss }: MemoryNoticeProps) {
  const affected = support.some((row) => row.reason === 'engram_not_installed');
  if (!affected || dismissed) return null;
  return <div className="memory-notice" role="status">
    <div>
      <strong>{t('memory.notice.missingTitle')}</strong>
      <p>{t('memory.notice.missingBody')}</p>
      <a href={ENGRAM_INSTALL_HREF} target="_blank" rel="noreferrer">{t('memory.notice.installLink')}</a>
    </div>
    <button type="button" className="memory-notice-dismiss" aria-label={t('ui.auto.044')} onClick={onDismiss}><X size={14} /></button>
  </div>;
}
