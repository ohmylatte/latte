import { ConflictError, NotFoundError, ValidationError } from '../core/errors';
import { commandHash } from '../learning/hash';
import { newLearningId } from '../learning/ids';
import type {
  CandidateState,
  HexSha256,
  LearnedSkillRecord,
  LearnedSkillVersionRecord,
  LearningJobRecord,
  LearningJobState,
  SkillCandidateRecord,
  SkillLifecycle,
} from '../learning/types';
import type { SqlDriver, SqlRow } from './driver';

interface CandidateRow extends SqlRow {
  id: string; skill_id: string; scope_key: string; state: string; revision: number;
  content_hash: string; name: string; description: string; markdown: string;
  base_version: number | null; base_hash: string | null; validated_hash: string | null;
  pattern_key: string; evidence_json: string; created_at: string;
}
interface SkillRow extends SqlRow {
  id: string; scope_key: string; active_version: number | null; lifecycle: string;
}
interface VersionRow extends SqlRow {
  skill_id: string; version: number; content_hash: string; name: string; description: string;
  markdown: string; approved_from: string; approved_at: string;
}
interface JobRow extends SqlRow {
  id: string; scope_key: string; source_key: string; state: string;
  lease_until: string | null; lease_token: string | null; attempts: number;
  candidate_id: string | null; evidence_json: string; created_at: string;
}

const toCandidate = (r: CandidateRow): SkillCandidateRecord => ({
  id: r.id,
  skillId: r.skill_id,
  scopeKey: r.scope_key,
  state: r.state as CandidateState,
  revision: Number(r.revision),
  contentHash: r.content_hash,
  name: r.name,
  description: r.description,
  markdown: r.markdown,
  baseVersion: r.base_version === null || r.base_version === undefined ? null : Number(r.base_version),
  baseHash: r.base_hash,
  validatedHash: r.validated_hash,
  patternKey: r.pattern_key,
  evidenceJson: r.evidence_json,
  createdAt: r.created_at,
});

const toSkill = (r: SkillRow): LearnedSkillRecord => ({
  id: r.id,
  scopeKey: r.scope_key,
  activeVersion: r.active_version === null || r.active_version === undefined ? null : Number(r.active_version),
  lifecycle: r.lifecycle as SkillLifecycle,
});

const toVersion = (r: VersionRow): LearnedSkillVersionRecord => ({
  skillId: r.skill_id,
  version: Number(r.version),
  contentHash: r.content_hash,
  name: r.name,
  description: r.description,
  markdown: r.markdown,
  approvedFrom: r.approved_from,
  approvedAt: r.approved_at,
});

const toJob = (r: JobRow): LearningJobRecord => ({
  id: r.id,
  scopeKey: r.scope_key,
  sourceKey: r.source_key,
  state: r.state as LearningJobState,
  leaseUntil: r.lease_until,
  leaseToken: r.lease_token,
  attempts: Number(r.attempts),
  candidateId: r.candidate_id,
  evidenceJson: r.evidence_json,
  createdAt: r.created_at,
});

export class PointerConflictError extends ConflictError {
  constructor() {
    super('The active version moved; this candidate is obsolete');
    this.name = 'PointerConflictError';
  }
}

export class LearningRepository {
  constructor(private readonly db: SqlDriver) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  private affected(): number {
    const row = this.db.get<{ c: number | string | null }>('SELECT changes() AS c');
    return Number(row?.c ?? 0);
  }

  insertLearnedSkill(row: { id: string; scopeKey: string; createdAt: string }): void {
    this.db.run(
      "INSERT INTO learned_skills(id, scope_key, active_version, lifecycle) VALUES (?, ?, NULL, 'active')",
      [row.id, row.scopeKey],
    );
  }

