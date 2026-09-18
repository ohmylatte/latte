import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';

// Clones the shape of decisions-agent.test.ts: `decisionAuthority` is the
// precedent for every per-Work setting that lives in `meta` with a closed
// union and a safe default on an unset/invalid read.

describe('coordination authority (per-Work meta, decisionAuthority precedent)', () => {
  let b: TestBackend;
  let workId: string;
  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Brand');
    const work = await b.service.createWork(brand.id, 'Work');
    workId = work.id;
  });
  afterEach(() => b.cleanup());

  it('defaults to manual when never set', async () => {
    expect(await b.service.getCoordinationAuthority(workId)).toBe('manual');
  });

  it('round-trips a valid write and rejects an invalid one, leaving the stored value unchanged', async () => {
    expect(await b.service.setCoordinationAuthority(workId, 'auto')).toBe('auto');
    expect(await b.service.getCoordinationAuthority(workId)).toBe('auto');
    await expect(b.service.setCoordinationAuthority(workId, 'yolo' as never)).rejects.toThrow();
    expect(await b.service.getCoordinationAuthority(workId)).toBe('auto');
  });

  it('accepts every mode in the closed union', async () => {
    for (const mode of ['manual', 'plan', 'auto'] as const) {
      expect(await b.service.setCoordinationAuthority(workId, mode)).toBe(mode);
      expect(await b.service.getCoordinationAuthority(workId)).toBe(mode);
    }
  });
});

describe('coordination budget (per-Work meta, JSON round-trip, no implicit unlimited)', () => {
  let b: TestBackend;
  let workId: string;
  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Brand');
    const work = await b.service.createWork(brand.id, 'Work');
    workId = work.id;
  });
  afterEach(() => b.cleanup());

  it('is unset (null) until a human configures it — never a default unlimited', async () => {
    expect(await b.service.getCoordinationBudget(workId)).toBeNull();
  });

  it('round-trips a budget with only the primary cap', async () => {
    const saved = await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    expect(saved.maxDispatches).toBe(10);
    expect(await b.service.getCoordinationBudget(workId)).toEqual(saved);
  });

  it('round-trips every secondary cap', async () => {
    const budget = { maxDispatches: 5, maxTokens: 1000, maxCostMicros: 5000, maxWallMinutes: 60, maxConcurrent: 2 };
    const saved = await b.service.setCoordinationBudget(workId, budget);
    // Normalized: every optional field is present, explicitly `null` when omitted.
    expect(saved).toEqual({ ...budget, unlimitedConfirmedAt: null });
    expect(await b.service.getCoordinationBudget(workId)).toEqual(saved);
  });

  it('rejects an implicit unlimited (maxDispatches:null without confirmation)', async () => {
    await expect(b.service.setCoordinationBudget(workId, { maxDispatches: null } as never)).rejects.toThrow();
    expect(await b.service.getCoordinationBudget(workId)).toBeNull();
  });

  it('accepts an explicit unlimited confirmation', async () => {
    const saved = await b.service.setCoordinationBudget(workId, { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' });
    expect(saved.maxDispatches).toBeNull();
    expect(await b.service.getCoordinationBudget(workId)).toEqual(saved);
  });

  it('rejects an invalid budget without touching the previously stored value', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await expect(b.service.setCoordinationBudget(workId, { maxDispatches: 0 } as never)).rejects.toThrow();
    expect((await b.service.getCoordinationBudget(workId))!.maxDispatches).toBe(10);
  });
});
