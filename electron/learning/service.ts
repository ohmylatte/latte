import { ConflictError, NotFoundError, ValidationError } from '../core/errors';
import { featureEnabled, requireFeature } from '../core/features';
import { requireId, requireInt, requireRequestId } from '../services/validation';
import { PointerConflictError, type LearningRepository } from '../storage/learningRepository';
import { allowObserve } from './capture';
import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, type ReviewCostGate, type ReserveResult, type UsageReport } from './cost';
import { patternKey, skillContentHash } from './hash';
import { brandScopeKey, isLearningId, newLearningId, parseScopeKey } from './ids';
import { CatalogSkillResolver } from './resolver';
import {
  AGENCY_SCOPE_KEY,
  LEARNING_CAPTURE_KEY,
  LEARNING_DAILY_CAP_KEY,
  type CaptureMode,
  type CandidatePayload,
  type LearningSignal,
  type ResolveApprovedResult,
  type SkillCandidateRecord,
} from './types';
import { validateCandidatePayload, validateEvidenceRefs, validateSourceKey } from './validator';
import { DisabledGenerator, LearningWorker, type CandidateGenerator } from './worker';
export type { CandidateGenerator } from './worker';

export interface WorkLookup {
  getWork(workId: string): { id: string; brandId: string };
}

export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export interface SkillReviewInput {
  candidateId: string;
  expectedRevision: number;
  expectedHash: string;
  requestId: string;
}

export interface SkillPromoteInput {
  candidateId: string;
  requestId: string;
}

const INBOX_STATES = ['needs_review', 'blocked'] as const;

export class MetaCostGate implements ReviewCostGate {
  constructor(private readonly deps: { learning: LearningRepository; meta: MetaStore; now: () => Date }) {}

  async reserve(input: {
    jobId: string; provider: string; model: string;
    maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number;
  }): Promise<ReserveResult> {
    const capRaw = this.deps.meta.getMeta(LEARNING_DAILY_CAP_KEY);
    if (capRaw === null || capRaw === '') {
      return { kind: 'denied', reason: 'no_cap_configured' };
    }
    const cap = Number(capRaw);
    if (!Number.isFinite(cap) || cap <= 0) return { kind: 'denied', reason: 'no_cap_configured' };
    const startOfDay = new Date(this.deps.now());
    startOfDay.setUTCHours(0, 0, 0, 0);
    const spent = this.deps.learning.sumSettledCostMicrosSince(startOfDay.toISOString());
    if (spent + input.maxCostMicros > cap) return { kind: 'denied', reason: 'daily_cap' };
    const id = newLearningId('lrs');
    this.deps.learning.insertReservation({
      id,
      jobId: input.jobId,
      provider: input.provider,
      model: input.model,
      maxInputTokens: input.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: input.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      maxCostMicros: input.maxCostMicros,
      createdAt: this.deps.now().toISOString(),
    });
    return { kind: 'reserved', reservationId: id };
  }

  async settle(reservationId: string, usage: UsageReport | null): Promise<void> {
    const row = this.deps.learning.getReservation(reservationId);
    if (!row) return;
    const at = this.deps.now().toISOString();
    if (usage === null) {
      this.deps.learning.settleReservation(reservationId, null, at, true);
      this.deps.learning.insertLedger({
        jobId: row.jobId, reservationId, kind: 'spend', costMicros: row.maxCostMicros,
        detail: { conservative: true }, createdAt: at,
      });
      return;
    }
    this.deps.learning.settleReservation(reservationId, JSON.stringify(usage), at, false);
    this.deps.learning.insertLedger({
      jobId: row.jobId, reservationId, kind: 'spend', costMicros: usage.costMicros,
      detail: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, createdAt: at,
    });
  }
}

export class LearningService {
  private readonly resolver: CatalogSkillResolver;
  private readonly worker: LearningWorker;
  private readonly now: () => Date;

  constructor(private readonly deps: {
    learning: LearningRepository;
    works: WorkLookup;
    meta: MetaStore;
    generator?: CandidateGenerator;
    now?: () => Date;
  }) {
    this.now = deps.now ?? (() => new Date());
    this.resolver = new CatalogSkillResolver({
      learning: deps.learning,
      getMeta: (key) => deps.meta.getMeta(key),
    });
    const cost = new MetaCostGate({ learning: deps.learning, meta: deps.meta, now: this.now });
    this.worker = new LearningWorker({
      learning: deps.learning,
      cost,
      generator: deps.generator ?? new DisabledGenerator(),
      now: this.now,
      persistCandidate: (input) => ({ candidateId: this.persistValidatedCandidate(input).id }),
      captureAuto: () => this.featureOn() && this.captureMode() === 'auto',
    });
  }

