import { describe, expect, it } from 'vitest';
import {
  BudgetUnsetError,
  recordSpend,
  reserveDispatch,
  type BudgetUsage,
  type CoordinationBudget,
} from '../../electron/coordination/budget';

const ZERO_USAGE: BudgetUsage = { dispatchesUsed: 0 };

describe('coordination budget (pure)', () => {
  it('BUDGET_UNSET: no budget configured at all is never implicitly unlimited', () => {
    expect(() => reserveDispatch(null, ZERO_USAGE)).toThrow(BudgetUnsetError);
    expect(() => reserveDispatch(undefined, ZERO_USAGE)).toThrow(BudgetUnsetError);
    try {
      reserveDispatch(null, ZERO_USAGE);
      expect.unreachable();
    } catch (e) {
      expect((e as BudgetUnsetError).code).toBe('BUDGET_UNSET');
    }
  });

  it('primary-cap-only budget: maxDispatches alone is fully enforceable with every other cap unset', () => {
    const budget: CoordinationBudget = { maxDispatches: 3 };
    expect(reserveDispatch(budget, { dispatchesUsed: 0 })).toEqual({ ok: true });
    expect(reserveDispatch(budget, { dispatchesUsed: 2 })).toEqual({ ok: true });
    expect(reserveDispatch(budget, { dispatchesUsed: 3 })).toEqual({ ok: false, reason: 'max_dispatches' });
  });

  it('an explicitly confirmed unlimited budget (maxDispatches: null) never denies on dispatch count', () => {
    const budget: CoordinationBudget = { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' };
    expect(reserveDispatch(budget, { dispatchesUsed: 10_000 })).toEqual({ ok: true });
  });

  it('denies at the cap: the caller must write a denied ledger row and create no dispatch row', () => {
    const budget: CoordinationBudget = { maxDispatches: 5 };
    const usage: BudgetUsage = { dispatchesUsed: 5 };
    const decision = reserveDispatch(budget, usage);
    expect(decision).toEqual({ ok: false, reason: 'max_dispatches' });
    // The pure decision alone is what tells the caller not to create a
    // dispatch row; budget.ts itself never touches a row.
  });

  it('spend on success: recordSpend advances dispatchesUsed and other counters independently', () => {
    const after = recordSpend(ZERO_USAGE, { dispatchesUsed: 1 });
    expect(after).toEqual({ dispatchesUsed: 1, tokensUsed: 0, costMicrosUsed: 0, wallMinutesUsed: 0 });
    const again = recordSpend(after, { dispatchesUsed: 1, tokensUsed: 1200, costMicrosUsed: 4000 });
    expect(again).toEqual({ dispatchesUsed: 2, tokensUsed: 1200, costMicrosUsed: 4000, wallMinutesUsed: 0 });
  });

  it('secondary caps deny independently of the primary one when set', () => {
    const budget: CoordinationBudget = { maxDispatches: 100, maxTokens: 1000, maxCostMicros: 5000, maxWallMinutes: 60 };
    expect(reserveDispatch(budget, { dispatchesUsed: 1, tokensUsed: 1000 })).toEqual({ ok: false, reason: 'max_tokens' });
    expect(reserveDispatch(budget, { dispatchesUsed: 1, costMicrosUsed: 5000 })).toEqual({ ok: false, reason: 'max_cost' });
    expect(reserveDispatch(budget, { dispatchesUsed: 1, wallMinutesUsed: 60 })).toEqual({ ok: false, reason: 'max_wall_minutes' });
  });

  it('cap-hit-mid-run suspends, resume-after-raise: raising the cap re-opens dispatch with the same usage', () => {
    const usage: BudgetUsage = { dispatchesUsed: 5 };
    const exhausted: CoordinationBudget = { maxDispatches: 5 };
    const hit = reserveDispatch(exhausted, usage);
    expect(hit.ok).toBe(false); // the run must be suspended by the caller on this signal
    const raised: CoordinationBudget = { maxDispatches: 10 };
    // Same usage, no work redone, just a higher cap: dispatch can resume.
    expect(reserveDispatch(raised, usage)).toEqual({ ok: true });
    // Previously accounted spend is untouched by raising the cap.
    expect(usage.dispatchesUsed).toBe(5);
  });
});
