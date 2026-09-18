import { translate as t } from './i18n';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { KnowledgeOrigin } from './KnowledgeScope';
import type {
  AgentRole, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudget, CoordinationGateAggregate,
  CoordinationGateView, CoordinationProposal, Decision, DecisionAuthorityMode, HandoffRequest, TeamMember, Work, WorkPermissionMode,
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
   * Additive, read-only coordination settings summary (autonomous-coordination,
   * Phase 2). `undefined` means the caller has not wired coordination state yet
   * (that hook-up is `useCoordination`, a later phase) — the section simply
   * does not render, so a Work with no coordination data looks exactly as it
   * did before this change. There is no control here to edit these settings;
   * editing arrives with the coordination gate UI in a later phase.
   */
  coordinationAuthority?: CoordinationAuthorityMode;
  coordinationBudget?: CoordinationBudget | null;
  coordinatorGrant?: string | null;
  /**
   * Additive, optional (autonomous-coordination Phase 7 tasks 7.4-7.6):
   * `undefined` means the caller has not wired gate state yet — the section
   * does not render, same as an empty list. `onResolveGate` mirrors
   * `resolveCoordinationGate(gateId, decision, editedPayload?)`'s own verb
   * exactly: there is no separate "editApprove" decision, an edit is the
   * SAME `'approve'` carrying an edited payload alongside it.
   */
  gates?: readonly CoordinationGateView[];
  onResolveGate?: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void;
  /** A `latte_ask` is a separate surface (Phase 3): its one action is the answer itself, never an edit. */
  openAsks?: readonly CoordinationAskView[];
  onAnswerAsk?: (askId: string, answer: string) => void;
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

/** The aggregate sentence (task 7.6): honest "can't sum this" the moment any input is null, never a fabricated total. */
function describeAggregate(mine: number | null, aggregate: CoordinationGateAggregate): string {
  if (mine == null || aggregate.otherCommittedDispatches == null || aggregate.totalIfApproved == null) {
    return t('coordination.proposal.aggregateUnlimited', { mine: mine ?? '∞', otherRuns: aggregate.otherActiveRuns });
  }
  return t('coordination.proposal.aggregate', { mine, otherRuns: aggregate.otherActiveRuns, otherDispatches: aggregate.otherCommittedDispatches, total: aggregate.totalIfApproved });
}

type ResolveGate = DecisionsViewProps['onResolveGate'];

/** The plan gate (task 7.4): approve/reject only — the engine ignores `editedPrompt` for this kind, so offering an edit here would be a capability that does not work. */
function PlanGateCard({ gate, onResolveGate }: { gate: CoordinationGateView; onResolveGate?: ResolveGate }) {
  return <div className="decision-gate decision-gate-plan" data-gate-kind="plan">
    <h3>{t('coordination.gate.plan.title')}</h3>
    <div className="decision-gate-actions">
      <button className="primary" onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/** The budget-exhausted gate (task 7.4): exactly 2 actions. `approve` resumes the run, `reject` cancels it — the three-action triple is a pattern, not a contract. */
function BudgetGateCard({ gate, onResolveGate }: { gate: CoordinationGateView; onResolveGate?: ResolveGate }) {
  return <div className="decision-gate decision-gate-budget" data-gate-kind="budget">
    <h3>{t('coordination.gate.budget.title')}</h3>
    <p>{t('coordination.gate.budget.body')}</p>
    <div className="decision-gate-actions">
      <button className="primary" onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/** The dispatch gate (task 7.4): the task prompt is genuinely editable, so it gets all 3 actions — `editApprove` mirrors the Decision-domain `window.prompt` pattern verbatim. */
function DispatchGateCard({ gate, onResolveGate }: { gate: CoordinationGateView; onResolveGate?: ResolveGate }) {
  return <div className="decision-gate decision-gate-dispatch" data-gate-kind="dispatch">
    <h3>{t('coordination.gate.dispatch.title')}</h3>
    {gate.prompt && <p className="decision-gate-prompt">{gate.prompt}</p>}
    <div className="decision-gate-actions">
      <button className="primary" onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button onClick={() => { const edited = window.prompt(t('coordination.gate.editApprove'), gate.prompt ?? ''); if (edited?.trim()) onResolveGate?.(gate.id, 'approve', edited.trim()); }}>{t('coordination.gate.editApprove')}</button>
      <button onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/**
 * The proposal gate (task 7.5) — the WOW surface: the plan's tasks, the
 * hires each with its reason, the proposed budget, the rationale and the
 * aggregate. No separate settings form anywhere in this flow: the person
 * reads a plan and says yes. `editApprove` opens an inline edit (drop a
 * hire, lower the dispatch cap — the two concrete edits the design calls
 * out) and approves the EDITED payload through the same
 * `resolveCoordinationGate(id,'approve',edited)` verb every other gate uses.
 * `discard` (`reject`) grants nothing: it is the plain `cancelRun` path,
 * with no edited payload ever attached.
 */
function ProposalGateCard({ gate, roles, team, onResolveGate }: {
  gate: CoordinationGateView; roles: readonly AgentRole[]; team: readonly TeamMember[]; onResolveGate?: ResolveGate;
}) {
  const proposal: CoordinationProposal | null = gate.proposalJson ? (JSON.parse(gate.proposalJson) as CoordinationProposal) : null;
  const [editing, setEditing] = useState(false);
  const [dispatches, setDispatches] = useState(proposal?.estimatedDispatches != null ? String(proposal.estimatedDispatches) : '');
  const [included, setIncluded] = useState<boolean[]>((proposal?.membersToHire ?? []).map(() => true));
  if (!proposal) return null;
  const hires = proposal.membersToHire ?? [];

  const confirmEdit = () => {
    const edited: CoordinationProposal = {
      ...proposal,
      estimatedDispatches: dispatches.trim() === '' ? null : Number(dispatches),
      membersToHire: hires.filter((_, i) => included[i]),
    };
    onResolveGate?.(gate.id, 'approve', JSON.stringify(edited));
    setEditing(false);
  };

  return <div className="decision-gate decision-gate-proposal" data-gate-kind="proposal">
    <div className="document-kicker">{t('coordination.proposal.kicker')}</div>
    <h3>{t('coordination.proposal.plan')}</h3>
    <ul className="decision-gate-plan-list">
      {proposal.plan.map((task, i) => <li key={i}><strong>{resolveRoleName(task.roleId, roles, team)}</strong><span>{task.spec}</span></li>)}
    </ul>
    {hires.length > 0 && <>
      <h3>{t('coordination.proposal.hires')}</h3>
      <ul className="decision-gate-hire-list">
        {hires.map((hire, i) => <li key={i}><strong>{resolveRoleName(hire.roleId, roles, team)}</strong><span>{t('coordination.proposal.hireReason', { reason: hire.why })}</span></li>)}
      </ul>
    </>}
    <h3>{t('coordination.proposal.budget')}</h3>
    <p>{proposal.estimatedDispatches == null
      ? (proposal.unlimitedConfirmedAt ? t('coordination.budget.unlimited') : t('coordination.budget.unset'))
      : t('coordination.budget.limited', { count: proposal.estimatedDispatches })}</p>
    <h3>{t('coordination.proposal.rationale')}</h3>
    <p>{proposal.rationale}</p>
    {gate.aggregate && <p className="decision-gate-aggregate">{describeAggregate(proposal.estimatedDispatches, gate.aggregate)}</p>}
    <p className="decision-gate-note">{t('coordination.proposal.noSettingsNote')}</p>
    {editing && <div className="decision-gate-edit">
      <label className="field-label">{t('coordination.proposal.editDispatches')}</label>
      <input type="number" value={dispatches} onChange={(e) => setDispatches(e.target.value)} />
      {hires.length > 0 && <>
        <p className="field-label">{t('coordination.proposal.editHires')}</p>
        {hires.map((hire, i) => <label key={i} className="decision-gate-edit-hire">
          <input type="checkbox" checked={included[i] ?? false} onChange={() => setIncluded((prev) => prev.map((v, idx) => idx === i ? !v : v))} />
          <span>{resolveRoleName(hire.roleId, roles, team)}</span>
        </label>)}
      </>}
      <div className="decision-gate-edit-actions">
        <button className="primary" onClick={confirmEdit}>{t('coordination.proposal.editConfirm')}</button>
        <button onClick={() => setEditing(false)}>{t('coordination.proposal.editCancel')}</button>
      </div>
    </div>}
    <div className="decision-gate-actions">
      <button className="primary" onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button onClick={() => setEditing(true)}>{t('coordination.gate.editApprove')}</button>
      <button onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/** An open `latte_ask` (Phase 3): its one action is the answer itself, never an edit — a different surface from the approve/reject gates above. */
function AskCard({ ask, formatDate, onAnswerAsk }: { ask: CoordinationAskView; formatDate: (value: string) => string; onAnswerAsk?: DecisionsViewProps['onAnswerAsk'] }) {
  return <div className="decision-ask">
    <h3>{t('coordination.ask.title')}</h3>
    <p>{ask.question}</p>
    <small>{t('coordination.ask.deadline', { date: formatDate(ask.deadlineAt) })}</small>
    <div className="decision-gate-actions">
      <button className="primary" onClick={() => { const answer = window.prompt(t('coordination.ask.placeholder'), ''); if (answer?.trim()) onAnswerAsk?.(ask.id, answer.trim()); }}>{t('coordination.ask.answer')}</button>
    </div>
  </div>;
}

export function DecisionsView(props: DecisionsViewProps) {
  return <div className="document-scroll">
    <div className="document-kicker">CRITERIO QUE PERMANECE</div>
    <h1>No empezar<br />de cero otra vez.</h1>
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
        <textarea aria-label={t('ui.auto.054')} placeholder="Elegimos? porque?" value={props.draft} onChange={e => props.onDraftChange(e.target.value)} />
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
    {((props.gates?.length ?? 0) > 0 || (props.openAsks?.length ?? 0) > 0) && <section className="decision-gates">
      {props.gates?.map((gate) => {
        if (gate.kind === 'proposal') return <ProposalGateCard key={gate.id} gate={gate} roles={props.roles} team={props.team} onResolveGate={props.onResolveGate} />;
        if (gate.kind === 'dispatch') return <DispatchGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} />;
        if (gate.kind === 'budget') return <BudgetGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} />;
        return <PlanGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} />;
      })}
      {props.openAsks?.map((ask) => <AskCard key={ask.id} ask={ask} formatDate={props.formatDate} onAnswerAsk={props.onAnswerAsk} />)}
    </section>}
    {props.work && <section className="decision-permissions">
      <div className="document-kicker">{t('decision.permissions.kicker')}</div>
      <p className="decision-permissions-lead">{t('decision.permissions.lead')}</p>
      <p className="decision-permission-mode">{t(`permission.mode.${props.permissions}` as 'permission.mode.ask')}</p>
      <p className="decision-permission-help">{t(`permission.help.${props.permissions}` as 'permission.help.ask')}</p>
      <h2>{t('decision.permissions.handoffs')}</h2>
      {props.handoffs.length === 0
        ? <p className="decision-permissions-empty">{t('decision.permissions.handoffs.empty')}</p>
        : <ul className="decision-handoff-list">{props.handoffs.map(h => <li key={h.fileName}><span>{h.roleName}</span><small>{h.fileName}</small></li>)}</ul>}
    </section>}
    {props.work && props.coordinationAuthority !== undefined && <section className="decision-coordination">
      <div className="document-kicker">{t('coordination.settings.kicker')}</div>
      <p className="decision-coordination-authority">{t(`coordination.authority.${props.coordinationAuthority}` as 'coordination.authority.manual')}</p>
      <p className="decision-coordination-budget">
        {props.coordinationBudget == null
          ? t('coordination.budget.unset')
          : props.coordinationBudget.maxDispatches == null
            ? t('coordination.budget.unlimited')
            : t('coordination.budget.limited', { count: props.coordinationBudget.maxDispatches })}
      </p>
      <p className="decision-coordination-grant">
        {props.coordinatorGrant
          ? t('coordination.coordinator.assigned', { name: resolveCoordinatorName(props.coordinatorGrant, props.team) ?? props.coordinatorGrant })
          : t('coordination.coordinator.none')}
      </p>
    </section>}
  </div>;
}
