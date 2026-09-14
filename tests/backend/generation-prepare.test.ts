import { describe, expect, it } from 'vitest';
import { prepareGeneration } from '../../electron/generation/prepare';
import { hashGenerationContext } from '../../electron/generation/canon';
import { GenerationContractError } from '../../electron/generation/errors';
import type {
  BrandContextPort,
  BrandContextSnapshot,
  GenerationReceipt,
  SkillResolverPort,
} from '../../shared/generationContracts';

const H = (ch: string) => ch.repeat(64);

const snapshotA: BrandContextSnapshot = {
  schemaVersion: 1,
  workId: 'wrk_a',
  brandId: 'brd_a',
  choice: { identity: 'brand', signature: 'none' },
  identity: 'brand',
  sourceKit: { kitId: 'kit_a', version: 1, hash: H('a') },
  rules: 'Paleta A.',
  assets: [{ id: 'logo', hash: H('b') }],
  signature: null,
  warnings: [],
};

function harness(over: {
  live?: number;
  brand?: BrandContextPort;
  skills?: SkillResolverPort;
  workBrandId?: string;
} = {}) {
  const receipts: GenerationReceipt[] = [];
  const pins: string[] = [];
  let refreshed = 0;
  const brand: BrandContextPort = over.brand ?? { resolveForWork: () => snapshotA, pinAssets: () => [] };
  const skills: SkillResolverPort = over.skills ?? {
    resolveApproved: ({ brandId }) => {
      if (brandId !== 'brd_a') return { refs: [], excluded: [] };
      return { refs: [{ skillId: 'learned-a', version: 1, hash: H('1') }], excluded: [] };
    },
  };
  return {
    receipts,
    pins,
    refreshed: () => refreshed,
    run: () =>
      prepareGeneration({
        works: { requireWork: (id) => {
          if (id !== 'wrk_a') throw new GenerationContractError('WORK_NOT_FOUND');
          return { id: 'wrk_a', brandId: over.workBrandId ?? 'brd_a' };
        } },
        brand,
        skills,
        insert: (r) => { receipts.push(r); return r; },
        pin: ({ generationId }) => { pins.push(generationId); },
        liveMemberCount: () => over.live ?? 0,
        refreshInstructions: () => { refreshed += 1; },
        newId: () => 'gen_dddddddddddddddddddd',
        now: () => '2026-09-14T12:00:00.000Z',
        budgetChars: 2000,
      }, 'wrk_a'),
  };
}

describe('prepareGeneration', () => {
  it('derives brandId from requireWork, seals a canonical receipt, and pins before refresh', () => {
    const h = harness();
    const result = h.run();
    expect(result.context.brandId).toBe('brd_a');
    expect(result.context.workId).toBe('wrk_a');
    expect(result.context.brandContext?.kitId).toBe('gen_dddddddddddddddddddd');
    expect(result.context.skillRefs).toEqual([{ skillId: 'learned-a', version: 1, hash: H('1') }]);
    expect(result.contextHash).toBe(hashGenerationContext(result.context).hash);
    expect(h.receipts).toHaveLength(1);
    expect(h.pins).toEqual(['gen_dddddddddddddddddddd']);
    expect(result.instructionsRefreshed).toBe(true);
    expect(result.pending).toBe(false);
    expect(h.refreshed()).toBe(1);
  });

  it('persists the receipt but does not rewrite instructions when live members exist', () => {
    const h = harness({ live: 2 });
    const result = h.run();
    expect(h.receipts).toHaveLength(1);
    expect(h.pins).toHaveLength(1);
    expect(result.pending).toBe(true);
    expect(result.instructionsRefreshed).toBe(false);
    expect(h.refreshed()).toBe(0);
  });

  it('fails closed on a snapshot that belongs to another brand instead of inheriting agency', () => {
    const h = harness({
      brand: { resolveForWork: () => ({ ...snapshotA, brandId: 'brd_other' }), pinAssets: () => [] },
    });
    expect(() => h.run()).toThrow(GenerationContractError);
    try { h.run(); } catch (error) { expect((error as GenerationContractError).code).toBe('BRAND_SCOPE_MISMATCH'); }
    expect(h.receipts).toHaveLength(0);
  });

  it('treats a missing work as WORK_NOT_FOUND before building context', () => {
    const h = harness();
    expect(() =>
      prepareGeneration({
        works: { requireWork: () => { throw new GenerationContractError('WORK_NOT_FOUND'); } },
        brand: { resolveForWork: () => snapshotA, pinAssets: () => [] },
        skills: { resolveApproved: () => ({ refs: [], excluded: [] }) },
        insert: (r) => r,
        pin: () => undefined,
        liveMemberCount: () => 0,
        refreshInstructions: () => undefined,
        newId: () => 'gen_x',
        now: () => '2026-09-14T12:00:00.000Z',
        budgetChars: 100,
      }, 'wrk_missing'),
    ).toThrow(GenerationContractError);
    expect(h.receipts).toHaveLength(0);
  });
});
