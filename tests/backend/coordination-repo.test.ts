import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { makeTempDir, removeDir } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

describe.each(ENGINES)('coordination repository CRUD on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver;
  let repo: LatteRepository;

  beforeEach(async () => {
    dir = makeTempDir();
    const opened = await openDriver(path.join(dir, 'latte.db'), engine);
    driver = opened.driver;
    repo = new LatteRepository(driver);
    repo.migrate();
    repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  afterEach(() => {
    try { repo.close(); } catch { /* closed */ }
    removeDir(dir);
  });

  it('inserts and reads back a run, finds it as the active one, and updates its status', () => {
    const run = repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'planning', coordinatorMemberId: 'mem_1',
      budgetJson: '{"maxDispatches":10}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(run.status).toBe('planning');
    expect(repo.getCoordinationRun('crn_1')).toMatchObject({ id: 'crn_1', workId: 'wrk_1', budgetJson: '{"maxDispatches":10}' });
    expect(repo.findActiveCoordinationRun('wrk_1')?.id).toBe('crn_1');

    const updated = repo.updateCoordinationRunStatus('crn_1', 'suspended', '2026-01-01T01:00:00.000Z', 'max_dispatches');
    expect(updated.status).toBe('suspended');
    expect(updated.suspendReason).toBe('max_dispatches');
    // Still "active" (suspended is a live state).
    expect(repo.findActiveCoordinationRun('wrk_1')?.id).toBe('crn_1');

    repo.updateCoordinationRunStatus('crn_1', 'done', '2026-01-01T02:00:00.000Z');
    expect(repo.findActiveCoordinationRun('wrk_1')).toBeNull();
  });

  it('the one-active-run-per-work index rejects a second concurrent insert at the repository layer too', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(() => repo.insertCoordinationRun({
      id: 'crn_2', workId: 'wrk_1', status: 'planning', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:01:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
    })).toThrow();
  });

  it('creates tasks, updates their status, and lists them for a run', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const task = repo.insertCoordinationTask({
      id: 'ctk_1', runId: 'crn_1', seq: 1, roleId: 'strategist', spec: 'Draft the brief',
      status: 'pending', depth: 0, attempts: 0, inPlan: true, assignedMemberId: null,
      resultSummary: null, resultFilesJson: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(task.inPlan).toBe(true);
    expect(repo.getCoordinationTask('ctk_1')).toMatchObject({ id: 'ctk_1', status: 'pending', inPlan: true });

    const updated = repo.updateCoordinationTask('ctk_1', { status: 'ready' }, '2026-01-01T00:05:00.000Z');
    expect(updated.status).toBe('ready');

    const dispatched = repo.updateCoordinationTask('ctk_1', {
      status: 'dispatched', assignedMemberId: 'mem_2', attempts: 1,
    }, '2026-01-01T00:06:00.000Z');
    expect(dispatched).toMatchObject({ status: 'dispatched', assignedMemberId: 'mem_2', attempts: 1 });

    expect(repo.listCoordinationTasks('crn_1').map((t) => t.id)).toEqual(['ctk_1']);
  });

  it('stores dependency edges separately and cascades their deletion with the task', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    for (const id of ['ctk_a', 'ctk_b']) {
      repo.insertCoordinationTask({
        id, runId: 'crn_1', seq: 1, roleId: 'strategist', spec: id, status: 'pending', depth: 0,
        attempts: 0, inPlan: false, assignedMemberId: null, resultSummary: null, resultFilesJson: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    repo.insertCoordinationTaskDep('ctk_b', 'ctk_a');
    expect(repo.listCoordinationTaskDeps('crn_1')).toEqual([{ taskId: 'ctk_b', dependsOnId: 'ctk_a' }]);
  });

  it('creates a dispatch, lists it, and updates it through to a settled state', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repo.insertCoordinationTask({
      id: 'ctk_1', runId: 'crn_1', seq: 1, roleId: 'strategist', spec: 'x', status: 'ready', depth: 0,
      attempts: 0, inPlan: false, assignedMemberId: null, resultSummary: null, resultFilesJson: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const dispatch = repo.insertCoordinationDispatch({
      id: 'cdp_1', runId: 'crn_1', taskId: 'ctk_1', memberId: 'mem_1', attempt: 1,
      status: 'dispatched', gateId: null, prompt: 'do it', outcome: null, summary: null,
      filesJson: null, reservationId: null, createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z', settledAt: null,
    });
    expect(dispatch.status).toBe('dispatched');
    expect(repo.listCoordinationDispatches('crn_1').map((d) => d.id)).toEqual(['cdp_1']);

    const settled = repo.updateCoordinationDispatch('cdp_1', {
      status: 'reported', outcome: 'succeeded', summary: 'done', settledAt: '2026-01-01T00:10:00.000Z',
    });
    expect(settled).toMatchObject({ status: 'reported', outcome: 'succeeded', summary: 'done' });
    expect(repo.getCoordinationDispatch('cdp_1').settledAt).toBe('2026-01-01T00:10:00.000Z');
  });

  it('mailbox: undelivered messages list in FIFO order and stop appearing once delivered', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repo.insertCoordinationMessage({
      id: 'cms_1', runId: 'crn_1', toMemberId: 'mem_1', fromMemberId: null, kind: 'task', body: 'A',
      deliveredAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    });
    repo.insertCoordinationMessage({
      id: 'cms_2', runId: 'crn_1', toMemberId: 'mem_1', fromMemberId: null, kind: 'task', body: 'B',
      deliveredAt: null, createdAt: '2026-01-01T00:00:01.000Z',
    });
    expect(repo.listUndeliveredCoordinationMessages('crn_1', 'mem_1').map((m) => m.body)).toEqual(['A', 'B']);
    repo.markCoordinationMessageDelivered('cms_1', '2026-01-01T00:00:02.000Z');
    expect(repo.listUndeliveredCoordinationMessages('crn_1', 'mem_1').map((m) => m.body)).toEqual(['B']);
  });

  it('asks: listed while open, answered removes them from the open list', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repo.insertCoordinationAsk({
      id: 'cak_1', runId: 'crn_1', taskId: null, memberId: 'mem_1', question: '¿Tono?',
      answer: null, deadlineAt: '2026-01-01T00:30:00.000Z', answeredAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(repo.listOpenCoordinationAsks('crn_1').map((a) => a.id)).toEqual(['cak_1']);
    const answered = repo.answerCoordinationAsk('cak_1', 'Cercano', '2026-01-01T00:10:00.000Z');
    expect(answered).toMatchObject({ answer: 'Cercano', answeredAt: '2026-01-01T00:10:00.000Z' });
    expect(repo.listOpenCoordinationAsks('crn_1')).toEqual([]);
  });

  it('cost reservations settle, and the ledger is append-only via triggers', () => {
    repo.insertCoordinationRun({
      id: 'crn_1', workId: 'wrk_1', status: 'running', coordinatorMemberId: null,
      budgetJson: '{}', planJson: null, planApprovedAt: null, suspendReason: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repo.insertCoordinationCostReservation({
      id: 'crs_1', runId: 'crn_1', dispatchId: null, memberId: 'mem_1', runtime: 'claude', model: 'sonnet',
      maxInputTokens: 8000, maxOutputTokens: 2000, maxCostMicros: 5000, state: 'reserved',
      usageJson: null, createdAt: '2026-01-01T00:00:00.000Z', settledAt: null,
    });
    expect(repo.getCoordinationCostReservation('crs_1')).toMatchObject({ state: 'reserved' });
    repo.settleCoordinationCostReservation('crs_1', '{"inputTokens":100}', '2026-01-01T00:05:00.000Z', false);
    expect(repo.getCoordinationCostReservation('crs_1')).toMatchObject({ state: 'settled', usageJson: '{"inputTokens":100}' });

    repo.insertCoordinationCostLedger({
      id: 'cld_1', runId: 'crn_1', reservationId: 'crs_1', kind: 'spend', dispatches: 1,
      costMicros: 1200, detailJson: '{}', createdAt: '2026-01-01T00:05:00.000Z',
    });
    expect(() => driver.run("UPDATE coordination_cost_ledger SET kind = 'denied' WHERE id = 'cld_1'")).toThrow(/immutable/);
    expect(() => driver.run("DELETE FROM coordination_cost_ledger WHERE id = 'cld_1'")).toThrow(/immutable|retained/);
  });

  it('a missing run/task/dispatch/ask throws NotFoundError, matching the rest of the repository', () => {
    expect(() => repo.getCoordinationRun('crn_ghost')).toThrow(/not found/i);
    expect(() => repo.getCoordinationTask('ctk_ghost')).toThrow(/not found/i);
    expect(() => repo.getCoordinationDispatch('cdp_ghost')).toThrow(/not found/i);
    expect(() => repo.getCoordinationAsk('cak_ghost')).toThrow(/not found/i);
  });
});
