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
import { isAskSuspendReason } from '../../shared/contracts';
import { taskTitle, TASK_TITLE_LONG, TASK_TITLE_STORED } from '../../shared/taskTitle';
import type { CoordinationSuspendReason } from '../../shared/contracts';

/** Lo que un despacho denegado puede alegar: todo motivo de suspensión, más el "ahora no" de la concurrencia, que NO suspende. */
type DispatchDenyReason = CoordinationSuspendReason | 'max_concurrent';
import { LatteError, NotFoundError, ValidationError } from '../core/errors';
import { FeatureDisabledError } from '../core/features';
import { newId } from '../core/ids';
import { assertCoordinationProposal, LIMITS, requireCoordinationProposal, requireInt, requireText } from '../services/validation';
import type {
  CoordinationAskRecord,
  CoordinationDispatchRecord,
  CoordinationMessageRecord,
  CoordinationRunRecord,
  CoordinationTaskClaim,
  CoordinationTaskRecord,
  LatteRepository,
} from '../storage/repository';
import { canAddTask, computeDoomedTasks, computeReadyTasks, computeTaskDepth, wouldCreateCycle, type DagEdge, type DagTask } from './dag';
import { assertBudgetConfigured, BudgetUnsetError, readStoredCoordinationBudget, requireCoordinationBudget, reserveDispatch, type BudgetUsage, type StoredCoordinationBudgetRead } from './budget';
import { ASK_TTL_DEFAULT_MINUTES, ASK_TTL_MAX_MINUTES, DEFAULT_MAX_CONCURRENT, IN_FLIGHT_DISPATCH_STALE_MINUTES, LOG_PREVIEW, MAX_ACTIVE_COORDINATION_RUNS, MAX_ATTEMPTS_PER_TASK, MAX_CALLED_UP_MEMBERS_PER_RUN, MAX_PENDING_NOTICES, TASK_LIST_SPEC_PREVIEW } from './limits';

/**
 * Los roles que la persona aprobo, por run. Una clave propia y no `plan_json`:
 * ese campo lo reescribe `latte_plan_submit` (juicio #3, ronda 4). El
 * precedente es `coordination_authority:` / `coordination_budget:` -- meta,
 * nunca una columna nueva (SCHEMA_VERSION se queda en '12').
 */
const APPROVED_ROLES_META = 'coordination_approved_roles:';
/** Las altas de ESTE run, en meta (como `decisionAuthority`): sin subir de versión de esquema. */
const HIRES_META = 'coordination_hires:';
/** H1: el run nació de un traspaso (una propuesta que Latte armó por un agente). Aprobarlo despacha solo. */
const HANDOFF_RUN_META = 'coordination_handoff_run:';
/**
 * R3: EL PEDIDO, GUARDADO AL APROBAR.
 *
 * El encabezado del run mostraba el nombre del Trabajo porque el texto del
 * pedido no sobrevivía a la aprobación: vivía adentro del JSON de la
 * propuesta y la propuesta se consume. Va en la MISMA mesa de `meta` donde ya
 * viven las altas del run (`HIRES_META`), así que no hace falta migrar el
 * esquema para algo que es un título.
 */
const REQUEST_META = 'coordination_request:';
/** Un título, no el pedido entero: entra en una línea de encabezado. */
export const COORDINATION_REQUEST_MAX = 100;

export function coordinationRequestMetaKey(runId: string): string {
  return REQUEST_META + runId;
}

/**
 * El pedido en una línea: el `rationale` de la propuesta (que es lo que el
 * coordinador escribió al pedir) y, si viniera vacío, el `spec` de la primera
 * tarea. Devuelve `''` cuando no hay de dónde sacarlo — y entonces no se
 * guarda nada, porque un pedido inventado es peor que ninguno.
 */
export function coordinationRequestTitle(proposal: Pick<CoordinationProposal, 'rationale' | 'plan'>): string {
  // N2: con la MISMA regla que el título de una tarea: el bloque de contexto
  // con el que el coordinador arranca no es el pedido.
  const rationale = typeof proposal.rationale === 'string' ? taskTitle(proposal.rationale, null, Number.MAX_SAFE_INTEGER) : '';
  const first = proposal.plan?.[0];
  const line = rationale || (first && typeof first.spec === 'string' ? taskTitle(first.spec, first.title, Number.MAX_SAFE_INTEGER) : '');
  if (line.length <= COORDINATION_REQUEST_MAX) return line;
  // El recorte deja lugar para el puntito: el tope es del texto que se
  // guarda, no del texto antes de adornarlo.
  return line.slice(0, COORDINATION_REQUEST_MAX - 1).trimEnd() + '…';
}

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

/**
 * Lo que un miembro ve cuando llama a `latte_check`: su buzón (lo que le
 * escribieron y no leyó) y el estado del run. Los dos juntos porque las dos
 * preguntas son la misma — "¿hay algo para mí y cómo viene la mano?" — y una
 * herramienta que devuelve la mitad obliga a un segundo sondeo.
 *
 * `run: null` es el miembro sin run activo, no un run vacío.
 */
export interface CoordinationCheckResult {
  run: {
    status: CoordinationRunRecord['status'];
    tasks: { ready: number; dispatched: number; done: number; failed: number; blocked: number; pending: number };
  } | null;
  messages: Array<{
    id: string;
    /** `null` sólo para un mensaje que escribió Latte, no un miembro. */
    from: { memberId: string; roleId: string } | null;
    text: string;
    createdAt: string;
  }>;
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
  /** Only present on a legible `proposal` gate: who can do each role the plan names. */
  roleCoverage?: CoordinationGateRoleCoverage[];
  /**
   * Only present on a legible `proposal` gate: the `membersToHire` roles the
   * Brand's team already has someone for, not yet on this Work. Approving
   * CALLS THEM UP ("Convoca a X"); every other hire is someone new to the
   * Brand ("Suma a X").
   */
  rosterHires?: string[];
  createdAt: string;
}

/**
 * Q6: la cobertura de UN rol del plan, decidida por el motor.
 *  - `hire`: la cubre un alta de esta misma propuesta; destildarla recorta sus tareas.
 *  - `member`: ya hay alguien en el Trabajo que la hace; no hay nada que contratar.
 *  - `orphan`: no la cubre nadie. El plan no se puede cumplir tal cual.
 */
