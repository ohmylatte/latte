import { describe, expect, it } from 'vitest';
import { brandContextNudge, electBrandContextOwner } from '../../electron/workspace/brandContextNudge';

/**
 * The empty-context nudge is emitted once per BRAND, not once per work.
 *
 * The bug it fixes: three works of the same brand each told their agent to
 * draft the brand context, so three agents asked the human the same questions.
 * The predicate answers "may THIS work carry the draft nudge, and if not, why".
 */

const EMPTY = { context: '', hasPendingProposal: false, hasInheritedMemory: false, workId: 'wrk_a', ownerWorkId: 'wrk_a' };

describe('electBrandContextOwner', () => {
  it('picks the lowest id with an explicit sort, regardless of list order', () => {
    expect(electBrandContextOwner([{ id: 'wrk_c' }, { id: 'wrk_a' }, { id: 'wrk_b' }])).toBe('wrk_a');
    expect(electBrandContextOwner([{ id: 'wrk_a' }, { id: 'wrk_b' }])).toBe('wrk_a');
  });

  it('is stable for an unchanged work set', () => {
    const works = [{ id: 'wrk_z' }, { id: 'wrk_m' }, { id: 'wrk_a' }];
    expect(electBrandContextOwner(works)).toBe(electBrandContextOwner(works));
    expect(electBrandContextOwner(works)).toBe('wrk_a');
  });

  it('has no owner for a brand with no works', () => {
    expect(electBrandContextOwner([])).toBeNull();
  });
});

describe('brandContextNudge', () => {
  it('is full only for the elected work of a brand with nothing written', () => {
    expect(brandContextNudge(EMPTY)).toEqual({ form: 'full', reason: null });
  });

  it('is none when the context already exists', () => {
    expect(brandContextNudge({ ...EMPTY, context: 'Tono cercano' })).toEqual({ form: 'none', reason: 'context-exists' });
    // Even a non-owner, with context written, gets the same honest reason.
    expect(brandContextNudge({ ...EMPTY, context: 'Tono cercano', workId: 'wrk_b' })).toEqual({ form: 'none', reason: 'context-exists' });
  });

  it('is none when a proposal is already pending human review', () => {
    expect(brandContextNudge({ ...EMPTY, hasPendingProposal: true })).toEqual({ form: 'none', reason: 'pending' });
  });

  it('is none when inherited brand memory exists', () => {
    expect(brandContextNudge({ ...EMPTY, hasInheritedMemory: true })).toEqual({ form: 'none', reason: 'inherited' });
  });

  it('is none for a work that is not the elected owner', () => {
    expect(brandContextNudge({ ...EMPTY, workId: 'wrk_b' })).toEqual({ form: 'none', reason: 'owner-elsewhere' });
  });

  it('is none when the brand has no elected owner at all', () => {
    expect(brandContextNudge({ ...EMPTY, ownerWorkId: null })).toEqual({ form: 'none', reason: 'owner-elsewhere' });
  });

  it('prefers the most specific reason: context, then pending, then inherited, then owner', () => {
    expect(brandContextNudge({ ...EMPTY, context: 'x', hasPendingProposal: true, hasInheritedMemory: true, workId: 'wrk_b' }).reason).toBe('context-exists');
    expect(brandContextNudge({ ...EMPTY, hasPendingProposal: true, hasInheritedMemory: true, workId: 'wrk_b' }).reason).toBe('pending');
    expect(brandContextNudge({ ...EMPTY, hasInheritedMemory: true, workId: 'wrk_b' }).reason).toBe('inherited');
  });
});
