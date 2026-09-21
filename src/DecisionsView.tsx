import { translate as t } from './i18n';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { KnowledgeOrigin } from './KnowledgeScope';
import type {
  AgentRole, Decision, DecisionAuthorityMode, HandoffRequest, TeamMember, Work, WorkPermissionMode,
} from '../shared/contracts';

/**
 * Decisiones: the extracted, enriched in-work decisions surface.
 *
 * It is props-only like `TrabajoView`: the header, authority select, add form,
 * decision list and knowledge-scope filter all move verbatim out of `App.tsx`,
 * with every handler becoming a callback so the backend (`api.*`) and the
 * state (`setDecisions`) stay in `App`. The extraction is a mechanical move,
 * not a rewrite.
 *
 * Two things are added on top of the verbatim block:
 *  - the three persisted `Decision` fields the inline block omitted —
 *    responsables (`source.memberId`/`source.roleId` resolved to a name, never
 *    a raw id), `alternativesRejected` and `evidenceRefs` — rendered only when
 *    present, never invented;
 *  - a read-only `.decision-permissions` summary of the work's
 *    `WorkPermissionMode` and `HandoffRequest[]`, visually distinct from the
 *    approve/reject controls, because approving a decision is not authorizing
 *    anything (aprobación ≠ autorización).
 */
export interface DecisionsViewProps {
  work: Work | null;
  /** The knowledge-scope-filtered decisions to render. */
  decisions: readonly Decision[];
  team: readonly TeamMember[];
  roles: readonly AgentRole[];
  permissions: WorkPermissionMode;
  handoffs: readonly HandoffRequest[];
  decisionAuthority: DecisionAuthorityMode;
  draft: string;
  busy: boolean;
  formatDate: (value: string) => string;
  titlesByWork: Record<string, string>;
  onDraftChange: (value: string) => void;
  onAdd: (text: string) => void;
  onApprove: (id: string) => void;
  onEditApprove: (id: string, edited: string) => void;
  onReject: (id: string) => void;
  onArchive: (id: string) => void;
  onAuthorityChange: (mode: DecisionAuthorityMode) => void;
  /**
   * Acepta un handoff como TAREA de la coordinación (`acceptHandoffAsTask`).
   * `undefined` deja la lista de sólo lectura, como estaba. Sin esto la función
   * existía cableada en cinco lugares y no había forma humana de dispararla.
   */
  onAcceptHandoff?: (handoff: HandoffRequest) => void;
}

/** The coordinator's team member, resolved to a display name — never a raw id. */
function resolveCoordinatorName(memberId: string, team: readonly TeamMember[]): string | null {
  return team.find((m) => m.id === memberId)?.roleName ?? null;
}

/**
 * Resolve who made the decision, in the design's precedence order: a member id
 * through the team, else a role id through the team's members, else a role id
 * through the roles catalog, else nothing. A raw id is never shown.
 */
function resolveResponsable(decision: Decision, team: readonly TeamMember[], roles: readonly AgentRole[]): string | null {
  if (decision.source.memberId) {
    const member = team.find((m) => m.id === decision.source.memberId);
    if (member) return member.roleName;
  }
  if (decision.source.roleId) {
    const member = team.find((m) => m.roleId === decision.source.roleId);
    if (member) return member.roleName;
    const role = roles.find((r) => r.id === decision.source.roleId);
    if (role) return role.name;
  }
  return null;
}

/** A proposal's `roleId` resolved to a display name: the hired member if one already exists, else the roles catalog, else the raw id — never invented. */
function resolveRoleName(roleId: string, roles: readonly AgentRole[], team: readonly TeamMember[]): string {
  const member = team.find((m) => m.roleId === roleId);
  if (member) return member.roleName;
  const role = roles.find((r) => r.id === roleId);
  if (role) return role.name;
  return roleId;
}

/**
 * B1.4: DECISIONES QUEDA PARA LO QUE PERDURA.
 *
 * "Decisiones es de marca y permanente; cada coordinación la llena de ruido."
 * De acá se fueron las tarjetas de gate, las preguntas, el estado de los
 * equipos, el bloque de coordinación autónoma, el editor de presupuesto y el
 * cartel del run terminado: todo eso es lo que PASA, y vive donde pasa --el
 * chat del miembro y el panel del equipo. Lo que queda es lo que dura: las
 * decisiones de marca y quién puede hacer qué.
 */
