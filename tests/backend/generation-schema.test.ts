import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashGenerationContext } from '../../electron/generation/canon';
import type { SqlDriver } from '../../electron/storage/driver';
import { openDriver, type DriverPreference } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { SCHEMA_VERSION } from '../../electron/storage/schema';
import type { GenerationContext, GenerationReceipt } from '../../shared/generationContracts';
import { makeTempDir, removeDir } from './helpers';

const ENGINES: DriverPreference[] = ['node:sqlite', 'sql.js'];
const H = (ch: string) => ch.repeat(64);

function seed(repo: LatteRepository): void {
  repo.insertBrand({ id: 'brd_one', name: 'One', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  repo.insertWork({ id: 'wrk_a', brandId: 'brd_one', title: 'A', brief: '', folder: null, updatedAt: '2026-01-03T00:00:00.000Z' });
}

function receipt(over: Partial<GenerationReceipt> = {}): GenerationReceipt {
  const context: GenerationContext = {
    schemaVersion: 1,
    workId: 'wrk_a',
    brandId: 'brd_one',
    brandContext: null,
    skillRefs: [],
  };
  const sealed = hashGenerationContext(context);
  return {
    id: 'gen_aaaaaaaaaaaaaaaaaaaa',
    workId: 'wrk_a',
    brandId: 'brd_one',
    context: sealed.context,
    contextJson: sealed.json,
    contextHash: sealed.hash,
    createdAt: '2026-09-14T00:00:00.000Z',
    ...over,
  };
}

describe.each(ENGINES)('generation schema on %s', (engine) => {
  let dir: string;
  let driver: SqlDriver;
  let repo: LatteRepository;

  beforeEach(async () => {
    dir = makeTempDir();
    const opened = await openDriver(path.join(dir, 'latte.db'), engine);
    driver = opened.driver;
    repo = new LatteRepository(driver);
    repo.migrate();
    seed(repo);
  });

  afterEach(() => {
    try { repo.close(); } catch { /* closed */ }
    removeDir(dir);
  });

  it('bumps SCHEMA_VERSION and creates generation tables', () => {
    expect(SCHEMA_VERSION).toBe('14');
    expect(repo.getMeta('schema_version')).toBe('14');
    const inserted = repo.insertGeneration(receipt());
    expect(inserted.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.getGeneration(inserted.id)?.workId).toBe('wrk_a');
    expect(repo.listGenerationsForWork('wrk_a')).toHaveLength(1);
  });

  it('lists the last inserted receipt first when created_at ties', () => {
    const first = receipt({ id: 'gen_zzzzzzzzzzzzzzzzzzzz' });
    const second = receipt({ id: 'gen_aaaaaaaaaaaaaaaaaaaa' });
    repo.insertGeneration(first);
    repo.insertGeneration(second);
    expect(repo.listGenerationsForWork('wrk_a').map((r) => r.id)).toEqual([
      'gen_aaaaaaaaaaaaaaaaaaaa',
      'gen_zzzzzzzzzzzzzzzzzzzz',
    ]);
  });

  it('refuses UPDATE and DELETE on the immutable receipt', () => {
    repo.insertGeneration(receipt());
    expect(() => driver.run('UPDATE generations SET context_json = ? WHERE id = ?', ['hacked', 'gen_aaaaaaaaaaaaaaaaaaaa'])).toThrow(/immutable/);
    expect(() => driver.run('DELETE FROM generations WHERE id = ?', ['gen_aaaaaaaaaaaaaaaaaaaa'])).toThrow(/immutable/);
    expect(repo.getGeneration('gen_aaaaaaaaaaaaaaaaaaaa')?.contextJson).not.toBe('hacked');
  });

  it('is idempotent for the same id+content and conflicts on a different payload', () => {
    const first = receipt();
    expect(repo.insertGeneration(first).contextHash).toBe(first.contextHash);
    expect(repo.insertGeneration(first).id).toBe(first.id);
    const other = hashGenerationContext({ ...first.context, workId: 'wrk_a' });
    // Same context; tweak hash to force a mismatch.
    expect(() => repo.insertGeneration({ ...first, contextHash: H('9'), contextJson: other.json })).toThrow(/different content/);
  });

  it('enforces foreign keys without cascading a brand or work delete through the receipt', () => {
    repo.insertGeneration(receipt());
    expect(() =>
      repo.insertGeneration({
        ...receipt(),
        id: 'gen_bbbbbbbbbbbbbbbbbbbb',
        workId: 'wrk_ghost',
      }),
    ).toThrow();
    expect(() => driver.run('DELETE FROM works WHERE id = ?', ['wrk_a'])).toThrow();
    expect(() => driver.run('DELETE FROM brands WHERE id = ?', ['brd_one'])).toThrow();
    expect(repo.getGeneration('gen_aaaaaaaaaaaaaaaaaaaa')).not.toBeNull();
  });

  it('rolls back a failed transaction so the receipt never lands', () => {
    expect(() =>
      repo.transaction(() => {
        repo.insertGeneration(receipt());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.getGeneration('gen_aaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('keeps delivery_evidence and artifact_checks off the receipt and immutable', () => {
    repo.insertGeneration(receipt());
    const evidence = repo.insertDeliveryEvidence({
      id: 'gev_aaaaaaaaaaaaaaaaaaaa',
      generationId: 'gen_aaaaaaaaaaaaaaaaaaaa',
      runtime: 'claude',
      chatId: null,
      projectedAt: '2026-09-14T00:01:00.000Z',
      filesWritten: ['.latte/generations/gen_aaaaaaaaaaaaaaaaaaaa/context.json'],
    });
    const check = repo.insertArtifactCheck({
      id: 'gck_aaaaaaaaaaaaaaaaaaaa',
      generationId: 'gen_aaaaaaaaaaaaaaaaaaaa',
      relativePath: 'entregables/pieza.pdf',
      fileHash: H('0'),
      checks: [{ name: 'exists', passed: false, note: 'not generated yet' }],
      brandCompliant: null,
      createdAt: '2026-09-14T00:02:00.000Z',
    });
    expect(repo.listDeliveryEvidence('gen_aaaaaaaaaaaaaaaaaaaa')).toEqual([evidence]);
    expect(repo.listArtifactChecks('gen_aaaaaaaaaaaaaaaaaaaa')[0].checks[0].passed).toBe(false);
    expect(() => driver.run('UPDATE delivery_evidence SET runtime = ? WHERE id = ?', ['x', evidence.id])).toThrow(/immutable/);
    expect(() => driver.run('DELETE FROM artifact_checks WHERE id = ?', [check.id])).toThrow(/immutable/);
  });
});
