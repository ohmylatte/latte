import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Check, ChevronRight, CircleCheck, CircleHelp, Pencil, Send, UserPlus, Users } from 'lucide-react';
import { translate as t } from '../i18n';
import { memberDisplayName, roleDisplayName } from './names';
import { CoordAvatar } from './anatomy';
import { titleOf } from './text';
import { hourOf, minutesSince } from './time';
import type {
  AgentRole, CoordinationAskView, CoordinationGateAggregate, CoordinationGateView,
  CoordinationProposal, CoordinationRunView, TeamMember,
} from '../../shared/contracts';

/**
 * LAS TARJETAS DEL EQUIPO VIVEN EN EL CHAT DEL MIEMBRO AL QUE LE CORRESPONDEN.
 *
 * Hasta acá todo lo de coordinación —propuesta, despacho, plan, presupuesto,
 * pregunta— se dibujaba en Decisiones, una pantalla que es de MARCA y que
 * permanece: cada coordinación la llenaba de ruido y la persona tenía que
 * salir de la conversación para contestar algo que el equipo le preguntó EN la
 * conversación. El producto es "pedís en el chat, aprobás en el chat": estas
 * tarjetas son eso.
 *
 * Este módulo es una MUDANZA, no una reescritura: las cinco tarjetas salieron
 * de `DecisionsView.tsx` tal cual estaban, con sus reglas ya juzgadas
 * (propuesta ilegible, recorte del plan por cobertura, el editor que sólo
 * cierra cuando el motor acepta, la nota de sólo lectura). Lo que cambia es
 * DÓNDE se dibujan y con qué clases (`team-card-*`), más dos cosas que la
 * mudanza permite: el prompt del despacho y el spec de las tareas se leen como
 * Markdown, y la edición del prompt es un `<textarea>` inline en vez de un
 * `window.prompt` (un cuadro nativo del sistema operativo no es un lugar donde
 * nadie pueda leer, mucho menos editar, un prompt de varias líneas).
 */

