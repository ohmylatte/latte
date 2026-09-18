import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CoordinationActiveRunSummary, CoordinationAuthorityMode, CoordinationBudget, CoordinationEvent, CoordinationGateView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationRunView, CoordinatorGrant } from '../shared/contracts';

/**
 * `useCoordination(workId)` (autonomous-coordination Phase 7 task 7.11):
 * finally wires Phase 2's three `DecisionsView` props to real IPC data, and
 * the run/gates/log/support/activeRuns surfaces built across Phases 3 and
 * 6. Renders no JSX of its own — `renderHook` needs jsdom (a wrapper
 * component still mounts), so this lives in `.dom.test.tsx` per the
 * project's strict-DOM-suffix rule even though nothing here touches the
 * DOM directly.
 */

const mocks = vi.hoisted(() => ({
  getCoordinationAuthority: vi.fn<(workId: string) => Promise<CoordinationAuthorityMode>>(),
  getCoordinationBudget: vi.fn<(workId: string) => Promise<CoordinationBudget | null>>(),
  getCoordinatorGrant: vi.fn<(workId: string) => Promise<CoordinatorGrant>>(),
  coordinationRuntimeSupport: vi.fn<(workId: string) => Promise<CoordinationMemberSupport[]>>(),
  getCoordinationRun: vi.fn<(workId: string) => Promise<CoordinationRunView | null>>(),
  listCoordinationGates: vi.fn<(runId: string) => Promise<CoordinationGateView[]>>(),
  listCoordinationLog: vi.fn<(runId: string) => Promise<CoordinationLogEntryView[]>>(),
  listActiveCoordinationRuns: vi.fn<() => Promise<CoordinationActiveRunSummary[]>>(),
  resolveCoordinationGate: vi.fn(),
  answerCoordinationAsk: vi.fn(),
  settleCoordinationDispatch: vi.fn(),
  pauseCoordinationRun: vi.fn(),
  onCoordinationEvent: vi.fn<(cb: (event: CoordinationEvent) => void) => () => void>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { useCoordination } = await import('./useCoordination');

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, planApproved: true, suspendReason: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});

let coordinationEventCallback: ((event: CoordinationEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCoordinationAuthority.mockResolvedValue('manual');
  mocks.getCoordinationBudget.mockResolvedValue(null);
  mocks.getCoordinatorGrant.mockResolvedValue(null);
  mocks.coordinationRuntimeSupport.mockResolvedValue([]);
  mocks.getCoordinationRun.mockResolvedValue(null);
  mocks.listCoordinationGates.mockResolvedValue([]);
  mocks.listCoordinationLog.mockResolvedValue([]);
  mocks.listActiveCoordinationRuns.mockResolvedValue([]);
  mocks.resolveCoordinationGate.mockResolvedValue(run());
  mocks.answerCoordinationAsk.mockResolvedValue({ id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '', answer: 'Sí', deadlineAt: '', answeredAt: '', createdAt: '' });
  mocks.settleCoordinationDispatch.mockResolvedValue({ id: 'task1', runId: 'run1', roleId: 'strategist', spec: '', status: 'done', attempts: 1, resultSummary: 'Listo' });
  mocks.pauseCoordinationRun.mockResolvedValue(run());
  mocks.onCoordinationEvent.mockImplementation((cb) => { coordinationEventCallback = cb; return () => { coordinationEventCallback = null; }; });
});

describe('useCoordination(workId): no Work open', () => {
  it('defaults everything to a safe, honest shape and fetches no per-work data', async () => {
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.authority).toBe('manual'));
    expect(result.current.budget).toBeNull();
    expect(result.current.coordinatorGrant).toBeNull();
    expect(result.current.run).toBeNull();
    expect(result.current.gates).toEqual([]);
    expect(result.current.log).toEqual([]);
    expect(result.current.support).toEqual([]);
    expect(mocks.getCoordinationAuthority).not.toHaveBeenCalled();
    expect(mocks.getCoordinationRun).not.toHaveBeenCalled();
  });

  it('still fetches the GLOBAL active-runs strip even with no Work open', async () => {
    mocks.listActiveCoordinationRuns.mockResolvedValue([{ runId: 'r1', workId: 'w9', workTitle: 'Otro', brandId: 'b9', brandName: 'Otra marca', status: 'running', dispatchesUsed: 1, maxDispatches: 5, pendingGates: 0 }]);
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.activeRuns).toHaveLength(1));
  });
});

