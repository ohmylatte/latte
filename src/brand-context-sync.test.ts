import { describe, expect, it } from 'vitest';
import { resolveRemoteBrandContext } from './brand-context-sync';

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
