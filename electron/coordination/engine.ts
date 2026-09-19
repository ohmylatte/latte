/**
 * The coordination state machine. The ONLY writer of `coordination_dispatch`:
 * every path that could ever start a member working — a coordinator's
 * `latte_dispatch` tool call (`tools.ts`, later relayed over MCP), a human
 * approving a gate over IPC, or the handoff bridge — re-enters `startDispatch`
 * below. There is no second way to reach `hub.send()` for coordination.
 *
 * No new runtime machinery: dispatch drives a member exactly the way
 * `LatteService.requestBrandContextDraft` already does (reuse an idle member
 * for the role, or open one, then `hub.send(memberId, prompt)`).
 *
 * `maxConcurrent` is enforced here, not in the pure `budget.ts`: counting
 * in-flight dispatches is a DB read. The coordinator is excluded from that
 * count for free — it never has a `coordination_dispatch` row of its own (it
 * dispatches to others, it is never dispatched to).
 */
import type { AgentHub, MemberContext } from '../agents/hub';
import type { CoordinationAuthorityMode, CoordinationBudget } from '../../shared/contracts';
import { LatteError, NotFoundError, ValidationError } from '../core/errors';
import { FeatureDisabledError } from '../core/features';
import { newId } from '../core/ids';
import { LIMITS, requireInt, requireText } from '../services/validation';
import type {
  CoordinationAskRecord,
  CoordinationDispatchRecord,
  CoordinationMessageRecord,
  CoordinationRunRecord,
  CoordinationTaskRecord,
  LatteRepository,
} from '../storage/repository';
import { canAddTask, computeBlockedTasks, computeReadyTasks, computeTaskDepth, wouldCreateCycle, type DagEdge, type DagTask } from './dag';
import { assertBudgetConfigured, BudgetUnsetError, readCoordinationGlobalBudget, requireCoordinationBudget, reserveDispatch, type BudgetUsage, type CoordinationGlobalBudgetRead } from './budget';
import { ASK_TTL_DEFAULT_MINUTES, ASK_TTL_MAX_MINUTES, MAX_ACTIVE_COORDINATION_RUNS, MAX_ATTEMPTS_PER_TASK } from './limits';

/**
 * Los roles que la persona aprobo, por run. Una clave propia y no `plan_json`:
 * ese campo lo reescribe `latte_plan_submit` (juicio #3, ronda 4). El
 * precedente es `coordination_authority:` / `coordination_budget:` -- meta,
 * nunca una columna nueva (SCHEMA_VERSION se queda en '12').
 */
const APPROVED_ROLES_META = 'coordination_approved_roles:';

export type CoordinationRole = 'coordinator' | 'worker';

/**
 * Stands in for a minted MCP token's resolved identity. Phase 3 passed this
 * directly — "a fake token" per the design's own testing strategy. Phase 6
 * (`tokens.ts`) mints a token bound only to `{workId, memberId}`; THIS grant
 * — `runId` and `role` included — is resolved fresh per request by
 * `resolveGrant`, below, never frozen at mint (design-v2-conversational
 * overrules design v1). `runId` is `null` whenever the Work has no active
 * run: a token minted before any run exists is valid, and it is exactly how
 * `latte_request_coordination` (task 6.5) gets called at all.
 */
export interface CoordinationGrant {
  workId: string;
  runId: string | null;
  memberId: string;
  role: CoordinationRole;
}

export interface CoordinationBudgetBlock {
  dispatchesUsed: number;
  maxDispatches: number | null;
  inFlight: number;
  maxConcurrent: number | null;
}

export type CoordinationGateKind = 'plan' | 'dispatch' | 'budget' | 'proposal';

export interface CoordinationGate {
  id: string;
  kind: CoordinationGateKind;
  runId: string;
  taskId?: string;
  dispatchId?: string;
  prompt?: string;
  /** Only present on a `proposal` gate: the whole `CoordinationProposal`, JSON-encoded. */
  proposalJson?: string | null;
  /** Only present on a `proposal` gate: the aggregate across every OTHER active run, shown never hidden. */
  aggregate?: CoordinationGateAggregate;
  createdAt: string;
}

/**
 * The whole of a `latte_request_coordination` call — the sentence becomes a
 * gate (design-v2-conversational D1). Stored verbatim as `coordination_run
 * .plan_json` while `status:'planning'`; the human either approves it as-is
 * or edits it (`decision.editAdd`) before approving, per `resolveGate`'s
 * `'proposal'` branch.
 */
export interface CoordinationProposalTask {
  roleId: string;
  spec: string;
  dependsOn?: number[];
}

export interface CoordinationProposalHire {
  roleId: string;
  why: string;
}

export interface CoordinationProposal {
  plan: CoordinationProposalTask[];
  /** `null` only ever means "unlimited", and only alongside `unlimitedConfirmedAt` — "no implicit unlimited" applies to a proposal exactly as it does to a Work's own budget default. */
  estimatedDispatches: number | null;
  unlimitedConfirmedAt?: string | null;
  membersToHire?: CoordinationProposalHire[];
  rationale: string;
}

export interface CoordinationGateAggregate {
  otherActiveRuns: number;
  /** `null` when another live run is itself explicitly unlimited — never a fabricated number. */
  otherCommittedDispatches: number | null;
  totalIfApproved: number | null;
}

export interface CoordinationDispatchLogEntry {
  /** Ausente y `'dispatch'` son lo mismo: toda entrada previa a la del cierre del run es de despacho. */
  kind?: 'dispatch';
  id: string;
  taskId: string;
  memberId: string;
  status: CoordinationDispatchRecord['status'];
  createdAt: string;
  startedAt: string | null;
  settledAt: string | null;
}

/**
 * El cierre del run, la única entrada de la bitácora que no nace de una fila de
 * `coordination_dispatch`. No se guarda: se DERIVA del estado del run y del de
 * sus tareas cada vez que se lee, igual que las otras — así no puede divergir
 * de lo que la base dice de verdad.
 */
export interface CoordinationRunDoneLogEntry {
  kind: 'run_done';
  id: string;
  runId: string;
  tasksDone: number;
  tasksFailed: number;
  createdAt: string;
}

export type CoordinationLogEntry = CoordinationDispatchLogEntry | CoordinationRunDoneLogEntry;

export interface CoordinationEngineDeps {
  repo: LatteRepository;
  hub: AgentHub;
  clock: () => string;
  memberContext: (workId: string) => MemberContext;
  /**
   * Task 6.37: called after a run/task/dispatch/gate change actually lands,
   * so the renderer's `latte:coordination-event` subscription can route an
   * event from a Brand the person is not currently looking at. Optional --
   * every pre-6.37 test constructs an engine without it, and this stays a
   * pure no-op for them.
   */
  emit?: (event: { brandId: string; workId: string; runId: string | null }) => void;
  /**
   * Task 8.1 (rollout gate): `featureFlags('coordination')`. Optional and
   * defaults to ENABLED when absent -- every pre-8.1 test (direct engine
   * construction, ~150 of them) never wires this and must keep behaving
   * exactly as before. Real production wiring (`latteService.ts`,
   * `bootstrap.ts`'s `mcpEngine`) passes the REAL flag, off by default like
   * every other feature. Gates only the two entry points that can create a
   * run (`startRun`, `requestCoordination`) -- everything downstream already
   * requires an active run (task 6.3's `NO_ACTIVE_RUN` guard), so gating
   * creation alone is sufficient: no run, no gate, no coordination server
   * ever gets used. Engram injection (task 6.29) is a SEPARATE policy and is
   * deliberately NOT read here.
   */
  isCoordinationEnabled?: () => boolean;
}

function isDagStatus(status: CoordinationTaskRecord['status']): DagTask['status'] {
  return status;
}

export class CoordinationEngine {
  /**
   * Los miembros que un despacho YA eligió y todavía está levantando.
   *
   * `resolveTargetMember` leía `hub.listTeam`, elegía al ocioso y recién
   * después esperaba a `hub.openMember` — segundos de spawn. Dos despachos
   * concurrentes del MISMO rol leían la misma foto y elegían al mismo miembro:
   * el `opening` del hub evita spawnear dos procesos, pero las dos tareas
   * quedaban asignadas a la misma persona y la segunda pisaba a la primera con
   * su `hub.send`. La elección se RESERVA en el mismo tick en que se toma, y
   * quien viene atrás ve a ese miembro tan ocupado como si ya estuviera
   * trabajando (que es exactamente lo que va a estar en un segundo).
   *
   * En memoria y no en la base a propósito: "ocioso" sale de `hub.listTeam`,
   * estado vivo de ESTE proceso. No sobrevive a un reinicio, y no debe.
   */
  private readonly assigning = new Set<string>();

  constructor(private readonly deps: CoordinationEngineDeps) {}

  /**
   * Task 6.37's own trigger. Nunca tira: el fallo de un listener no es
   * problema de este motor.
   *
   * Crítico 12: el `brandId` salía de `memberContext`, que hace I/O de disco
   * y, cuando el Trabajo no tiene ninguna conversación viva, REESCRIBE su
   * CLAUDE.md/AGENTS.md. O sea que cada cambio de estado de coordinación
   * —empezar, pausar, reanudar, cancelar, aprobar, reportar— reescribía los
   * archivos de instrucciones del Trabajo sólo para averiguar a qué Marca
   * pertenece. La regla de quietud del repo dice que esos archivos se tocan
   * en momentos contados, y esto los tocaba en todos. Es una lectura de una
   * columna: sale del repo, sincrónica, sin tocar el filesystem.
   */
  private touch(workId: string, runId: string | null): void {
    if (!this.deps.emit) return;
    try {
      this.deps.emit({ brandId: this.deps.repo.getWork(workId).brandId, workId, runId });
    } catch { /* an event listener's own failure is never this engine's problem */ }
  }

  /** Task 8.1: the single choke point for the rollout gate. Called first, before any read/write, by both `startRun` and `requestCoordination` -- the only two ways a run row can ever be created. */
  private requireCoordinationEnabled(): void {
    const enabled = this.deps.isCoordinationEnabled ? this.deps.isCoordinationEnabled() : true;
    if (!enabled) throw new FeatureDisabledError('coordination');
  }

  // -- Run lifecycle (IPC-facing) --------------------------------------------

  /** Requires a configured budget (`BUDGET_UNSET` otherwise) — no implicit unlimited run ever starts. */
  async startRun(workId: string, coordinatorMemberId: string | null): Promise<CoordinationRunRecord> {
    this.requireCoordinationEnabled();
    const existing = this.deps.repo.findActiveCoordinationRun(workId);
    if (existing) throw new LatteError('RUN_ALREADY_ACTIVE', 'This Work already has an active coordination run');
    this.assertRunCeiling();
    const budget = this.readBudget(workId);
    assertBudgetConfigured(budget);
    const now = this.deps.clock();
    const run = this.deps.repo.insertCoordinationRun({
      id: newId('crn'),
      workId,
      status: 'running',
      coordinatorMemberId,
      budgetJson: JSON.stringify(budget),
      planJson: null,
      planApprovedAt: null,
      suspendReason: null,
      createdAt: now,
      updatedAt: now,
    });
    this.touch(workId, run.id);
    return run;
  }

