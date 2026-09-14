import { describe, expect, it } from 'vitest';
import {
  authorizeWork,
  canonicalJson,
  composeBrandContext,
  kitsForAuthorizedWork,
  resolveBrandContext,
  sha256Utf8,
} from '../../electron/branding/resolver';
import { BrandKitError, implicitWorkBrandPolicy, type BrandAccess, type Kit, type Signature } from '../../electron/branding/types';

const HASH = 'ab'.repeat(32);

function kit(partial: Partial<Kit> & Pick<Kit, 'owner'>): Kit {
  return {
    ref: { kitId: 'kit_aaaaaa', version: 1, hash: HASH },
    approved: true,
    revoked: false,
    permitsAgencySignature: true,
    assets: [{ id: 'logo', hash: HASH, required: true, usable: true }],
    rules: 'Reglas de la marca.',
    ...partial,
  };
}

const brandA = kit({ owner: { kind: 'brand', brandId: 'brd_alpha' }, ref: { kitId: 'kit_alpha', version: 1, hash: HASH } });
const brandB = kit({ owner: { kind: 'brand', brandId: 'brd_beta' }, ref: { kitId: 'kit_beta', version: 1, hash: HASH } });
const agency = kit({ owner: { kind: 'agency' }, ref: { kitId: 'kit_agency', version: 1, hash: HASH }, rules: 'Reglas de agencia.' });
const signature: Signature = { agencyRevision: 1, hash: HASH, publicName: 'Estudio Norte', website: 'https://norte.example', logo: { id: 'sig-logo', hash: HASH, required: false, usable: true } };

function policy(brandId: string, extra: Partial<ReturnType<typeof implicitWorkBrandPolicy>> = {}) {
  return { ...implicitWorkBrandPolicy('wrk_one', brandId), allowNeutral: true, allowAgencySignature: true, ...extra };
}

function access(overrides: Partial<BrandAccess> = {}): BrandAccess {
  return {
    requireWork: (workId) => ({ id: workId, brandId: 'brd_alpha' }),
    policyForWork: (workId) => policy('brd_alpha', { workId }),
    approvedKitForBrand: (brandId) => (brandId === 'brd_alpha' ? brandA : brandId === 'brd_beta' ? brandB : null),
    approvedAgencyKit: () => agency,
    agencySignature: () => signature,
    ...overrides,
  };
}

function resolveA(partial: Parameters<typeof resolveBrandContext>[0] extends infer T ? Partial<T> : never) {
  return resolveBrandContext({
    brandId: 'brd_alpha',
    choice: { identity: 'brand', signature: 'none' },
    brandKit: brandA,
    agencyKit: agency,
    agencySignature: signature,
    policy: policy('brd_alpha'),
    ...partial,
  });
}

