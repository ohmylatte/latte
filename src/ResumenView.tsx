import { translate as t } from './i18n';
import { resumenSummary, type CoordinationHireEvent } from './resumen-summary';
import { CycleMap } from './CycleMap';
import type { Brand, CoordinationLogEntryView, Decision, DocumentState, TeamMember, Work, WorkDocument, WorkPermissionMode } from '../shared/contracts';

/**
 * Resumen: the first in-work tab, answering "¿dónde estamos?" on one screen.
 *
 * It is presentational like `HomeView`: props only, no state, no backend. The
 * review sweep (`useDocumentStates`) is owned by `App` and handed down as
 * `states` + `checking`. Every decision — which "estado actual" wins, which
 * decisions are pending, which rung of the ladder is next — lives in
 * `resumen-summary`, so this component only renders.
 *
 * It owns the ONE in-work next-step ladder (the retired OrientationStrip had it
 * before) and a non-sequential `CycleMap`. It renders no `<nav>` and no
 * `.document-scroll` (it is not a document pane), so both stay unambiguous for
 * the guards that walk the tree.
 */
export interface ResumenViewProps {
  /** Null before a brand resolves; the surface must still be honest. */
  brand: Brand | null;
  /** Null before a work resolves: a safe empty state, never derived content. */
  work: Work | null;
  documents: readonly WorkDocument[];
  decisions: readonly Decision[];
  /** The review sweep's result, owned by `App`. */
  states: Readonly<Record<string, DocumentState>>;
  /** True while the first review sweep has not answered. */
  checking: boolean;
  team: readonly TeamMember[];
  permissions: WorkPermissionMode;
  /** True while an agent session of this work is running. */
  live: boolean;
  brandContextDefined: boolean;
  /**
   * Additive, optional (autonomous-coordination Phase 7 task 7.3): `undefined`
   * means the caller has not wired coordination state yet — the bitácora
   * section does not render at all, so an unwired caller sees zero change.
   */
  coordinationLog?: readonly CoordinationLogEntryView[];
  coordinationHires?: readonly CoordinationHireEvent[];
  /**
   * Additive, optional (autonomous-coordination Phase 7 task 7.11): settles
   * the in-flight dispatch of a bitácora row — surfaces task 3.19's
   * `settleCoordinationDispatch(taskId, outcome, summary)` directly, never
   * reinvents it. `undefined` means the caller has not wired it: no settle
   * control renders, even for a `dispatched`/`running` row.
   */
  onSettleDispatch?: (taskId: string, outcome: 'succeeded' | 'failed', summary: string) => void;
  formatDate: (value: string) => string;
  onOpenBrief: () => void;
}

const IN_FLIGHT_STATUSES = new Set(['dispatched', 'running']);

