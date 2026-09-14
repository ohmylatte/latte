/**
 * Shared generation contracts. Domain types only: no I/O, no Node, no Electron.
 * Brand-kit and learned-skill worktrees implement the ports; this tree ships fakes in tests.
 */

export type SchemaVersion = 1;
/** 64 lowercase hex characters. Not the short SHA-1 fingerprint of Markdown snapshots. */
export type HexSha256 = string;
export type ContentHash = HexSha256;

export const GENERATION_SCHEMA_VERSION: SchemaVersion = 1;
export const HEX_SHA256 = /^[0-9a-f]{64}$/;
/** Installation meta key. Absent or any value other than `1` means OFF. */
export const GENERATION_ENABLED_META = 'feature:generation';

export interface KitRef {
  kitId: string;
  version: number;
  hash: ContentHash;
}

export interface SkillRef {
  skillId: string;
  version: number;
  hash: ContentHash;
}

export type IdentityMode = 'brand' | 'agency' | 'neutral';
export type SignatureMode = 'none' | 'agency';

export interface BrandChoice {
  identity: IdentityMode;
  signature: SignatureMode;
}

export interface BrandAssetRef {
  id: string;
  hash: ContentHash;
}

export interface BrandSignatureSnapshot {
  agencyRevision: number;
  hash: ContentHash;
  publicName: string;
  website: string | null;
  logo: BrandAssetRef | null;
}

/**
 * Resolved, immutable identity+signature composition.
 * `null` from the port means no identity and no signature (explicit-neutral).
 * Neutral WITH a signature is a non-null snapshot (`sourceKit === null`, `signature !== null`).
 */
export interface BrandContextSnapshot {
  schemaVersion: SchemaVersion;
  workId: string;
  brandId: string;
  choice: BrandChoice;
  identity: IdentityMode;
  sourceKit: KitRef | null;
  rules: string;
  assets: BrandAssetRef[];
  signature: BrandSignatureSnapshot | null;
  warnings: string[];
}

export interface GenerationContext {
  schemaVersion: SchemaVersion;
  workId: string;
  brandId: string;
  brandContext: KitRef | null;
  skillRefs: SkillRef[];
}

export interface GenerationReceipt {
  id: string;
  workId: string;
  brandId: string;
  context: GenerationContext;
  contextJson: string;
  contextHash: ContentHash;
  createdAt: string;
}

export type GenerationErrorCode =
  | 'SCHEMA_INVALID'
  | 'WORK_NOT_FOUND'
  | 'BRAND_SCOPE_MISMATCH'
  | 'HASH_INVALID'
  | 'VERSION_CONFLICT'
  | 'KIT_NOT_APPROVED'
  | 'SKILL_NOT_APPROVED'
  | 'REVOKED_REF'
  | 'LIVE_MEMBERS'
  | 'CANONICALIZE_FAILED'
  | 'DISABLED';

export interface BrandContextPort {
  /** Reads the persisted identity/signature choice for the work. Never takes brandId from the caller. */
  resolveForWork(workId: string): BrandContextSnapshot | null;
}

export interface SkillResolverPort {
  /**
   * Authorize `brand:<brandId>` and `agency:local` BEFORE indexing.
   * Returns approved learned refs that fit `budgetChars`, plus those excluded.
   * Shipped skills are not this catalog.
   */
  resolveApproved(input: { brandId: string; budgetChars: number }): {
    refs: SkillRef[];
    excluded: SkillRef[];
  };
}

export interface DeliveryEvidence {
  id: string;
  generationId: string;
  runtime: string;
  chatId: string | null;
  projectedAt: string;
  filesWritten: string[];
}

export interface ArtifactCheck {
  id: string;
  generationId: string;
  relativePath: string;
  fileHash: ContentHash | null;
  checks: Array<{ name: string; passed: boolean; note: string }>;
  brandCompliant: boolean | null;
  createdAt: string;
}

export interface PrepareGenerationResult {
  generationId: string;
  context: GenerationContext;
  contextHash: ContentHash;
  pending: boolean;
  instructionsRefreshed: boolean;
  excludedSkillRefs: SkillRef[];
}

export function isGenerationEnabled(metaValue: string | null | undefined): boolean {
  return metaValue === 'on';
}

export const NOOP_BRAND_CONTEXT: BrandContextPort = {
  resolveForWork() {
    return null;
  },
};

export const NOOP_SKILL_RESOLVER: SkillResolverPort = {
  resolveApproved() {
    return { refs: [], excluded: [] };
  },
};