describe('resolveBrandContext', () => {
  it('marca sin kit, agencia disponible, identity=brand → KIT_MISSING', () => {
    expect(() => resolveA({ brandKit: null })).toThrow(BrandKitError);
    try { resolveA({ brandKit: null }); } catch (error) { expect((error as BrandKitError).code).toBe('KIT_MISSING'); }
  });

  it('kit de otra marca inyectado como brandKit → KIT_SCOPE_MISMATCH', () => {
    expect(() => resolveA({ brandKit: brandB })).toThrow(/no pertenece/);
    try { resolveA({ brandKit: brandB }); } catch (error) { expect((error as BrandKitError).code).toBe('KIT_SCOPE_MISMATCH'); }
  });

  it('marca válida, signature=none → signature === null y no hereda agencia', () => {
    const resolved = resolveA({ choice: { identity: 'brand', signature: 'none' } });
    expect(resolved.signature).toBeNull();
    expect(resolved.sourceKit).toEqual(brandA.ref);
    expect(resolved.rules).toBe(brandA.rules);
    expect(resolved.rules).not.toBe(agency.rules);
  });

  it('firma pedida, allowAgencySignature=false → SIGNATURE_NOT_APPROVED', () => {
    try {
      resolveA({ choice: { identity: 'brand', signature: 'agency' }, policy: policy('brd_alpha', { allowAgencySignature: false }) });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('SIGNATURE_NOT_APPROVED'); }
  });

  it('firma pedida, kit.permitsAgencySignature=false → SIGNATURE_NOT_APPROVED', () => {
    try {
      resolveA({
        choice: { identity: 'brand', signature: 'agency' },
        brandKit: { ...brandA, permitsAgencySignature: false },
      });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('SIGNATURE_NOT_APPROVED'); }
  });

  it('recurso obligatorio usable=false → REQUIRED_ASSET_MISSING', () => {
    try {
      resolveA({ brandKit: { ...brandA, assets: [{ id: 'logo', hash: HASH, required: true, usable: false }] } });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('REQUIRED_ASSET_MISSING'); }
  });

  it('neutro no autorizado → NEUTRAL_NOT_APPROVED', () => {
    try {
      resolveA({ choice: { identity: 'neutral', signature: 'none' }, policy: policy('brd_alpha', { allowNeutral: false }) });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('NEUTRAL_NOT_APPROVED'); }
  });

  it('identity=agency usa agencyKit, no brandKit', () => {
    const resolved = resolveA({ choice: { identity: 'agency', signature: 'none' } });
    expect(resolved.sourceKit).toEqual(agency.ref);
    expect(resolved.rules).toBe(agency.rules);
  });

  it('policy.brandId distinto → WORK_BRAND_MISMATCH', () => {
    try {
      resolveA({ policy: policy('brd_beta') });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('WORK_BRAND_MISMATCH'); }
  });

  it('kit revocado aunque aprobado → KIT_REVOKED', () => {
    try {
      resolveA({ brandKit: { ...brandA, revoked: true } });
      throw new Error('expected throw');
    } catch (error) { expect((error as BrandKitError).code).toBe('KIT_REVOKED'); }
  });

  it('nunca usa agencyKit como fallback de brandKit', () => {
    expect(() => resolveA({ brandKit: null, choice: { identity: 'brand', signature: 'none' } })).toThrow(/neutro|importá/);
  });
});

describe('composeBrandContext', () => {
  it('neutro autorizado sin kit ni firma → brandContext === null', () => {
    const resolution = resolveA({ choice: { identity: 'neutral', signature: 'none' }, brandKit: null });
    const { receipt, snapshot } = composeBrandContext('gen_one', 'wrk_one', 'brd_alpha', { identity: 'neutral', signature: 'none' }, resolution, []);
    expect(receipt.brandContext).toBeNull();
    expect(snapshot.sourceKit).toBeNull();
  });

  it('neutro autorizado con firma → brandContext !== null && sourceKit === null', () => {
    const resolution = resolveA({ choice: { identity: 'neutral', signature: 'agency' }, brandKit: null });
    const { receipt, snapshot } = composeBrandContext('gen_two', 'wrk_one', 'brd_alpha', { identity: 'neutral', signature: 'agency' }, resolution, []);
    expect(receipt.brandContext).not.toBeNull();
    expect(receipt.brandContext?.kitId).toBe('gen_two');
    expect(snapshot.sourceKit).toBeNull();
    expect(snapshot.signature?.publicName).toBe('Estudio Norte');
  });

  it('el kitId del recibo es el generationId, no el kit fuente', () => {
    const resolution = resolveA({});
    const { receipt } = composeBrandContext('gen_comp', 'wrk_one', 'brd_alpha', { identity: 'brand', signature: 'none' }, resolution, []);
    expect(receipt.brandContext?.kitId).toBe('gen_comp');
    expect(receipt.brandContext?.kitId).not.toBe(brandA.ref.kitId);
    expect(receipt.brandContext?.version).toBe(1);
  });

  it('canonicalJson es estable ante el orden de claves', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(sha256Utf8(canonicalJson({ b: 1, a: 2 }))).toBe(sha256Utf8(canonicalJson({ a: 2, b: 1 })));
  });
});

describe('authorizeWork / kitsForAuthorizedWork', () => {
  it('un trabajo de marca A no recibe el kit de B', () => {
    const loaded = kitsForAuthorizedWork(access(), 'wrk_one');
    expect(loaded.brandKit?.ref.kitId).toBe('kit_alpha');
    expect(loaded.brandKit?.ref.kitId).not.toBe('kit_beta');
  });

  it('política desalineada aborta antes de resolver', () => {
    expect(() => authorizeWork(access({
      policyForWork: () => policy('brd_beta', { workId: 'wrk_one' }),
    }), 'wrk_one')).toThrow(BrandKitError);
  });
});
