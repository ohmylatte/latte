import { useState } from 'react';
import { translate as t } from './i18n';
import { FileText, RefreshCw } from 'lucide-react';
import type { DocumentState, FunnelStage, WorkDocument } from '../shared/contracts';
import { groupByStage, reviewReasons, STAGES, STAGE_LABEL, STATUS_LABEL } from './document-organizer';
import { KnowledgeOrigin } from './KnowledgeScope';
import { ApprovalStamp } from './brand-marks';

/**
 * The campaign by funnel stage, on its own screen.
 *
 * An empty stage collapses to a single line. The first version gave each one a
 * full card, so a new work spent four blocks of screen saying "nothing here"
 * and pushed the unclassified documents — every document there is — below the
 * fold. A zero is worth one line; what you have to work on is worth the space.
 *
 * An empty gap is also actionable: it offers the five human triggers that
 * close it (analyze, propose, experiment, associate an existing piece, or mark
 * the stage out of scope). Out-of-scope stages stay visible but muted, and
 * unmarking restores the normal gap.
 */
export function FunnelView({ documents, selectedId, states, checking, onRefresh, onSelect, busy, currentWorkId, workTitles, outOfScopeStages, onCreateAction, onAssociate, onToggleOutOfScope }: {
  documents: WorkDocument[];
  selectedId: string | null;
  states: Record<string, DocumentState>;
  checking: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  busy: boolean;
  currentWorkId: string | null;
  workTitles: Record<string, string>;
  outOfScopeStages: FunnelStage[];
  onCreateAction: (stage: FunnelStage, kind: 'analyze' | 'propose' | 'experiment') => void;
  onAssociate: (documentId: string, stage: FunnelStage) => void;
  onToggleOutOfScope: (stage: FunnelStage) => void;
}) {
  const [associating, setAssociating] = useState<FunnelStage | null>(null);
  const groups = groupByStage(documents);
  // An out-of-scope stage is parked, not actionable: it leaves the empty list.
  const empty = STAGES.filter(s => groups[s].length === 0 && !outOfScopeStages.includes(s));
  // Out-of-scope only ever hides EMPTY stages: a stage with documents keeps them.
  const parked = outOfScopeStages.filter(s => groups[s].length === 0);
  // A document in several stages appears once per stage. The leftmost stage is
  // its home; later appearances are "same file" repeats, not duplicates.
  const firstStage: Record<string, FunnelStage> = {};
  for (const s of STAGES) for (const d of groups[s]) if (!(d.id in firstStage)) firstStage[d.id] = s;

  const candidates = (stage: FunnelStage): WorkDocument[] => documents.filter(d => d.workId === currentWorkId && !(d.funnelStages ?? []).includes(stage));

  const card = (d: WorkDocument, stage?: FunnelStage) => {
    const repeat = stage !== undefined && firstStage[d.id] !== stage;
    return <button key={d.id} data-document-id={d.id} data-origin-work={d.workId} data-current-work={d.workId === currentWorkId ? 'true' : 'false'} disabled={busy} className={'funnel-card' + (repeat ? ' repeat' : '') + (selectedId === d.id ? ' selected' : '')} onClick={() => onSelect(d.id)} aria-label={t('ui.auto.124') + d.title}>
      <FileText size={14} />
      <span>
        <strong>{d.title}{d.status === 'approved' && <ApprovalStamp size={16} className="row-stamp" />}</strong>
        <small><span className={'doc-status doc-status-' + d.status}>{STATUS_LABEL[d.status]}</span> · {d.fileName}</small>
        <KnowledgeOrigin workId={d.workId} currentWorkId={currentWorkId} titles={workTitles} />
        {d.proposedFunnelStages.length > 0 && <em className="proposed">{t('ui.auto.373')} {d.proposedFunnelStages.map(s => STAGE_LABEL[s]).join(' + ')}</em>}
        {repeat && <em className="repeat-note">{t('funnel.sameFile')}</em>}
        {reviewReasons(d, states[d.id]?.baseOutdated ?? false).map(reason => <em key={reason}>{reason}</em>)}
      </span>
    </button>;
  };

  return <div className="funnel-view">
    <header className="funnel-head">
      <div>
        <span className="eyebrow">{t('ui.auto.197')}</span>
        <h2>{t('ui.auto.198')}</h2>
      </div>
      <button className="icon-button" aria-label={t('ui.auto.199')} disabled={checking} onClick={onRefresh}><RefreshCw size={13} /></button>
    </header>
    <p className="explorer-hint">{t('ui.auto.200')}</p>

    {groups.unclassified.length > 0 && <section className="funnel-block unclassified" aria-label={t('ui.auto.201')}>
      <h3>{t('ui.auto.201')} <small>{groups.unclassified.length}</small></h3>
      <p className="stage-empty">{t('ui.auto.202')}</p>
      <div className="funnel-cards">{groups.unclassified.map(d => card(d))}</div>
    </section>}

    {STAGES.map((s, i) => groups[s].length > 0 && <section className={'funnel-block funnel-stage-' + i} key={s} data-stage={s} aria-label={STAGE_LABEL[s]}>
      <h3><span>{String(i + 1).padStart(2, '0')} / {STAGE_LABEL[s]}</span><small>{groups[s].length}</small></h3>
      <div className="funnel-cards">{groups[s].map(d => card(d, s))}</div>
    </section>)}

    {(empty.length > 0 || parked.length > 0) && <section className="funnel-gaps" aria-label={t('ui.auto.203')}>
      <h3>{t('ui.auto.204')} <small>{empty.length + parked.length}</small></h3>
      {empty.map(s => <div key={s} data-stage={s} className="funnel-gap">
        <span className="funnel-gap-stage">{String(STAGES.indexOf(s) + 1).padStart(2, '0')} / {STAGE_LABEL[s]}</span>
        <span className="funnel-gap-empty">{t('funnel.emptyStage')}</span>
        <span className="funnel-gap-unattended">{t('funnel.unattended')}</span>
        <div className="funnel-gap-actions">
          <button disabled={busy} onClick={() => onCreateAction(s, 'analyze')}>{t('funnel.analyze')}</button>
          <button disabled={busy} onClick={() => onCreateAction(s, 'propose')}>{t('funnel.propose')}</button>
          <button disabled={busy} onClick={() => onCreateAction(s, 'experiment')}>{t('funnel.experiment')}</button>
          <button disabled={busy} aria-expanded={associating === s} onClick={() => setAssociating(associating === s ? null : s)}>{t('funnel.associate')}</button>
          <button disabled={busy} onClick={() => onToggleOutOfScope(s)}>{t('funnel.outOfScope')}</button>
        </div>
        {associating === s && <div className="funnel-associate" role="listbox" aria-label={t('funnel.associateTitle')}>
          {candidates(s).length === 0
            ? <p className="funnel-associate-empty">{t('funnel.associateEmpty')}</p>
            : candidates(s).map(d => <button key={d.id} data-document-id={d.id} disabled={busy} onClick={() => onAssociate(d.id, s)}>{d.title}<small>{d.fileName}</small></button>)}
        </div>}
      </div>)}
      {parked.map(s => <div key={s} data-stage={s} className="funnel-gap out-of-scope">
        <span className="funnel-gap-stage">{String(STAGES.indexOf(s) + 1).padStart(2, '0')} / {STAGE_LABEL[s]}</span>
        <span className="funnel-gap-marked">{t('funnel.outOfScopeMarked')}</span>
        <button disabled={busy} onClick={() => onToggleOutOfScope(s)}>{t('funnel.outOfScopeUndo')}</button>
      </div>)}
      <p className="footnote">{t('ui.auto.206')}</p>
    </section>}
  </div>;
}