describe('useCoordination(workId): a Work is open', () => {
  it('fetches authority, budget, coordinator grant and runtime support for that Work', async () => {
    mocks.getCoordinationAuthority.mockResolvedValue('plan');
    mocks.getCoordinationBudget.mockResolvedValue({ maxDispatches: 20, unlimitedConfirmedAt: null });
    mocks.getCoordinatorGrant.mockResolvedValue('m1');
    mocks.coordinationRuntimeSupport.mockResolvedValue([{ memberId: 'm1', canPropose: true, memoryInjected: true, reason: null }]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.authority).toBe('plan'));
    expect(result.current.budget).toEqual({ maxDispatches: 20, unlimitedConfirmedAt: null });
    expect(result.current.coordinatorGrant).toBe('m1');
    expect(result.current.support).toEqual([{ memberId: 'm1', canPropose: true, memoryInjected: true, reason: null }]);
    expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w1');
  });

  it('when a run exists, also fetches its gates and its bitácora', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationGates.mockResolvedValue([{ id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z' }]);
    mocks.listCoordinationLog.mockResolvedValue([{ id: 'l1', taskId: 't1', memberId: 'm1', status: 'running', createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', settledAt: null }]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.run).not.toBeNull());
    expect(mocks.listCoordinationGates).toHaveBeenCalledWith('run1');
    expect(mocks.listCoordinationLog).toHaveBeenCalledWith('run1');
    expect(result.current.gates).toHaveLength(1);
    expect(result.current.log).toHaveLength(1);
  });

  it('when there is no run, gates and log stay empty without ever calling listCoordinationGates', async () => {
    mocks.getCoordinationRun.mockResolvedValue(null);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationRun).toHaveBeenCalled());
    expect(result.current.gates).toEqual([]);
    expect(result.current.log).toEqual([]);
    expect(mocks.listCoordinationGates).not.toHaveBeenCalled();
  });

  it('re-fetches for a new Work when workId changes', async () => {
    const { rerender } = renderHook(({ workId }) => useCoordination(workId), { initialProps: { workId: 'w1' as string | null } });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w1'));
    rerender({ workId: 'w2' });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w2'));
  });
});

describe('useCoordination(workId): actions surface the existing IPC verbs, never reinvent them', () => {
  it('resolveGate calls resolveCoordinationGate with the exact same verb every other gate uses', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.resolveGate('g1', 'approve', 'edited-json');
    expect(mocks.resolveCoordinationGate).toHaveBeenCalledWith('g1', 'approve', 'edited-json');
  });

  it('answerAsk calls answerCoordinationAsk', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.answerAsk('ask1', 'Sí');
    expect(mocks.answerCoordinationAsk).toHaveBeenCalledWith('ask1', 'Sí');
  });

  it('settleDispatch surfaces settleCoordinationDispatch (task 3.19) — it does not reinvent it', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.settleDispatch('task1', 'succeeded', 'Listo');
    expect(mocks.settleCoordinationDispatch).toHaveBeenCalledWith('task1', 'succeeded', 'Listo');
  });

  it('pauseRun calls pauseCoordinationRun and applies the returned run', async () => {
    mocks.pauseCoordinationRun.mockResolvedValue(run({ status: 'suspended' }));
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.pauseRun('run1');
    await waitFor(() => expect(result.current.run?.status).toBe('suspended'));
    expect(mocks.pauseCoordinationRun).toHaveBeenCalledWith('run1');
  });
});

describe('useCoordination(workId): the event subscription', () => {
  it('refreshes the GLOBAL strip on ANY event, even one for a Brand the person is not viewing', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'other-brand', workId: 'other-work', runId: null });
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(2));
  });

  it('does NOT re-fetch the open Work\'s own data for an event about a different Work', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'other-brand', workId: 'other-work', runId: null });
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(2));
    expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1);
  });

  it('DOES re-fetch the open Work\'s own data for an event about that same Work', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'b1', workId: 'w1', runId: null });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(2));
  });
});
