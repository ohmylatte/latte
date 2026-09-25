import { createHash } from 'node:crypto';
import { CHAT_RUNTIMES, DEFAULT_EFFORT_TIER, EFFORT_TIERS, EMPTY_USAGE, type Brand, type BrandContextProposal, type BrandContextProposalStatus, type BrandContextRevision, type BrandContextRevisionSource, type CoordinationSuspendReason, type FunnelStage, type ChatRuntime, type ChatUsage, type Decision, type DecisionSource, type DecisionStatus, type EffortTier, type Revision, type Work } from '../../shared/contracts';
import type { ArtifactCheck, DeliveryEvidence, GenerationReceipt } from '../../shared/generationContracts';
import { GenerationContractError } from '../generation/errors';
import { hashGenerationContext } from '../generation/canon';
import { newId } from '../core/ids';
import { LatteError, NotFoundError, ValidationError } from '../core/errors';
import { addUsage, parseUsage, serializeUsage } from '../core/usage';
import { avatarFromSeed, serializeAvatar } from '../../shared/avatar';
import type { SqlDriver, SqlRow } from './driver';
import { BrandingRepository } from './brandingRepository';
import { BRANDING_SCHEMA_SQL } from './brandingSchema';
import { ConnectionsRepository } from './connectionsRepository';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
// The fingerprint is the SAME value the Contexto view and the CAS check use, so
// it is imported instead of re-implemented: one algorithm, one history.
import { brandContextFingerprint } from '../workspace/brandContextProtocol';

interface BrandRow extends SqlRow { id: string; name: string; context: string; created_at: string; archived_at: string | null }
interface WorkRow extends SqlRow { id: string; brand_id: string; title: string; brief: string; dir: string | null; expected_output: string | null; result_path: string | null; out_of_scope_stages: string; updated_at: string }
interface RevisionRow extends SqlRow { id: string; work_id: string; document_id: string | null; source: string; content: string; created_at: string }
interface DecisionRow extends SqlRow { id: string; work_id: string; text: string; created_at: string }
interface DecisionProposalRow extends SqlRow { id:string; work_id:string; statement:string; rationale:string; alternatives:string; evidence:string; status:string; source_chat_id:string|null; source_message_id:string|null; source_member_id:string|null; source_role_id:string|null; source_runtime:string|null; client_request_id:string; fingerprint:string; created_at:string; decided_at:string|null }
interface BrandContextProposalRow extends SqlRow {
  id: string; brand_id: string; work_id: string;
  source_chat_id: string | null; source_message_id: string | null; source_member_id: string | null;
  source_role_id: string | null; source_runtime: string | null;
  text: string; rationale: string; mode: string; status: string; fingerprint: string;
  base_fingerprint: string; client_request_id: string | null; created_at: string; decided_at: string | null;
  decided_reason: string | null; superseded_by: string | null;
}
interface DocumentRow extends SqlRow { id: string; work_id: string; kind: string; title: string; file_name: string; status: string; funnel_stages: string; proposed_stages: string; base_doc_id: string | null; base_rev_id: string | null; base_print: string | null; last_print: string | null; created_at: string; updated_at: string }
interface BrandContextRevisionRow extends SqlRow { id: string; brand_id: string; source: string; origin: string | null; content: string; fingerprint: string; created_at: string }
interface MemberRow extends SqlRow { id: string; work_id: string; role_id: string; role_name: string; initial: string; runtime: string; model: string | null; account_id: string | null; session_id: string; done: number; continued_from: string | null; tier: string | null; usage_json: string | null; brand_member_id: string | null; created_at: string; updated_at: string }
interface BrandMemberRow extends SqlRow { id: string; brand_id: string; role_id: string; role_name: string; initial: string; avatar: string | null; runtime: string; model: string | null; account_id: string | null; tier: string | null; coordinator: number; last_called_at: string; retired_at: string | null; created_at: string; updated_at: string }
interface GenerationRow extends SqlRow { id: string; work_id: string; brand_id: string; context_json: string; context_hash: string; created_at: string }
interface EvidenceRow extends SqlRow { id: string; generation_id: string; runtime: string; chat_id: string | null; projected_at: string; files_written: string }
interface CheckRow extends SqlRow { id: string; generation_id: string; relative_path: string; file_hash: string | null; checks_json: string; brand_compliant: number | null; created_at: string }
interface CoordinationRunRow extends SqlRow { id: string; work_id: string; status: string; coordinator_member_id: string | null; budget_json: string; plan_json: string | null; plan_approved_at: string | null; suspend_reason: string | null; created_at: string; updated_at: string }
interface CoordinationTaskRow extends SqlRow { id: string; run_id: string; seq: number; role_id: string; spec: string; title: string | null; status: string; depth: number; attempts: number; in_plan: number; assigned_member_id: string | null; result_summary: string | null; result_files_json: string | null; created_at: string; updated_at: string }
interface CoordinationDispatchRow extends SqlRow { id: string; run_id: string; task_id: string; member_id: string; attempt: number; status: string; gate_id: string | null; prompt: string; outcome: string | null; summary: string | null; files_json: string | null; reservation_id: string | null; created_at: string; started_at: string | null; settled_at: string | null }
interface CoordinationMessageRow extends SqlRow { id: string; run_id: string; to_member_id: string; from_member_id: string | null; kind: string; body: string; delivered_at: string | null; created_at: string }
interface CoordinationAskRow extends SqlRow { id: string; run_id: string; task_id: string | null; member_id: string; question: string; answer: string | null; deadline_at: string; answered_at: string | null; created_at: string }
interface CoordinationCostReservationRow extends SqlRow { id: string; run_id: string; dispatch_id: string | null; member_id: string; runtime: string; model: string; max_input_tokens: number; max_output_tokens: number; max_cost_micros: number; state: string; usage_json: string | null; created_at: string; settled_at: string | null }
interface CoordinationCostLedgerRow extends SqlRow { id: string; run_id: string; reservation_id: string | null; kind: string; dispatches: number; cost_micros: number; detail_json: string; created_at: string }

