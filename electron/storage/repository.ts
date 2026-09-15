import { createHash } from 'node:crypto';
import { DEFAULT_EFFORT_TIER, EFFORT_TIERS, EMPTY_USAGE, type Brand, type BrandContextProposal, type BrandContextProposalStatus, type FunnelStage, type ChatRuntime, type ChatUsage, type Decision, type DecisionSource, type DecisionStatus, type EffortTier, type Revision, type Work } from '../../shared/contracts';
import type { ArtifactCheck, DeliveryEvidence, GenerationReceipt } from '../../shared/generationContracts';
import { GenerationContractError } from '../generation/errors';
import { hashGenerationContext } from '../generation/canon';
import { NotFoundError, ValidationError } from '../core/errors';
import { addUsage, parseUsage, serializeUsage } from '../core/usage';
import type { SqlDriver, SqlRow } from './driver';
import { BrandingRepository } from './brandingRepository';
import { BRANDING_SCHEMA_SQL } from './brandingSchema';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

interface BrandRow extends SqlRow { id: string; name: string; context: string; created_at: string; archived_at: string | null }
interface WorkRow extends SqlRow { id: string; brand_id: string; title: string; brief: string; dir: string | null; expected_output: string | null; result_path: string | null; updated_at: string }
interface RevisionRow extends SqlRow { id: string; work_id: string; document_id: string | null; source: string; content: string; created_at: string }
interface DecisionRow extends SqlRow { id: string; work_id: string; text: string; created_at: string }
interface DecisionProposalRow extends SqlRow { id:string; work_id:string; statement:string; rationale:string; alternatives:string; evidence:string; status:string; source_chat_id:string|null; source_message_id:string|null; source_member_id:string|null; source_role_id:string|null; source_runtime:string|null; client_request_id:string; fingerprint:string; created_at:string; decided_at:string|null }
interface BrandContextProposalRow extends SqlRow {
  id: string; brand_id: string; work_id: string;
  source_chat_id: string | null; source_message_id: string | null; source_member_id: string | null;
  source_role_id: string | null; source_runtime: string | null;
  text: string; rationale: string; mode: string; status: string; fingerprint: string;
  base_fingerprint: string; client_request_id: string | null; created_at: string; decided_at: string | null;
}
interface DocumentRow extends SqlRow { id: string; work_id: string; kind: string; title: string; file_name: string; status: string; funnel_stages: string; proposed_stages: string; base_doc_id: string | null; base_rev_id: string | null; base_print: string | null; last_print: string | null; created_at: string; updated_at: string }
interface MemberRow extends SqlRow { id: string; work_id: string; role_id: string; role_name: string; initial: string; runtime: string; model: string | null; account_id: string | null; session_id: string; done: number; continued_from: string | null; tier: string | null; usage_json: string | null; created_at: string; updated_at: string }
interface GenerationRow extends SqlRow { id: string; work_id: string; brand_id: string; context_json: string; context_hash: string; created_at: string }
interface EvidenceRow extends SqlRow { id: string; generation_id: string; runtime: string; chat_id: string | null; projected_at: string; files_written: string }
interface CheckRow extends SqlRow { id: string; generation_id: string; relative_path: string; file_hash: string | null; checks_json: string; brand_compliant: number | null; created_at: string }

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
  createdAt: string;
  updatedAt: string;
}

