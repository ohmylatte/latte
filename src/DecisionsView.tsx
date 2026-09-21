import { translate as t } from './i18n';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { KnowledgeOrigin } from './KnowledgeScope';
import type {
  AgentRole, CoordinationAuthorityMode, CoordinationBudgetView, CoordinationDegradedReason,
  CoordinationMemberSupport, CoordinationRunView, Decision, DecisionAuthorityMode, HandoffRequest, TeamMember, Work, WorkPermissionMode,
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
  coordinationBudget?: CoordinationBudgetView;
  /**
   * Escribe el tope de despachos de ESTE Trabajo (`setCoordinationBudget`).
   * `undefined` deja la sección de sólo lectura, como estaba.
   *
   * Sin esto, `setCoordinationBudget` existía en la IPC y no tenía un solo
   * llamador en el renderer — y el copy del estado `invalid` prometía "hasta
   * que lo escribas de nuevo, cada despacho se deniega" sin ningún lugar
   * donde escribirlo. La persona quedaba encerrada, con cada despacho
   * denegado, leyendo una instrucción imposible de cumplir.
   */
  onSetCoordinationBudget?: (maxDispatches: number) => void;
  coordinatorGrant?: string | null;
  /**
   * El run de coordinación de este Trabajo, o `null` cuando no hay ninguno.
   * `undefined` es un llamador sin cablear y deja la pantalla exactamente como
   * estaba, igual que el resto de las props aditivas de acá.
   *
   * Sin esto, Decisiones —la pantalla donde la persona aprueba y rechaza— no
   * tenía forma de saber si el equipo seguía vivo: un run TERMINADO se dibujaba
   * idéntico a uno trabajando, con sus tarjetas de gate y sus botones sobre
   * algo que el motor no va a ejecutar nunca más. El backend ya devuelve gates
   * vacíos para un run no activo, pero la interfaz NO depende de eso: `active`
   * se lee acá, explícito, para que la promesa "un run terminado no puede
   * parecer vivo" sea una propiedad de esta pantalla y no una consecuencia de
   * otra capa.
   */
  coordinationRun?: CoordinationRunView | null;
  /**
   * Acepta un handoff como TAREA de la coordinación (`acceptHandoffAsTask`).
   * `undefined` deja la lista de sólo lectura, como estaba. Sin esto la función
   * existía cableada en cinco lugares y no había forma humana de dispararla.
   */
  onAcceptHandoff?: (handoff: HandoffRequest) => void;
  /**
   * Additive, optional (autonomous-coordination Phase 7 task 7.9): per-member
   * degraded badges from `coordinationRuntimeSupport`. `undefined` means the
   * caller has not wired support state — the section does not render, same
   * as an empty list (zero rows is never a zero). Coordination and memory
   * are two INDEPENDENT injection policies (task 6.29): a member can carry
   * memory with no coordination, or coordination with no memory — never
   * silent about either.
   */
  coordinationSupport?: readonly CoordinationMemberSupport[];
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

/** Maps a `CoordinationDegradedReason` to the matching `coordination.degraded.*` i18n key suffix — the six sentences slice 7-A already added. */
const DEGRADED_KEY: Record<CoordinationDegradedReason, string> = {
  claude_below_floor: 'claudeBelowFloor',
  codex_run_cap: 'codexRunCap',
  codex_global_cap: 'codexGlobalCap',
  codex_process_ceiling: 'codexProcessCeiling',
  opencode_shared_server: 'opencodeSharedServer',
  engram_not_installed: 'engramMissing',
  runtime_refused_injection: 'runtimeRefused',
  coordination_server_unavailable: 'coordinationServerDown',
};

/** The coordination line: nothing to flag when the member can propose; the reason's own sentence otherwise (it already says "dispatch manual"). */
function describeCoordinationSupport(row: CoordinationMemberSupport): string {
  // Crítico 7c: "sin restricciones" es una afirmación sobre un proceso que
  // está andando. Mientras el runtime no diga qué levantó, lo único que Latte
  // sabe es lo que PIDIÓ, y eso se dice con esas palabras — no como un verde.
  // "Sin confirmar" promete que la confirmación puede llegar. Cuando el
  // runtime no tiene forma de informarla NUNCA (OpenCode: su servidor no
  // expone ningún endpoint que liste servidores MCP), esa frase deja a la
  // persona esperando algo que no va a pasar. Se dice lo que es. Lo que NO
  // cambia en ninguno de los dos casos: sin confirmación no se afirma que
  // anda.
  if (row.canPropose && !row.runtimeConfirmed) {
    return row.runtimeReportsInjection ? t('coordination.support.unconfirmed') : t('coordination.support.notReported');
  }
  if (row.canPropose) return t('coordination.support.available');
  // `reason` is one of the six ceiling/floor causes -- name it honestly. A
  // member that cannot propose with NO reason attached (task 8.1) means the
  // `coordination` feature flag itself is off app-wide: a distinct, real
  // cause, never the same sentence as "no restrictions" (that would be a
  // silent failure -- the member genuinely cannot propose).
  return row.reason
    ? t(`coordination.degraded.${DEGRADED_KEY[row.reason]}` as 'coordination.degraded.claudeBelowFloor')
    : t('coordination.support.disabled');
}

/** The memory line, independent of the coordination line (task 6.29): `engram_not_installed` explains a missing memory server specifically; any other reason falls back to an honest generic sentence rather than reusing a "dispatch manual" sentence under the wrong heading. */
function describeMemorySupport(row: CoordinationMemberSupport): string {
  // Mismo criterio que la línea de coordinación: la confirmación del runtime
  // es UNA sola y viene del mismo reporte, así que una memoria reclamada y no
  // confirmada tampoco se puede anunciar como disponible.
  // Misma distinción que arriba: "sin confirmar" (todavía) contra "este
  // runtime no informa la conexión" (nunca). Ninguna de las dos afirma que la
  // memoria esté andando.
  if (row.memoryInjected && !row.runtimeConfirmed) {
    return row.runtimeReportsInjection ? t('coordination.memory.unconfirmed') : t('coordination.memory.notReported');
  }
  if (row.memoryInjected) return t('coordination.memory.available');
  if (row.reason === 'engram_not_installed') return t('coordination.degraded.engramMissing');
  return t('coordination.memory.unavailable');
}

/**
 * El presupuesto de este Trabajo, con sus TRES estados separados. `invalid`
 * no es `unset`: decir "sin presupuesto configurado" sobre bytes rotos manda
 * a la persona a buscar un campo vacío que en realidad tiene algo adentro,
 * mientras el motor deniega cada despacho contra esos mismos bytes.
 */
function describeWorkBudget(view: CoordinationBudgetView | undefined): string {
  if (view == null || view.state === 'unset') return t('coordination.budget.unset');
  if (view.state === 'invalid') return t('coordination.budget.invalid');
  if (view.budget.maxDispatches == null) return t('coordination.budget.unlimited');
  return t('coordination.budget.limited', { count: view.budget.maxDispatches });
}

/**
 * El editor del tope de este Trabajo, con el MISMO patrón que Ajustes usa para
 * el tope global: un `number`, un botón, y ninguna forma de guardar algo que
 * el validador vaya a rechazar.
 *
 * Se ofrece en los TRES estados a propósito. `unset` es obvio; `set` porque un
 * tope que no se puede cambiar es una trampa, no un ajuste; e `invalid` sobre
 * todo — ése es el estado donde cada despacho ya se está denegando y la
 * pantalla promete que escribirlo de nuevo lo arregla.
 *
 * No hay "sin tope" acá: un presupuesto ilimitado se confirma en la propuesta,
 * con su casilla, y no se cuela por un campo vacío.
 */
function WorkBudgetEditor({ onSave }: { onSave: (maxDispatches: number) => void }) {
  const [draft, setDraft] = useState('');
  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed > 0;
  return <div className="decision-coordination-budget-edit">
    <label className="field-label">{t('coordination.budget.editLabel')}
      <input className="decision-coordination-budget-input" type="number" min={1} value={draft} onChange={(e) => setDraft(e.target.value)} />
    </label>
    <button className="decision-coordination-budget-save" disabled={!valid} onClick={() => { if (valid) { onSave(parsed); setDraft(''); } }}>{t('coordination.budget.save')}</button>
  </div>;
}

/** One row per team member (task 7.9): coordination and memory status, rendered independently — never a single combined verdict. */
function SupportRow({ row, team }: { row: CoordinationMemberSupport; team: readonly TeamMember[] }) {
  const name = team.find((m) => m.id === row.memberId)?.roleName ?? row.memberId;
  return <li className="decision-support-row" data-member-id={row.memberId}>
    <strong>{name}</strong>
    <p className="decision-support-coordination">{describeCoordinationSupport(row)}</p>
    <p className="decision-support-memory">{describeMemorySupport(row)}</p>
  </li>;
}

/**
 * Cómo terminó este equipo, dicho con las cuentas separadas.
 *
 * `done` y `cancelled` son dos finales distintos y no comparten frase: un run
 * cancelado no "terminó", y sus tareas sin empezar no son fracasos de nadie.
 * Las tres cuentas viajan aparte por eso mismo — colapsar `failed` dentro de
 * "sin terminar" borraba la única diferencia que importa.
 */
function FinishedRunBanner({ run }: { run: CoordinationRunView }) {
  const text = run.status === 'cancelled'
    ? t('coordination.run.finished.cancelled', { done: run.tasksDone, failed: run.tasksFailed, pending: run.tasksPending })
    : t('coordination.run.finished.done', { done: run.tasksDone, failed: run.tasksFailed });
  return <p className="decision-coordination-finished" data-run-status={run.status} role="status">{text}</p>;
}

export function DecisionsView(props: DecisionsViewProps) {
  // Un run que cerró no ofrece NADA de un run vivo. `active` se lee explícito
  // (no se deduce de que la lista de gates venga vacía): que el backend ya
  // devuelva cero gates para un run terminado es una segunda defensa, no la
  // razón por la que esto funciona.
  const runFinished = props.coordinationRun != null && !props.coordinationRun.active;
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
    {runFinished && <FinishedRunBanner run={props.coordinationRun!} />}
    {(props.coordinationSupport?.length ?? 0) > 0 && <section className="decision-coordination-support">
      <div className="document-kicker">{t('coordination.teams.kicker')}</div>
      <ul>{props.coordinationSupport!.map((row) => <SupportRow key={row.memberId} row={row} team={props.team} />)}</ul>
    </section>}
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
    {props.work && props.coordinationAuthority !== undefined && <section className="decision-coordination">
      <div className="document-kicker">{t('coordination.settings.kicker')}</div>
      <p className="decision-coordination-authority">{t(`coordination.authority.${props.coordinationAuthority}` as 'coordination.authority.manual')}</p>
      <p className="decision-coordination-budget">
        {describeWorkBudget(props.coordinationBudget)}
      </p>
      {/* Q6: y el presupuesto del RUN EN CURSO, cuando es ilegible. `budgetInvalid`
          lo calculaba el motor y lo publicaba `CoordinationRunView` desde siempre,
          y ninguna pantalla del Trabajo lo renderizaba: el equipo tenía cada
          despacho denegado contra unos bytes rotos y la persona no tenía dónde
          enterarse. Va acá, al lado del editor que es la salida. */}
      {/* O5: SÓLO CON EL EQUIPO EN CURSO, Y CON SU PROPIA FRASE.
          Se mostraba también con el run TERMINADO —donde ya no se deniega ni
          se va a denegar ningún despacho— y reusaba la frase del presupuesto
          del TRABAJO, que habla de otros bytes: `run.budget_json` es la foto
          que se congeló al aprobar, el meta del Trabajo es el default. El
          editor de abajo (`setCoordinationBudget`) escribe los dos —pasa por
          `updateActiveCoordinationRunBudget`, que alcanza al run activo—, y
          por eso la frase puede prometer que se aplica al equipo. */}
      {props.coordinationRun?.active && props.coordinationRun.budgetInvalid
        && <p className="decision-coordination-run-budget-invalid">{t('coordination.budget.runInvalid')}</p>}
      {props.onSetCoordinationBudget && <WorkBudgetEditor onSave={props.onSetCoordinationBudget} />}
      <p className="decision-coordination-grant">
        {props.coordinatorGrant
          ? t('coordination.coordinator.assigned', { name: resolveCoordinatorName(props.coordinatorGrant, props.team) ?? props.coordinatorGrant })
          : t('coordination.coordinator.none')}
      </p>
    </section>}
  </div>;
}
