import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../electron/bootstrap';
import { IncompatibleSchemaError, isNewerSchema, prepareForMigration, pruneBackups } from '../../electron/storage/backup';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeBackend, makeTempDir, removeDir } from './helpers';

describe('Updating the app must not put the data at risk', () => {
  let dir: string;
  let dbFile: string;
  const backupsIn = (root: string) => {
    try { return fs.readdirSync(path.join(root, 'backups')).sort(); } catch { return []; }
  };

  beforeEach(() => {
    dir = makeTempDir('latte-backup-');
    dbFile = path.join(dir, 'latte.db');
  });
  afterEach(() => removeDir(dir));

  it('takes no backup of a database that does not exist yet', () => {
    expect(prepareForMigration(dbFile, null, '6')).toBeNull();
    expect(backupsIn(dir)).toEqual([]);
  });

  it('takes no backup when the schema is already current', () => {
    fs.writeFileSync(dbFile, 'pretend-sqlite');
    expect(prepareForMigration(dbFile, '6', '6')).toBeNull();
    expect(backupsIn(dir)).toEqual([]);
  });

  it('copies the database before schema 8 is migrated to the current version', () => {
    fs.writeFileSync(dbFile, 'datos-schema-8');
    const backup = prepareForMigration(dbFile, '8', SCHEMA_VERSION, { now: () => new Date('2026-09-14T12:00:00Z') });
    expect(SCHEMA_VERSION).toBe('10');
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v8-20260914T120000.db'));
    expect(fs.readFileSync(backup!, 'utf8')).toBe('datos-schema-8');
    expect(fs.readFileSync(dbFile, 'utf8')).toBe('datos-schema-8');
  });

  it('copies the database before an older schema is migrated', () => {
    fs.writeFileSync(dbFile, 'los-datos-del-usuario');
    const backup = prepareForMigration(dbFile, '5', '6', { now: () => new Date('2026-09-07T14:25:30Z') });
    expect(backup).toBe(path.join(dir, 'backups', 'latte-v5-20260907T142530.db'));
    expect(fs.readFileSync(backup!, 'utf8')).toBe('los-datos-del-usuario');
    // The original is untouched: the backup is a copy, never a move.
    expect(fs.readFileSync(dbFile, 'utf8')).toBe('los-datos-del-usuario');
  });

  it('takes the write-ahead log with it, because the last commits live there', () => {
    fs.writeFileSync(dbFile, 'main');
    fs.writeFileSync(`${dbFile}-wal`, 'lo-ultimo-que-guardaste');
    const backup = prepareForMigration(dbFile, '5', '6', { now: () => new Date('2026-09-07T14:25:30Z') });
    expect(fs.readFileSync(`${backup}-wal`, 'utf8')).toBe('lo-ultimo-que-guardaste');
  });

  it('refuses a database written by a newer Latte instead of migrating it backwards', () => {
    fs.writeFileSync(dbFile, 'datos-de-una-version-nueva');
    expect(() => prepareForMigration(dbFile, '9', '6')).toThrow(IncompatibleSchemaError);
    // Refusing early means nothing was copied and, above all, nothing was changed.
    expect(backupsIn(dir)).toEqual([]);
    expect(fs.readFileSync(dbFile, 'utf8')).toBe('datos-de-una-version-nueva');
  });

  it('never locks the user out over a marker it cannot read', () => {
    expect(isNewerSchema('experimental', '6')).toBe(false);
    fs.writeFileSync(dbFile, 'datos');
    // Unknown is not newer: it is backed up and migrated like any older schema.
    expect(prepareForMigration(dbFile, 'experimental', '6')).not.toBeNull();
  });

  it('keeps the newest backups and drops the rest', () => {
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const stamp of ['20260101T000000', '20260102T000000', '20260103T000000', '20260104T000000']) {
      fs.writeFileSync(path.join(backupDir, `latte-v5-${stamp}.db`), stamp);
    }
    fs.writeFileSync(path.join(backupDir, 'no-es-un-backup.txt'), 'x');

    expect(pruneBackups(backupDir, 2)).toEqual(['latte-v5-20260101T000000.db', 'latte-v5-20260102T000000.db']);
    expect(backupsIn(dir)).toEqual(['latte-v5-20260103T000000.db', 'latte-v5-20260104T000000.db', 'no-es-un-backup.txt']);
  });

  it('retains the latest backup across schema 9 to 10 and prunes its older WAL pair', () => {
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const older = 'latte-v9-20260101T000000.db';
    const latest = 'latte-v10-20260201T000000.db';
    for (const name of [older, latest]) {
      fs.writeFileSync(path.join(backupDir, name), 'database');
      fs.writeFileSync(path.join(backupDir, `${name}-wal`), 'wal');
    }
    expect(pruneBackups(backupDir, 1)).toEqual([older]);
    expect(backupsIn(dir)).toEqual([latest, `${latest}-wal`]);
  });
});

describe('The schema version on disk', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir('latte-schema-'); });
  afterEach(() => removeDir(dir));

  it('is null before the first migration and readable after it', async () => {
    const file = path.join(dir, 'latte.db');
    const { driver } = await openDriver(file, 'auto');
    const repo = new LatteRepository(driver);
    expect(repo.storedSchemaVersion()).toBeNull();
    repo.migrate();
    expect(repo.storedSchemaVersion()).toBe(SCHEMA_VERSION);
    repo.close();
  });
});

describe('Opening a workspace from a newer Latte', () => {
  it('stops the start instead of degrading the data', async () => {
    const backend = await makeBackend();
    const dir = backend.dir;
    try {
      backend.repo.setMeta('schema_version', '99');
      backend.service.shutdown();

      await expect(createBackend({
        dataDir: dir,
        version: '0.0.0-test',
        emit: () => {},
        chooseExportPath: async () => null,
        seedDemo: false,
      })).rejects.toThrow(IncompatibleSchemaError);
      // Refusing must not corrupt what is there: the marker is still 99.
      const { driver } = await openDriver(path.join(dir, 'latte.db'), 'auto');
      const repo = new LatteRepository(driver);
      expect(repo.storedSchemaVersion()).toBe('99');
      repo.close();
    } finally {
      removeDir(dir);
    }
  });
});
