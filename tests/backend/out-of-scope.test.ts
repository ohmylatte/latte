import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../electron/bootstrap';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';

describe.each<DriverPreference>(['node:sqlite', 'sql.js'])('Out-of-scope column on an existing database (%s)', (engine) => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('adds it without touching rows, and without a version an older build would refuse', async () => {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), engine);
    // The works table as schema 6 left it: no out_of_scope_stages (nor outcome columns).
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec('CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT \'\', dir TEXT, updated_at TEXT NOT NULL)');
    driver.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '6']);
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z']);

    const repo = new LatteRepository(driver);
    try {
      repo.migrate();
      // Idempotent: a second run must not throw on the already-added column.
      repo.migrate();
      expect(repo.getWork('wrk_1')).toEqual({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '# Viejo', folder: null, expectedOutput: null, resultPath: null, outOfScopeStages: [], updatedAt: '2026-01-02T00:00:00.000Z' });
      expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
      // The out-of-scope column adds no schema version of its own.
      expect(SCHEMA_VERSION).toBe('12');
      // What an older build still does after this one ran: insert naming only the columns it knows.
      driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['wrk_2', 'brd_1', 'Dos', '', null, '2026-01-03T00:00:00.000Z']);
      expect(repo.getWork('wrk_2')).toMatchObject({ outOfScopeStages: [] });
      expect(repo.setWorkOutOfScopeStages('wrk_1', ['discovery'], '2026-01-04T00:00:00.000Z')).toMatchObject({ outOfScopeStages: ['discovery'], brief: '# Viejo' });
    } finally {
      repo.close();
    }
  });
});

describe('toggleOutOfScopeStage', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('marks and unmarks a stage reversibly, defaulting to empty', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    expect(work.outOfScopeStages ?? []).toEqual([]);
    expect((await b.service.toggleOutOfScopeStage(work.id, 'discovery')).outOfScopeStages).toEqual(['discovery']);
    expect((await b.service.toggleOutOfScopeStage(work.id, 'discovery')).outOfScopeStages).toEqual([]);
  });

  it('rejects a token that is not a funnel stage', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    await expect(b.service.toggleOutOfScopeStage(work.id, 'propuesta' as never)).rejects.toThrow();
    await expect(b.service.toggleOutOfScopeStage(work.id, 'unclassified' as never)).rejects.toThrow();
  });

  it('persists across a restart', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    await b.service.toggleOutOfScopeStage(work.id, 'retention');
    b.service.shutdown();

    const again = await createBackend({ dataDir: b.dir, version: '0.0.0-test', emit: () => {}, chooseExportPath: async () => null, seedDemo: false });
    try {
      expect((await again.service.listWorks(brand.id))[0].outOfScopeStages).toEqual(['retention']);
    } finally {
      again.service.shutdown();
    }
  });
});
