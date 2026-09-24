import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeTempDir, removeDir } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

const COORDINATION_TABLES = [
  'coordination_run',
  'coordination_task',
  'coordination_task_dep',
  'coordination_dispatch',
  'coordination_message',
  'coordination_ask',
  'coordination_cost_reservations',
  'coordination_cost_ledger',
];

describe.each(ENGINES)('coordination schema (v12) on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver;
  let repo: LatteRepository;

  beforeEach(async () => {
    dir = makeTempDir();
    const opened = await openDriver(path.join(dir, 'latte.db'), engine);
    driver = opened.driver;
    repo = new LatteRepository(driver);
    repo.migrate();
  });

  afterEach(() => {
    try { repo.close(); } catch { /* closed */ }
    removeDir(dir);
  });

  it('bumps schema to 12 and creates all 7 coordination tables', () => {
    expect(SCHEMA_VERSION).toBe('14');
    expect(repo.getMeta('schema_version')).toBe('14');
    for (const table of COORDINATION_TABLES) {
      expect(driver.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table])?.name).toBe(table);
    }
  });

  it('is idempotent: migrating an already-migrated database does not throw and does not duplicate rows', () => {
    expect(() => repo.migrate()).not.toThrow();
    expect(() => repo.migrate()).not.toThrow();
    expect(repo.getMeta('schema_version')).toBe('14');
    // No ALTER is needed for v12: every coordination column ships in the initial
    // CREATE TABLE, so a second migrate() must not have grown any column list.
    const runColumns = driver.all<{ name: string }>("SELECT name FROM pragma_table_info('coordination_run')").map((c) => c.name);
    expect(runColumns.sort()).toEqual(
      ['budget_json', 'coordinator_member_id', 'created_at', 'id', 'plan_approved_at', 'plan_json', 'status', 'suspend_reason', 'updated_at', 'work_id'].sort(),
    );
  });

  it('enforces one active run per work with a partial unique index, but allows a new run once the old one is done', () => {
    repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    driver.run(
      "INSERT INTO coordination_run(id, work_id, status, budget_json, created_at, updated_at) VALUES (?, ?, 'planning', '{}', ?, ?)",
      ['crn_1', 'wrk_1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    expect(() =>
      driver.run(
        "INSERT INTO coordination_run(id, work_id, status, budget_json, created_at, updated_at) VALUES (?, ?, 'running', '{}', ?, ?)",
        ['crn_2', 'wrk_1', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z'],
      ),
    ).toThrow();
    driver.run("UPDATE coordination_run SET status = 'done' WHERE id = 'crn_1'");
    expect(() =>
      driver.run(
        "INSERT INTO coordination_run(id, work_id, status, budget_json, created_at, updated_at) VALUES (?, ?, 'planning', '{}', ?, ?)",
        ['crn_3', 'wrk_1', '2026-01-01T00:02:00.000Z', '2026-01-01T00:02:00.000Z'],
      ),
    ).not.toThrow();
  });

  it('keeps the coordination cost ledger immutable via triggers, mirroring the learning ledger', () => {
    repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    driver.run(
      "INSERT INTO coordination_run(id, work_id, status, budget_json, created_at, updated_at) VALUES (?, ?, 'running', '{}', ?, ?)",
      ['crn_1', 'wrk_1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    driver.run(
      "INSERT INTO coordination_cost_ledger(id, run_id, reservation_id, kind, dispatches, cost_micros, detail_json, created_at) VALUES (?, ?, NULL, 'spend', 1, 0, '{}', ?)",
      ['cld_1', 'crn_1', '2026-01-01T00:00:00.000Z'],
    );
    expect(() => driver.run("UPDATE coordination_cost_ledger SET kind = 'denied' WHERE id = 'cld_1'")).toThrow(/immutable/);
    expect(() => driver.run("DELETE FROM coordination_cost_ledger WHERE id = 'cld_1'")).toThrow(/immutable|retained/);
  });
});