  getRun(runId: string): CoordinationRunRecord {
    return this.deps.repo.getCoordinationRun(runId);
  }

  /**
   * Resolves a member's grant PER REQUEST — the lazy-resolution rule
   * (task 6.2, overruling design v1's "freeze at mint"): `runId` is whatever
   * run is active for the Work right now (`null` if none), `role` is
   * whichever member currently holds the `coordination_coordinator:<W>` meta
   * key. The same `{workId, memberId}` pair, never re-minted and with no
   * process restart, moves from `runId:null`/`'worker'` to a live run and to
   * `'coordinator'` as the Work's state changes underneath it — and flips
   * back the moment the grant moves elsewhere, with no revocation step.
   */
  resolveGrant(workId: string, memberId: string): CoordinationGrant {
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    const coordinatorMemberId = this.deps.repo.getMeta('coordination_coordinator:' + workId);
    return { workId, memberId, runId: run?.id ?? null, role: coordinatorMemberId === memberId ? 'coordinator' : 'worker' };
  }

  listTasks(runId: string): CoordinationTaskRecord[] {
    return this.deps.repo.listCoordinationTasks(runId);
  }

  /**
   * "Pausar equipo": takes effect at the next boundary. In-flight dispatches
   * finish and report; nothing new starts.
   *
   * Y por eso pausar NO liquida las reservas abiertas, a diferencia de
   * `cancelRun`: el despacho en vuelo sigue vivo y su `latte_report` tiene que
   * seguir entrando. Liquidarlo escribiría el gasto por adelantado y, peor,
   * dejaría al despacho sin fila `dispatched`, con lo cual el reporte
   * legítimo del miembro rebotaría con FORBIDDEN. Una pausa se reanuda; una
   * cancelación no.
   */
  pauseRun(runId: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running') return run;
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', this.deps.clock(), 'paused_by_human');
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /**
   * Unconditional: resuming just lets dispatch attempts proceed again. Whether
   * budget actually allows one is re-checked at the next `startDispatch` call,
   * never here — a resume with a still-exhausted budget simply re-suspends on
   * the next attempt instead of lying about being unblocked.
   */
  resumeRun(runId: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'suspended') return run;
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'running', this.deps.clock(), null);
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /**
   * Cancelar es la salida de emergencia que la interfaz promete, así que tiene
   * que dejar las cuentas cerradas: cambiar sólo `run.status` dejaba las
   * reservas del run abiertas y, como el tope app-wide cuenta
   * `state='reserved'`, cada run cancelado con despachos en vuelo erosionaba
   * ese tope PARA SIEMPRE — usar el escape empeoraba la situación de forma
   * permanente. Los despachos en vuelo se liquidan igual que en una caída (el
   * miembro FUE despachado: el asiento se escribe), sin cobrar intento.
   */
  cancelRun(runId: string): CoordinationRunRecord {
    for (const dispatch of this.deps.repo.listCoordinationDispatches(runId)) {
      if (dispatch.status === 'dispatched' || dispatch.status === 'running') this.settleUncertain(dispatch.id, { incrementAttempts: false });
    }
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'cancelled', this.deps.clock(), null);
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /** The gate kinds a human resolves with approve/reject: proposal, plan, dispatch, budget-exhausted. Open `latte_ask`s are a separate surface (`answerAsk`). */
  listGates(runId: string): CoordinationGate[] {
    const run = this.deps.repo.getCoordinationRun(runId);
    const gates: CoordinationGate[] = [];
    // The proposal gate (task 6.9): a 'planning' run holds an unapproved
    // `latte_request_coordination` proposal. Unlike the 'plan' gate below,
    // it appears in EVERY authority mode — the proposal decides the
    // authority, so there is no authority yet to gate it by.
    if (run.status === 'planning') {
      const proposal = run.planJson ? (JSON.parse(run.planJson) as CoordinationProposal) : null;
      gates.push({
        id: `proposal:${run.id}`,
        kind: 'proposal',
        runId: run.id,
        proposalJson: run.planJson,
        aggregate: proposal ? this.computeAggregate(run, proposal) : undefined,
        createdAt: run.createdAt,
      });
    }
    // The plan snapshot only gates dispatch under 'plan' authority — under
    // 'manual' every dispatch already gates individually, and under 'auto'
    // nothing gates, so a plan gate would be a decision nobody needs to make.
    // Guarded against 'planning': that status is the PROPOSAL gate's own
    // territory above, even though `plan_json` is set on both (a different
    // shape — the whole proposal here, a task-id snapshot for the Phase 3
    // 'plan' gate) — the two must never both fire for the same run.
    if (run.status !== 'planning' && this.readAuthority(run.workId) === 'plan' && run.planJson && !run.planApprovedAt) {
      gates.push({ id: `plan:${run.id}`, kind: 'plan', runId: run.id, createdAt: run.createdAt });
    }
    for (const dispatch of this.deps.repo.listCoordinationDispatches(runId)) {
      if (dispatch.status === 'pending_approval') {
        gates.push({ id: dispatch.id, kind: 'dispatch', runId: run.id, taskId: dispatch.taskId, dispatchId: dispatch.id, prompt: dispatch.prompt, createdAt: dispatch.createdAt });
      }
    }
    if (run.status === 'suspended' && run.suspendReason && run.suspendReason !== 'paused_by_human' && run.suspendReason !== 'all_blocked_on_ask') {
      gates.push({ id: `budget:${run.id}`, kind: 'budget', runId: run.id, createdAt: run.updatedAt });
    }
    return gates;
  }

  /** Approves or rejects a proposal/plan/dispatch/budget gate. The dispatch branch re-enters `startDispatch` — the same choke point `latte_dispatch` uses. Task 6.37: fires the coordination event once, after the fact, for every branch. */
  async resolveGate(gateId: string, decision: 'approve' | 'reject', editedPrompt?: string | null): Promise<CoordinationGate | CoordinationDispatchRecord | CoordinationRunRecord> {
    // PRIMERO, antes de leer una sola fila (crítico 6). `resolveProposalGate`
    // es el efecto más caro del motor: contrata gente, levanta procesos y
    // escribe permiso, presupuesto y autoridad. Sin este chequeo, bajar la
    // bandera a mitad de vuelo no frenaba NADA de eso — sólo el despacho
    // siguiente, o sea después de que el equipo ya estaba contratado y
    // andando. Un interruptor que sólo impide encender no es un interruptor.
    //
    // Se rechaza antes de tocar nada, así que el gate NO se consume: queda
    // pendiente, y cuando la persona vuelve a prender la bandera la decisión
    // sigue sobre la mesa, tal cual estaba. La salida de emergencia con la
    // bandera baja es `cancelCoordinationRun`, que apaga en vez de encender.
    this.requireCoordinationEnabled();
    // Defensa en profundidad (crítico 12): la frontera IPC ya lo valida, pero
    // este método es público y `hub.send` está a tres saltos de acá.
    if (editedPrompt != null) requireText(editedPrompt, 'editedPrompt', LIMITS.chatMessage);
    const result = await this.resolveGateInternal(gateId, decision, editedPrompt);
    const workId = 'workId' in result ? result.workId : this.deps.repo.getCoordinationRun(result.runId).workId;
    const runId = 'runId' in result ? result.runId : result.id;
    this.touch(workId, runId);
    return result;
  }

  private async resolveGateInternal(gateId: string, decision: 'approve' | 'reject', editedPrompt?: string | null): Promise<CoordinationGate | CoordinationDispatchRecord | CoordinationRunRecord> {
    if (gateId.startsWith('proposal:')) {
      return this.resolveProposalGate(gateId.slice('proposal:'.length), decision, editedPrompt ?? undefined);
    }
    if (gateId.startsWith('plan:')) {
      const runId = gateId.slice('plan:'.length);
      const run = this.deps.repo.getCoordinationRun(runId);
      if (decision === 'reject') return this.cancelRun(runId);
      const snapshot: string[] = run.planJson ? JSON.parse(run.planJson) : [];
      const now = this.deps.clock();
      for (const taskId of snapshot) this.deps.repo.updateCoordinationTask(taskId, { inPlan: true }, now);
      return this.deps.repo.approveCoordinationPlan(runId, now);
    }
    if (gateId.startsWith('budget:')) {
      const runId = gateId.slice('budget:'.length);
      if (decision === 'reject') return this.cancelRun(runId);
      return this.resumeRun(runId);
    }
    // A dispatch gate: the id is the pending_approval dispatch row's own id.
    const dispatch = this.deps.repo.getCoordinationDispatch(gateId);
    if (decision === 'reject') {
      const now = this.deps.clock();
      this.deps.repo.updateCoordinationTask(dispatch.taskId, { status: 'ready', assignedMemberId: null }, now);
      return this.deps.repo.updateCoordinationDispatch(dispatch.id, { status: 'rejected', settledAt: now });
    }
    const outcome = await this.startDispatch({
      grant: { workId: this.deps.repo.getCoordinationRun(dispatch.runId).workId, runId: dispatch.runId, memberId: '', role: 'coordinator' },
      taskId: dispatch.taskId,
      approvedGateId: dispatch.id,
      editedPrompt: editedPrompt ?? undefined,
    });
    return this.deps.repo.getCoordinationDispatch(outcome.dispatchId);
  }