  featureOn(): boolean {
    return featureEnabled((key) => this.deps.meta.getMeta(key), 'learning');
  }

  private requireEnabled(): void {
    requireFeature((key) => this.deps.meta.getMeta(key), 'learning');
  }

  captureMode(): CaptureMode {
    const raw = this.deps.meta.getMeta(LEARNING_CAPTURE_KEY);
    return raw === 'manual' || raw === 'auto' ? raw : 'off';
  }

  resolveApproved(input: { brandId: string; budgetChars: number }): ResolveApprovedResult {
    return this.resolver.resolveApproved(input);
  }

  listInbox(): SkillCandidateRecord[] {
    if (!this.featureOn()) return [];
    return this.deps.learning.listInbox([...INBOX_STATES]);
  }

  duplicateSpendVisible(): Array<{ jobId: string; costMicros: number; createdAt: string }> {
    if (!this.featureOn()) return [];
    return this.deps.learning.listDuplicateSpend();
  }

  /**
   * Persist the outbox row BEFORE any later signal. Capture is off by default.
   * A completed chat event is not a valid caller of this method.
   */
  observe(signal: LearningSignal, payload?: CandidatePayload): { jobId: string; created: boolean; candidateId: string | null } {
    this.requireEnabled();
    if (!allowObserve({ mode: this.captureMode() }, signal.kind)) {
      throw new ValidationError('Learning capture is off');
    }
    const work = this.deps.works.getWork(requireId(signal.workId, 'workId'));
    const sourceKey = validateSourceKey(signal.sourceKey);
    const evidenceRefs = validateEvidenceRefs(signal.evidenceRefs);
    const scopeKey = brandScopeKey(work.brandId);
    const createdAt = this.now().toISOString();
    const jobId = newLearningId('ljb');

    return this.deps.learning.transaction(() => {
      const inserted = this.deps.learning.insertJob({
        id: jobId,
        scopeKey,
        sourceKey,
        evidenceJson: JSON.stringify(evidenceRefs),
        createdAt,
      });
      if (!payload) {
        return { jobId: inserted.job.id, created: inserted.created, candidateId: inserted.job.candidateId };
      }
      if (inserted.job.candidateId) {
        return { jobId: inserted.job.id, created: false, candidateId: inserted.job.candidateId };
      }
      const candidate = this.persistValidatedCandidate({
        scopeKey,
        payload,
        evidenceJson: JSON.stringify(evidenceRefs),
        createdAt,
        targetSkillId: payload.targetSkillId,
      });
      this.deps.learning.finishQueuedJob(inserted.job.id, 'done', candidate.id);
      return { jobId: inserted.job.id, created: inserted.created, candidateId: candidate.id };
    });
  }

  captureExplicit(input: {
    workId: string;
    sourceKey: string;
    payload: unknown;
    evidenceRefs?: unknown;
    verification?: LearningSignal['verification'];
  }): SkillCandidateRecord {
    const payload = validateCandidatePayload(input.payload);
    const evidenceRefs = validateEvidenceRefs(input.evidenceRefs ?? []);
    const result = this.observe({
      workId: input.workId,
      sourceKey: input.sourceKey,
      kind: 'explicit_capture',
      evidenceRefs,
      verification: input.verification ?? 'human_confirmed',
    }, payload);
    if (!result.candidateId) throw new ValidationError('Capture did not persist a candidate');
    return this.deps.learning.getCandidate(result.candidateId);
  }

  persistValidatedCandidate(input: {
    scopeKey: string;
    payload: CandidatePayload;
    evidenceJson: string;
    createdAt: string;
    targetSkillId?: string | null;
  }): SkillCandidateRecord {
    this.requireEnabled();
    const payload = validateCandidatePayload(input.payload);
    const hash = skillContentHash(payload);
    const skillId = payload.targetSkillId ?? input.targetSkillId ?? newLearningId('lsk');
    if (payload.targetSkillId) {
      const existing = this.deps.learning.findLearnedSkill(payload.targetSkillId);
      if (!existing || existing.scopeKey !== input.scopeKey) {
        throw new ValidationError('targetSkillId is not an authorized learned skill in this scope');
      }
    } else if (!this.deps.learning.findLearnedSkill(skillId)) {
      this.deps.learning.insertLearnedSkill({ id: skillId, scopeKey: input.scopeKey, createdAt: input.createdAt });
    }
    const candidate = this.deps.learning.insertCandidate({
      id: newLearningId('lcd'),
      skillId,
      scopeKey: input.scopeKey,
      state: 'needs_review',
      contentHash: hash,
      name: payload.name,
      description: payload.description,
      markdown: payload.markdown,
      baseVersion: payload.base?.version ?? null,
      baseHash: payload.base?.hash ?? null,
      validatedHash: hash,
      patternKey: patternKey(input.scopeKey, payload.name, payload.markdown),
      evidenceJson: input.evidenceJson,
      createdAt: input.createdAt,
    });
    this.deps.learning.insertAudit(candidate.id, 'needs_review', { hash }, input.createdAt);
    return candidate;
  }

