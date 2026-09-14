import { describe, expect, it } from 'vitest';
import {
  canonicalGenerationContext,
  canonicalJson,
  hashGenerationContext,
  kitRefFromSnapshot,
  sha256Utf8,
  validateGenerationContext,
} from '../../electron/generation/canon';
import { GenerationContractError } from '../../electron/generation/errors';
import type { BrandContextSnapshot, GenerationContext, SkillRef } from '../../shared/generationContracts';

const H = (ch: string) => ch.repeat(64);

const skill = (id: string, version = 1): SkillRef => ({ skillId: id, version, hash: H('1') });

function brandSnapshot(over: Partial<BrandContextSnapshot> & Pick<BrandContextSnapshot, 'workId' | 'brandId'>): BrandContextSnapshot {
  return {
    schemaVersion: 1,
    choice: { identity: 'brand', signature: 'none' },
    identity: 'brand',
    sourceKit: { kitId: 'kit_source', version: 1, hash: H('a') },
    rules: 'Reglas de marca.',
    assets: [{ id: 'logo', hash: H('b') }],
    signature: null,
    warnings: [],
    ...over,
  };
}

const marcaA: GenerationContext = {
  schemaVersion: 1,
  workId: 'wrk_marca_a',
  brandId: 'brd_marca_a',
  brandContext: { kitId: 'gen_marca_a', version: 1, hash: H('c') },
  skillRefs: [skill('learned-b', 2), skill('learned-a', 1)],
};

const marcaB: GenerationContext = {
  schemaVersion: 1,
  workId: 'wrk_marca_b',
  brandId: 'brd_marca_b',
  brandContext: { kitId: 'gen_marca_b', version: 1, hash: H('d') },
  skillRefs: [],
};

const neutroFirma: GenerationContext = {
  schemaVersion: 1,
  workId: 'wrk_neutro',
  brandId: 'brd_neutro',
  brandContext: { kitId: 'gen_neutro', version: 1, hash: H('e') },
  skillRefs: [],
};

describe('canonicalJson', () => {
  it('sorts object keys and drops undefined, so insertion order does not change the bytes', () => {
    const left = canonicalJson({ z: 1, a: 'café', nested: { b: true, a: null } });
    const right = canonicalJson({ a: 'café', nested: { a: null, b: true }, z: 1 });
    expect(left).toBe(right);
    expect(left).toBe('{"a":"café","nested":{"a":null,"b":true},"z":1}');
  });

  it('NFC-normalizes strings so composed and decomposed café hash the same', () => {
    const composed = 'café';
    const decomposed = 'cafe\u0301';
    expect(composed).not.toBe(decomposed);
    expect(canonicalJson(composed)).toBe(canonicalJson(decomposed));
    expect(sha256Utf8(canonicalJson(composed))).toBe(sha256Utf8(canonicalJson(decomposed)));
  });

  it('is not incidental JSON.stringify of an unsorted object', () => {
    const value = { z: 1, a: 2 };
    expect(JSON.stringify(value)).toBe('{"z":1,"a":2}');
    expect(canonicalJson(value)).toBe('{"a":2,"z":1}');
    expect(canonicalJson(value)).not.toBe(JSON.stringify(value));
  });
});

describe('generation context fixtures: marca A, marca B, neutro+firma', () => {
  it('same input always yields the same SHA-256', () => {
    const first = hashGenerationContext(marcaA);
    const shuffled: GenerationContext = {
      skillRefs: [...marcaA.skillRefs].reverse(),
      brandId: marcaA.brandId,
      schemaVersion: 1,
      workId: marcaA.workId,
      brandContext: { hash: marcaA.brandContext!.hash, version: 1, kitId: marcaA.brandContext!.kitId },
    };
    const second = hashGenerationContext(shuffled);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).not.toBe(first.hash.slice(0, 16));
  });

  it('a minimal change yields a different hash', () => {
    const a = hashGenerationContext(marcaA).hash;
    const b = hashGenerationContext(marcaB).hash;
    const n = hashGenerationContext(neutroFirma).hash;
    expect(a).not.toBe(b);
    expect(a).not.toBe(n);
    expect(b).not.toBe(n);
    const tweaked = hashGenerationContext({ ...marcaA, workId: 'wrk_marca_a2' }).hash;
    expect(tweaked).not.toBe(a);
  });

  it('neutral with a signature still produces a brandContext ref; neutral without inputs is null', () => {
    const withSig = brandSnapshot({
      workId: 'wrk_neutro',
      brandId: 'brd_neutro',
      choice: { identity: 'neutral', signature: 'agency' },
      identity: 'neutral',
      sourceKit: null,
      assets: [],
      signature: { agencyRevision: 1, hash: H('f'), publicName: 'Agencia Local', website: null, logo: null },
    });
    expect(kitRefFromSnapshot('gen_neutro_firma', withSig)).toEqual({
      kitId: 'gen_neutro_firma',
      version: 1,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const bare = brandSnapshot({
      workId: 'wrk_neutro',
      brandId: 'brd_neutro',
      choice: { identity: 'neutral', signature: 'none' },
      identity: 'neutral',
      sourceKit: null,
      assets: [],
      signature: null,
    });
    expect(kitRefFromSnapshot('gen_neutro_bare', bare)).toBeNull();
  });

  it('rejects an invalid schema, a short hash, and a non-integer version', () => {
    expect(() => canonicalGenerationContext({ ...marcaA, schemaVersion: 2 as 1 })).toThrow(GenerationContractError);
    try {
      validateGenerationContext({ ...marcaA, brandContext: { kitId: 'kit', version: 1, hash: 'deadbeef' } });
      throw new Error('expected HASH_INVALID');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationContractError);
      expect((error as GenerationContractError).code).toBe('HASH_INVALID');
    }
    try {
      validateGenerationContext({ ...marcaA, skillRefs: [{ skillId: 'x', version: 0, hash: H('1') }] });
      throw new Error('expected SCHEMA_INVALID');
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationContractError);
      expect((error as GenerationContractError).code).toBe('SCHEMA_INVALID');
    }
  });
});