export function DecisionsView(props: DecisionsViewProps) {
  return <div className="document-scroll">
    <div className="document-kicker">{t('decision.kicker')}</div>
    <h1>{t('decision.headline.first')}<br />{t('decision.headline.second')}</h1>
    <p className="intro">{t('ui.auto.053')}</p>
    {props.work && <>
      <label className="field-label">{t('decision.authority.label')}</label>
      <select value={props.decisionAuthority} onChange={e => props.onAuthorityChange(e.target.value as DecisionAuthorityMode)}>
        <option value="off">{t('decision.authority.off')}</option>
        <option value="suggest">{t('decision.authority.suggest')}</option>
        <option value="auto-record">{t('decision.authority.auto')}</option>
      </select>
      <p className="footnote">{t('decision.authority.help')}</p>
      <form className="decision-form" onSubmit={e => { e.preventDefault(); props.onAdd(props.draft); }}>
        <textarea aria-label={t('ui.auto.054')} placeholder={t('decision.draftPlaceholder')} value={props.draft} onChange={e => props.onDraftChange(e.target.value)} />
        <button className="primary" disabled={!props.draft.trim() || props.busy}><Plus size={15} />{t('ui.auto.055')}</button>
      </form>
    </>}
    <div className="decision-list">
      {props.decisions.filter(d => d.status !== 'rejected' && d.status !== 'archived').map((d, i) => {
        const responsable = resolveResponsable(d, props.team, props.roles);
        return <div className={'decision-card status-' + d.status} data-origin-work={d.workId} data-current-work={d.workId === props.work?.id ? 'true' : 'false'} key={d.id}>
          <span className="decision-number">{String(i + 1).padStart(2, '0')}</span>
          <div>
            <small>{d.status === 'pending' ? t('decision.pending') : d.source.chatId ? t('decision.autoNotice') : ''}</small>
            <KnowledgeOrigin workId={d.workId} currentWorkId={props.work?.id ?? null} titles={props.titlesByWork} />
            <p>{d.text}</p>
            {d.rationale && <p className="footnote">{d.rationale}</p>}
            {responsable && <p className="decision-responsible"><strong>{t('decision.responsible')}</strong> <span>{responsable}</span></p>}
            {d.alternativesRejected.length > 0 && <p className="decision-alternatives"><strong>{t('decision.alternatives')}</strong> <span>{d.alternativesRejected.join(', ')}</span></p>}
            {d.evidenceRefs.length > 0 && <p className="decision-evidence"><strong>{t('decision.evidence')}</strong> <span>{d.evidenceRefs.join(', ')}</span></p>}
            <small>{props.formatDate(d.createdAt)}</small>
            {d.status === 'pending' && <div className="chat-card-actions">
              <button className="primary" onClick={() => props.onApprove(d.id)}>{t('decision.add')}</button>
              <button onClick={() => { const edited = window.prompt(t('decision.editAdd'), d.text); if (edited?.trim()) props.onEditApprove(d.id, edited.trim()); }}>{t('decision.editAdd')}</button>
              <button onClick={() => props.onReject(d.id)}>{t('decision.discard')}</button>
            </div>}
            {d.status === 'approved' && d.source.chatId && <button onClick={() => props.onArchive(d.id)}>{t('decision.undo')}</button>}
          </div>
        </div>;
      })}
      {!props.decisions.filter(d => d.status === 'approved' || d.status === 'pending').length && <p className="footnote">{t('ui.auto.056')}</p>}
    </div>
    {props.work && <section className="decision-permissions">
      <div className="document-kicker">{t('decision.permissions.kicker')}</div>
      <p className="decision-permissions-lead">{t('decision.permissions.lead')}</p>
      <p className="decision-permission-mode">{t(`permission.mode.${props.permissions}` as 'permission.mode.ask')}</p>
      <p className="decision-permission-help">{t(`permission.help.${props.permissions}` as 'permission.help.ask')}</p>
      <h2>{t('decision.permissions.handoffs')}</h2>
      {props.handoffs.length === 0
        ? <p className="decision-permissions-empty">{t('decision.permissions.handoffs.empty')}</p>
        : <ul className="decision-handoff-list">{props.handoffs.map(h => <li key={h.fileName}>
            <span>{h.roleName}</span><small>{h.fileName}</small>
            {props.onAcceptHandoff && h.known && <button className="decision-handoff-accept" onClick={() => props.onAcceptHandoff!(h)}>{t('decision.permissions.handoffs.accept')}</button>}
          </li>)}</ul>}
    </section>}
  </div>;
}
