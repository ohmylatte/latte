import { translate as t } from './i18n';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { KnowledgeOrigin } from './KnowledgeScope';
import type {
  AgentRole, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudgetView, CoordinationDegradedReason, CoordinationGateAggregate,
  CoordinationGateView, CoordinationMemberSupport, CoordinationProposal, CoordinationRunView, Decision, DecisionAuthorityMode, HandoffRequest, TeamMember, Work, WorkPermissionMode,
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
   * Additive, optional (autonomous-coordination Phase 7 tasks 7.4-7.6):
   * `undefined` means the caller has not wired gate state yet — the section
   * does not render, same as an empty list. `onResolveGate` mirrors
   * `resolveCoordinationGate(gateId, decision, editedPayload?)`'s own verb
   * exactly: there is no separate "editApprove" decision, an edit is the
   * SAME `'approve'` carrying an edited payload alongside it.
   */
  gates?: readonly CoordinationGateView[];
  /**
   * O1: puede devolver si el motor ACEPTÓ. `void` (un llamador sin cablear, o
   * uno viejo) se lee como "no sé", que es el comportamiento de antes; una
   * promesa que resuelve `false` —o que rechaza— es un rechazo del backend, y
   * el editor de la propuesta NO se cierra sobre un rechazo.
   */
  onResolveGate?: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void | boolean | Promise<boolean | void>;
  /**
   * Acepta un handoff como TAREA de la coordinación (`acceptHandoffAsTask`).
   * `undefined` deja la lista de sólo lectura, como estaba. Sin esto la función
   * existía cableada en cinco lugares y no había forma humana de dispararla.
   */
  onAcceptHandoff?: (handoff: HandoffRequest) => void;
  /** A `latte_ask` is a separate surface (Phase 3): its one action is the answer itself, never an edit. */
  openAsks?: readonly CoordinationAskView[];
  onAnswerAsk?: (askId: string, answer: string) => void;
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
  /**
   * Additive, optional (juicio ronda 4, ítem 14): `useCoordination`'s
   * per-action in-flight flags, keyed `gate:<gateId>` / `ask:<askId>`.
   * `undefined` (an unwired caller) disables nothing — the same safe default
   * every other additive coordination prop here follows. Wired, it disables
   * the action buttons of the gate/ask that IS mutating right now, so a
   * double click cannot fire the same mutation twice (a double click on a
   * proposal gate ran `hub.addMember` — the hiring loop — twice).
   */
  pending?: Record<string, boolean>;
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
 * Q4: DESTILDAR UNA CONTRATACIÓN RECORTA EL PLAN, A LA VISTA.
 *
 * `confirmEdit` filtraba `membersToHire` y mandaba `proposal.plan` intacto. Las
 * tareas de ese rol quedaban en el plan aprobado, nacían `ready`, el primer
 * despacho moría con `ROLE_NOT_APPROVED`, la tarea quedaba `failed` y
 * `recomputeReadiness` derribaba a todas las que dependían de ella: la persona
 * destildaba UNA contratación y se le caía media planificación, sin que nada se
 * lo dijera.
 *
 * Acá se calcula lo que el motor va a poder cumplir: una tarea cuyo rol no se
 * contrata NI está ya en el equipo se cae, y con ella todo lo que dependía de
 * ella, transitivamente. Los índices de `dependsOn` se remapean al plan nuevo,
 * porque son posiciones en ESTE array y correrlos sin remapear apuntaría a otra
 * tarea.
 */
export function trimPlanWithoutRoles(
  plan: readonly { roleId: string; spec: string; dependsOn?: number[] }[],
  removedRoleIds: ReadonlySet<string>,
): { plan: { roleId: string; spec: string; dependsOn?: number[] }[]; removed: number; dropped: boolean[] } {
  // Sólo lo que la persona SACÓ, nunca lo que la propuesta ya traía. Recortar
  // por "qué roles quedan disponibles" haría que una propuesta que nadie editó
  // —cuyos roles el motor igual va a juzgar— apareciera recortada sola: la
  // pantalla estaría decidiendo por su cuenta sobre algo que la persona no tocó.
  const dropped = plan.map((item) => removedRoleIds.has(item.roleId));
  // Punto fijo: una tarea que depende de una caída también se cae, y eso puede
  // arrastrar a la que dependía de ella. Se repite hasta que nada más cambia.
  for (let pass = 0; pass < plan.length; pass += 1) {
    let changed = false;
    plan.forEach((item, i) => {
      if (dropped[i]) return;
      // Q6: un índice FUERA DE RANGO se cae, y se dice con todas las letras.
      // Antes esto se apoyaba en que `dropped[idx]` diera `undefined` y
      // `undefined !== false` fuera verdadero: la regla correcta escrita como un
      // accidente del lenguaje, que el primer `?? false` de alguien rompía sin
      // que ningún test se enterara.
      if ((item.dependsOn ?? []).some((idx) => idx < 0 || idx >= plan.length || dropped[idx]!)) { dropped[i] = true; changed = true; }
    });
    if (!changed) break;
  }
  const remap = new Map<number, number>();
  plan.forEach((_, i) => { if (!dropped[i]) remap.set(i, remap.size); });
  const kept = plan.flatMap((item, i) => {
    if (dropped[i]) return [];
    const deps = (item.dependsOn ?? []).map((idx) => remap.get(idx)).filter((idx): idx is number => idx !== undefined);
    return [item.dependsOn === undefined ? { ...item } : { ...item, dependsOn: deps }];
  });
  return { plan: kept, removed: plan.length - kept.length, dropped };
}

/** The aggregate sentence (task 7.6): honest "can't sum this" the moment any input is null, never a fabricated total. */
function describeAggregate(mine: number | null, aggregate: CoordinationGateAggregate): string {
  if (mine == null || aggregate.otherCommittedDispatches == null || aggregate.totalIfApproved == null) {
    return t('coordination.proposal.aggregateUnlimited', { mine: mine ?? '∞', otherRuns: aggregate.otherActiveRuns });
  }
  return t('coordination.proposal.aggregate', { mine, otherRuns: aggregate.otherActiveRuns, otherDispatches: aggregate.otherCommittedDispatches, total: aggregate.totalIfApproved });
}

type ResolveGate = DecisionsViewProps['onResolveGate'];
type Pending = DecisionsViewProps['pending'];

/** The plan gate (task 7.4): approve/reject only — the engine ignores `editedPrompt` for this kind, so offering an edit here would be a capability that does not work. */
function PlanGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="decision-gate decision-gate-plan" data-gate-kind="plan">
    <h3>{t('coordination.gate.plan.title')}</h3>
    <div className="decision-gate-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/** The budget-exhausted gate (task 7.4): exactly 2 actions. `approve` resumes the run, `reject` cancels it — the three-action triple is a pattern, not a contract. */
function BudgetGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="decision-gate decision-gate-budget" data-gate-kind="budget">
    <h3>{t('coordination.gate.budget.title')}</h3>
    <p>{t('coordination.gate.budget.body')}</p>
    <div className="decision-gate-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

/** The dispatch gate (task 7.4): the task prompt is genuinely editable, so it gets all 3 actions — `editApprove` mirrors the Decision-domain `window.prompt` pattern verbatim. */
function DispatchGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="decision-gate decision-gate-dispatch" data-gate-kind="dispatch">
    <h3>{t('coordination.gate.dispatch.title')}</h3>
    {gate.prompt && <p className="decision-gate-prompt">{gate.prompt}</p>}
    <div className="decision-gate-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate?.(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => { const edited = window.prompt(t('coordination.gate.editApprove'), gate.prompt ?? ''); if (edited?.trim()) onResolveGate?.(gate.id, 'approve', edited.trim()); }}>{t('coordination.gate.editApprove')}</button>
      <button disabled={busy} onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
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
/**
 * Una propuesta que no se puede leer, leída sin tirar.
 *
 * `JSON.parse` a pelo hacía que un `proposalJson` roto tumbara el render de
 * TODA la pantalla de Decisiones, y un JSON válido pero sin `plan` llegaba
 * hasta `proposal.plan.map` sobre `undefined`. Las dos cosas son el mismo
 * hecho para la persona: la propuesta llegó rota. Se dice, no se finge un plan
 * vacío — un plan vacío es una propuesta que no pide nada, que es otra cosa.
 */
function readProposal(raw: string | null | undefined): CoordinationProposal | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<CoordinationProposal>;
  if (!Array.isArray(candidate.plan)) return null;
  // Y CADA CAMPO QUE ESTA TARJETA RENDERIZA, con su tipo (F4). Bastaba un
  // `spec` u objeto `rationale` —que el motor dejaba entrar por MCP sin
  // validar— para que React tirara "Objects are not valid as a React child".
  // No hay ErrorBoundary: eso no rompía una tarjeta, dejaba la app en blanco.
  // Un tipo que no se puede mostrar es exactamente lo mismo que un JSON roto:
  // la propuesta llegó ilegible, y se dice.
  if (typeof candidate.rationale !== 'string') return null;
  if (candidate.estimatedDispatches != null && typeof candidate.estimatedDispatches !== 'number') return null;
  for (const task of candidate.plan) {
    if (typeof task !== 'object' || task === null) return null;
    if (typeof task.roleId !== 'string' || typeof task.spec !== 'string') return null;
  }
  const hires = candidate.membersToHire;
  if (hires != null) {
    if (!Array.isArray(hires)) return null;
    for (const hire of hires) {
      if (typeof hire !== 'object' || hire === null) return null;
      if (typeof hire.roleId !== 'string' || typeof hire.why !== 'string') return null;
    }
  }
  return candidate as CoordinationProposal;
}