  /**
   * The proposal gate's own resolution (task 6.10, design-v2-conversational
   * D1). `reject` is trivial: `cancelRun` only ever touches `run.status`, so
   * "reject grants nothing" (task 6.12) holds for free — no meta key, no
   * hire, no task is ever written.
   *
   * `approve` performs SIX effects that must land together or not at all —
   * a failing `hub.addMember` must leave NO grant, NO budget, NO tasks
   * (task 6.10). `hub.addMember` is async and SQLite's own transaction is
   * synchronous, so the two cannot literally share one `BEGIN`/`COMMIT`.
   * El orden ayuda — las contrataciones van primero, antes de cualquier
   * escritura — pero NO alcanza: protege del caso "una contratación falla",
   * no del inverso. `hub.addMember` inserta la fila, mintea el token, ocupa
   * un cupo de techo y spawnea un proceso real, y nada de eso vuelve atrás
   * solo; con `[copywriter, designer]` donde el agente inventó `designer`, la
   * primera quedaba spawneada para siempre. Por eso el conjunto de
   * contrataciones es COMPENSABLE: se anotan a medida que entran y se
   * deshacen con `hub.removeMember` si falla una posterior o si falla la
   * transacción. Los cinco efectos restantes (grant, meta del presupuesto,
   * presupuesto del run, autoridad, tareas + aprobación + estado) siguen
   * cayendo juntos dentro de un `repo.transaction()` real.
   */
  private async resolveProposalGate(runId: string, decision: 'approve' | 'reject', editedProposalJson?: string): Promise<CoordinationRunRecord> {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (decision === 'reject') return this.cancelRun(runId);

    const proposal: CoordinationProposal = editedProposalJson ? JSON.parse(editedProposalJson) : JSON.parse(run.planJson!);
    // "No implicit unlimited" re-asserted for an EDITED proposal too (task
    // 6.11): the same validator `setCoordinationBudget` already uses. La
    // confirmación de ilimitado sólo cuenta si viene en el payload que la
    // PERSONA mandó al aprobar; lo que el agente hubiera escrito en su
    // propuesta ya se descartó al guardarla (ver `requestCoordination`).
    const unlimitedConfirmedAt = editedProposalJson ? proposal.unlimitedConfirmedAt ?? null : null;
    const budget = requireCoordinationBudget({ maxDispatches: proposal.estimatedDispatches, unlimitedConfirmedAt });

    // El run tiene que seguir en 'planning'. Sin esto, un segundo clic en
    // "Aprobar" volvía a correr los seis efectos: contrataba de nuevo a TODO
    // el equipo, recreaba las tareas, pisaba el presupuesto que la persona
    // hubiera subido y forzaba la autoridad de vuelta a 'plan'. El chequeo
    // autoritativo está adentro de la transacción; éste es sólo para fallar
    // antes de gastar una contratación.
    if (run.status !== 'planning') throw new LatteError('COORDINATION_NOT_APPROVED', `This proposal is already resolved (run is ${run.status})`);

    // Las contrataciones se hacen de a una y se anotan: `hub.addMember`
    // inserta la fila, mintea el token, ocupa un cupo de techo Y spawnea un
    // proceso real, nada de lo cual vuelve atrás solo. Si una falla —o si
    // falla la transacción de abajo— hay que deshacer las que ya entraron.
    const hired: string[] = [];
    try {
      for (const hire of proposal.membersToHire ?? []) {
        const session = await this.deps.hub.addMember({ ...this.deps.memberContext(run.workId), roleId: hire.roleId });
        hired.push(session.id);
      }
      return this.commitProposal(run.id, proposal, budget);
    } catch (error) {
      for (const memberId of hired.reverse()) {
        try { this.deps.hub.removeMember(memberId); } catch { /* el rollback nunca tapa el error original */ }
      }
      throw error;
    }
  }

  /** Los cinco efectos restantes de una propuesta aprobada, en una sola transacción real. */
  private commitProposal(runId: string, proposal: CoordinationProposal, budget: CoordinationBudget): CoordinationRunRecord {
    const now = this.deps.clock();
    return this.deps.repo.transaction(() => {
      // Releído acá adentro: es el único chequeo que dos aprobaciones
      // concurrentes no pueden atravesar las dos (el precedente es
      // `repo.setDecisionStatus`, que se guarda igual dentro de su transacción).
      const run = this.deps.repo.getCoordinationRun(runId);
      if (run.status !== 'planning') throw new LatteError('COORDINATION_NOT_APPROVED', `This proposal is already resolved (run is ${run.status})`);
      this.deps.repo.setMeta('coordination_coordinator:' + run.workId, run.coordinatorMemberId ?? '');
      // El presupuesto de la propuesta es SOLO la estimación de despachos: se
      // funde sobre el que la persona ya había configurado en vez de pisarlo.
      // Reemplazarlo entero normalizaba a `null` todos los topes secundarios,
      // `maxConcurrent` incluido — el único limitador en vuelo que existe.
      const existingBudget = this.readBudget(run.workId);
      const merged: CoordinationBudget = {
        ...budget,
        maxTokens: existingBudget?.maxTokens ?? budget.maxTokens,
        maxCostMicros: existingBudget?.maxCostMicros ?? budget.maxCostMicros,
        maxWallMinutes: existingBudget?.maxWallMinutes ?? budget.maxWallMinutes,
        maxConcurrent: existingBudget?.maxConcurrent ?? budget.maxConcurrent,
      };
      const budgetJson = JSON.stringify(merged);
      this.deps.repo.setMeta('coordination_budget:' + run.workId, budgetJson);
      this.deps.repo.updateActiveCoordinationRunBudget(run.workId, budgetJson, now); // the run is still 'planning' here — included in the active set
      // Aprobar NUNCA afloja la autoridad. `manual` es más estricto que
      // `plan` (gatea cada despacho, uno por uno): pisarlo con 'plan' le
      // sacaba en silencio TODOS los gates a quien lo había elegido a
      // propósito, porque cada tarea de la propuesta entra con `inPlan:true`.
      // Desde `auto`, en cambio, subir a 'plan' sí es endurecer.
      // Se lee el meta CRUDO, no `readAuthority`: éste devuelve 'manual' tanto
      // para "la persona lo eligió" como para "nunca se configuró", y preservar
      // el segundo caso dejaría a todo Trabajo nuevo sin la autoridad 'plan'
      // que la aprobación existe para conceder. Sólo la elección explícita manda.
      if (this.deps.repo.getMeta('coordination_authority:' + run.workId) !== 'manual') {
        this.deps.repo.setMeta('coordination_authority:' + run.workId, 'plan');
      }
      this.deps.repo.setCoordinationPlan(run.id, JSON.stringify(proposal), now); // the approved (possibly edited) proposal, for the record
      // La foto de los roles aprobados va a su PROPIA clave, no a `plan_json`:
      // ese campo lo reescribe `latte_plan_submit`, una herramienta que el
      // agente coordinador tiene en la mano (juicio #3). Esto es lo que la
      // persona vio y aprobó, y nada alcanzable desde una tool lo toca.
      //
      // Y se arma SÓLO desde los `membersToHire` que llegaron en la resolución
      // del gate (editados o no) más los roles que YA son miembros del
      // Trabajo. Nunca desde `proposal.plan`: cada contratación existe porque
      // el plan la pide, así que derivar la foto del plan hacía que destildar
      // una contratación en la interfaz no impidiera absolutamente nada — el
      // rol quedaba aprobado igual y el primer despacho lo contrataba y le
      // levantaba un proceso, sin un solo gate. La interfaz renderizaba un
      // rechazo que el motor ignoraba.
      const approvedRoles = new Set<string>();
      for (const hire of proposal.membersToHire ?? []) approvedRoles.add(hire.roleId);
      // Un rol que ya está en el equipo no necesita aprobación: nadie lo
      // contrata de nuevo, se lo reutiliza (`resolveTargetMember`). Los
      // terminados no cuentan: re-abrir uno ES una contratación.
      for (const member of this.deps.repo.listMembers(run.workId)) {
        if (!member.done) approvedRoles.add(member.roleId);
      }
      this.deps.repo.setMeta(APPROVED_ROLES_META + run.id, JSON.stringify([...approvedRoles]));
      const created: CoordinationTaskRecord[] = []; // index-based dependsOn, exactly like planSubmit's own loop
      for (const item of proposal.plan) {
        const dependsOnIds = (item.dependsOn ?? []).map((idx) => {
          const dep = created[idx];
          if (!dep) throw new ValidationError(`Plan task dependsOn index ${idx} is out of range`);
          return dep.id;
        });
        const task = this.createTaskRow(run.id, item.roleId, item.spec, dependsOnIds);
        this.deps.repo.updateCoordinationTask(task.id, { inPlan: true }, now);
        created.push(task);
      }
      this.deps.repo.approveCoordinationPlan(run.id, now);
      return this.deps.repo.updateCoordinationRunStatus(run.id, 'running', now, null);
    });
  }

  /**
   * The aggregate across every OTHER active run (task 6.13): shown, never
   * hidden. `null` for the sum — and therefore for the total — the moment
   * any other run is itself explicitly unlimited: an honest "can't sum
   * this" beats a fabricated number.
   */
  private computeAggregate(currentRun: CoordinationRunRecord, proposal: CoordinationProposal): CoordinationGateAggregate {
    const others = this.deps.repo.listActiveCoordinationRuns().filter((r) => r.id !== currentRun.id);
    let otherCommittedDispatches: number | null = 0;
    for (const other of others) {
      const budget = JSON.parse(other.budgetJson) as CoordinationBudget;
      if (budget.maxDispatches == null) { otherCommittedDispatches = null; break; }
      otherCommittedDispatches = (otherCommittedDispatches as number) + budget.maxDispatches;
    }
    const mine = proposal.estimatedDispatches;
    const totalIfApproved = mine == null || otherCommittedDispatches == null ? null : mine + otherCommittedDispatches;
    return { otherActiveRuns: others.length, otherCommittedDispatches, totalIfApproved };
  }