  getLearnedSkill(id: string): LearnedSkillRecord {
    const row = this.db.get<SkillRow>('SELECT * FROM learned_skills WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('LearnedSkill', id);
    return toSkill(row);
  }

  findLearnedSkill(id: string): LearnedSkillRecord | null {
    const row = this.db.get<SkillRow>('SELECT * FROM learned_skills WHERE id = ?', [id]);
    return row ? toSkill(row) : null;
  }

  insertCandidate(row: Omit<SkillCandidateRecord, 'revision'> & { revision?: number }): SkillCandidateRecord {
    const revision = row.revision ?? 1;
    this.db.run(
      `INSERT INTO skill_candidates(
        id, skill_id, scope_key, state, revision, content_hash, name, description, markdown,
        base_version, base_hash, validated_hash, pattern_key, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.skillId, row.scopeKey, row.state, revision, row.contentHash, row.name, row.description, row.markdown,
        row.baseVersion, row.baseHash, row.validatedHash, row.patternKey, row.evidenceJson, row.createdAt,
      ],
    );
    return this.getCandidate(row.id);
  }

  getCandidate(id: string): SkillCandidateRecord {
    const row = this.db.get<CandidateRow>('SELECT * FROM skill_candidates WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('SkillCandidate', id);
    return toCandidate(row);
  }

  listInbox(states: CandidateState[] = ['needs_review', 'blocked']): SkillCandidateRecord[] {
    const placeholders = states.map(() => '?').join(', ');
    return this.db.all<CandidateRow>(
      `SELECT * FROM skill_candidates WHERE state IN (${placeholders}) ORDER BY created_at DESC`,
      states,
    ).map(toCandidate);
  }

  insertJob(row: {
    id: string; scopeKey: string; sourceKey: string; evidenceJson: string; createdAt: string;
  }): { job: LearningJobRecord; created: boolean } {
    this.db.run(
      `INSERT OR IGNORE INTO learning_jobs(
        id, scope_key, source_key, state, lease_until, lease_token, attempts, candidate_id, evidence_json, created_at
      ) VALUES (?, ?, ?, 'queued', NULL, NULL, 0, NULL, ?, ?)`,
      [row.id, row.scopeKey, row.sourceKey, row.evidenceJson, row.createdAt],
    );
    const existing = this.db.get<JobRow>(
      'SELECT * FROM learning_jobs WHERE scope_key = ? AND source_key = ?',
      [row.scopeKey, row.sourceKey],
    );
    if (!existing) throw new ValidationError('Failed to persist learning job');
    const created = existing.id === row.id;
    if (!created && existing.state === 'queued') {
      const merged = mergeEvidence(existing.evidence_json, row.evidenceJson);
      if (merged !== existing.evidence_json) {
        this.db.run('UPDATE learning_jobs SET evidence_json = ? WHERE id = ? AND state = ?', [merged, existing.id, 'queued']);
      }
    }
    return { job: toJob(this.db.get<JobRow>('SELECT * FROM learning_jobs WHERE id = ?', [existing.id])!), created };
  }

  getJob(id: string): LearningJobRecord {
    const row = this.db.get<JobRow>('SELECT * FROM learning_jobs WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('LearningJob', id);
    return toJob(row);
  }

  listJobs(): LearningJobRecord[] {
    return this.db.all<JobRow>('SELECT * FROM learning_jobs ORDER BY created_at').map(toJob);
  }

  /**
   * Atomic claim: queued or expired running jobs. Replaces lease_token so a
   * stale worker cannot commit later.
   */
  claimJob(input: { jobId?: string; nowIso: string; leaseUntil: string; token: string; maxAttempts: number }): LearningJobRecord | null {
    if (input.jobId) {
      this.db.run(
        `UPDATE learning_jobs
         SET state = 'running', lease_until = ?, lease_token = ?, attempts = attempts + 1
         WHERE id = ? AND attempts < ? AND (
           state = 'queued' OR (state = 'running' AND (lease_until IS NULL OR lease_until < ?))
         )`,
        [input.leaseUntil, input.token, input.jobId, input.maxAttempts, input.nowIso],
      );
    } else {
      const next = this.db.get<JobRow>(
        `SELECT * FROM learning_jobs
         WHERE attempts < ? AND (
           state = 'queued' OR (state = 'running' AND (lease_until IS NULL OR lease_until < ?))
         )
         ORDER BY created_at ASC LIMIT 1`,
        [input.maxAttempts, input.nowIso],
      );
      if (!next) return null;
      this.db.run(
        `UPDATE learning_jobs
         SET state = 'running', lease_until = ?, lease_token = ?, attempts = attempts + 1
         WHERE id = ? AND attempts < ? AND (
           state = 'queued' OR (state = 'running' AND (lease_until IS NULL OR lease_until < ?))
         )`,
        [input.leaseUntil, input.token, next.id, input.maxAttempts, input.nowIso],
      );
    }
    if (this.affected() !== 1) return null;
    const row = this.db.get<JobRow>('SELECT * FROM learning_jobs WHERE lease_token = ?', [input.token]);
    return row ? toJob(row) : null;
  }

  completeJob(input: {
    jobId: string;
    token: string;
    nowIso: string;
    state: Exclude<LearningJobState, 'queued' | 'running'>;
    candidateId: string | null;
  }): boolean {
    this.db.run(
      `UPDATE learning_jobs
       SET state = ?, candidate_id = ?, lease_token = NULL, lease_until = NULL
       WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`,
      [input.state, input.candidateId, input.jobId, input.token, input.nowIso],
    );
    return this.affected() === 1;
  }

  /** Manual capture never leases: close a queued job in the same write as the candidate. */
  finishQueuedJob(jobId: string, state: Exclude<LearningJobState, 'queued' | 'running'>, candidateId: string | null): boolean {
    this.db.run(
      `UPDATE learning_jobs
       SET state = ?, candidate_id = ?, lease_token = NULL, lease_until = NULL
       WHERE id = ? AND state = 'queued'`,
      [state, candidateId, jobId],
    );
    return this.affected() === 1;
  }

  failJobAttemptsExceeded(nowIso: string, maxAttempts: number): void {
    this.db.run(
      `UPDATE learning_jobs SET state = 'failed'
       WHERE state IN ('queued','running') AND attempts >= ? AND (lease_until IS NULL OR lease_until < ?)`,
      [maxAttempts, nowIso],
    );
  }

  insertReservation(row: {
    id: string; jobId: string; provider: string; model: string;
    maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number; createdAt: string;
  }): void {
    this.db.run(
      `INSERT INTO learning_cost_reservations(
        id, job_id, provider, model, max_input_tokens, max_output_tokens, max_cost_micros, state, usage_json, created_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL)`,
      [row.id, row.jobId, row.provider, row.model, row.maxInputTokens, row.maxOutputTokens, row.maxCostMicros, row.createdAt],
    );
  }

  settleReservation(id: string, usageJson: string | null, at: string, uncertain: boolean): void {
    this.db.run(
      `UPDATE learning_cost_reservations SET state = ?, usage_json = ?, settled_at = ? WHERE id = ? AND state = 'reserved'`,
      [uncertain ? 'uncertain' : 'settled', usageJson, at, id],
    );
  }

  getReservation(id: string): { id: string; jobId: string; maxCostMicros: number; state: string } | null {
    const row = this.db.get<{ id: string; job_id: string; max_cost_micros: number; state: string }>(
      'SELECT id, job_id, max_cost_micros, state FROM learning_cost_reservations WHERE id = ?',
      [id],
    );
    if (!row) return null;
    return { id: row.id, jobId: row.job_id, maxCostMicros: Number(row.max_cost_micros), state: row.state };
  }

  sumSettledCostMicrosSince(sinceIso: string): number {
    const row = this.db.get<{ total: number | null }>(
      `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM learning_cost_ledger WHERE created_at >= ? AND kind IN ('spend','duplicate_spend')`,
      [sinceIso],
    );
    return Number(row?.total ?? 0);
  }

  insertLedger(row: {
    jobId: string; reservationId: string | null; kind: 'spend' | 'duplicate_spend' | 'denied';
    costMicros: number; detail: Record<string, unknown>; createdAt: string;
  }): void {
    this.db.run(
      'INSERT INTO learning_cost_ledger(id, job_id, reservation_id, kind, cost_micros, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newLearningId('lld'), row.jobId, row.reservationId, row.kind, row.costMicros, JSON.stringify(row.detail), row.createdAt],
    );
  }

  jobHasDuplicateSpend(jobId: string): boolean {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM learning_cost_ledger WHERE job_id = ? AND kind = 'duplicate_spend'",
      [jobId],
    );
    return Number(row?.n ?? 0) > 0;
  }

  listDuplicateSpend(): Array<{ jobId: string; costMicros: number; createdAt: string }> {
    return this.db.all<{ job_id: string; cost_micros: number; created_at: string }>(
      "SELECT job_id, cost_micros, created_at FROM learning_cost_ledger WHERE kind = 'duplicate_spend' ORDER BY created_at DESC",
    ).map((r) => ({ jobId: r.job_id, costMicros: Number(r.cost_micros), createdAt: r.created_at }));
  }

  insertAudit(candidateId: string | null, action: string, detail: Record<string, unknown>, createdAt: string): void {
    this.db.run(
      'INSERT INTO skill_audit(id, candidate_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [newLearningId('lau'), candidateId, action, JSON.stringify(detail), createdAt],
    );
  }

  findReceipt(requestId: string): { commandHash: string; resultJson: string } | null {
    const row = this.db.get<{ command_hash: string; result_json: string }>(
      'SELECT command_hash, result_json FROM skill_review_receipts WHERE request_id = ?',
      [requestId],
    );
    return row ? { commandHash: row.command_hash, resultJson: row.result_json } : null;
  }

  insertReceipt(requestId: string, hash: string, resultJson: string, createdAt: string): void {
    this.db.run(
      'INSERT INTO skill_review_receipts(request_id, command_hash, result_json, created_at) VALUES (?, ?, ?, ?)',
      [requestId, hash, resultJson, createdAt],
    );
  }

  listApprovedVersions(scopeKeys: string[]): LearnedSkillVersionRecord[] {
    if (scopeKeys.length === 0) return [];
    const placeholders = scopeKeys.map(() => '?').join(', ');
    return this.db.all<VersionRow>(
      `SELECT v.* FROM learned_skill_versions v
       INNER JOIN learned_skills s ON s.id = v.skill_id AND s.active_version = v.version
       WHERE s.lifecycle = 'active' AND s.scope_key IN (${placeholders})
       ORDER BY s.scope_key ASC, v.skill_id ASC`,
      scopeKeys,
    ).map(toVersion);
  }

  getVersion(skillId: string, version: number): LearnedSkillVersionRecord | null {
    const row = this.db.get<VersionRow>(
      'SELECT * FROM learned_skill_versions WHERE skill_id = ? AND version = ?',
      [skillId, version],
    );
    return row ? toVersion(row) : null;
  }

  nextVersion(skillId: string): number {
    const row = this.db.get<{ m: number | null }>('SELECT MAX(version) AS m FROM learned_skill_versions WHERE skill_id = ?', [skillId]);
    return Number(row?.m ?? 0) + 1;
  }

  markSuperseded(candidateId: string): void {
    this.db.run(
      "UPDATE skill_candidates SET state = 'superseded', revision = revision + 1 WHERE id = ? AND state = 'needs_review'",
      [candidateId],
    );
  }

  rejectCandidate(candidateId: string, expectedRevision: number, expectedHash: string): SkillCandidateRecord {
    this.db.run(
      `UPDATE skill_candidates SET state = 'rejected', revision = revision + 1
       WHERE id = ? AND state = 'needs_review' AND revision = ? AND content_hash = ?`,
      [candidateId, expectedRevision, expectedHash],
    );
    if (this.affected() !== 1) throw new ConflictError('Candidate review conflict');
    return this.getCandidate(candidateId);
  }

  /**
   * Approve inside one write transaction: CAS candidate, insert immutable
   * version, CAS active pointer. No LLM, no filesystem.
   */
  approveCandidate(input: {
    candidateId: string;
    expectedRevision: number;
    expectedHash: HexSha256;
    requestId: string;
    nowIso: string;
  }): SkillCandidateRecord {
    const hash = commandHash({
      candidateId: input.candidateId,
      expectedRevision: input.expectedRevision,
      expectedHash: input.expectedHash,
      decision: 'approve',
    });
    const existing = this.findReceipt(input.requestId);
    if (existing) {
      if (existing.commandHash !== hash) throw new ConflictError('requestId reused with a different command');
      return this.getCandidate(input.candidateId);
    }

    this.db.run(
      `UPDATE skill_candidates
       SET state = 'approved', revision = revision + 1
       WHERE id = ? AND state = 'needs_review' AND revision = ? AND content_hash = ? AND validated_hash = ?`,
      [input.candidateId, input.expectedRevision, input.expectedHash, input.expectedHash],
    );
    if (this.affected() !== 1) throw new ConflictError('Candidate review conflict');

    const candidate = this.getCandidate(input.candidateId);
    const nextVersion = this.nextVersion(candidate.skillId);
    this.db.run(
      `INSERT INTO learned_skill_versions(
        skill_id, version, content_hash, name, description, markdown, approved_from, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [candidate.skillId, nextVersion, candidate.contentHash, candidate.name, candidate.description, candidate.markdown, candidate.id, input.nowIso],
    );

    if (candidate.baseVersion === null) {
      this.db.run(
        `UPDATE learned_skills SET active_version = ?
         WHERE id = ? AND scope_key = ? AND lifecycle = 'active' AND active_version IS NULL`,
        [nextVersion, candidate.skillId, candidate.scopeKey],
      );
    } else {
      this.db.run(
        `UPDATE learned_skills SET active_version = ?
         WHERE id = ? AND scope_key = ? AND lifecycle = 'active' AND active_version = ?`,
        [nextVersion, candidate.skillId, candidate.scopeKey, candidate.baseVersion],
      );
    }
    if (this.affected() !== 1) throw new PointerConflictError();

    this.insertAudit(candidate.id, 'approved', { version: nextVersion, requestId: input.requestId }, input.nowIso);
    this.insertReceipt(input.requestId, hash, JSON.stringify({ status: 'approved', candidateId: candidate.id, version: nextVersion }), input.nowIso);
    return this.getCandidate(input.candidateId);
  }

  rejectWithReceipt(input: {
    candidateId: string;
    expectedRevision: number;
    expectedHash: HexSha256;
    requestId: string;
    nowIso: string;
  }): SkillCandidateRecord {
    const hash = commandHash({
      candidateId: input.candidateId,
      expectedRevision: input.expectedRevision,
      expectedHash: input.expectedHash,
      decision: 'reject',
    });
    const existing = this.findReceipt(input.requestId);
    if (existing) {
      if (existing.commandHash !== hash) throw new ConflictError('requestId reused with a different command');
      return this.getCandidate(input.candidateId);
    }
    const candidate = this.rejectCandidate(input.candidateId, input.expectedRevision, input.expectedHash);
    this.insertAudit(candidate.id, 'rejected', { requestId: input.requestId }, input.nowIso);
    this.insertReceipt(input.requestId, hash, JSON.stringify({ status: 'rejected', candidateId: candidate.id }), input.nowIso);
    return candidate;
  }
}

function mergeEvidence(existingJson: string, incomingJson: string): string {
  const parse = (raw: string): unknown[] => {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...parse(existingJson), ...parse(incomingJson)]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return JSON.stringify(out);
}