/**
 * Una huella estable del contenido de la propuesta, para la `key` de su
 * tarjeta. No es criptografía ni pretende serlo: lo único que tiene que
 * cumplir es que dos propuestas distintas den huellas distintas con
 * probabilidad abrumadora, y que la MISMA propuesta dé siempre la misma —
 * porque si cambiara sola, cada render tiraría la edición en curso.
 */
function proposalVersion(raw: string | null | undefined): string {
  if (!raw) return 'none';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${raw.length}-${(hash >>> 0).toString(36)}`;
}

/** La propuesta ilegible: se nombra el hecho y queda UNA sola acción — descartarla. Aprobar algo que no se puede leer no es aprobar nada. */
function UnreadableProposalCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="decision-gate decision-gate-proposal" data-gate-kind="proposal">
    <div className="document-kicker">{t('coordination.proposal.kicker')}</div>
    <p className="decision-gate-unreadable">{t('coordination.proposal.unreadable')}</p>
    <div className="decision-gate-actions">
      <button disabled={busy} onClick={() => onResolveGate?.(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>
  </div>;
}

function ProposalGateCard({ gate, roles, team, onResolveGate, pending }: {
  gate: CoordinationGateView; roles: readonly AgentRole[]; team: readonly TeamMember[]; onResolveGate?: ResolveGate; pending?: Pending;
}) {
  const proposal = readProposal(gate.proposalJson);
  if (!proposal) return <UnreadableProposalCard gate={gate} onResolveGate={onResolveGate} pending={pending} />;
  return <ReadableProposalGateCard gate={gate} proposal={proposal} roles={roles} team={team} onResolveGate={onResolveGate} pending={pending} />;
}

function ReadableProposalGateCard({ gate, proposal, roles, team, onResolveGate, pending }: {
  gate: CoordinationGateView; proposal: CoordinationProposal; roles: readonly AgentRole[]; team: readonly TeamMember[]; onResolveGate?: ResolveGate; pending?: Pending;
}) {
  // Los valores iniciales del formulario, derivados de la PROPUESTA — nunca al
  // revés. `editCancel` vuelve a estos mismos valores: abrir la edición y
  // cancelar tiene que dejar el formulario exactamente como lo encontró.
  const initialDispatches = () => proposal?.estimatedDispatches != null ? String(proposal.estimatedDispatches) : '';
  const initialIncluded = () => (proposal?.membersToHire ?? []).map(() => true);
  const [editing, setEditing] = useState(false);
  const [dispatches, setDispatches] = useState(initialDispatches);
  const [included, setIncluded] = useState<boolean[]>(initialIncluded);
  const [unlimitedConfirmed, setUnlimitedConfirmed] = useState(false);
  const hires = proposal.membersToHire ?? [];
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  // N8: LAS RAMAS DE "ILIMITADO" DE LA PROPUESTA GUARDADA NO EXISTEN MÁS.
  //
  // Acá vivía `needsUnlimitedConfirmation = estimatedDispatches == null &&
  // unlimitedConfirmedAt == null`, y más abajo la tarjeta elegía entre
  // "ilimitado" y "sin tope" según `proposal.unlimitedConfirmedAt`. Las dos
  // ramas eran inalcanzables: `requestCoordination` valida
  // `estimatedDispatches` con `requireInt(…, 1, …)` y guarda
  // `unlimitedConfirmedAt: null` a la fuerza, así que una propuesta GUARDADA
  // siempre tiene un entero y nunca una confirmación. Código muerto que
  // describía un estado imposible, y que había que leer cada vez para
  // convencerse de que no pasaba nada raro.
  //
  // Lo que SÍ existe y sigue acá es la casilla del EDITOR: la persona borra el
  // número y confirma el ilimitado ella misma. Ése es el único camino, y
  // `formPristine` lo cuenta como formulario modificado.

  // Q6: QUIÉN CUBRE CADA ROL LO DICE EL MOTOR, no esta pantalla.
  //
  // Acá se recalculaba el equipo desde `team` —la foto del renderer— para
  // decidir qué se recortaba. El motor decide lo mismo con su propia cuenta un
  // milisegundo después, y cuando las dos no coinciden el "Aprobar" rebota con
  // un error que la pantalla no supo anticipar. Ahora llega calculado en el
  // gate. Sin el campo (un gate de antes de este cambio) se deriva de la
  // propuesta misma, que es lo único que hay: con alta, `hire`; sin alta, se
  // asume que el rol ya está cubierto, que es lo que esta pantalla suponía.
  const coverage = new Map<string, 'hire' | 'member' | 'orphan'>(
    gate.roleCoverage
      ? gate.roleCoverage.map((entry) => [entry.roleId, entry.coverage])
      : proposal.plan.map((task) => [task.roleId, hires.some((h) => h.roleId === task.roleId) ? 'hire' : 'member']),
  );
  const keptHires = hires.filter((_, i) => included[i]);
  const keptRoleIds = new Set(keptHires.map((hire) => hire.roleId));
  // Un rol que YA está en el equipo no se contrata, se reutiliza, así que
  // destildar su alta no le quita a nadie el trabajo.
  const untickedRoleIds = hires
    .filter((hire, i) => !included[i] && !keptRoleIds.has(hire.roleId) && coverage.get(hire.roleId) !== 'member')
    .map((hire) => hire.roleId);
  // Y los HUÉRFANOS: roles que el plan nombra y que nadie cubre. `requestCoordination`
  // ya no deja entrar ninguno, pero una base vieja puede tener uno guardado, y el
  // equipo pudo cambiar entre la propuesta y la aprobación. Se van solos: dejarlos
  // no ofrecía ninguna acción que funcionara, sólo "Rechazar".
  const orphanRoleIds = new Set([...coverage].filter(([, c]) => c === 'orphan').map(([roleId]) => roleId));
  const removedRoleIds = new Set([...orphanRoleIds, ...untickedRoleIds]);
  const trimmed = trimPlanWithoutRoles(proposal.plan, removedRoleIds);
  // Cuánto de lo que se cae es culpa de los huérfanos: su propia frase, porque
  // no es lo mismo "esto se va porque lo sacaste" que "esto no lo puede hacer nadie".
  const orphanDropped = orphanRoleIds.size > 0 ? trimPlanWithoutRoles(proposal.plan, orphanRoleIds).removed : 0;

  // Q6/P8: un alta que la persona mantiene tildada pero cuyas tareas se cayeron
  // TODAS por arrastre se contrataba igual: un proceso levantado, un cupo de
  // techo ocupado y un miembro sin una sola tarea que hacer. Un alta que NUNCA
  // tuvo tareas en el plan se respeta —por API puede ser deliberada—; la que se
  // quedó sin ellas acá, no.
  const rolesInTrimmedPlan = new Set(trimmed.plan.map((task) => task.roleId));
  const rolesInOriginalPlan = new Set(proposal.plan.map((task) => task.roleId));
  const survives = (hire: { roleId: string }) => !rolesInOriginalPlan.has(hire.roleId) || rolesInTrimmedPlan.has(hire.roleId);
  // N7: por ÍNDICE, no por referencia. La lista de abajo preguntaba
  // `hiresToSend.includes(hire)`, y con dos altas idénticas del mismo rol el
  // `includes` no puede distinguirlas.
  const hiresToSendIndexes = new Set(hires.map((hire, i) => (included[i] && survives(hire) ? i : -1)).filter((i) => i >= 0));
  const hiresToSend = hires.filter((_, i) => hiresToSendIndexes.has(i));
  const hiresWithoutTasks = keptHires.length - hiresToSend.length;

  /**
   * O1: EL EDITOR CIERRA CUANDO EL MOTOR ACEPTA, NO CUANDO SE APRIETA EL BOTÓN.
   *
   * `setEditing(false)` corría incondicionalmente, en el mismo tick del clic.
   * Si el backend rechazaba —`DEPTH_CAP` (que el validador no medía),
   * `PROPOSAL_STALE`, `COORDINATION_BUDGET_INVALID`, un `addMember` caído— el
   * gate seguía en pantalla con el editor cerrado, las casillas destildadas
   * perdidas y el "Aprobar" simple de vuelta: un clic más mandaba
   * `onResolveGate(id,'approve')` SIN payload, o sea el `planJson` guardado
   * ENTERO, con todas las altas que la persona acababa de rechazar.
   *
   * Ahora el editor queda abierto con su estado intacto y el error se ve por
   * el canal de error de la app, que es donde se ven todos.
   */
  const confirmEdit = async () => {
    // N10: sin handler no hay a quién mandarle esto. `accepted` quedaba
    // `undefined` —que no es `false`— y el editor cerraba como si el motor
    // hubiera aceptado. Los botones ya no se renderizan sin handler; esta
    // guarda es la del camino programático.
    if (!onResolveGate) return;
    const edited: CoordinationProposal = {
      ...proposal,
      // Q4: el plan RECORTADO. Mandarlo entero dejaba tareas de un rol que la
      // persona acababa de rechazar, y el motor las mataba una por una al
      // despacharlas, arrastrando a sus dependientes.
      plan: trimmed.plan,
      estimatedDispatches: dispatches.trim() === '' ? null : Number(dispatches),
      membersToHire: hiresToSend,
      // La ÚNICA fuente de un presupuesto ilimitado: esta casilla, acá, ahora.
      unlimitedConfirmedAt: dispatches.trim() === '' && unlimitedConfirmed ? new Date().toISOString() : null,
    };
    let accepted: boolean | void;
    try {
      accepted = await onResolveGate(gate.id, 'approve', JSON.stringify(edited));
    } catch {
      return; // el motor rechazó y ya lo reportó: el editor se queda como está
    }
    if (accepted === false) return;
    setEditing(false);
  };

  // Con huérfanos en el plan, el "Aprobar" simple NO puede mandar la propuesta
  // guardada: el motor la rechazaría con `PLAN_HAS_UNAPPROVED_ROLES` y la
  // persona se quedaría otra vez sin salida. Manda lo mismo que la edición:
  // el plan que sí se puede cumplir.
  const approvePlain = () => { if (orphanRoleIds.size > 0) void confirmEdit(); else onResolveGate?.(gate.id, 'approve'); };

  /**
   * O1: EL FORMULARIO ESTÁ COMO NACIÓ.
   *
   * El "Aprobar" simple manda la propuesta GUARDADA, sin payload. Eso sólo es
   * lo mismo que lee la persona mientras no haya tocado nada: todas las altas
   * tildadas y el tope de despachos sin cambiar (lo único que se recorta solo
   * son los huérfanos, que `approvePlain` ya manda por el camino del payload
   * derivado). En cualquier otro estado ese botón mandaría algo distinto de lo
   * que la pantalla muestra, así que no existe: el único camino es "Confirmar
   * edición y aprobar".
   *
   * N8: y la casilla de ilimitado cuenta. Tildarla NO cambia `dispatches` ni
   * `included`, así que un formulario con el número borrado y el ilimitado
   * confirmado se leía "intacto" y el "Aprobar" simple seguía ahí, listo para
   * mandar la propuesta guardada en lugar de lo que la pantalla muestra.
   */
  const formPristine = included.every(Boolean) && dispatches === initialDispatches() && !unlimitedConfirmed;

  const editCancel = () => {
    // Sin esto, cancelar no reseteaba nada: el formulario quedaba con
    // ediciones a medio hacer que ni se aprobaron ni se descartaron.
    setDispatches(initialDispatches());
    setIncluded(initialIncluded());
    setUnlimitedConfirmed(false);
    setEditing(false);
  };

  return <div className="decision-gate decision-gate-proposal" data-gate-kind="proposal">
    <div className="document-kicker">{t('coordination.proposal.kicker')}</div>
    <h3>{t('coordination.proposal.plan')}</h3>
    {/* Q6/P7: LO QUE SE APRUEBA, no lo que se propuso. La lista mostraba el plan
        entero justo debajo del contador que decía "se quitan N tareas", así que
        la persona confirmaba leyendo tareas que ya no iban a existir. El plan
        que viaja y el plan que se lee son el mismo. */}
    <ul className="decision-gate-plan-list">
      {proposal.plan.map((task, i) => trimmed.dropped[i] ? null
        : <li key={i}><strong>{resolveRoleName(task.roleId, roles, team)}</strong><span>{task.spec}</span></li>)}
    </ul>
    {trimmed.removed > 0 && <>
      <h3 className="decision-gate-plan-dropped-title">{t('coordination.proposal.droppedTitle')}</h3>
      <ul className="decision-gate-plan-dropped-list">
        {proposal.plan.map((task, i) => trimmed.dropped[i]
          ? <li key={i}><s><strong>{resolveRoleName(task.roleId, roles, team)}</strong><span>{task.spec}</span></s></li>
          : null)}
      </ul>
    </>}
    {orphanDropped > 0 && <p className="decision-gate-orphan-note">{t('coordination.proposal.orphanRolesDropped', { count: orphanDropped })}</p>}
    {hires.length > 0 && <>
      <h3>{t('coordination.proposal.hires')}</h3>
      {/* O3: EL ALTA QUE NO SE VA A CONTRATAR SE VE TACHADA.
          `hiresToSend` ya filtraba las que se quedaron sin una sola tarea, pero
          esta lista las seguía mostrando iguales a las demás: por el camino
          "Aprobar" simple, sin abrir la edición, la persona leía un alta que el
          payload no iba a llevar. Se tacha y se dice por qué, con la misma
          forma que la lista de tareas quitadas. */}
      {/* N7: Y EL MOTIVO DEL TACHADO ES EL VERDADERO.
          Toda alta fuera de `hiresToSend` leía "No se contrata: se quedó sin
          tareas", incluidas las que la persona acababa de DESTILDAR: se le
          atribuía a una consecuencia del plan lo que fue una decisión suya. El
          tachado y esa frase quedan SÓLO para el alta que la persona mantuvo
          tildada y que se cayó por arrastre. La destildada se marca como lo
          que es —la sacó ella— y sin tachado: la casilla ya lo dice.

          Y la comparación es por ÍNDICE. `hiresToSend.includes(hire)` decidía
          por referencia, así que dos altas idénticas del mismo rol se leían
          como una sola. */}
      <ul className="decision-gate-hire-list">
        {hires.map((hire, i) => {
          const name = resolveRoleName(hire.roleId, roles, team);
          const reason = <span>{t('coordination.proposal.hireReason', { reason: hire.why })}</span>;
          if (!included[i]) {
            return <li key={i} className="decision-gate-hire-unticked">
              <strong>{name}</strong>{reason}
              <small>{t('coordination.proposal.hireUntickedLabel')}</small>
            </li>;
          }
          if (hiresToSendIndexes.has(i)) return <li key={i}><strong>{name}</strong>{reason}</li>;
          return <li key={i} className="decision-gate-hire-dropped">
            <s><strong>{name}</strong>{reason}</s>
            <small>{t('coordination.proposal.hireDroppedLabel')}</small>
          </li>;
        })}
      </ul>
    </>}
    {/* O3: Y LOS AVISOS VIVEN FUERA DE LA EDICIÓN, como ya vivía la lista de
        tareas quitadas. Estaban adentro de `{editing && ...}`, así que por el
        camino de "Aprobar" simple —un plan con un huérfano que arrastra la
        única tarea de un alta— se recortaba el plan Y se caía un alta sin que
        nada se dijera. El aviso de tareas sólo habla de lo que la persona
        SACÓ: lo que se va por huérfanos ya tiene su propia frase arriba. */}
    {trimmed.removed > orphanDropped && <p className="decision-gate-edit-dropped">{t('coordination.proposal.editDropsTasks', { count: trimmed.removed - orphanDropped })}</p>}
    {hiresWithoutTasks > 0 && <p className="decision-gate-edit-dropped decision-gate-edit-hire-dropped">{t('coordination.proposal.editDropsHires', { count: hiresWithoutTasks })}</p>}
    {/* O12: el plan 100 % huérfano. Sin esto los dos botones primarios quedaban
        grises y no había una sola palabra afuera de la edición que dijera por
        qué: "Editar y aprobar" tampoco servía, porque no queda nada que
        aprobar. La única salida real se nombra. */}
    {orphanDropped === proposal.plan.length && <p className="decision-gate-edit-dropped decision-gate-empty-plan">{t('coordination.proposal.nobodyCanDoIt')}</p>}
    <h3>{t('coordination.proposal.budget')}</h3>
    {/* N8: sin la rama de `unlimitedConfirmedAt`, que una propuesta guardada no
        puede tener (`requestCoordination` la fuerza a `null`). Queda el tope, y
        el `null` —que el tipo permite y el motor no produce— se dice como lo
        que sería: un tope que nadie escribió. Nunca "ilimitado". */}
    <p>{proposal.estimatedDispatches == null
      ? t('coordination.budget.unset')
      : t('coordination.budget.limited', { count: proposal.estimatedDispatches })}</p>
    <h3>{t('coordination.proposal.rationale')}</h3>
    <p>{proposal.rationale}</p>
    {gate.aggregate && <p className="decision-gate-aggregate">{describeAggregate(proposal.estimatedDispatches, gate.aggregate)}</p>}
    <p className="decision-gate-note">{t('coordination.proposal.noSettingsNote')}</p>
    {editing && <div className="decision-gate-edit">
      <label className="field-label">{t('coordination.proposal.editDispatches')}</label>
      {/* Tocar el campo INVALIDA la confirmación de ilimitado. Sin esto,
          tildar la casilla, escribir un tope y volver a borrarlo dejaba viva
          una confirmación que la persona dio sobre otro estado del campo: el
          único consentimiento que vale es el que se da sobre lo que hay
          ahora. */}
      <input type="number" value={dispatches} onChange={(e) => { setDispatches(e.target.value); setUnlimitedConfirmed(false); }} />
      {dispatches.trim() === '' && <label className="decision-gate-edit-unlimited">
        <input type="checkbox" checked={unlimitedConfirmed} onChange={() => setUnlimitedConfirmed((v) => !v)} />
        <span>{t('coordination.proposal.unlimitedConfirm')}</span>
      </label>}
      {hires.length > 0 && <>
        <p className="field-label">{t('coordination.proposal.editHires')}</p>
        {hires.map((hire, i) => <label key={i} className="decision-gate-edit-hire">
          <input type="checkbox" checked={included[i] ?? false} onChange={() => setIncluded((prev) => prev.map((v, idx) => idx === i ? !v : v))} />
          <span>{resolveRoleName(hire.roleId, roles, team)}</span>
        </label>)}
      </>}
      {/* Q4/O3: los dos avisos de arriba (tareas y altas que se caen) ya se
          renderizan SIEMPRE que aplican, fuera de este bloque: valen igual por
          el camino del "Aprobar" simple. Acá queda sólo lo que es propio de
          estar editando. */}
      {trimmed.plan.length === 0 && <p className="decision-gate-edit-dropped decision-gate-edit-empty">{t('coordination.proposal.editDropsAll')}</p>}
      <div className="decision-gate-edit-actions">
        <button className="primary" disabled={busy || trimmed.plan.length === 0} onClick={confirmEdit}>{t('coordination.proposal.editConfirm')}</button>
        <button onClick={editCancel}>{t('coordination.proposal.editCancel')}</button>
      </div>
    </div>}
    {/* N10: SIN HANDLER NO HAY BOTONES. Con `onResolveGate` sin definir los
        tres no podían hacer nada, y "Confirmar edición y aprobar" era peor que
        inerte: `accepted` quedaba `undefined`, no era `false`, y el editor se
        cerraba como si el motor hubiera aceptado una aprobación que nunca
        salió. La tarjeta se lee igual; lo que no se ofrece es una acción que no
        existe. */}
    {onResolveGate && <div className="decision-gate-actions">
      {/* O1: la condición es el ESTADO DEL FORMULARIO, no si el editor está
          abierto. Antes era `!editing`, y eso deja pasar el caso que importa:
          el editor cerrado sobre un formulario modificado (lo que producía
          `confirmEdit` cerrando sin esperar al motor). Con el formulario
          intacto no hay ninguna edición que este botón pueda descartar en
          silencio, así que puede convivir con el editor abierto. */}
      {formPristine && <button className="primary" disabled={busy || trimmed.plan.length === 0} onClick={approvePlain}>{t('coordination.gate.approve')}</button>}
      <button disabled={busy} onClick={() => setEditing(true)}>{t('coordination.gate.editApprove')}</button>
      <button disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div>}
  </div>;
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

/** An open `latte_ask` (Phase 3): its one action is the answer itself, never an edit — a different surface from the approve/reject gates above. */
function AskCard({ ask, formatDate, onAnswerAsk, pending }: { ask: CoordinationAskView; formatDate: (value: string) => string; onAnswerAsk?: DecisionsViewProps['onAnswerAsk']; pending?: Pending }) {
  const busy = Boolean(pending?.[`ask:${ask.id}`]);
  return <div className="decision-ask">
    <h3>{t('coordination.ask.title')}</h3>
    <p>{ask.question}</p>
    <small>{t('coordination.ask.deadline', { date: formatDate(ask.deadlineAt) })}</small>
    <div className="decision-gate-actions">
      <button className="primary" disabled={busy} onClick={() => { const answer = window.prompt(t('coordination.ask.placeholder'), ''); if (answer?.trim()) onAnswerAsk?.(ask.id, answer.trim()); }}>{t('coordination.ask.answer')}</button>
    </div>
  </div>;
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
  const gates = runFinished ? [] : props.gates;
  const openAsks = runFinished ? [] : props.openAsks;
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
    {((gates?.length ?? 0) > 0 || (openAsks?.length ?? 0) > 0) && <section className="decision-gates">
      {gates?.map((gate) => {
        // La key lleva la VERSIÓN de la propuesta, no sólo el id del gate. Un
        // agente que re-envía la propuesta reusa el mismo gate, y con una key
        // estable los `useState` del formulario —inicializados una sola vez—
        // se quedaban con el plan y el tope VIEJOS: el bloque de lectura
        // mostraba el tope nuevo y `confirmEdit` mandaba el anterior. Cambiar
        // la key remonta la tarjeta, que es exactamente "esta ya es otra
        // propuesta".
        if (gate.kind === 'proposal') return <ProposalGateCard key={`${gate.id}:${proposalVersion(gate.proposalJson)}`} gate={gate} roles={props.roles} team={props.team} onResolveGate={props.onResolveGate} pending={props.pending} />;
        if (gate.kind === 'dispatch') return <DispatchGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
        if (gate.kind === 'budget') return <BudgetGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
        return <PlanGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
      })}
      {openAsks?.map((ask) => <AskCard key={ask.id} ask={ask} formatDate={props.formatDate} onAnswerAsk={props.onAnswerAsk} pending={props.pending} />)}
    </section>}
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
