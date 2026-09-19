import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';

// Tasks 6.33-6.36: the IPC surface built on top of `CoordinationInjectionPlanner`
// (tested directly in coordination-hub-wiring.test.ts) -- `coordinationRuntimeSupport`,
// `listActiveCoordinationRuns`, and the optional app-wide budget pair. Uses the
// REAL `makeBackend()` wiring (bootstrap.ts attaches a real
// `CoordinationInjectionPlanner` to both `hub` and `service` now), with
// Claude's real resolution faked via `runner` so the planner's eligibility
// checks see an installed version instead of "not found" -- and
// `claude.start` itself spied so no real process ever spawns.

function claudeResolvable(version: string) {
  return fakeRunner((file, args) => {
    if (args[0] === 'claude') return { code: 0, stdout: 'C:\\fake\\claude.exe\r\n' };
    if (file.endsWith('claude.exe') && args[0] === '--version') return { code: 0, stdout: version };
    return { code: 1, stdout: '', stderr: 'not found' };
  });
}

function fakeSession(memberId: string) {
  return { id: memberId, workId: 'wrk_x', provider: 'claude' as const, model: null, accountId: null, label: 'x', resumed: false, roleId: 'strategist', roleName: 'Strategist', historyRecovered: false };
}

describe('LatteService.coordinationRuntimeSupport (task 6.33)', () => {
  let b: TestBackend;
  afterEach(() => b?.cleanup());

  it('reports a below-floor Claude member with claude_below_floor, canPropose false, memoryInjected false', async () => {
    b = await makeBackend({ runner: claudeResolvable('2.0.0') });
    vi.spyOn(b.claude, 'start').mockResolvedValue({ session: fakeSession('mem_x'), runtimeSessionId: '' });
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.addTeamMember(work.id, 'strategist', { runtime: 'claude' });

    const rows = await b.service.coordinationRuntimeSupport(work.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canPropose: false, memoryInjected: false, reason: 'claude_below_floor' });
  });

  it('a Work with NO run anywhere still reports a Claude member above the floor as able to propose (task 6.33/6.29 headline)', async () => {
    b = await makeBackend({ runner: claudeResolvable('2.1.263') });
    // Task 8.1: this headline proves the ON path (coordination eligibility,
    // independent of any run) -- the OFF path is proven separately in
    // coordination-feature-flag.test.ts.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    vi.spyOn(b.claude, 'start').mockResolvedValue({ session: fakeSession('mem_x'), runtimeSessionId: '' });
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.addTeamMember(work.id, 'strategist', { runtime: 'claude' });

    expect(await b.service.getCoordinationRun(work.id)).toBeNull(); // no run exists anywhere for this Work
    const rows = await b.service.coordinationRuntimeSupport(work.id);
    expect(rows[0].canPropose).toBe(true); // Claude has no run gate
    // engram is not resolvable under this test's runner -- the reason names
    // that honestly (memory has its OWN, separate reason) rather than the
    // absence of a run silently hiding it.
    expect(rows[0].reason).toBe('engram_not_installed');
    expect(rows[0].memoryInjected).toBe(false);
  });

  it('with zero members, the row list is simply empty, never a throw', async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    expect(await b.service.coordinationRuntimeSupport(work.id)).toEqual([]);
  });
});

describe('LatteService.listActiveCoordinationRuns (task 6.34)', () => {
  let b: TestBackend;
  afterEach(() => b?.cleanup());

  it('returns one row per active run across every Brand', async () => {
    b = await makeBackend();
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // task 8.1: this test proves the ON path
    const brandA = await b.service.createBrand('Marca A');
    const workA = await b.service.createWork(brandA.id, 'Trabajo A');
    await b.service.setCoordinationBudget(workA.id, { maxDispatches: 5 });
    const runA = await b.service.startCoordinationRun(workA.id);

    const brandB = await b.service.createBrand('Marca B');
    const workB = await b.service.createWork(brandB.id, 'Trabajo B');
    await b.service.setCoordinationBudget(workB.id, { maxDispatches: 3 });
    const runB = await b.service.startCoordinationRun(workB.id);

    const rows = await b.service.listActiveCoordinationRuns();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.runId).sort()).toEqual([runA.id, runB.id].sort());
    const rowA = rows.find((r) => r.runId === runA.id)!;
    expect(rowA).toMatchObject({ workId: workA.id, workTitle: 'Trabajo A', brandId: brandA.id, brandName: 'Marca A', status: 'running', dispatchesUsed: 0, maxDispatches: 5, pendingGates: 0 });
  });

  it('empty when no run is active anywhere', async () => {
    b = await makeBackend();
    expect(await b.service.listActiveCoordinationRuns()).toEqual([]);
  });
});

describe('the latte:coordination-event channel fires from real IPC-driven changes too (task 6.37)', () => {
  let b: TestBackend;
  afterEach(() => b?.cleanup());

  it('startCoordinationRun (through LatteService, not a directly-constructed engine) fires emitCoordination', async () => {
    const emitted: Array<{ brandId: string; workId: string; runId: string | null }> = [];
    b = await makeBackend({ emitCoordination: (event) => emitted.push(event) });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // task 8.1: this test proves the ON path
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    const run = await b.service.startCoordinationRun(work.id);
    expect(emitted).toContainEqual({ brandId: brand.id, workId: work.id, runId: run.id });
  });
});

describe('LatteService.get/setCoordinationGlobalBudget (task 6.35)', () => {
  let b: TestBackend;
  afterEach(() => b?.cleanup());

  it('unset reads back null, and applies no extra cap (never an invented limit)', async () => {
    b = await makeBackend();
    expect(await b.service.getCoordinationGlobalBudget()).toEqual({ state: 'unset' });
  });

  it('round-trips a set value, reusing the requireCoordinationBudget validator (no implicit unlimited)', async () => {
    b = await makeBackend();
    const saved = await b.service.setCoordinationGlobalBudget({ maxDispatches: 100 });
    expect(saved?.maxDispatches).toBe(100);
    expect(await b.service.getCoordinationGlobalBudget()).toEqual({ state: 'set', budget: saved });
    // `{maxDispatches: null}` (un ilimitado sin confirmar) sigue siendo un error; pasar `null` a secas es OTRA cosa: borrar el tope.
    await expect(b.service.setCoordinationGlobalBudget({ maxDispatches: null })).rejects.toThrow();
  });
});
