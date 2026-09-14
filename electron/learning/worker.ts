import { newLearningId } from './ids';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  LEASE_MS,
  MAX_JOB_ATTEMPTS,
  type ReviewCostGate,
} from './cost';
import type { CandidatePayload } from './types';
import type { LearningRepository } from '../storage/learningRepository';

export type GeneratorResult =
  | { kind: 'none'; reason: string }
  | { kind: 'candidate'; payload: CandidatePayload };

export interface CandidateGenerator {
  propose(input: { jobId: string; scopeKey: string; evidenceSummary: string }): Promise<GeneratorResult>;
}

export class DisabledGenerator implements CandidateGenerator {
  async propose(): Promise<GeneratorResult> {
    return { kind: 'none', reason: 'No hay generador configurado' };
  }
}

export interface LearningWorkerDeps {
  learning: LearningRepository;
  cost: ReviewCostGate;
  generator: CandidateGenerator;
  now: () => Date;
  persistCandidate: (input: {
    scopeKey: string;
    payload: CandidatePayload;
    evidenceJson: string;
    createdAt: string;
  }) => { candidateId: string };
  captureAuto: () => boolean;
}

export class LearningWorker {
  constructor(private readonly deps: LearningWorkerDeps) {}

  async processNext(): Promise<'idle' | 'processed' | 'deferred' | 'failed'> {
    if (!this.deps.captureAuto()) return 'idle';
    const now = this.deps.now();
    const nowIso = now.toISOString();
    const token = newLearningId('ljb');
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    const claimed = this.deps.learning.transaction(() =>
      this.deps.learning.claimJob({ nowIso, leaseUntil, token, maxAttempts: MAX_JOB_ATTEMPTS }),
    );
    if (!claimed) {
      this.deps.learning.failJobAttemptsExceeded(nowIso, MAX_JOB_ATTEMPTS);
      return 'idle';
    }

    if (!this.deps.captureAuto()) {
      this.deps.learning.transaction(() => {
        this.deps.learning.completeJob({
          jobId: claimed.id, token, nowIso, state: 'deferred', candidateId: null,
        });
      });
      return 'deferred';
    }

    const reserved = await this.deps.cost.reserve({
      jobId: claimed.id,
      provider: 'none',
      model: 'none',
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxCostMicros: 0,
    });
    if (reserved.kind === 'denied') {
      this.deps.learning.transaction(() => {
        this.deps.learning.insertLedger({
          jobId: claimed.id, reservationId: null, kind: 'denied', costMicros: 0,
          detail: { reason: reserved.reason }, createdAt: nowIso,
        });
        const ok = this.deps.learning.completeJob({
          jobId: claimed.id, token, nowIso, state: 'deferred', candidateId: null,
        });
        if (!ok) {
          this.deps.learning.insertLedger({
            jobId: claimed.id, reservationId: null, kind: 'duplicate_spend', costMicros: 0,
            detail: { reason: 'stale_lease_after_denied' }, createdAt: nowIso,
          });
        }
      });
      return 'deferred';
    }

    let result: GeneratorResult;
    try {
      result = await this.deps.generator.propose({
        jobId: claimed.id,
        scopeKey: claimed.scopeKey,
        evidenceSummary: claimed.evidenceJson,
      });
    } catch (error) {
      await this.deps.cost.settle(reserved.reservationId, null);
      this.recordUncertain(claimed.id, token, reserved.reservationId, nowIso, error);
      return 'failed';
    }

    await this.deps.cost.settle(reserved.reservationId, { inputTokens: 0, outputTokens: 0, costMicros: 0 });

    return this.deps.learning.transaction(() => {
      if (result.kind === 'none') {
        const ok = this.deps.learning.completeJob({
          jobId: claimed.id, token, nowIso, state: 'no_candidate', candidateId: null,
        });
        if (!ok) this.duplicate(claimed.id, reserved.reservationId, nowIso, 'stale_lease_after_none');
        return ok ? 'processed' : 'failed';
      }
      try {
        const persisted = this.deps.persistCandidate({
          scopeKey: claimed.scopeKey,
          payload: result.payload,
          evidenceJson: claimed.evidenceJson,
          createdAt: nowIso,
        });
        const ok = this.deps.learning.completeJob({
          jobId: claimed.id, token, nowIso, state: 'done', candidateId: persisted.candidateId,
        });
        if (!ok) this.duplicate(claimed.id, reserved.reservationId, nowIso, 'stale_lease_after_persist');
        return ok ? 'processed' : 'failed';
      } catch {
        const ok = this.deps.learning.completeJob({
          jobId: claimed.id, token, nowIso, state: 'failed', candidateId: null,
        });
        if (!ok) this.duplicate(claimed.id, reserved.reservationId, nowIso, 'stale_lease_after_invalid');
        return 'failed';
      }
    });
  }

  private duplicate(jobId: string, reservationId: string, nowIso: string, reason: string): void {
    this.deps.learning.insertLedger({
      jobId, reservationId, kind: 'duplicate_spend', costMicros: 0,
      detail: { reason, visible: true }, createdAt: nowIso,
    });
  }

  private recordUncertain(jobId: string, token: string, reservationId: string, nowIso: string, error: unknown): void {
    this.deps.learning.transaction(() => {
      this.deps.learning.insertLedger({
        jobId, reservationId, kind: 'duplicate_spend', costMicros: 0,
        detail: {
          reason: 'uncertain_after_crash_window',
          visible: true,
          error: error instanceof Error ? error.message : String(error),
        },
        createdAt: nowIso,
      });
      const ok = this.deps.learning.completeJob({
        jobId, token, nowIso, state: 'failed', candidateId: null,
      });
      if (!ok) this.duplicate(jobId, reservationId, nowIso, 'stale_lease_after_uncertain');
    });
  }
}