export interface CoordinationGateRoleCoverage {
  roleId: string;
  coverage: 'hire' | 'member' | 'orphan';
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
  /** N2: el título corto de la tarea, si el coordinador lo manda. */
  title?: string;
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
  /** `'succeeded'` / `'failed'` cuando el despacho ya se liquido; `null` mientras sigue en vuelo. */
  outcome: string | null;
  /** Los primeros `LOG_PREVIEW` caracteres del prompt y del resumen: lo que entra en un renglon del buzon. */
  promptPreview: string;
  summaryPreview: string | null;
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
   * exactly as before. Real production wiring (`latteService.ts`, el único
   * motor del proceso — Q11: acá decía "el `mcpEngine` de bootstrap.ts", que
   * R1 eliminó) passes the REAL flag, off by default like
   * every other feature. Gates only the two entry points that can create a
   * run (`startRun`, `requestCoordination`) -- everything downstream already
   * requires an active run (task 6.3's `NO_ACTIVE_RUN` guard), so gating
   * creation alone is sufficient: no run, no gate, no coordination server
   * ever gets used. Engram injection (task 6.29) is a SEPARATE policy and is
   * deliberately NOT read here.
   */
  isCoordinationEnabled?: () => boolean;
  /**
   * M3 (ronda 8): dónde va a parar el fallo de un paso del tick. El barrido no
   * puede tirar hacia afuera —un run roto no puede dejar sin barrer a los
   * demás— y hasta ahora eso significaba tragarse el error en silencio.
   * Opcional: los tests que construyen el motor a mano siguen sin cablear
   * nada.
   */
  log?: (line: string) => void;
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

  /**
   * Los convocados que el cierre todavía no pudo apagar porque estaban EN MEDIO
   * de un turno, y el run al que pertenecen (para la bitácora).
   *
   * Cortarle el proceso abajo a alguien que está respondiendo es tirar su turno
   * a la basura: el trabajo ya se pagó y el resultado se pierde sin que nadie
   * se entere. Se anota acá y se apaga en el `status:'idle'` siguiente, el
   * mismo camino por el que ya se destraban el cierre pendiente (`pendingClose`)
   * y los avisos encolados (`pendingNotices`).
   *
   * En memoria y no en la base, por la misma razón que sus dos hermanos: "¿está
   * ocupado?" es estado vivo de ESTE proceso. Un reinicio lo pierde y no
   * importa — un reinicio ya apagó a todo el mundo.
   */
  private readonly pendingPause = new Map<string, string>();

  /**
   * Los avisos que todavía no se le pudieron entregar a un miembro, en orden.
   *
   * Un aviso (la aprobación de un plan, la respuesta a una pregunta) es un
   * turno de usuario: `hub.send` sobre un miembro que está EN MEDIO de un turno
   * lo rechaza —los dos adaptadores tiran "still working on the previous
   * message"— y el aviso se perdía. Se guarda acá y se entrega cuando el hub
   * publica el `status: 'idle'` de ese miembro, el mismo camino que ya destraba
   * el cierre del run (`noteTurnEnded`).
   *
   * En memoria y no en la base a propósito, igual que `assigning` y
   * `pendingClose`: "¿está ocupado?" sale del adaptador, estado vivo de ESTE
   * proceso, y hay un solo motor por proceso. Un reinicio lo pierde, y eso es
   * honesto: el agente que se reinicia no está esperando nada.
   */
  private readonly pendingNotices = new Map<string, string[]>();

  /**
   * B5.1: EL DESPACHO QUE YA LE FUE ENVIADO a cada miembro, y si ya se le
   * recordó una vez que no reportó.
   *
   * El agujero que tapa: un worker puede hacer el trabajo y terminar su turno
   * SIN llamar `latte_report`. El despacho queda `dispatched` para siempre —el
   * barrido de filas viejas (`IN_FLIGHT_DISPATCH_STALE_MINUTES`) sólo alcanza a
   * las que no tienen dueño, y este miembro sigue vivo—, el run no cierra nunca
   * y el coordinador no se entera de nada.
   *
   * La clave es el miembro y el valor es el despacho: hay uno solo en vuelo por
   * miembro (la concurrencia se reserva por miembro en `assigning`).
   *
   * SE ESCRIBE DESPUÉS DE `hub.send`, no antes, y ése es el candado que
   * distingue el `idle` del spawn del `idle` del turno: abrir o contratar a un
   * miembro lo deja ocioso —y emite su `status:'idle'`— ANTES de que la tarea
   * exista para él. Hasta que `hub.send` no resuelve no hay entrada acá, así
   * que ningún idle anterior al envío puede disparar un aviso.
   *
   * En memoria y no en la base a propósito, igual que `assigning`,
   * `pendingClose` y `pendingNotices`: "¿terminó su turno?" sale del adaptador,
   * estado vivo de ESTE proceso. Un reinicio lo pierde, y eso es honesto — el
   * barrido de arranque ya liquida todo despacho en vuelo sin cobrar intento.
   */
  private readonly sentDispatches = new Map<string, { dispatchId: string; nudged: boolean }>();

  constructor(private readonly deps: CoordinationEngineDeps) {}

  /**
   * Un aviso para un miembro, entregado AHORA o encolado.
   *
   * Nunca tira: lo llaman caminos —aprobar una propuesta, contestar una
   * pregunta— cuyo efecto real ya está commiteado. Que el agente no se entere
   * es malo; que la aprobación se caiga porque el agente no se enteró es peor.
   */
  private async deliverNotice(memberId: string, text: string): Promise<{ delivered: boolean; queued: boolean }> {
    if (!memberId || !text) return { delivered: false, queued: false };
    if (this.holdForPausedCoordinator(memberId, text)) return { delivered: false, queued: true };
    // B5.5: se registra QUÉ pasó con el aviso, nunca su contenido. Un aviso
    // lleva resúmenes y nombres de archivo; la bitácora del proceso lleva ids
    // y estados.
    if (this.memberIsBusy(memberId)) {
      this.queueNotice(memberId, text);
      this.deps.log?.(`[latte] coordination notice queued (member=${memberId} reason=busy)`);
      return { delivered: false, queued: true };
    }
    try {
      await this.deps.hub.send(memberId, text);
      this.deps.log?.(`[latte] coordination notice delivered (member=${memberId})`);
      return { delivered: true, queued: false };
    } catch (error) {
      // Se encola en vez de perderse: el próximo fin de turno lo reintenta. Un
      // miembro que ya no existe deja su cola colgada y no molesta a nadie —
      // está acotada, y muere con el proceso.
      this.queueNotice(memberId, text);
      this.deps.log?.(`[latte] coordination notice queued after send failed (${memberId}): ${error instanceof Error ? error.message : String(error)}`);
      return { delivered: false, queued: true };
    }
  }

  /**
   * O2: EL COORDINADOR EN PAUSA CON EL RUN ACTIVO NO ES SILENCIO.
   *
   * Lo que pasó (2026-09-24): un worker reportó y le escribió al coordinador,
   * que la persona había pausado. El aviso se encolaba —la cola sólo se vacía
   * en un fin de turno, y un proceso apagado no tiene turnos— y el run seguía
   * `running` sin que nada se moviera ni nadie lo dijera.
   *
   * LA DECISIÓN: no se lo despierta solo. La pausa la hizo la persona, y un
   * motor que la deshace por detrás la vacía de sentido (y gasta en su nombre).
   * Lo que cambia es que la pausa SE VE: el aviso queda en la cola, el run pasa
   * a `suspended:coordinator_paused` y la persona lo lee en el encabezado y en
   * la tira de equipos. Reanudar al coordinador (`noteMemberOpened`) entrega la
   * cola y devuelve el run a `running`.
   *
   * "En pausa" es lo que publica el hub (`paused`: la fila existe y ningún
   * adaptador la posee). Sólo se pisa `running`: una suspensión anterior —la
   * pausa del equipo, un tope, una pregunta— tiene su propio motivo y su
   * propia salida, y el aviso igual queda en la cola.
   */
  private holdForPausedCoordinator(memberId: string, text: string): boolean {
    let runs: CoordinationRunRecord[];
    try { runs = this.deps.repo.listActiveCoordinationRuns().filter((run) => this.coordinatorOf(run) === memberId); } catch { return false; }
    for (const run of runs) {
      const member = this.teamOf(run.workId).find((m) => m.id === memberId);
      if (!member || member.status !== 'paused') continue;
      this.queueNotice(memberId, text);
      this.deps.log?.(`[latte] coordination notice queued (member=${memberId} reason=coordinator_paused)`);
      if (run.status === 'running') {
        this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', this.deps.clock(), 'coordinator_paused');
        this.deps.log?.(`[latte] coordination run suspended (run=${run.id} reason=coordinator_paused)`);
      }
      this.touch(run.workId, run.id);
      return true;
    }
    return false;
  }

  /**
   * O2: el coordinador volvió (la persona lo reanudó). El run que estaba
   * suspendido POR SU PAUSA vuelve a `running` —o a `coordination_disabled` si
   * el interruptor está abajo: reanudar a un miembro no enciende el equipo—, y
   * recién después se le entrega lo que esperaba, para que lo que haga con esos
   * avisos (despachar, contestar) encuentre el run andando.
   *
   * Nunca tira: lo llama la apertura de un miembro, cuyo efecto ya ocurrió.
   */
  async noteMemberOpened(memberId: string): Promise<void> {
    if (!memberId) return;
    try {
      const now = this.deps.clock();
      const enabled = this.deps.isCoordinationEnabled ? this.deps.isCoordinationEnabled() : true;
      for (const run of this.deps.repo.listActiveCoordinationRuns()) {
        if (this.coordinatorOf(run) !== memberId) continue;
        if (run.status !== 'suspended' || run.suspendReason !== 'coordinator_paused') continue;
        if (enabled) this.deps.repo.updateCoordinationRunStatus(run.id, 'running', now, null);
        else this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', now, 'coordination_disabled');
        this.deps.log?.(`[latte] coordination run resumed with its coordinator (run=${run.id})`);
        this.touch(run.workId, run.id);
      }
    } catch (error) {
      this.deps.log?.(`[latte] coordination resume check failed (${memberId}): ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.flushMemberNotices(memberId);
  }

  /** Un `isMemberBusy` que tira se lee como "ocupado": encolar de más sólo retrasa, mandar sobre un turno en vuelo pierde el aviso. */
  private memberIsBusy(memberId: string): boolean {
    try { return this.deps.hub.isMemberBusy(memberId); } catch { return true; }
  }

  private queueNotice(memberId: string, text: string): void {
    const queue = this.pendingNotices.get(memberId) ?? [];
    // Acotada: un miembro muerto no puede hacer crecer esta cola para siempre.
    if (queue.length >= MAX_PENDING_NOTICES) queue.shift();
    queue.push(text);
    this.pendingNotices.set(memberId, queue);
  }

  /**
   * El turno de este miembro terminó: se le entrega lo que quedó esperando, en
   * orden. Si vuelve a fallar (o si ya arrancó otro turno con el primer aviso),
   * lo que falta se devuelve a la cola y espera al próximo `idle`.
   */
  async flushMemberNotices(memberId: string): Promise<void> {
    const queue = this.pendingNotices.get(memberId);
    if (!queue || queue.length === 0) return;
    this.pendingNotices.delete(memberId);
    for (let i = 0; i < queue.length; i += 1) {
      try {
        await this.deps.hub.send(memberId, queue[i]);
      } catch (error) {
        const rest = queue.slice(i);
        for (const pending of rest) this.queueNotice(memberId, pending);
        this.deps.log?.(`[latte] coordination notice still undeliverable (${memberId}): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

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
    // R10: y lo DICE. Devolver el run tal cual era responder que sí sin hacer
    // nada: sobre un `planning` no hay nada que pausar —la propuesta sigue
    // esperando una decisión— y sobre uno ya suspendido tampoco, y en los dos
    // casos quien apretó "Pausar" se quedaba creyendo que el equipo había
    // quedado detenido. La interfaz hoy no ofrece el botón ahí, pero el motor
    // no puede depender de eso: es público, y `resolveGate` está a un salto.
    if (run.status !== 'running') throw new LatteError('RUN_NOT_RUNNING', `Only a running team can be paused (this one is ${run.status})`);
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
    // O4: REANUDAR ES ENCENDER, y el interruptor apaga.
    //
    // `startRun`, `requestCoordination`, `startDispatch` y el tick
    // (`refreshAsks`) ya consultan la bandera; esto no, y es exactamente la
    // misma clase de acción: un run suspendido vuelve a estar disponible para
    // despachar. Con `feature:coordination` apagada, "Reanudar equipo" volvía
    // a poner a todo el mundo a gastar. Cancelar sigue siendo la salida, y esa
    // no pasa por acá: cancelar TERMINA trabajo, no lo empieza.
    this.requireCoordinationEnabled();
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
    // Q6: UNA sola lectura. Había dos, `terminal` y `run`, con nada en el medio
    // que pudiera cambiar la fila: dos fotos del mismo instante que sólo podían
    // divergir por accidente, y una de ellas decidía si la otra se usaba.
    const run = this.deps.repo.getCoordinationRun(runId);
    // Un run terminado no tiene ninguna decisión pendiente: seguir ofreciendo
    // gates de algo que ya terminó es pedirle a la persona que decida sobre un
    // equipo que no existe, y cada clic rebotaba con un error desde el fondo.
    if (run.status === 'done' || run.status === 'cancelled') return [];
    // Q7: ESTO ES UNA LECTURA Y NO ESCRIBE UNA SOLA FILA.
    //
    // Acá vivía un `refreshAsks(runId, clock())`, puesto por F5 con un motivo
    // real: a un run suspendido por preguntas vencidas no lo llama nadie, y
    // abrir Decisiones era uno de los pocos momentos en que alguien lo miraba.
    // Pero `refreshAsks` llama a `finishRunIfComplete`, que llama a `closeRun`,
    // que BORRA el permiso del coordinador: abrir la pantalla de decisiones
    // podía terminar el equipo. Y la tira global publicaba el `status` de la
    // foto que había tomado ANTES de este llamado, así que decía "en curso"
    // sobre un run que esta misma lectura acababa de cerrar.
    //
    // El motivo de F5 sigue siendo cierto, y por eso ahora tiene dueño propio:
    // `LatteService.sweepCoordination()`, un tick periódico que corre sin que
    // nadie mire. Una lectura informa; escribir es de quien decide.
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
        // Q6: la cobertura de cada rol del plan, calculada por el motor — que es
        // el único que sabe quién está en el equipo. La interfaz recorta con
        // ESTO y no con su propia foto.
        roleCoverage: proposal && Array.isArray(proposal.plan) ? this.computeRoleCoverage(run.workId, proposal) : undefined,
        // Y de las altas, cuáles traen a alguien que la marca ya tiene: la
        // tarjeta dice "Convoca a X" en vez de "Suma a X".
        rosterHires: proposal && Array.isArray(proposal.membersToHire)
          ? [...new Set(proposal.membersToHire.map((hire) => hire?.roleId).filter((roleId): roleId is string => typeof roleId === 'string' && this.rosterHas(run.workId, roleId)))]
          : undefined,
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
    // M9: `coordination_disabled` entra en la lista de motivos que NO son de
    // presupuesto. Sin esto, renombrar la suspensión hacía aparecer una
    // decisión de presupuesto inventada en Decisiones.
    if (run.status === 'suspended' && run.suspendReason
      && run.suspendReason !== 'paused_by_human'
      && run.suspendReason !== 'coordinator_paused'
      && run.suspendReason !== 'all_blocked_on_ask'
      && run.suspendReason !== 'coordination_disabled') {
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
      // K7 (ronda 10): APROBAR EL PLAN NO LE CAMBIA EL DUEÑO A NADIE, así que
      // no le mueve el reloj a nadie. Esto pasaba por `updateCoordinationTask`,
      // que reescribe `updated_at` sobre TODA la fila: una tarea del snapshot
      // que en ese instante estaba reclamada por un despacho levantando su
      // proceso se quedaba sin token, y ese despacho volvía y abortaba con
      // `CLAIM_LOST` —despidiendo al miembro recién contratado y diciéndole a
      // la persona que otro había tomado la tarea— por haber aprobado el plan.
      for (const taskId of snapshot) this.deps.repo.markCoordinationTaskInPlan(taskId);
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
    if (decision === 'reject') {
      const cancelled = this.cancelRun(runId);
      // A1: EL RECHAZO TAMBIÉN SE AVISA. Sin esto el agente que propuso queda
      // esperando una aprobación que ya no va a llegar, sondeando o —peor—
      // pidiéndole a la persona que apruebe algo que la persona ya rechazó.
      // El texto que la interfaz manda al rechazar (si manda alguno) es el
      // motivo: al rechazar nunca viaja una propuesta editada, editar sólo
      // tiene sentido para aprobar.
      const reason = editedProposalJson?.trim();
      await this.deliverNotice(
        run.coordinatorMemberId ?? '',
        `Your plan was rejected. The person did not approve this coordination plan, so no task was created and no budget was granted.${reason ? `\n\nReason: ${reason}` : ''}\n\nDo not wait for it: nothing is pending on Latte's side. Ask the person what to change, and propose again with \`latte_request_coordination\` when you know.`,
      );
      return cancelled;
    }

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

    // Q4: Y EL PLAN TIENE QUE SER CUMPLIBLE, antes de contratar a nadie. La
    // versión autoritativa vive adentro de la transacción de `commitProposal`;
    // ésta corre acá para no levantar procesos de un equipo que igual no va a
    // arrancar.
    this.assertPlanIsFulfillable(run.workId, proposal);

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
      const committed = this.commitProposal(run.id, proposal, budget, hired);
      // R3: recién acá, con la aprobación ya commiteada. Guardarlo al proponer
      // dejaría el pedido de una propuesta rechazada colgado de un run que
      // nunca existió como equipo.
      const requestTitle = coordinationRequestTitle(proposal);
      if (requestTitle !== '') this.deps.repo.setMeta(coordinationRequestMetaKey(run.id), requestTitle);
      // H1: LA PROPUESTA DE UN TRASPASO SE DESPACHA AL APROBARLA.
      //
      // Quien escribió el traspaso ya dijo a quién y qué; lo único que faltaba
      // era el sí de la persona. Esperar a que el coordinador lea el aviso y
      // llame a `latte_dispatch` volvía a poner un paso en el medio — y si el
      // coordinador no tiene MCP, ese paso no llega nunca. Pasa por
      // `startDispatch`, así que la autoridad (manual → gate), el presupuesto y
      // la concurrencia valen igual. Nunca tira: la aprobación ya está
      // commiteada y no se deshace porque un despacho se haya denegado.
      if (this.deps.repo.getMeta(HANDOFF_RUN_META + run.id) === '1') {
        for (const task of this.deps.repo.listCoordinationTasks(run.id).filter((t) => t.status === 'ready')) {
          try {
            await this.startDispatch({ grant: { workId: run.workId, runId: run.id, memberId: '', role: 'coordinator' }, taskId: task.id });
          } catch (error) {
            this.deps.log?.(`[latte] handoff dispatch after approval failed (${run.id}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      // A1: Y EL COORDINADOR SE ENTERA, fuera de la transacción.
      //
      // Éste era el agujero medido en uso real: la persona aprobaba y el
      // coordinador no se enteraba NUNCA. Cuando se lo decían por chat, el
      // agente volvía a crear las tareas que esta transacción acaba de crear
      // —no tenía cómo verlas— y esas tareas nuevas, `inPlan:false` bajo la
      // autoridad `plan` que la aprobación acaba de conceder, abrían un gate
      // por cada despacho. La autonomía existía en el motor y el silencio la
      // desactivaba.
      //
      // Nunca tira: `deliverNotice` se traga todo. La aprobación ya está
      // commiteada y no se deshace porque un agente no se haya enterado.
      try {
        await this.deliverNotice(committed.coordinatorMemberId ?? '', this.approvalNoticeText(committed, hired));
      } catch (error) {
        // Armar el texto lee filas, y una lectura puede fallar. El `catch` de
        // abajo despide al equipo recién contratado: un aviso que no se pudo
        // redactar no puede entrar ahí.
        this.deps.log?.(`[latte] approval notice failed (${committed.id}): ${error instanceof Error ? error.message : String(error)}`);
      }
      return committed;
    } catch (error) {
      for (const { memberId } of hired.reverse()) {
        try { this.deps.hub.removeMember(memberId); } catch { /* el rollback nunca tapa el error original */ }
      }
      throw error;
    }
  }

  /**
   * Q4: TODA TAREA DEL PLAN TIENE QUIÉN LA HAGA, o la aprobación no pasa.
   *
   * El lookup es el mismo que `assertRoleCreatable` hace en todos los demás
   * caminos (`taskCreate`, `planSubmit`, el puente de handoff) — la foto de
   * contratables más el equipo vivo de hoy —, con la única diferencia de que
   * acá la foto todavía no está escrita: se deriva de los `membersToHire` que
   * llegaron en ESTA resolución, que es exactamente lo que `commitProposal`
   * está por congelar.
   *
   * Sin esto, destildar una contratación en la interfaz —que filtra
   * `membersToHire` y manda `proposal.plan` intacto— dejaba tareas de un rol
   * que nadie aprobó: nacían `ready`, el primer despacho moría con
   * `ROLE_NOT_APPROVED`, la tarea quedaba `failed` y `recomputeReadiness`
   * derribaba a sus dependientes. Un rechazo de la persona se convertía en
   * media planificación caída, en silencio, después de haber aprobado.
   *
   * La forma de la propuesta no tiene nada de malo, así que esto NO vive en
   * `assertCoordinationProposal`: qué roles existen lo sabe el motor.
   */
  private assertPlanIsFulfillable(workId: string, proposal: CoordinationProposal): void {
    const orphans = this.computeRoleCoverage(workId, proposal)
      .filter((entry) => entry.coverage === 'orphan')
      .map((entry) => entry.roleId);
    if (orphans.length === 0) return;
    throw new LatteError(
      'PLAN_HAS_UNAPPROVED_ROLES',
      `The plan still has tasks for roles nobody approved and this Work has no member for: ${orphans.join(', ')}. Remove those tasks or approve their hire.`,
    );
  }

  /**
   * Q6: QUIÉN VA A PODER HACER CADA ROL DEL PLAN, calculado UNA vez y publicado.
   *
   * Es la misma cuenta que `assertPlanIsFulfillable` hace para decir que no, y
   * por eso las dos salen de acá: la interfaz recortaba el plan recalculando el
   * equipo por su cuenta (`team`, la foto del renderer) y podía llegar a una
   * conclusión distinta de la que el motor iba a aplicar un milisegundo después
   * — que es exactamente cómo un "Aprobar" rebota con un error que la pantalla
   * no supo anticipar.
   *
   * El equipo de HOY cuenta por sus dos fuentes: la tabla de miembros (la que
   * `assertRoleCreatable` mira) y el equipo vivo del hub (la que
   * `reserveTargetMember` mira de verdad cuando llega el despacho). Divergen
   * —el hub puede tener a alguien que la tabla todavía no, y al revés— y esto
   * decide si ALGUIEN va a poder hacer la tarea: negar por una de las dos
   * vistas sería rechazar una aprobación que el despacho sí podría cumplir, que
   * es el error caro en esta dirección.
   *
   * `member` gana sobre `hire`: si el rol ya está en el equipo, destildar su
   * alta no le quita el trabajo a nadie.
   */
  private computeRoleCoverage(workId: string, proposal: CoordinationProposal): CoordinationGateRoleCoverage[] {
    const hires = new Set((proposal.membersToHire ?? []).map((hire) => hire.roleId));
    let live: Set<string>;
    try { live = new Set(this.deps.hub.listTeam(workId).filter((m) => m.status !== 'ended').map((m) => m.roleId)); }
    catch { live = new Set(); }
    return [...new Set(proposal.plan.map((item) => item.roleId))].map((roleId) => ({
      roleId,
      coverage: live.has(roleId) || this.workHasMemberForRole(workId, roleId)
        ? 'member'
        : hires.has(roleId) ? 'hire' : 'orphan',
    }));
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
      // Q4: el chequeo AUTORITATIVO, antes de la primera escritura de la
      // transacción. El de `resolveProposalGate` corre antes de contratar —
      // para no levantar procesos de un equipo que no va a arrancar— pero entre
      // aquél y éste hay un spawn entero, y en esos segundos alguien pudo
      // borrar el miembro que hacía cumplible una tarea. Cero filas escritas.
      this.assertPlanIsFulfillable(run.workId, proposal);
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
        const task = this.createTaskRow(run.id, item.roleId, item.spec, dependsOnIds, item.title);
        // K7: la pertenencia al plan se marca sin tocar el reloj de la tarea,
        // igual que en el gate de plan. Acá la tarea acaba de nacer y no puede
        // estar reclamada, pero es la misma forma y no hay dos.
        this.deps.repo.markCoordinationTaskInPlan(task.id);
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
      id: d.id, taskId: d.taskId, memberId: d.memberId, status: d.status,
      // El QUE y el COMO, no solo el cuando: sin esto el buzon del panel de
      // equipo solo podia decir "hubo un despacho", que no le sirve a nadie.
      outcome: d.outcome,
      promptPreview: d.prompt.slice(0, LOG_PREVIEW),
      summaryPreview: d.summary == null ? null : d.summary.slice(0, LOG_PREVIEW),
      createdAt: d.createdAt, startedAt: d.startedAt, settledAt: d.settledAt,
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

  /**
   * Q9: el alta que se deshizo. Sólo se escribe si había algo que sacar, para
   * que compensar un despacho que nunca anotó nada (los caminos con rollback)
   * no invente una clave de meta vacía.
   */
  private forgetHire(runId: string, memberId: string): void {
    const hires = this.listHires(runId);
    const remaining = hires.filter((hire) => hire.memberId !== memberId);
    if (remaining.length === hires.length) return;
    this.deps.repo.setMeta(HIRES_META + runId, JSON.stringify(remaining));
  }

  /** Append-only, idempotente por miembro: re-abrir a alguien ya anotado no lo duplica. */
  private recordHire(runId: string, memberId: string, roleId: string, at: string): void {
    const hires = this.listHires(runId);
    if (hires.some((hire) => hire.memberId === memberId)) return;
    hires.push({ memberId, roleId, hiredAt: at });
    this.deps.repo.setMeta(HIRES_META + runId, JSON.stringify(hires));
    // B5.5: el alta es el primer eslabón del circuito, y `agents.log` no tenía
    // una sola línea de coordinación. El guard de arriba lo deja idempotente:
    // un alta ya anotada no vuelve a escribir ni fila ni línea.
    this.deps.log?.(`[latte] coordination hire (run=${runId} member=${memberId} role=${roleId})`);
  }

  /**
   * Las `latte_ask` todavía sin responder de un run. `listGates` excluye
   * `all_blocked_on_ask` a propósito (una pregunta no es un gate de
   * aprobar/rechazar), así que sin esta lista un run suspendido por una
   * pregunta no tenía ninguna salida en la UI salvo cancelar.
   */
  listOpenAsks(runId: string): CoordinationAskRecord[] {
    // Q7: y ésta también es una lectura pura. Acá también vivía un
    // `refreshAsks`, con el mismo efecto colateral: publicar la lista de
    // preguntas podía cerrar el run. El barrido lo corre el tick del servicio
    // (`sweepCoordination`), que es quien puede escribir sin que nadie mire.
    //
    // Q6b: PERO FILTRAR ES LEER. Con las lecturas puras, una pregunta con el
    // plazo pasado se seguía publicando hasta el próximo tick, así que la
    // persona la veía y la contestaba mientras `latte_ask_status` —la misma
    // pregunta, mirada por el agente en el mismo instante— ya decía que estaba
    // vencida. Es exactamente el mismo filtro que `openAsksHolding` usa para
    // decidir si un run está bloqueado: una vencida no espera a nadie. El
    // cierre, que SÍ es una escritura, lo sigue anotando el tick.
    return this.openAsksHolding(runId, this.deps.clock());
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
    // Q6b: EL PLAZO YA PASÓ, y eso no depende de que alguien haya pasado a
    // anotarlo. El CAS del repo sólo mira `answered_at IS NULL`, así que entre
    // el vencimiento y el tick que lo cierra la respuesta entraba y la persona
    // se quedaba creyendo que su respuesta iba a llegar — cuando el vencimiento
    // ya devolvió (o va a devolver) la tarea a la cola y nadie la va a leer.
    // Mismo código que el cierre por vencimiento: la pregunta está cerrada.
    if (pending.answeredAt == null && pending.deadlineAt <= now) {
      throw new LatteError('ASK_CLOSED', `That question's deadline passed at ${pending.deadlineAt}: nobody is waiting for this answer any more`);
    }
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
    //
    // N6: Y CON LA BANDERA ABAJO, ESTE `running` NO SE ESCRIBE.
    //
    // Es la misma regla que O4 le puso a `resumeRun` y al tick (`refreshAsks`):
    // con `feature:coordination` apagada nada REACTIVA un equipo. `answerAsk`
    // se había quedado afuera, así que contestar una pregunta encendía un run
    // que el interruptor promete detenido — y por un camino que la persona no
    // asocia con "encender". La respuesta se guarda igual, arriba: apagar la
    // coordinación no puede borrar lo que alguien escribió, y cuando la
    // bandera vuelva a subir el tick levantará la suspensión con el mismo
    // cálculo de siempre.
    //
    // M9 (ronda 8): PERO EL MOTIVO SE CORRIGE IGUAL. Con la bandera abajo, la
    // fila se quedaba diciendo `all_blocked_on_ask` cuando eso YA ERA FALSO:
    // la pregunta está contestada y hay tareas despachables. El equipo sigue
    // detenido —eso es lo que el interruptor promete— pero lo detiene el
    // interruptor, no las preguntas, y el motivo es lo único que la persona
    // tiene para saber por qué. También `listGates` lo lee: cualquier motivo
    // que no sea de los conocidos le hace inventar una decisión de
    // presupuesto.
    //
    // L3 (ronda 9): Y LA FÓRMULA ES UNA SOLA, ACÁ Y EN TODOS LADOS.
    const run = this.deps.repo.getCoordinationRun(answered.runId);
    this.reconcileSuspendReason(run.id, now);
    // Y con la pregunta cerrada, el cierre se re-evalúa: puede haber sido lo
    // único que quedaba en pie (D2).
    this.finishRunIfComplete(run.id, now);
    this.touch(run.workId, run.id);
    // A4: Y LA RESPUESTA LLEGA A QUIEN PREGUNTÓ.
    //
    // `coordination_ask` guarda `memberId` desde siempre, así que la respuesta
    // tuvo destinatario todo este tiempo y nadie se la mandaba. Una pregunta
    // CON tarea vuelve en el prompt del re-despacho (R7), pero la del
    // coordinador —que no está despachado a nada— sólo se podía sondear con
    // `latte_ask_status`: el agente quedaba puliendo una tool o, directamente,
    // esperando. Mismo mecanismo que el aviso de aprobación: se manda, y si
    // está en medio de un turno se encola hasta su `idle`.
    //
    // `void`: este método es sincrónico y su valor de retorno es la fila
    // escrita. `deliverNotice` nunca tira.
    void this.deliverNotice(
      answered.memberId,
      `Answer to your question «${answered.question}»: ${answer}`,
    );
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
   *
   * H1 (uso real, 2026-09-23): SIN RUN, EL TRASPASO SE VUELVE UNA PROPUESTA.
   *
   * Antes esto devolvía `{bridged:false}` y la interfaz caía al borrador: el
   * pedido que un agente le escribía a otro terminaba pegado en el cuadro de
   * texto para que la PERSONA lo mandara a mano — la persona en el medio de
   * una conversación entre dos agentes. Ahora arma una propuesta de UNA tarea
   * (con el alta del rol si falta) y la guarda por `requestCoordination`, el
   * mismo camino que `latte_request_coordination`: mismos candados, misma
   * tarjeta, mismo Aprobar/Editar/Rechazar. El coordinador del run es quien
   * escribió el traspaso (lo resuelve el llamador, que ve las conversaciones).
   *
   * Cuando NO puentea devuelve SIEMPRE su motivo, con el código del motor: la
   * interfaz ya no tiene un borrador al que caer mientras la coordinación esté
   * prendida, así que necesita saber por qué el pedido se quedó quieto.
   */
  async bridgeHandoffToTask(workId: string, roleId: string, spec: string, options: { coordinatorMemberId?: string | null } = {}): Promise<
    | { bridged: false; reason: string }
    | { bridged: true; proposed: CoordinationRunRecord }
    | { bridged: true; proposed?: undefined; task: CoordinationTaskRecord; dispatch: { status: 'dispatched' | 'pending_approval'; dispatchId: string }; reason: null }
    | { bridged: true; proposed?: undefined; task: CoordinationTaskRecord; dispatch: null; reason: string }
  > {
    // Crítico 6: `startDispatch` ya chequeaba la bandera, pero ACÁ abajo —
    // después de que `createTaskRow` ya había escrito la tarea. Con la
    // bandera baja quedaba una tarea huérfana en el run por cada handoff
    // aceptado. El chequeo va antes de escribir, no después.
    this.requireCoordinationEnabled();
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    if (!run) return this.proposeFromHandoff(workId, roleId, spec, options.coordinatorMemberId ?? null);
    // R3: Y EL ESTADO DEL RUN, ANTES DE ESCRIBIR NADA. "Activo" incluye
    // `planning` (una propuesta que la persona todavía no aprobó) y
    // `suspended` (un equipo pausado o sin presupuesto). Sobre cualquiera de
    // los dos, `createTaskRow` corría igual y `startDispatch` rebotaba tres
    // saltos más adentro con `COORDINATION_NOT_APPROVED`/`RUN_NOT_ACTIVE`,
    // dejando una tarea `ready` colada en un run que nadie aprobó — que con
    // autoridad `auto` se despacha sola en cuanto el run arranque — y una
    // excepción subiendo hasta la interfaz por haber aceptado un pedido. Sólo
    // un run CORRIENDO acepta trabajo nuevo; con cualquier otro estado el
    // pedido se queda quieto y el motivo viaja (H1: ya no hay borrador al que
    // degradar). Una propuesta pendiente es la misma puerta cerrada que ve
    // `requestCoordination`, con el mismo código.
    if (run.status !== 'running') return { bridged: false, reason: run.status === 'planning' ? 'RUN_ALREADY_ACTIVE' : 'RUN_NOT_ACTIVE' };
    // EL MISMO chequeo que `taskCreate` y `planSubmit` (F7). Este camino
    // llamaba a `createTaskRow` directo: la tarea nacía, el despacho moría con
    // `ROLE_NOT_APPROVED` tres saltos más adentro, quedaba una tarea `failed`
    // en la bitácora de la persona y la excepción subía hasta la interfaz por
    // haber aceptado un borrador. Un rol que nadie aprobó no se puede
    // convertir en tarea por ningún camino; el handoff se queda quieto y dice
    // por qué.
    try {
      this.assertRoleCreatable(run, roleId);
    } catch (error) {
      if (error instanceof LatteError && error.code === 'ROLE_NOT_APPROVED') return { bridged: false, reason: 'ROLE_NOT_APPROVED' };
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
   * H1: la propuesta que nace de un traspaso. Una tarea (el pedido), el alta
   * del rol sólo si nadie del equipo lo hace, el presupuesto que la persona ya
   * configuró para el Trabajo (o el mínimo que alcanza para una tarea con sus
   * reintentos) y un título de una línea. Entra por `requestCoordination`, así
   * que no hay un segundo validador ni un segundo lugar donde una propuesta se
   * vuelve fila: lo que ese camino rechaza, acá también, con el mismo código.
   */
  private async proposeFromHandoff(workId: string, roleId: string, spec: string, coordinatorMemberId: string | null): Promise<{ bridged: false; reason: string } | { bridged: true; proposed: CoordinationRunRecord }> {
    const plan = [{ roleId, spec }];
    const covered = this.computeRoleCoverage(workId, { plan, membersToHire: [], estimatedDispatches: 1, rationale: '' })[0]?.coverage === 'member';
    let configured: number | null = null;
    try { configured = this.requireReadableBudget(workId)?.maxDispatches ?? null; } catch { configured = null; }
    const proposal: CoordinationProposal = {
      plan,
      estimatedDispatches: configured ?? MAX_ATTEMPTS_PER_TASK,
      membersToHire: covered ? [] : [{
        roleId,
        why: this.rosterHas(workId, roleId)
          ? `The request is for ${roleId}: someone on the Brand's team does it and is not on this Work yet, so approving calls them up.`
          : `The request is for ${roleId} and nobody on the team does it yet.`,
      }],
      rationale: coordinationRequestTitle({ rationale: '', plan }),
    };
    try {
      const run = await this.requestCoordination({ workId, runId: null, memberId: coordinatorMemberId ?? '', role: 'worker' }, proposal);
      // Marcado para que aprobarla despache sola (ver `resolveProposalGate`):
      // quien la pidió ya dijo a quién y qué, no hay nada que coordinar.
      this.deps.repo.setMeta(HANDOFF_RUN_META + run.id, '1');
      return { bridged: true, proposed: run };
    } catch (error) {
      if (error instanceof LatteError) return { bridged: false, reason: error.code };
      throw error;
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
    // O8: PRIMERO LO QUE DICE "ACÁ NO ENTRA NINGÚN PLAN".
    //
    // `assertPlanIsFulfillable` corría antes que estos dos, así que con un run
    // ya activo —o con el techo app-wide lleno— el agente recibía
    // `PLAN_HAS_UNAPPROVED_ROLES`: "arreglá tu plan", sobre un plan que no iba
    // a entrar ni perfecto. Se le respondía la consecuencia en vez del hecho, y
    // se ponía a re-planificar contra una puerta cerrada. Los tres son lecturas
    // y ninguno escribe: el orden no cambia lo que queda en la base, cambia qué
    // se le dice a quien preguntó.
    const existing = this.deps.repo.findActiveCoordinationRun(grant.workId);
    if (existing) throw new LatteError('RUN_ALREADY_ACTIVE', `This Work already has an active coordination run (${existing.id}, ${existing.status})`);
    this.assertRunCeiling();
    // Q6: Y QUE EL PLAN SE PUEDA CUMPLIR, ACÁ, donde el error le llega a quien
    // puede arreglarlo. Un rol del plan sin alta ni miembro se guardaba igual, y
    // recién `assertPlanIsFulfillable` lo rechazaba al aprobar Y al editar: la
    // persona quedaba con una tarjeta cuyo único botón útil era "Rechazar", y el
    // agente —el que escribió la propuesta— no se enteraba nunca. Misma cuenta,
    // mil pasos antes: el agente recibe el error y vuelve a proponer.
    this.assertPlanIsFulfillable(grant.workId, proposal);
    const now = this.deps.clock();
    const run = this.deps.repo.insertCoordinationRun({
      id: newId('crn'),
      workId: grant.workId,
      status: 'planning',
      coordinatorMemberId: grant.memberId || null,
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

  planSubmit(runId: string, tasks: Array<{ roleId: string; spec: string; title?: string; dependsOn?: number[] }>): CoordinationTaskRecord[] {
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
    // Q6: UN PLAN ENTRA ENTERO O NO ENTRA.
    //
    // Esto escribía de a una fila en un `for` suelto. `createTaskRow` consulta
    // el DAG, y el tope de tareas del run (`MAX_TASKS_PER_RUN`) saltaba recién
    // en la fila que lo cruzaba: con 201 tareas quedaban 200 escritas y `ready`
    // mientras el coordinador recibía un error que le decía que su plan no
    // había entrado. Doscientas tareas despachables que nadie aprobó como
    // conjunto, y un error que mentía sobre el estado de la base.
    //
    // El esquema publicado ahora lleva `maxItems`, así que el caso normal se
    // rechaza antes de llegar acá; esto es lo que garantiza que CUALQUIER
    // fallo a mitad de camino —tope, profundidad, dependencia inválida— no deje
    // nada escrito.
    const created = this.deps.repo.transaction(() => {
      const rows: CoordinationTaskRecord[] = [];
      for (const spec of tasks) {
        const dependsOnIds = (spec.dependsOn ?? []).map((idx) => {
          const dep = rows[idx];
          if (!dep) throw new ValidationError(`Plan task dependsOn index ${idx} is out of range`);
          return dep.id;
        });
        rows.push(this.createTaskRow(run.id, spec.roleId, spec.spec, dependsOnIds, spec.title));
      }
      this.deps.repo.setCoordinationPlan(run.id, JSON.stringify(rows.map((t) => t.id)), this.deps.clock());
      return rows;
    });
    this.touch(run.workId, run.id);
    return created;
  }

  taskCreate(runId: string, input: { roleId: string; spec: string; title?: string; dependsOn?: string[] }): CoordinationTaskRecord {
    const run = this.assertRunMutable(this.deps.repo.getCoordinationRun(runId));
    // `running`, el MISMO umbral que `planSubmit` (F6). Sin esto, con el
    // permiso de coordinador escrito por IPC y un run todavía en `planning`,
    // el agente colaba tareas que la persona NO leyó en la propuesta que está
    // por aprobar: aprobaba un plan de tres tareas y el run arrancaba con
    // cinco. Una propuesta que se puede ampliar mientras se la lee no es una
    // propuesta.
    if (run.status !== 'running') throw new LatteError('RUN_NOT_ACTIVE', `Run is ${run.status}`);
    this.assertRoleCreatable(run, input.roleId);
    const task = this.createTaskRow(runId, input.roleId, input.spec, input.dependsOn ?? [], input.title);
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
    throw new LatteError('ROLE_NOT_APPROVED', `Creating a task for ${roleId} was not part of the approved plan; it needs its own approval${this.rosterNote(run.workId, roleId)}`);
  }

  /**
   * Si la marca tiene a alguien de este rol que todavía no está en este
   * trabajo (activo o retirado: convocarlo lo devuelve). Una lectura; nunca
   * tira, porque sólo cambia qué se le dice a alguien.
   */
  private rosterHas(workId: string, roleId: string): boolean {
    return this.rosterPerson(workId, roleId) !== null;
  }

  private rosterPerson(workId: string, roleId: string): { id: string; roleId: string } | null {
    try {
      const brandId = this.deps.repo.brandIdOfWork(workId);
      return brandId ? this.deps.repo.findBrandMemberToCall(brandId, roleId, workId, null) : null;
    } catch {
      return null;
    }
  }

  /**
   * La salida, dicha al agente, cuando lo que pide es de alguien del plantel
   * que nadie convocó: no se lo arranca por la espalda (sería un proceso que
   * nadie pidió en un trabajo al que no pertenece); lo convoca la persona, al
   * aprobar un alta.
   */
  private rosterNote(workId: string, roleId: string): string {
    return this.rosterHas(workId, roleId)
      ? `. «${roleId}» is on this Brand's team but not called up in this Work. Calling them up needs the person's approval: it goes in membersToHire of a coordination proposal (latte_request_coordination).`
      : '';
  }

  teamList(workId: string) {
    return this.deps.hub.listTeam(workId);
  }

  /**
   * A2: LAS TAREAS DEL RUN, PARA VERLAS EN VEZ DE RECREARLAS.
   *
   * `latte_check` devuelve `[]` por diseño (no hay productor de mensajes de
   * coordinación) y no existía ninguna otra forma de que el coordinador
   * supiera qué tareas tiene el run. En cuanto perdía el hilo —un turno nuevo,
   * una aprobación de la que no se enteró— su única salida era
   * `latte_task_create`, o sea duplicar el plan entero con tareas
   * `inPlan:false` que después gatean uno por uno.
   *
   * `spec` va truncado: la lista es para ELEGIR cuál despachar, no para releer
   * el plan. Y `dependsOn` viaja con ids reales, que es lo que hace falta para
   * despachar en orden.
   */
  taskList(runId: string): Array<{
    id: string; roleId: string; status: CoordinationTaskRecord['status']; inPlan: boolean;
    dependsOn: string[]; attempts: number; assignedMemberId: string | null; spec: string; title: string;
  }> {
    const deps = new Map<string, string[]>();
    for (const edge of this.deps.repo.listCoordinationTaskDeps(runId)) {
      deps.set(edge.taskId, [...(deps.get(edge.taskId) ?? []), edge.dependsOnId]);
    }
    return this.deps.repo.listCoordinationTasks(runId).map((task) => ({
      id: task.id,
      roleId: task.roleId,
      status: task.status,
      inPlan: task.inPlan,
      dependsOn: deps.get(task.id) ?? [],
      attempts: task.attempts,
      assignedMemberId: task.assignedMemberId,
      spec: task.spec.length > TASK_LIST_SPEC_PREVIEW ? `${task.spec.slice(0, TASK_LIST_SPEC_PREVIEW)}…` : task.spec,
      // N2: del spec ENTERO, no del recorte: el pedido puede venir después de
      // un bloque de contexto más largo que el recorte.
      title: taskTitle(task.spec, task.title, TASK_TITLE_LONG),
    }));
  }

  /**
   * Lo que el coordinador necesita saber en el instante en que su plan se
   * aprueba: qué autoridad quedó, cuánto presupuesto hay, QUÉ TAREAS YA
   * EXISTEN —con su id, su rol, su estado y sus dependencias—, a quién
   * contrataron, y qué hacer ahora.
   *
   * En inglés, como el resto de lo que Latte le dice a un agente (el prompt de
   * despacho y el bloque de respuestas de `withAnsweredAsks`).
   */
  private approvalNoticeText(run: CoordinationRunRecord, hired: Array<{ memberId: string; roleId: string }>): string {
    const authority = this.readAuthority(run.workId);
    const budget = this.budgetBlockForEnvelope(run.id);
    const tasks = this.taskList(run.id);
    const lines: string[] = [];
    lines.push('Your plan was approved. Latte already created every task of it — you do not have to.');
    lines.push('');
    lines.push(`Authority: ${authority}.${authority === 'plan'
      ? ' Tasks that belong to the approved plan dispatch straight away; anything else needs the person to approve each dispatch.'
      : authority === 'auto'
        ? ' Every dispatch runs without asking.'
        : ' The person chose to approve every dispatch one by one.'}`);
    lines.push(`Budget: ${budget.maxDispatches ?? 'unlimited'} dispatches${budget.maxConcurrent == null ? '' : `, at most ${budget.maxConcurrent} at a time`}.`);
    lines.push('');
    lines.push('Tasks that already exist:');
    for (const task of tasks) {
      const depends = task.dependsOn.length > 0 ? ` (depends on: ${task.dependsOn.join(', ')})` : '';
      lines.push(`- ${task.id} [${task.roleId}] ${task.status}${depends}: ${task.title}`);
    }
    if (hired.length > 0) {
      lines.push('');
      lines.push('Members hired for this plan:');
      for (const hire of hired) lines.push(`- ${hire.memberId} (${hire.roleId})`);
    }
    lines.push('');
    if (this.deps.repo.getMeta(HANDOFF_RUN_META + run.id) === '1') {
      // H1: la propuesta nació de un traspaso y Latte ya la despachó al aprobarla.
      lines.push('This plan came from your handoff file, and Latte already took care of the dispatch when the person approved (under manual authority it waits for their approval of that dispatch): do not dispatch it again. The member reports back with `latte_report`, and Latte tells you.');
      return lines.join('\n');
    }
    lines.push('These tasks already exist. Dispatch them with `latte_dispatch(taskId)` in dependency order (`latte_task_list` shows them, with their current status). Do NOT recreate them with `latte_task_create`: tasks created outside the approved plan need the person\'s approval for every dispatch.');
    lines.push('The run closes itself the moment its last task reports, so dispatch what is ready and let the reports come back.');
    return lines.join('\n');
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
    //
    // L1 (ronda 9): Y EL RECLAMO DEJA UN TOKEN, porque reclamar no alcanza.
    // Entre este compare-and-set y el commit hay un spawn entero, y desde la
    // ronda 8 hay un ESCRITOR de la tarea adentro de esa ventana: el caso 3 de
    // `settleOrphanDispatches` devuelve a `ready` la tarea reclamada cuyo
    // despacho nunca llegó a nacer. El token —el `updated_at` del reclamo, o
    // el `started_at` que el gate escribió— es lo que le permite a la
    // transacción de abajo CONFIRMAR que lo que reclamó sigue siendo suyo.
    let existingPending: CoordinationDispatchRecord | null = null;
    let claimToken: string | null = null;
    let gateClaimedAt: string | null = null;
    // K1 (ronda 10): LA FOTO DEL RECLAMO, y es lo único que autoriza a escribir
    // sobre esta tarea del `await` en adelante. La ronda 9 blindó UNA de las
    // tres salidas de ese `await` —la que commitea—; las otras dos (la rama
    // `RUN_NOT_ACTIVE` y el `catch` del spawn) seguían escribiendo a ciegas.
    // La regla es una sola: DESPUÉS DEL `await`, NINGUNA ESCRITURA SOBRE LA
    // TAREA SIN EL TOKEN; si el token no coincide, la tarea no se toca, se
    // anota la bitácora y se compensa.
    let taskClaim: CoordinationTaskClaim;
    if (ctx.approvedGateId) {
      existingPending = this.deps.repo.getCoordinationDispatch(ctx.approvedGateId);
      if (existingPending.taskId !== task.id || existingPending.status !== 'pending_approval') {
        throw new LatteError('INVALID_GATE', 'Gate does not match a pending dispatch for this task');
      }
      if (!this.deps.repo.claimCoordinationDispatchFromGate(existingPending.id, now)) {
        throw new LatteError('INVALID_GATE', 'Gate does not match a pending dispatch for this task');
      }
      gateClaimedAt = now;
      // Por gate, el reclamo de la TAREA lo tomó quien creó la fila pendiente
      // (la dejó `dispatched` y sin miembro): la foto es la que se acaba de
      // leer, y este camino no la movió.
      taskClaim = { token: task.updatedAt, memberId: task.assignedMemberId };
    } else {
      if (task.status !== 'ready') throw new LatteError('TASK_NOT_READY', `Task is ${task.status}, not ready`);
      claimToken = this.deps.repo.claimCoordinationTaskForDispatch(task.id, now);
      if (claimToken == null) {
        throw new LatteError('TASK_NOT_READY', 'Task was already claimed by another dispatch');
      }
      taskClaim = { token: claimToken, memberId: null };
    }
    // K5 (ronda 10): EL NÚMERO DEL INTENTO SE CUENTA AL RECLAMAR, no al
    // abortar. Cada salida en contra lo calculaba en su propio momento, o sea
    // DESPUÉS del `await`: si en el medio entró un re-despacho legítimo, la
    // fila de este intento —el que empezó PRIMERO— quedaba numerada después
    // del que lo reemplazó, y la bitácora contaba la historia al revés. Se
    // cuenta acá, en el mismo tick del reclamo, y se pasa.
    const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;

    // R7: LA RESPUESTA VUELVE AL AGENTE. Preguntar estaba construido de punta a
    // punta y la respuesta no salía de la base: la tarea que volvía a la cola
    // se re-despachaba con su `spec` pelado, o sea el mismo texto de la primera
    // vez, sin una palabra de lo que el agente preguntó ni de lo que le
    // contestaron. Sólo se agrega cuando el prompt se ARMA desde la tarea: un
    // `editedPrompt` es lo que la persona escribió a mano y se respeta tal
    // cual, y una fila pendiente ya lleva la sección adentro desde que nació.
    const prompt = ctx.editedPrompt ?? existingPending?.prompt ?? this.withAnsweredAsks(task);
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
      this.deps.repo.transaction(() => this.applyDispatchDenial(run.id, task.id, existingPending, now, preflight, taskClaim));
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
      const target = this.reserveTargetMember(run.workId, task.roleId, this.approvedRoleIds(run), this.listHires(run.id).length);
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
      // K4 (ronda 10): EL CIERRE SE FECHA CUANDO SE ESCRIBE. `now` se tomó
      // ANTES del `await` que levanta el proceso, así que una fila cerrada tras
      // un spawn largo nacía con un `settled_at` ANTERIOR a su propio
      // `created_at` —medido: cuarenta minutos antes—. Del `await` en adelante,
      // el `now` de antes sirve para UNA sola cosa: ser el token del reclamo.
      const settledAt = this.deps.clock();
      if (error instanceof LatteError && error.code === 'ROLE_NOT_APPROVED') {
        this.blockOnUnapprovedRole(run, task, existingPending, prompt, settledAt, error.message, taskClaim, attempt);
      } else {
        this.releaseDispatchClaim(run, task, existingPending, prompt, settledAt, taskClaim, gateClaimedAt, attempt);
      }
      throw error;
    }

    // La foto del gasto y la escritura de la reserva viven en UNA transacción
    // sincrónica, sin ningún `await` en el medio: nadie puede leer el mismo
    // `dispatchesUsed` dos veces. Una denegación NO tira desde adentro (eso
    // haría rollback del asiento `denied` y de la suspensión, que son
    // justamente lo que hay que dejar escrito): se devuelve y se tira afuera.
    const runTransaction = (): { ok: true; dispatch: CoordinationDispatchRecord; claim: CoordinationTaskClaim } | { ok: false; error: LatteError } => {
      // LA CONFIRMACIÓN. `run` se leyó ANTES de levantar el proceso, y levantar
      // un proceso son segundos: en el medio la persona pudo cancelar o pausar.
      // Sin esta relectura, `cancelRun` escribía `cancelled`, su barrido no
      // encontraba esta tarea (todavía no había fila de despacho) y el despacho
      // commiteaba y mandaba igual — el escenario del brief, medido:
      // `{"runStatusAfterCancel":"cancelled","hubSendCalls":1,"openReservations":1}`.
      // Acá adentro, en la misma transacción que escribe la reserva, gana quien
      // escribió último en la base, no quien leyó primero.
      // L4 (ronda 9): EL RELOJ DE LA FILA ES EL DEL COMMIT.
      //
      // `now` se tomó ANTES del `await` que levanta el proceso, y levantar un
      // proceso son segundos —o, con un runtime trabado, cuarenta minutos—.
      // Con `createdAt`/`startedAt` sellados en `now`, la fila NACÍA VENCIDA:
      // el tick siguiente la medía contra `IN_FLIGHT_DISPATCH_STALE_MINUTES`,
      // la encontraba más vieja que el umbral y la liquidaba cobrándole el
      // intento a un agente que acababa de recibir su prompt. Una fila se
      // fecha cuando se escribe, no cuando se pensó en escribirla.
      const committedAt = this.deps.clock();
      // L1 (ronda 9): LA CONFIRMACIÓN DEL RECLAMO, Y ES LA MISMA REGLA QUE LA
      // DE ARRIBA APLICADA A LA TAREA.
      //
      // `runTransaction` releía el RUN y el presupuesto, nunca la TAREA — y
      // desde la ronda 8 la tarea TIENE un escritor durante el `await`: el
      // caso 3 de `settleOrphanDispatches` la devuelve a `ready` a los treinta
      // minutos. El coordinador la re-despachaba (fila, reserva y `send`
      // legítimos), y este spawn tardío volvía y escribía una SEGUNDA fila
      // abierta para la misma tarea. `report()` asume a lo sumo una, así que
      // el miembro que sí estaba trabajando recibía `FORBIDDEN`.
      //
      // Va ANTES del veredicto de presupuesto a propósito: una denegación
      // llama a `abortDispatchClaim`, que devuelve la tarea a `ready` — o sea
      // que sin confirmar primero pisaría el reclamo de otro.
      //
      // K1 (ronda 10): Y VA ANTES DE RELEER EL RUN, por exactamente la misma
      // razón. La relectura del run estaba PRIMERA, así que un despacho que
      // había perdido su reclamo llegaba a la rama `RUN_NOT_ACTIVE` y
      // `abortDispatchOnRunNotRunning` soltaba la tarea de OTRO: alcanzaba con
      // que la persona pausara el run entre el re-despacho legítimo y la
      // vuelta del spawn colgado. Primero se pregunta "¿esto sigue siendo
      // mío?"; recién después importa el estado del mundo.
      if (!this.confirmDispatchClaim(existingPending, task.id, claimToken, gateClaimedAt, session.id, committedAt)) {
        this.abortDispatchOnClaimLost(run, task, existingPending, prompt, committedAt, attempt);
        return { ok: false, error: new LatteError('CLAIM_LOST', 'This dispatch lost its claim on the task while the member was starting up') };
      }
      // A partir de acá la tarea ES de este despacho, y el token pasa a ser lo
      // que la confirmación acaba de escribir: cualquier salida en contra de
      // acá para abajo suelta CONTRA ESTA FOTO, no contra la del reclamo.
      const confirmed: CoordinationTaskClaim = { token: committedAt, memberId: session.id };
      const live = this.deps.repo.getCoordinationRun(run.id);
      if (live.status !== 'running') {
        this.abortDispatchOnRunNotRunning(run, task, existingPending, prompt, committedAt, live.status, confirmed, attempt);
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
        this.applyDispatchDenial(run.id, task.id, existingPending, committedAt, verdict, confirmed);
        return { ok: false, error: verdict.error };
      }

      const reservationId = newId('crs');
      this.deps.repo.insertCoordinationCostReservation({
        id: reservationId, runId: run.id, dispatchId: existingPending?.id ?? null, memberId: session.id, runtime: session.provider, model: session.model ?? 'default',
        maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: 0, state: 'reserved', usageJson: null, createdAt: committedAt, settledAt: null,
      });

      let dispatch: CoordinationDispatchRecord;
      if (existingPending) {
        // `memberId` se escribe ACÁ: la fila pendiente nació sin miembro (el
        // gate va antes de contratar), así que recién al aprobar se sabe
        // contra quién queda anotado el despacho.
        dispatch = this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'dispatched', memberId: session.id, prompt, reservationId, startedAt: committedAt });
      } else {
        dispatch = this.deps.repo.insertCoordinationDispatch({
          id: newId('cdp'), runId: run.id, taskId: task.id, memberId: session.id, attempt, status: 'dispatched',
          gateId: null, prompt, outcome: null, summary: null, filesJson: null, reservationId,
          createdAt: committedAt, startedAt: committedAt, settledAt: null,
        });
      }
      // La tarea ya quedó escrita —`dispatched` y con este miembro— por la
      // confirmación de arriba, que es el ÚNICO lugar donde este método le
      // pone dueño: confirmar y asignar son un solo acto. Acá había un
      // `updateCoordinationTask` sin condición alguna que repetía esa misma
      // escritura sin el token; escribir dos veces lo mismo no cambia nada,
      // pero deja en pie una forma que la regla prohíbe.
      // LA CONTRATACIÓN, anotada donde pasa. `coordinationHires` estaba
      // testeado en tres archivos del renderer y no lo alimentaba NADIE, así
      // que la bitácora no mostró jamás una sola alta. Se escribe acá adentro,
      // en la misma transacción sincrónica que commitea el despacho: si el
      // despacho se va al rollback, la contratación que nunca se usó se va con
      // él. `reservedMemberId` null significa que el camino fue `addMember`,
      // o sea que este miembro no existía hasta hace un segundo.
      if (reservedMemberId == null) this.recordHire(run.id, session.id, task.roleId, committedAt);
      return { ok: true, dispatch, claim: confirmed };
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
        // El throw hizo ROLLBACK, así que la confirmación —si llegó a
        // correr— se fue con él: lo que hay en la base es otra vez el reclamo,
        // y por eso se suelta contra `taskClaim` y no contra la foto de la
        // confirmación. K4: y se fecha ahora, no antes del `await`.
        const settledAt = this.deps.clock();
        this.releaseDispatchClaim(run, task, existingPending, prompt, settledAt, taskClaim, gateClaimedAt, attempt);
        // R2: y la contratación también se deshace. Un throw de adentro deja
        // exactamente el mismo miembro sobrante que una denegación.
        this.compensateHire(reservedMemberId, session.id, run.id, task.roleId, settledAt);
        throw error;
      }
      if (!outcome.ok) {
        // R2: la transacción dijo que no, así que el miembro que se contrató
        // PARA ESTE despacho sobra. `resolveProposalGate` ya compensaba así
        // desde siempre; acá no compensaba nadie, y cada denegación dejaba una
        // fila, un token, un cupo de techo y un proceso vivo para nadie.
        this.compensateHire(reservedMemberId, session.id, run.id, task.roleId, this.deps.clock());
        // K5 (ronda 10): Y LA PANTALLA SE ENTERA. Las salidas en contra de la
        // transacción —reclamo perdido, run pausado, tope agotado— escribían
        // fila, suspensión y liberación de la tarea y se iban por el `throw`
        // sin un solo `touch`: la persona veía su despacho congelado hasta el
        // próximo evento de otra cosa. Todo lo que escribe, avisa.
        this.touch(run.workId, run.id);
        throw outcome.error;
      }
      const dispatched = outcome.dispatch;
      const committedClaim = outcome.claim;

      // `hub.send` es el UNICO efecto real, y corre despues del commit: si el
      // proceso del miembro se murio entre `resolveTargetMember` y aca,
      // `AgentHub.route` tira NotFoundError y la transaccion ya escribio una
      // reserva `reserved`, un despacho `dispatched` y una tarea `dispatched`
      // que nadie deshacia. Nada se ejecuto, asi que la reserva se cierra SIN
      // asiento de gasto: no se cobra un despacho que nunca salio.
      try {
        await this.deps.hub.send(session.id, prompt);
      } catch (error) {
        // K4 (ronda 10): la hora del cierre es la de AHORA. Con `now` —tomado
        // antes del spawn— esta fila quedaba con `settled_at` cuarenta minutos
        // ANTERIOR a su propio `created_at`, que desde la ronda 9 es el del
        // commit. Una fila que se cierra antes de haber nacido no es un
        // detalle de prolijidad: es la bitácora mintiendo sobre el orden de lo
        // que pasó.
        const settledAt = this.deps.clock();
        this.deps.repo.transaction(() => {
          if (dispatched.reservationId) this.deps.repo.settleCoordinationCostReservation(dispatched.reservationId, null, settledAt, false);
          this.deps.repo.updateCoordinationDispatch(dispatched.id, {
            status: 'cancelled', outcome: 'not_sent', summary: error instanceof Error ? error.message : String(error), settledAt,
          });
          // K2 (ronda 10): y la tarea vuelve a la cola SÓLO si sigue siendo la
          // que este despacho commiteó. `hub.send` es un `await` más, y en esa
          // ventana un barrido puede liquidar esta fila y soltar la tarea, y el
          // coordinador re-despacharla: un UPDATE pelado acá se la quitaba al
          // que acababa de recibirla.
          this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, settledAt, committedClaim);
        });
        // Q9: y la CONTRATACIÓN también se deshace, igual que en las otras dos
        // salidas de este método (R2). Acá no se deshacía: la reserva se
        // liquidaba, la tarea volvía a `ready` y el miembro contratado PARA
        // ESTE despacho se quedaba —fila, token, cupo del techo de la app y un
        // proceso vivo— sin trabajo que hacer y sin nadie que lo fuera a
        // reclamar; el reintento contrataba a otro. Reutilizar a alguien del
        // equipo no contrató nada, así que ahí no se toca a nadie.
        this.compensateHire(reservedMemberId, session.id, run.id, task.roleId, settledAt);
        this.touch(run.workId, run.id);
        throw error;
      }
      // B5.1: LA TAREA YA ESTÁ EN SUS MANOS. A partir de acá, y no antes, un
      // fin de turno de este miembro sin `latte_report` es un turno que no
      // reportó. Todo `idle` anterior —el del spawn, el de la confirmación— es
      // de alguien que todavía no tenía nada que reportar.
      this.sentDispatches.set(session.id, { dispatchId: dispatched.id, nudged: false });
      this.deps.log?.(`[latte] coordination dispatch sent (run=${run.id} dispatch=${dispatched.id} task=${task.id} role=${task.roleId} member=${session.id})`);
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
  ): { ok: true } | { ok: false; reason: DispatchDenyReason; suspend: boolean; error: LatteError } {
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
        const reason = `global_${globalDecision.reason}` as const;
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
    verdict: { reason: DispatchDenyReason; suspend: boolean },
    claim: CoordinationTaskClaim,
  ): void {
    this.writeLedgerDenied(runId, verdict.reason);
    // `max_concurrent` nunca suspende (es un "ahora no", no un tope agotado),
    // y por eso no es un `CoordinationSuspendReason`. El tipo lo dice; esta
    // guarda lo hace cierto en tiempo de ejecución.
    if (verdict.suspend && verdict.reason !== 'max_concurrent') this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, verdict.reason);
    this.abortDispatchClaim(taskId, existingPending, now, verdict.reason, claim);
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
   * Si el DESPIDO falla, el alta se registra igual. El miembro sigue vivo, así
   * que ocultarlo dejaría un proceso contratado que ninguna bitácora nombra — y
   * la bitácora existe justamente para que la persona pueda ver lo que hay. La
   * verdad manda por encima de la prolijidad del registro.
   */
  private compensateHire(reservedMemberId: string | null, memberId: string, runId: string, roleId: string, now: string): void {
    if (reservedMemberId != null) return; // se reutilizó a alguien del equipo: no se contrató nada que deshacer
    try {
      this.deps.hub.removeMember(memberId);
    } catch {
      // El despido falló: el miembro SIGUE VIVO. Se lo vuelve a anotar como
      // alta, porque eso es lo que hay de verdad, y se sale sin tocar la
      // bitácora más allá de eso.
      try { this.recordHire(runId, memberId, roleId, now); }
      catch { /* si ni siquiera se puede anotar, no hay nada más honesto que hacer acá */ }
      return;
    }
    // Q6: y el borrado del alta va en su PROPIO try. Los dos estaban juntos, y
    // un fallo de `forgetHire` con el despido ya hecho caía en el mismo `catch`
    // y llamaba a `recordHire`: re-anotaba como contratado a alguien que
    // acababa de ser despedido de verdad. La bitácora decía lo contrario de lo
    // que había pasado, que es exactamente lo que este método existe para
    // evitar. Se anota el alta sólo si el despido falló.
    try {
      // En las dos salidas viejas la transacción hacía rollback y el
      // `recordHire` se iba con ella; en la de `hub.send` la transacción YA
      // COMMITEÓ, así que el alta queda escrita y hay que sacarla a mano. Una
      // contratación deshecha no es un alta.
      this.forgetHire(runId, memberId);
    } catch { /* el miembro ya no existe: una línea de más en la bitácora es preferible a tirar acá */ }
  }

  /**
   * El reclamo se suelta intacto: la tarea vuelve a `ready`, o el gate vuelve
   * a la mesa tal como estaba — SI TODAVÍA ES SUYO.
   *
   * K2 (ronda 10): ESTO ERA UN UPDATE PELADO, y es la salida más peligrosa de
   * las tres porque es la que corre cuando el spawn RECHAZA — o sea, casi
   * siempre tarde. Medido: un runtime que tarda media hora en decir que no,
   * sobre una tarea que el barrido soltó, que el coordinador re-despachó y que
   * el segundo miembro ya reportó `done`, la devolvía a `ready` con su
   * `result_summary` puesto: una tarea terminada volviendo a la cola, y la
   * persona sin forma de saber por qué.
   *
   * Cero filas afectadas significa que el reclamo ya es de otro. Entonces no
   * se toca nada: sólo queda la bitácora, que es lo que le explica a la
   * persona por qué ese despacho no salió.
   */
  private releaseDispatchClaim(
    run: CoordinationRunRecord,
    task: CoordinationTaskRecord,
    existingPending: CoordinationDispatchRecord | null,
    prompt: string,
    now: string,
    claim: CoordinationTaskClaim,
    gateClaimedAt: string | null,
    attempt: number,
  ): boolean {
    const released = existingPending
      ? gateClaimedAt != null && this.deps.repo.releaseCoordinationDispatchToGate(existingPending.id, gateClaimedAt)
      : this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, now, claim);
    if (!released) this.abortDispatchOnClaimLost(run, task, existingPending, prompt, now, attempt);
    return released;
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
  /*
   * K6 (ronda 10): y `failed` ES TERMINAL, así que escribirlo sin el token
   * sería la peor de las tres formas. Hoy no tiene ventana —`ROLE_NOT_APPROVED`
   * lo tira `reserveTargetMember`, que es sincrónico y corre ANTES del
   * `await`—, pero se lo alcanza desde el mismo `catch` que a
   * `releaseDispatchClaim`: el día que algo de ese camino se vuelva
   * asincrónico, esto marcaría terminal la tarea de otro. El compare-and-set
   * es defensivo y cuesta nada.
   */
  private blockOnUnapprovedRole(
    run: CoordinationRunRecord,
    task: CoordinationTaskRecord,
    existingPending: CoordinationDispatchRecord | null,
    prompt: string,
    now: string,
    reason: string,
    claim: CoordinationTaskClaim,
    attempt: number,
  ): void {
    const blocked = this.deps.repo.transaction(() => {
      if (!this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, now, claim, 'failed')) {
        // El reclamo ya no es suyo: no se marca nada terminal, sólo bitácora.
        this.abortDispatchOnClaimLost(run, task, existingPending, prompt, now, attempt);
        return false;
      }
      if (existingPending) {
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'role_not_approved', summary: reason, settledAt: now });
      } else {
        this.deps.repo.insertCoordinationDispatch({
          id: newId('cdp'), runId: run.id, taskId: task.id, memberId: '', attempt, status: 'cancelled',
          gateId: null, prompt, outcome: 'role_not_approved', summary: reason, filesJson: null, reservationId: null,
          createdAt: now, startedAt: null, settledAt: now,
        });
      }
      return true;
    });
    if (!blocked) {
      this.touch(run.workId, run.id);
      return;
    }
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
   * COMPARE-AND-SET para no pisar a quien escribió después —`cancelRun`
   * liquidando, un barrido, un reporte— y queda constancia en la bitácora, que
   * se deriva de `coordination_dispatch`: sin una fila, la persona vería una
   * tarea que vuelve sola a la cola y ninguna explicación.
   *
   * K1 (ronda 10): EL `WHERE status='dispatched'` PELADO NO ERA UN RECLAMO,
   * ERA UN ESTADO. "Sigue despachada" también es cierto cuando la despachó
   * otro, y por eso esta rama devolvía a la cola la tarea de un miembro que
   * estaba trabajando. Ahora se la llama DESPUÉS de confirmar, con la foto que
   * la confirmación escribió (`claim`), así que sólo puede soltar lo suyo.
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
    claim: CoordinationTaskClaim,
    attempt: number,
  ): void {
    const summary = `Despacho abortado: el run pasó a ${status} mientras se levantaba el miembro`;
    this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, now, claim);
    if (existingPending) {
      this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'run_not_active', summary, settledAt: now });
    } else {
      this.deps.repo.insertCoordinationDispatch({
        id: newId('cdp'), runId: run.id, taskId: task.id, memberId: '', attempt, status: 'cancelled',
        gateId: null, prompt, outcome: 'run_not_active', summary, filesJson: null, reservationId: null,
        createdAt: now, startedAt: null, settledAt: now,
      });
    }
  }

  /**
   * L1 (ronda 9): ¿EL RECLAMO SIGUE SIENDO DE ESTE DESPACHO?
   *
   * Se pregunta DENTRO de la transacción que commitea, que es el único lugar
   * donde la respuesta todavía vale. Dos caminos, dos reclamos distintos:
   *
   *  - sin gate, el reclamo es el CAS sobre la tarea, y se confirma con otro
   *    CAS que exige el mismo `updated_at` que dejó el reclamo, la tarea
   *    todavía `dispatched` y todavía sin miembro asignado. Ese mismo UPDATE
   *    escribe el miembro, así que confirmar y asignar son un solo acto;
   *  - por gate, el reclamo es el CAS sobre la fila `pending_approval`, y se
   *    confirma releyéndola: sigue `dispatched` y sigue con el `started_at`
   *    que escribió ESTE reclamo. Un barrido que la liquidó mientras el
   *    proceso levantaba la dejó `cancelled`, y una fila liquidada no revive.
   *
   * K3 (ronda 10): Y EL CAMINO POR GATE TAMBIÉN CONFIRMA LA TAREA. Confirmaba
   * la FILA y después escribía la tarea sin condición: la fila y la tarea son
   * dos filas distintas y las mueven escritores distintos —el barrido liquida
   * la fila, el caso 3 suelta la tarea—, así que "mi fila sigue siendo mía" no
   * dice nada sobre la tarea. Las dos condiciones que quedan sin token
   * (`dispatched` y sin miembro) se exigen en la MISMA sentencia que escribe
   * al miembro, que es lo que impide que dos despachos la escriban los dos.
   */
  private confirmDispatchClaim(
    existingPending: CoordinationDispatchRecord | null,
    taskId: string,
    claimToken: string | null,
    gateClaimedAt: string | null,
    memberId: string,
    committedAt: string,
  ): boolean {
    if (existingPending) {
      const live = this.deps.repo.getCoordinationDispatch(existingPending.id);
      if (live.status !== 'dispatched' || live.startedAt !== gateClaimedAt) return false;
      return this.deps.repo.confirmCoordinationTaskClaim(taskId, memberId, null, committedAt);
    }
    if (claimToken == null) return false;
    return this.deps.repo.confirmCoordinationTaskClaim(taskId, memberId, claimToken, committedAt);
  }

  /**
   * L1 (ronda 9): EL RECLAMO SE PERDIÓ, ASÍ QUE ACÁ NO SE TOCA NADA DE NADIE.
   *
   * Es la diferencia con `abortDispatchOnRunNotRunning`: allá el reclamo
   * seguía siendo nuestro y había que soltarlo; acá ya es de otro —o de
   * nadie— y cualquier escritura sobre la tarea o sobre la fila pisaría a
   * quien llegó primero. Lo único que se escribe es la bitácora, que se deriva
   * de `coordination_dispatch`: sin una fila, la persona vería un despacho que
   * se desvanece y ninguna explicación. `memberId` vacío, sin reserva,
   * `settled_at` en el acto; la contratación fresca la deshace el llamador
   * (`compensateHire`), igual que en las otras salidas en contra.
   *
   * K3 (ronda 10): CON UNA FILA PENDIENTE SE MARCA ESA, NO UNA NUEVA. El
   * camino por gate llega acá con su propia fila —la que la persona aprobó—
   * todavía abierta, y meter un asiento nuevo al lado dejaba DOS: una abierta
   * que ya nadie iba a cerrar y otra `cancelled` explicando por qué. Y si el
   * barrido ya la liquidó, no se la vuelve a escribir: ese cierre es el que de
   * verdad pasó, y pisarlo sería cambiarle la historia a la bitácora para que
   * diga lo que este despacho cree.
   */
  private abortDispatchOnClaimLost(
    run: CoordinationRunRecord,
    task: CoordinationTaskRecord,
    existingPending: CoordinationDispatchRecord | null,
    prompt: string,
    now: string,
    attempt: number,
  ): void {
    const summary = 'Despacho abortado: esta tarea dejó de ser suya mientras se levantaba el miembro';
    if (existingPending) {
      const live = this.deps.repo.getCoordinationDispatch(existingPending.id);
      // Abierta: la cierra esto. Ya cerrada PERO SIN MOTIVO —`settleUncertain`
      // cancela y no dice por qué—: se le completa el hueco, que es lo único
      // que la persona tiene para entender por qué ese despacho no salió. Ya
      // cerrada CON motivo: no se toca, ése es el que de verdad pasó.
      if (live.status === 'dispatched' || live.status === 'pending_approval') {
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'claim_lost', summary, settledAt: now });
      } else if (live.outcome == null) {
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { outcome: 'claim_lost', summary });
      }
      return;
    }
    this.deps.repo.insertCoordinationDispatch({
      id: newId('cdp'), runId: run.id, taskId: task.id, memberId: '', attempt, status: 'cancelled',
      gateId: null, prompt, outcome: 'claim_lost', summary,
      filesJson: null, reservationId: null, createdAt: now, startedAt: null, settledAt: now,
    });
  }

  /**
   * K1/K2 (ronda 10): la denegación también suelta CON EL TOKEN. Es la tercera
   * escritura sobre la tarea que vivía sin condición, y le entra por dos
   * puertas: el pre-chequeo (antes del `await`, con la foto del reclamo) y la
   * confirmación de presupuesto (después, con la foto de la confirmación). En
   * las dos, lo que suelta es lo que este despacho tomó, o nada.
   */
  private abortDispatchClaim(
    taskId: string,
    existingPending: CoordinationDispatchRecord | null,
    now: string,
    reason: string,
    claim: CoordinationTaskClaim,
  ): void {
    this.deps.repo.releaseCoordinationTaskFromDispatch(taskId, now, claim);
    if (existingPending) this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'cancelled', outcome: 'denied', summary: reason, settledAt: now });
  }

  /** `outcome:'succeeded'` unblocks dependents; `'failed'` returns the task to `ready`, or `blocked` at the attempt cap. Idempotent on an already-`done` task. */
  async report(grant: CoordinationGrant, taskId: string, outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null = null): Promise<CoordinationTaskRecord> {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    // R2: un reporte sin resumen no es un reporte.
    //
    // `summary` es lo ÚNICO que queda de la tarea una vez liquidada: con eso
    // consolida el coordinador y eso lee la persona. El esquema publicado ya
    // pone `minLength: 1`, pero el esquema mide LARGO y un resumen de puros
    // espacios lo pasa; y además `report()` tiene otra entrada que no cruza
    // el guardia de esquema (`acceptHandoffAsTask`). El candado va acá, antes
    // de mirar la tarea, así que no se toca ni el despacho ni el intento: el
    // agente puede volver a reportar, bien.
    // El código es `VALIDATION`, no `INVALID_ARGUMENT`: ése último es del
    // SOBRE MCP y no cruza IPC (hay un test que lo vigila), y `report()` tiene
    // una entrada que sí cruza IPC. `ValidationError` ya tiene frase en los
    // dos idiomas para esa puerta, y por MCP sale igual de legible.
    if (summary.trim().length === 0) throw new ValidationError('summary must say what happened: an empty report would settle the task with nothing in it');
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
    // B5.5: el reporte, en `agents.log`. Sin contenido: el resumen y los
    // archivos ya viven en la fila del despacho y en el aviso al coordinador.
    this.deps.log?.(`[latte] coordination report (run=${task.runId} dispatch=${current?.id ?? 'none'} task=${taskId} member=${grant.memberId} outcome=${outcome})`);
    // EL punto único: toda tarea que pasa a un estado terminal sale por acá.
    this.finishRunIfComplete(task.runId, now);
    // O6: Y LA SUSPENSIÓN SE RE-EVALÚA ACÁ, no en el próximo tick.
    //
    // `maybeSelfSuspendOnAsks` sólo se llamaba desde `ask()`: el camino del
    // reporte pasaba por `finishRunIfComplete` → `refreshAsks`, que únicamente
    // LEVANTA la suspensión, nunca la pone. Con la última tarea en vuelo
    // reportando y otra trabada por una pregunta, el run se quedaba `running`
    // sin nada que despachar hasta que el tick de 30 s pasara a mirarlo: la
    // pantalla decía "en curso" sobre un equipo que no tenía qué hacer.
    this.maybeSelfSuspendOnAsks(task.runId, now);
    this.touch(grant.workId, task.runId);
    // M1: Y EL COORDINADOR SE ENTERA DEL REPORTE.
    //
    // Éste era el agujero del criterio entero: "cada uno en lo suyo, otro
    // consolida". El motor tenía despacho (coordinador → miembro) y reporte
    // (miembro → base), y ahí moría: el resultado quedaba en una fila que el
    // coordinador no tenía cómo ver — `latte_check` devolvía `[]` por diseño —
    // así que consolidaba a ciegas o, peor, rehacía el trabajo él mismo.
    //
    // DESPUÉS de `finishRunIfComplete`, no antes: el conteo que viaja en el
    // aviso es el de después de este reporte, y si éste era el último, el
    // cierre ya mandó lo suyo y los dos avisos llegan en orden.
    //
    // `void`: el aviso no es parte del reporte. `deliverNotice` nunca tira, y
    // un reporte ya asentado no se deshace porque un agente no se entere.
    void this.noticeReport(task.runId, grant.memberId, task.roleId, taskId, outcome, summary, filesJson);
    return this.deps.repo.getCoordinationTask(taskId);
  }

  /**
   * El aviso de un reporte, redactado con lo que el coordinador necesita para
   * consolidar sin volver a pedir nada: quién (rol Y miembro, porque puede
   * haber dos del mismo rol), qué tarea, cómo salió, el resumen, los archivos
   * —`none` cuando no hay, nunca una lista vacía que parezca un olvido— y
   * cómo va el run.
   *
   * Nunca se avisa a sí mismo: el coordinador que hace una tarea del plan y la
   * reporta ya sabe lo que hizo, y un turno de usuario contándoselo le
   * arrancaría un turno entero para nada.
   */
  private async noticeReport(
    runId: string, reporterId: string, roleId: string, taskId: string,
    outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null,
  ): Promise<void> {
    try {
      const run = this.deps.repo.getCoordinationRun(runId);
      const coordinatorId = this.coordinatorOf(run);
      if (!coordinatorId || coordinatorId === reporterId) return;
      const tasks = this.deps.repo.listCoordinationTasks(runId);
      const count = (status: CoordinationTaskRecord['status']) => tasks.filter((t) => t.status === status).length;
      const done = count('done');
      const inFlight = count('dispatched') + count('running');
      const files = (filesJson ?? '').trim();
      await this.deliverNotice(
        coordinatorId,
        `«${roleId}» (${reporterId}) reported task ${taskId} as ${outcome}: ${summary}. `
        + `Files: ${files.length > 0 ? files : 'none'}. `
        + `Run: ${done}/${tasks.length} done, ${count('ready')} ready, ${inFlight} in flight.`,
      );
    } catch (error) {
      // Redactar el aviso lee filas, y una lectura puede fallar. El reporte ya
      // está asentado: lo único que se pierde acá es el aviso.
      this.deps.log?.(`[latte] report notice failed (${taskId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** El miembro coordinador de este run, por su columna o por el meta que `resolveGrant` lee. */
  private coordinatorOf(run: CoordinationRunRecord): string {
    return run.coordinatorMemberId || this.deps.repo.getMeta('coordination_coordinator:' + run.workId) || '';
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
   * El cierre.
   *
   * `coordination_coordinator:<workId>` SE CONSERVA (decisión del dueño,
   * 2026-09-24): quién coordina el trabajo lo elige la persona y dura; sólo se
   * va cuando ese miembro se va o cuando la persona elige a otro. Lo que sí
   * termina con el run son sus facultades: toda herramienta que exige ser
   * coordinador exige ANTES un run activo (`NO_ACTIVE_RUN`), y un run nuevo
   * fija su coordinador al nacer (`startRun` con el permiso, o el proponente
   * al aprobar la propuesta).
   */
  private closeRun(runId: string, status: 'done' | 'cancelled', now: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    // M1: el final también se avisa. El coordinador recibía un reporte por
    // tarea y después SILENCIO: sin esto no tiene cómo saber que ya no queda
    // nada que despachar, y su única salida era seguir sondeando
    // `latte_task_list` (o quedarse esperando para siempre).
    //
    // Un run `planning` que se cancela NO avisa acá: eso es un
    // plan rechazado, y `resolveProposalGate` ya le manda su propio texto — dos
    // avisos por el mismo hecho son dos turnos de usuario por el mismo hecho.
    const coordinatorId = this.coordinatorOf(run);
    const notice = run.status === 'planning'
      ? null
      : status === 'done'
        ? (() => {
          const tasks = this.deps.repo.listCoordinationTasks(runId);
          const done = tasks.filter((t) => t.status === 'done').length;
          return `Run finished: ${done} done, ${tasks.length - done} failed. Nothing left to dispatch.`
            + ' Planning and dispatching end with the run: if more work turns out to be needed, propose it again with `latte_request_coordination`.';
        })()
        : 'Run cancelled by the person. Nothing else will be dispatched; stop waiting for reports.';
    this.pendingClose.delete(runId);
    const closed = this.deps.repo.updateCoordinationRunStatus(runId, status, now, null);
    // B5.5: el último eslabón. Un run que cierra es el hecho que la persona
    // más busca en el log cuando algo quedó a medias.
    this.deps.log?.(`[latte] coordination run closed (run=${runId} work=${run.workId} status=${status})`);
    // El apagado va DESPUÉS del estado escrito: si pausar tirara, el run tiene
    // que quedar cerrado igual. Un proceso de más es un desperdicio; un run que
    // no cierra es un equipo que la persona no puede terminar.
    this.stopRunMembers(runId, coordinatorId);
    // El coordinador es el ÚLTIMO en salir, y recién cuando ya no queda nada en
    // vuelo para él: el aviso de cierre que se manda acá abajo es un turno de
    // usuario, y apagarlo antes de que ese aviso llegue es cerrarle la puerta
    // en la cara con la carta adentro. Entregado (o encolado, o fallado), se
    // apaga; si el aviso lo dejó en un turno, `pauseWhenIdle` lo aparca hasta
    // que termine, igual que a cualquier otro convocado.
    const stopCoordinator = () => this.pauseWhenIdle(coordinatorId, runId);
    if (notice) void this.deliverNotice(coordinatorId, notice).then(stopCoordinator, stopCoordinator);
    else stopCoordinator();
    return closed;
  }

  /**
   * Los que ESTE run convocó: sus altas (`listHires`) y todo el que recibió un
   * despacho. Son dos conjuntos distintos y hacen falta los dos — un miembro
   * que ya estaba en el equipo antes del run no es un alta, pero si el run lo
   * despachó, el run lo convocó.
   *
   * Al que la persona abrió A MANO no lo convocó nadie: no tiene alta ni
   * despacho, y por eso no aparece acá. Ésa es toda la regla, sin necesidad de
   * que el motor sepa qué ventana tiene abierta la persona.
   */
  private runMemberIds(runId: string): Set<string> {
    const ids = new Set<string>();
    for (const hire of this.listHires(runId)) ids.add(hire.memberId);
    try {
      for (const dispatch of this.deps.repo.listCoordinationDispatches(runId)) {
        if (dispatch.memberId) ids.add(dispatch.memberId);
      }
    } catch { /* una lectura que falla apaga de menos, nunca de más */ }
    return ids;
  }

  /** Apaga a los convocados del run, salvo el coordinador, que sale último (`closeRun`). */
  private stopRunMembers(runId: string, coordinatorId: string): void {
    for (const memberId of this.runMemberIds(runId)) {
      if (memberId === coordinatorId) continue;
      this.pauseWhenIdle(memberId, runId);
    }
  }

  /**
   * Apaga al miembro ahora, o lo aparca hasta el final de su turno.
   *
   * `pauseMember` y no `finishMember`: pausar cierra la conversación y deja la
   * fila viva y reanudable. `finishMember` además marca `done`, y terminar un
   * run no termina a nadie — la bitácora, el uso y la sesión siguen ahí.
   */
  private pauseWhenIdle(memberId: string, runId: string): void {
    if (!memberId) return;
    if (this.memberIsBusy(memberId)) {
      this.pendingPause.set(memberId, runId);
      this.deps.log?.(`[latte] coordination member stop deferred (run=${runId} member=${memberId} reason=busy)`);
      return;
    }
    this.pendingPause.delete(memberId);
    try {
      this.deps.hub.pauseMember(memberId);
      this.deps.log?.(`[latte] coordination member stopped (run=${runId} member=${memberId})`);
    } catch (error) {
      // Un miembro que ya no existe, o un proceso que se murió solo, es
      // exactamente el final que se buscaba. Se anota y se sigue.
      this.deps.log?.(`[latte] coordination member stop failed (run=${runId} member=${memberId}): ${error instanceof Error ? error.message : String(error)}`);
    }
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
    if (!memberId) return;
    const now = this.deps.clock();
    // B5.1: PRIMERO el turno que terminó sin reportar. Va antes del cierre
    // pendiente porque puede LIQUIDAR un despacho, y liquidar es justamente lo
    // que puede volver cerrable a un run que hasta este instante no lo era.
    this.noteTurnWithoutReport(memberId, now);
    // El apagado que había quedado esperando a este turno. Va acá arriba, antes
    // del corte por `pendingClose`: el run de este miembro YA cerró — si el
    // corte se leyera primero, el único convocado que estaba ocupado al cerrar
    // se quedaría vivo para siempre, que es justo el agujero que este bloque
    // tapa.
    const owedRunId = this.pendingPause.get(memberId);
    if (owedRunId !== undefined) {
      this.pendingPause.delete(memberId);
      this.pauseWhenIdle(memberId, owedRunId);
    }
    if (this.pendingClose.size === 0) return;
    // Se recorre lo PENDIENTE, no el miembro: `findMember` no sirve acá (el
    // coordinador puede no tener fila propia). Como mucho hay un puñado.
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

  /**
   * B5.1: EL TURNO QUE TERMINA SIN REPORTAR NO SE QUEDA EN VUELO PARA SIEMPRE.
   *
   * Lo que pasó de verdad (run `crn_3f40b0633ab99bf4636b`): el worker recibió
   * su tarea, la HIZO —dejó el archivo en la carpeta del Trabajo— y terminó su
   * turno sin llamar `latte_report`. El despacho quedó `dispatched`, el
   * miembro siguió vivo (así que el barrido de filas huérfanas nunca lo miró),
   * el run quedó `running` eterno y el coordinador esperó un reporte que no
   * iba a llegar nunca.
   *
   * Dos golpes, no uno. El primero es un AVISO: casi siempre el agente
   * simplemente se olvidó, y decirle qué llamar le cuesta un turno y recupera
   * el trabajo entero, con su resumen y sus archivos. El segundo —otro turno
   * terminado sin reportar— ya no es un olvido: ahí se liquida el despacho con
   * motivo visible (`no_report`), se cobra el intento y se le dice al
   * coordinador qué pasó, porque el único desenlace peor que perder la tarea es
   * que nadie sepa que se perdió.
   *
   * Los candados, todos por la misma razón (un aviso es un turno de usuario, y
   * un turno de usuario de más sobre alguien que no hizo nada mal es ruido que
   * cuesta plata):
   * - Sin envío no hay aviso: `sentDispatches` se escribe DESPUÉS de
   *   `hub.send`, así que el `idle` del spawn y cualquiera anterior al envío
   *   no existen para este camino.
   * - Una `latte_ask` abierta de este miembro (o sobre esta tarea) es ocio
   *   LEGÍTIMO: preguntó y está esperando. Se sale sin consumir el aviso, así
   *   que el candado no se gasta.
   * - Un run que ya no está activo no espera ningún reporte.
   * - Al coordinador no se lo empuja: su turno termina todo el tiempo sin
   *   reportar nada, porque lo suyo es despachar.
   */
  private noteTurnWithoutReport(memberId: string, now: string): void {
    const tracked = this.sentDispatches.get(memberId);
    if (!tracked) return;
    try {
      const dispatch = this.deps.repo.getCoordinationDispatch(tracked.dispatchId);
      // Reportado, liquidado o cancelado: el rastro ya no sirve para nada, y
      // borrarlo es lo que hace que un `latte_report` normal después del aviso
      // no deje un solo residuo.
      if (dispatch.status !== 'dispatched' && dispatch.status !== 'running') { this.sentDispatches.delete(memberId); return; }
      const run = this.deps.repo.getCoordinationRun(dispatch.runId);
      if (run.status !== 'running' && run.status !== 'suspended' && run.status !== 'planning') { this.sentDispatches.delete(memberId); return; }
      if (this.coordinatorOf(run) === memberId) return;
      // El candado de la pregunta abierta: NO se consume el aviso. Cuando la
      // persona conteste y el miembro vuelva a terminar su turno, el chequeo
      // corre otra vez desde cero.
      if (this.openAsksHolding(run.id, now).some((ask) => ask.memberId === memberId || (ask.taskId != null && ask.taskId === dispatch.taskId))) return;
      const task = this.deps.repo.getCoordinationTask(dispatch.taskId);
      if (!tracked.nudged) {
        tracked.nudged = true;
        this.deps.log?.(`[latte] coordination turn ended without report (run=${run.id} dispatch=${dispatch.id} task=${task.id} member=${memberId}) nudged`);
        void this.deliverNotice(memberId, this.noReportNudgeText(task));
        return;
      }
      this.sentDispatches.delete(memberId);
      this.settleUncertain(dispatch.id, { incrementAttempts: true, reason: 'no_report' });
      const settled = this.deps.repo.getCoordinationTask(dispatch.taskId);
      this.deps.log?.(`[latte] coordination dispatch settled (run=${run.id} dispatch=${dispatch.id} task=${task.id} member=${memberId} reason=no_report task_status=${settled.status})`);
      const coordinatorId = this.coordinatorOf(run);
      if (coordinatorId && coordinatorId !== memberId) {
        void this.deliverNotice(
          coordinatorId,
          `«${task.roleId}» (${memberId}) ended two turns without calling \`latte_report\` for task ${task.id}, even after being reminded. `
          + `Latte closed dispatch ${dispatch.id} as \`no_report\` and charged the attempt; the task is now \`${settled.status}\`. `
          + 'Nothing was reported about its result: whatever it did is unrecorded. If you still need it, dispatch it again — '
          + 'and check the Work folder first, because it may have left files behind without telling anyone.',
        );
      }
    } catch (error) {
      // Un rastro que ya no se puede leer (la fila borrada, la base trabada) no
      // puede volver a intentarse para siempre: se suelta, y el barrido de
      // arranque sigue siendo la red de abajo.
      this.sentDispatches.delete(memberId);
      this.deps.log?.(`[latte] coordination turn-end check failed (${memberId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * El texto del aviso, en inglés y sin i18n como el resto de lo que el motor
   * le manda a un agente: esto no lo lee una persona. Dice EXACTAMENTE qué
   * llamar y con qué argumentos, porque un aviso que sólo señala el error
   * gasta un turno y no arregla nada.
   */
  private noReportNudgeText(task: CoordinationTaskRecord): string {
    const title = taskTitle(task.spec, task.title, 120) || task.id;
    return `Your turn ended without reporting the task Latte gave you. Task ${task.id}: «${title}».\n\n`
      + `Call \`latte_report\` now: \`taskId: "${task.id}"\`, \`outcome: "succeeded"\` if you finished it or \`"failed"\` if you could not, `
      + 'and a `summary` of what you actually did.\n\n'
      + 'If you left work for another role — a file, a draft, a handoff — say so in the summary and name the file in `files`. '
      + 'Latte delivers your report to the coordinator, and that report is the ONLY way anyone learns what you produced: '
      + 'a file written in the Work folder that no report mentions is invisible to the rest of the team.\n\n'
      + 'If this turn also ends without a report, Latte will close the dispatch as unreported, charge the attempt and tell the coordinator the task was lost.';
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
   * listas y su plazo vencido hacía horas.
   *
   * Q7: quien lo corre sin que nadie mire es `sweepActiveRuns` —el tick
   * periódico del servicio—, más los caminos que YA escriben (`report`,
   * `answerAsk`, `resumeRun`, `noteTurnEnded`, el barrido de arranque). Las
   * lecturas por IPC (`listGates`, `listOpenAsks`) lo corrían y dejaron de
   * hacerlo: cerrar un run es una escritura, y una lectura que cierra runs le
   * saca el permiso al coordinador por el solo hecho de abrir una pantalla.
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
    // Q6: CON LA BANDERA BAJA, EL TICK NO ENCIENDE NADA.
    //
    // Este `running` es una reactivación: un run suspendido vuelve a estar
    // disponible para despachar. Con `feature:coordination` apagada eso es
    // exactamente lo que el interruptor promete que no pasa, y el barrido lo
    // hacía solo, sin que nadie hubiera tocado nada. Con la bandera baja el
    // tick sólo cierra (`finish`) y vence preguntas: las dos cosas terminan
    // trabajo, ninguna lo empieza.
    // La suspensión se levanta cuando su MOTIVO deja de ser cierto, no sólo
    // cuando no queda ninguna pregunta: con una pregunta vigente sobre una
    // tarea y otra tarea `ready` para despachar, "todo bloqueado" ya es falso.
    //
    // L3 (ronda 9): Y ESA CUENTA SE HACE EN UN SOLO LUGAR. Acá vivía media
    // fórmula —sólo la reactivación, y sólo con la bandera arriba— y en
    // `answerAsk` vivía la otra media. Un vencimiento con la bandera abajo
    // dejaba la fila diciendo `all_blocked_on_ask` sin una sola pregunta
    // esperando; una bandera que volvía con preguntas nuevas dejaba la fila
    // diciendo `coordination_disabled` cuando lo que detenía al equipo ya eran
    // las preguntas. Dos fórmulas parciales para el mismo campo es cómo ese
    // campo termina mintiendo.
    this.reconcileSuspendReason(runId, now);
    // Y el cierre. La recursión termina en un paso: `finishRunIfComplete`
    // vuelve a entrar acá, pero ya no queda nada vencido que cerrar, así que
    // `expired` es cero y no reentra.
    if (expired > 0) this.finishRunIfComplete(runId, now);
    return expired;
  }

  /**
   * L3 (ronda 9): EL MOTIVO DE UNA SUSPENSIÓN, CALCULADO ENTERO Y EN UN SOLO
   * LUGAR.
   *
   * Tres preguntas en orden, porque el orden ES la regla: quien detiene al
   * equipo manda sobre quien lo detenía antes.
   *
   *  1. la bandera abajo ⇒ `coordination_disabled`. Es lo más fuerte: el
   *     interruptor promete un equipo detenido, y nada de acá adentro lo
   *     reactiva;
   *  2. si no, y todo lo despachable espera una respuesta ⇒
   *     `all_blocked_on_ask`;
   *  3. si no, y el motivo actual era uno de esos dos ⇒ `running`. Lo que lo
   *     retenía dejó de ser cierto.
   *
   * `paused_by_human` NO ENTRA, ni como entrada ni como salida: lo puso una
   * persona y sólo una persona lo saca. Tampoco entran los motivos de
   * presupuesto, que se levantan subiendo el tope, no dejando de mirarlos.
   *
   * Lo llaman los cuatro caminos que pueden cambiar la respuesta: `answerAsk`,
   * `refreshAsks`, el tick (`sweepActiveRuns`) y `resumeRun` —éste a través de
   * `refreshAsks`, que es su primera línea—.
   */
  private reconcileSuspendReason(runId: string, now: string): void {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'suspended' || !isAskSuspendReason(run.suspendReason)) return;
    const enabled = this.deps.isCoordinationEnabled ? this.deps.isCoordinationEnabled() : true;
    if (!enabled) {
      if (run.suspendReason !== 'coordination_disabled') this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, 'coordination_disabled');
      return;
    }
    if (this.allBlockedOnAsks(runId, now)) {
      if (run.suspendReason !== 'all_blocked_on_ask') this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, 'all_blocked_on_ask');
      return;
    }
    this.deps.repo.updateCoordinationRunStatus(runId, 'running', now, null);
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
    // Q5: UNA TAREA EN VUELO NO ESTÁ ESPERANDO NADA — hay alguien haciéndola.
    //
    // `ask()` no mueve a `blocked` una tarea ya despachada, y con razón: su
    // reporte tiene que poder entrar. Pero acá esa misma tarea entraba igual en
    // `readyEligible` y su pregunta la marcaba como bloqueada, así que el caso
    // REAL —el worker pregunta MIENTRAS trabaja, que es cuando le aparece la
    // duda— suspendía el run entero con `all_blocked_on_ask` teniendo a un
    // miembro trabajando. El run quedaba detenido por un bloqueo que no existía.
    //
    // Q6: la señal es el despacho vivo, pero NO como exclusión del conjunto.
    // Excluir la tarea en vuelo dejaba el conjunto con las trabadas solas, así
    // que una tarea en cola trabada por una pregunta suspendía el run entero
    // teniendo a otro miembro trabajando — la misma regresión que Q5 quiso
    // arreglar, corrida un caso más allá. Con algo en el aire el equipo NO está
    // bloqueado, punto: el reporte que entre volverá a evaluar esto. Es el mismo
    // conjunto que `finishRunIfComplete` mira para no cerrar un run con trabajo
    // en vuelo.
    //
    // N1 (ronda 7): LA ANTIGÜEDAD NO ES EVIDENCIA DE MUERTE, Y ACÁ NO SE MIRA
    // EL RELOJ.
    //
    // O6 excluía de `inFlight` toda fila más vieja que
    // `IN_FLIGHT_DISPATCH_STALE_MINUTES`. Un reloj no sabe si hay alguien
    // trabajando: una tarea legítima de 31 minutos dejaba de contar, el run se
    // suspendía `all_blocked_on_ask` CON un miembro adentro, el coordinador
    // recibía `RUN_NOT_ACTIVE` en el `latte_task_create` siguiente, y
    // "Reanudar" se deshacía en el tick siguiente. Y el zombi de verdad
    // tampoco se arreglaba: seguía reteniendo el cierre, ahora con el equipo
    // suspendido por un motivo falso.
    //
    // M1 (ronda 8): Y LA SEÑAL ES LA DEL ADAPTADOR, NO LA DE LA TABLA.
    //
    // La ronda 7 preguntó por `hub.listTeam` —o sea `repo.listMembers` +
    // `describe()`— con la condición `status !== 'ended'`. La tabla de miembros
    // SOBREVIVE a la muerte del proceso: sin adaptador, `describe()` devuelve
    // `paused`, que pasa ese filtro. Así que un miembro muerto sin `closed`, o
    // pausado por la persona, contaba como trabajo vivo PARA SIEMPRE: el run
    // no podía suspenderse ni cerrar, y `settleOrphanDispatches` nunca
    // liquidaba nada. Quien sabe si hay alguien adentro es el ADAPTADOR
    // (`hub.liveMemberIds`), que es quien tiene los procesos.
    const run = this.deps.repo.getCoordinationRun(runId);
    const open = this.deps.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched' || d.status === 'running');
    // M1(b), PRIMERA LECTURA DE UN HUB QUE TIRA: "hay alguien adentro". Nunca
    // se suspende un equipo sobre información que no se pudo obtener —
    // suspender es una decisión, y no saber no es una razón para tomarla.
    // (`settleOrphanDispatches` lee el mismo silencio al revés, y ahí también
    // lo conservador es no actuar: ver su docstring.)
    const live = this.liveMemberIds(run.workId);
    if (live === null && open.length > 0) return false;
    const inFlight = new Set(open.filter((d) => this.memberIsInside(d.memberId, live)).map((d) => d.taskId));
    if (inFlight.size > 0) return false;
    const readyEligible = tasks.filter((t) =>
      t.status === 'ready' || t.status === 'blocked' || t.status === 'dispatched' || t.status === 'running');
    return readyEligible.length > 0 && readyEligible.every((t) => blockedTaskIds.has(t.id));
  }

  /**
   * M1: QUIÉN ESTÁ ADENTRO, EN UNA SOLA PREGUNTA POR EVALUACIÓN.
   *
   * `hub.liveMemberIds` recorre los adaptadores una vez y devuelve los
   * miembros que alguno POSEE. Se cachea en el llamador —un `Set` por run por
   * tick— en vez de preguntar de a un despacho: la versión anterior llamaba a
   * `listTeam` por cada fila abierta, y `listTeam` pasa por `describe()`, que
   * además TIENE EFECTO COLATERAL (borra la sesión publicada del miembro sin
   * adaptador). Preguntar "¿está vivo?" no puede escribir.
   *
   * `null` significa NO SE PUDO SABER, y no se confunde con "no hay nadie":
   * los dos llamadores leen ese silencio de forma distinta y a propósito.
   */
  private liveMemberIds(workId: string): Set<string> | null {
    try { return this.deps.hub.liveMemberIds(workId); } catch { return null; }
  }

  /**
   * Vivo (algún adaptador lo posee) o en medio de un turno. Con `live` en
   * `null` nadie se declara adentro: el que decide qué hacer con eso es el
   * llamador.
   *
   * L10 (ronda 9): y un `isMemberBusy` que TIRA se lee acá como "hay alguien
   * adentro", igual que en `memberIsBusySafe`. El `catch { return false }`
   * contradecía el comentario de su único llamador —"un hub que tira se lee en
   * `allBlockedOnAsks` como 'hay alguien adentro'"—, que es la regla que
   * `live === null` ya aplica una línea más arriba en el llamador. Suspender
   * es una decisión, y no saber no es una razón para tomarla.
   */
  private memberIsInside(memberId: string, live: Set<string> | null): boolean {
    if (!memberId) return false;
    if (live?.has(memberId)) return true;
    try { return this.deps.hub.isMemberBusy(memberId); } catch { return true; }
  }

  /**
   * M1: LOS TRES HUÉRFANOS REALES, TODOS CONTRA
   * `IN_FLIGHT_DISPATCH_STALE_MINUTES`.
   *
   * La ronda 7 dejó esto como código muerto: preguntaba por la TABLA de
   * miembros, que sobrevive a la muerte del proceso, así que la condición "el
   * hub no lo conoce" no se cumplía nunca. Con la señal del adaptador, los
   * casos que hay que recoger son tres, y NO se liquidan igual:
   *
   *  1. Fila abierta SIN NADIE ADENTRO (proceso muerto sin `closed`, o miembro
   *     pausado por la persona). `incrementAttempts:false`: perder el proceso
   *     —o pausarlo— no es culpa del agente, igual que en el barrido de
   *     arranque. La reserva se cierra y la tarea vuelve a `ready`.
   *  2. Fila abierta con el miembro VIVO pero NO OCUPADO: terminó su turno y
   *     nunca llamó a `latte_report`. `incrementAttempts:true`, porque eso SÍ
   *     es un intento fallido del agente; al tope, la tarea queda `failed` en
   *     vez de reintentarse para siempre.
   *  3. Tarea `dispatched` SIN NINGUNA fila de despacho abierta: el spawn se
   *     colgó entre el CAS que reclamó la tarea y el `insert` de la fila, que
   *     viene DESPUÉS del `await` que levanta el proceso. No hay reserva ni
   *     asiento que cerrar —nunca se escribieron—, así que no se liquida nada:
   *     se suelta el reclamo con el CAS inverso
   *     (`releaseCoordinationTaskFromDispatch`), que no puede pisar a quien
   *     haya escrito después. Su reloj es el `updatedAt` de la TAREA, que es
   *     lo único que ese estado dejó.
   *
   * M1(b), SEGUNDA LECTURA DE UN HUB QUE TIRA: "no liquidar en este tick". Es
   * la opuesta a la de `allBlockedOnAsks` y por la misma razón de fondo: lo
   * conservador es no actuar. Allá actuar es suspender, acá actuar es liquidar
   * el trabajo de alguien que a lo mejor está adentro. El tick siguiente
   * vuelve a preguntar.
   */
  private settleOrphanDispatches(run: CoordinationRunRecord, now: string): void {
    const live = this.liveMemberIds(run.workId);
    if (live === null) return;
    const staleBefore = new Date(new Date(now).getTime() - IN_FLIGHT_DISPATCH_STALE_MINUTES * 60_000).toISOString();
    const open = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.status === 'dispatched' || d.status === 'running');
    const asks = this.deps.repo.listCoordinationAsksForRun(run.id);
    // L7 (ronda 9): UN `try` POR FILA, Y OTRO PARA EL BLOQUE DEL CASO 3.
    //
    // `sweepActiveRuns` le dio a cada uno de sus cuatro pasos su propio
    // `guard` por esta misma razón, y adentro de este paso el problema se
    // repetía a otra escala: una sola fila que tirara —una reserva con bytes
    // corruptos, un despacho cuya tarea ya no existe— se llevaba puestas a
    // TODAS las demás de ese run y al bloque del caso 3, en silencio, hasta el
    // próximo tick. Y como el defecto que la hace tirar no se arregla solo, el
    // tick siguiente se traba en la misma fila: las otras quedaban rehenes
    // para siempre.
    const guard = (what: string, fn: () => void): void => {
      try { fn(); } catch (error) { this.deps.log?.(`[latte] coordination sweep (${what}) failed: ${error instanceof Error ? error.message : String(error)}`); }
    };
    for (const dispatch of open) guard(`settleOrphanDispatch ${dispatch.id}`, () => {
      // L2 (ronda 9): EL QUE ESPERA UNA RESPUESTA NO ES UN HUÉRFANO.
      //
      // El caso 2 describe a un agente que terminó su turno y no reportó. Un
      // worker que llamó a `latte_ask` MIENTRAS trabajaba se ve idéntico desde
      // afuera —vivo, `!isBusy`, su tarea `dispatched` a propósito para que su
      // reporte pueda entrar, haciendo poll con `latte_ask_status`—, y podía
      // estar así hasta `ASK_TTL_MAX_MINUTES`, o sea un día entero. A los
      // treinta y un minutos el barrido le liquidaba la fila COBRÁNDOLE UN
      // INTENTO por haber preguntado.
      if (this.asksHolding(asks, dispatch, now).length > 0) return;
      // Y cuando la pregunta se vence o se contesta, el reloj arranca AHÍ. Un
      // despacho de dos horas que pasó una hora y media esperando una respuesta
      // no lleva dos horas sin dar señales: lleva media.
      if (this.orphanClock(asks, dispatch) > staleBefore) return;
      if (this.memberIsBusySafe(dispatch.memberId)) return; // hay un turno en vuelo: es trabajo, no un huérfano
      // Vivo pero ocioso: terminó sin reportar, y eso se cobra.
      this.settleUncertain(dispatch.id, { incrementAttempts: live.has(dispatch.memberId) });
    });
    // Caso 3: la tarea reclamada cuyo despacho nunca llegó a nacer.
    guard('settleOrphanClaims', () => {
      const stillOpen = new Set(
        this.deps.repo.listCoordinationDispatches(run.id)
          .filter((d) => d.status === 'dispatched' || d.status === 'running' || d.status === 'pending_approval')
          .map((d) => d.taskId));
      for (const task of this.deps.repo.listCoordinationTasks(run.id)) {
        if (task.status !== 'dispatched' || stillOpen.has(task.id)) continue;
        if (task.updatedAt > staleBefore) continue;
        // K1 (ronda 10): el CAS va contra lo que este barrido acaba de LEER.
        // Entre la lectura de la lista y esta línea no hay `await`, pero la
        // condición vieja (`status='dispatched'` a secas) no decía "la que
        // leí" sino "cualquiera que esté despachada" — la misma forma que
        // dejaba soltar la tarea de otro. Acá el token es el `updatedAt` de la
        // tarea, que es lo único que ese estado dejó escrito.
        this.deps.repo.releaseCoordinationTaskFromDispatch(task.id, now, { token: task.updatedAt, memberId: task.assignedMemberId });
      }
    });
  }

  /**
   * L2: las preguntas de ESTE despacho. Dos vínculos, porque las preguntas
   * tienen los dos: la que nombra su `taskId`, y la que el MISMO MIEMBRO hizo
   * sin nombrar ninguna tarea (`latte_ask` acepta el `taskId` opcional, y un
   * worker que pregunta a mitad de su turno no siempre lo pasa).
   */
  private asksOfDispatch(asks: CoordinationAskRecord[], dispatch: CoordinationDispatchRecord): CoordinationAskRecord[] {
    return asks.filter((ask) =>
      (ask.taskId != null && ask.taskId === dispatch.taskId)
      || (dispatch.memberId !== '' && ask.memberId === dispatch.memberId));
  }

  /** Las de este despacho que TODAVÍA esperan: sin responder y sin vencer. Es el mismo filtro de `openAsksHolding`, acotado a una fila. */
  private asksHolding(asks: CoordinationAskRecord[], dispatch: CoordinationDispatchRecord, now: string): CoordinationAskRecord[] {
    return this.asksOfDispatch(asks, dispatch).filter((ask) => ask.answeredAt == null && ask.deadlineAt > now);
  }

  /**
   * L2: DESDE CUÁNDO este despacho no da señales. El máximo entre su propio
   * arranque y el instante en que su última pregunta dejó de esperar.
   *
   * Y ese instante NO es siempre `answeredAt`: `expireCoordinationAsk` escribe
   * ahí la marca del TICK que pasó a cerrarla, que puede ser horas posterior
   * al plazo. Una pregunta que se venció dejó de esperar en su `deadlineAt`,
   * no cuando alguien vino a anotarlo. La respuesta de verdad —la única que
   * lleva texto (`answerCoordinationAsk` siempre lo escribe)— sí cuenta por su
   * `answeredAt`. Y la vencida que este mismo tick todavía no cerró también
   * cae en `deadlineAt`, porque `settleOrphanDispatches` corre ANTES que
   * `refreshAsks`.
   */
  private orphanClock(asks: CoordinationAskRecord[], dispatch: CoordinationDispatchRecord): string {
    let clock = dispatch.startedAt ?? dispatch.createdAt;
    for (const ask of this.asksOfDispatch(asks, dispatch)) {
      const stoppedWaiting = ask.answer != null && ask.answeredAt != null ? ask.answeredAt : ask.deadlineAt;
      if (stoppedWaiting > clock) clock = stoppedWaiting;
    }
    return clock;
  }

  /**
   * "¿Hay un turno en vuelo?", sin que el hub pueda tumbar el barrido.
   *
   * L10 (ronda 9): Y UN HUB QUE TIRA SE LEE COMO "OCUPADO", que es lo
   * conservador acá y lo que el docstring de `settleOrphanDispatches` promete
   * desde la ronda 8 ("no liquidar en este tick"). El `catch { return false }`
   * hacía exactamente lo contrario de lo escrito: convertía un fallo del hub
   * en "no hay nadie adentro" y liquidaba la fila de alguien que podía estar
   * trabajando. Su hermano `liveMemberIds` ya devuelve `null` —no sé— y el
   * llamador sale sin tocar nada; ésta es la otra mitad de la misma regla.
   *
   * `memberId` vacío es un hecho, no un fallo: una fila `pending_approval`
   * todavía no tiene miembro, así que ahí no hay ningún turno en vuelo.
   */
  private memberIsBusySafe(memberId: string): boolean {
    if (!memberId) return false;
    try { return this.deps.hub.isMemberBusy(memberId); } catch { return true; }
  }

  /**
   * La reparación de las bases que dejó la versión sin estado final: un run
   * `running`/`suspended` cuyas tareas ya están todas terminales pasa a `done`
   * al arrancar. Corre junto a `sweepUncertainDispatches` (y después de él: el
   * barrido puede devolver tareas a `ready`, y ésas no cierran nada).
   * Idempotente: la segunda corrida no encuentra nada que escribir.
   */
  /**
   * Q7: EL BARRIDO PERIÓDICO. Lo llama el tick del servicio
   * (`LatteService.sweepCoordination`, cada 30 s) y nadie más.
   *
   * Existe porque las lecturas dejaron de escribir: `listGates` y
   * `listOpenAsks` corrían `refreshAsks` —y con él `finishRunIfComplete` y
   * `closeRun`— así que abrir Decisiones podía terminar un equipo y borrarle el
   * permiso al coordinador. El motivo por el que ese barrido tenía que correr
   * seguía siendo válido: un run `suspended` por `all_blocked_on_ask` no
   * recibe ninguna otra llamada. La diferencia es que ahora lo corre algo que
   * escribe a propósito, en vez de algo que la persona creía que sólo miraba.
   *
   * CUATRO PASOS por run activo, todos idempotentes y baratos, en este orden:
   *
   *  1. liquidar lo que no tiene a nadie adentro (`settleOrphanDispatches`):
   *     libera reservas y devuelve tareas a `ready`, así que los tres
   *     siguientes miran el estado de verdad y no el que dejó un proceso
   *     muerto;
   *  2. vencer lo vencido (`refreshAsks`), que ya levanta la suspensión cuyo
   *     motivo dejó de ser cierto;
   *  3. volver a preguntarse si el run terminó (`finishRunIfComplete`);
   *  4. re-evaluar la auto-suspensión (`maybeSelfSuspendOnAsks`).
   *
   * Un run que se cierra en un paso no se toca en los siguientes: todos releen
   * su estado y salen.
   *
   * M3 (ronda 8): CADA PASO EN SU PROPIO `try`, igual que el `guard` de la
   * rama `closed` de `bootstrap.ts`. Los cuatro escriben en la base y los
   * cuatro pueden tirar; con un solo `try`, un fallo en el primero —el que más
   * escribe y el único que consulta al hub— se llevaba puestos a los otros
   * tres: el equipo quedaba sin vencer preguntas, sin cerrar y sin
   * re-evaluarse, en silencio, hasta el próximo arranque de la app. El orden
   * importa (cada paso deja el estado más limpio para el siguiente); la
   * dependencia no: ninguno necesita que el anterior haya salido bien.
   *
   * Nunca tira hacia afuera: un run roto no puede impedir que los demás se
   * barran.
   */
  sweepActiveRuns(): void {
    const now = this.deps.clock();
    const guard = (what: string, fn: () => void): void => {
      try { fn(); } catch (error) { this.deps.log?.(`[latte] coordination sweep (${what}) failed: ${error instanceof Error ? error.message : String(error)}`); }
    };
    for (const run of this.deps.repo.listActiveCoordinationRuns()) {
      guard('settleOrphanDispatches', () => this.settleOrphanDispatches(run, now));
      guard('refreshAsks', () => this.refreshAsks(run.id, now));
      guard('finishRunIfComplete', () => this.finishRunIfComplete(run.id, now));
      guard('maybeSelfSuspendOnAsks', () => this.maybeSelfSuspendOnAsks(run.id, now));
      // L3 (ronda 9): y el motivo, al final y en su propio paso. Es el único
      // camino que un run `suspended` recorre de verdad —no recibe reportes ni
      // despachos—, así que si la fórmula no corre acá no corre en ningún
      // lado: el equipo se queda con el motivo que le dejó el último evento,
      // que puede haber dejado de ser cierto hace horas.
      guard('reconcileSuspendReason', () => this.reconcileSuspendReason(run.id, now));
    }
  }

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
   * M3: EL BUZÓN DEJA DE ESTAR VACÍO.
   *
   * Hasta hoy esto devolvía `[]` siempre y estaba bien que lo dijera: nada
   * escribía en `coordination_message`. Con `latte_message` ya hay productor,
   * así que `latte_check` es de verdad la lectura de un miembro: lo que le
   * escribieron y todavía no leyó, MÁS el estado del run, que es lo que hace
   * falta para decidir si seguís, si esperás o si ya no hay nada que hacer.
   *
   * FIFO y una sola entrega: leer CONSUME. La segunda llamada devuelve `[]` y
   * eso es lo correcto — un mensaje que vuelve a aparecer en cada sondeo hace
   * que el agente lo conteste dos veces.
   */
  check(memberId: string, runId: string | null = null): CoordinationCheckResult {
    // El run del GRANT primero: `resolveGrant` ya lo resolvió contra el
    // Trabajo del miembro, y viene con `requiresRun` cumplido. Buscarlo de
    // nuevo por la fila del miembro (`activeRunForMember`) es el camino de los
    // llamadores directos, que no tienen grant.
    const run = runId ? this.deps.repo.getCoordinationRun(runId) : this.activeRunForMember(memberId);
    if (!run) return { run: null, messages: [] };
    const messages = this.deps.repo.listUndeliveredCoordinationMessages(run.id, memberId);
    const now = this.deps.clock();
    for (const m of messages) this.deps.repo.markCoordinationMessageDelivered(m.id, now);
    const tasks = this.deps.repo.listCoordinationTasks(run.id);
    const count = (status: CoordinationTaskRecord['status']) => tasks.filter((t) => t.status === status).length;
    return {
      run: {
        status: run.status,
        tasks: {
          ready: count('ready'), dispatched: count('dispatched') + count('running'),
          done: count('done'), failed: count('failed'), blocked: count('blocked'), pending: count('pending'),
        },
      },
      messages: messages.map((m) => ({
        id: m.id,
        from: m.fromMemberId ? { memberId: m.fromMemberId, roleId: this.roleIdOf(run.workId, m.fromMemberId) } : null,
        text: m.body,
        createdAt: m.createdAt,
      })),
    };
  }

  /**
   * M2: UN MIEMBRO LE ESCRIBE A OTRO. La pieza que faltaba para que los roles
   * sean roles: si uno necesita algo de otro, se lo PIDE en vez de inventarlo
   * o de hacerlo él mismo.
   *
   * `to` acepta las tres formas que un agente tiene a mano: `"coordinator"`
   * (que no sabe qué id tiene), un `roleId` del equipo (que es como piensa: "el
   * diseñador") o un `memberId` concreto (el que vino en un aviso). Fuera del
   * Trabajo no se escribe NUNCA: el aislamiento entre Marcas no se negocia por
   * comodidad de direccionamiento.
   *
   * Se GUARDA y se entrega, en ese orden. La fila es la verdad —sobrevive al
   * proceso, y es lo que la persona va a leer— y la entrega es el empujón:
   * `deliverNotice` la encola si el destinatario está en medio de un turno, y
   * el resultado lo dice sin mentir (`delivered` sólo si el `send` resolvió).
   */
  async message(grant: CoordinationGrant, to: string, text: string): Promise<{ delivered: boolean; queued: boolean; to: string }> {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    // Defensa en profundidad: el esquema MCP publica y hace cumplir el mismo
    // tope, y este método es público.
    const cleanTo = requireText(to, 'Recipient', LIMITS.name);
    const cleanText = requireText(text, 'Message', LIMITS.decision);
    const run = this.assertRunMutable(this.deps.repo.getCoordinationRun(grant.runId));
    const toMemberId = this.resolveMessageTarget(run, cleanTo);
    const now = this.deps.clock();
    this.deps.repo.insertCoordinationMessage({
      id: newId('cms'), runId: run.id, toMemberId, fromMemberId: grant.memberId,
      kind: 'note', body: cleanText, deliveredAt: null, createdAt: now,
    });
    this.touch(run.workId, run.id);
    const outcome = await this.deliverNotice(
      toMemberId,
      `Message from «${this.roleIdOf(run.workId, grant.memberId)}» (${grant.memberId}): ${cleanText}`
      + '\n\nReply with `latte_message` if they need an answer; `latte_check` shows anything else waiting for you.',
    );
    return { ...outcome, to: toMemberId };
  }

  /**
   * A quién le llega. `coordinator` sale del run; un id de miembro se acepta
   * sólo si es DE ESTE TRABAJO (si es de otro, `FORBIDDEN`, no `NOT_FOUND`: la
   * diferencia entre "no existe" y "no es tuyo" es la que enseña el límite); y
   * un rol se resuelve contra el equipo vivo, prefiriendo al que tiene un
   * despacho abierto de este run — si hay dos copywriters, el que está
   * trabajando en esto es el que te interesa.
   */
  private resolveMessageTarget(run: CoordinationRunRecord, to: string): string {
    if (to === 'coordinator') {
      const coordinatorId = this.coordinatorOf(run);
      if (!coordinatorId) throw new NotFoundError('CoordinationMember', 'coordinator');
      return coordinatorId;
    }
    const team = this.teamOf(run.workId).filter((m) => m.status !== 'ended');
    const byId = team.find((m) => m.id === to);
    if (byId) return byId.id;
    // Un id que el hub no publica todavía puede ser una fila real: si es de
    // otro Trabajo, el pedido se rechaza acá y no escribe una sola fila.
    const member = this.deps.repo.findMember(to);
    if (member) {
      if (member.workId !== run.workId) {
        throw new LatteError('FORBIDDEN', 'That member belongs to another Work. A coordination message never leaves its own Work.');
      }
      return member.id;
    }
    // Esquema 14: el id de una PERSONA del plantel. Convocada acá, es su hilo
    // en este trabajo; de otra marca, el mismo FORBIDDEN que otro trabajo; sin
    // convocar, tampoco se le escribe: arrancaría un proceso que nadie pidió.
    const person = this.deps.repo.findBrandMember(to);
    if (person) {
      if (person.brandId !== this.deps.repo.brandIdOfWork(run.workId)) {
        throw new LatteError('FORBIDDEN', 'That person belongs to another Brand. A coordination message never leaves its own Work.');
      }
      const convocation = this.deps.repo.findConvocation(run.workId, person.id);
      if (convocation) return convocation.id;
      throw this.notCalledUp(person.roleId);
    }
    const sameRole = team.filter((m) => m.roleId === to);
    if (sameRole.length > 0) {
      const working = new Set(this.deps.repo.listCoordinationDispatches(run.id)
        .filter((d) => d.status === 'dispatched' || d.status === 'running').map((d) => d.memberId));
      return (sameRole.find((m) => working.has(m.id)) ?? sameRole[0]).id;
    }
    if (this.rosterHas(run.workId, to)) throw this.notCalledUp(to);
    throw new NotFoundError('CoordinationMember', to);
  }

  /** Alguien del plantel que nadie convocó a este trabajo: el límite, dicho con la salida. */
  private notCalledUp(roleId: string): LatteError {
    return new LatteError(
      'FORBIDDEN',
      `«${roleId}» is on this Brand's team but not called up in this Work, so a message would reach nobody. Calling them up needs the person's approval: it goes in membersToHire of a coordination proposal (latte_request_coordination).`,
    );
  }

  /** El rol de un miembro, del equipo vivo o de su fila. Vacío cuando ya no hay ni una ni otra: nunca un rol inventado. */
  private roleIdOf(workId: string, memberId: string): string {
    const fromTeam = this.teamOf(workId).find((m) => m.id === memberId);
    if (fromTeam) return fromTeam.roleId;
    try { return this.deps.repo.findMember(memberId)?.roleId ?? ''; } catch { return ''; }
  }

  private teamOf(workId: string): Array<{ id: string; roleId: string; status: string }> {
    try { return this.deps.hub.listTeam(workId); } catch { return []; }
  }

  /**
   * M4: TODO el buzón de un run, para la persona. Los mensajes entre agentes
   * son parte de lo que pasó en el Trabajo, y hasta acá no había forma de
   * verlos: leer no consume nada (a diferencia de `check`) y los ids vienen
   * con su rol resuelto, porque `mem_fake_1` no le dice nada a nadie.
   */
  listMessages(runId: string): Array<{
    id: string; runId: string;
    from: { memberId: string; roleId: string } | null;
    to: { memberId: string; roleId: string };
    text: string; readAt: string | null; createdAt: string;
  }> {
    const run = this.deps.repo.getCoordinationRun(runId);
    return this.deps.repo.listCoordinationMessages(runId).map((m) => ({
      id: m.id,
      runId: m.runId,
      from: m.fromMemberId ? { memberId: m.fromMemberId, roleId: this.roleIdOf(run.workId, m.fromMemberId) } : null,
      to: { memberId: m.toMemberId, roleId: this.roleIdOf(run.workId, m.toMemberId) },
      text: m.body,
      readAt: m.deliveredAt,
      createdAt: m.createdAt,
    }));
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

  /**
   * A synchronous poll of one ask: never blocks. Past its deadline and still
   * unanswered, it reports `{answered:false}` rather than hanging.
   *
   * R7: toma el GRANT y exige que la pregunta sea de ESTE run. Es la misma
   * regla que `report()` ya aplica sobre `taskId`, y pasa a hacer falta de
   * verdad ahora que `latte_ask_status` expone esto por MCP: sin el chequeo,
   * un miembro de la Marca B con un token válido pasaba un `askId` de la Marca
   * A y se llevaba su pregunta y su respuesta.
   */
  askStatus(grant: CoordinationGrant, askId: string): { answered: boolean; answer: string | null; deadline: string; expiredAt: string | null } {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    const ask = this.deps.repo.getCoordinationAsk(askId);
    if (ask.runId !== grant.runId) throw new NotFoundError('CoordinationAsk', askId);
    // F5: `answeredAt` con `answer` en `null` es una pregunta CERRADA POR
    // VENCIMIENTO, no una respondida. Decir `answered:true` con la respuesta en
    // `null` le haría creer al agente que la persona contestó y no dijo nada.
    if (ask.answeredAt && ask.answer !== null) return { answered: true, answer: ask.answer, deadline: ask.deadlineAt, expiredAt: null };
    // Q6: LO QUE VENCE UNA PREGUNTA ES SU PLAZO, no que alguien haya pasado a
    // anotarlo. Acá se devolvía `ask.answeredAt` a secas, o sea el instante en
    // que el barrido la cerró — y al barrido lo corren los caminos de
    // ESCRITURA. Un agente que pregunta y después sólo consulta, que es
    // exactamente para lo que existe esta herramienta, leía `expiredAt: null`
    // indefinidamente y se quedaba esperando una respuesta cuyo plazo había
    // pasado hacía horas. Se compara el plazo contra el reloj de ahora; el
    // cierre anotado, si lo hay, sigue valiendo.
    const expiredAt = ask.answeredAt ?? (ask.deadlineAt <= this.deps.clock() ? ask.deadlineAt : null);
    return { answered: false, answer: null, deadline: ask.deadlineAt, expiredAt };
  }

  /**
   * La tarea MÁS lo que ya se preguntó y se contestó sobre ella (R7).
   *
   * En inglés y sin i18n a propósito: esto no lo lee una persona, lo lee el
   * agente, igual que el resto de su prompt y que los packs de rol. Y se marca
   * como vinculante para que no vuelva a preguntar lo mismo: un agente que
   * repite la pregunta que ya le contestaron vuelve a trabar su tarea y a
   * gastar un despacho.
   *
   * Sólo las CONTESTADAS: una vencida se cerró con `answer` en `null` y nadie
   * dijo nada, así que no hay nada que pasarle.
   */
  private withAnsweredAsks(task: CoordinationTaskRecord): string {
    let answered: CoordinationAskRecord[] = [];
    try {
      answered = this.deps.repo.listCoordinationAsksForTask(task.id).filter((ask) => ask.answer !== null);
    } catch { return task.spec; } // una bitácora de preguntas ilegible no puede impedir el despacho
    if (answered.length === 0) return task.spec;
    const lines = answered.map((ask) => `- You asked: ${ask.question}\n  The human answered: ${ask.answer}`);
    return `${task.spec}\n\n## Answers to your questions\n\nYou asked about this task and the human answered. These answers are binding: follow them, and do not ask the same thing again.\n\n${lines.join('\n')}`;
  }

  /**
   * Crash/death settlement. `incrementAttempts:false` for an app-restart crash
   * (not the agent's fault); `true` for a member-process death (a real failure).
   *
   * B5.1: `reason` SE ESCRIBE EN LA FILA. Había un pendiente documentado
   * ("settleUncertain sin motivo en la bitácora") y hasta acá toda liquidación
   * quedaba igual a cualquier otra: `cancelled` sin `outcome`, sin una palabra
   * sobre por qué. La bitácora ya dibuja `outcome`, así que un despacho cerrado
   * porque nadie reportó se lee como lo que es. Sin `reason` la fila queda
   * exactamente como quedaba antes — los dos llamadores viejos no cambian.
   */
  settleUncertain(dispatchId: string, opts: { incrementAttempts: boolean; reason?: string }): CoordinationDispatchRecord {
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
          detailJson: JSON.stringify({ taskId: dispatch.taskId, outcome: opts.reason ?? 'uncertain' }), createdAt: now,
        });
      }
      const settled = this.deps.repo.updateCoordinationDispatch(dispatchId, opts.reason
        ? { status: 'cancelled', outcome: opts.reason, settledAt: now }
        : { status: 'cancelled', settledAt: now });
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
    // O6: y la misma re-evaluación que el reporte. Liquidar el último despacho
    // en vuelo es exactamente el momento en que "hay alguien trabajando" deja
    // de ser cierto, así que es cuando hay que volver a preguntarse si todo lo
    // que queda está esperando una respuesta.
    this.maybeSelfSuspendOnAsks(dispatch.runId, now);
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

  private createTaskRow(runId: string, roleId: string, spec: string, dependsOnIds: string[], title?: unknown): CoordinationTaskRecord {
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
      // N2: el título es opcional y de adorno: uno que no es texto no rompe
      // la tarea, se ignora. Y se guarda acotado.
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, TASK_TITLE_STORED) : null,
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

  private reserveTargetMember(workId: string, roleId: string, approvedRoles: Set<string> | null = null, calledUpSoFar = 0): { reuseMemberId: string | null; reservationKey: string; context: MemberContext } {
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
      throw new LatteError('ROLE_NOT_APPROVED', `Hiring a ${roleId} was not part of the approved plan; it needs its own approval${this.rosterNote(workId, roleId)}`);
    }
    // El tope de convocados por run (limits.ts): reutilizar no cuenta, traer
    // a alguien más sí. La tarea vuelve intacta a `ready` (no es un fracaso de
    // nadie) y el coordinador puede dársela a quien ya está.
    if (candidates.length === 0 && calledUpSoFar >= MAX_CALLED_UP_MEMBERS_PER_RUN) {
      throw new LatteError('TOO_MANY_CALLED_UP', `This run already called up ${calledUpSoFar} people, the most one run may; give the task to someone already on this Work`);
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
