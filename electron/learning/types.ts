/** Domain types for learned skills. Pure: no I/O, no Electron, no SQLite. */

export type ScopeKind = 'brand' | 'agency';

export type Scope = { kind: 'brand'; brandId: string } | { kind: 'agency' };

export type CandidateState =
  | 'draft'
  | 'validating'
  | 'needs_review'
  | 'blocked'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type SkillLifecycle = 'active' | 'archived';

export type LearningJobState = 'queued' | 'running' | 'done' | 'no_candidate' | 'deferred' | 'failed';

export type CaptureMode = 'off' | 'manual' | 'auto';

export type SignalKind = 'explicit_capture' | 'durable_correction' | 'procedure_proposal';

export type SignalVerification = 'human_confirmed' | 'check_passed' | 'unverified';

export type HexSha256 = string;

export interface SkillRef {
  skillId: string;
  version: number;
  hash: HexSha256;
}

export interface EvidenceRef {
  documentId: string;
  revisionId: string;
  hash: HexSha256;
}

export interface LearningSignal {
  sourceKey: string;
  workId: string;
  kind: SignalKind;
  evidenceRefs: EvidenceRef[];
  verification: SignalVerification;
}

export interface CandidatePayload {
  name: string;
  description: string;
  markdown: string;
  targetSkillId: string | null;
  base: { version: number; hash: HexSha256 } | null;
}

export interface ReviewCommand {
  requestId: string;
  candidateId: string;
  expectedRevision: number;
  expectedHash: HexSha256;
  decision: 'approve' | 'reject';
}

export interface SkillCandidateRecord {
  id: string;
  skillId: string;
  scopeKey: string;
  state: CandidateState;
  revision: number;
  contentHash: HexSha256;
  name: string;
  description: string;
  markdown: string;
  baseVersion: number | null;
  baseHash: HexSha256 | null;
  validatedHash: HexSha256 | null;
  patternKey: string;
  evidenceJson: string;
  createdAt: string;
}

export interface LearnedSkillRecord {
  id: string;
  scopeKey: string;
  activeVersion: number | null;
  lifecycle: SkillLifecycle;
}

export interface LearnedSkillVersionRecord {
  skillId: string;
  version: number;
  contentHash: HexSha256;
  name: string;
  description: string;
  markdown: string;
  approvedFrom: string;
  approvedAt: string;
}

export interface LearningJobRecord {
  id: string;
  scopeKey: string;
  sourceKey: string;
  state: LearningJobState;
  leaseUntil: string | null;
  leaseToken: string | null;
  attempts: number;
  candidateId: string | null;
  evidenceJson: string;
  createdAt: string;
}

export interface ResolveApprovedInput {
  brandId: string;
  budgetChars: number;
}

export interface ResolveApprovedResult {
  refs: SkillRef[];
  excluded: SkillRef[];
}

export interface SkillResolver {
  resolveApproved(input: ResolveApprovedInput): ResolveApprovedResult;
}

export const AGENCY_SCOPE_KEY = 'agency:local';
export const LEARNING_CAPTURE_KEY = 'learning_capture';
export const LEARNING_DAILY_CAP_KEY = 'learning_daily_cost_cap_micros';
export const MAX_MARKDOWN_BYTES = 12_288;
export const MAX_LEARNED_PER_TASK = 3;
export const PATTERN_ALGO = 'v1';
export const LEARNING_ID_NAMESPACE = 'lsk';