type ResolveGate = (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void | boolean | Promise<boolean | void>;
type Pending = Record<string, boolean> | undefined;

export interface TeamCardsProps {
  /** El miembro de ESTE chat: la tarjeta se dibuja acá sólo si es para él. */
  memberId: string;
  /**
   * El run del Trabajo. `coordinatorMemberId` es lo que decide a quién le toca
   * un gate; `active: false` (un run cerrado) no muestra ninguna tarjeta, la
   * misma regla explícita que Decisiones tenía.
   */
  coordinationRun?: CoordinationRunView | null;
  gates?: readonly CoordinationGateView[];
  openAsks?: readonly CoordinationAskView[];
  roles?: readonly AgentRole[];
  team?: readonly TeamMember[];
  formatDate?: (value: string) => string;
  onResolveGate?: ResolveGate;
  onAnswerAsk?: (askId: string, answer: string) => void;
  pending?: Record<string, boolean>;
  /** Cambia la pestaña del panel de equipo: lo que hace el botón de "El equipo te espera". */
  onSelectMember?: (memberId: string) => void;
  /** C6: la hora local de un ISO y el instante de referencia, inyectables para los tests. */
  formatTime?: (value: string) => string;
  now?: number;
  /** C6: "Ver equipo" cambia el rail a Equipo. Sin handler, no se ofrece. */
  onShowTeam?: () => void;
  /**
   * B4.3a: el encabezado plegable YA nombra la sección. Con él presente, el
   * título de adentro decía «Del equipo» por segunda vez, dos renglones
   * seguidos, y se comía el alto que las tarjetas necesitan para verse.
   */
  titled?: boolean;
}

/**
 * A quién le toca cada cosa, decidido UNA vez y en un lugar que se puede
 * testear sin montar un chat.
 *
 * Un gate (propuesta, despacho, plan, presupuesto) es una conversación con el
 * COORDINADOR: es quien propuso, quien despacha y quien administra el
 * presupuesto. Una pregunta es de quien preguntó — si el motor no dijo quién
 * (una fila vieja, un miembro que ya no está), cae en el coordinador, que es
 * el único destinatario que siempre existe mientras haya run.
 *
 * Sin coordinador no hay destinatario posible: se devuelve `null` y las
 * tarjetas no se dibujan en NINGÚN chat, en vez de elegir un miembro al azar.
 */
export function gateRecipient(run: CoordinationRunView | null | undefined): string | null {
  return run?.coordinatorMemberId ?? null;
}

export function askRecipient(ask: CoordinationAskView, run: CoordinationRunView | null | undefined): string | null {
  return ask.memberId || gateRecipient(run);
}

export interface TeamCardRouting {
  /** Los gates de ESTE miembro. */
  gates: CoordinationGateView[];
  /** Las preguntas de ESTE miembro. */
  asks: CoordinationAskView[];
  /** Cuántas tarjetas hay para OTROS miembros, y a cuál saltar primero. */
  elsewhere: number;
  firstElsewhereMemberId: string | null;
}

export function routeTeamCards(
  memberId: string,
  gates: readonly CoordinationGateView[] | undefined,
  asks: readonly CoordinationAskView[] | undefined,
  run: CoordinationRunView | null | undefined,
): TeamCardRouting {
  // Un run que cerró no pide nada: la misma lectura explícita de `active` que
  // Decisiones hacía, y no una deducción de que la lista venga vacía.
  const finished = run != null && !run.active;
  const allGates = finished ? [] : (gates ?? []);
  const allAsks = finished ? [] : (asks ?? []);
  const to = gateRecipient(run);
  const mineGates = to === memberId ? [...allGates] : [];
  const mineAsks: CoordinationAskView[] = [];
  let elsewhere = 0;
  let first: string | null = null;
  if (to !== memberId && allGates.length > 0 && to != null) { elsewhere += allGates.length; first = to; }
  for (const ask of allAsks) {
    const target = askRecipient(ask, run);
    if (target === memberId) { mineAsks.push(ask); continue; }
    if (target == null) continue;
    elsewhere += 1;
    first ??= target;
  }
  return { gates: mineGates, asks: mineAsks, elsewhere, firstElsewhereMemberId: first };
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

/**
 * Texto largo del motor (el prompt de un despacho, el spec de una tarea)
 * leído como lo que es: Markdown, con el mismo `ReactMarkdown + remarkGfm` que
 * los documentos. Colapsado a su primera línea, porque una tarjeta que vive
 * arriba del campo de escribir no puede comerse la conversación.
 */
function MarkdownLine({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const first = lines[0] ?? '';
  const collapsible = lines.length > 1;
  return <div className={'team-card-text' + (className ? ' ' + className : '')}>
    {open || !collapsible
      ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
      : <p className="team-card-first-line">{first}</p>}
    {collapsible && <button type="button" className="team-card-more" onClick={() => setOpen((v) => !v)}>
      {open ? t('coordination.card.less') : t('coordination.card.more')}
    </button>}
  </div>;
}

/**
 * M4 (ronda 8): LA MISMA REGLA EN LAS CINCO TARJETAS.
 *
 * Sin `onResolveGate` no se ofrece una acción que no existe, y se DICE — un
 * botón que no hace nada es un clic en el vacío, y esconderlo en silencio deja
 * a la persona sin saber si la tarjeta es de sólo lectura o si algo se rompió.
 */
function ReadOnlyGateNote() {
  return <p className="team-card-readonly">{t('coordination.gate.readOnly')}</p>;
}

/** The plan gate: approve/reject only — the engine ignores `editedPrompt` for this kind, so offering an edit here would be a capability that does not work. */
function PlanGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="team-card team-card-plan" data-gate-kind="plan">
    <h3>{t('coordination.gate.plan.title')}</h3>
    {onResolveGate ? <div className="team-card-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div> : <ReadOnlyGateNote />}
  </div>;
}

/** The budget-exhausted gate: exactly 2 actions. `approve` resumes the run, `reject` cancels it — the three-action triple is a pattern, not a contract. */
function BudgetGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  return <div className="team-card team-card-budget" data-gate-kind="budget">
    <h3>{t('coordination.gate.budget.title')}</h3>
    <p>{t('coordination.gate.budget.body')}</p>
    {onResolveGate ? <div className="team-card-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div> : <ReadOnlyGateNote />}
  </div>;
}

/**
 * The dispatch gate: the task prompt is genuinely editable, so it gets all 3
 * actions.
 *
 * El editor es un `<textarea>` INLINE. Antes era `window.prompt`: un cuadro
 * modal del sistema operativo, de una línea, que no muestra el prompt formateado
 * y que en un chat bloquea toda la ventana. Un prompt de despacho tiene varias
 * líneas y Markdown; editarlo ahí no era editarlo, era adivinarlo.
 */
function DispatchGateCard({ gate, onResolveGate, pending }: { gate: CoordinationGateView; onResolveGate?: ResolveGate; pending?: Pending }) {
  const busy = Boolean(pending?.[`gate:${gate.id}`]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(gate.prompt ?? '');
  return <div className="team-card team-card-dispatch" data-gate-kind="dispatch">
    <h3>{t('coordination.gate.dispatch.title')}</h3>
    {gate.prompt && <MarkdownLine text={gate.prompt} className="team-card-prompt" />}
    {editing && <div className="team-card-edit">
      <label className="field-label" htmlFor={`dispatch-prompt-${gate.id}`}>{t('coordination.gate.editPromptLabel')}</label>
      <textarea id={`dispatch-prompt-${gate.id}`} className="team-card-edit-prompt" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="team-card-edit-actions">
        <button className="primary" disabled={busy || !draft.trim()} onClick={() => { onResolveGate?.(gate.id, 'approve', draft.trim()); }}>{t('coordination.proposal.editConfirm')}</button>
        <button disabled={busy} onClick={() => { setDraft(gate.prompt ?? ''); setEditing(false); }}>{t('coordination.proposal.editCancel')}</button>
      </div>
    </div>}
    {onResolveGate ? <div className="team-card-actions">
      <button className="primary" disabled={busy} onClick={() => onResolveGate(gate.id, 'approve')}>{t('coordination.gate.approve')}</button>
      <button disabled={busy} onClick={() => setEditing(true)}>{t('coordination.gate.editApprove')}</button>
      <button disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div> : <ReadOnlyGateNote />}
  </div>;
}

/**
 * Una propuesta que no se puede leer, leída sin tirar.
 *
 * `JSON.parse` a pelo hacía que un `proposalJson` roto tumbara el render de
 * TODA la pantalla, y un JSON válido pero sin `plan` llegaba hasta
 * `proposal.plan.map` sobre `undefined`. Las dos cosas son el mismo hecho para
 * la persona: la propuesta llegó rota. Se dice, no se finge un plan vacío — un
 * plan vacío es una propuesta que no pide nada, que es otra cosa.
 */
export function readProposal(raw: string | null | undefined): CoordinationProposal | null {
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
export function proposalVersion(raw: string | null | undefined): string {
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
  return <div className="team-card team-card-proposal" data-gate-kind="proposal">
    <div className="document-kicker">{t('coordination.proposal.kicker')}</div>
    <p className="team-card-unreadable">{t('coordination.proposal.unreadable')}</p>
    {onResolveGate ? <div className="team-card-actions">
      <button disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coordination.gate.reject')}</button>
    </div> : <ReadOnlyGateNote />}
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

  // Q6: QUIÉN CUBRE CADA ROL LO DICE EL MOTOR, no esta pantalla. Sin el campo
  // (un gate de antes de ese cambio) se deriva de la propuesta misma: con
  // alta, `hire`; sin alta, se asume que el rol ya está cubierto.
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
  // Y los HUÉRFANOS: roles que el plan nombra y que nadie cubre. Se van solos:
  // dejarlos no ofrecía ninguna acción que funcionara, sólo "Rechazar".
  const orphanRoleIds = new Set([...coverage].filter(([, c]) => c === 'orphan').map(([roleId]) => roleId));
  const removedRoleIds = new Set([...orphanRoleIds, ...untickedRoleIds]);
  const trimmed = trimPlanWithoutRoles(proposal.plan, removedRoleIds);
  // Cuánto de lo que se cae es culpa de los huérfanos: su propia frase, porque
  // no es lo mismo "esto se va porque lo sacaste" que "esto no lo puede hacer nadie".
  const orphanDropped = orphanRoleIds.size > 0 ? trimPlanWithoutRoles(proposal.plan, orphanRoleIds).removed : 0;

  // Q6/P8: un alta que la persona mantiene tildada pero cuyas tareas se cayeron
  // TODAS por arrastre se contrataba igual: un proceso levantado, un cupo de
  // techo ocupado y un miembro sin una sola tarea que hacer.
  const rolesInTrimmedPlan = new Set(trimmed.plan.map((task) => task.roleId));
  const rolesInOriginalPlan = new Set(proposal.plan.map((task) => task.roleId));
  const survives = (hire: { roleId: string }) => !rolesInOriginalPlan.has(hire.roleId) || rolesInTrimmedPlan.has(hire.roleId);
  // N7: por ÍNDICE, no por referencia: dos altas idénticas del mismo rol no se
  // pueden distinguir con `includes`.
  const hiresToSendIndexes = new Set(hires.map((hire, i) => (included[i] && survives(hire) ? i : -1)).filter((i) => i >= 0));
  const hiresToSend = hires.filter((_, i) => hiresToSendIndexes.has(i));
  const hiresWithoutTasks = keptHires.length - hiresToSend.length;

  /**
   * O1: EL EDITOR CIERRA CUANDO EL MOTOR ACEPTA, NO CUANDO SE APRIETA EL BOTÓN.
   *
   * Si el backend rechaza —`DEPTH_CAP`, `INVALID_GATE`,
   * `COORDINATION_BUDGET_INVALID`, un `addMember` caído— el editor queda
   * abierto con su estado intacto y el error se ve por el canal de error de la
   * app. Cerrarlo antes de la respuesta perdía las casillas destildadas y
   * devolvía el "Aprobar" simple, que manda la propuesta GUARDADA.
   */
  const confirmEdit = async () => {
    if (!onResolveGate) return;
    const edited: CoordinationProposal = {
      ...proposal,
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
  // guardada: el motor la rechazaría con `PLAN_HAS_UNAPPROVED_ROLES`.
  const approvePlain = () => { if (orphanRoleIds.size > 0) void confirmEdit(); else onResolveGate?.(gate.id, 'approve'); };

  // O1/N8: el "Aprobar" simple manda la propuesta GUARDADA, así que sólo existe
  // mientras el formulario esté como nació — la casilla de ilimitado incluida.
  const formPristine = included.every(Boolean) && dispatches === initialDispatches() && !unlimitedConfirmed;

  const editCancel = () => {
    setDispatches(initialDispatches());
    setIncluded(initialIncluded());
    setUnlimitedConfirmed(false);
    setEditing(false);
  };

  /**
   * C6: LA PROPUESTA SE LEE COMO UNA LISTA DE TAREAS, NO COMO UN FORMULARIO.
   *
   * El número en mono, el título en una línea, "tras N" en gris cuando
   * depende de otra, y el mini-avatar del dueño. Los índices del `dependsOn`
   * son posiciones en el plan ORIGINAL: se traducen al número que la persona
   * ve, que es el del plan recortado — decir "tras 3" apuntando a una tarea
   * que se cayó no manda a ningún lado.
   */
  const keptIndexes = proposal.plan.map((_, i) => i).filter((i) => !trimmed.dropped[i]);
  const numberOf = new Map(keptIndexes.map((i, pos) => [i, pos + 1]));

  return <div className="team-card team-card-proposal coord-card" data-gate-kind="proposal">
    <div className="coord-card-head">
      <span className="coord-tic"><Users size={14} /></span>
      <span className="coord-card-title">{t('coord.proposal.title')}</span>
      <span className="coord-pill coord-card-counts">{proposal.estimatedDispatches == null
        ? t('coord.proposal.countsNoCap', { tasks: keptIndexes.length })
        : t('coord.proposal.counts', { tasks: keptIndexes.length, dispatches: proposal.estimatedDispatches })}</span>
    </div>
    {/* Q6/P7: LO QUE SE APRUEBA, no lo que se propuso. */}
    <ul className="team-card-plan-list coord-plan">
      {proposal.plan.map((task, i) => {
        if (trimmed.dropped[i]) return null;
        const after = (task.dependsOn ?? []).map((idx) => numberOf.get(idx)).filter((n): n is number => n !== undefined);
        const owner = roleDisplayName(task.roleId, roles, team);
        return <li key={i} className="coord-plan-task">
          <span className="coord-plan-n">{numberOf.get(i)}</span>
          <span className="coord-plan-title" title={task.spec}>{titleOf(task.spec)}</span>
          {after.length > 0 && <span className="coord-plan-after">{t('coord.proposal.after', { n: after.join(', ') })}</span>}
          <CoordAvatar name={owner} small roleId={task.roleId} />
        </li>;
      })}
    </ul>
    {trimmed.removed > 0 && <>
      <h3 className="team-card-plan-dropped-title">{t('coordination.proposal.droppedTitle')}</h3>
      <ul className="team-card-plan-dropped-list">
        {proposal.plan.map((task, i) => trimmed.dropped[i]
          ? <li key={i}><s><strong>{roleDisplayName(task.roleId, roles, team)}</strong><span>{task.spec}</span></s></li>
          : null)}
      </ul>
    </>}
    {orphanDropped > 0 && <p className="team-card-orphan-note">{t('coordination.proposal.orphanRolesDropped', { count: orphanDropped })}</p>}
    {/* C6: el alta es una fila con su ícono: "Suma a {rol}" y, en gris, que no
        está en el equipo. El encabezado "Contrataciones" decía en palabras lo
        que el ícono ya dice. */}
    {hires.length > 0 && <ul className="team-card-hire-list coord-hires">
      {/* O3/N7: el alta que no se va a contratar se ve tachada, y con el motivo
          VERDADERO: el tachado es sólo para la que la persona dejó tildada y
          se quedó sin tareas por arrastre. La destildada se marca como lo que
          es —la sacó ella— y sin tachado. La comparación es por ÍNDICE. */}
      {hires.map((hire, i) => {
        const name = roleDisplayName(hire.roleId, roles, team);
        const row = <><UserPlus size={13} className="coord-ic-idle" />
          <span className="coord-hire-name">{t('coord.proposal.hire', { role: name })}</span>
          <span className="coord-hire-note" title={hire.why}>{t('coord.proposal.hireNote')}</span></>;
        if (!included[i]) {
          return <li key={i} className="team-card-hire-unticked coord-hire">
            {row}<small>{t('coordination.proposal.hireUntickedLabel')}</small>
          </li>;
        }
        if (hiresToSendIndexes.has(i)) return <li key={i} className="coord-hire">{row}</li>;
        return <li key={i} className="team-card-hire-dropped coord-hire">
          <s>{row}</s><small>{t('coordination.proposal.hireDroppedLabel')}</small>
        </li>;
      })}
    </ul>}
    {/* O3: los avisos viven FUERA de la edición: valen igual por el camino del
        "Aprobar" simple. */}
    {trimmed.removed > orphanDropped && <p className="team-card-edit-dropped">{t('coordination.proposal.editDropsTasks', { count: trimmed.removed - orphanDropped })}</p>}
    {hiresWithoutTasks > 0 && <p className="team-card-edit-dropped team-card-edit-hire-dropped">{t('coordination.proposal.editDropsHires', { count: hiresWithoutTasks })}</p>}
    {/* O12: el plan 100 % huérfano nombra su única salida real. */}
    {orphanDropped === proposal.plan.length && <p className="team-card-edit-dropped team-card-empty-plan">{t('coordination.proposal.nobodyCanDoIt')}</p>}
    {/* C6: el presupuesto ya lo dice la pastilla del encabezado; repetirlo bajo
        un título era el mismo número dos veces. El motivo se queda —es lo
        único de la tarjeta que la persona no puede deducir de la lista— pero
        sin un encabezado que anuncie que abajo hay un motivo. */}
    {proposal.rationale.trim() !== '' && <p className="coord-card-rationale">{proposal.rationale}</p>}
    {gate.aggregate && <p className="team-card-aggregate">{describeAggregate(proposal.estimatedDispatches, gate.aggregate)}</p>}
    <p className="team-card-note">{t('coordination.proposal.noSettingsNote')}</p>
    {editing && <div className="team-card-edit">
      <label className="field-label">{t('coordination.proposal.editDispatches')}</label>
      {/* Tocar el campo INVALIDA la confirmación de ilimitado: el único
          consentimiento que vale es el que se da sobre lo que hay ahora. */}
      <input type="number" value={dispatches} onChange={(e) => { setDispatches(e.target.value); setUnlimitedConfirmed(false); }} />
      {dispatches.trim() === '' && <label className="team-card-edit-unlimited">
        <input type="checkbox" checked={unlimitedConfirmed} onChange={() => setUnlimitedConfirmed((v) => !v)} />
        <span>{t('coordination.proposal.unlimitedConfirm')}</span>
      </label>}
      {hires.length > 0 && <>
        <p className="field-label">{t('coordination.proposal.editHires')}</p>
        {hires.map((hire, i) => <label key={i} className="team-card-edit-hire">
          <input type="checkbox" checked={included[i] ?? false} onChange={() => setIncluded((prev) => prev.map((v, idx) => idx === i ? !v : v))} />
          <span>{roleDisplayName(hire.roleId, roles, team)}</span>
        </label>)}
      </>}
      {trimmed.plan.length === 0 && <p className="team-card-edit-dropped team-card-edit-empty">{t('coordination.proposal.editDropsAll')}</p>}
      <div className="team-card-edit-actions">
        <button className="primary" disabled={busy || trimmed.plan.length === 0} onClick={confirmEdit}>{t('coordination.proposal.editConfirm')}</button>
        <button onClick={editCancel}>{t('coordination.proposal.editCancel')}</button>
      </div>
    </div>}
    {/* N10/M4: sin handler no hay botones, y se dice. */}
    {!onResolveGate && <ReadOnlyGateNote />}
    {/* C6: un verbo por botón, siempre con ícono. "Editar" abre el MISMO flujo
        de "Editar y aprobar" de siempre —el recorte de tareas y altas— y por
        eso el botón de confirmar adentro conserva su nombre entero: ahí sí
        aprobar es lo que pasa al apretarlo. "Rechazar" va a la derecha,
        fantasma: es la salida, no una alternativa al mismo nivel. */}
    {onResolveGate && <div className="team-card-actions coord-card-actions">
      {formPristine && <button className="primary coord-btn-primary" disabled={busy || trimmed.plan.length === 0} onClick={approvePlain}><Check size={14} />{t('coord.proposal.approve')}</button>}
      <button disabled={busy} onClick={() => setEditing(true)}><Pencil size={13} />{t('coord.proposal.edit')}</button>
      <span className="coord-card-spacer" />
      <button className="coord-btn-ghost" disabled={busy} onClick={() => onResolveGate(gate.id, 'reject')}>{t('coord.proposal.reject')}</button>
    </div>}
  </div>;
}

/**
 * Una `latte_ask` abierta: su única acción es la respuesta misma, nunca una
 * edición. El campo es un `<textarea>` inline por lo mismo que el del
 * despacho: `window.prompt` no es un lugar donde nadie pueda escribir una
 * respuesta de verdad.
 */
function AskCard({ ask, team, roles, onAnswerAsk, pending, now }: {
  ask: CoordinationAskView; team: readonly TeamMember[]; roles: readonly AgentRole[];
  onAnswerAsk?: (askId: string, answer: string) => void; pending?: Pending; now?: number;
}) {
  const busy = Boolean(pending?.[`ask:${ask.id}`]);
  const [answer, setAnswer] = useState('');
  const role = memberDisplayName(ask.memberId, team, null, roles);
  /**
   * C6: "hace {n} min" en vez de la fecha del vencimiento.
   *
   * Lo que la persona necesita saber de una pregunta que le llegó AL CHAT es
   * hace cuánto la están esperando. El vencimiento vive en el modo Equipo,
   * donde la tarjeta grande tiene lugar para decir para qué tarea es.
   */
  const ago = minutesSince(ask.createdAt, now ?? Date.now());
  const send = () => { if (answer.trim()) { onAnswerAsk?.(ask.id, answer.trim()); setAnswer(''); } };
  return <div className="team-card team-card-ask coord-card" data-gate-kind="ask">
    <div className="coord-card-head">
      <span className="coord-tic coord-tic-live"><CircleHelp size={14} /></span>
      <span className="coord-card-title">{t('coord.ask.title', { role })}</span>
      {ago != null && <time className="coord-time" dateTime={ask.createdAt}>{ago > 0 ? t('coord.ask.ago', { count: ago }) : t('coord.ask.now')}</time>}
    </div>
    <p className="team-card-question coord-card-question">{ask.question}</p>
    {onAnswerAsk && <div className="coord-ask-form">
      <label className="visually-hidden" htmlFor={`team-card-answer-${ask.id}`}>{t('coord.ask.label', { name: role })}</label>
      <input id={`team-card-answer-${ask.id}`} className="team-card-answer coord-ask-input" type="text"
        placeholder={t('coord.ask.placeholder')} value={answer} disabled={busy}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      <button className="primary coord-btn-primary coord-ask-send" disabled={busy || !answer.trim()} onClick={send}><Send size={14} />{t('coord.ask.answer')}</button>
    </div>}
  </div>;
}

/**
 * C6: LA LÍNEA PLEGADA DE UN PLAN QUE YA SE APROBÓ.
 *
 * Aprobar hacía desaparecer la tarjeta y no dejaba nada: la conversación
 * seguía como si no hubiera pasado. Esto es una línea —tilde verde, la frase,
 * la hora en mono— y un solo verbo para ir a ver al equipo trabajar.
 */
function ApprovedLine({ run, formatTime, onShowTeam }: {
  run: CoordinationRunView; formatTime?: (value: string) => string; onShowTeam?: () => void;
}) {
  const at = run.createdAt;
  const label = formatTime ? formatTime(at) : hourOf(at);
  return <div className="team-card coord-approved" data-gate-kind="approved">
    <span className="coord-tic coord-tic-ok"><CircleCheck size={14} /></span>
    <span className="coord-approved-text">{t('coord.approved.line')}</span>
    {label && <time className="coord-time" dateTime={at}>{label}</time>}
    {onShowTeam && <button type="button" className="coord-btn coord-btn-ghost coord-approved-go" onClick={onShowTeam}>
      {t('coord.approved.seeTeam')}<ArrowRight size={13} />
    </button>}
  </div>;
}

/**
 * La sección fija arriba del campo de escribir, con lo que ESTE miembro te
 * está pidiendo. Cuando no hay nada para él pero sí para otro, una sola línea
 * lo dice y ofrece el salto — nunca se dibuja una tarjeta en el chat
 * equivocado, y nunca se calla que hay algo esperando en otro lado.
 */
export function TeamCards(props: TeamCardsProps) {
  const routing = routeTeamCards(props.memberId, props.gates, props.openAsks, props.coordinationRun);
  const roles = props.roles ?? [];
  const team = props.team ?? [];
  const run = props.coordinationRun ?? null;
  if (routing.gates.length === 0 && routing.asks.length === 0) {
    /**
     * C6: el plan aprobado deja una linea en la conversacion donde se aprobo.
     * Solo en el chat del coordinador --es su conversacion-- y solo mientras
     * el run este vivo: un run cerrado ya no tiene equipo trabajando.
     */
    const approved = run?.active && run.planApproved && gateRecipient(run) === props.memberId;
    if (approved) return <section className="team-cards team-cards-approved">
      <ApprovedLine run={run!} formatTime={props.formatTime} onShowTeam={props.onShowTeam} />
    </section>;
    if (routing.elsewhere === 0 || !routing.firstElsewhereMemberId) return null;
    const target = routing.firstElsewhereMemberId;
    // B2.2: el miembro que espera puede ya no estar en el equipo. La cadena de
    // `memberDisplayName` termina en una frase, nunca en `mem_…`.
    const name = memberDisplayName(target, team, null, roles);
    return <section className="team-cards team-cards-elsewhere">
      <p className="team-cards-waiting">{t('coordination.cards.waiting', { count: routing.elsewhere })}</p>
      {props.onSelectMember && <button type="button" className="team-cards-goto" onClick={() => props.onSelectMember!(target)}>{t('coordination.cards.goToMember', { name })}</button>}
    </section>;
  }
  return <section className="team-cards">
    {props.titled !== false && <div className="document-kicker team-cards-title">{t('coordination.cards.title')}</div>}
    {routing.gates.map((gate) => {
      // La key lleva la VERSIÓN de la propuesta, no sólo el id del gate: un
      // agente que re-envía la propuesta reusa el mismo gate, y con una key
      // estable el formulario se quedaba con el plan y el tope VIEJOS.
      if (gate.kind === 'proposal') return <ProposalGateCard key={`${gate.id}:${proposalVersion(gate.proposalJson)}`} gate={gate} roles={roles} team={team} onResolveGate={props.onResolveGate} pending={props.pending} />;
      if (gate.kind === 'dispatch') return <DispatchGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
      if (gate.kind === 'budget') return <BudgetGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
      return <PlanGateCard key={gate.id} gate={gate} onResolveGate={props.onResolveGate} pending={props.pending} />;
    })}
    {routing.asks.map((ask) => <AskCard key={ask.id} ask={ask} team={team} roles={roles} onAnswerAsk={props.onAnswerAsk} pending={props.pending} now={props.now} />)}
  </section>;
}

/**
 * B3.2: QUÉ es lo que el equipo está esperando, en una frase contada.
 *
 * Los cuatro tipos de gate y la pregunta tienen nombres distintos porque son
 * cosas distintas: "1 propuesta" y "1 presupuesto" mandan a la persona a
 * decisiones que no se parecen en nada. Con más de un tipo a la vez no se
 * elige uno —eso mentiría sobre lo que hay detrás de la línea— y se cuenta
 * cuántos pendientes son.
 */
export function describeCardsPending(routing: TeamCardRouting): string {
  const kinds = new Set<string>(routing.gates.map((gate) => gate.kind));
  if (routing.asks.length > 0) kinds.add('ask');
  const count = routing.gates.length + routing.asks.length;
  const kind = kinds.size === 1 ? [...kinds][0]! : 'mixed';
  return t(`coordination.cards.kind.${kind}` as 'coordination.cards.kind.mixed', { count });
}

/**
 * B3.2: LAS TARJETAS, PLEGADAS POR DEFECTO.
 *
 * Arriba del composer es el lugar correcto —una aprobación dentro del scroll
 * se va hacia arriba con el primer mensaje nuevo—, pero DESPLEGADAS ocupan
 * hasta 46vh todo el tiempo, esté la persona por aprobar algo o no. El dueño
 * lo dijo con la captura: el chat necesita ese alto.
 *
 * Plegadas son una línea que dice qué hay. Se abren al tocarla, y se vuelven a
 * plegar al tocarla de nuevo o cuando ya no queda nada para este miembro: si
 * llega un pendiente nuevo después, la persona lo ve como línea, no como una
 * tarjeta que se le abrió sola encima del teclado.
 *
 * Sin nada para este miembro esto no decide nada: delega en `TeamCards`, que
 * dibuja la línea de "hay algo en otro chat" o no dibuja nada.
 */
export function TeamCardsCollapsible(props: TeamCardsProps & { initiallyExpanded?: boolean }) {
  const routing = routeTeamCards(props.memberId, props.gates, props.openAsks, props.coordinationRun);
  const mine = routing.gates.length + routing.asks.length;
  const [open, setOpen] = useState(Boolean(props.initiallyExpanded));
  useEffect(() => { if (mine === 0) setOpen(false); }, [mine === 0]);
  // B3.5: el aviso puede llegar con el chat YA montado -- la persona ya estaba
  // en la conversacion del coordinador cuando toco 'te espera una aprobacion'.
  // Sin esto, ese camino no desplegaba nada.
  useEffect(() => { if (props.initiallyExpanded) setOpen(true); }, [props.initiallyExpanded]);
  if (mine === 0) return <TeamCards {...props} />;
  return <>
    <button type="button" className={'team-cards-collapsed' + (open ? ' is-open' : '')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <span className="team-cards-collapsed-text">{t('coordination.cards.collapsed', { what: describeCardsPending(routing) })}</span>
      <ChevronRight size={13} />
    </button>
    {/* El encabezado de arriba ya dice de qué es esto: adentro no se repite. */}
    {open && <TeamCards {...props} titled={false} />}
  </>;
}
