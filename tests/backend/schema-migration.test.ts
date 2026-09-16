import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareForMigration } from '../../electron/storage/backup';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeTempDir, removeDir } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

/** Core tables as `upstream/main` schema 7 left them, before additive generation/brand/learning DDL. */
const UPSTREAM_V7 = `
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', dir TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

describe.each(ENGINES)('schema 7 → 8 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v7 file and creates generation, branding and learning tables', async () => {
    dir = makeTempDir(`latte-mig-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '7']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '7', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v7-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe('10');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='generations'")?.name).toBe('generations');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_kit_versions'")?.name).toBe('brand_kit_versions');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'")?.name).toBe('learned_skills');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_evidence'")?.name).toBe('delivery_evidence');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_archives'")?.name).toBe('brand_archives');
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});

describe.each(ENGINES)('schema 8 → 9 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v8 file and creates brand_archives without rewriting brands', async () => {
    dir = makeTempDir(`latte-mig8-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '8']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '8', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v8-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('10');
    expect(SCHEMA_VERSION).toBe('10');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_archives'")?.name).toBe('brand_archives');
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono', archivedAt: null });
    expect(repo.listBrands().map((b) => b.id)).toEqual(['brd_1']);
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});

describe.each(ENGINES)('schema 9 → 10 migration on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver | undefined;
  afterEach(() => {
    try { driver?.close(); } catch { /* closed */ }
    if (dir) removeDir(dir);
  });

  it('backs up the v9 file and creates brand_context_proposals without rewriting brands', async () => {
    dir = makeTempDir(`latte-mig9-${engine.replace(/[^a-z]/g, '')}-`);
    const file = path.join(dir, 'latte.db');
    const opened = await openDriver(file, engine);
    driver = opened.driver;
    driver.exec(UPSTREAM_V7);
    driver.run('INSERT INTO meta(key, value) VALUES (?, ?)', ['schema_version', '9']);
    driver.run('INSERT INTO brands(id, name, context, created_at) VALUES (?, ?, ?, ?)', [
      'brd_1', 'Casa', 'tono', '2026-01-01T00:00:00.000Z',
    ]);
    driver.run('INSERT INTO works(id, brand_id, title, brief, dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
      'wrk_1', 'brd_1', 'Uno', '# Viejo', null, '2026-01-02T00:00:00.000Z',
    ]);

    const backup = prepareForMigration(file, '9', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v9-20260914T120000.db'));
    expect(fs.existsSync(backup!)).toBe(true);

    const repo = new LatteRepository(driver);
    repo.migrate();
    expect(repo.getMeta('schema_version')).toBe('10');
    expect(SCHEMA_VERSION).toBe('10');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_context_proposals'")?.name).toBe('brand_context_proposals');
    expect(driver.all<{ name: string }>('PRAGMA table_info(brand_context_proposals)').map((c) => c.name)).toEqual(expect.arrayContaining(['source_member_id', 'source_role_id', 'source_runtime', 'base_fingerprint']));
    expect(repo.getBrand('brd_1')).toMatchObject({ name: 'Casa', context: 'tono' });
    expect(repo.getWork('wrk_1').title).toBe('Uno');
    repo.close();
    driver = undefined;
  });
});
