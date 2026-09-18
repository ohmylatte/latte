import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

// Spec: "Handoff Unaffected Outside an Active Run" + "acceptHandoff Bridges to
// a Task During an Active Run". `acceptHandoffAsTask` is the new backend
// method (task 3.15); it re-enters the same dispatch choke point
// `latte_dispatch` uses, so a task minted this way can also land as a
// `pending_approval` gate under manual authority.

describe('acceptHandoffAsTask: the handoff-to-coordination bridge', () => {
  let b: TestBackend;
  let workId: string;
  let brandId: string;
  let dir: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    brandId = brand.id;
    dir = path.join(b.dir, 'brands', brandId, 'works', workId);
    fakeCoordinationHub(b, [] as FakeTeamMember[]);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // task 8.1: this file drives startCoordinationRun through the real IPC surface
  });
  afterEach(() => b.cleanup());

  function writeHandoff(fileName: string, roleId: string, request: string) {
    fs.writeFileSync(path.join(dir, fileName), `---\npara: ${roleId}\n---\n${request}\n`);
  }

  it('is a no-op with no active run: the handoff stays exactly as listHandoffs/dismissHandoff already behave', async () => {
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');
    const before = await b.service.listHandoffs(workId);
    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    expect(result).toEqual({ bridged: false, task: null });
    // Untouched: still there, unconsumed, exactly like before this change.
    expect(await b.service.listHandoffs(workId)).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'para-strategist.md'))).toBe(true);
  });

  it('mints a coordination_task and dismisses the handoff during an active run', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await b.service.startCoordinationRun(workId);
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    expect(result.bridged).toBe(true);
    expect(result.task).toMatchObject({ roleId: 'strategist', spec: 'Draft the Q3 brief.' });

    const tasks = b.repo.listCoordinationTasks(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].spec).toBe('Draft the Q3 brief.');
    // Auto authority: dispatched immediately through the same choke point.
    expect(tasks[0].status).toBe('dispatched');

    // Consumed: the file is gone and no longer listed.
    expect(fs.existsSync(path.join(dir, 'para-strategist.md'))).toBe(false);
    expect(await b.service.listHandoffs(workId)).toEqual([]);
  });

  it('under manual authority, the bridged task creates a dispatch gate instead of starting immediately', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'manual');
    const run = await b.service.startCoordinationRun(workId);
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');

    await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    const gates = await b.service.listCoordinationGates(run.id);
    expect(gates).toHaveLength(1);
    expect(gates[0].kind).toBe('dispatch');
    expect(b.hub.send).not.toHaveBeenCalled();
  });

  it('throws when the named handoff is no longer in the folder', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.startCoordinationRun(workId);
    await expect(b.service.acceptHandoffAsTask(workId, 'para-ghost.md')).rejects.toThrow(/ya no está/);
  });

  // Task 3.19 — the safety line's "close" half. Zero `tools.ts`/MCP anywhere
  // in this test: start, dispatch-request, gate approval AND settlement all
  // go through `LatteService`/IPC alone, proving a human can drive a full
  // coordination run end to end without a single MCP-connected worker.
  it('closes the full run loop via IPC alone: handoff -> gate approval -> manual settlement -> done, zero MCP', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'manual');
    const run = await b.service.startCoordinationRun(workId);
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');

    const bridged = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    expect(bridged.bridged).toBe(true);
    const taskId = bridged.task!.id;

    const gates = await b.service.listCoordinationGates(run.id);
    expect(gates).toHaveLength(1);
    await b.service.resolveCoordinationGate(gates[0].id, 'approve');
    expect(b.hub.send).toHaveBeenCalledTimes(1);

    // No MCP, no tools.ts: the human reads the worker's own chat and closes
    // the dispatch directly over IPC.
    const settled = await b.service.settleCoordinationDispatch(taskId, 'succeeded', 'Brief drafted, read from the chat');
    expect(settled.status).toBe('done');

    const tasks = b.repo.listCoordinationTasks(run.id);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
  });
});
