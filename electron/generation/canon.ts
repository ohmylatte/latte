import {
  GENERATION_SCHEMA_VERSION,
  HEX_SHA256,
  type BrandAssetRef,
  type BrandContextSnapshot,
  type BrandSignatureSnapshot,
  type ContentHash,
  type GenerationContext,
  type KitRef,
  type SkillRef,
} from '../../shared/generationContracts';
import { canonicalJson as coreCanonicalJson, sha256Utf8 as coreSha256Utf8 } from '../core/canonical';
import { GenerationContractError } from './errors';

const IDENTITY_MODES = new Set(['brand', 'agency', 'neutral']);
const SIGNATURE_MODES = new Set(['none', 'agency']);

/** Deterministic JSON: sorted object keys, no `undefined`, NFC strings. Not incidental JSON.stringify. */
export function canonicalJson(value: unknown): string {
  try {
    return coreCanonicalJson(value);
  } catch (error) {
    if (error instanceof GenerationContractError) throw error;
    throw new GenerationContractError('CANONICALIZE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export function sha256Utf8(text: string): ContentHash {
  return coreSha256Utf8(text);
}

export function assertHexSha256(value: string): ContentHash {
  if (!HEX_SHA256.test(value)) throw new GenerationContractError('HASH_INVALID');
  return value;
}

function assertKitRef(value: KitRef, label: string): KitRef {
  if (!value || typeof value !== 'object') throw new GenerationContractError('SCHEMA_INVALID', `${label} missing`);
  if (typeof value.kitId !== 'string' || value.kitId.normalize('NFC').trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', `${label}.kitId`);
  }
  if (!Number.isInteger(value.version) || value.version < 1) {
    throw new GenerationContractError('SCHEMA_INVALID', `${label}.version`);
  }
  return { kitId: value.kitId.normalize('NFC'), version: value.version, hash: assertHexSha256(value.hash) };
}

function assertSkillRef(value: SkillRef): SkillRef {
  if (!value || typeof value !== 'object') throw new GenerationContractError('SCHEMA_INVALID', 'skillRef');
  if (typeof value.skillId !== 'string' || value.skillId.normalize('NFC').trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'skillRef.skillId');
  }
  if (!Number.isInteger(value.version) || value.version < 1) {
    throw new GenerationContractError('SCHEMA_INVALID', 'skillRef.version');
  }
  return { skillId: value.skillId.normalize('NFC'), version: value.version, hash: assertHexSha256(value.hash) };
}

function assertAssetRef(value: BrandAssetRef): BrandAssetRef {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'asset.id');
  }
  return { id: value.id.normalize('NFC'), hash: assertHexSha256(value.hash) };
}

function assertSignature(value: BrandSignatureSnapshot): BrandSignatureSnapshot {
  if (!Number.isInteger(value.agencyRevision) || value.agencyRevision < 1) {
    throw new GenerationContractError('SCHEMA_INVALID', 'signature.agencyRevision');
  }
  if (typeof value.publicName !== 'string' || value.publicName.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'signature.publicName');
  }
  if (value.website !== null && typeof value.website !== 'string') {
    throw new GenerationContractError('SCHEMA_INVALID', 'signature.website');
  }
  return {
    agencyRevision: value.agencyRevision,
    hash: assertHexSha256(value.hash),
    publicName: value.publicName.normalize('NFC'),
    website: value.website === null ? null : value.website.normalize('NFC'),
    logo: value.logo ? assertAssetRef(value.logo) : null,
  };
}

export function validateBrandContextSnapshot(snapshot: BrandContextSnapshot): BrandContextSnapshot {
  if (snapshot.schemaVersion !== GENERATION_SCHEMA_VERSION) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.schemaVersion');
  }
  if (typeof snapshot.workId !== 'string' || snapshot.workId.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.workId');
  }
  if (typeof snapshot.brandId !== 'string' || snapshot.brandId.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.brandId');
  }
  if (!IDENTITY_MODES.has(snapshot.identity) || !IDENTITY_MODES.has(snapshot.choice?.identity)) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.identity');
  }
  if (!SIGNATURE_MODES.has(snapshot.choice?.signature)) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.choice.signature');
  }
  if (snapshot.identity !== snapshot.choice.identity) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.identity/choice mismatch');
  }
  if (typeof snapshot.rules !== 'string') throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.rules');
  if (!Array.isArray(snapshot.assets) || !Array.isArray(snapshot.warnings)) {
    throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.assets/warnings');
  }
  const assets = snapshot.assets
    .map(assertAssetRef)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    workId: snapshot.workId.normalize('NFC'),
    brandId: snapshot.brandId.normalize('NFC'),
    choice: { identity: snapshot.choice.identity, signature: snapshot.choice.signature },
    identity: snapshot.identity,
    sourceKit: snapshot.sourceKit ? assertKitRef(snapshot.sourceKit, 'sourceKit') : null,
    rules: snapshot.rules.normalize('NFC'),
    assets,
    signature: snapshot.signature ? assertSignature(snapshot.signature) : null,
    warnings: snapshot.warnings.map((w) => {
      if (typeof w !== 'string') throw new GenerationContractError('SCHEMA_INVALID', 'snapshot.warnings');
      return w.normalize('NFC');
    }),
  };
}

export function validateGenerationContext(ctx: GenerationContext): GenerationContext {
  if (ctx.schemaVersion !== GENERATION_SCHEMA_VERSION) {
    throw new GenerationContractError('SCHEMA_INVALID', 'schemaVersion');
  }
  if (typeof ctx.workId !== 'string' || ctx.workId.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'workId');
  }
  if (typeof ctx.brandId !== 'string' || ctx.brandId.trim().length === 0) {
    throw new GenerationContractError('SCHEMA_INVALID', 'brandId');
  }
  if (!Array.isArray(ctx.skillRefs)) throw new GenerationContractError('SCHEMA_INVALID', 'skillRefs');
  const skillRefs = ctx.skillRefs
    .map(assertSkillRef)
    .sort((a, b) => a.skillId.localeCompare(b.skillId) || a.version - b.version);
  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    workId: ctx.workId.normalize('NFC'),
    brandId: ctx.brandId.normalize('NFC'),
    brandContext: ctx.brandContext ? assertKitRef(ctx.brandContext, 'brandContext') : null,
    skillRefs,
  };
}

export function canonicalGenerationContext(ctx: GenerationContext): string {
  return canonicalJson(validateGenerationContext(ctx));
}

export function hashGenerationContext(ctx: GenerationContext): { json: string; hash: ContentHash; context: GenerationContext } {
  const context = validateGenerationContext(ctx);
  const json = canonicalJson(context);
  return { json, hash: sha256Utf8(json), context };
}

/**
 * KitRef for the resolved composition. Neutral without identity or signature → null.
 * Neutral with a signature still gets a ref (hash of the snapshot).
 */
export function kitRefFromSnapshot(generationId: string, snapshot: BrandContextSnapshot | null): KitRef | null {
  if (!snapshot) return null;
  const valid = validateBrandContextSnapshot(snapshot);
  const hasInputs = valid.sourceKit !== null || valid.signature !== null;
  if (!hasInputs) return null;
  const hash = sha256Utf8(canonicalJson({ generationId, snapshot: valid }));
  return { kitId: generationId, version: 1, hash };
}