export function ResumenView(props: ResumenViewProps) {
  if (!props.work) {
    return <section className="resumen-view" role="region" aria-label={t('resumen.region')} />;
  }
  const summary = resumenSummary({
    brandName: props.brand?.name ?? '',
    work: props.work,
    documents: props.documents,
    states: props.states,
    checking: props.checking,
    decisions: props.decisions,
    team: props.team,
    live: props.live,
    brandContextDefined: props.brandContextDefined,
    coordinationLog: props.coordinationLog,
    coordinationHires: props.coordinationHires,
  });
  return <section className="resumen-view" role="region" aria-label={t('resumen.region')}>
    <div className="document-kicker">{t('resumen.kicker')}</div>

    <div className="resumen-header">
      <div className="resumen-next" data-step={summary.step}>
        <strong>{t('orientation.next')}</strong>
        <span>{t(summary.stepKey, summary.stepParams)}</span>
      </div>
      <div className="resumen-estado" data-estado={summary.estado}>
        <strong>{t('resumen.estado')}</strong>
        <span>{t(summary.estadoKey)}</span>
      </div>
    </div>

    <div className="resumen-cells">
      <span className="resumen-cell" data-cell="brand" data-state={props.brandContextDefined ? 'defined' : 'empty'}>
        <strong>{t('orientation.brand')}</strong>
        <span className="resumen-value">{t(summary.brandStateKey)}</span>
      </span>
      <span className="resumen-cell" data-cell="outcome" data-state={summary.expectedOutput ? 'set' : 'unset'}>
        <strong>{t('outcome.label')}</strong>
        <span className="resumen-value" title={summary.expectedOutput ?? undefined}>{summary.expectedOutput ?? <em>{t('outcome.unset')}</em>}</span>
      </span>
      <span className="resumen-cell" data-cell="review" data-state={summary.reviewDocuments === null ? 'pending' : summary.reviewDocuments > 0 ? 'some' : 'none'}>
        <strong>{t('orientation.review')}</strong>
        <span className="resumen-value">{summary.reviewDocuments === null ? '…' : summary.reviewDocuments}</span>
      </span>
      <span className="resumen-cell" data-cell="decisions" data-state={summary.pendingDecisions.length > 0 ? 'some' : 'none'}>
        <strong>{t('orientation.decisions')}</strong>
        <span className="resumen-value">{summary.pendingDecisions.length}</span>
      </span>
    </div>

    <div className="resumen-items">
      <section className="resumen-item" data-item="objetivo">
        <h2>{t('resumen.objetivo')}</h2>
        <p className="resumen-title">{summary.title}</p>
        <p>{summary.brief}</p>
        <button className="primary" onClick={props.onOpenBrief}>{t('resumen.openBrief')}</button>
      </section>

      <section className="resumen-item" data-item="resultado">
        <h2>{t('outcome.label')}</h2>
        <p>{summary.expectedOutput ?? <em>{t('outcome.unset')}</em>}</p>
        {summary.resultPath && <p className="resumen-result-path"><code>{summary.resultPath}</code></p>}
      </section>

      <section className="resumen-item" data-item="marca">
        <h2>{t('resumen.marca')}</h2>
        <p>{summary.brandName}</p>
        <p className="resumen-folder"><strong>{t('resumen.folder')}</strong> <span>{summary.folder ?? t('resumen.folder.none')}</span></p>
        <p className="resumen-alcance"><strong>{t('resumen.alcance')}</strong> <span>{t('knowledge.thisWork')}</span></p>
      </section>

      <section className="resumen-item" data-item="decisiones">
        <h2>{t('orientation.decisions')}</h2>
        {summary.pendingDecisions.length > 0 && <ul className="resumen-decision-list">{summary.pendingDecisions.map((row) => (
          <li key={row.id}><p>{row.text}</p><small>{props.formatDate(row.createdAt)}</small></li>
        ))}</ul>}
      </section>

      {props.coordinationLog !== undefined && <section className="resumen-item" data-item="bitacora">
        <h2>{t('resumen.bitacora')}</h2>
        {summary.bitacoraRows.length > 0 && <ul className="resumen-bitacora-list">{summary.bitacoraRows.map((row) => (
          <li className="resumen-bitacora-row" key={row.id}>
            <p>{row.kind === 'hire'
              ? t('resumen.bitacora.hired', { roleName: row.roleName })
              : row.kind === 'runDone'
                ? t('resumen.bitacora.runDone', { done: row.tasksDone, failed: row.tasksFailed })
                : t(`resumen.bitacora.status.${row.status}` as 'resumen.bitacora.status.reported')}</p>
            <small>{props.formatDate(row.at)}</small>
            {row.kind === 'dispatch' && IN_FLIGHT_STATUSES.has(row.status) && props.onSettleDispatch && <div className="resumen-bitacora-settle">
              <button type="button" className="resumen-bitacora-settle-succeeded" onClick={() => {
                const value = window.prompt(t('coordination.settle.summaryPrompt'), '');
                if (value?.trim()) props.onSettleDispatch!(row.taskId, 'succeeded', value.trim());
              }}>{t('coordination.settle.succeeded')}</button>
              <button type="button" className="resumen-bitacora-settle-failed" onClick={() => {
                const value = window.prompt(t('coordination.settle.summaryPrompt'), '');
                if (value?.trim()) props.onSettleDispatch!(row.taskId, 'failed', value.trim());
              }}>{t('coordination.settle.failed')}</button>
            </div>}
          </li>
        ))}</ul>}
      </section>}

      <section className="resumen-item" data-item="acciones">
        <h2>{t('resumen.acciones')}</h2>
        <p className="resumen-permission-mode">{t(`permission.mode.${props.permissions}` as 'permission.mode.ask')}</p>
        <p className="resumen-permission-help">{t(`permission.help.${props.permissions}` as 'permission.help.ask')}</p>
      </section>
    </div>

    <CycleMap phases={summary.cycle} />
  </section>;
}
