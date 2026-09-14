import { LatteError } from '../core/errors';

/** SHA-256 hex of 64 lowercase characters. Not the short document fingerprint. */
export type Sha256 = string;
export type KitRef = Readonly<{ kitId: string; version: number; hash: Sha256 }>;
export type SkillRef = Readonly<{ skillId: string; version: number; hash: Sha256 }>;

export type GenerationContext = Readonly<{
  schemaVersion: 1;
  workId: string;
  brandId: string;
  brandContext: KitRef | null;
  skillRefs: readonly SkillRef[];
}>;

export type Asset = Readonly<{
  id: string;
  hash: Sha256;
  required: boolean;
  usable: boolean;
}>;

export type KitOwner =
  | Readonly<{ kind: 'brand'; brandId: string }>
  | Readonly<{ kind: 'agency' }>;

export type Kit = Readonly<{
  ref: KitRef;
  owner: KitOwner;
  approved: boolean;
  revoked: boolean;
  permitsAgencySignature: boolean;
  assets: readonly Asset[];
  rules: string;
}>;

export type Signature = Readonly<{
  agencyRevision: number;
  hash: Sha256;
  publicName: string;
  website?: string;
  logo: Asset | null;
}>;

export type Choice = Readonly<{
  identity: 'brand' | 'agency' | 'neutral';
  signature: 'none' | 'agency';
}>;

export type WorkBrandPolicy = Readonly<{
  workId: string;
  brandId: string;
  revision: number;
  defaultChoice: Choice;
  allowNeutral: boolean;
  allowAgencySignature: boolean;
}>;

export type Resolution = Readonly<{
  identity: Choice['identity'];
  sourceKit: KitRef | null;
  rules: string;
  assets: readonly Asset[];
  signature: Signature | null;
  warnings: readonly string[];
}>;

export type BrandError =
  | 'KIT_MISSING'
  | 'KIT_NOT_APPROVED'
  | 'KIT_REVOKED'
  | 'KIT_SCOPE_MISMATCH'
  | 'NEUTRAL_NOT_APPROVED'
  | 'REQUIRED_ASSET_MISSING'
  | 'SIGNATURE_NOT_APPROVED'
  | 'SIGNATURE_ASSET_MISSING'
  | 'WORK_BRAND_MISMATCH'
  | 'UNAUTHORIZED';

export class BrandKitError extends LatteError {
  constructor(readonly brandCode: BrandError, message: string) {
    super(brandCode, message);
    this.name = 'BrandKitError';
  }
}

export const NEUTRAL_RULES = 'Estilo neutro; no afirmar identidad oficial.';

/**
 * Default when a work has no persisted policy and no kit: identity and
 * signature stay off, so today's product behaviour is preserved until a
 * human imports a kit and chooses otherwise.
 */
export const DEFAULT_WORK_CHOICE: Choice = Object.freeze({ identity: 'neutral', signature: 'none' });

export function implicitWorkBrandPolicy(workId: string, brandId: string): WorkBrandPolicy {
  return {
    workId,
    brandId,
    revision: 0,
    defaultChoice: DEFAULT_WORK_CHOICE,
    allowNeutral: true,
    allowAgencySignature: false,
  };
}

export interface BrandAccess {
  requireWork(workId: string): { id: string; brandId: string };
  policyForWork(workId: string): WorkBrandPolicy;
  approvedKitForBrand(brandId: string): Kit | null;
  approvedAgencyKit(): Kit | null;
  agencySignature(): Signature | null;
}

/** Snapshot of a resolved composition. Generation adapts this to its port after merge. */
export type BrandContextSnapshot = Readonly<{
  schemaVersion: 1;
  generationId: string;
  workId: string;
  brandId: string;
  choice: Choice;
  identity: Choice['identity'];
  sourceKit: KitRef | null;
  rules: string;
  assets: ReadonlyArray<{ id: string; hash: Sha256 }>;
  signature: {
    agencyRevision: number;
    hash: Sha256;
    publicName: string;
    website: string | null;
    logo: { id: string; hash: Sha256 } | null;
  } | null;
  warnings: readonly string[];
}>;

export type ComposedBrandContext = Readonly<{
  receipt: GenerationContext;
  snapshot: BrandContextSnapshot;
}>;

export { FEATURE_KEYS } from '../core/features';
export const FEATURE_BRAND_KITS = 'feature:brand-kits';
