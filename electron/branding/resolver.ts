import { createHash } from 'node:crypto';
import {
  BrandKitError,
  NEUTRAL_RULES,
  type BrandAccess,
  type BrandContextSnapshot,
  type Choice,
  type ComposedBrandContext,
  type GenerationContext,
  type Kit,
  type KitRef,
  type Resolution,
  type Sha256,
  type SkillRef,
  type WorkBrandPolicy,
} from './types';

export function selectKit(choice: Choice, brandKit: Kit | null, agencyKit: Kit | null): Kit | null {
  if (choice.identity === 'brand') return brandKit;
  if (choice.identity === 'agency') return agencyKit;
  return null;
}

export function assertOwner(selected: Kit, identity: Choice['identity'], brandId: string): void {
  if (identity === 'brand' && (selected.owner.kind !== 'brand' || selected.owner.brandId !== brandId)) {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'El kit no pertenece a esta marca');
  }
  if (identity === 'agency' && selected.owner.kind !== 'agency') {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Identidad de agencia exige kit de agencia');
  }
}

/** Authorize a work and its persisted (or implicit) policy. No I/O of its own. */
export function authorizeWork(access: BrandAccess, workId: string): {
  work: { id: string; brandId: string };
  policy: WorkBrandPolicy;
} {
  const work = access.requireWork(workId);
  const policy = access.policyForWork(work.id);
  if (policy.workId !== work.id || policy.brandId !== work.brandId) {
    throw new BrandKitError('WORK_BRAND_MISMATCH', 'Política desalineada del trabajo');
  }
  return { work, policy };
}

/** Kits visible for this work: this brand's approved kit and the agency kit. Never another brand. */
export function kitsForAuthorizedWork(access: BrandAccess, workId: string): {
  work: { id: string; brandId: string };
  policy: WorkBrandPolicy;
  brandKit: Kit | null;
  agencyKit: Kit | null;
  agencySignature: ReturnType<BrandAccess['agencySignature']>;
} {
  const { work, policy } = authorizeWork(access, workId);
  const brandKit = access.approvedKitForBrand(work.brandId);
  if (brandKit && (brandKit.owner.kind !== 'brand' || brandKit.owner.brandId !== work.brandId)) {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Head de marca apunta a otro dueño');
  }
  const agencyKit = access.approvedAgencyKit();
  if (agencyKit && agencyKit.owner.kind !== 'agency') {
    throw new BrandKitError('KIT_SCOPE_MISMATCH', 'Head de agencia no es de agencia');
  }
  return {
    work,
    policy,
    brandKit,
    agencyKit,
    agencySignature: access.agencySignature(),
  };
}

/** Pure: identity + signature. No I/O, no IPC, no licenses, no agency fallback for a brand kit. */
export function resolveBrandContext(input: {
  brandId: string;
  choice: Choice;
  brandKit: Kit | null;
  agencyKit: Kit | null;
  agencySignature: ReturnType<BrandAccess['agencySignature']>;
  policy: WorkBrandPolicy;
}): Resolution {
  if (input.policy.brandId !== input.brandId) {
    throw new BrandKitError('WORK_BRAND_MISMATCH', 'La política no es de esta marca');
  }
  const { choice } = input;
  const selected = selectKit(choice, input.brandKit, input.agencyKit);
  if (choice.identity !== 'neutral' && !selected) {
    throw new BrandKitError('KIT_MISSING', 'Elegí neutro explícitamente o importá un kit');
  }
  if (selected) {
    if (!selected.approved) throw new BrandKitError('KIT_NOT_APPROVED', 'El kit no está aprobado');
    if (selected.revoked) throw new BrandKitError('KIT_REVOKED', 'El kit está revocado');
    assertOwner(selected, choice.identity, input.brandId);
  }
  if (choice.identity === 'neutral' && !input.policy.allowNeutral) {
    throw new BrandKitError('NEUTRAL_NOT_APPROVED', 'Este trabajo no autoriza estilo neutro');
  }
  const assets = selected?.assets ?? [];
  if (assets.some((a) => a.required && !a.usable)) {
    throw new BrandKitError('REQUIRED_ASSET_MISSING', 'Falta un recurso obligatorio usable');
  }
  const warnings = assets.filter((a) => !a.usable).map((a) => `Recurso opcional omitido: ${a.id}`);
  let signature: Resolution['signature'] = null;
  if (choice.signature === 'agency') {
    const kitForbids = Boolean(selected && !selected.permitsAgencySignature);
    const workForbids = !input.policy.allowAgencySignature;
    if (workForbids || kitForbids || !input.agencySignature) {
      throw new BrandKitError('SIGNATURE_NOT_APPROVED', 'Firma de agencia no autorizada');
    }
    signature = input.agencySignature;
    if (signature.logo && !signature.logo.usable) {
      throw new BrandKitError('SIGNATURE_ASSET_MISSING', 'El logo de firma no es usable');
    }
  }
  return {
    identity: choice.identity,
    sourceKit: selected?.ref ?? null,
    rules: selected?.rules ?? NEUTRAL_RULES,
    assets: assets.filter((a) => a.usable),
    signature,
    warnings,
  };
}

/** Canonical JSON: sorted object keys, schemaVersion inside hashed payloads, hash itself stays outside. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Utf8(s: string): Sha256 {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Receipt kitId is the generationId of this composition, not the source kit.
 * brandContext is null only for neutral identity with no signature.
 */
export function composeBrandContext(
  generationId: string,
  workId: string,
  brandId: string,
  choice: Choice,
  resolution: Resolution,
  skillRefs: readonly SkillRef[],
  hashUtf8: (s: string) => Sha256 = sha256Utf8,
): ComposedBrandContext {
  const snapshot: BrandContextSnapshot = {
    schemaVersion: 1,
    generationId,
    workId,
    brandId,
    choice,
    identity: resolution.identity,
    sourceKit: resolution.sourceKit,
    rules: resolution.rules,
    assets: resolution.assets
      .map((a) => ({ id: a.id, hash: a.hash }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    signature: resolution.signature && {
      agencyRevision: resolution.signature.agencyRevision,
      hash: resolution.signature.hash,
      publicName: resolution.signature.publicName,
      website: resolution.signature.website ?? null,
      logo: resolution.signature.logo && {
        id: resolution.signature.logo.id,
        hash: resolution.signature.logo.hash,
      },
    },
    warnings: resolution.warnings,
  };
  const hash = hashUtf8(canonicalJson(snapshot));
  const hasInputs = resolution.sourceKit !== null || resolution.signature !== null;
  const brandContext: KitRef | null = hasInputs ? { kitId: generationId, version: 1, hash } : null;
  const receipt: GenerationContext = { schemaVersion: 1, workId, brandId, brandContext, skillRefs };
  return { receipt, snapshot };
}