const BRAND_SELECT = 'SELECT b.id, b.name, b.context, b.created_at, a.archived_at FROM brands b LEFT JOIN brand_archives a ON a.brand_id = b.id';
const toBrand = (r: BrandRow): Brand => ({ id: r.id, name: r.name, context: r.context, createdAt: r.created_at, archivedAt: r.archived_at ?? null });
const toWork = (r: WorkRow): Work => ({ id: r.id, brandId: r.brand_id, title: r.title, brief: r.brief, folder: r.dir ?? null, expectedOutput: r.expected_output ?? null, resultPath: r.result_path ?? null, updatedAt: r.updated_at });
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
const toProposal = (r:DecisionProposalRow):Decision => ({id:r.id,workId:r.work_id,text:r.statement,rationale:r.rationale,alternativesRejected:jsonStrings(r.alternatives),evidenceRefs:jsonStrings(r.evidence),status:r.status as DecisionStatus,source:{chatId:r.source_chat_id,messageId:r.source_message_id,memberId:r.source_member_id,roleId:r.source_role_id,runtime:(r.source_runtime==='claude'||r.source_runtime==='codex'||r.source_runtime==='opencode')?r.source_runtime:null},clientRequestId:r.client_request_id,fingerprint:r.fingerprint,createdAt:r.created_at,decidedAt:r.decided_at});
const toBrandContextProposal = (r: BrandContextProposalRow): BrandContextProposal => ({
  id: r.id,
  brandId: r.brand_id,
  workId: r.work_id,
  source: {
    chatId: r.source_chat_id,
    messageId: r.source_message_id,
    memberId: r.source_member_id,
    roleId: r.source_role_id,
    runtime: (r.source_runtime === 'claude' || r.source_runtime === 'codex' || r.source_runtime === 'opencode') ? r.source_runtime : null,
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
  runtime: (r.runtime === 'claude' || r.runtime === 'codex' ? r.runtime : 'opencode'),
  model: r.model,
  accountId: r.account_id,
  sessionId: r.session_id,
  done: r.done === 1,
  continuedFrom: r.continued_from ?? null,
  // A tier nobody recognises (a hand-edited row, a build ahead of this one)
  // reads as the default rather than propagating an unknown word upwards.
  tier: (EFFORT_TIERS as readonly string[]).includes(r.tier ?? '') ? (r.tier as EffortTier) : DEFAULT_EFFORT_TIER,
  usage: parseUsage(r.usage_json),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

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

  constructor(private readonly db: SqlDriver) {
    this.branding = new BrandingRepository(db);
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
    this.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['schema_version', SCHEMA_VERSION]);
  }

  // Meta (small app-level settings) --------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value]);
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
    this.db.run('INSERT INTO works(id, brand_id, title, brief, dir, expected_output, result_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      work.id, work.brandId, work.title, work.brief, work.folder ?? null, work.expectedOutput ?? null, work.resultPath ?? null, work.updatedAt,
    ]);
    return work;
  }

  /** What the work should deliver and the Deliverables file linked as its result. Validation lives in the service. */
  setWorkOutcome(id: string, expectedOutput: string | null, resultPath: string | null, updatedAt: string): Work {
    this.getWork(id);
    this.db.run('UPDATE works SET expected_output = ?, result_path = ?, updated_at = ? WHERE id = ?', [expectedOutput, resultPath, updatedAt, id]);
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
      'INSERT INTO team_members(id, work_id, role_id, role_name, initial, runtime, model, account_id, session_id, done, continued_from, tier, usage_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [member.id, member.workId, member.roleId, member.roleName, member.initial, member.runtime, member.model, member.accountId, member.sessionId, member.done ? 1 : 0, member.continuedFrom ?? null, tier, serializeUsage(usage), member.createdAt, member.updatedAt],
    );
    return { ...member, continuedFrom: member.continuedFrom ?? null, tier, usage };
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

  // Decisions ---------------------------------------------------------------

  listDecisions(workId: string): Decision[] {
    const legacy = this.db
      .all<DecisionRow>('SELECT * FROM decisions WHERE work_id = ? ORDER BY created_at ASC, id ASC', [workId])
      .map(toDecision);
    const proposals=this.db.all<DecisionProposalRow>('SELECT * FROM decision_proposals WHERE work_id = ? ORDER BY created_at ASC, id ASC',[workId]).map(toProposal);
    return [...legacy,...proposals].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
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
      'INSERT INTO brand_context_proposals(id, brand_id, work_id, source_chat_id, source_message_id, source_member_id, source_role_id, source_runtime, text, rationale, mode, status, fingerprint, base_fingerprint, client_request_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        proposal.id, proposal.brandId, proposal.workId,
        proposal.source.chatId, proposal.source.messageId, proposal.source.memberId, proposal.source.roleId, proposal.source.runtime,
        proposal.text, proposal.rationale, proposal.mode, proposal.status, proposal.fingerprint, proposal.baseFingerprint,
        proposal.clientRequestId, proposal.createdAt, proposal.decidedAt,
      ],
    );
    return proposal;
  }

  rejectPendingBrandContext(brandId: string, at: string): BrandContextProposal | null {
    const pending = this.findPendingBrandContext(brandId);
    if (!pending) return null;
    this.db.run("UPDATE brand_context_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", [at, pending.id]);
    return this.getBrandContextProposal(pending.id);
  }

  transitionBrandContextProposal(id: string, status: BrandContextProposalStatus, text: string | null, at: string): BrandContextProposal {
    const before = this.getBrandContextProposal(id);
    if (before.status === status) return before;
    if (before.status !== 'pending' || (status !== 'approved' && status !== 'rejected')) {
      throw new ValidationError(`Brand context proposal cannot transition from ${before.status} to ${status}`);
    }
    const nextText = text ?? before.text;
    this.db.run('UPDATE brand_context_proposals SET status = ?, text = ?, decided_at = ? WHERE id = ?', [status, nextText, at, id]);
    return this.getBrandContextProposal(id);
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
}