  approve(input: unknown): SkillCandidateRecord {
    this.requireEnabled();
    const command = requireReviewInput(input);
    try {
      return this.deps.learning.transaction(() => this.deps.learning.approveCandidate({
        candidateId: command.candidateId,
        expectedRevision: command.expectedRevision,
        expectedHash: command.expectedHash,
        requestId: command.requestId,
        nowIso: this.now().toISOString(),
      }));
    } catch (error) {
      if (error instanceof PointerConflictError) {
        this.deps.learning.transaction(() => {
          this.deps.learning.markSuperseded(command.candidateId);
          this.deps.learning.insertAudit(command.candidateId, 'superseded', { reason: 'stale_base' }, this.now().toISOString());
        });
        throw new ConflictError('The active version moved; this candidate is obsolete');
      }
      throw error;
    }
  }

  reject(input: unknown): SkillCandidateRecord {
    this.requireEnabled();
    const command = requireReviewInput(input);
    return this.deps.learning.transaction(() => this.deps.learning.rejectWithReceipt({
      candidateId: command.candidateId,
      expectedRevision: command.expectedRevision,
      expectedHash: command.expectedHash,
      requestId: command.requestId,
      nowIso: this.now().toISOString(),
    }));
  }

  promote(input: unknown): SkillCandidateRecord {
    this.requireEnabled();
    const parsed = requirePromoteInput(input);
    return this.deps.learning.transaction(() => {
      const source = this.deps.learning.getCandidate(parsed.candidateId);
      if (source.scopeKey === AGENCY_SCOPE_KEY) throw new ValidationError('Already an agency candidate');
      if (source.state !== 'approved' && source.state !== 'needs_review') {
        throw new ValidationError('Only reviewed brand candidates can be promoted');
      }
      const sanitized = sanitizeForAgency(source);
      const payload = validateCandidatePayload({
        name: sanitized.name,
        description: sanitized.description,
        markdown: sanitized.markdown,
        targetSkillId: null,
        base: null,
      });
      const createdAt = this.now().toISOString();
      const promoted = this.persistValidatedCandidate({
        scopeKey: AGENCY_SCOPE_KEY,
        payload,
        evidenceJson: '[]',
        createdAt,
      });
      this.deps.learning.insertAudit(promoted.id, 'promoted', {
        from: source.id,
        fromScope: source.scopeKey,
        requestId: parsed.requestId,
      }, createdAt);
      return promoted;
    });
  }

  async processJobs(): Promise<'idle' | 'processed' | 'deferred' | 'failed'> {
    this.requireEnabled();
    return this.worker.processNext();
  }
}

function requireReviewInput(value: unknown): SkillReviewInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid review payload');
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!['candidateId', 'expectedRevision', 'expectedHash', 'requestId'].includes(key)) {
      throw new ValidationError(`Unknown field: ${key}`);
    }
  }
  if (!isLearningId(rec.candidateId, 'lcd')) throw new ValidationError('Invalid candidateId');
  return {
    candidateId: rec.candidateId,
    expectedRevision: requireInt(rec.expectedRevision, 'expectedRevision', 1, 1_000_000),
    expectedHash: typeof rec.expectedHash === 'string' && /^[0-9a-f]{64}$/.test(rec.expectedHash)
      ? rec.expectedHash
      : (() => { throw new ValidationError('expectedHash must be a SHA-256 hex digest'); })(),
    requestId: requireRequestId(rec.requestId),
  };
}

function requirePromoteInput(value: unknown): SkillPromoteInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Invalid promote payload');
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!['candidateId', 'requestId'].includes(key)) throw new ValidationError(`Unknown field: ${key}`);
  }
  if (!isLearningId(rec.candidateId, 'lcd')) throw new ValidationError('Invalid candidateId');
  return { candidateId: rec.candidateId, requestId: requireRequestId(rec.requestId) };
}

function sanitizeForAgency(source: SkillCandidateRecord): { name: string; description: string; markdown: string } {
  const strip = (text: string) => text
    .replace(/brand:[a-z][a-z0-9_-]{2,63}/g, 'brand:<redacted>')
    .replace(/\b(doc|rev|wrk)_[a-z0-9]+/g, '<id>');
  return {
    name: source.name,
    description: strip(source.description),
    markdown: strip(source.markdown),
  };
}

export function scopeOfWork(brandId: string): string {
  if (!parseScopeKey(brandScopeKey(brandId))) throw new NotFoundError('Brand', brandId);
  return brandScopeKey(brandId);
}
