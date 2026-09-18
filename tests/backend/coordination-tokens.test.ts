import { describe, expect, it } from 'vitest';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';

// Task 6.1: the mint/verify/revoke registry only — no server, no run/role
// resolution here (that is `CoordinationEngine.resolveGrant`, task 6.2). A
// token binds `{workId, memberId}` ONLY: no `runId`, no `role` stored.

describe('CoordinationTokenRegistry — mint / verify / revoke', () => {
  it('mint returns a 64-hex token bound to {workId, memberId} only, no runId, no role stored', () => {
    const registry = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
    const token = registry.mint('wrk_a', 'mem_a');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const entry = registry.verify(token);
    expect(entry).not.toBeNull();
    // Exact key set: workId, memberId, mintedAt — never runId or role.
    expect(Object.keys(entry!).sort()).toEqual(['memberId', 'mintedAt', 'workId']);
    expect(entry).toEqual({ workId: 'wrk_a', memberId: 'mem_a', mintedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('an unknown token resolves to null', () => {
    const registry = new CoordinationTokenRegistry();
    expect(registry.verify('deadbeef'.repeat(8))).toBeNull();
  });

  it('an empty or malformed token resolves to null rather than throwing', () => {
    const registry = new CoordinationTokenRegistry();
    expect(registry.verify('')).toBeNull();
    // @ts-expect-error -- deliberately supplying a non-string to prove it degrades safely
    expect(registry.verify(undefined)).toBeNull();
  });

  it('a revoked token resolves to null', () => {
    const registry = new CoordinationTokenRegistry();
    const token = registry.mint('wrk_a', 'mem_a');
    registry.revoke(token);
    expect(registry.verify(token)).toBeNull();
  });

  it('a second mint for the same member replaces the first: the old token stops verifying, the new one works', () => {
    const registry = new CoordinationTokenRegistry();
    const first = registry.mint('wrk_a', 'mem_a');
    const second = registry.mint('wrk_a', 'mem_a');

    expect(second).not.toBe(first);
    expect(registry.verify(first)).toBeNull();
    expect(registry.verify(second)).toEqual(expect.objectContaining({ workId: 'wrk_a', memberId: 'mem_a' }));
  });

  it('does not confuse tokens across two different members of the same Work', () => {
    const registry = new CoordinationTokenRegistry();
    const a = registry.mint('wrk_a', 'mem_a');
    const b = registry.mint('wrk_a', 'mem_b');

    expect(registry.verify(a)?.memberId).toBe('mem_a');
    expect(registry.verify(b)?.memberId).toBe('mem_b');
  });

  // Task 6.28: hub wiring revokes by (workId, memberId), not by the token
  // string itself -- the hub knows which member is closing, not its live
  // token, so the registry needs a lookup path from identity to token.
  describe('revokeMember (task 6.28)', () => {
    it('revokes the live token for a (workId, memberId), by identity rather than the token string', () => {
      const registry = new CoordinationTokenRegistry();
      const token = registry.mint('wrk_a', 'mem_a');
      registry.revokeMember('wrk_a', 'mem_a');
      expect(registry.verify(token)).toBeNull();
      expect(registry.size).toBe(0);
    });

    it('is a no-op for a member that was never minted, or already revoked', () => {
      const registry = new CoordinationTokenRegistry();
      expect(() => registry.revokeMember('wrk_a', 'mem_never')).not.toThrow();
      const token = registry.mint('wrk_a', 'mem_a');
      registry.revokeMember('wrk_a', 'mem_a');
      expect(() => registry.revokeMember('wrk_a', 'mem_a')).not.toThrow();
      expect(registry.verify(token)).toBeNull();
    });

    it('never touches a different member of the same Work', () => {
      const registry = new CoordinationTokenRegistry();
      const a = registry.mint('wrk_a', 'mem_a');
      const b = registry.mint('wrk_a', 'mem_b');
      registry.revokeMember('wrk_a', 'mem_a');
      expect(registry.verify(a)).toBeNull();
      expect(registry.verify(b)).not.toBeNull();
    });
  });
});
