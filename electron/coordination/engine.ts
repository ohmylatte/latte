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
import { assertCoordinationProposal, LIMITS, requireCoordinationProposal, requireInt, requireText } from '../services/validation';
import type {
  CoordinationAskRecord,
  CoordinationDispatchRecord,
  CoordinationMessageRecord,
  CoordinationRunRecord,
  CoordinationTaskRecord,
  LatteRepository,
} from '../storage/repository';
import { canAddTask, computeDoomedTasks, computeReadyTasks, computeTaskDepth, wouldCreateCycle, type DagEdge, type DagTask } from './dag';
import { assertBudgetConfigured, BudgetUnsetError, readStoredCoordinationBudget, requireCoordinationBudget, reserveDispatch, type BudgetUsage, type StoredCoordinationBudgetRead } from './budget';
import { ASK_TTL_DEFAULT_MINUTES, ASK_TTL_MAX_MINUTES, DEFAULT_MAX_CONCURRENT, MAX_ACTIVE_COORDINATION_RUNS, MAX_ATTEMPTS_PER_TASK } from './limits';

/**
 * Los roles que la persona aprobo, por run. Una clave propia y no `plan_json`:
 * ese campo lo reescribe `latte_plan_submit` (juicio #3, ronda 4). El
 * precedente es `coordination_authority:` / `coordination_budget:` -- meta,
 * nunca una columna nueva (SCHEMA_VERSION se queda en '12').
 */
const APPROVED_ROLES_META = 'coordination_approved_roles:';
/** Las altas de ESTE run, en meta (como `decisionAuthority`): sin subir de versión de esquema. */
const HIRES_META = 'coordination_hires:';

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

/**
 * El otro final. Un run `cancelled` terminó igual que uno `done` —no vuelve a
 * despachar nunca—, y la bitácora lo dejaba sin una sola línea: la última cosa
 * que se leía era el despacho que quedó a medio camino, como si el equipo
 * siguiera trabajando. Se deriva igual que `run_done`, del estado del run y del
 * de sus tareas, así que tampoco puede divergir de lo que dice la base.
 *
 * Las TRES cuentas, separadas (U9). `tasksPending` juntaba antes todo lo que
 * no llegó a `done`, con las `failed` adentro: decir "sin terminar" sobre una
 * tarea que se intentó tres veces y no salió es tan falso como decir "fallida"
 * sobre una que nunca se despachó. Cancelar no hace fracasar a nadie, pero
 * tampoco borra el fracaso de quien ya había fracasado antes del corte.
 */
export interface CoordinationRunCancelledLogEntry {
  kind: 'run_cancelled';
  id: string;
  runId: string;
  tasksDone: number;
  tasksFailed: number;
  /** Ni `done` ni `failed`: lo que quedó sin terminar cuando se cortó. */
  tasksPending: number;
  createdAt: string;
}

export type CoordinationLogEntry = CoordinationDispatchLogEntry | CoordinationRunDoneLogEntry | CoordinationRunCancelledLogEntry;