/** Persisted part of a tracked document. Titles and status are UI-facing; the file name is Latte-generated. */
export interface DocumentRecord {
  id: string;
  workId: string;
  kind: string;
  title: string;
  fileName: string;
  status: string;
  funnelStages: FunnelStage[];
  /** Stages the agent proposed and the human has not answered yet. Never applied on its own. */
  proposedFunnelStages: FunnelStage[];
  baseDocumentId: string | null;
  baseRevisionId: string | null;
  baseFingerprint: string | null;
  /** Fingerprint of the last content Latte itself wrote or accepted; the fallback base for a save without one. */
  lastFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Persisted part of a team member (status is derived live by the hub). */
export interface TeamMemberRecord {
  id: string;
  workId: string;
  roleId: string;
  roleName: string;
  initial: string;
  runtime: ChatRuntime;
  model: string | null;
  accountId: string | null;
  /** Runtime-native id for resume; empty until the runtime reveals it. */
  sessionId: string;
  done: boolean;
  /** Member this one continues. Optional on insert: most members start from scratch. */
  continuedFrom?: string | null;
  /** Effort tier. Optional on insert: an omitted one means the default, like the column's. */
  tier?: EffortTier;
  /** Lifetime consumption. Optional on insert: a new member has consumed nothing. */
  usage?: ChatUsage;
  /**
   * La persona del plantel de la marca de la que esta fila es la convocatoria
   * (esquema 14). Opcional al insertar y NULL en una fila escrita por fuera del
   * hub: `migrate()` la completa en el próximo arranque.
   */
  brandMemberId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Alguien del plantel de una marca (esquema 14): la identidad que un trabajo
 * convoca. No es un proceso ni una conversación —eso es la convocatoria, una
 * fila de `team_members`—, así que estar acá no corre nada.
 */
export interface BrandMemberRecord {
  id: string;
  brandId: string;
  roleId: string;
  roleName: string;
  initial: string;
  /** Cara propia, serializada. `null` = la del rol, calculada al leer. */
  avatar: string | null;
  runtime: ChatRuntime;
  model: string | null;
  accountId: string | null;
  tier: EffortTier;
  /** El coordinador habitual de la marca (brief 2.3): exclusivo, lo escribe `setBrandCoordinator`. */
  coordinator: boolean;
  lastCalledAt: string;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Autonomous coordination records (schema 12). Kept local to the storage
 * layer for now: Phase 1 only ships the store and the pure `dag`/`budget`
 * modules, wired to nothing, so there is no IPC surface yet to justify
 * promoting these to `shared/contracts.ts` (that is Phase 2, task 2.1).
 */
export type CoordinationRunStatus = 'planning' | 'running' | 'suspended' | 'done' | 'cancelled';

export interface CoordinationRunRecord {
  id: string;
  workId: string;
  status: CoordinationRunStatus;
  coordinatorMemberId: string | null;
  /** The per-run budget snapshot, copied from the Work's default at run start. */
  budgetJson: string;
  planJson: string | null;
  planApprovedAt: string | null;
  suspendReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CoordinationTaskStatus = 'pending' | 'ready' | 'dispatched' | 'running' | 'done' | 'failed' | 'blocked';

export interface CoordinationTaskRecord {
  id: string;
  runId: string;
  seq: number;
  roleId: string;
  spec: string;
  /** N2: el título que mandó el coordinador, cuando lo mandó. `null`/ausente: se deriva del spec. */
  title?: string | null;
  status: CoordinationTaskStatus;
  depth: number;
  attempts: number;
  /** Whether this task was part of the plan snapshot approved under `'plan'` authority. A column, never a JSON diff. */
  inPlan: boolean;
  assignedMemberId: string | null;
  resultSummary: string | null;
  resultFilesJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * K1 (ronda 10): LA FOTO DEL RECLAMO, que es lo que autoriza a escribir sobre
 * una tarea DESPUÉS del `await` que levanta el proceso del miembro.
 *
 * `token` es el `updated_at` que este despacho dejó escrito —al reclamar, o al
 * confirmar—; `memberId` es el dueño que esa misma escritura dejó: `null`
 * mientras el reclamo no está confirmado, el miembro una vez que lo está.
 * Todo compare-and-set posterior compara contra ESTA foto: si no coincide, la
 * tarea ya es de otro y no se la toca.
 */
export interface CoordinationTaskClaim {
  token: string;
  memberId: string | null;
}

/** One dependency edge: `taskId` depends on `dependsOnId`. */
export interface CoordinationTaskDep {
  taskId: string;
  dependsOnId: string;
}

export type CoordinationDispatchStatus = 'pending_approval' | 'dispatched' | 'running' | 'reported' | 'failed' | 'rejected' | 'cancelled';

/** One row per dispatch attempt. The bitácora's only source: never write narrative text that isn't backed by one of these. */
export interface CoordinationDispatchRecord {
  id: string;
  runId: string;
  taskId: string;
  memberId: string;
  attempt: number;
  status: CoordinationDispatchStatus;
  gateId: string | null;
  prompt: string;
  outcome: string | null;
  summary: string | null;
  filesJson: string | null;
  reservationId: string | null;
  createdAt: string;
  startedAt: string | null;
  settledAt: string | null;
}

export type CoordinationMessageKind = 'task' | 'answer' | 'note';

export interface CoordinationMessageRecord {
  id: string;
  runId: string;
  toMemberId: string;
  fromMemberId: string | null;
  kind: CoordinationMessageKind;
  body: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface CoordinationAskRecord {
  id: string;
  runId: string;
  taskId: string | null;
  memberId: string;
  question: string;
  answer: string | null;
  deadlineAt: string;
  answeredAt: string | null;
  createdAt: string;
}

export type CoordinationCostReservationState = 'reserved' | 'settled' | 'uncertain';

/** Column-for-column `learning_cost_reservations` (see learningSchema.ts). */
export interface CoordinationCostReservationRecord {
  id: string;
  runId: string;
  dispatchId: string | null;
  memberId: string;
  runtime: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
  state: CoordinationCostReservationState;
  usageJson: string | null;
  createdAt: string;
  settledAt: string | null;
}

export type CoordinationCostLedgerKind = 'spend' | 'duplicate_spend' | 'denied';

/** Column-for-column `learning_cost_ledger`; the row is append-only by trigger, never by convention alone. */
export interface CoordinationCostLedgerRecord {
  id: string;
  runId: string;
  reservationId: string | null;
  kind: CoordinationCostLedgerKind;
  dispatches: number;
  costMicros: number;
  detailJson: string;
  createdAt: string;
}

const BRAND_SELECT = 'SELECT b.id, b.name, b.context, b.created_at, a.archived_at FROM brands b LEFT JOIN brand_archives a ON a.brand_id = b.id';
const toBrand = (r: BrandRow): Brand => ({ id: r.id, name: r.name, context: r.context, createdAt: r.created_at, archivedAt: r.archived_at ?? null });
const toWork = (r: WorkRow): Work => ({ id: r.id, brandId: r.brand_id, title: r.title, brief: r.brief, folder: r.dir ?? null, expectedOutput: r.expected_output ?? null, resultPath: r.result_path ?? null, outOfScopeStages: parseStages(r.out_of_scope_stages), updatedAt: r.updated_at });
const toRevision = (r: RevisionRow): Revision => ({
  id: r.id,
  workId: r.work_id,
  documentId: r.document_id ?? briefDocumentId(r.work_id),
  source: r.source === 'external' || r.source === 'latte' ? r.source : 'human',
  content: r.content,
  createdAt: r.created_at,
});
function parseStages(value: string): FunnelStage[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? [...new Set(parsed.filter((s): s is FunnelStage => ['discovery', 'consideration', 'conversion', 'retention'].includes(s)))] : []; } catch { return []; }
}
const toDocument = (r: DocumentRow): DocumentRecord => ({
  id: r.id,
  workId: r.work_id,
  kind: r.kind,
  title: r.title,
  fileName: r.file_name,
  status: r.status,
  funnelStages: parseStages(r.funnel_stages),
  proposedFunnelStages: parseStages(r.proposed_stages),
  baseDocumentId: r.base_doc_id,
  baseRevisionId: r.base_rev_id,
  baseFingerprint: r.base_print,
  lastFingerprint: r.last_print,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const emptySource = (): DecisionSource => ({ chatId:null,messageId:null,memberId:null,roleId:null,runtime:null });
const jsonStrings = (value:string):string[] => { try { const v:unknown=JSON.parse(value); return Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[]; } catch { return []; } };
const toDecision = (r: DecisionRow): Decision => ({ id:r.id,workId:r.work_id,text:r.text,rationale:'',alternativesRejected:[],evidenceRefs:[],status:'approved',source:emptySource(),clientRequestId:null,fingerprint:'',createdAt:r.created_at,decidedAt:r.created_at });
const toProposal = (r:DecisionProposalRow):Decision => ({id:r.id,workId:r.work_id,text:r.statement,rationale:r.rationale,alternativesRejected:jsonStrings(r.alternatives),evidenceRefs:jsonStrings(r.evidence),status:r.status as DecisionStatus,source:{chatId:r.source_chat_id,messageId:r.source_message_id,memberId:r.source_member_id,roleId:r.source_role_id,runtime:readSourceRuntime(r.source_runtime)},clientRequestId:r.client_request_id,fingerprint:r.fingerprint,createdAt:r.created_at,decidedAt:r.decided_at});
const toBrandContextProposal = (r: BrandContextProposalRow): BrandContextProposal => ({
  id: r.id,
  brandId: r.brand_id,
  workId: r.work_id,
  source: {
    chatId: r.source_chat_id,
    messageId: r.source_message_id,
    memberId: r.source_member_id,
    roleId: r.source_role_id,
    runtime: readSourceRuntime(r.source_runtime),
  },
  text: r.text,
  rationale: r.rationale,
  mode: r.mode === 'replace' ? 'replace' : 'append',
  status: r.status === 'approved' || r.status === 'rejected' ? r.status : 'pending',
  fingerprint: r.fingerprint,
  baseFingerprint: r.base_fingerprint,
  clientRequestId: r.client_request_id,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedReason: r.decided_reason === 'approved' || r.decided_reason === 'rejected' || r.decided_reason === 'superseded' || r.decided_reason === 'auto-recorded' ? r.decided_reason : null,
  supersededBy: r.superseded_by ?? null,
});
const toBrandContextRevision = (r: BrandContextRevisionRow): BrandContextRevision => ({
  id: r.id,
  brandId: r.brand_id,
  source: (r.source === 'proposal' || r.source === 'clear' || r.source === 'restore') ? r.source : 'human',
  origin: r.origin ?? null,
  content: r.content,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});
const toGeneration = (r: GenerationRow): GenerationReceipt => ({
  id: r.id,
  workId: r.work_id,
  brandId: r.brand_id,
  context: JSON.parse(r.context_json) as GenerationReceipt['context'],
  contextJson: r.context_json,
  contextHash: r.context_hash,
  createdAt: r.created_at,
});
const toEvidence = (r: EvidenceRow): DeliveryEvidence => ({
  id: r.id,
  generationId: r.generation_id,
  runtime: r.runtime,
  chatId: r.chat_id,
  projectedAt: r.projected_at,
  filesWritten: jsonStrings(r.files_written),
});
const toCheck = (r: CheckRow): ArtifactCheck => {
  let checks: ArtifactCheck['checks'] = [];
  try {
    const parsed: unknown = JSON.parse(r.checks_json);
    if (Array.isArray(parsed)) {
      checks = parsed.filter((c): c is ArtifactCheck['checks'][number] =>
        !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
        && typeof (c as { passed?: unknown }).passed === 'boolean'
        && typeof (c as { note?: unknown }).note === 'string');
    }
  } catch { /* stored payload is audit data; a corrupt row still has identity */ }
  return {
    id: r.id,
    generationId: r.generation_id,
    relativePath: r.relative_path,
    fileHash: r.file_hash,
    checks,
    brandCompliant: r.brand_compliant === null ? null : r.brand_compliant === 1,
    createdAt: r.created_at,
  };
};
const toMember = (r: MemberRow): TeamMemberRecord => ({
  id: r.id,
  workId: r.work_id,
  roleId: r.role_id,
  roleName: r.role_name,
  initial: r.initial,
  runtime: readRuntime(r.runtime),
  model: r.model,
  accountId: r.account_id,
  sessionId: r.session_id,
  done: r.done === 1,
  continuedFrom: r.continued_from ?? null,
  // A tier nobody recognises (a hand-edited row, a build ahead of this one)
  // reads as the default rather than propagating an unknown word upwards.
  tier: (EFFORT_TIERS as readonly string[]).includes(r.tier ?? '') ? (r.tier as EffortTier) : DEFAULT_EFFORT_TIER,
  usage: parseUsage(r.usage_json),
  brandMemberId: r.brand_member_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
/** Un runtime que este build no conoce se lee como OpenCode, el de siempre; Grok y Hermes se leen como lo que son. */
const readRuntime = (runtime: string): ChatRuntime => ((CHAT_RUNTIMES as readonly string[]).includes(runtime) ? runtime as ChatRuntime : 'opencode');
const readSourceRuntime = (runtime: string | null): ChatRuntime | null => (runtime && (CHAT_RUNTIMES as readonly string[]).includes(runtime) ? runtime as ChatRuntime : null);
const readTier = (tier: string | null): EffortTier => ((EFFORT_TIERS as readonly string[]).includes(tier ?? '') ? (tier as EffortTier) : DEFAULT_EFFORT_TIER);
const toBrandMember = (r: BrandMemberRow): BrandMemberRecord => ({
  id: r.id,
  brandId: r.brand_id,
  roleId: r.role_id,
  roleName: r.role_name,
  initial: r.initial,
  avatar: r.avatar,
  runtime: readRuntime(r.runtime),
  model: r.model,
  accountId: r.account_id,
  tier: readTier(r.tier),
  coordinator: r.coordinator === 1,
  lastCalledAt: r.last_called_at,
  retiredAt: r.retired_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCoordinationRun = (r: CoordinationRunRow): CoordinationRunRecord => ({
  id: r.id,
  workId: r.work_id,
  status: r.status as CoordinationRunStatus,
  coordinatorMemberId: r.coordinator_member_id,
  budgetJson: r.budget_json,
  planJson: r.plan_json,
  planApprovedAt: r.plan_approved_at,
  suspendReason: r.suspend_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toCoordinationTask = (r: CoordinationTaskRow): CoordinationTaskRecord => ({
  id: r.id,
  runId: r.run_id,
  seq: Number(r.seq),
  roleId: r.role_id,
  spec: r.spec,
  title: r.title ?? null,
  status: r.status as CoordinationTaskStatus,
  depth: Number(r.depth),
  attempts: Number(r.attempts),
  inPlan: Number(r.in_plan) === 1,
  assignedMemberId: r.assigned_member_id,
  resultSummary: r.result_summary,
  resultFilesJson: r.result_files_json,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toCoordinationDispatch = (r: CoordinationDispatchRow): CoordinationDispatchRecord => ({
  id: r.id,
  runId: r.run_id,
  taskId: r.task_id,
  memberId: r.member_id,
  attempt: Number(r.attempt),
  status: r.status as CoordinationDispatchStatus,
  gateId: r.gate_id,
  prompt: r.prompt,
  outcome: r.outcome,
  summary: r.summary,
  filesJson: r.files_json,
  reservationId: r.reservation_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  settledAt: r.settled_at,
});
const toCoordinationMessage = (r: CoordinationMessageRow): CoordinationMessageRecord => ({
  id: r.id,
  runId: r.run_id,
  toMemberId: r.to_member_id,
  fromMemberId: r.from_member_id,
  kind: r.kind as CoordinationMessageKind,
  body: r.body,
  deliveredAt: r.delivered_at,
  createdAt: r.created_at,
});
const toCoordinationAsk = (r: CoordinationAskRow): CoordinationAskRecord => ({
  id: r.id,
  runId: r.run_id,
  taskId: r.task_id,
  memberId: r.member_id,
  question: r.question,
  answer: r.answer,
  deadlineAt: r.deadline_at,
  answeredAt: r.answered_at,
  createdAt: r.created_at,
});
const toCoordinationCostReservation = (r: CoordinationCostReservationRow): CoordinationCostReservationRecord => ({
  id: r.id,
  runId: r.run_id,
  dispatchId: r.dispatch_id,
  memberId: r.member_id,
  runtime: r.runtime,
  model: r.model,
  maxInputTokens: Number(r.max_input_tokens),
  maxOutputTokens: Number(r.max_output_tokens),
  maxCostMicros: Number(r.max_cost_micros),
  state: r.state as CoordinationCostReservationState,
  usageJson: r.usage_json,
  createdAt: r.created_at,
  settledAt: r.settled_at,
});
const toCoordinationCostLedger = (r: CoordinationCostLedgerRow): CoordinationCostLedgerRecord => ({
  id: r.id,
  runId: r.run_id,
  reservationId: r.reservation_id,
  kind: r.kind as CoordinationCostLedgerKind,
  dispatches: Number(r.dispatches),
  costMicros: Number(r.cost_micros),
  detailJson: r.detail_json,
  createdAt: r.created_at,
});

/** Id determinista de la persona del plantel que la migración 13 → 14 crea a partir de una convocatoria. */
function migratedBrandMemberId(memberId: string): string {
  return `bm_${createHash('sha1').update(`${memberId}\0brand-member`).digest('hex').slice(0, 20)}`;
}

/** Deterministic id for a member created by the v2 -> v3 migration (idempotent re-runs). */
function legacyMemberSuffix(workId: string, runtime: string): string {
  return createHash('sha1').update(`${workId}\0${runtime}`).digest('hex').slice(0, 20);
}

/**
 * The brief document of a work always has the same id, derived from the work
 * id. Revisions written before v4 carry document_id NULL and are read back as
 * belonging to this document, so no historical row is ever updated.
 */
export function briefDocumentId(workId: string): string {
  return `doc_${createHash('sha1').update(`${workId}\0brief`).digest('hex').slice(0, 20)}`;
}

/**
 * Plain SQL repository. It owns the schema and the row mapping; it does not
 * know about the filesystem, ids generation or validation (service layer).
 */
export class LatteRepository {
  readonly branding: BrandingRepository;
  /** Las Conexiones MCP y sus secretos (esquema 13, brief de conexiones 4.3). */
  readonly connections: ConnectionsRepository;

  constructor(private readonly db: SqlDriver) {
    this.branding = new BrandingRepository(db);
    this.connections = new ConnectionsRepository(db);
  }

  /**
   * Schema version recorded on disk, readable before migrate() writes
   * anything. Null for a database that was never migrated — the meta table
   * may not exist yet — which is the same thing as "brand new" here.
   */
  storedSchemaVersion(): string | null {
    try {
      const row = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(BRANDING_SCHEMA_SQL);
    // N2: las tareas de coordinación ganan un título opcional. Mismo patrón:
    // ADD COLUMN no es idempotente, así que se mira la tabla primero.
    const coordinationTaskColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('coordination_task')").map(c => c.name);
    if (coordinationTaskColumns.length > 0 && !coordinationTaskColumns.includes('title')) this.db.run('ALTER TABLE coordination_task ADD COLUMN title TEXT');
    const documentColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('documents')").map(c => c.name);
    if (!documentColumns.includes('funnel_stages')) this.db.run("ALTER TABLE documents ADD COLUMN funnel_stages TEXT NOT NULL DEFAULT '[]'");
    if (documentColumns.length > 0 && !documentColumns.includes('proposed_stages')) this.db.run("ALTER TABLE documents ADD COLUMN proposed_stages TEXT NOT NULL DEFAULT '[]'");
    // v3 -> v4: revisions gain document_id + source. ADD COLUMN is not
    // idempotent, so it is gated on pragma_table_info; existing rows keep
    // document_id NULL ("the work's brief document") because the immutability
    // trigger forbids updating them.
    const workColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('works')").map((c) => c.name);
    if (workColumns.length > 0 && !workColumns.includes('dir')) this.db.run('ALTER TABLE works ADD COLUMN dir TEXT');
    // The outcome of a work (what it should deliver, and the Deliverables file
    // linked as its result). Nullable, so every existing row reads as "not
    // set"; not in SCHEMA_SQL, so new and existing databases take this path.
    if (workColumns.length > 0 && !workColumns.includes('expected_output')) this.db.run('ALTER TABLE works ADD COLUMN expected_output TEXT');
    if (workColumns.length > 0 && !workColumns.includes('result_path')) this.db.run('ALTER TABLE works ADD COLUMN result_path TEXT');
    // Out-of-scope stages: a JSON array of funnel stages the human parked for
    // this work. Defaulted like funnel_stages, ignored by older builds (they
    // name their columns on insert), and added by migrate() so new and existing
    // databases take the same path — no schema version of its own.
    if (workColumns.length > 0 && !workColumns.includes('out_of_scope_stages')) this.db.run("ALTER TABLE works ADD COLUMN out_of_scope_stages TEXT NOT NULL DEFAULT '[]'");
    const revisionColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('revisions')").map((c) => c.name);
    if (revisionColumns.length > 0 && !revisionColumns.includes('document_id')) this.db.run('ALTER TABLE revisions ADD COLUMN document_id TEXT');
    if (revisionColumns.length > 0 && !revisionColumns.includes('source')) this.db.run("ALTER TABLE revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'human'");
    // Nullable and ignored by older builds (they name their columns on insert),
    // so, like proposed_stages, it needs no schema version of its own.
    const memberColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('team_members')").map((c) => c.name);
    if (memberColumns.length > 0 && !memberColumns.includes('continued_from')) this.db.run('ALTER TABLE team_members ADD COLUMN continued_from TEXT');
    // Effort tier and lifetime usage. Same reasoning as continued_from: an
    // existing row reads as the default tier and as "nothing measured yet",
    // which is exactly true — Latte never invents consumption it did not see.
    if (memberColumns.length > 0 && !memberColumns.includes('tier')) this.db.run("ALTER TABLE team_members ADD COLUMN tier TEXT NOT NULL DEFAULT 'balanced'");
    if (memberColumns.length > 0 && !memberColumns.includes('usage_json')) this.db.run('ALTER TABLE team_members ADD COLUMN usage_json TEXT');
    // The supersede trail on brand-context proposals: why a proposal stopped
    // being pending, and which one replaced it. Nullable and ignored by older
    // builds (they name their columns on insert), so, like tier, it needs no
    // schema version of its own.
    const brandContextColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('brand_context_proposals')").map((c) => c.name);
    if (brandContextColumns.length > 0 && !brandContextColumns.includes('decided_reason')) this.db.run('ALTER TABLE brand_context_proposals ADD COLUMN decided_reason TEXT');
    if (brandContextColumns.length > 0 && !brandContextColumns.includes('superseded_by')) this.db.run('ALTER TABLE brand_context_proposals ADD COLUMN superseded_by TEXT');
    // v1/v2 kept one runtime session per work in chat_sessions. v3 models a
    // team: every conversation is a member with a role. Old sessions become
    // "assistant" members so nothing already resumable is lost.
    const legacy = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('chat_sessions')");
    if (legacy.length > 0) {
      if (legacy.some((c) => c.name === 'runtime')) {
        const rows = this.db.all<{ work_id: string; runtime: string; session_id: string; updated_at: string }>('SELECT work_id, runtime, session_id, updated_at FROM chat_sessions');
        for (const row of rows) {
          const id = `mem_${legacyMemberSuffix(row.work_id, row.runtime)}`;
          this.db.run(
            'INSERT OR IGNORE INTO team_members(id, work_id, role_id, role_name, initial, runtime, model, account_id, session_id, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)',
            [id, row.work_id, 'assistant', 'Asistente', 'A', row.runtime, row.session_id, row.updated_at, row.updated_at],
          );
        }
      }
      this.db.exec('DROP TABLE chat_sessions');
    }
    // Every existing work gets its brief document row, with a deterministic id
    // so revisions with a NULL document_id resolve to it without a back-fill.
    for (const row of this.db.all<{ id: string; title: string; updated_at: string }>('SELECT id, title, updated_at FROM works')) {
      this.db.run(
        "INSERT OR IGNORE INTO documents(id, work_id, kind, title, file_name, status, base_doc_id, base_rev_id, base_print, last_print, created_at, updated_at) VALUES (?, ?, 'brief', ?, 'brief.md', 'draft', NULL, NULL, NULL, NULL, ?, ?)",
        [briefDocumentId(row.id), row.id, row.title, row.updated_at, row.updated_at],
      );
    }
    // Esquema 14: la convocatoria nombra a su persona del plantel. Nullable y
    // agregada acá, como continued_from, para que una base nueva y una vieja
    // tomen el mismo camino. Va DESPUÉS de la conversión de chat_sessions, que
    // todavía puede estar creando miembros.
    const convocationColumns = this.db.all<{ name: string }>("SELECT name FROM pragma_table_info('team_members')").map((c) => c.name);
    if (!convocationColumns.includes('brand_member_id')) this.db.run('ALTER TABLE team_members ADD COLUMN brand_member_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_team_members_brand_member ON team_members(brand_member_id)');
    this.backfillBrandMembers();
    this.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['schema_version', SCHEMA_VERSION]);
  }

  /**
   * La migración 13 → 14 (brief 3.2): CADA MIEMBRO DE HOY SE VUELVE PLANTEL
   * DE SU MARCA, CONVOCADO EN SU TRABAJO.
   *
   * En orden de llegada, cada fila sin persona busca en el plantel de su marca
   * a alguien con el mismo `(rol, runtime, cuenta)` que todavía NO esté
   * convocado en ese mismo trabajo; si no hay, lo crea copiando la identidad
   * de la fila. Así, la misma estratega en dos trabajos de una marca se funde
   * en una persona, y dos del mismo rol en el MISMO trabajo siguen siendo dos.
   *
   * Idempotente por construcción: sólo mira filas con `brand_member_id` NULL,
   * y el id de la persona creada se deriva del de la fila. Corre en cada
   * arranque, así que una fila escrita por fuera del hub se completa sola. Una
   * fila cuyo trabajo ya no existe queda como está: no se inventa una marca.
   *
   * La cara se conserva: la primera del rol en su trabajo mostraba la del rol
   * (queda NULL, y sigue al override `role-avatar:`); las siguientes mostraban
   * la derivada de su propio id, y ésa se copia tal cual.
   */
  private backfillBrandMembers(): void {
    const pending = this.db.all<MemberRow & { brand_id: string }>(
      'SELECT tm.*, w.brand_id AS brand_id FROM team_members tm JOIN works w ON w.id = tm.work_id WHERE tm.brand_member_id IS NULL ORDER BY tm.created_at ASC, tm.id ASC',
    );
    if (pending.length === 0) return;
    this.db.transaction(() => {
      for (const row of pending) {
        const match = this.db.get<{ id: string; last_called_at: string }>(
          `SELECT bm.id, bm.last_called_at FROM brand_members bm
           WHERE bm.brand_id = ? AND bm.role_id = ? AND bm.runtime = ? AND IFNULL(bm.account_id, '') = IFNULL(?, '')
             AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.work_id = ? AND t.brand_member_id = bm.id)
           ORDER BY bm.created_at ASC, bm.id ASC LIMIT 1`,
          [row.brand_id, row.role_id, row.runtime, row.account_id, row.work_id],
        );
        let brandMemberId: string;
        if (match) {
          brandMemberId = match.id;
          if (row.updated_at > match.last_called_at) {
            this.db.run('UPDATE brand_members SET last_called_at = ?, updated_at = ? WHERE id = ?', [row.updated_at, row.updated_at, match.id]);
          }
        } else {
          brandMemberId = migratedBrandMemberId(row.id);
          const first = this.db.get<{ id: string }>('SELECT id FROM team_members WHERE work_id = ? AND role_id = ? ORDER BY created_at ASC, id ASC LIMIT 1', [row.work_id, row.role_id]);
          const avatar = first && first.id !== row.id ? serializeAvatar(avatarFromSeed(row.id)) : null;
          this.db.run(
            'INSERT OR IGNORE INTO brand_members(id, brand_id, role_id, role_name, initial, avatar, runtime, model, account_id, tier, coordinator, last_called_at, retired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)',
            [brandMemberId, row.brand_id, row.role_id, row.role_name, row.initial, avatar, row.runtime, row.model, row.account_id, readTier(row.tier), row.updated_at, row.created_at, row.updated_at],
          );
        }
        this.db.run('UPDATE team_members SET brand_member_id = ? WHERE id = ?', [brandMemberId, row.id]);
      }
    });
  }

  // Meta (small app-level settings) --------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value]);
  }

  /** Borra la clave entera. "No configurado" y "configurado en algo que no sirve" son estados distintos: un ajuste opcional tiene que poder volver a NO estar. */
  deleteMeta(key: string): void {
    this.db.run('DELETE FROM meta WHERE key = ?', [key]);
  }

  get engine(): SqlDriver['kind'] {
    return this.db.kind;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }

  // Brands ------------------------------------------------------------------

  listBrands(): Brand[] {
    return this.db.all<BrandRow>(`${BRAND_SELECT} WHERE a.brand_id IS NULL ORDER BY b.created_at ASC, b.name ASC`).map(toBrand);
  }

  listArchivedBrands(): Brand[] {
    return this.db.all<BrandRow>(`${BRAND_SELECT} WHERE a.brand_id IS NOT NULL ORDER BY a.archived_at DESC, b.name ASC`).map(toBrand);
  }

  getBrand(id: string): Brand {
    const row = this.db.get<BrandRow>(`${BRAND_SELECT} WHERE b.id = ?`, [id]);
    if (!row) throw new NotFoundError('Brand', id);
    return toBrand(row);
  }

  archiveBrand(id: string, archivedAt: string): Brand {
    this.getBrand(id);
    this.db.run('INSERT OR IGNORE INTO brand_archives(brand_id, archived_at) VALUES (?, ?)', [id, archivedAt]);
    return this.getBrand(id);
  }

  restoreBrand(id: string): Brand {
    this.getBrand(id);
    this.db.run('DELETE FROM brand_archives WHERE brand_id = ?', [id]);
    return this.getBrand(id);
  }

  countBrands(): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM brands');
    return Number(row?.n ?? 0);
  }

  insertBrand(brand: Omit<Brand, 'archivedAt'>): Brand {
    this.db.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      brand.id, brand.name, brand.context, brand.createdAt,
    ]);
    return this.getBrand(brand.id);
  }

  updateBrandContext(id: string, context: string): Brand {
    this.getBrand(id);
    this.db.run('UPDATE brands SET context = ? WHERE id = ?', [context, id]);
    return this.getBrand(id);
  }

  // Works -------------------------------------------------------------------

  listWorks(brandId: string): Work[] {
    return this.db
      .all<WorkRow>('SELECT * FROM works WHERE brand_id = ? ORDER BY updated_at DESC, title ASC', [brandId])
      .map(toWork);
  }

  getWork(id: string): Work {
    const row = this.db.get<WorkRow>('SELECT * FROM works WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Work', id);
    return toWork(row);
  }

  insertWork(work: Work): Work {
    this.db.run('INSERT INTO works(id, brand_id, title, brief, dir, expected_output, result_path, out_of_scope_stages, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      work.id, work.brandId, work.title, work.brief, work.folder ?? null, work.expectedOutput ?? null, work.resultPath ?? null, JSON.stringify(work.outOfScopeStages ?? []), work.updatedAt,
    ]);
    return work;
  }

  /** What the work should deliver and the Deliverables file linked as its result. Validation lives in the service. */
  setWorkOutcome(id: string, expectedOutput: string | null, resultPath: string | null, updatedAt: string): Work {
    this.getWork(id);
    this.db.run('UPDATE works SET expected_output = ?, result_path = ?, updated_at = ? WHERE id = ?', [expectedOutput, resultPath, updatedAt, id]);
    return this.getWork(id);
  }

  /** Which funnel stages the human marked out of scope for this work. Validation lives in the service. */
  setWorkOutOfScopeStages(id: string, stages: FunnelStage[], updatedAt: string): Work {
    this.getWork(id);
    this.db.run('UPDATE works SET out_of_scope_stages = ?, updated_at = ? WHERE id = ?', [JSON.stringify([...new Set(stages)]), updatedAt, id]);
    return this.getWork(id);
  }

  /** Points a work at a folder the user chose, or back at Latte's own. */
  setWorkFolder(id: string, folder: string | null, updatedAt: string): Work {
    this.getWork(id);
    this.db.run('UPDATE works SET dir = ?, updated_at = ? WHERE id = ?', [folder, updatedAt, id]);
    return this.getWork(id);
  }

  /** Every work that lives in a user folder, for restoring the mapping at start. */
  linkedWorks(): Array<{ id: string; dir: string }> {
    return this.db.all<{ id: string; dir: string }>('SELECT id, dir FROM works WHERE dir IS NOT NULL AND dir <> ?', ['']);
  }

  updateBrief(id: string, brief: string, updatedAt: string): Work {
    this.getWork(id);
    this.db.run('UPDATE works SET brief = ?, updated_at = ? WHERE id = ?', [brief, updatedAt, id]);
    return this.getWork(id);
  }

  touchWork(id: string, updatedAt: string): void {
    this.db.run('UPDATE works SET updated_at = ? WHERE id = ?', [updatedAt, id]);
  }

  // Documents ---------------------------------------------------------------

  listDocuments(workId: string): DocumentRecord[] {
    return this.db.all<DocumentRow>('SELECT * FROM documents WHERE work_id = ? ORDER BY created_at ASC, id ASC', [workId]).map(toDocument);
  }

  /** Every tracked document of every work that belongs to this brand. */
  listDocumentsForBrand(brandId: string): DocumentRecord[] {
    return this.db
      .all<DocumentRow>(
        'SELECT d.* FROM documents d INNER JOIN works w ON w.id = d.work_id WHERE w.brand_id = ? ORDER BY d.created_at ASC, d.id ASC',
        [brandId],
      )
      .map(toDocument);
  }

  getDocument(id: string): DocumentRecord {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Document', id);
    return toDocument(row);
  }

  findDocument(id: string): DocumentRecord | null {
    const row = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
    return row ? toDocument(row) : null;
  }

  /** The default document of a work (kind 'brief'), created by migrate()/createWork. */
  briefDocument(workId: string): DocumentRecord {
    return this.getDocument(briefDocumentId(workId));
  }

  insertDocument(doc: Omit<DocumentRecord, 'funnelStages' | 'proposedFunnelStages'> & { funnelStages?: FunnelStage[] }): DocumentRecord {
    this.db.run(
      'INSERT INTO documents(id, work_id, kind, title, file_name, status, base_doc_id, base_rev_id, base_print, last_print, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [doc.id, doc.workId, doc.kind, doc.title, doc.fileName, doc.status, doc.baseDocumentId, doc.baseRevisionId, doc.baseFingerprint, doc.lastFingerprint, doc.createdAt, doc.updatedAt],
    );
    return this.updateDocument(doc.id, { funnelStages: doc.funnelStages ?? [], updatedAt: doc.updatedAt });
  }

  updateDocument(id: string, patch: { title?: string; status?: string; funnelStages?: FunnelStage[]; proposedFunnelStages?: FunnelStage[]; baseDocumentId?: string | null; baseRevisionId?: string | null; baseFingerprint?: string | null; lastFingerprint?: string | null; updatedAt: string }): DocumentRecord {
    const current = this.getDocument(id);
    this.db.run(
      'UPDATE documents SET title = ?, status = ?, funnel_stages = ?, proposed_stages = ?, base_doc_id = ?, base_rev_id = ?, base_print = ?, last_print = ?, updated_at = ? WHERE id = ?',
      [
        patch.title ?? current.title,
        patch.status ?? current.status,
        JSON.stringify([...new Set(patch.funnelStages ?? current.funnelStages)]),
        JSON.stringify([...new Set(patch.proposedFunnelStages ?? current.proposedFunnelStages)]),
        patch.baseDocumentId === undefined ? current.baseDocumentId : patch.baseDocumentId,
        patch.baseRevisionId === undefined ? current.baseRevisionId : patch.baseRevisionId,
        patch.baseFingerprint === undefined ? current.baseFingerprint : patch.baseFingerprint,
        patch.lastFingerprint === undefined ? current.lastFingerprint : patch.lastFingerprint,
        patch.updatedAt,
        id,
      ],
    );
    return this.getDocument(id);
  }

  usedFileNames(workId: string): string[] {
    return this.db.all<{ file_name: string }>('SELECT file_name FROM documents WHERE work_id = ?', [workId]).map((r) => r.file_name);
  }

  /** Documents that declared this one as their base version. */
  documentsBasedOn(documentId: string): DocumentRecord[] {
    return this.db.all<DocumentRow>('SELECT * FROM documents WHERE base_doc_id = ? ORDER BY created_at ASC', [documentId]).map(toDocument);
  }

  // Revisions (immutable) ---------------------------------------------------

  /** Newest first: the UI shows the latest version at the top. */
  listRevisions(workId: string): Revision[] {
    return this.db
      .all<RevisionRow>('SELECT * FROM revisions WHERE work_id = ? ORDER BY created_at DESC, id DESC', [workId])
      .map(toRevision);
  }

  /**
   * Versions of one document. Rows written before v4 have document_id NULL and
   * belong to the work's brief document.
   */
  listDocumentRevisions(workId: string, documentId: string): Revision[] {
    const legacy = documentId === briefDocumentId(workId);
    const sql = legacy
      ? 'SELECT * FROM revisions WHERE work_id = ? AND (document_id = ? OR document_id IS NULL) ORDER BY created_at DESC, id DESC'
      : 'SELECT * FROM revisions WHERE work_id = ? AND document_id = ? ORDER BY created_at DESC, id DESC';
    return this.db.all<RevisionRow>(sql, [workId, documentId]).map(toRevision);
  }

  getRevision(id: string): Revision | undefined {
    const row = this.db.get<RevisionRow>('SELECT * FROM revisions WHERE id = ?', [id]);
    return row ? toRevision(row) : undefined;
  }

  latestRevision(workId: string): Revision | undefined {
    const row = this.db.get<RevisionRow>(
      'SELECT * FROM revisions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [workId],
    );
    return row ? toRevision(row) : undefined;
  }

  insertRevision(revision: Revision): Revision {
    this.db.run('INSERT INTO revisions(id, work_id, document_id, source, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      revision.id, revision.workId, revision.documentId, revision.source, revision.content, revision.createdAt,
    ]);
    return revision;
  }

  // Team members (one conversation per role per work, resumable) -------------

  listMembers(workId: string): TeamMemberRecord[] {
    return this.db.all<MemberRow>('SELECT * FROM team_members WHERE work_id = ? ORDER BY created_at ASC, id ASC', [workId]).map(toMember);
  }

  getMember(id: string): TeamMemberRecord {
    const row = this.db.get<MemberRow>('SELECT * FROM team_members WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Team member', id);
    return toMember(row);
  }

  findMember(id: string): TeamMemberRecord | null {
    const row = this.db.get<MemberRow>('SELECT * FROM team_members WHERE id = ?', [id]);
    return row ? toMember(row) : null;
  }

  insertMember(member: TeamMemberRecord): TeamMemberRecord {
    const tier = member.tier ?? DEFAULT_EFFORT_TIER;
    const usage = member.usage ?? EMPTY_USAGE;
    this.db.run(
      'INSERT INTO team_members(id, work_id, role_id, role_name, initial, runtime, model, account_id, session_id, done, continued_from, tier, usage_json, brand_member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [member.id, member.workId, member.roleId, member.roleName, member.initial, member.runtime, member.model, member.accountId, member.sessionId, member.done ? 1 : 0, member.continuedFrom ?? null, tier, serializeUsage(usage), member.brandMemberId ?? null, member.createdAt, member.updatedAt],
    );
    return { ...member, continuedFrom: member.continuedFrom ?? null, tier, usage, brandMemberId: member.brandMemberId ?? null };
  }

  /** Runtime-native session/thread id learned at start or, for Claude, with the first reply. */
  setMemberSession(id: string, sessionId: string, updatedAt: string): void {
    this.db.run('UPDATE team_members SET session_id = ?, updated_at = ? WHERE id = ?', [sessionId, updatedAt, id]);
  }

  /** The model a member's conversation runs on. Empty string means the runtime's default. */
  setMemberModel(id: string, model: string | null, updatedAt: string): void {
    this.db.run('UPDATE team_members SET model = ?, updated_at = ? WHERE id = ?', [model, updatedAt, id]);
  }

  /** How hard a member works per answer. The runtime is restarted by the hub, not here. */
  setMemberTier(id: string, tier: EffortTier, updatedAt: string): void {
    this.db.run('UPDATE team_members SET tier = ?, updated_at = ? WHERE id = ?', [tier, updatedAt, id]);
  }

  /**
   * Adds one measured turn to what this member has consumed in its whole life,
   * and answers with the new total.
   *
   * Read-modify-write in one place, so the caller cannot forget to add before
   * it writes. It is safe here because the main process is the only writer and
   * SQL calls in it are synchronous: no two turns interleave between the read
   * and the write.
   */
  addMemberUsage(id: string, turn: ChatUsage, updatedAt: string): ChatUsage {
    const row = this.db.get<MemberRow>('SELECT * FROM team_members WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Team member', id);
    const total = addUsage(parseUsage(row.usage_json), turn);
    this.db.run('UPDATE team_members SET usage_json = ?, updated_at = ? WHERE id = ?', [serializeUsage(total), updatedAt, id]);
    return total;
  }

  setMemberDone(id: string, done: boolean, updatedAt: string): void {
    this.db.run('UPDATE team_members SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, updatedAt, id]);
  }

  deleteMember(id: string): void {
    this.db.run('DELETE FROM team_members WHERE id = ?', [id]);
  }

  // El plantel de la marca (esquema 14) -----------------------------------------

  /** La marca de un trabajo, sin sincronizar nada del disco. `null` si el trabajo no existe. */
  brandIdOfWork(workId: string): string | null {
    return this.db.get<{ brand_id: string }>('SELECT brand_id FROM works WHERE id = ?', [workId])?.brand_id ?? null;
  }

  /** Todo el plantel de una marca, retirados incluidos, en orden de llegada. */
  listBrandMembers(brandId: string): BrandMemberRecord[] {
    return this.db.all<BrandMemberRow>('SELECT * FROM brand_members WHERE brand_id = ? ORDER BY created_at ASC, id ASC', [brandId]).map(toBrandMember);
  }

  findBrandMember(id: string): BrandMemberRecord | null {
    const row = this.db.get<BrandMemberRow>('SELECT * FROM brand_members WHERE id = ?', [id]);
    return row ? toBrandMember(row) : null;
  }

  getBrandMember(id: string): BrandMemberRecord {
    const found = this.findBrandMember(id);
    if (!found) throw new NotFoundError('Brand member', id);
    return found;
  }

  insertBrandMember(member: BrandMemberRecord): BrandMemberRecord {
    this.db.run(
      'INSERT INTO brand_members(id, brand_id, role_id, role_name, initial, avatar, runtime, model, account_id, tier, coordinator, last_called_at, retired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [member.id, member.brandId, member.roleId, member.roleName, member.initial, member.avatar, member.runtime, member.model, member.accountId, member.tier, member.coordinator ? 1 : 0, member.lastCalledAt, member.retiredAt, member.createdAt, member.updatedAt],
    );
    return member;
  }

  deleteBrandMember(id: string): void {
    this.db.run('DELETE FROM brand_members WHERE id = ?', [id]);
  }

  /** Lo convocaron (o abrieron uno de sus hilos): vuelve si estaba retirado. */
  markBrandMemberCalled(id: string, at: string): void {
    this.db.run('UPDATE brand_members SET last_called_at = ?, retired_at = NULL, updated_at = ? WHERE id = ?', [at, at, id]);
  }

  /**
   * El coordinador habitual de la marca: EXCLUSIVO. Una sola sentencia marca a
   * esa persona y desmarca a todas las demás de la marca, así que nunca hay dos
   * ni un instante con dos. `null` desmarca a quien estuviera.
   */
  setBrandCoordinator(brandId: string, brandMemberId: string | null, at: string): void {
    this.db.run(
      'UPDATE brand_members SET coordinator = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE brand_id = ? AND (coordinator = 1 OR id = ?)',
      [brandMemberId ?? '', at, brandId, brandMemberId ?? ''],
    );
  }

  /** Quién coordina por costumbre los trabajos de esta marca, si alguien. */
  brandCoordinator(brandId: string): BrandMemberRecord | null {
    const row = this.db.get<BrandMemberRow>('SELECT * FROM brand_members WHERE brand_id = ? AND coordinator = 1 ORDER BY created_at ASC, id ASC LIMIT 1', [brandId]);
    return row ? toBrandMember(row) : null;
  }

  retireBrandMember(id: string, at: string): void {
    this.db.run('UPDATE brand_members SET retired_at = ?, updated_at = ? WHERE id = ? AND retired_at IS NULL', [at, at, id]);
  }

  /**
   * Retira a los que nadie llamó desde `cutoff`: ni una convocatoria ni un
   * movimiento en ninguno de sus hilos (`team_members.updated_at` cambia con
   * cada sesión y cada turno medido). `brandId` null = todas las marcas.
   * Devuelve cuántos retiró.
   */
  retireIdleBrandMembers(brandId: string | null, cutoff: string, at: string): number {
    const idle = this.db.all<{ id: string }>(
      `SELECT bm.id FROM brand_members bm
       WHERE (? IS NULL OR bm.brand_id = ?) AND bm.retired_at IS NULL AND bm.last_called_at < ?
         AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.brand_member_id = bm.id AND t.updated_at >= ?)`,
      [brandId, brandId, cutoff, cutoff],
    );
    for (const { id } of idle) this.retireBrandMember(id, at);
    return idle.length;
  }

  /** En qué trabajos está convocada cada persona del plantel de esta marca. */
  brandMemberConvocations(brandId: string): Map<string, string[]> {
    const rows = this.db.all<{ brand_member_id: string; work_id: string }>(
      'SELECT t.brand_member_id, t.work_id FROM team_members t JOIN brand_members bm ON bm.id = t.brand_member_id WHERE bm.brand_id = ? ORDER BY t.created_at ASC, t.id ASC',
      [brandId],
    );
    const out = new Map<string, string[]>();
    for (const row of rows) {
      const list = out.get(row.brand_member_id) ?? [];
      if (!list.includes(row.work_id)) list.push(row.work_id);
      out.set(row.brand_member_id, list);
    }
    return out;
  }

  /** La convocatoria de esta persona en este trabajo, si ya la tiene. */
  findConvocation(workId: string, brandMemberId: string): TeamMemberRecord | null {
    const row = this.db.get<MemberRow>('SELECT * FROM team_members WHERE work_id = ? AND brand_member_id = ? ORDER BY created_at ASC, id ASC LIMIT 1', [workId, brandMemberId]);
    return row ? toMember(row) : null;
  }

  /**
   * A quién del plantel convocar para este rol en este trabajo: alguien de la
   * marca con ese rol que todavía no esté convocado acá. Con `exact` se pide
   * esa identidad (runtime y cuenta); sin él, cualquiera del rol. Los activos
   * van antes que los retirados, y entre iguales el más antiguo.
   */
  findBrandMemberToCall(brandId: string, roleId: string, workId: string, exact: { runtime: ChatRuntime; accountId: string | null } | null): BrandMemberRecord | null {
    const filter = exact ? " AND bm.runtime = ? AND IFNULL(bm.account_id, '') = IFNULL(?, '')" : '';
    const params: Array<string | null> = [brandId, roleId, workId];
    if (exact) params.push(exact.runtime, exact.accountId);
    const row = this.db.get<BrandMemberRow>(
      `SELECT bm.* FROM brand_members bm
       WHERE bm.brand_id = ? AND bm.role_id = ?
         AND NOT EXISTS (SELECT 1 FROM team_members t WHERE t.work_id = ? AND t.brand_member_id = bm.id)${filter}
       ORDER BY (bm.retired_at IS NOT NULL) ASC, bm.created_at ASC, bm.id ASC LIMIT 1`,
      params,
    );
    return row ? toBrandMember(row) : null;
  }

  // Decisions ---------------------------------------------------------------

  listDecisions(workId: string): Decision[] {
    const legacy = this.db
      .all<DecisionRow>('SELECT * FROM decisions WHERE work_id = ? ORDER BY created_at ASC, id ASC', [workId])
      .map(toDecision);
    const proposals=this.db.all<DecisionProposalRow>('SELECT * FROM decision_proposals WHERE work_id = ? ORDER BY created_at ASC, id ASC',[workId]).map(toProposal);
    return [...legacy,...proposals].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }

  /** Approved, pending and legacy decisions of every work of this brand. */
  listDecisionsForBrand(brandId: string): Decision[] {
    const legacy = this.db
      .all<DecisionRow>(
        'SELECT d.* FROM decisions d INNER JOIN works w ON w.id = d.work_id WHERE w.brand_id = ? ORDER BY d.created_at ASC, d.id ASC',
        [brandId],
      )
      .map(toDecision);
    const proposals = this.db
      .all<DecisionProposalRow>(
        'SELECT p.* FROM decision_proposals p INNER JOIN works w ON w.id = p.work_id WHERE w.brand_id = ? ORDER BY p.created_at ASC, p.id ASC',
        [brandId],
      )
      .map(toProposal);
    return [...legacy, ...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  insertDecision(decision: Pick<Decision,'id'|'workId'|'text'|'createdAt'>): Decision {
    this.db.run('INSERT INTO decisions(id, work_id, text, created_at) VALUES (?, ?, ?, ?)', [
      decision.id, decision.workId, decision.text, decision.createdAt,
    ]);
    return { ...decision,rationale:'',alternativesRejected:[],evidenceRefs:[],status:'approved',source:emptySource(),clientRequestId:null,fingerprint:'',decidedAt:decision.createdAt };
  }

  findDecisionRequest(workId:string,chatId:string,clientRequestId:string):Decision|null {
    const row=this.db.get<DecisionProposalRow>('SELECT * FROM decision_proposals WHERE work_id=? AND source_chat_id=? AND client_request_id=?',[workId,chatId,clientRequestId]);
    return row?toProposal(row):null;
  }

  insertDecisionProposal(decision:Decision):Decision {
    this.db.transaction(()=>{
      this.db.run('INSERT INTO decision_proposals(id,work_id,statement,rationale,alternatives,evidence,status,source_chat_id,source_message_id,source_member_id,source_role_id,source_runtime,client_request_id,fingerprint,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[decision.id,decision.workId,decision.text,decision.rationale,JSON.stringify(decision.alternativesRejected),JSON.stringify(decision.evidenceRefs),decision.status,decision.source.chatId,decision.source.messageId,decision.source.memberId,decision.source.roleId,decision.source.runtime,decision.clientRequestId,decision.fingerprint,decision.createdAt,decision.decidedAt]);
      this.db.run('INSERT INTO decision_events(id,decision_id,action,actor,detail,created_at) VALUES (?,?,?,?,?,?)',[`evt_${decision.id.slice(4)}`,decision.id,'proposed','agent','',decision.createdAt]);
      if(decision.status==='approved') this.db.run('INSERT INTO decision_events(id,decision_id,action,actor,detail,created_at) VALUES (?,?,?,?,?,?)',[`evt_auto_${decision.id.slice(4)}`,decision.id,'approved','authority:auto-record','',decision.createdAt]);
    });
    return decision;
  }

  getDecision(id:string):Decision {
    const row=this.db.get<DecisionProposalRow>('SELECT * FROM decision_proposals WHERE id=?',[id]);
    if(!row) throw new NotFoundError('Decision',id); return toProposal(row);
  }

  transitionDecision(id:string,status:DecisionStatus,statement:string|null,at:string,actor='human'):Decision {
    return this.db.transaction(()=>{ const before=this.getDecision(id); if(before.status===status)return before; const allowed=(before.status==='pending'&&(status==='approved'||status==='rejected'))||(before.status==='approved'&&status==='archived'); if(!allowed)throw new ValidationError(`Decision cannot transition from ${before.status} to ${status}`); const text=statement??before.text; this.db.run('UPDATE decision_proposals SET status=?, statement=?, decided_at=? WHERE id=?',[status,text,at,id]); this.db.run('INSERT INTO decision_events(id,decision_id,action,actor,detail,created_at) VALUES (?,?,?,?,?,?)',[`evt_${createHash('sha1').update(`${id}\0${status}\0${at}`).digest('hex').slice(0,20)}`,id,status,actor,statement&&statement!==before.text?'statement edited':'',at]); return this.getDecision(id); });
  }

  // Brand context proposals -------------------------------------------------

  listBrandContextProposals(brandId: string): BrandContextProposal[] {
    return this.db
      .all<BrandContextProposalRow>('SELECT * FROM brand_context_proposals WHERE brand_id = ? ORDER BY created_at ASC, id ASC', [brandId])
      .map(toBrandContextProposal);
  }

  getBrandContextProposal(id: string): BrandContextProposal {
    const row = this.db.get<BrandContextProposalRow>('SELECT * FROM brand_context_proposals WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('BrandContextProposal', id);
    return toBrandContextProposal(row);
  }

  findBrandContextRequest(brandId: string, workId: string, chatId: string, clientRequestId: string): BrandContextProposal | null {
    const row = this.db.get<BrandContextProposalRow>(
      'SELECT * FROM brand_context_proposals WHERE brand_id = ? AND work_id = ? AND source_chat_id = ? AND client_request_id = ?',
      [brandId, workId, chatId, clientRequestId],
    );
    return row ? toBrandContextProposal(row) : null;
  }

  findPendingBrandContext(brandId: string): BrandContextProposal | null {
    const row = this.db.get<BrandContextProposalRow>(
      "SELECT * FROM brand_context_proposals WHERE brand_id = ? AND status = 'pending'",
      [brandId],
    );
    return row ? toBrandContextProposal(row) : null;
  }

  insertBrandContextProposal(proposal: BrandContextProposal): BrandContextProposal {
    this.db.run(
      'INSERT INTO brand_context_proposals(id, brand_id, work_id, source_chat_id, source_message_id, source_member_id, source_role_id, source_runtime, text, rationale, mode, status, fingerprint, base_fingerprint, client_request_id, created_at, decided_at, decided_reason, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        proposal.id, proposal.brandId, proposal.workId,
        proposal.source.chatId, proposal.source.messageId, proposal.source.memberId, proposal.source.roleId, proposal.source.runtime,
        proposal.text, proposal.rationale, proposal.mode, proposal.status, proposal.fingerprint, proposal.baseFingerprint,
        proposal.clientRequestId, proposal.createdAt, proposal.decidedAt,
        proposal.decidedReason ?? null, proposal.supersededBy ?? null,
      ],
    );
    return proposal;
  }

  /**
   * Marks the pending proposal of a brand as superseded by a newer one. The
   * row is kept (never deleted) with a reason and a pointer, so the Contexto
   * view can show that an earlier proposal existed and was replaced instead of
   * it vanishing silently. The partial unique index keeps one pending per brand.
   */
  rejectPendingBrandContext(brandId: string, at: string, reason: 'superseded' | 'rejected' = 'superseded', supersededBy: string | null = null): BrandContextProposal | null {
    const pending = this.findPendingBrandContext(brandId);
    if (!pending) return null;
    this.db.run(
      "UPDATE brand_context_proposals SET status = 'rejected', decided_at = ?, decided_reason = ?, superseded_by = ? WHERE id = ?",
      [at, reason, supersededBy, pending.id],
    );
    return this.getBrandContextProposal(pending.id);
  }

  transitionBrandContextProposal(id: string, status: BrandContextProposalStatus, text: string | null, at: string): BrandContextProposal {
    const before = this.getBrandContextProposal(id);
    if (before.status === status) return before;
    if (before.status !== 'pending' || (status !== 'approved' && status !== 'rejected')) {
      throw new ValidationError(`Brand context proposal cannot transition from ${before.status} to ${status}`);
    }
    const nextText = text ?? before.text;
    this.db.run('UPDATE brand_context_proposals SET status = ?, text = ?, decided_at = ?, decided_reason = ? WHERE id = ?', [status, nextText, at, status, id]);
    return this.getBrandContextProposal(id);
  }

  // Brand context history (immutable) ----------------------------------------

  /** The history of `brands.context`, newest first. */
  listBrandContextRevisions(brandId: string): BrandContextRevision[] {
    // `rowid` breaks the tie when two revisions share a timestamp: the
    // back-filled original is inserted before the change that followed it.
    return this.db
      .all<BrandContextRevisionRow>('SELECT * FROM brand_context_revisions WHERE brand_id = ? ORDER BY created_at DESC, rowid DESC', [brandId])
      .map(toBrandContextRevision);
  }

  getBrandContextRevision(id: string): BrandContextRevision {
    const row = this.db.get<BrandContextRevisionRow>('SELECT * FROM brand_context_revisions WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('BrandContextRevision', id);
    return toBrandContextRevision(row);
  }

  insertBrandContextRevision(revision: BrandContextRevision): BrandContextRevision {
    this.db.run(
      'INSERT INTO brand_context_revisions(id, brand_id, source, origin, content, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [revision.id, revision.brandId, revision.source, revision.origin, revision.content, revision.fingerprint, revision.createdAt],
    );
    return revision;
  }

  /**
   * Records a change of `brands.context`, and never loses the value it replaced.
   *
   * `brand` must be the row as it was BEFORE the change: when the context was
   * already written and no revision exists yet (a database from before this
   * table), the previous value is back-filled first, so the first change of an
   * existing context cannot erase it. A no-op change records nothing.
   *
   * The caller owns the transaction: this only runs statements, so it must be
   * called inside one that also writes `brands.context`.
   */
  recordBrandContextRevision(
    brand: Brand,
    next: string,
    source: BrandContextRevisionSource,
    origin: string | null,
    at: string,
  ): BrandContextRevision[] {
    if (next === brand.context) return [];
    const recorded: BrandContextRevision[] = [];
    const existing = this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM brand_context_revisions WHERE brand_id = ?', [brand.id]);
    if (brand.context.trim().length > 0 && (existing?.count ?? 0) === 0) {
      recorded.push(this.insertBrandContextRevision({
        id: newId('bcr'), brandId: brand.id, source: 'human', origin: null,
        content: brand.context, fingerprint: brandContextFingerprint(brand.context), createdAt: at,
      }));
    }
    recorded.push(this.insertBrandContextRevision({
      id: newId('bcr'), brandId: brand.id, source, origin,
      content: next, fingerprint: brandContextFingerprint(next), createdAt: at,
    }));
    return recorded;
  }

  // Generations (immutable receipts) -----------------------------------------

  insertGeneration(receipt: GenerationReceipt): GenerationReceipt {
    const existing = this.getGeneration(receipt.id);
    if (existing) {
      if (existing.contextHash !== receipt.contextHash || existing.contextJson !== receipt.contextJson) {
        throw new GenerationContractError('VERSION_CONFLICT', 'Same generation id with different content');
      }
      return existing;
    }
    const sealed = hashGenerationContext(receipt.context);
    if (sealed.hash !== receipt.contextHash || sealed.json !== receipt.contextJson) {
      throw new GenerationContractError('HASH_INVALID', 'Receipt hash does not match canonical context');
    }
    this.db.run(
      'INSERT INTO generations(id, work_id, brand_id, context_json, context_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [receipt.id, receipt.workId, receipt.brandId, receipt.contextJson, receipt.contextHash, receipt.createdAt],
    );
    return receipt;
  }

  getGeneration(id: string): GenerationReceipt | null {
    const row = this.db.get<GenerationRow>('SELECT * FROM generations WHERE id = ?', [id]);
    return row ? toGeneration(row) : null;
  }

  listGenerationsForWork(workId: string): GenerationReceipt[] {
    return this.db
      .all<GenerationRow>('SELECT * FROM generations WHERE work_id = ? ORDER BY created_at DESC, rowid DESC', [workId])
      .map(toGeneration);
  }

  insertDeliveryEvidence(row: DeliveryEvidence): DeliveryEvidence {
    this.db.run(
      'INSERT INTO delivery_evidence(id, generation_id, runtime, chat_id, projected_at, files_written) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, row.generationId, row.runtime, row.chatId, row.projectedAt, JSON.stringify(row.filesWritten)],
    );
    return row;
  }

  listDeliveryEvidence(generationId: string): DeliveryEvidence[] {
    return this.db
      .all<EvidenceRow>('SELECT * FROM delivery_evidence WHERE generation_id = ? ORDER BY projected_at ASC, id ASC', [generationId])
      .map(toEvidence);
  }

  insertArtifactCheck(row: ArtifactCheck): ArtifactCheck {
    const compliant = row.brandCompliant === null ? null : row.brandCompliant ? 1 : 0;
    this.db.run(
      'INSERT INTO artifact_checks(id, generation_id, relative_path, file_hash, checks_json, brand_compliant, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.generationId, row.relativePath, row.fileHash, JSON.stringify(row.checks), compliant, row.createdAt],
    );
    return row;
  }

  listArtifactChecks(generationId: string): ArtifactCheck[] {
    return this.db
      .all<CheckRow>('SELECT * FROM artifact_checks WHERE generation_id = ? ORDER BY created_at ASC, id ASC', [generationId])
      .map(toCheck);
  }

  // Coordination (autonomous runs, schema 12) ---------------------------------
  // Phase 1: storage only. Nothing here is called from any IPC method yet.

  insertCoordinationRun(run: CoordinationRunRecord): CoordinationRunRecord {
    this.db.run(
      'INSERT INTO coordination_run(id, work_id, status, coordinator_member_id, budget_json, plan_json, plan_approved_at, suspend_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [run.id, run.workId, run.status, run.coordinatorMemberId, run.budgetJson, run.planJson, run.planApprovedAt, run.suspendReason, run.createdAt, run.updatedAt],
    );
    return this.getCoordinationRun(run.id);
  }

  getCoordinationRun(id: string): CoordinationRunRecord {
    const row = this.db.get<CoordinationRunRow>('SELECT * FROM coordination_run WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('CoordinationRun', id);
    return toCoordinationRun(row);
  }

  /** The Work's live run, if any: `planning`/`running`/`suspended` — the same set the partial unique index enforces one of. */
  findActiveCoordinationRun(workId: string): CoordinationRunRecord | null {
    const row = this.db.get<CoordinationRunRow>(
      "SELECT * FROM coordination_run WHERE work_id = ? AND status IN ('planning','running','suspended')",
      [workId],
    );
    return row ? toCoordinationRun(row) : null;
  }

  /**
   * El ÚLTIMO run terminado de este Trabajo (`done`/`cancelled`), o `null` si
   * nunca terminó ninguno. Terminar no es desaparecer: sin esto, en cuanto un
   * run pasaba a `done` la interfaz se quedaba sin run, y con él se iba la
   * bitácora entera — la entrada de cierre `run_done` incluida, que es
   * justamente la que cuenta cómo terminó.
   */
  findLatestFinishedCoordinationRun(workId: string): CoordinationRunRecord | null {
    const row = this.db.get<CoordinationRunRow>(
      "SELECT * FROM coordination_run WHERE work_id = ? AND status IN ('done','cancelled') ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1",
      [workId],
    );
    return row ? toCoordinationRun(row) : null;
  }

  /**
   * El ÚLTIMO run terminado de cada Trabajo, app-wide, del más nuevo al más
   * viejo. Uno por Trabajo y nada más: la tira de Inicio tiene que poder decir
   * "tu equipo terminó" desde que terminó hasta que la persona lo mira, y para
   * eso alcanza el último — el historial completo no es una novedad, es un
   * archivo.
   */
  listLatestFinishedCoordinationRuns(limit = 25): CoordinationRunRecord[] {
    return this.db
      .all<CoordinationRunRow>(
        `SELECT r.* FROM coordination_run r
         WHERE r.status IN ('done','cancelled')
           AND r.updated_at = (SELECT MAX(o.updated_at) FROM coordination_run o WHERE o.work_id = r.work_id AND o.status IN ('done','cancelled'))
         ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
        [limit],
      )
      .map(toCoordinationRun);
  }

  /**
   * Every active run app-wide, across every Work and every Brand —
   * `planning`/`running`/`suspended`, the same set `idx_coordination_run_active`
   * enforces one-per-Work of. Feeds a proposal gate's `aggregate` (task 6.13:
   * "the aggregate is shown, not hidden") and, later, the global "Equipos
   * activos" strip (task 6.34, out of this slice).
   */
  listActiveCoordinationRuns(): CoordinationRunRecord[] {
    return this.db
      .all<CoordinationRunRow>("SELECT * FROM coordination_run WHERE status IN ('planning','running','suspended') ORDER BY created_at ASC, id ASC", [])
      .map(toCoordinationRun);
  }

  /**
   * The same app-wide active set `listActiveCoordinationRuns` returns, but a
   * bare count — no row materialization. Feeds the `MAX_ACTIVE_COORDINATION_RUNS`
   * ceiling (task 6.15) and the coordination MCP server's stop-when-idle rule
   * (task 6.19), both of which only need "how many", not "which ones".
   */
  countActiveCoordinationRuns(): number {
    const row = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM coordination_run WHERE status IN ('planning','running','suspended')");
    return row?.count ?? 0;
  }

  /**
   * M9 (ronda 8): EL MOTIVO ES UNA UNIÓN CERRADA EN LA ESCRITURA. La LECTURA
   * sigue siendo `string | null` —una base vieja puede tener un motivo que
   * esta versión ya no emite—, pero nadie puede ESCRIBIR uno que `listGates` y
   * el tick no sepan interpretar: un motivo desconocido le hacía inventar a
   * Decisiones una decisión de presupuesto que no existía.
   */
  updateCoordinationRunStatus(id: string, status: CoordinationRunStatus, updatedAt: string, suspendReason: CoordinationSuspendReason | null = null): CoordinationRunRecord {
    this.getCoordinationRun(id);
    this.db.run('UPDATE coordination_run SET status = ?, suspend_reason = ?, updated_at = ? WHERE id = ?', [status, suspendReason, updatedAt, id]);
    return this.getCoordinationRun(id);
  }

  /** Records the plan snapshot (the task ids `latte_plan_submit` just created), still unapproved. */
  setCoordinationPlan(id: string, planJson: string, updatedAt: string): CoordinationRunRecord {
    this.getCoordinationRun(id);
    this.db.run('UPDATE coordination_run SET plan_json = ?, updated_at = ? WHERE id = ?', [planJson, updatedAt, id]);
    return this.getCoordinationRun(id);
  }

  /** The one human approval `'plan'` authority requires before any snapshot task can skip its dispatch gate. */
  approveCoordinationPlan(id: string, approvedAt: string): CoordinationRunRecord {
    this.getCoordinationRun(id);
    this.db.run('UPDATE coordination_run SET plan_approved_at = ?, updated_at = ? WHERE id = ?', [approvedAt, approvedAt, id]);
    return this.getCoordinationRun(id);
  }

  /** Also updates the active run's own snapshot when one exists: a raised cap must reach a run already in flight, never only the Work's future default. */
  updateActiveCoordinationRunBudget(workId: string, budgetJson: string, updatedAt: string): void {
    const run = this.findActiveCoordinationRun(workId);
    if (!run) return;
    this.db.run('UPDATE coordination_run SET budget_json = ?, updated_at = ? WHERE id = ?', [budgetJson, updatedAt, run.id]);
  }

  insertCoordinationTask(task: CoordinationTaskRecord): CoordinationTaskRecord {
    this.db.run(
      'INSERT INTO coordination_task(id, run_id, seq, role_id, spec, title, status, depth, attempts, in_plan, assigned_member_id, result_summary, result_files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [task.id, task.runId, task.seq, task.roleId, task.spec, task.title ?? null, task.status, task.depth, task.attempts, task.inPlan ? 1 : 0, task.assignedMemberId, task.resultSummary, task.resultFilesJson, task.createdAt, task.updatedAt],
    );
    return this.getCoordinationTask(task.id);
  }

  getCoordinationTask(id: string): CoordinationTaskRecord {
    const row = this.db.get<CoordinationTaskRow>('SELECT * FROM coordination_task WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('CoordinationTask', id);
    return toCoordinationTask(row);
  }

  listCoordinationTasks(runId: string): CoordinationTaskRecord[] {
    return this.db.all<CoordinationTaskRow>('SELECT * FROM coordination_task WHERE run_id = ? ORDER BY seq ASC, id ASC', [runId]).map(toCoordinationTask);
  }

  /** Partial patch: only the fields named are changed, everything else keeps its current value. */
  updateCoordinationTask(id: string, patch: {
    status?: CoordinationTaskStatus; depth?: number; attempts?: number; assignedMemberId?: string | null;
    resultSummary?: string | null; resultFilesJson?: string | null; inPlan?: boolean;
  }, updatedAt: string): CoordinationTaskRecord {
    const current = this.getCoordinationTask(id);
    this.db.run(
      'UPDATE coordination_task SET status = ?, depth = ?, attempts = ?, assigned_member_id = ?, result_summary = ?, result_files_json = ?, in_plan = ?, updated_at = ? WHERE id = ?',
      [
        patch.status ?? current.status,
        patch.depth ?? current.depth,
        patch.attempts ?? current.attempts,
        patch.assignedMemberId === undefined ? current.assignedMemberId : patch.assignedMemberId,
        patch.resultSummary === undefined ? current.resultSummary : patch.resultSummary,
        patch.resultFilesJson === undefined ? current.resultFilesJson : patch.resultFilesJson,
        patch.inPlan === undefined ? (current.inPlan ? 1 : 0) : (patch.inPlan ? 1 : 0),
        updatedAt,
        id,
      ],
    );
    return this.getCoordinationTask(id);
  }

  /**
   * Compare-and-set: se queda con una tarea `ready` para despacharla, en UNA
   * sola sentencia. `null` significa que otro la reclamó primero — es lo que
   * hace que dos `latte_dispatch` simultáneos sobre la misma tarea no puedan
   * despachar los dos. Se llama SIEMPRE antes de cualquier `await`.
   *
   * L1 (ronda 9): DEVUELVE EL TOKEN DEL RECLAMO, que es el `updated_at` que
   * acaba de escribir. Reclamar no alcanza: entre el reclamo y el commit hay
   * un spawn entero, y desde la ronda 8 existe un escritor de la tarea en esa
   * ventana (el caso 3 de `settleOrphanDispatches`). Con este token, la
   * transacción que commitea puede CONFIRMAR que el reclamo sigue siendo suyo
   * — ver `confirmCoordinationTaskClaim`.
   *
   * `assigned_member_id` se pone en NULL explícitamente: una tarea `ready` ya
   * lo tiene así por todos los caminos que la sueltan, y dejarlo escrito acá
   * es lo que vuelve cierta la condición `assigned_member_id IS NULL` de la
   * confirmación en vez de dejarla descansando sobre una costumbre.
   */
  claimCoordinationTaskForDispatch(id: string, updatedAt: string): string | null {
    const claimed = this.db.run(
      "UPDATE coordination_task SET status = 'dispatched', assigned_member_id = NULL, updated_at = ? WHERE id = ? AND status = 'ready'",
      [updatedAt, id],
    ) > 0;
    return claimed ? updatedAt : null;
  }

  /**
   * L1 (ronda 9): LA CONFIRMACIÓN DEL RECLAMO, en la misma transacción que
   * escribe la reserva y la fila.
   *
   * Cuatro condiciones en una sola sentencia: la tarea sigue `dispatched`
   * (nadie la soltó), sigue sin miembro asignado (nadie la confirmó antes),
   * y su `updated_at` sigue siendo el del reclamo (nadie la tocó en el medio).
   * Cero filas afectadas significa que el reclamo se perdió, y entonces este
   * despacho no escribe NADA: ni reserva, ni fila, ni `hub.send`.
   *
   * K3 (ronda 10): `claimToken` NULO es el camino por gate. Ahí el reclamo no
   * lo guarda la tarea sino la fila (`started_at`), así que el token de la
   * tarea no existe; lo que sí sigue valiendo son las otras dos condiciones
   * —`dispatched` y sin miembro—, y el gate las necesita porque antes de esto
   * confirmaba la FILA y escribía la tarea a ciegas.
   *
   * K7 (ronda 10): `updated_at` COMO TOKEN ES UNA APROXIMACIÓN, y se sabe.
   * Lo reescribe cualquier UPDATE de la tabla, incluidos los que no cambian
   * de dueño, así que un escritor inocente puede provocar un `CLAIM_LOST`
   * falso: nada se corrompe (abortar es la salida segura) pero se despide a
   * un miembro recién contratado. Por eso todo escritor que NO cambia de
   * dueño tiene que dejar `updated_at` en paz — ver
   * `markCoordinationTaskInPlan`. EL ARREGLO DEFINITIVO es una columna propia
   * del reclamo (`dispatch_claim_id`, esquema v13): un token que sólo escribe
   * quien toma o suelta la tarea, inmune a cualquier otra escritura. Queda
   * fuera de este slice porque sube la versión del esquema.
   */
  confirmCoordinationTaskClaim(id: string, memberId: string, claimToken: string | null, updatedAt: string): boolean {
    const base = "UPDATE coordination_task SET assigned_member_id = ?, updated_at = ? WHERE id = ? AND status = 'dispatched' AND assigned_member_id IS NULL";
    return claimToken == null
      ? this.db.run(base, [memberId, updatedAt, id]) > 0
      : this.db.run(base + ' AND updated_at = ?', [memberId, updatedAt, id, claimToken]) > 0;
  }

  /**
   * K7 (ronda 10): EL PLAN APROBADO NO CAMBIA DE DUEÑO, ASÍ QUE NO TOCA EL
   * RELOJ.
   *
   * `updateCoordinationTask(id, { inPlan: true }, now)` reescribía
   * `updated_at` sobre TODAS las tareas del snapshot, incluidas las que en ese
   * momento estaban `dispatched` y todavía sin miembro — o sea, reclamadas por
   * un despacho que estaba levantando su proceso. Con el token roto, ese
   * despacho volvía, no podía confirmar y abortaba con `CLAIM_LOST`:
   * despedía al miembro recién contratado y le decía a la persona que otro
   * había tomado la tarea, cuando lo único que había pasado era que ella
   * aprobó el plan. Marcar la pertenencia al plan es un hecho del PLAN, no de
   * la tarea, y no tiene por qué mover su reloj.
   */
  markCoordinationTaskInPlan(id: string): void {
    this.db.run('UPDATE coordination_task SET in_plan = 1 WHERE id = ?', [id]);
  }

  /**
   * El compare-and-set inverso: mueve SOLO la tarea que este despacho había
   * reclamado, y sólo mientras siga siendo la que reclamó.
   *
   * K1 (ronda 10): EL `WHERE status = 'dispatched'` NO ALCANZABA. Decía "la
   * tarea sigue despachada", que es cierto también cuando quien la despachó es
   * OTRO: entre el reclamo y esta llamada hay un spawn entero, y en esa
   * ventana el caso 3 del barrido puede soltarla y el coordinador
   * re-despacharla legítimamente. Con la condición vieja, un spawn que volvía
   * tarde devolvía a `ready` la tarea que otro miembro estaba trabajando, y el
   * legítimo se quedaba con una fila abierta sobre una tarea que ya no era
   * suya. `expect` es la foto EXACTA de lo que este despacho dejó: su
   * `updated_at` y su dueño (nadie, mientras el reclamo no esté confirmado;
   * el miembro, después). Si algo de eso cambió, este UPDATE no toca nada y
   * devuelve `false` — y el llamador anota la bitácora en vez de escribir.
   */
  releaseCoordinationTaskFromDispatch(
    id: string,
    updatedAt: string,
    expect: CoordinationTaskClaim,
    status: 'ready' | 'failed' = 'ready',
  ): boolean {
    const owner = expect.memberId == null ? 'assigned_member_id IS NULL' : 'assigned_member_id = ?';
    const params: Array<string | null> = [status, updatedAt, id, expect.token];
    if (expect.memberId != null) params.push(expect.memberId);
    return this.db.run(
      `UPDATE coordination_task SET status = ?, assigned_member_id = NULL, updated_at = ? WHERE id = ? AND status = 'dispatched' AND updated_at = ? AND ${owner}`,
      params,
    ) > 0;
  }

  /** Compare-and-set sobre el gate: dos clics en "Aprobar" compiten por esta fila y uno solo gana. */
  claimCoordinationDispatchFromGate(id: string, startedAt: string): boolean {
    return this.db.run("UPDATE coordination_dispatch SET status = 'dispatched', started_at = ? WHERE id = ? AND status = 'pending_approval'", [startedAt, id]) > 0;
  }

  /**
   * Devuelve el gate a la mesa cuando el despacho no llegó a concretarse (por
   * ejemplo, todos los miembros del rol están ocupados).
   *
   * K2 (ronda 10): y es un COMPARE-AND-SET, igual que el que lo reclamó. Era
   * un UPDATE por id pelado: un gate que el barrido ya había liquidado
   * mientras el proceso levantaba volvía a `pending_approval` desde el `catch`
   * de un spawn tardío, y la persona veía reaparecer en la mesa una decisión
   * que ya estaba cerrada. `startedAt` es el token: sólo revive la fila que
   * ESTE reclamo marcó.
   */
  releaseCoordinationDispatchToGate(id: string, startedAt: string): boolean {
    return this.db.run(
      "UPDATE coordination_dispatch SET status = 'pending_approval', started_at = NULL WHERE id = ? AND status = 'dispatched' AND started_at = ?",
      [id, startedAt],
    ) > 0;
  }

  /** Edges live on their own table so cycle detection is a graph query, never a JSON parse. */
  insertCoordinationTaskDep(taskId: string, dependsOnId: string): void {
    this.db.run('INSERT INTO coordination_task_dep(task_id, depends_on_id) VALUES (?, ?)', [taskId, dependsOnId]);
  }

  /** Every edge for every task in a run, for feeding `dag.ts`'s pure functions. */
  listCoordinationTaskDeps(runId: string): CoordinationTaskDep[] {
    return this.db
      .all<{ task_id: string; depends_on_id: string }>(
        'SELECT d.task_id, d.depends_on_id FROM coordination_task_dep d INNER JOIN coordination_task t ON t.id = d.task_id WHERE t.run_id = ?',
        [runId],
      )
      .map((r) => ({ taskId: r.task_id, dependsOnId: r.depends_on_id }));
  }

  insertCoordinationDispatch(dispatch: CoordinationDispatchRecord): CoordinationDispatchRecord {
    this.db.run(
      'INSERT INTO coordination_dispatch(id, run_id, task_id, member_id, attempt, status, gate_id, prompt, outcome, summary, files_json, reservation_id, created_at, started_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [dispatch.id, dispatch.runId, dispatch.taskId, dispatch.memberId, dispatch.attempt, dispatch.status, dispatch.gateId, dispatch.prompt, dispatch.outcome, dispatch.summary, dispatch.filesJson, dispatch.reservationId, dispatch.createdAt, dispatch.startedAt, dispatch.settledAt],
    );
    return this.getCoordinationDispatch(dispatch.id);
  }

  getCoordinationDispatch(id: string): CoordinationDispatchRecord {
    const row = this.db.get<CoordinationDispatchRow>('SELECT * FROM coordination_dispatch WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('CoordinationDispatch', id);
    return toCoordinationDispatch(row);
  }

  /** Newest last: the bitácora's own source, in the order the events actually happened. */
  /**
   * Todo despacho todavía en vuelo, de toda la app: `dispatched` o `running`.
   * Es lo que el barrido de arranque y el de cierre reconcilian — sin esto,
   * una caída con tres despachos en vuelo dejaba esas tres tareas y sus tres
   * reservas abiertas PARA SIEMPRE, quemando cupo del Trabajo y de la app.
   */
  listOpenCoordinationDispatches(): CoordinationDispatchRecord[] {
    return this.db
      .all<CoordinationDispatchRow>("SELECT * FROM coordination_dispatch WHERE status IN ('dispatched','running') ORDER BY created_at ASC, id ASC", [])
      .map(toCoordinationDispatch);
  }

  listCoordinationDispatches(runId: string): CoordinationDispatchRecord[] {
    return this.db.all<CoordinationDispatchRow>('SELECT * FROM coordination_dispatch WHERE run_id = ? ORDER BY created_at ASC, id ASC', [runId]).map(toCoordinationDispatch);
  }

  updateCoordinationDispatch(id: string, patch: {
    status?: CoordinationDispatchStatus; memberId?: string; gateId?: string | null; prompt?: string; outcome?: string | null; summary?: string | null;
    filesJson?: string | null; reservationId?: string | null; startedAt?: string | null; settledAt?: string | null;
  }): CoordinationDispatchRecord {
    const current = this.getCoordinationDispatch(id);
    this.db.run(
      'UPDATE coordination_dispatch SET status = ?, member_id = ?, gate_id = ?, prompt = ?, outcome = ?, summary = ?, files_json = ?, reservation_id = ?, started_at = ?, settled_at = ? WHERE id = ?',
      [
        patch.status ?? current.status,
        patch.memberId ?? current.memberId,
        patch.gateId === undefined ? current.gateId : patch.gateId,
        patch.prompt ?? current.prompt,
        patch.outcome === undefined ? current.outcome : patch.outcome,
        patch.summary === undefined ? current.summary : patch.summary,
        patch.filesJson === undefined ? current.filesJson : patch.filesJson,
        patch.reservationId === undefined ? current.reservationId : patch.reservationId,
        patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        patch.settledAt === undefined ? current.settledAt : patch.settledAt,
        id,
      ],
    );
    return this.getCoordinationDispatch(id);
  }

  insertCoordinationMessage(message: CoordinationMessageRecord): CoordinationMessageRecord {
    this.db.run(
      'INSERT INTO coordination_message(id, run_id, to_member_id, from_member_id, kind, body, delivered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [message.id, message.runId, message.toMemberId, message.fromMemberId, message.kind, message.body, message.deliveredAt, message.createdAt],
    );
    return message;
  }

  /** FIFO: enqueue order, undelivered only. One index scan (`idx_coordination_message_undelivered`). */
  listUndeliveredCoordinationMessages(runId: string, toMemberId: string): CoordinationMessageRecord[] {
    return this.db
      .all<CoordinationMessageRow>(
        'SELECT * FROM coordination_message WHERE run_id = ? AND to_member_id = ? AND delivered_at IS NULL ORDER BY created_at ASC, id ASC',
        [runId, toMemberId],
      )
      .map(toCoordinationMessage);
  }

  /**
   * TODO el buzón del run, leído y sin leer, en orden de llegada. La lectura
   * de la PERSONA (`listCoordinationMessages` por IPC): la del agente es
   * `listUndeliveredCoordinationMessages`, que consume, y ésta no consume
   * nada — un mensaje que alguien ya leyó sigue siendo parte de lo que pasó.
   */
  listCoordinationMessages(runId: string): CoordinationMessageRecord[] {
    return this.db
      .all<CoordinationMessageRow>('SELECT * FROM coordination_message WHERE run_id = ? ORDER BY created_at ASC, id ASC', [runId])
      .map(toCoordinationMessage);
  }

  markCoordinationMessageDelivered(id: string, deliveredAt: string): void {
    this.db.run('UPDATE coordination_message SET delivered_at = ? WHERE id = ?', [deliveredAt, id]);
  }

  insertCoordinationAsk(ask: CoordinationAskRecord): CoordinationAskRecord {
    this.db.run(
      'INSERT INTO coordination_ask(id, run_id, task_id, member_id, question, answer, deadline_at, answered_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ask.id, ask.runId, ask.taskId, ask.memberId, ask.question, ask.answer, ask.deadlineAt, ask.answeredAt, ask.createdAt],
    );
    return this.getCoordinationAsk(ask.id);
  }

  getCoordinationAsk(id: string): CoordinationAskRecord {
    const row = this.db.get<CoordinationAskRow>('SELECT * FROM coordination_ask WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('CoordinationAsk', id);
    return toCoordinationAsk(row);
  }

  /** Unanswered asks for a run (`idx_coordination_ask_open`). */
  listOpenCoordinationAsks(runId: string): CoordinationAskRecord[] {
    return this.db.all<CoordinationAskRow>('SELECT * FROM coordination_ask WHERE run_id = ? AND answered_at IS NULL ORDER BY created_at ASC, id ASC', [runId]).map(toCoordinationAsk);
  }

  /**
   * Las preguntas de UNA tarea, oldest first (R7). Alimenta el prompt del
   * re-despacho: sin esto, la tarea que volvía a la cola porque su pregunta
   * fue contestada se despachaba EXACTAMENTE igual que la primera vez, y la
   * respuesta que la persona escribió no salía nunca de la base.
   */
  /**
   * L2 (ronda 9): TODAS las preguntas de un run, contestadas y vencidas
   * incluidas. `listOpenCoordinationAsks` no alcanza para el barrido: además
   * de saber si alguien espera AHORA, hay que saber desde CUÁNDO dejó de
   * esperar, y eso vive en las que ya se cerraron.
   */
  listCoordinationAsksForRun(runId: string): CoordinationAskRecord[] {
    return this.db.all<CoordinationAskRow>('SELECT * FROM coordination_ask WHERE run_id = ? ORDER BY created_at ASC, id ASC', [runId]).map(toCoordinationAsk);
  }

  listCoordinationAsksForTask(taskId: string): CoordinationAskRecord[] {
    return this.db.all<CoordinationAskRow>('SELECT * FROM coordination_ask WHERE task_id = ? ORDER BY created_at ASC, id ASC', [taskId]).map(toCoordinationAsk);
  }

  /**
   * La pregunta que se venció sin respuesta, CERRADA (F5).
   *
   * `answered_at` con la marca del cierre y `answer` intacto en `null`: ninguna
   * respuesta real puede verse así (`answerCoordinationAsk` siempre escribe un
   * texto), y así `listOpenCoordinationAsks` —que filtra por `answered_at IS
   * NULL`— deja de publicarla sin que haga falta una columna nueva ni subir
   * `SCHEMA_VERSION`. El `WHERE answered_at IS NULL` impide pisar una respuesta
   * que entró en el mismo instante.
   */
  expireCoordinationAsk(id: string, expiredAt: string): void {
    this.db.run('UPDATE coordination_ask SET answered_at = ? WHERE id = ? AND answered_at IS NULL', [expiredAt, id]);
  }

  /**
   * R9: un COMPARE-AND-SET, no una escritura a ciegas.
   *
   * Sin el `AND answered_at IS NULL`, dos respuestas a la misma pregunta —dos
   * personas, dos pestañas, dos clics— se pisaban en silencio, y una pregunta
   * CERRADA POR VENCIMIENTO se "contestaba" igual: el vencimiento ya había
   * devuelto la tarea a la cola, así que la persona escribía una respuesta que
   * no iba a leer nadie y la interfaz le decía que había salido bien. Cero
   * filas es un error con nombre, no un éxito silencioso.
   */
  answerCoordinationAsk(id: string, answer: string, answeredAt: string): CoordinationAskRecord {
    this.getCoordinationAsk(id); // que exista es un NotFound, no un ASK_CLOSED: son dos cosas distintas
    const changed = this.db.run('UPDATE coordination_ask SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL', [answer, answeredAt, id]);
    if (changed === 0) throw new LatteError('ASK_CLOSED', 'Esa pregunta ya no esperaba respuesta: se contestó o se venció.');
    return this.getCoordinationAsk(id);
  }

  // Coordination cost ledger (column-for-column learning_cost_reservations/ledger) --

  insertCoordinationCostReservation(row: CoordinationCostReservationRecord): void {
    this.db.run(
      'INSERT INTO coordination_cost_reservations(id, run_id, dispatch_id, member_id, runtime, model, max_input_tokens, max_output_tokens, max_cost_micros, state, usage_json, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.runId, row.dispatchId, row.memberId, row.runtime, row.model, row.maxInputTokens, row.maxOutputTokens, row.maxCostMicros, row.state, row.usageJson, row.createdAt, row.settledAt],
    );
  }

  /**
   * Compare-and-set: sólo cierra una reserva que TODAVÍA está abierta. Devuelve
   * si ganó — el llamador necesita saberlo, porque el asiento de gasto se
   * escribe una sola vez por reserva y quien pierde el CAS no tiene que
   * escribir nada (ver `CoordinationEngine.settleUncertain`).
   */
  settleCoordinationCostReservation(id: string, usageJson: string | null, settledAt: string, uncertain: boolean): boolean {
    return this.db.run(
      "UPDATE coordination_cost_reservations SET state = ?, usage_json = ?, settled_at = ? WHERE id = ? AND state = 'reserved'",
      [uncertain ? 'uncertain' : 'settled', usageJson, settledAt, id],
    ) > 0;
  }

  getCoordinationCostReservation(id: string): CoordinationCostReservationRecord | null {
    const row = this.db.get<CoordinationCostReservationRow>('SELECT * FROM coordination_cost_reservations WHERE id = ?', [id]);
    return row ? toCoordinationCostReservation(row) : null;
  }

  /** Append-only by trigger: no code path here ever issues an UPDATE/DELETE against this table. */
  insertCoordinationCostLedger(row: CoordinationCostLedgerRecord): void {
    this.db.run(
      'INSERT INTO coordination_cost_ledger(id, run_id, reservation_id, kind, dispatches, cost_micros, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.runId, row.reservationId, row.kind, row.dispatches, row.costMicros, row.detailJson, row.createdAt],
    );
  }

  /**
   * Reservas todavía abiertas (`state = 'reserved'`): gasto ya comprometido al
   * despachar, que nadie liquidó aún. Sin esto el tope sólo contaría lo que el
   * agente se dignó a reportar — un agente que nunca llama a `latte_report`
   * tendría presupuesto infinito. Sin `runId` es el total de la app.
   */
  countOpenCoordinationCostReservations(runId?: string): number {
    const row = runId
      ? this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM coordination_cost_reservations WHERE state = 'reserved' AND run_id = ?", [runId])
      : this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM coordination_cost_reservations WHERE state = 'reserved'");
    return row?.n ?? 0;
  }

  /** Las reservas abiertas de los runs vivos, la contraparte de `sumActiveCoordinationSpentDispatches` para el tope app-wide. */
  countOpenActiveCoordinationCostReservations(): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM coordination_cost_reservations WHERE state = 'reserved' AND run_id IN (SELECT id FROM coordination_run WHERE status IN ('planning','running','suspended'))",
    );
    return row?.n ?? 0;
  }

  /** `SUM(dispatches) WHERE kind = 'spend'` de UN run. La otra mitad del tope del Trabajo. */
  sumCoordinationSpentDispatches(runId: string): number {
    const row = this.db.get<{ n: number | null }>("SELECT SUM(dispatches) AS n FROM coordination_cost_ledger WHERE kind = 'spend' AND run_id = ?", [runId]);
    return row?.n ?? 0;
  }

  /**
   * Lo mismo, pero sumando sólo los runs VIVOS
   * (`planning`/`running`/`suspended`). El tope app-wide se calculaba sobre el
   * libro mayor entero, para toda la vida de la instalación: quien ponía 40
   * tenía 40 despachos y nunca más, y después cada run de cada Marca se
   * suspendía sin salida posible. Un tope app-wide describe cuánto puede estar
   * pasando A LA VEZ, no cuánto pasó alguna vez; el asiento igual queda
   * retenido, que es lo que la inmutabilidad del libro promete.
   */
  sumActiveCoordinationSpentDispatches(): number {
    const row = this.db.get<{ n: number | null }>(
      "SELECT SUM(dispatches) AS n FROM coordination_cost_ledger WHERE kind = 'spend' AND run_id IN (SELECT id FROM coordination_run WHERE status IN ('planning','running','suspended'))",
    );
    return row?.n ?? 0;
  }

  /** Every ledger row for a run, oldest first — the source `budget.ts`'s caller sums into a `BudgetUsage` snapshot. */
  listCoordinationCostLedger(runId: string): CoordinationCostLedgerRecord[] {
    return this.db
      .all<CoordinationCostLedgerRow>('SELECT * FROM coordination_cost_ledger WHERE run_id = ? ORDER BY created_at ASC, id ASC', [runId])
      .map(toCoordinationCostLedger);
  }
}
