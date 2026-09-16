import { MessageSquare, RotateCcw, Save, Trash2, X, Check } from 'lucide-react';
import type { Brand, BrandContextProposal, Work } from '../shared/contracts';
import { translate as t } from './i18n';
import { CONTEXT_STATE_KEYS, REVISION_SOURCE_KEYS, decidedReasonKey, deriveContextView, isCurrentRevision, revisionList, revisionPreview, type ContextStatusView } from './context-view';

/**
 * The Contexto view: where a human writes what every agent of this brand should
 * know before it starts.
 *
 * Props only, like `DocumentsView` and `TeamPanel`. `App` keeps the draft, the
 * `contextDirty` flag and the close guard, so leaving this view cannot lose an
 * unsaved context silently.
 */
export interface ContextViewProps {
  brand: Brand;
  /** Proposals of this brand, any status; the pending one is the review card. */
  proposals: BrandContextProposal[];
  /** What the app knows beyond the brand record. Null while it is still unknown. */
  status: ContextStatusView | null;
  /** A work is needed to ask the strategist, and for the "next sessions" truth. */
  work: Work | null;
  draft: string;
  busy: boolean;
  /** False in the web preview: asking the strategist needs a real runtime. */
  desktop: boolean;
  onDraft: (value: string) => void;
  onSave: () => void;
  /**
   * Clearing on purpose is an explicit, confirmed action: it lands with the
   * brand-context history tier, so P0 declares the prop and offers no control.
   */
  onClear?: () => void;
  onDecide: (proposalId: string, action: 'approve' | 'edit' | 'reject', acceptStale?: boolean) => void;
  onAsk: () => void;
  /** Restoring a past revision is the history tier; declared, not offered yet. */
  onRestore?: (revisionId: string) => void;
  /**
   * A save was refused because `brand.context` changed underneath
   * (`CONTEXT_STALE`). The draft survives; the human has to choose.
   */
  conflict?: boolean;
  /** Takes the value that is on disk now, discarding the draft. */
  onReload?: () => void;
  /** Keeps the draft and writes it against the value that is on disk now. */
  onOverride?: () => void;
}