/** Un alta de este run: quién se sumó, con qué rol y cuándo. Guardado en `coordination_hires:<runId>`. */
export interface CoordinationHireRecord {
  memberId: string;
  roleId: string;
  hiredAt: string;
}

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

  /**
   * Los runs cuyo cierre quedó esperando a que el coordinador termine su turno
   * (D17). En memoria y no en la base a propósito, igual que `assigning`:
   * "¿está ocupado?" sale del adaptador, estado vivo de ESTE proceso. Un
   * reinicio lo pierde, y no importa — el barrido de arranque vuelve a evaluar
   * el cierre con el coordinador ya apagado.
   */
  private readonly pendingClose = new Set<string>();

  constructor(private readonly deps: CoordinationEngineDeps) {}

  /**
   * D3: un run `done`/`cancelled` no acepta una sola mutación más. Cancelar,
   * pausar, reanudar, resolver un gate, mandar un plan o responder una pregunta
   * sobre algo terminado escribía igual: `pauseRun` devolvía el run como si
   * nada, `resolveGate` volvía a correr los seis efectos de una propuesta sobre
   * un run cancelado, y `planSubmit` pisaba `plan_json`. Terminado es terminado.
   */
  private assertRunMutable(run: CoordinationRunRecord): CoordinationRunRecord {
    if (run.status === 'done' || run.status === 'cancelled') {
      throw new LatteError('RUN_NOT_ACTIVE', `This coordination run already finished (${run.status})`);
    }
    return run;
  }

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
    const budget = this.requireReadableBudget(workId);
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
    const run = this.assertRunMutable(this.deps.repo.getCoordinationRun(runId));
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
    this.assertRunMutable(this.deps.repo.getCoordinationRun(runId));
    // F5: reanudar es el momento más obvio en que alguien vuelve a mirar el
    // run, y una pregunta cuyo plazo venció no puede seguir reteniendo sus
    // tareas. El barrido puede devolverlo a `running` por su cuenta.
    const now = this.deps.clock();
    this.refreshAsks(runId, now);
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'suspended') {
      this.touch(run.workId, run.id);
      return run;
    }
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'running', now, null);
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
    this.assertRunMutable(this.deps.repo.getCoordinationRun(runId));
    const now = this.deps.clock();
    for (const dispatch of this.deps.repo.listCoordinationDispatches(runId)) {
      if (dispatch.status === 'dispatched' || dispatch.status === 'running') this.settleUncertain(dispatch.id, { incrementAttempts: false });
      // Y los gates que quedaron sobre la mesa. Un `pending_approval` de un run
      // cancelado es una decisión que ya no decide nada: `listGates` la seguía
      // ofreciendo y aprobarla reentraba a `startDispatch` sobre un run muerto.
      else if (dispatch.status === 'pending_approval') {
        this.deps.repo.updateCoordinationDispatch(dispatch.id, {
          status: 'cancelled', outcome: 'run_cancelled', summary: 'El equipo se canceló antes de resolver esta aprobación', settledAt: now,
        });
      }
    }
    const updated = this.closeRun(runId, 'cancelled', now);
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /** The gate kinds a human resolves with approve/reject: proposal, plan, dispatch, budget-exhausted. Open `latte_ask`s are a separate surface (`answerAsk`). */
  listGates(runId: string): CoordinationGate[] {
    const terminal = this.deps.repo.getCoordinationRun(runId);
    // Un run terminado no tiene ninguna decisión pendiente: seguir ofreciendo
    // gates de algo que ya terminó es pedirle a la persona que decida sobre un
    // equipo que no existe, y cada clic rebotaba con un error desde el fondo.
    if (terminal.status === 'done' || terminal.status === 'cancelled') return [];
    // F5: mirar las decisiones de un run es uno de los tres momentos en que
    // alguien vuelve a mirarlo, y un run suspendido por preguntas vencidas no
    // tiene ningún otro camino de vuelta a `running` hasta el próximo arranque.
    // El run se RELEE después: el barrido puede haberlo devuelto a `running`, y
    // un gate de presupuesto derivado de la foto vieja sería una decisión sobre
    // una suspensión que ya no existe.
    this.refreshAsks(runId, this.deps.clock());
    const run = this.deps.repo.getCoordinationRun(runId);
    // R4: el barrido puede haber CERRADO el run (una pregunta vencida era lo
    // último que lo retenía). El chequeo de arriba se hizo sobre la foto
    // anterior, así que se repite sobre la de ahora: un run terminado no tiene
    // ninguna decisión pendiente.
    if (run.status === 'done' || run.status === 'cancelled') return [];
    const gates: CoordinationGate[] = [];
    // The proposal gate (task 6.9): a 'planning' run holds an unapproved
    // `latte_request_coordination` proposal. Unlike the 'plan' gate below,
    // it appears in EVERY authority mode — the proposal decides the
    // authority, so there is no authority yet to gate it by.
    if (run.status === 'planning') {
      // F8: un `plan_json` ilegible no puede tumbar la lista entera. Este
      // `JSON.parse` iba a pelo, así que una fila rota hacía estallar la
      // pantalla de Decisiones — justo donde vive el único botón que puede
      // sacar a ese run de ahí. El gate se emite igual, con el JSON CRUDO:
      // la interfaz ya sabe dibujar la tarjeta ilegible, cuya única acción es
      // "Rechazar". Sin propuesta legible no hay agregado que calcular, y
      // `undefined` es honesto donde un cero sería inventado.
      let proposal: CoordinationProposal | null = null;
      try {
        proposal = run.planJson ? (JSON.parse(run.planJson) as CoordinationProposal) : null;
      } catch { proposal = null; }
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
    // D4: sólo APROBAR enciende. `reject` —de cualquier clase de gate— apaga:
    // cancela el run o devuelve la tarea a la cola. Gatearlo dejaba a la persona
    // que baja la bandera sin ninguna salida salvo cancelar a mano lo que ya
    // estaba andando, que es exactamente lo contrario de lo que un interruptor
    // de emergencia tiene que permitir.
    if (decision === 'approve') this.requireCoordinationEnabled();
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
    // D3: el run tiene que seguir vivo, sea cual sea la clase de gate. Sin esto,
    // aprobar un `proposal:` de un run ya cancelado volvía a correr los seis
    // efectos —contratar, spawnear, escribir permiso, presupuesto y autoridad—
    // sobre un equipo que la persona ya había apagado.
    const runIdOfGate = gateId.includes(':')
      ? gateId.slice(gateId.indexOf(':') + 1)
      : this.deps.repo.getCoordinationDispatch(gateId).runId;
    this.assertRunMutable(this.deps.repo.getCoordinationRun(runIdOfGate));
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

    // Defensa en profundidad (D12): la frontera IPC ya la valida, pero este
    // método es público y desde acá se contrata gente y se levantan procesos.
    // Y cuando NO hay edición, se valida lo GUARDADO (F4c). Aprobar sin
    // `editedProposalJson` hacía un `JSON.parse(run.planJson!)` a ciegas sobre
    // una fila que pudo haberse escrito antes de que `requestCoordination`
    // validara nada — o quedar ilegible por cualquier otra razón —, y los seis
    // efectos de la aprobación (contratar, spawnear, permiso, presupuesto,
    // autoridad, tareas) corrían sobre eso. Aprobar algo que no se puede leer
    // no es aprobar nada: se rechaza, y la persona ve la tarjeta ilegible con
    // su única acción, "Rechazar".
    if (editedProposalJson != null) requireCoordinationProposal(editedProposalJson);
    else requireCoordinationProposal(run.planJson ?? '');
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
    const hired: Array<{ memberId: string; roleId: string }> = [];
    try {
      for (const hire of proposal.membersToHire ?? []) {
        const session = await this.deps.hub.addMember({ ...this.deps.memberContext(run.workId), roleId: hire.roleId });
        hired.push({ memberId: session.id, roleId: hire.roleId });
      }
      return this.commitProposal(run.id, proposal, budget, hired);
    } catch (error) {
      for (const { memberId } of hired.reverse()) {
        try { this.deps.hub.removeMember(memberId); } catch { /* el rollback nunca tapa el error original */ }
      }
      throw error;
    }
  }

  /** Los cinco efectos restantes de una propuesta aprobada, en una sola transacción real. */
  private commitProposal(runId: string, proposal: CoordinationProposal, budget: CoordinationBudget, hired: Array<{ memberId: string; roleId: string }> = []): CoordinationRunRecord {
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
      const existingBudget = this.requireReadableBudget(run.workId);
      const merged: CoordinationBudget = {
        ...budget,
        maxTokens: existingBudget?.maxTokens ?? budget.maxTokens,
        maxCostMicros: existingBudget?.maxCostMicros ?? budget.maxCostMicros,
        maxWallMinutes: existingBudget?.maxWallMinutes ?? budget.maxWallMinutes,
        // D16: `budget` sale de `requireCoordinationBudget({maxDispatches,
        // unlimitedConfirmedAt})`, o sea que su `maxConcurrent` es SIEMPRE
        // nulo. Sin presupuesto previo, aprobar dejaba el único limitador en
        // vuelo que existe apagado — "sin tope de concurrencia" decidido por
        // omisión, en el camino más común de todos.
        maxConcurrent: existingBudget?.maxConcurrent ?? budget.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
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
      //
      // Y guarda SÓLO lo CONTRATABLE (D11). Congelar acá los roles que ya eran
      // miembros convertía una foto de "qué se puede contratar" en una foto del
      // equipo, y las dos envejecen distinto: el miembro que se borraba después
      // dejaba su rol aprobado para siempre, así que la primera tarea de ese rol
      // lo RE-contrataba en silencio — una contratación que nadie aprobó,
      // autorizada por un miembro que ya no existe. Un rol que ya está en el
      // equipo no necesita aprobación porque no se contrata: se lo reutiliza, y
      // eso `reserveTargetMember` lo resuelve EN VIVO contra el equipo de hoy.
      const approvedRoles = new Set<string>();
      for (const hire of proposal.membersToHire ?? []) approvedRoles.add(hire.roleId);
      this.deps.repo.setMeta(APPROVED_ROLES_META + run.id, JSON.stringify([...approvedRoles]));
      // LAS ALTAS, anotadas donde pasan (D13). `resolveProposalGate` llamaba a
      // `hub.addMember` por cada contratación y no llamaba a `recordHire`
      // NUNCA: la bitácora de un equipo recién aprobado —justo el momento en
      // que más altas hay— no mostraba una sola. Se escriben acá adentro, en la
      // misma transacción que el resto: si la aprobación se va al rollback, las
      // altas se van con ella (y el `catch` de arriba deshace los procesos).
      for (const hire of hired) this.recordHire(run.id, hire.memberId, hire.roleId, now);
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
      // POR FILA (D12). Un `budget_json` ilegible en OTRA marca hacía tirar este
      // `JSON.parse` y con él el `listGates` entero: la persona no podía ni ver
      // —mucho menos aprobar o rechazar— la propuesta de SU Trabajo por culpa
      // de una fila que no es suya. Una fila que no se puede leer no se suma, y
      // eso vuelve el total honestamente desconocido, igual que un ilimitado.
      let budget: CoordinationBudget;
      try {
        budget = JSON.parse(other.budgetJson) as CoordinationBudget;
      } catch {
        otherCommittedDispatches = null;
        break;
      }
      if (budget?.maxDispatches == null) { otherCommittedDispatches = null; break; }
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
    if (run.status === 'cancelled') {
      const tasks = this.deps.repo.listCoordinationTasks(runId);
      const done = tasks.filter((t) => t.status === 'done').length;
      const failed = tasks.filter((t) => t.status === 'failed').length;
      entries.push({
        kind: 'run_cancelled',
        id: `run-cancelled:${run.id}`,
        runId: run.id,
        tasksDone: done,
        // Las `failed` van APARTE (U9). Contarlas como "sin terminar" borraba
        // la diferencia entre una tarea que se intentó y no salió y una que
        // nunca empezó — que es exactamente lo que quien lee la bitácora de un
        // run cancelado necesita para decidir si vuelve a intentarlo.
        tasksFailed: failed,
        tasksPending: tasks.length - done - failed,
        createdAt: run.updatedAt,
      });
    }
    return entries;
  }

  /**
   * Las contrataciones de ESTE run, oldest first: quién se sumó, con qué rol y
   * cuándo. `coordinationHires` estaba testeado en tres archivos del renderer
   * y no lo alimentaba nadie; ésta es su fuente.
   *
   * Un registro ilegible se lee como VACÍO a propósito: una bitácora no puede
   * caerse entera por un meta corrupto. No es el caso del presupuesto —donde
   * ilegible tiene que denegar—, porque acá no se autoriza nada: se cuenta lo
   * que pasó, y lo que no se puede leer simplemente no se cuenta.
   */
  listHires(runId: string): CoordinationHireRecord[] {
    const raw = this.deps.repo.getMeta(HIRES_META + runId);
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    const out: CoordinationHireRecord[] = [];
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null) continue;
      const { memberId, roleId, hiredAt } = row as Record<string, unknown>;
      if (typeof memberId !== 'string' || !memberId) continue;
      if (typeof roleId !== 'string' || !roleId) continue;
      if (typeof hiredAt !== 'string' || !hiredAt) continue;
      out.push({ memberId, roleId, hiredAt });
    }
    return out;
  }

  /** Append-only, idempotente por miembro: re-abrir a alguien ya anotado no lo duplica. */
  private recordHire(runId: string, memberId: string, roleId: string, at: string): void {
    const hires = this.listHires(runId);
    if (hires.some((hire) => hire.memberId === memberId)) return;
    hires.push({ memberId, roleId, hiredAt: at });
    this.deps.repo.setMeta(HIRES_META + runId, JSON.stringify(hires));
  }

  /**
   * Las `latte_ask` todavía sin responder de un run. `listGates` excluye
   * `all_blocked_on_ask` a propósito (una pregunta no es un gate de
   * aprobar/rechazar), así que sin esta lista un run suspendido por una
   * pregunta no tenía ninguna salida en la UI salvo cancelar.
   */
  listOpenAsks(runId: string): CoordinationAskRecord[] {
    // F5: se vence lo vencido ANTES de publicar la lista. Sin esto la pantalla
    // ofrecía preguntas cuyo plazo ya había pasado, y contestarlas no
    // destrababa a nadie.
    this.refreshAsks(runId, this.deps.clock());
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
    const pending = this.deps.repo.getCoordinationAsk(askId);
    this.assertRunMutable(this.deps.repo.getCoordinationRun(pending.runId));
    const now = this.deps.clock();
    const answered = this.deps.repo.answerCoordinationAsk(askId, answer, now);
    // D1: la tarea que esperaba esta respuesta vuelve a la cola. `blocked` es
    // exactamente esto y nada más — "bloqueada por una pregunta" — así que
    // contestarla es su única salida, y tiene que existir de punta a punta.
    // Va PRIMERO: la suspensión se decide sobre el estado de después, no el de
    // antes.
    if (answered.taskId) {
      const task = this.deps.repo.getCoordinationTask(answered.taskId);
      if (task.status === 'blocked') this.deps.repo.updateCoordinationTask(task.id, { status: 'ready', assignedMemberId: null }, now);
    }
    // R4: la suspensión se levanta cuando su MOTIVO deja de ser cierto, con el
    // MISMO cálculo que la decidió (`allBlockedOnAsks`), no por el mero hecho
    // de que alguien contestara algo. Con tres preguntas abiertas, contestar la
    // que no traba ninguna tarea devolvía el run a `running` con todas sus
    // tareas todavía `blocked`: un equipo que dice estar trabajando y no tiene
    // una sola tarea que pueda despachar. Dos fórmulas distintas para entrar y
    // salir del mismo estado es exactamente cómo un run queda atrapado en él.
    const run = this.deps.repo.getCoordinationRun(answered.runId);
    if (run.status === 'suspended' && run.suspendReason === 'all_blocked_on_ask' && !this.allBlockedOnAsks(run.id, now)) {
      this.deps.repo.updateCoordinationRunStatus(run.id, 'running', now, null);
    }
    // Y con la pregunta cerrada, el cierre se re-evalúa: puede haber sido lo
    // único que quedaba en pie (D2).
    this.finishRunIfComplete(run.id, now);
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
  async bridgeHandoffToTask(workId: string, roleId: string, spec: string): Promise<
    | { bridged: false }
    | { bridged: true; task: CoordinationTaskRecord; dispatch: { status: 'dispatched' | 'pending_approval'; dispatchId: string }; reason: null }
    | { bridged: true; task: CoordinationTaskRecord; dispatch: null; reason: string }
  > {
    // Crítico 6: `startDispatch` ya chequeaba la bandera, pero ACÁ abajo —
    // después de que `createTaskRow` ya había escrito la tarea. Con la
    // bandera baja quedaba una tarea huérfana en el run por cada handoff
    // aceptado. El chequeo va antes de escribir, no después.
    this.requireCoordinationEnabled();
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    if (!run) return { bridged: false };
    // R3: Y EL ESTADO DEL RUN, ANTES DE ESCRIBIR NADA. "Activo" incluye
    // `planning` (una propuesta que la persona todavía no aprobó) y
    // `suspended` (un equipo pausado o sin presupuesto). Sobre cualquiera de
    // los dos, `createTaskRow` corría igual y `startDispatch` rebotaba tres
    // saltos más adentro con `COORDINATION_NOT_APPROVED`/`RUN_NOT_ACTIVE`,
    // dejando una tarea `ready` colada en un run que nadie aprobó — que con
    // autoridad `auto` se despacha sola en cuanto el run arranque — y una
    // excepción subiendo hasta la interfaz por haber aceptado un pedido. Sólo
    // un run CORRIENDO acepta trabajo nuevo; con cualquier otro estado esto
    // degrada al borrador de chat, que es exactamente lo que este método
    // promete cuando no hay run.
    if (run.status !== 'running') return { bridged: false };
    // EL MISMO chequeo que `taskCreate` y `planSubmit` (F7). Este camino
    // llamaba a `createTaskRow` directo: la tarea nacía, el despacho moría con
    // `ROLE_NOT_APPROVED` tres saltos más adentro, quedaba una tarea `failed`
    // en la bitácora de la persona y la excepción subía hasta la interfaz por
    // haber aceptado un borrador. Un rol que nadie aprobó no se puede
    // convertir en tarea por ningún camino; el handoff DEGRADA al borrador,
    // que es exactamente lo que este método promete cuando no hay run.
    try {
      this.assertRoleCreatable(run, roleId);
    } catch (error) {
      if (error instanceof LatteError && error.code === 'ROLE_NOT_APPROVED') return { bridged: false };
      throw error;
    }
    const task = this.createTaskRow(run.id, roleId, spec, []);
    // R3: EL PUENTE NO TIRA. La tarea ya está escrita —el run está vivo y la
    // persona la pidió—, así que un despacho denegado (presupuesto agotado,
    // concurrencia al tope, el run que se cayó durante el spawn) no puede
    // salir como excepción hacia la interfaz: el pedido se aceptó de verdad y
    // lo que falló es el paso siguiente. Se devuelve el hecho, con su razón,
    // para que la pantalla diga "tarea creada, todavía sin despachar" en vez de
    // anunciar un despacho que no pasó — o peor, romperse.
    try {
      const outcome = await this.startDispatch({ grant: { workId, runId: run.id, memberId: '', role: 'coordinator' }, taskId: task.id });
      this.touch(workId, run.id);
      return { bridged: true, task: this.deps.repo.getCoordinationTask(task.id), dispatch: { status: outcome.status, dispatchId: outcome.dispatchId }, reason: null };
    } catch (error) {
      this.touch(workId, run.id);
      return {
        bridged: true,
        task: this.deps.repo.getCoordinationTask(task.id),
        dispatch: null,
        reason: error instanceof LatteError ? error.code : 'INTERNAL',
      };
    }
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
    // Y LA FORMA ENTERA, con el MISMO validador que corre sobre la propuesta
    // editada (F4). `estimatedDispatches` era el único campo que se miraba:
    // `plan[].spec`, `plan[].roleId`, `membersToHire[].why` y `rationale`
    // entraban crudos desde `tools/call` —`mcpServer` no valida contra el
    // `inputSchema` que publica— y se guardaban tal cual en `plan_json`. La
    // tarjeta de Decisiones los renderiza como hijos de React, así que un
    // objeto ahí tiraba "Objects are not valid as a React child" y, sin
    // ErrorBoundary, dejaba la app en blanco con el run `planning` ocupando el
    // único cupo del Trabajo. Antes de insertar la fila, no después.
    assertCoordinationProposal(proposal);
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
    // `running`, no "cualquier cosa menos terminal" (D3). Sobre un run
    // `planning` esto pisaba `plan_json` —que ahí adentro guarda la PROPUESTA
    // ENTERA— con una lista pelada de ids: la propuesta que la persona todavía
    // no aprobó se quedaba sin `plan`, sin `membersToHire` y sin `rationale`, y
    // el gate pasaba a mostrar un objeto vacío.
    if (run.status !== 'running') throw new LatteError('RUN_NOT_ACTIVE', `Run is ${run.status}`);
    // TODOS los roles ANTES de crear la primera fila (U10). Validar por tarea
    // dejaría medio plan escrito y el otro medio rechazado: el coordinador
    // cree que mandó un plan entero y la bitácora muestra la mitad.
    for (const spec of tasks) this.assertRoleCreatable(run, spec.roleId);
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
    const run = this.assertRunMutable(this.deps.repo.getCoordinationRun(runId));
    // `running`, el MISMO umbral que `planSubmit` (F6). Sin esto, con el
    // permiso de coordinador escrito por IPC y un run todavía en `planning`,
    // el agente colaba tareas que la persona NO leyó en la propuesta que está
    // por aprobar: aprobaba un plan de tres tareas y el run arrancaba con
    // cinco. Una propuesta que se puede ampliar mientras se la lee no es una
    // propuesta.
    if (run.status !== 'running') throw new LatteError('RUN_NOT_ACTIVE', `Run is ${run.status}`);
    this.assertRoleCreatable(run, input.roleId);
    const task = this.createTaskRow(runId, input.roleId, input.spec, input.dependsOn ?? []);
    this.touch(run.workId, runId);
    return task;
  }

  /**
   * U10: un rol que nadie contrató no llega a ser tarea.
   *
   * El despacho ya lo frenaba (`reserveTargetMember` → `ROLE_NOT_APPROVED`),
   * pero recién ahí: la tarea nacía igual, se quedaba en la cola y terminaba
   * `failed` con una entrada de bitácora por cada rol que el coordinador se
   * inventó. Ensuciar el registro de la persona con trabajo que nunca podía
   * salir es exactamente lo contrario de "nunca mostrar como hecho lo que el
   * motor no confirmó". Se rechaza donde nace.
   *
   * El lookup es EL MISMO que el del despacho, sin una segunda verdad: la foto
   * de CONTRATABLES que congeló la aprobación (D11) más el equipo VIVO de hoy
   * — un rol que ya está en el Trabajo no se contrata, se reutiliza, así que no
   * necesita aprobación.
   */
  private assertRoleCreatable(run: CoordinationRunRecord, roleId: string): void {
    if (this.approvedRoleIds(run).has(roleId)) return;
    if (this.workHasMemberForRole(run.workId, roleId)) return;
    throw new LatteError('ROLE_NOT_APPROVED', `Creating a task for ${roleId} was not part of the approved plan; it needs its own approval`);
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

    // EL PRESUPUESTO SE CONSULTA ANTES DE CONTRATAR (R2). Estos cuatro
    // veredictos —presupuesto legible, concurrencia, tope del Trabajo, tope
    // app-wide— vivían SÓLO dentro de la transacción de abajo, o sea después
    // de `reserveTargetMember` + `hub.addMember`: fila, token, cupo de techo y
    // un PROCESO REAL levantado para un despacho que el tope ya iba a negar. Y
    // la denegación no despedía a nadie. Acá es un pre-chequeo barato,
    // sincrónico, en el MISMO tick en que se reclamó la tarea: nada se reserva
    // todavía, se mira el estado de ahora. Con el tope ya agotado no se
    // contrata a nadie, que es el caso común.
    //
    // NO reemplaza al chequeo de la transacción: entre esta línea y el commit
    // hay un spawn entero, y en esos segundos otro despacho puede consumir lo
    // que quedaba. Éste evita lo evitable; aquél es el que manda.
    //
    // (El diseño pedía además un chequeo barato del ESTADO DEL RUN acá. Sigue
    // sin escribirse, y por la misma razón de siempre: del `getCoordinationRun`
    // de arriba a esta línea no hay un solo `await`, así que releerlo devolvería
    // lo mismo. El presupuesto sí cambia sin que este método espere nada — lo
    // mueven otros despachos y otros runs —, por eso éste vale y aquél no.)
    const preflight = this.judgeDispatchBudget(run, existingPending?.id);
    if (!preflight.ok) {
      this.deps.repo.transaction(() => this.applyDispatchDenial(run.id, task.id, existingPending, now, preflight));
      this.touch(run.workId, run.id);
      throw preflight.error;
    }

    let session: Awaited<ReturnType<AgentHub['openMember']>>;
    // La elección del miembro y su reserva pasan en el MISMO tick (ver
    // `assigning`); lo lento —levantar el proceso— viene después.
    let reservedMemberId: string | null = null;
    // La clave de la reserva: el id del miembro reutilizado, o la del ROL que
    // se está contratando (D10). Se suelta siempre en el `finally` de abajo.
    let reservationKey: string | null = null;
    try {
      const target = this.reserveTargetMember(run.workId, task.roleId, this.approvedRoleIds(run));
      reservedMemberId = target.reuseMemberId;
      reservationKey = target.reservationKey;
      session = await (target.reuseMemberId
        ? this.deps.hub.openMember(target.reuseMemberId, target.context)
        : this.deps.hub.addMember({ ...target.context, roleId: task.roleId }));
    } catch (error) {
      if (reservationKey) this.assigning.delete(reservationKey);
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
      // A PARTIR DE ACÁ `live.status` ES `'running'`, SIEMPRE. De acá al final
      // de esta función no hay un solo `await` —es el cuerpo de una
      // transacción sincrónica—, así que nadie puede cambiarlo en el medio.
      // Las cuatro suspensiones de abajo llevaban cada una su
      // `if (live.status === 'running')` adelante: cuatro ramas que no
      // protegían nada y que se leían como si protegieran algo. Si alguna vez
      // aparece un `await` acá adentro, esta invariante deja de valer y hay
      // que releer el run, no volver a poner el `if`.
      // LA CONFIRMACIÓN del presupuesto, sobre el run RELEÍDO: un
      // `setCoordinationBudget` que entró mientras se levantaba el proceso ya
      // escribió el snapshot nuevo, y despachar contra la foto vieja es la
      // misma causa raíz de siempre. El pre-chequeo de arriba evita contratar
      // cuando el tope YA estaba agotado; éste es el que manda, porque otro
      // despacho pudo consumir el último cupo durante el spawn.
      const verdict = this.judgeDispatchBudget(live, existingPending?.id);
      if (!verdict.ok) {
        this.applyDispatchDenial(run.id, task.id, existingPending, now, verdict);
        return { ok: false, error: verdict.error };
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
      // LA CONTRATACIÓN, anotada donde pasa. `coordinationHires` estaba
      // testeado en tres archivos del renderer y no lo alimentaba NADIE, así
      // que la bitácora no mostró jamás una sola alta. Se escribe acá adentro,
      // en la misma transacción sincrónica que commitea el despacho: si el
      // despacho se va al rollback, la contratación que nunca se usó se va con
      // él. `reservedMemberId` null significa que el camino fue `addMember`,
      // o sea que este miembro no existía hasta hace un segundo.
      if (reservedMemberId == null) this.recordHire(run.id, session.id, task.roleId, now);
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
        // R2: y la contratación también se deshace. Un throw de adentro deja
        // exactamente el mismo miembro sobrante que una denegación.
        this.compensateHire(reservedMemberId, session.id, run.id, task.roleId, now);
        throw error;
      }
      if (!outcome.ok) {
        // R2: la transacción dijo que no, así que el miembro que se contrató
        // PARA ESTE despacho sobra. `resolveProposalGate` ya compensaba así
        // desde siempre; acá no compensaba nadie, y cada denegación dejaba una
        // fila, un token, un cupo de techo y un proceso vivo para nadie.
        this.compensateHire(reservedMemberId, session.id, run.id, task.roleId, now);
        throw outcome.error;
      }
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
      if (reservationKey) this.assigning.delete(reservationKey);
    }
  }

  /**
   * "¿Entra un despacho más?", sin reservar nada (R2). Los CUATRO veredictos
   * —presupuesto legible, concurrencia, tope del Trabajo, tope app-wide— en un
   * solo lugar, para que el pre-chequeo barato de antes del spawn y la
   * confirmación de adentro de la transacción no puedan divergir: dos fórmulas
   * distintas para la misma pregunta es exactamente cómo se cuela un despacho
   * que un tope tenía que negar.
   *
   * Es una lectura pura de la base: no escribe una sola fila. Quien decide qué
   * hacer con el "no" es `applyDispatchDenial`.
   *
   * `suspend:false` sólo para `max_concurrent`: chocar contra la concurrencia
   * no agota nada, es un "ahora no" que se resuelve solo en cuanto termine
   * alguno de los que están en vuelo. Suspender el run por eso lo dejaría
   * esperando una decisión humana que no hace falta tomar.
   */
  private judgeDispatchBudget(
    run: CoordinationRunRecord,
    excludeDispatchId: string | undefined,
  ): { ok: true } | { ok: false; reason: string; suspend: boolean; error: LatteError } {
    // Ilegible NO es "sin presupuesto", y tampoco es una excepción opaca desde
    // el fondo de la pila: es una denegación con nombre, que se lee en la
    // bitácora y en la suspensión como cualquier otra (crítico 8).
    const budgetRead = readStoredCoordinationBudget(run.budgetJson);
    if (budgetRead.kind !== 'set') {
      return {
        ok: false, reason: 'budget_invalid', suspend: true,
        error: new LatteError('COORDINATION_BUDGET_INVALID', "This run's budget cannot be read; set the Work's budget again before dispatching."),
      };
    }
    const budget = budgetRead.budget;
    const inFlight = this.countInFlightDispatches(run.id, excludeDispatchId);
    if (budget.maxConcurrent != null && inFlight >= budget.maxConcurrent) {
      return { ok: false, reason: 'max_concurrent', suspend: false, error: new LatteError('MAX_CONCURRENT', 'Too many dispatches are already in flight') };
    }
    const decision = reserveDispatch(budget, this.usageFor(run.id));
    if (!decision.ok) {
      return { ok: false, reason: decision.reason, suspend: true, error: new LatteError('BUDGET_EXCEEDED', `Coordination budget denied: ${decision.reason}`) };
    }
    // El tope app-wide (task 6.35), en el MISMO choke point que el del Trabajo:
    // se guardaba en meta y no lo leía nadie, así que la persona que ponía 40
    // no tenía tope ninguno. Suspende sólo al run que chocó. Ilegible tampoco
    // es "sin tope": un dato roto DENIEGA (crítico 8).
    const globalBudget = this.readGlobalBudget();
    if (globalBudget.kind === 'invalid') {
      return {
        ok: false, reason: 'global_budget_invalid', suspend: true,
        error: new LatteError('GLOBAL_BUDGET_INVALID', 'The app-wide dispatch cap could not be read; fix it in Settings before dispatching again.'),
      };
    }
    if (globalBudget.kind === 'set') {
      const globalDecision = reserveDispatch(globalBudget.budget, this.globalUsage());
      if (!globalDecision.ok) {
        const reason = `global_${globalDecision.reason}`;
        return { ok: false, reason, suspend: true, error: new LatteError('BUDGET_EXCEEDED', `Coordination budget denied: ${reason}`) };
      }
    }
    return { ok: true };
  }

  /**
   * El "no" del presupuesto, anotado donde se anotan todos: un asiento
   * `denied` en el libro mayor, la suspensión del run cuando corresponde, y el
   * reclamo soltado con el despacho resuelto en contra.
   *
   * NO abre transacción: los dos llamadores ya están adentro de una (la
   * confirmación por estar dentro de `runTransaction`, el pre-chequeo porque la
   * abre él). `repo.transaction` es un `BEGIN` pelado y SQLite no anida.
   */
  private applyDispatchDenial(
    runId: string,
    taskId: string,
    existingPending: CoordinationDispatchRecord | null,
    now: string,
    verdict: { reason: string; suspend: boolean },
  ): void {
    this.writeLedgerDenied(runId, verdict.reason);
    if (verdict.suspend) this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, verdict.reason);
    this.abortDispatchClaim(taskId, existingPending, now, verdict.reason);
  }

  /**
   * Deshace la contratación que este despacho hizo y no va a usar (R2).
   *
   * Sólo cuando el miembro se contrató PARA ESTE despacho: `reservedMemberId`
   * no nulo significa que se REUTILIZÓ a alguien que ya estaba en el equipo, y
   * a ése no lo despide un despacho que no salió. `hub.removeMember` es la
   * misma compensación que `resolveProposalGate` usa desde siempre: para el
   * proceso, suelta el cupo de techo y el token, y borra la fila.
   *
   * Si la compensación FALLA, el alta se registra igual. El miembro sigue
   * vivo, así que ocultarlo dejaría un proceso contratado que ninguna bitácora
   * nombra — y la bitácora existe justamente para que la persona pueda ver lo
   * que hay. La verdad manda por encima de la prolijidad del registro.
   */
  private compensateHire(reservedMemberId: string | null, memberId: string, runId: string, roleId: string, now: string): void {
    if (reservedMemberId != null) return; // se reutilizó a alguien del equipo: no se contrató nada que deshacer
    try {
      this.deps.hub.removeMember(memberId);
    } catch {
      try {
        this.recordHire(runId, memberId, roleId, now);
      } catch { /* si ni siquiera se puede anotar, no hay nada más honesto que hacer acá */ }
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
   * La tarea de un rol sin aprobar: `failed` con outcome `role_not_approved`,
   * y eso es TERMINAL (D1). La persona rechazó esa contratación: esa tarea no
   * corre en este run, punto. Antes quedaba `blocked` —no terminal— y el run
   * no podía cerrarse nunca, esperando una intervención que la interfaz ni
   * siquiera ofrece. El coordinador recibe `ROLE_NOT_APPROVED` en el resultado
   * de su tool y puede re-planificar con tareas de otro rol; el run ya no
   * queda rehén de la decisión que la persona YA tomó.
   *
   * La razón se anota donde se anotan todas — una fila de
   * `coordination_dispatch` resuelta en contra, exactamente como
   * `abortDispatchClaim` anota una denegación de presupuesto. Nada de esto
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
      this.deps.repo.updateCoordinationTask(task.id, { status: 'failed', assignedMemberId: null }, now);
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
    // Y si era la última, el run cierra: una tarea terminal SIEMPRE pasa por el
    // punto único de cierre, venga de un reporte o de un rol sin aprobar.
    this.finishRunIfComplete(run.id, now);
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
    // El barrido de vencimientos corre ACÁ, en el único punto por el que pasa
    // todo cierre: al arrancar la app y en cada reporte. Una pregunta vencida
    // sólo se consultaba (`askStatus`), así que nadie destrababa nunca la tarea
    // que esperaba por ella.
    this.refreshAsks(runId, now);
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    if (tasks.length === 0) return;
    if (!tasks.every((t) => t.status === 'done' || t.status === 'failed')) return;
    // Una pregunta abierta es trabajo pendiente de la PERSONA. Cerrar el run
    // con una sobre la mesa la deja contestando algo que ya no le va a llegar a
    // nadie, y borra la única pista de por qué el equipo se detuvo.
    if (this.openAsksHolding(runId, now).length > 0) return;
    // Un despacho o una reserva todavía abiertos son trabajo en vuelo: la foto
    // de las tareas puede estar adelantada respecto de la contabilidad.
    const open = this.deps.repo.listCoordinationDispatches(runId).some((d) => d.status === 'dispatched' || d.status === 'running');
    if (open) return;
    if (this.deps.repo.countOpenCoordinationCostReservations(runId) > 0) return;
    // D17: el coordinador puede estar en medio de un turno — leyendo el último
    // resultado y por crear la tarea que sigue. Cerrarle el run abajo convierte
    // su próximo `latte_task_create` en un `NO_ACTIVE_RUN` y le come el trabajo
    // que estaba por encargar. La única mitigación que había era una frase en
    // `strategist.md`, o sea una promesa del prompt, no una garantía del motor.
    if (this.coordinatorIsMidTurn(run)) {
      this.pendingClose.add(runId);
      return;
    }
    this.pendingClose.delete(runId);
    this.closeRun(runId, 'done', now);
  }

  /**
   * El cierre, con las dos limpiezas que todo final necesita.
   *
   * `coordination_coordinator:<workId>` se BORRA: el permiso se concedió para
   * ESTE run. Arrastrarlo al siguiente hacía que un miembro cualquiera
   * amaneciera coordinador de un run que nadie le confió — `resolveGrant` lee
   * ese meta fresco en cada request, sin mirar de qué run venía.
   */
  private closeRun(runId: string, status: 'done' | 'cancelled', now: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    this.deps.repo.setMeta('coordination_coordinator:' + run.workId, '');
    this.pendingClose.delete(runId);
    return this.deps.repo.updateCoordinationRunStatus(runId, status, now, null);
  }

  /**
   * Si el miembro coordinador está respondiendo AHORA. La señal la da el
   * adaptador (`isBusy`), que es el único que sabe si hay un turno en vuelo; un
   * runtime que no la publique se lee como "no está ocupado" y el run cierra
   * como cerraba antes — nunca se inventa una espera.
   */
  private coordinatorIsMidTurn(run: CoordinationRunRecord): boolean {
    const coordinatorId = run.coordinatorMemberId || this.deps.repo.getMeta('coordination_coordinator:' + run.workId);
    if (!coordinatorId) return false;
    try {
      return this.deps.hub.isMemberBusy(coordinatorId);
    } catch {
      return false; // un miembro que ya no existe no está en ningún turno
    }
  }

  /**
   * El turno del coordinador terminó: si el cierre había quedado pendiente por
   * él, se vuelve a evaluar. Y se re-evalúa DE VERDAD, no se cierra a ciegas:
   * si en ese turno creó una tarea nueva, `finishRunIfComplete` la ve y el run
   * sigue vivo con ella.
   *
   * F1: se re-evalúa TODO lo pendiente, no sólo lo que esperaba a ESTE miembro.
   * El filtro por coordinador comparaba contra `run.coordinatorMemberId` o el
   * meta, dos cosas que pueden estar vacías o desfasadas (un run arrancado sin
   * coordinador, el permiso movido a otro miembro a mitad de camino), y un
   * cierre que no le "pertenecía" a nadie no se destrababa nunca. Re-evaluar de
   * más es gratis y no puede cerrar nada de menos: `finishRunIfComplete` vuelve
   * a mirar tareas, despachos, reservas y el turno del coordinador, y si
   * todavía está ocupado el run se vuelve a aparcar igual.
   */
  noteTurnEnded(memberId: string): void {
    if (!memberId || this.pendingClose.size === 0) return;
    // Se recorre lo PENDIENTE, no el miembro: `findMember` no sirve acá (el
    // coordinador puede no tener fila propia). Como mucho hay un puñado.
    const now = this.deps.clock();
    for (const runId of [...this.pendingClose]) {
      let run: CoordinationRunRecord;
      try {
        run = this.deps.repo.getCoordinationRun(runId);
      } catch {
        this.pendingClose.delete(runId);
        continue;
      }
      this.finishRunIfComplete(runId, now);
      this.touch(run.workId, run.id);
    }
  }

  /** Las preguntas que TODAVÍA retienen el cierre: sin responder y sin vencer. Una vencida ya no espera a nadie. */
  private openAsksHolding(runId: string, now: string): CoordinationAskRecord[] {
    return this.deps.repo.listOpenCoordinationAsks(runId).filter((ask) => ask.deadlineAt > now);
  }

  /**
   * Una pregunta vencida devuelve su tarea a la cola Y SE CIERRA (F5).
   *
   * Cerrarla no era un detalle contable: `listOpenCoordinationAsks` filtra
   * sólo por `answered_at IS NULL`, así que una pregunta vencida seguía
   * publicándose en la pantalla —la persona podía contestar algo que ya no
   * esperaba nadie— y `maybeSelfSuspendOnAsks` la seguía contando como
   * bloqueo, con lo cual la pregunta SIGUIENTE suspendía el run entero aunque
   * hubiera tareas `ready` para despachar. Se cierra sin respuesta: nadie
   * contestó, y eso es exactamente lo que queda escrito.
   */
  private expireOverdueAsks(runId: string, now: string): number {
    let expired = 0;
    for (const ask of this.deps.repo.listOpenCoordinationAsks(runId)) {
      if (ask.deadlineAt > now) continue;
      this.deps.repo.expireCoordinationAsk(ask.id, now);
      expired += 1;
      if (!ask.taskId) continue;
      const task = this.deps.repo.getCoordinationTask(ask.taskId);
      if (task.status === 'blocked') this.deps.repo.updateCoordinationTask(task.id, { status: 'ready', assignedMemberId: null }, now);
    }
    return expired;
  }

  /**
   * El barrido de vencimientos MÁS su consecuencia: un run que se auto-suspendió
   * porque TODO estaba esperando respuestas vuelve a `running` cuando esas
   * respuestas ya no pueden llegar (F5).
   *
   * Antes el barrido vivía sólo adentro de `finishRunIfComplete`, y a un run
   * `suspended` por `all_blocked_on_ask` no lo llama nadie: ni un reporte (no
   * hay despachos en vuelo), ni un despacho (el run no está `running`). El
   * equipo quedaba detenido hasta el próximo arranque de la app, con sus tareas
   * listas y su plazo vencido hacía horas. Por eso corre también en las
   * lecturas por IPC (`listGates`, `listOpenAsks`) y al reanudar: son los tres
   * momentos en los que alguien vuelve a mirar ese run.
   *
   * Es idempotente y barato: sin preguntas abiertas no escribe una sola fila.
   *
   * R4: devuelve CUÁNTAS cerró, y si cerró alguna vuelve a preguntarse si el
   * run terminó. Vencer una pregunta es un cambio de estado como cualquier
   * otro: un run con todas sus tareas terminales y una única pregunta abierta
   * se queda `running` justamente PORQUE esa pregunta lo retiene, así que el
   * momento en que deja de retenerlo es exactamente el momento en que hay que
   * volver a mirar. Sin esto, el run seguía `running` hasta el próximo
   * arranque de la app — ocupando un cupo app-wide, con todo su trabajo hecho.
   */
  private refreshAsks(runId: string, now: string): number {
    const expired = this.expireOverdueAsks(runId, now);
    const run = this.deps.repo.getCoordinationRun(runId);
    // La suspensión se levanta cuando su MOTIVO deja de ser cierto, no sólo
    // cuando no queda ninguna pregunta: con una pregunta vigente sobre una
    // tarea y otra tarea `ready` para despachar, "todo bloqueado" ya es falso.
    if (run.status === 'suspended' && run.suspendReason === 'all_blocked_on_ask' && !this.allBlockedOnAsks(runId, now)) {
      this.deps.repo.updateCoordinationRunStatus(runId, 'running', now, null);
    }
    // Y el cierre. La recursión termina en un paso: `finishRunIfComplete`
    // vuelve a entrar acá, pero ya no queda nada vencido que cerrar, así que
    // `expired` es cero y no reentra.
    if (expired > 0) this.finishRunIfComplete(runId, now);
    return expired;
  }

  /**
   * "Todo lo despachable está esperando una respuesta". El MISMO cálculo que
   * decide suspender y que decide levantar la suspensión: dos fórmulas
   * distintas para entrar y salir del mismo estado es exactamente cómo un run
   * queda atrapado en él.
   */
  private allBlockedOnAsks(runId: string, now: string): boolean {
    // Sólo las VIGENTES retienen: una vencida no espera a nadie.
    const openAsks = this.openAsksHolding(runId, now);
    if (openAsks.length === 0) return false;
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    const blockedTaskIds = new Set(openAsks.map((a) => a.taskId).filter((id): id is string => id != null));
    // `blocked` entra en la cuenta: desde D1 ese estado significa exactamente
    // "esperando una respuesta", que es justo lo que este chequeo mide. Sin
    // incluirlo, la tarea que la pregunta acaba de trabar desaparecía del
    // conjunto y el run nunca se auto-suspendía.
    const readyEligible = tasks.filter((t) => t.status === 'ready' || t.status === 'blocked' || t.status === 'dispatched' || t.status === 'running');
    return readyEligible.length > 0 && readyEligible.every((t) => blockedTaskIds.has(t.id));
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
    // D1: la tarea que la pregunta traba pasa a `blocked` — el ÚNICO
    // significado que le queda a ese estado. Sólo desde `ready`/`pending`: una
    // tarea ya despachada sigue en vuelo y su reporte tiene que poder entrar;
    // moverla acá le sacaría la fila de despacho de abajo.
    if (taskId) {
      const task = this.deps.repo.getCoordinationTask(taskId);
      if (task.runId === grant.runId && (task.status === 'ready' || task.status === 'pending')) {
        this.deps.repo.updateCoordinationTask(task.id, { status: 'blocked', assignedMemberId: null }, now);
      }
    }
    this.maybeSelfSuspendOnAsks(grant.runId, now);
    this.touch(grant.workId, grant.runId);
    return ask;
  }

  /** A synchronous poll of one ask: never blocks. Past its deadline and still unanswered, it reports `{answered:false, deadline}` rather than hanging. */
  askStatus(askId: string): { answered: boolean; answer?: string | null; deadline: string } {
    const ask = this.deps.repo.getCoordinationAsk(askId);
    // F5: `answeredAt` con `answer` en `null` es una pregunta CERRADA POR
    // VENCIMIENTO, no una respondida. Decir `answered:true` con la respuesta en
    // `null` le haría creer al agente que la persona contestó y no dijo nada.
    if (ask.answeredAt && ask.answer !== null) return { answered: true, answer: ask.answer, deadline: ask.deadlineAt };
    return { answered: false, deadline: ask.deadlineAt };
  }

  /** Crash/death settlement. `incrementAttempts:false` for an app-restart crash (not the agent's fault); `true` for a member-process death (a real failure). */
  settleUncertain(dispatchId: string, opts: { incrementAttempts: boolean }): CoordinationDispatchRecord {
    const dispatch = this.deps.repo.getCoordinationDispatch(dispatchId);
    const now = this.deps.clock();
    // Las escrituras van juntas, por lo mismo que en `report`: cerrar la
    // reserva sin asentar el gasto vuelve el despacho invisible para el tope.
    const outcome = this.deps.repo.transaction(() => {
      // El asiento se escribe SÓLO si el CAS de la reserva ganó (D6). Dos
      // cierres de la misma reserva no son hipotéticos: la muerte de un proceso
      // y el barrido de cancelación llegan por caminos distintos y pueden
      // pisarse. El UPDATE lleva `AND state='reserved'`, así que el segundo no
      // cierra nada — pero el asiento se escribía igual, y el despacho quedaba
      // cobrado dos veces contra el presupuesto de la persona y contra el tope
      // app-wide, para siempre (el libro mayor es append-only por trigger).
      if (dispatch.reservationId && this.deps.repo.settleCoordinationCostReservation(dispatch.reservationId, null, now, true)) {
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
  settleMemberDispatches(memberId: string, options: { incrementAttempts?: boolean } = {}): number {
    if (!memberId) return 0;
    const incrementAttempts = options.incrementAttempts ?? true;
    const open = this.deps.repo.listOpenCoordinationDispatches().filter((d) => d.memberId === memberId);
    for (const dispatch of open) {
      const run = this.deps.repo.getCoordinationRun(dispatch.runId);
      this.settleUncertain(dispatch.id, { incrementAttempts });
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
    // D1: la dependencia caída CONDENA, no bloquea. `blocked` no era terminal,
    // así que un run con una tarea condenada quedaba vivo para siempre
    // esperando una intervención imposible: nadie destraba una dependencia
    // `failed`. Hoy la tarea termina `failed`, con la razón escrita en la
    // bitácora — igual que cualquier otro final — y el run puede cerrarse.
    const doomed = new Set(computeDoomedTasks(dagTasks, edges));
    for (const task of tasks) {
      if (!doomed.has(task.id)) continue;
      if (task.status !== 'pending' && task.status !== 'ready' && task.status !== 'blocked') continue;
      this.deps.repo.updateCoordinationTask(task.id, { status: 'failed', assignedMemberId: null }, now);
      this.writeTerminalDispatchRow(runId, task, 'dependency_failed', 'Una dependencia de esta tarea terminó fallada: no va a poder correr.', now);
    }
  }

  /**
   * El final de una tarea que nunca llegó a despacharse, anotado donde se
   * anotan todos: una fila de `coordination_dispatch` ya resuelta. Sin miembro,
   * sin reserva, `settled_at` en el acto — no contrata ni gasta. Es la única
   * forma de que la bitácora (derivada de esa tabla) pueda explicar por qué una
   * tarea terminó sin que nadie la trabajara.
   */
  private writeTerminalDispatchRow(runId: string, task: CoordinationTaskRecord, outcome: string, summary: string, now: string): void {
    const attempt = this.deps.repo.listCoordinationDispatches(runId).filter((d) => d.taskId === task.id).length + 1;
    this.deps.repo.insertCoordinationDispatch({
      id: newId('cdp'), runId, taskId: task.id, memberId: '', attempt, status: 'cancelled',
      gateId: null, prompt: task.spec, outcome, summary, filesJson: null, reservationId: null,
      createdAt: now, startedAt: null, settledAt: now,
    });
  }

  private maybeSelfSuspendOnAsks(runId: string, now: string): void {
    // F5: lo vencido se vence PRIMERO. Contando preguntas cuyo plazo ya pasó,
    // la pregunta siguiente —perfectamente legítima— suspendía el run entero
    // aunque las tareas de las viejas ya hubieran vuelto a `ready`: el equipo
    // se paraba por un bloqueo que ya no existía.
    this.refreshAsks(runId, now);
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running') return;
    if (this.allBlockedOnAsks(runId, now)) this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, 'all_blocked_on_ask');
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

  /**
   * El presupuesto de ESTE Trabajo, por el MISMO parser que alimenta la
   * pantalla. Antes hacía `JSON.parse` a mano y devolvía `null` ante bytes
   * ilegibles: "no se pudo leer" salía por la misma puerta que "nunca se
   * configuró", así que `startRun` fallaba con `BUDGET_UNSET` —"no hay
   * presupuesto"— sobre un presupuesto que SÍ existe y está roto, y la
   * pantalla decía lo mismo. Tres estados, uno por cada cosa que puede pasar.
   */
  private readBudget(workId: string): StoredCoordinationBudgetRead {
    return readStoredCoordinationBudget(this.deps.repo.getMeta('coordination_budget:' + workId));
  }

  /** El presupuesto configurado, o `null` si no hay ninguno. Ilegible TIRA: nunca se degrada a "no hay". */
  private requireReadableBudget(workId: string): CoordinationBudget | null {
    const read = this.readBudget(workId);
    if (read.kind === 'invalid') throw new LatteError('COORDINATION_BUDGET_INVALID', "This Work's budget cannot be read; set it again before coordinating.");
    return read.kind === 'set' ? read.budget : null;
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
  private readGlobalBudget(): StoredCoordinationBudgetRead {
    return readStoredCoordinationBudget(this.deps.repo.getMeta('coordination_budget_global'));
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
  /**
   * Si el Trabajo TIENE hoy un miembro de este rol (D11). El lookup es EN VIVO,
   * contra el equipo de ahora, y no contra la foto que la aprobación congeló:
   * un rol que ya está en el equipo no se contrata, se reutiliza, así que no
   * necesita aprobación — pero si ese miembro se borró, el rol vuelve a
   * necesitarla, y la foto vieja no puede seguir autorizándolo.
   *
   * Los terminados (`done`) no cuentan: re-abrir uno SÍ es una contratación.
   */
  private workHasMemberForRole(workId: string, roleId: string): boolean {
    try {
      return this.deps.repo.listMembers(workId).some((m) => m.roleId === roleId && !m.done);
    } catch {
      return false;
    }
  }

  private reserveTargetMember(workId: string, roleId: string, approvedRoles: Set<string> | null = null): { reuseMemberId: string | null; reservationKey: string; context: MemberContext } {
    // LA RESERVA DE CONTRATACIÓN SE MIRA PRIMERO (D10). `hub.addMember` inserta
    // la fila ANTES de terminar de levantar el proceso, así que un segundo
    // despacho del mismo rol ya ve al recién contratado en `listTeam`, ocioso y
    // sin reservar — y se lo lleva puesto: dos tareas asignadas a la misma
    // persona y el segundo `hub.send` pisando al primero. Mientras una
    // contratación de este rol está en vuelo, ningún otro despacho del mismo rol
    // arranca; la tarea vuelve intacta a `ready` y el intento siguiente
    // encuentra al miembro nuevo ya asentado y disponible.
    const hireKey = 'hire:' + workId + '|' + roleId;
    if (this.assigning.has(hireKey)) {
      throw new LatteError('MEMBER_BUSY', `A ${roleId} is already being hired for this Work; retry once it is up`);
    }
    const team = this.deps.hub.listTeam(workId);
    const candidates = team.filter((m) => m.roleId === roleId && m.status !== 'ended');
    // Un miembro que otro despacho ya eligió cuenta como ocupado: va a estarlo
    // en cuanto termine de levantarse. Sin esto, dos despachos concurrentes del
    // mismo rol elegían al mismo y el segundo `hub.send` pisaba al primero.
    const idle = candidates.find((m) => m.status !== 'working' && !this.assigning.has(m.id));
    if (candidates.length > 0 && !idle) throw new LatteError('MEMBER_BUSY', `Every ${roleId} member is already working`);
    if (candidates.length === 0 && approvedRoles && !approvedRoles.has(roleId) && !this.workHasMemberForRole(workId, roleId)) {
      throw new LatteError('ROLE_NOT_APPROVED', `Hiring a ${roleId} was not part of the approved plan; it needs its own approval`);
    }
    // La reserva de la contratación se TOMA acá, en el mismo tick de la
    // decisión: el argumento viejo de que "una contratación no se reserva
    // porque su id todavía no existe" miraba el problema al revés — el riesgo
    // no es colisionar por id, es contratar DOS VECES. Dos `latte_dispatch` del
    // mismo rol sin miembro veían los dos `candidates` vacío y llamaban los dos
    // a `hub.addMember`: dos filas, dos tokens, dos cupos de techo y DOS
    // PROCESOS reales para un rol que la persona aprobó una vez. La clave es
    // por ROL y lleva prefijo, así que no puede chocar con ningún id de miembro.
    //
    // F3: el CONTEXTO se resuelve ANTES de reservar. `memberContext` hace I/O
    // de disco y puede tirar, y cuando tiraba la reserva ya estaba tomada
    // mientras el llamador todavía no había copiado la clave en
    // `reservationKey` (sigue `null` hasta que este método RETORNA): ni su
    // `catch` ni su `finally` la soltaban, así que el rol quedaba en
    // `MEMBER_BUSY` para el resto de la sesión por un fallo transitorio. Lo
    // que puede fallar falla antes de haber tomado nada.
    const context = this.deps.memberContext(workId);
    // Y la reserva propiamente dicha, en su propio try: si alguna vez algo
    // entre tomarla y devolverla llega a tirar, se suelta acá — el llamador
    // todavía no tiene la clave y no puede soltarla por él.
    const reservationKey = idle?.id ?? hireKey;
    try {
      // SINCRÓNICO, en el mismo tick de la elección: el llamador recién después
      // espera al spawn, y suelta la reserva en su `finally`.
      this.assigning.add(reservationKey);
      return { reuseMemberId: idle?.id ?? null, reservationKey, context };
    } catch (error) {
      this.assigning.delete(reservationKey);
      throw error;
    }
  }
}
