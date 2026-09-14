import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import { makeTempDir, removeDir } from './helpers';

const HASH = 'ab'.repeat(32);
const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];

describe.each(ENGINES)('branding schema on %s', (engine) => {
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

  it(`bumps schema to ${SCHEMA_VERSION} and creates branding tables`, () => {
    expect(SCHEMA_VERSION).toBe('8');
    expect(repo.getMeta('schema_version')).toBe('8');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_kit_versions'")?.name).toBe('brand_kit_versions');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='work_brand_policies'")?.name).toBe('work_brand_policies');
    expect(driver.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agency_profile_versions'")?.name).toBe('agency_profile_versions');
  });

  it('keeps kit versions immutable via triggers', () => {
    seedBrandAndWork(repo);
    insertApprovedKit(repo, 'kit_one', 'brd_one');
    expect(() => driver.run('UPDATE brand_kit_versions SET rules_text = ? WHERE kit_id = ?', ['hacked', 'kit_one'])).toThrow(/immutable/);
    expect(() => driver.run('DELETE FROM brand_kit_versions WHERE kit_id = ?', ['kit_one'])).toThrow(/immutable/);
    expect(() => driver.run('UPDATE brand_kit_assets SET usable = 0 WHERE kit_id = ?', ['kit_one'])).toThrow(/immutable/);
  });

  it('refuses to delete a brand that still has kits (no CASCADE)', () => {
    seedBrandAndWork(repo);
    insertApprovedKit(repo, 'kit_one', 'brd_one');
    expect(() => driver.run('DELETE FROM brands WHERE id = ?', ['brd_one'])).toThrow();
    expect(repo.getBrand('brd_one').id).toBe('brd_one');
  });

  it('CAS of heads: second writer with the same expected version loses', () => {
    seedBrandAndWork(repo);
    insertApprovedKit(repo, 'kit_one', 'brd_one', 1);
    repo.branding.insertKitVersion({
      kitId: 'kit_one',
      version: 2,
      ownerKind: 'brand',
      ownerBrandId: 'brd_one',
      hash: HASH,
      approved: true,
      permitsAgencySignature: false,
      manifestJson: '{}',
      rulesText: 'v2',
      createdAt: '2026-01-02T00:00:00.000Z',
      assets: [],
    });
    repo.branding.casHead('kit_one', 'brand', 'brd_one', 1, 2);
    expect(() => repo.branding.casHead('kit_one', 'brand', 'brd_one', 1, 3)).toThrow(/VERSION_CONFLICT|head/);
  });

  it('rolls back a failed branding transaction on this engine', () => {
    seedBrandAndWork(repo);
    expect(() =>
      repo.transaction(() => {
        insertApprovedKit(repo, 'kit_one', 'brd_one');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.branding.approvedKitForBrand('brd_one')).toBeNull();
  });

  it('enforces foreign keys for policies', () => {
    expect(() =>
      driver.run(
        `INSERT INTO work_brand_policies(work_id, brand_id, revision, identity, signature, allow_neutral, allow_agency_signature, updated_at)
         VALUES (?, ?, 1, 'neutral', 'none', 1, 0, ?)`,
        ['wrk_ghost', 'brd_ghost', '2026-01-01T00:00:00.000Z'],
      ),
    ).toThrow();
  });
});

function seedBrandAndWork(repo: LatteRepository): void {
  repo.insertBrand({ id: 'brd_one', name: 'One', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  repo.insertWork({ id: 'wrk_a', brandId: 'brd_one', title: 'A', brief: '', folder: null, updatedAt: '2026-01-03T00:00:00.000Z' });
}

function insertApprovedKit(repo: LatteRepository, kitId: string, brandId: string, version = 1): void {
  repo.branding.insertKitVersion({
    kitId,
    version,
    ownerKind: 'brand',
    ownerBrandId: brandId,
    hash: HASH,
    approved: true,
    permitsAgencySignature: false,
    manifestJson: '{}',
    rulesText: 'rules',
    createdAt: '2026-01-01T00:00:00.000Z',
    assets: [{ assetId: 'logo', hash: HASH, kind: 'logo', required: true, usable: true, relativePath: 'assets/logo.png' }],
  });
  if (version === 1) repo.branding.casHead(kitId, 'brand', brandId, 0, 1);
}