  /**
   * The bitácora: derived only from `coordination_dispatch` rows, one entry per
   * lifecycle event — más, cuando el run terminó, la entrada de cierre con
   * cuántas tareas salieron bien y cuántas fallaron. También derivada: se
   * cuenta sobre las tareas, no se guarda una frase que después pueda mentir.
   */
  listLog(runId: string): CoordinationLogEntry[] {
    const entries: CoordinationLogEntry[] = this.deps.repo.listCoordinationDispatches(runId).map((d) => ({
      id: d.id, taskId: d.taskId, memberId: d.memberId, status: d.status, createdAt: d.createdAt, startedAt: d.startedAt, settledAt: d.settledAt,
    }));
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status === 'done') {
      const tasks = this.deps.repo.listCoordinationTasks(runId);
      entries.push({
        kind: 'run_done',
        id: `run-done:${run.id}`,
        runId: run.id,
        tasksDone: tasks.filter((t) => t.status === 'done').length,
        tasksFailed: tasks.filter((t) => t.status === 'failed').length,
        createdAt: run.updatedAt,
      });
    }
    return entries;
  }

  /**
   * Las `latte_ask` todavía sin responder de un run. `listGates` excluye
   * `all_blocked_on_ask` a propósito (una pregunta no es un gate de
   * aprobar/rechazar), así que sin esta lista un run suspendido por una
   * pregunta no tenía ninguna salida en la UI salvo cancelar.
   */
  listOpenAsks(runId: string): CoordinationAskRecord[] {
    return this.deps.repo.listOpenCoordinationAsks(runId);
  }

  /**
   * Crítico 6, revisado y DEJADO sin gatear a propósito: responder una
   * pregunta no contrata a nadie, no levanta ningún proceso y no escribe
   * permiso, presupuesto ni autoridad — sólo guarda lo que la persona
   * contestó, y a lo sumo saca al run de un `all_blocked_on_ask` del que no
   * puede salir despachando igual (`startDispatch` sí tiene el chequeo). Con
   * la bandera baja, cerrarle esta puerta a la persona la dejaría con un
   * agente esperando una respuesta que nadie le puede dar, y sin ganar una
   * sola garantía a cambio.
   */
  answerAsk(askId: string, answer: string): CoordinationAskRecord {
    const answered = this.deps.repo.answerCoordinationAsk(askId, answer, this.deps.clock());
    // Answering may un-suspend a run that self-suspended on "all blocked on asks".
    const run = this.deps.repo.getCoordinationRun(answered.runId);
    if (run.status === 'suspended' && run.suspendReason === 'all_blocked_on_ask') {
      this.deps.repo.updateCoordinationRunStatus(run.id, 'running', this.deps.clock(), null);
    }
    this.touch(run.workId, run.id);
    return answered;
  }

  // -- Handoff bridge ---------------------------------------------------------

  /**
   * WHEN a Work has an active run, mints a `coordination_task` for the
   * accepted handoff instead of only opening a chat draft, then immediately
   * attempts to dispatch it through the exact same choke point `latte_dispatch`
   * uses. This is the human-driven path that needs no coordinator agent and no
   * MCP: the human's own UI action both creates the task and requests its
   * dispatch, and authority gating (manual/plan/auto) applies exactly as it
   * would to a coordinator-originated dispatch.
   */
  async bridgeHandoffToTask(workId: string, roleId: string, spec: string): Promise<{ bridged: false } | { bridged: true; task: CoordinationTaskRecord; dispatch: { status: 'dispatched' | 'pending_approval'; dispatchId: string } }> {
    // Crítico 6: `startDispatch` ya chequeaba la bandera, pero ACÁ abajo —
    // después de que `createTaskRow` ya había escrito la tarea. Con la
    // bandera baja quedaba una tarea huérfana en el run por cada handoff
    // aceptado. El chequeo va antes de escribir, no después.
    this.requireCoordinationEnabled();
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    if (!run) return { bridged: false };
    const task = this.createTaskRow(run.id, roleId, spec, []);
    const outcome = await this.startDispatch({ grant: { workId, runId: run.id, memberId: '', role: 'coordinator' }, taskId: task.id });
    this.touch(workId, run.id);
    return { bridged: true, task: this.deps.repo.getCoordinationTask(task.id), dispatch: { status: outcome.status, dispatchId: outcome.dispatchId } };
  }

  /**
   * The sentence becomes a gate (task 6.5, design-v2-conversational D1): ANY
   * member — a plain worker grant, no coordinator, no run needed — may
   * propose a plan. Writes exactly ONE `coordination_run` row,
   * `status:'planning'`, holding the whole proposal. Deliberately does
   * NOTHING else: zero tasks, zero dispatches, zero `hub.send` — a proposal
   * cannot spend (task 6.6 enforces this from the other side, at
   * `startDispatch`). "One proposal per Work" (task 6.8) reuses the exact
   * `RUN_ALREADY_ACTIVE` check `startRun` already makes — the partial unique
   * index's own `WHERE status IN (...)` already includes `'planning'`, so no
   * separate case is needed for "another proposal is already pending" vs.
   * "a run is already live": `findActiveCoordinationRun` sees both alike.
   */
  async requestCoordination(grant: CoordinationGrant, proposal: CoordinationProposal): Promise<CoordinationRunRecord> {
    this.requireCoordinationEnabled();
    // ANTES de tocar la base: un `estimatedDispatches` que no sea entero
    // positivo produce un `budget_json` que `requireCoordinationBudget`
    // rechaza, y esa fila después rompía la tira global de TODAS las marcas y
    // convertía cada llamada MCP siguiente de este Trabajo en un HTTP 500.
    // Un run con presupuesto ilegible no se inserta nunca.
    requireInt(proposal.estimatedDispatches, 'estimatedDispatches', 1, Number.MAX_SAFE_INTEGER);
    const existing = this.deps.repo.findActiveCoordinationRun(grant.workId);
    if (existing) throw new LatteError('RUN_ALREADY_ACTIVE', `This Work already has an active coordination run (${existing.id}, ${existing.status})`);
    this.assertRunCeiling();
    const now = this.deps.clock();
    const run = this.deps.repo.insertCoordinationRun({
      id: newId('crn'),
      workId: grant.workId,
      status: 'planning',
      coordinatorMemberId: grant.memberId,
      // `unlimitedConfirmedAt` se DESCARTA acá, tanto del presupuesto como de
      // la propuesta guardada: "un presupuesto ilimitado es siempre una
      // elección humana, nunca un default implícito" se volvía satisfacible
      // por el agente escribiendo su propio timestamp, y el único "Aprobar"
      // de la persona — el mismo botón que para un plan acotado — lo
      // concedía. La confirmación tiene que venir del payload de aprobación.
      budgetJson: JSON.stringify({ maxDispatches: proposal.estimatedDispatches, unlimitedConfirmedAt: null }),
      planJson: JSON.stringify({ ...proposal, unlimitedConfirmedAt: null }),
      planApprovedAt: null,
      suspendReason: null,
      createdAt: now,
      updatedAt: now,
    });
    this.touch(grant.workId, run.id);
    return run;
  }

  // -- Tool-facing engine methods (wrapped by tools.ts) ------------------------

  planSubmit(runId: string, tasks: Array<{ roleId: string; spec: string; dependsOn?: number[] }>): CoordinationTaskRecord[] {
    const run = this.deps.repo.getCoordinationRun(runId);
    const created: CoordinationTaskRecord[] = [];
    for (const spec of tasks) {
      const dependsOnIds = (spec.dependsOn ?? []).map((idx) => {
        const dep = created[idx];
        if (!dep) throw new ValidationError(`Plan task dependsOn index ${idx} is out of range`);
        return dep.id;
      });
      created.push(this.createTaskRow(run.id, spec.roleId, spec.spec, dependsOnIds));
    }
    const now = this.deps.clock();
    this.deps.repo.setCoordinationPlan(run.id, JSON.stringify(created.map((t) => t.id)), now);
    this.touch(run.workId, run.id);
    return created;
  }

  taskCreate(runId: string, input: { roleId: string; spec: string; dependsOn?: string[] }): CoordinationTaskRecord {
    const task = this.createTaskRow(runId, input.roleId, input.spec, input.dependsOn ?? []);
    this.touch(this.deps.repo.getCoordinationRun(runId).workId, runId);
    return task;
  }

  teamList(workId: string) {
    return this.deps.hub.listTeam(workId);
  }

  /**
   * THE single dispatch choke point. Every path that can ever start a member
   * working re-enters here. Order (non-negotiable, mirrors the design):
   * grant → active run → task ready → target member idle → authority gate
   * (short-circuits to `pending_approval`) → `maxConcurrent` → budget reserve
   * → `hub.send()` → dispatched row.
   */
  async startDispatch(ctx: { grant: CoordinationGrant; taskId: string; approvedGateId?: string; editedPrompt?: string }): Promise<{ status: 'dispatched' | 'pending_approval'; taskId: string; dispatchId: string }> {
    // El interruptor tiene que APAGAR, no sólo impedir encender: gateando
    // únicamente `startRun`/`requestCoordination`, bajar la bandera a mitad de
    // run no frenaba nada y los agentes seguían gastando plata. Acá, en el
    // único choke point por el que pasa todo despacho, sí frena.
    this.requireCoordinationEnabled();
    if (ctx.grant.role !== 'coordinator') throw new LatteError('FORBIDDEN', 'Only the coordinator may dispatch');
    if (ctx.grant.runId == null) throw new LatteError('RUN_NOT_ACTIVE', 'No active coordination run for this Work');
    const run = this.deps.repo.getCoordinationRun(ctx.grant.runId);
    // FIRST run-status assertion (task 6.6): a `'planning'` run holds an
    // unapproved proposal — `plan_json`/`budget_json` nobody confirmed yet.
    // Phase 3 left this open (it silently ACCEPTED 'planning', dormant only
    // because nothing ever wrote that status); the proposal gate now writes
    // it for real, so this must reject before anything else, or an
    // unapproved proposal could spend a budget no human confirmed.
    if (run.status === 'planning') throw new LatteError('COORDINATION_NOT_APPROVED', 'This coordination run has not been approved yet');
    if (run.status !== 'running') throw new LatteError('RUN_NOT_ACTIVE', `Run is ${run.status}`);
    const task = this.deps.repo.getCoordinationTask(ctx.taskId);
    if (task.runId !== run.id) throw new NotFoundError('CoordinationTask', ctx.taskId);

    const now = this.deps.clock();
    // EL RECLAMO, antes de cualquier `await`. Los chequeos de arriba y la
    // reserva de abajo estaban a ambos lados de `resolveTargetMember` (que
    // espera a `hub.openMember`/`addMember`), así que dos `latte_dispatch`
    // simultáneos sobre la misma tarea lista — o dos clics en "Aprobar" sobre
    // el mismo gate, cada uno un invoke IPC independiente — veían los dos
    // `ready`/`pending_approval`, reservaban los dos y llegaban los dos a
    // `hub.send`. Un compare-and-set de una sola sentencia hace que compitan
    // por UNA fila: el que pierde aborta sin haber reservado ni despachado.
    let existingPending: CoordinationDispatchRecord | null = null;
    if (ctx.approvedGateId) {
      existingPending = this.deps.repo.getCoordinationDispatch(ctx.approvedGateId);
      if (existingPending.taskId !== task.id || existingPending.status !== 'pending_approval') {
        throw new LatteError('INVALID_GATE', 'Gate does not match a pending dispatch for this task');
      }
      if (!this.deps.repo.claimCoordinationDispatchFromGate(existingPending.id, now)) {
        throw new LatteError('INVALID_GATE', 'Gate does not match a pending dispatch for this task');
      }
    } else {
      if (task.status !== 'ready') throw new LatteError('TASK_NOT_READY', `Task is ${task.status}, not ready`);
      if (!this.deps.repo.claimCoordinationTaskForDispatch(task.id, now)) {
        throw new LatteError('TASK_NOT_READY', 'Task was already claimed by another dispatch');
      }
    }

    const prompt = ctx.editedPrompt ?? existingPending?.prompt ?? task.spec;
    const authority = this.readAuthority(run.workId);
    const gated = !ctx.approvedGateId && this.isGated(authority, run, task);

    // EL GATE VA PRIMERO, antes de resolver el miembro. `resolveTargetMember`
    // llama a `hub.addMember`: inserta la fila, mintea el token, ocupa un cupo
    // del techo de la app Y SPAWNEA UN PROCESO REAL. Hacerlo antes de evaluar
    // la autoridad convertia el modo `manual` -- el mas estricto -- en via
    // libre: un coordinador encadenando `latte_task_create` + `latte_dispatch`
    // forzaba a Latte a contratar y spawnear un miembro por rol hasta el techo
    // de la app, sin una sola aprobacion humana y sin cargo de presupuesto; y
    // rechazar el gate devolvia la tarea a `ready` pero no despedia a nadie.
    // La fila pendiente nace SIN miembro (`''`, el mismo "todavia nadie" que
    // `settleDispatch` ya usa): recien al aprobar se resuelve y se contrata.
    if (gated) {
      const dispatchId = newId('cdp');
      const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
      const dispatch = this.deps.repo.insertCoordinationDispatch({
        id: dispatchId, runId: run.id, taskId: task.id, memberId: '', attempt, status: 'pending_approval',
        gateId: dispatchId, prompt, outcome: null, summary: null, filesJson: null, reservationId: null,
        createdAt: now, startedAt: null, settledAt: null,
      });
      this.deps.repo.updateCoordinationTask(task.id, { status: 'dispatched', assignedMemberId: null }, now);
      this.touch(run.workId, run.id);
      return { status: 'pending_approval', taskId: task.id, dispatchId: dispatch.id };
    }

    // (El diseño pedía además un chequeo barato del estado del run ACÁ, antes
    // de pagar el spawn. No se escribió: entre la lectura del run al entrar a
    // este método y esta línea no hay un solo `await` —el reclamo, el gate y la
    // autoridad son todos sincrónicos—, así que releer devolvería exactamente
    // lo mismo. Sería una rama muerta que ningún test puede alcanzar. El
    // chequeo que importa es el de la confirmación, abajo, que sí tiene un
    // spawn entero de por medio.)
    let session: Awaited<ReturnType<AgentHub['openMember']>>;
    // La elección del miembro y su reserva pasan en el MISMO tick (ver
    // `assigning`); lo lento —levantar el proceso— viene después.
    let reservedMemberId: string | null = null;
    try {
      const target = this.reserveTargetMember(run.workId, task.roleId, this.approvedRoleIds(run));
      reservedMemberId = target.reuseMemberId;
      session = await (target.reuseMemberId
        ? this.deps.hub.openMember(target.reuseMemberId, target.context)
        : this.deps.hub.addMember({ ...target.context, roleId: task.roleId }));
    } catch (error) {
      if (reservedMemberId) this.assigning.delete(reservedMemberId);
      // Un rol que la persona no aprobó no vuelve a la cola a reintentarse
      // eternamente ni desaparece en silencio: la tarea queda `blocked` con la
      // razón escrita en la bitácora, para que la persona la vea y el
      // coordinador pueda re-planificar con `latte_plan_submit`.
      if (error instanceof LatteError && error.code === 'ROLE_NOT_APPROVED') {
        this.blockOnUnapprovedRole(run, task, existingPending, prompt, now, error.message);
      } else {
        this.releaseDispatchClaim(task.id, existingPending, now);
      }
      throw error;
    }

    // La foto del gasto y la escritura de la reserva viven en UNA transacción
    // sincrónica, sin ningún `await` en el medio: nadie puede leer el mismo
    // `dispatchesUsed` dos veces. Una denegación NO tira desde adentro (eso
    // haría rollback del asiento `denied` y de la suspensión, que son
    // justamente lo que hay que dejar escrito): se devuelve y se tira afuera.
    const runTransaction = (): { ok: true; dispatch: CoordinationDispatchRecord } | { ok: false; error: LatteError } => {
      // LA CONFIRMACIÓN. `run` se leyó ANTES de levantar el proceso, y levantar
      // un proceso son segundos: en el medio la persona pudo cancelar o pausar.
      // Sin esta relectura, `cancelRun` escribía `cancelled`, su barrido no
      // encontraba esta tarea (todavía no había fila de despacho) y el despacho
      // commiteaba y mandaba igual — el escenario del brief, medido:
      // `{"runStatusAfterCancel":"cancelled","hubSendCalls":1,"openReservations":1}`.
      // Acá adentro, en la misma transacción que escribe la reserva, gana quien
      // escribió último en la base, no quien leyó primero.
      const live = this.deps.repo.getCoordinationRun(run.id);
      if (live.status !== 'running') {
        this.abortDispatchOnRunNotRunning(run, task, existingPending, prompt, now, live.status);
        return { ok: false, error: new LatteError('RUN_NOT_ACTIVE', `Run is ${live.status}`) };
      }
      const budget = this.readRunBudget(run);
      const inFlight = this.countInFlightDispatches(run.id, existingPending?.id);
      if (budget.maxConcurrent != null && inFlight >= budget.maxConcurrent) {
        this.writeLedgerDenied(run.id, 'max_concurrent');
        this.abortDispatchClaim(task.id, existingPending, now, 'max_concurrent');
        return { ok: false, error: new LatteError('MAX_CONCURRENT', 'Too many dispatches are already in flight') };
      }

      const decision = reserveDispatch(budget, this.usageFor(run.id));
      if (!decision.ok) {
        this.writeLedgerDenied(run.id, decision.reason);
        if (run.status === 'running') this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', now, decision.reason);
        this.abortDispatchClaim(task.id, existingPending, now, decision.reason);
        return { ok: false, error: new LatteError('BUDGET_EXCEEDED', `Coordination budget denied: ${decision.reason}`) };
      }

      // El tope app-wide (task 6.35), en el MISMO choke point que el del
      // Trabajo: se guardaba en meta y no lo leía nadie, así que la persona
      // que ponía 40 no tenía tope ninguno. Suspende sólo al run que chocó.
      const globalBudget = this.readGlobalBudget();
      // Ilegible NO es "sin tope": es un dato roto, y un dato roto DENIEGA,
      // con una razón que se lee en la bitácora y en la suspensión como
      // cualquier otra — no como una excepción opaca desde el fondo de la
      // pila (crítico 8).
      if (globalBudget.kind === 'invalid') {
        const reason = 'global_budget_invalid';
        this.writeLedgerDenied(run.id, reason);
        if (run.status === 'running') this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', now, reason);
        this.abortDispatchClaim(task.id, existingPending, now, reason);
        return { ok: false, error: new LatteError('GLOBAL_BUDGET_INVALID', 'The app-wide dispatch cap could not be read; fix it in Settings before dispatching again.') };
      }
      if (globalBudget.kind === 'set') {
        const globalDecision = reserveDispatch(globalBudget.budget, this.globalUsage());
        if (!globalDecision.ok) {
          const reason = `global_${globalDecision.reason}`;
          this.writeLedgerDenied(run.id, reason);
          if (run.status === 'running') this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', now, reason);
          this.abortDispatchClaim(task.id, existingPending, now, reason);
          return { ok: false, error: new LatteError('BUDGET_EXCEEDED', `Coordination budget denied: ${reason}`) };
        }
      }

      const reservationId = newId('crs');
      this.deps.repo.insertCoordinationCostReservation({
        id: reservationId, runId: run.id, dispatchId: existingPending?.id ?? null, memberId: session.id, runtime: session.provider, model: session.model ?? 'default',
        maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: 0, state: 'reserved', usageJson: null, createdAt: now, settledAt: null,
      });

      let dispatch: CoordinationDispatchRecord;
      if (existingPending) {
        // `memberId` se escribe ACÁ: la fila pendiente nació sin miembro (el
        // gate va antes de contratar), así que recién al aprobar se sabe
        // contra quién queda anotado el despacho.
        dispatch = this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'dispatched', memberId: session.id, prompt, reservationId, startedAt: now });
      } else {
        const dispatchId = newId('cdp');
        const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
        dispatch = this.deps.repo.insertCoordinationDispatch({
          id: dispatchId, runId: run.id, taskId: task.id, memberId: session.id, attempt, status: 'dispatched',
          gateId: null, prompt, outcome: null, summary: null, filesJson: null, reservationId,
          createdAt: now, startedAt: now, settledAt: null,
        });
      }
      this.deps.repo.updateCoordinationTask(task.id, { status: 'dispatched', assignedMemberId: session.id }, now);
      return { ok: true, dispatch };
    };
    // El reclamo se tomo en autocommit ANTES de esta transaccion, asi que un
    // throw de adentro (un `budget_json` corrupto, BUDGET_UNSET, cualquier
    // constraint) hace rollback de la transaccion pero NO del reclamo: la
    // tarea quedaba `dispatched` para siempre, sin reserva y sin despacho, y
    // cada intento siguiente repetia el ciclo. Soltar y recien ahi relanzar.
    // La reserva del miembro se suelta pase lo que pase: a partir del commit
    // el estado real del miembro (`working`) es lo que lo protege, y un fallo
    // no puede dejarlo marcado como "en asignación" para siempre.
    try {
      let outcome: ReturnType<typeof runTransaction>;
      try {
        outcome = this.deps.repo.transaction(runTransaction);
      } catch (error) {
        this.releaseDispatchClaim(task.id, existingPending, now);
        throw error;
      }
      if (!outcome.ok) throw outcome.error;
      const dispatched = outcome.dispatch;

      // `hub.send` es el UNICO efecto real, y corre despues del commit: si el
      // proceso del miembro se murio entre `resolveTargetMember` y aca,
      // `AgentHub.route` tira NotFoundError y la transaccion ya escribio una
      // reserva `reserved`, un despacho `dispatched` y una tarea `dispatched`
      // que nadie deshacia. Nada se ejecuto, asi que la reserva se cierra SIN
      // asiento de gasto: no se cobra un despacho que nunca salio.
      try {
        await this.deps.hub.send(session.id, prompt);
      } catch (error) {
        this.deps.repo.transaction(() => {
          if (dispatched.reservationId) this.deps.repo.settleCoordinationCostReservation(dispatched.reservationId, null, now, false);
          this.deps.repo.updateCoordinationDispatch(dispatched.id, {
            status: 'cancelled', outcome: 'not_sent', summary: error instanceof Error ? error.message : String(error), settledAt: now,
          });
          this.deps.repo.updateCoordinationTask(task.id, { status: 'ready', assignedMemberId: null }, now);
        });
        this.touch(run.workId, run.id);
        throw error;
      }
      this.touch(run.workId, run.id);
      return { status: 'dispatched', taskId: task.id, dispatchId: dispatched.id };
    } finally {
      if (reservedMemberId) this.assigning.delete(reservedMemberId);
    }
  }

  /** El reclamo se suelta intacto: la tarea vuelve a `ready`, o el gate vuelve a la mesa tal como estaba. */
  private releaseDispatchClaim(taskId: string, existingPending: CoordinationDispatchRecord | null, now: string): void {
    if (existingPending) this.deps.repo.releaseCoordinationDispatchToGate(existingPending.id);
    else this.deps.repo.updateCoordinationTask(taskId, { status: 'ready', assignedMemberId: null }, now);
  }

  /**
   * El reclamo se suelta con el despacho ya resuelto en contra, y la bitácora
   * dice QUIÉN dijo que no. `'rejected'` es la palabra del humano que aprieta
   * "Rechazar"; acá la persona acaba de apretar "Aprobar" y fue el tope (o
   * `maxConcurrent`) el que frenó. Anotarlo como rechazo hacía que la
   * bitácora dijera que alguien negó un trabajo que en realidad autorizó.
   */
  /**
   * La tarea de un rol sin aprobar: `blocked`, con la razón anotada donde se
   * anotan todas — una fila de `coordination_dispatch` resuelta en contra,
   * exactamente como `abortDispatchClaim` anota una denegación de presupuesto
   * y como `startDispatch` anota un `hub.send` que rebotó. Nada de esto
   * contrata ni gasta: `memberId` vacío, sin reserva, `settled_at` en el acto.
   */
  private blockOnUnapprovedRole(
    run: CoordinationRunRecord,
    task: CoordinationTaskRecord,
    existingPending: CoordinationDispatchRecord | null,
    prompt: string,
    now: string,
    reason: string,
  ): void {
    this.deps.repo.transaction(() => {
      this.deps.repo.updateCoordinationTask(task.id, { status: 'blocked', assignedMemberId: null }, now);
      if (existingPending) {
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'role_not_approved', summary: reason, settledAt: now });
      } else {
        const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
        this.deps.repo.insertCoordinationDispatch({
          id: newId('cdp'), runId: run.id, taskId: task.id, memberId: '', attempt, status: 'cancelled',
          gateId: null, prompt, outcome: 'role_not_approved', summary: reason, filesJson: null, reservationId: null,
          createdAt: now, startedAt: null, settledAt: now,
        });
      }
    });
    // Y con ella caen sus dependientes, igual que con cualquier otra tarea que
    // no va a resolverse sola.
    this.recomputeReadiness(run.id, now);
    this.touch(run.workId, run.id);
  }

  /**
   * El run dejó de correr mientras se levantaba el proceso. Nada se reserva,
   * nada se inserta, nada sale por `hub.send`; el reclamo se suelta con un
   * COMPARE-AND-SET (`WHERE status='dispatched'`) para no pisar a quien escribió
   * después —`cancelRun` liquidando, un barrido, un reporte— y queda constancia
   * en la bitácora, que se deriva de `coordination_dispatch`: sin una fila, la
   * persona vería una tarea que vuelve sola a la cola y ninguna explicación.
   *
   * NO abre transacción: los dos llamadores ya están adentro de una (el de la
   * confirmación por estar dentro de `runTransaction`, el barato porque la abre
   * él). `repo.transaction` es un `BEGIN` pelado y SQLite no anida.
   */
  private abortDispatchOnRunNotRunning(
    run: CoordinationRunRecord,
    task: CoordinationTaskRecord,
    existingPending: CoordinationDispatchRecord | null,
    prompt: string,
    now: string,
    status: CoordinationRunRecord['status'],
  ): void {
    const summary = `Despacho abortado: el run pasó a ${status} mientras se levantaba el miembro`;
    this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, now);
    if (existingPending) {
      this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'run_not_active', summary, settledAt: now });
    } else {
      const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
      this.deps.repo.insertCoordinationDispatch({
        id: newId('cdp'), runId: run.id, taskId: task.id, memberId: '', attempt, status: 'cancelled',
        gateId: null, prompt, outcome: 'run_not_active', summary, filesJson: null, reservationId: null,
        createdAt: now, startedAt: null, settledAt: now,
      });
    }
  }

  private abortDispatchClaim(taskId: string, existingPending: CoordinationDispatchRecord | null, now: string, reason: string): void {
    this.deps.repo.updateCoordinationTask(taskId, { status: 'ready', assignedMemberId: null }, now);
    if (existingPending) this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'denied', summary: reason, settledAt: now });
  }

  /** `outcome:'succeeded'` unblocks dependents; `'failed'` returns the task to `ready`, or `blocked` at the attempt cap. Idempotent on an already-`done` task. */
  async report(grant: CoordinationGrant, taskId: string, outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null = null): Promise<CoordinationTaskRecord> {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    const task = this.deps.repo.getCoordinationTask(taskId);
    // PRIMERO de todo: la tarea tiene que ser de ESTE run. `startDispatch` ya
    // lo chequeaba y acá faltaba, así que un miembro de la Marca B con un
    // token válido podía pasar un id de tarea de la Marca A y recibir su
    // `spec`, su `resultSummary` y sus `resultFilesJson` de vuelta.
    if (task.runId !== grant.runId) throw new NotFoundError('CoordinationTask', taskId);
    // The CURRENT dispatch: there is at most one `dispatched`/`running` row
    // for a task at a time (a new attempt is only ever created after the
    // previous one settled), so this is more robust than "last by
    // createdAt" — two attempts can legitimately share a timestamp.
    const current = this.deps.repo.listCoordinationDispatches(task.runId).find((d) => d.taskId === taskId && (d.status === 'dispatched' || d.status === 'running'));
    if (task.status === 'done') {
      // El atajo de idempotencia va DESPUÉS de autorizar, no antes: quien
      // repite el reporte tiene que ser quien hizo la tarea. Ya no hay
      // despacho vivo, así que el permiso se mide contra el último intento.
      // Ronda 4, juicio #5: `.at(-1)` autorizaba POR POSICIÓN sobre un orden
      // `created_at ASC, id ASC`, y `newId` es `randomBytes(10)` — no
      // monotónico. Con un reintento rápido dentro del mismo tick de reloj los
      // dos intentos empatan en `created_at` y el desempate por id es al azar:
      // el miembro que hizo el trabajo podía recibir FORBIDDEN mientras el del
      // intento anterior quedaba autorizado a leer el resumen y los archivos
      // de la tarea `done`. El último intento es el de `attempt` más alto, que
      // es un contador real, no un orden de fila.
      const attemptsForTask = this.deps.repo.listCoordinationDispatches(task.runId).filter((d) => d.taskId === taskId);
      const last = attemptsForTask.reduce<CoordinationDispatchRecord | null>((best, d) => (best === null || d.attempt > best.attempt ? d : best), null);
      if (!last || last.memberId !== grant.memberId) {
        throw new LatteError('FORBIDDEN', 'Only the member this task is currently dispatched to may report it');
      }
      return task; // idempotent: already settled, no duplicate row
    }
    if (!current || current.memberId !== grant.memberId) {
      throw new LatteError('FORBIDDEN', 'Only the member this task is currently dispatched to may report it');
    }
    const now = this.deps.clock();
    // Cerrar la reserva y asentar el gasto son UNA escritura: entre las dos,
    // una caída dejaba la reserva cerrada sin asiento y el despacho se volvía
    // invisible para `usageFor`/`globalUsage` — justo el sub-conteo que contar
    // reservas abiertas existe para impedir. El estado del despacho entra en
    // la misma transacción por lo mismo.
    const reservationId = current.reservationId;
    this.deps.repo.transaction(() => {
      if (reservationId) {
        this.deps.repo.settleCoordinationCostReservation(reservationId, null, now, false);
        this.deps.repo.insertCoordinationCostLedger({ id: newId('cld'), runId: task.runId, reservationId, kind: 'spend', dispatches: 1, costMicros: 0, detailJson: JSON.stringify({ taskId, outcome }), createdAt: now });
      }
      this.deps.repo.updateCoordinationDispatch(current.id, { status: 'reported', outcome, summary, filesJson, settledAt: now });
    });

    if (outcome === 'succeeded') {
      this.deps.repo.updateCoordinationTask(taskId, { status: 'done', resultSummary: summary, resultFilesJson: filesJson }, now);
      this.recomputeReadiness(task.runId, now);
    } else {
      const attempts = task.attempts + 1;
      if (attempts >= MAX_ATTEMPTS_PER_TASK) {
        // `failed`, no `blocked`: agotar los intentos es un fracaso DEFINITIVO
        // de esta tarea, y eso es terminal — el run puede cerrarse con ella
        // adentro. `blocked` queda para lo que todavía se puede destrabar
        // (una dependencia caída, un rol sin aprobar), que es justamente lo
        // que tiene que mantener el run vivo para que alguien intervenga.
        this.deps.repo.updateCoordinationTask(taskId, { status: 'failed', attempts }, now);
        // Y con él caen sus dependientes: nadie los va a destrabar nunca más.
        this.recomputeReadiness(task.runId, now);
      } else {
        this.deps.repo.updateCoordinationTask(taskId, { status: 'ready', attempts, assignedMemberId: null }, now);
      }
    }
    // EL punto único: toda tarea que pasa a un estado terminal sale por acá.
    this.finishRunIfComplete(task.runId, now);
    this.touch(grant.workId, task.runId);
    return this.deps.repo.getCoordinationTask(taskId);
  }

  /**
   * El estado final que nunca se había diseñado. Un run termina cuando ya no
   * queda NADA por hacer: todas sus tareas en un estado terminal (`done` o
   * `failed`), ningún despacho en vuelo y ninguna reserva abierta. Idempotente
   * por construcción — sólo escribe desde `running`/`suspended`.
   *
   * `blocked` NO es terminal a propósito: una tarea bloqueada (por una
   * dependencia caída o por un rol que la persona no aprobó) todavía se puede
   * destrabar re-planificando, así que el run sigue vivo y visible en vez de
   * cerrarse tapando el problema.
   *
   * Un run SIN tareas tampoco termina: es el run recién aprobado cuyo
   * coordinador todavía no planificó nada.
   */
  private finishRunIfComplete(runId: string, now: string): void {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running' && run.status !== 'suspended') return;
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    if (tasks.length === 0) return;
    if (!tasks.every((t) => t.status === 'done' || t.status === 'failed')) return;
    // Un despacho o una reserva todavía abiertos son trabajo en vuelo: la foto
    // de las tareas puede estar adelantada respecto de la contabilidad.
    const open = this.deps.repo.listCoordinationDispatches(runId).some((d) => d.status === 'dispatched' || d.status === 'running');
    if (open) return;
    if (this.deps.repo.countOpenCoordinationCostReservations(runId) > 0) return;
    this.deps.repo.updateCoordinationRunStatus(runId, 'done', now, null);
  }

  /**
   * La reparación de las bases que dejó la versión sin estado final: un run
   * `running`/`suspended` cuyas tareas ya están todas terminales pasa a `done`
   * al arrancar. Corre junto a `sweepUncertainDispatches` (y después de él: el
   * barrido puede devolver tareas a `ready`, y ésas no cierran nada).
   * Idempotente: la segunda corrida no encuentra nada que escribir.
   */
  sweepFinishedRuns(): number {
    const now = this.deps.clock();
    let finished = 0;
    for (const run of this.deps.repo.listActiveCoordinationRuns()) {
      this.finishRunIfComplete(run.id, now);
      if (this.deps.repo.getCoordinationRun(run.id).status === 'done') finished += 1;
    }
    return finished;
  }

  /**
   * Manual settlement via IPC, zero MCP (task 3.19 — the "close" half of the
   * safety line): `latte_report` is called by the WORKER, but without MCP no
   * worker has tools, so nothing ever settled a dispatch. Under `manual`
   * authority the human already IS the coordinator, so it/she reads the
   * worker's own chat and records the outcome directly.
   *
   * This is NOT a second route into the engine: it re-enters `report()` —
   * the exact function `latte_report` calls — by resolving the current
   * dispatch's own member id first, so every rule `report()` enforces
   * (idempotency on an already-`done` task, rejection when no dispatch is
   * currently assigned, ledger settlement, the dispatch's settling
   * timestamp) applies completely unchanged.
   */
  async settleDispatch(taskId: string, outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null = null): Promise<CoordinationTaskRecord> {
    const task = this.deps.repo.getCoordinationTask(taskId);
    const run = this.deps.repo.getCoordinationRun(task.runId);
    const current = this.deps.repo.listCoordinationDispatches(task.runId).find((d) => d.taskId === taskId && (d.status === 'dispatched' || d.status === 'running'));
    const grant: CoordinationGrant = { workId: run.workId, runId: run.id, memberId: current?.memberId ?? task.assignedMemberId ?? '', role: 'worker' };
    return this.report(grant, taskId, outcome, summary, filesJson);
  }

  /**
   * FIFO, una sola entrega, lectura sincrónica. Nadie escribe todavía en
   * `coordination_message` (`insertCoordinationMessage` no tiene ningún
   * llamador de producción), así que esto devuelve `[]` siempre — y el
   * esquema publicado de `latte_check` lo dice con todas las letras en vez de
   * prometer un buzón y una espera que no existen.
   */
  check(memberId: string): CoordinationMessageRecord[] {
    const run = this.activeRunForMember(memberId);
    if (!run) return [];
    const messages = this.deps.repo.listUndeliveredCoordinationMessages(run.id, memberId);
    const now = this.deps.clock();
    for (const m of messages) this.deps.repo.markCoordinationMessageDelivered(m.id, now);
    return messages;
  }

  ask(grant: CoordinationGrant, question: string, ttlMinutes?: number, taskId?: string): CoordinationAskRecord {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    const clampedTtl = Math.min(Math.max(ttlMinutes ?? ASK_TTL_DEFAULT_MINUTES, 1), ASK_TTL_MAX_MINUTES);
    const now = this.deps.clock();
    const deadline = new Date(new Date(now).getTime() + clampedTtl * 60_000).toISOString();
    const ask = this.deps.repo.insertCoordinationAsk({
      id: newId('cak'), runId: grant.runId, taskId: taskId ?? null, memberId: grant.memberId, question, answer: null,
      deadlineAt: deadline, answeredAt: null, createdAt: now,
    });
    this.maybeSelfSuspendOnAsks(grant.runId, now);
    this.touch(grant.workId, grant.runId);
    return ask;
  }

  /** A synchronous poll of one ask: never blocks. Past its deadline and still unanswered, it reports `{answered:false, deadline}` rather than hanging. */
  askStatus(askId: string): { answered: boolean; answer?: string | null; deadline: string } {
    const ask = this.deps.repo.getCoordinationAsk(askId);
    if (ask.answeredAt) return { answered: true, answer: ask.answer, deadline: ask.deadlineAt };
    return { answered: false, deadline: ask.deadlineAt };
  }

  /** Crash/death settlement. `incrementAttempts:false` for an app-restart crash (not the agent's fault); `true` for a member-process death (a real failure). */
  settleUncertain(dispatchId: string, opts: { incrementAttempts: boolean }): CoordinationDispatchRecord {
    const dispatch = this.deps.repo.getCoordinationDispatch(dispatchId);
    const now = this.deps.clock();
    // Las escrituras van juntas, por lo mismo que en `report`: cerrar la
    // reserva sin asentar el gasto vuelve el despacho invisible para el tope.
    const outcome = this.deps.repo.transaction(() => {
      if (dispatch.reservationId) {
        this.deps.repo.settleCoordinationCostReservation(dispatch.reservationId, null, now, true);
        // El asiento se escribe igual que en `report`: el miembro FUE despachado
        // y la persona lo pagó. Sin esto, cerrar la reserva volvía ese gasto
        // invisible para siempre y el reintento estrenaba cupo.
        this.deps.repo.insertCoordinationCostLedger({
          id: newId('cld'), runId: dispatch.runId, reservationId: dispatch.reservationId, kind: 'spend', dispatches: 1, costMicros: 0,
          detailJson: JSON.stringify({ taskId: dispatch.taskId, outcome: 'uncertain' }), createdAt: now,
        });
      }
      const settled = this.deps.repo.updateCoordinationDispatch(dispatchId, { status: 'cancelled', settledAt: now });
      const task = this.deps.repo.getCoordinationTask(dispatch.taskId);
      const attempts = opts.incrementAttempts ? task.attempts + 1 : task.attempts;
      // `failed` por la misma razón que en `report`: agotar los intentos es
      // definitivo, y lo definitivo es terminal.
      const status = opts.incrementAttempts && attempts >= MAX_ATTEMPTS_PER_TASK ? 'failed' : 'ready';
      this.deps.repo.updateCoordinationTask(task.id, { status, attempts, assignedMemberId: null }, now);
      if (status === 'failed') this.recomputeReadiness(task.runId, now);
      return settled;
    });
    // Fuera de la transacción, igual que en `report`: el mismo punto único.
    this.finishRunIfComplete(dispatch.runId, now);
    return outcome;
  }

  /**
   * Reconcilia TODO despacho que quedó en vuelo, de toda la app.
   * `settleUncertain` existía sin un solo llamador de producción: nadie
   * barría al arrancar y `shutdown()` no liquidaba nada, así que salir de la
   * app (o caerse) con tres despachos en vuelo dejaba esas tres tareas en
   * `dispatched` y sus tres reservas en `reserved` para siempre. Como el tope
   * cuenta reservas abiertas, cada una quemaba de forma irrecuperable un
   * despacho del Trabajo Y del tope app-wide, y el run no podía terminar nunca.
   *
   * `incrementAttempts:false` a propósito: una salida o una caída de la app no
   * es culpa del agente, y cobrarle un intento le acercaría la tarea al tope de
   * reintentos por algo que no hizo.
   */
  sweepUncertainDispatches(): number {
    const open = this.deps.repo.listOpenCoordinationDispatches();
    for (const dispatch of open) this.settleUncertain(dispatch.id, { incrementAttempts: false });
    return open.length;
  }

  /**
   * EL LLAMADOR EN CALIENTE de `settleUncertain(..., {incrementAttempts:true})`,
   * que documentaba ese modo "para la muerte de un proceso" y no tenía ninguno
   * (crítico 5). Un `closed` de un adaptador llegaba a `hub.stop` y a
   * `injection.release` y ahí terminaba: la tarea se quedaba `dispatched` y su
   * reserva abierta por el resto de la sesión — sin reintento, con el cupo de
   * presupuesto quemado, y el run sin poder terminar nunca.
   *
   * `incrementAttempts:true` a diferencia del barrido de arranque: que se caiga
   * el proceso del agente SÍ es un fracaso de este intento, y al tope la tarea
   * queda `failed` en vez de reintentarse para siempre. `settleUncertain` ya
   * corre `finishRunIfComplete`, así que si era la última el run cierra solo.
   *
   * Un miembro sin despachos en vuelo (el caso normal: pausar a alguien que no
   * estaba trabajando) no escribe nada.
   */
  settleMemberDispatches(memberId: string): number {
    if (!memberId) return 0;
    const open = this.deps.repo.listOpenCoordinationDispatches().filter((d) => d.memberId === memberId);
    for (const dispatch of open) {
      const run = this.deps.repo.getCoordinationRun(dispatch.runId);
      this.settleUncertain(dispatch.id, { incrementAttempts: true });
      this.touch(run.workId, run.id);
    }
    return open.length;
  }

  // -- Envelope helpers for tools.ts -------------------------------------------
  // Kept public (only these two) so tools.ts never reaches into the repo or
  // hub directly — every envelope's `authority`/`budget` block is read the
  // same way a dispatch attempt itself would compute it.

  readAuthorityForEnvelope(workId: string): CoordinationAuthorityMode {
    return this.readAuthority(workId);
  }

  /** `null` (no active run for the Work — a lazily-resolved grant's honest state) answers with a zeroed block instead of throwing `NotFound`. */
  budgetBlockForEnvelope(runId: string | null): CoordinationBudgetBlock {
    if (runId == null) return { dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null };
    const run = this.deps.repo.getCoordinationRun(runId);
    const budget = this.readRunBudget(run);
    const usage = this.usageFor(runId);
    return {
      dispatchesUsed: usage.dispatchesUsed,
      maxDispatches: budget.maxDispatches,
      inFlight: this.countInFlightDispatches(runId),
      maxConcurrent: budget.maxConcurrent ?? null,
    };
  }

  // -- Internals ---------------------------------------------------------------

  /**
   * The app-wide ceiling on simultaneously active runs (task 6.15): checked
   * AFTER the per-Work `RUN_ALREADY_ACTIVE` check (a Work with its own
   * active run never reaches this — that is a different, older error), so
   * this only ever fires for a genuinely NEW run competing for one of
   * `MAX_ACTIVE_COORDINATION_RUNS` app-wide slots. Never a silent queue: the
   * caller is rejected immediately, and the message names every busy Work so
   * a human knows exactly what to close to make room.
   */
  private assertRunCeiling(): void {
    const active = this.deps.repo.listActiveCoordinationRuns();
    if (active.length < MAX_ACTIVE_COORDINATION_RUNS) return;
    const busyWorkTitles = active.map((run) => {
      try {
        return this.deps.repo.getWork(run.workId).title;
      } catch {
        return run.workId; // a Work looked up mid-deletion race: fall back to its id rather than throwing here.
      }
    });
    throw new LatteError(
      'TOO_MANY_ACTIVE_RUNS',
      `Too many coordination runs are active app-wide (limit ${MAX_ACTIVE_COORDINATION_RUNS}): ${busyWorkTitles.join(', ')}`,
    );
  }

  private createTaskRow(runId: string, roleId: string, spec: string, dependsOnIds: string[]): CoordinationTaskRecord {
    const existing = this.deps.repo.listCoordinationTasks(runId);
    // Las dependencias tienen que ser de ESTE run: `getCoordinationTask` sola
    // acepta cualquier id de la app, así que un coordinador podía colgar una
    // tarea de otra Marca de la que nadie de acá va a enterarse nunca.
    const known = new Set(existing.map((t) => t.id));
    for (const depId of dependsOnIds) {
      if (!known.has(depId)) throw new ValidationError(`Task dependency ${depId} does not belong to this coordination run`);
    }
    // `wouldCreateCycle` tampoco tenía llamador. Hoy ninguna ruta de producción
    // puede cerrar un ciclo (una tarea recién creada no tiene dependientes),
    // pero el guard vive donde las aristas se crean, que es el único lugar
    // donde puede servir cuando esa ruta exista.
    const edges: DagEdge[] = this.deps.repo.listCoordinationTaskDeps(runId);
    const depths = dependsOnIds.map((id) => this.deps.repo.getCoordinationTask(id).depth);
    const depth = computeTaskDepth(depths);
    const decision = canAddTask({ currentTaskCount: existing.length, proposedDepth: depth });
    if (!decision.ok) throw new LatteError(decision.reason === 'task_cap' ? 'TASK_CAP' : 'DEPTH_CAP', `Cannot add task: ${decision.reason}`);
    const now = this.deps.clock();
    const task = this.deps.repo.insertCoordinationTask({
      id: newId('ctk'), runId, seq: existing.length + 1, roleId, spec,
      status: dependsOnIds.length === 0 ? 'ready' : 'pending', depth, attempts: 0, inPlan: false,
      assignedMemberId: null, resultSummary: null, resultFilesJson: null, createdAt: now, updatedAt: now,
    });
    for (const dep of dependsOnIds) {
      if (wouldCreateCycle(edges, task.id, dep)) throw new ValidationError(`Task dependency ${dep} would create a dependency cycle`);
      edges.push({ taskId: task.id, dependsOnId: dep });
      this.deps.repo.insertCoordinationTaskDep(task.id, dep);
    }
    return task;
  }

  /**
   * Las DOS mitades del módulo `dag.ts`, no una sola: promover lo que ya está
   * listo Y bajar a `blocked` lo que depende de algo que nunca va a resolver.
   * `computeBlockedTasks` no tenía ningún llamador de producción, así que una
   * tarea cuya dependencia llegaba a `blocked` se quedaba `pending` para
   * siempre — justo lo contrario de lo que promete el docstring de ese
   * módulo ("a task never stalls `pending` forever") — y nada terminaba el run.
   */
  private recomputeReadiness(runId: string, now: string): void {
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    const edges: DagEdge[] = this.deps.repo.listCoordinationTaskDeps(runId);
    const dagTasks: DagTask[] = tasks.map((t) => ({ id: t.id, status: isDagStatus(t.status) }));
    const ready = new Set(computeReadyTasks(dagTasks, edges));
    for (const task of tasks) {
      if (task.status === 'pending' && ready.has(task.id)) this.deps.repo.updateCoordinationTask(task.id, { status: 'ready' }, now);
    }
    const blocked = new Set(computeBlockedTasks(dagTasks, edges));
    for (const task of tasks) {
      if ((task.status === 'pending' || task.status === 'ready') && blocked.has(task.id)) {
        this.deps.repo.updateCoordinationTask(task.id, { status: 'blocked', assignedMemberId: null }, now);
      }
    }
  }

  private maybeSelfSuspendOnAsks(runId: string, now: string): void {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running') return;
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    const openAsks = this.deps.repo.listOpenCoordinationAsks(runId);
    if (openAsks.length === 0) return;
    const blockedTaskIds = new Set(openAsks.map((a) => a.taskId).filter((id): id is string => id != null));
    const readyEligible = tasks.filter((t) => t.status === 'ready' || t.status === 'dispatched' || t.status === 'running');
    const allBlocked = readyEligible.length > 0 && readyEligible.every((t) => blockedTaskIds.has(t.id));
    if (allBlocked) this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, 'all_blocked_on_ask');
  }

  private isGated(authority: CoordinationAuthorityMode, run: CoordinationRunRecord, task: CoordinationTaskRecord): boolean {
    if (authority === 'auto') return false;
    if (authority === 'manual') return true;
    return !(run.planApprovedAt && task.inPlan);
  }

  private readAuthority(workId: string): CoordinationAuthorityMode {
    const raw = this.deps.repo.getMeta('coordination_authority:' + workId);
    return raw === 'plan' || raw === 'auto' ? raw : 'manual';
  }

  private readBudget(workId: string): CoordinationBudget | null {
    const raw = this.deps.repo.getMeta('coordination_budget:' + workId);
    if (!raw) return null;
    try { return JSON.parse(raw) as CoordinationBudget; } catch { return null; }
  }

  /**
   * El MISMO validador que escribe el presupuesto. Leído a mano, un
   * `{"maxDispatches": null}` sin `unlimitedConfirmedAt` entraba a
   * `reserveDispatch` como "sin tope ninguno" — la inversión exacta de "no hay
   * ilimitado implícito", decidida por un JSON que nadie confirmó. Un
   * `budget_json` roto tira desde acá, y eso NIEGA el despacho (el llamador
   * suelta el reclamo y relanza): nunca habilita.
   */
  private readRunBudget(run: CoordinationRunRecord): CoordinationBudget {
    try {
      return requireCoordinationBudget(JSON.parse(run.budgetJson));
    } catch (error) {
      // La razón se NOMBRA. Antes salía como un `VALIDATION` genérico
      // ("Invalid coordination budget") desde el fondo de la pila, y quien lo
      // recibía —un despacho denegado, la tira global— no tenía forma de
      // distinguir "este run tiene el presupuesto roto" de cualquier otro
      // dato inválido. Con un código propio, la fila se puede marcar y el
      // despacho se puede denegar con una razón que se lee.
      throw new LatteError('COORDINATION_BUDGET_INVALID', `This run's budget cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * El gasto de un run: lo liquidado MÁS lo reservado y todavía abierto. Esa
   * suma es la corrección central del tope — una reserva se escribe al
   * despachar, un `spend` se escribe al liquidar, y como liquidar también
   * cierra la reserva, un despacho cuenta exactamente uno de punta a punta.
   * Contando sólo el gasto liquidado, el tope no topaba nada: un agente que
   * nunca llamara a `latte_report` tenía presupuesto infinito, que es
   * justamente la inversión de la invariante que este diseño existe para
   * sostener.
   */
  private usageFor(runId: string): BudgetUsage {
    const ledger = this.deps.repo.listCoordinationCostLedger(runId);
    let dispatchesUsed = 0;
    let costMicrosUsed = 0;
    for (const row of ledger) {
      if (row.kind !== 'spend') continue;
      dispatchesUsed += row.dispatches;
      costMicrosUsed += row.costMicros;
    }
    return { dispatchesUsed: dispatchesUsed + this.deps.repo.countOpenCoordinationCostReservations(runId), costMicrosUsed };
  }

  /**
   * El mismo cálculo que `usageFor`, pero de toda la app — y sólo sobre los
   * runs VIVOS. Sumando el libro mayor entero, el tope app-wide era un contador
   * de por vida: quien ponía 40 tenía 40 despachos para toda la vida de la
   * instalación y después cada run de cada Marca se suspendía con
   * `global_max_dispatches`; "Aprobar" llamaba a `resumeRun` y el despacho
   * siguiente volvía a suspender, un bucle sin salida que la interfaz
   * presentaba como una decisión resoluble. Un tope app-wide describe cuánto
   * puede estar pasando A LA VEZ; el asiento igual queda retenido.
   */
  private globalUsage(): BudgetUsage {
    return {
      dispatchesUsed: this.deps.repo.sumActiveCoordinationSpentDispatches() + this.deps.repo.countOpenActiveCoordinationCostReservations(),
      costMicrosUsed: 0,
    };
  }

  /**
   * El tope app-wide (`coordination_budget_global`, task 6.35), leído fresco
   * en cada despacho tal como su propio doc comment promete — y por el MISMO
   * parser que usa el getter que alimenta la pantalla (crítico 8). Antes eran
   * dos lecturas distintas de los mismos bytes: una tiraba y la otra devolvía
   * `null`, así que la persona leía "sin tope global" mientras cada despacho
   * se caía. Un solo parser, tres estados, el mismo veredicto en los dos
   * lados.
   */
  private readGlobalBudget(): CoordinationGlobalBudgetRead {
    return readCoordinationGlobalBudget(this.deps.repo.getMeta('coordination_budget_global'));
  }

  /** `excludeDispatchId` es el despacho que se está decidiendo ahora: ya reclamado, todavía no concedido. */
  private countInFlightDispatches(runId: string, excludeDispatchId?: string): number {
    return this.deps.repo.listCoordinationDispatches(runId)
      .filter((d) => d.id !== excludeDispatchId && (d.status === 'dispatched' || d.status === 'running')).length;
  }

  private writeLedgerDenied(runId: string, reason: string): void {
    this.deps.repo.insertCoordinationCostLedger({
      id: newId('cld'), runId, reservationId: null, kind: 'denied', dispatches: 0, costMicros: 0,
      detailJson: JSON.stringify({ reason }), createdAt: this.deps.clock(),
    });
  }

  private activeRunForMember(memberId: string): CoordinationRunRecord | null {
    const member = this.deps.repo.findMember(memberId);
    if (!member) return null;
    return this.deps.repo.findActiveCoordinationRun(member.workId);
  }

  /**
   * Los roles que la persona aprobó de verdad, congelados EN EL MOMENTO DE LA
   * APROBACIÓN en su propia clave de meta.
   *
   * Ronda 4, juicio #3: antes se derivaban de `run.planJson`, y devolvía
   * `null` — NINGUNA restricción — cuando ese campo no parseaba a un objeto
   * con un array `plan`. Pero `planSubmit`, alcanzable por el agente
   * coordinador como `latte_plan_submit`, pisa `plan_json` con una lista pelada
   * de ids de tarea. O sea: la persona aprobaba `[strategist]`, el agente
   * llamaba a `latte_plan_submit`, y a partir de ahí podía crear una tarea con
   * CUALQUIER rol del catálogo y contratarlo sin que nadie lo viera. Una
   * herramienta que el agente tiene no puede borrar el límite que lo acota.
   *
   * Sin propuesta aprobada (un run de `startRun` directo) el conjunto es
   * VACÍO, no `null`: el alta automática queda acotada a los roles que ya
   * están en el Trabajo — `resolveTargetMember` reutiliza a los presentes y
   * sólo frena CONTRATAR a alguien nuevo.
   */
  private approvedRoleIds(run: CoordinationRunRecord): Set<string> {
    const raw = this.deps.repo.getMeta(APPROVED_ROLES_META + run.id);
    if (!raw) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((role): role is string => typeof role === 'string'));
    } catch {
      // Ilegible NO es "sin restricción": es el caso más estricto.
      return new Set();
    }
  }

  /**
   * Reuses an existing idle member for the role, or opens one — the exact
   * `requestBrandContextDraft` precedent, never a new spawn mechanism.
   *
   * El alta automática está acotada a `approvedRoles`: la persona aprobó un
   * equipo concreto, y sin esto un coordinador podía crear una tarea con
   * cualquier `roleId` del catálogo y `latte_dispatch` la contrataba en
   * silencio, sin ningún gate. Un rol ya presente en el Trabajo se reutiliza
   * como siempre — esto sólo frena CONTRATAR a alguien nuevo.
   */
  private reserveTargetMember(workId: string, roleId: string, approvedRoles: Set<string> | null = null): { reuseMemberId: string | null; context: MemberContext } {
    const team = this.deps.hub.listTeam(workId);
    const candidates = team.filter((m) => m.roleId === roleId && m.status !== 'ended');
    // Un miembro que otro despacho ya eligió cuenta como ocupado: va a estarlo
    // en cuanto termine de levantarse. Sin esto, dos despachos concurrentes del
    // mismo rol elegían al mismo y el segundo `hub.send` pisaba al primero.
    const idle = candidates.find((m) => m.status !== 'working' && !this.assigning.has(m.id));
    if (candidates.length > 0 && !idle) throw new LatteError('MEMBER_BUSY', `Every ${roleId} member is already working`);
    if (candidates.length === 0 && approvedRoles && !approvedRoles.has(roleId)) {
      throw new LatteError('ROLE_NOT_APPROVED', `Hiring a ${roleId} was not part of the approved plan; it needs its own approval`);
    }
    const context = this.deps.memberContext(workId);
    // SINCRÓNICO, en el mismo tick de la elección: el llamador recién después
    // espera al spawn, y suelta la reserva en su `finally`. Una contratación no
    // se reserva porque su id todavía no existe: `hub.addMember` acuña uno
    // nuevo, con el que nadie puede colisionar.
    if (idle) this.assigning.add(idle.id);
    return { reuseMemberId: idle?.id ?? null, context };
  }
}