export function ContextView(props: ContextViewProps) {
  const { brand, proposals } = props;
  const pending = proposals.find((proposal) => proposal.status === 'pending') ?? null;
  const decided = proposals.filter((proposal) => proposal.status !== 'pending');
  const worksCount = props.status?.worksCount ?? 0;
  const history = revisionList(props.status?.revisions ?? []);
  const view = deriveContextView({
    context: brand.context,
    draft: props.draft,
    proposals,
    liveCount: props.status?.liveCount ?? 0,
    hasWork: Boolean(props.work),
    busy: props.busy,
  });

  return <div className="document-scroll">
    <div className="document-kicker">{t('ui.auto.045')}</div>
    <h1>{t('ui.auto.046')}<br />{t('ui.auto.047')}</h1>
    <p className="intro">{t('ui.auto.048')}</p>

    {/* The brand-wide truth: one context, every work of this brand, and where it stands. */}
    <div className="context-banner">
      <span className={'context-state context-state-' + view.state}>{t(CONTEXT_STATE_KEYS[view.state])}</span>
      {worksCount > 0 && <span className="context-shared">{t('context.shared', { count: worksCount })}</span>}
    </div>

    <label className="field-label" htmlFor="brand-context">{t('ui.auto.049')} {brand.name}</label>
    <textarea
      id="brand-context"
      className="context-editor"
      value={props.draft}
      placeholder={t('ui.auto.050')}
      disabled={props.busy}
      onChange={(event) => props.onDraft(event.target.value)}
    />
    <div className="document-actions context-write">
      <button className="primary" disabled={!view.canSave} onClick={props.onSave}><Save size={15} />{t('ui.auto.051')}</button>
      {/* Emptying is a decision of its own: it never happens by saving an empty
          box, only through this confirmed action, and it stays recoverable. */}
      {props.onClear && <button className="danger" disabled={!view.canClear} onClick={props.onClear}><Trash2 size={15} />{t('context.clear')}</button>}
    </div>
    {view.liveCount > 0 && <p className="footnote">{t('ui.auto.052')}</p>}

    {/* A refused save is not an error to swallow: the context changed underneath
        and the draft is still here. Reloading takes what is on disk; overriding
        keeps the human's text and writes it on top of the current value. */}
    {props.conflict && <div className="context-conflict" role="alert">
      <p className="footnote">{t('context.conflict')}</p>
      <div className="document-actions">
        <button disabled={props.busy} onClick={props.onReload}><RotateCcw size={15} />{t('context.conflict.reload')}</button>
        <button className="primary" disabled={props.busy || !view.dirty} onClick={props.onOverride}><Save size={15} />{t('context.conflict.override')}</button>
      </div>
    </div>}

    {pending && <section className="context-proposal" aria-label={t('context.proposal')}>
      <div className="document-kicker">{t('context.proposal')}</div>
      <p className="footnote">{pending.mode === 'append' ? t('context.mode.append') : t('context.mode.replace')}</p>
      {pending.rationale && <p className="context-rationale">{pending.rationale}</p>}
      <div className="context-diff" role="group" aria-label={t('context.diff')}>
        {view.diff.map((line, index) => <div key={index} className={'context-diff-line context-diff-' + line.kind}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} {line.text}</div>)}
      </div>
      {view.stalePending && <p className="footnote">{t('context.changedSince')}</p>}
      <div className="document-actions">
        <button className="primary" disabled={props.busy} onClick={() => props.onDecide(pending.id, 'approve', view.stalePending)}><Check size={15} />{view.stalePending ? t('context.acceptStale') : t('context.accept')}</button>
        <button disabled={props.busy} onClick={() => props.onDecide(pending.id, 'edit')}>{t('context.editAccept')}</button>
        <button disabled={props.busy} onClick={() => props.onDecide(pending.id, 'reject')}><X size={15} />{t('context.reject')}</button>
      </div>
    </section>}

    <div className="document-actions">
      {props.desktop
        ? <button disabled={!view.canAsk} onClick={props.onAsk}><MessageSquare size={15} />{t('context.ask')}</button>
        : <p className="footnote">{t('ui.auto.028')}</p>}
    </div>
    {!props.work && <p className="footnote">{t('context.ask.needWork')}</p>}

    {/* The trail of what was decided, superseded included: a replaced proposal
        must not vanish silently when a newer one takes its place. */}
    {decided.length > 0 && <section className="context-decided" aria-label={t('context.decided')}>
      <div className="document-kicker">{t('context.decided')}</div>
      <ul>{decided.map((proposal) => <li key={proposal.id}><span>{t(decidedReasonKey(proposal))}</span><small>{proposal.createdAt.slice(0, 10)}</small></li>)}</ul>
    </section>}

    {/* The history of the context itself. Restoring is a write like any other,
        so it is recorded and can be undone by restoring what it replaced. */}
    {props.status && <section className="context-history" aria-label={t('context.history')}>
      <div className="document-kicker">{t('context.history')}</div>
      {history.shown.length === 0
        ? <p className="footnote">{t('context.history.empty')}</p>
        : <ul>{history.shown.map((revision) => <li key={revision.id}>
            <span className="context-revision-source">{t(REVISION_SOURCE_KEYS[revision.source])}</span>
            {/* What restoring would bring back, so the confirm is not blind. */}
            {revisionPreview(revision.content) && <span className="context-revision-preview" title={revision.content}>{revisionPreview(revision.content)}</span>}
            <small>{revision.createdAt.slice(0, 10)}</small>
            {/* The newest revision IS the live context: offering "Restaurar" on
                it was a button that did nothing, silently. It says so instead. */}
            {isCurrentRevision(revision, brand.context)
              ? <span className="context-revision-current">{t('context.restore.current')}</span>
              : <button className="subtle" disabled={props.busy} onClick={() => props.onRestore?.(revision.id)}><RotateCcw size={13} />{t('context.restore')}</button>}
          </li>)}</ul>}
      {history.hidden > 0 && <p className="footnote">{t('context.history.more', { count: history.hidden })}</p>}
    </section>}
  </div>;
}
