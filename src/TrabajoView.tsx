import { translate as t } from './i18n';
import { trabajoSummary } from './trabajo-summary';
import type { LatteMode } from './TeamPanel';
import type { Brand, ChatRuntime, Decision, DocumentState, HandoffRequest, TeamMember, Work, WorkDocument, WorkPermissionMode } from '../shared/contracts';

/**
 * Trabajo: the in-work surface answering "¿cómo viene el trabajo?".
 *
 * It is presentational like `ResumenView`: props only, no state, no backend.
 * Every decision — which encargo, which documents and handoffs are in scope,
 * which estado wins, which rung of the ladder is next — lives in
 * `trabajo-summary`, so this component only renders.
 *
 * The runtime/model/esfuerzo of each member is a technical detail, so it is
 * gated behind `mode === 'advanced'` (the same gate `TeamPanel` uses); the
 * permission requests stay visible in both modes. The "Conversar" action opens
 * the agent drawer through `onOpenChat` — the conversation never renders
 * inline. It renders no `<nav>` and no `.document-scroll` (it is not a document
 * pane) and no `.orientation-strip` (that ladder is retired; the single
 * next-step rung below reuses `orientationSummary`).
 */

const RUNTIME_NAME: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', grok: 'Grok', hermes: 'Hermes' };

export interface TrabajoViewProps {
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
  handoffs: readonly HandoffRequest[];
  /** True while an agent session of this work is running. */
  live: boolean;
  brandContextDefined: boolean;
  /** Gates the member runtime/model/esfuerzo detail. */
  mode: LatteMode;
  formatDate: (value: string) => string;
  /** Opens the agent drawer: the conversation never renders in `<main>`. */
  onOpenChat: () => void;
}

export function TrabajoView(props: TrabajoViewProps) {
  if (!props.work) {
    return <section className="trabajo-view" role="region" aria-label={t('trabajo.region')} />;
  }
  const summary = trabajoSummary({
    work: props.work,
    documents: props.documents,
    decisions: props.decisions,
    states: props.states,
    checking: props.checking,
    team: props.team,
    handoffs: props.handoffs,
    live: props.live,
    brandContextDefined: props.brandContextDefined,
  });
  return <section className="trabajo-view" role="region" aria-label={t('trabajo.region')}>
    <div className="document-kicker">{t('trabajo.kicker')}</div>

    <div className="trabajo-items">
      <section className="trabajo-item" data-section="encargo">
        <h2>{t('trabajo.encargo')}</h2>
        <p className="trabajo-title">{summary.title}</p>
        <p>{summary.brief}</p>
        <p className="trabajo-outcome"><strong>{t('outcome.label')}</strong> <span>{summary.expectedOutput ?? <em>{t('outcome.unset')}</em>}</span></p>
        {summary.resultPath && <p className="trabajo-result-path"><code>{summary.resultPath}</code></p>}
      </section>

      <section className="trabajo-item" data-section="documentos">
        <h2>{t('trabajo.documentos')}</h2>
        {summary.documents.length === 0 && <p className="trabajo-empty">{t('trabajo.documentos.empty')}</p>}
        {summary.documents.length > 0 && <ul className="trabajo-document-list">{summary.documents.map((row) => (
          <li key={row.id}>
            <span className="trabajo-doc-title">{row.title}</span>
            <span className="trabajo-doc-meta">{t(`kind.${row.kind}` as 'kind.brief')}{row.needsReview ? ` · ${t('orientation.review')}` : ''}</span>
          </li>
        ))}</ul>}
      </section>

      <section className="trabajo-item" data-section="permisos">
        <h2>{t('trabajo.permisos')}</h2>
        <p className="trabajo-permission-mode">{t(`permission.mode.${props.permissions}` as 'permission.mode.ask')}</p>
        <p className="trabajo-permission-help">{t(`permission.help.${props.permissions}` as 'permission.help.ask')}</p>
        {summary.handoffs.length === 0 && <p className="trabajo-empty">{t('trabajo.handoffs.empty')}</p>}
        {summary.handoffs.length > 0 && <ul className="trabajo-handoff-list">{summary.handoffs.map((h) => (
          <li key={h.fileName}><span>{h.roleName}</span><small>{h.fileName}</small></li>
        ))}</ul>}
        {props.mode === 'advanced' && props.team.length > 0 && <div className="trabajo-team">
          {props.team.map((member) => (
            <div key={member.id} className="trabajo-member">
              <span className="trabajo-member-name">{member.roleName}</span>
              <span className="trabajo-member-meta">
                <strong>{t('trabajo.runtime')}</strong> {RUNTIME_NAME[member.runtime]}
                {' · '}<strong>{t('trabajo.modelo')}</strong> {member.model ?? '—'}
                {' · '}<strong>{t('trabajo.esfuerzo')}</strong> {t(`effort.tier.${member.tier}.label` as 'effort.tier.light.label')}
              </span>
            </div>
          ))}
        </div>}
      </section>

      <section className="trabajo-item" data-section="progreso">
        <h2>{t('trabajo.progreso')}</h2>
        <p className="trabajo-estado" data-estado={summary.estado}>{t(summary.estadoKey)}</p>
        <div className="trabajo-cells">
          <span className="trabajo-cell" data-cell="working"><strong>{t('resumen.estado.working')}</strong><span className="trabajo-value">{summary.workingMembers}</span></span>
          <span className="trabajo-cell" data-cell="review" data-state={summary.reviewDocuments === null ? 'pending' : summary.reviewDocuments > 0 ? 'some' : 'none'}><strong>{t('orientation.review')}</strong><span className="trabajo-value">{summary.reviewDocuments === null ? '…' : summary.reviewDocuments}</span></span>
          <span className="trabajo-cell" data-cell="decisions" data-state={summary.pendingDecisions > 0 ? 'some' : 'none'}><strong>{t('orientation.decisions')}</strong><span className="trabajo-value">{summary.pendingDecisions}</span></span>
        </div>
      </section>

      <section className="trabajo-item" data-section="proximos">
        <h2>{t('trabajo.proximos')}</h2>
        <p className="trabajo-next" data-step={summary.step}>{t(summary.stepKey, summary.stepParams)}</p>
      </section>
    </div>

    <button className="primary trabajo-conversar" onClick={props.onOpenChat}>{t('trabajo.conversar')}</button>
  </section>;
}
