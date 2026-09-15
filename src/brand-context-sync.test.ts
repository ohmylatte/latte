import { describe, expect, it } from 'vitest';
import type { Brand } from '../shared/contracts';
import { applyFetchedBrand, resolveRemoteBrandContext } from './brand-context-sync';

const brand = (id: string, context: string): Brand => ({ id, name: id, context, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null });

describe('resolveRemoteBrandContext', () => {
  it('syncs the editor when the draft is clean', () => {
    expect(resolveRemoteBrandContext({
      draft: 'viejo', persisted: 'nuevo', previousPersisted: 'viejo', dirty: false,
    })).toEqual({ draft: 'nuevo', notice: false });
  });

  it('keeps a dirty draft and asks to notice a newer persisted context', () => {
    expect(resolveRemoteBrandContext({
      draft: 'borrador', persisted: 'nuevo', previousPersisted: 'viejo', dirty: true,
    })).toEqual({ draft: 'borrador', notice: true });
  });

  it('does not notice when a dirty draft matches an unchanged persisted context', () => {
    expect(resolveRemoteBrandContext({
      draft: 'borrador', persisted: 'viejo', previousPersisted: 'viejo', dirty: true,
    })).toEqual({ draft: 'borrador', notice: false });
  });
});

describe('applyFetchedBrand', () => {
  it('does not apply when the selected brand changed during the fetch', () => {
    expect(applyFetchedBrand({
      selectedId: 'brd_new', fetched: brand('brd_old', 'x'), previousPersisted: '', draft: '', dirty: false,
    })).toEqual({ applied: false });
  });

  it('applies and syncs a clean editor for the still-selected brand', () => {
    const fetched = brand('brd_1', 'nuevo');
    expect(applyFetchedBrand({
      selectedId: 'brd_1', fetched, previousPersisted: 'viejo', draft: 'viejo', dirty: false,
    })).toEqual({ applied: true, brand: fetched, draft: 'nuevo', notice: false });
  });

  it('forceContext overwrites a dirty draft after an explicit save', () => {
    const fetched = brand('brd_1', 'guardado');
    expect(applyFetchedBrand({
      selectedId: 'brd_1', fetched, previousPersisted: 'viejo', draft: 'guardado', dirty: true, forceContext: true,
    })).toEqual({ applied: true, brand: fetched, draft: 'guardado', notice: false });
  });
});
