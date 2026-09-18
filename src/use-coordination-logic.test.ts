import { describe, expect, it } from 'vitest';
import { shouldRefreshWork } from './coordination-event-routing';
import type { CoordinationEvent } from '../shared/contracts';

/**
 * The pure decision `useCoordination` (task 7.11) makes on every
 * `latte:coordination-event`: does this event concern the Work currently
 * open. The GLOBAL strip always refreshes (that decision needs no
 * function — it is unconditional); this is only the per-work half.
 */
describe('shouldRefreshWork: does this coordination event concern the open Work', () => {
  const event = (patch: Partial<CoordinationEvent> = {}): CoordinationEvent => ({ brandId: 'b1', workId: 'w1', runId: 'run1', ...patch });

  it('is false when no Work is open at all', () => {
    expect(shouldRefreshWork(event({ workId: 'w1' }), null)).toBe(false);
  });

  it('is true when the event is for the open Work', () => {
    expect(shouldRefreshWork(event({ workId: 'w1' }), 'w1')).toBe(true);
  });

  it('is false for a different Work — this is exactly what lets the global strip refresh for a Brand the person is not viewing, without also re-fetching the wrong Work\'s data', () => {
    expect(shouldRefreshWork(event({ workId: 'other' }), 'w1')).toBe(false);
  });
});
