import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { LatteError, NotFoundError } from '../../electron/core/errors';
import { makeBackend, type TestBackend } from './helpers';

function workDirOf(b: TestBackend, brandId: string, workId: string): string {
  return path.join(b.dir, 'brands', brandId, 'works', workId);
}

describe('archiving a brand is a reversible soft delete', () => {
  let b: TestBackend;

  beforeEach(async () => {
    b = await makeBackend();
  });
  afterEach(() => b.cleanup());

  it('hides archived brands from listBrands, keeps them findable, and restores without rewriting disk', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Campaña');
    const brandDir = path.join(b.dir, 'brands', brand.id);
    const brief = path.join(workDirOf(b, brand.id, work.id), 'brief.md');
    expect(fs.existsSync(brandDir)).toBe(true);
    expect(fs.readFileSync(brief, 'utf8')).toBe('# Campaña\n\n');

    const archived = await b.service.archiveBrand(brand.id);
    expect(archived.archivedAt).toMatch(/^\d{4}-/);
    expect((await b.service.listBrands()).map((x) => x.id)).not.toContain(brand.id);
    expect((await b.service.listArchivedBrands()).map((x) => x.id)).toEqual([brand.id]);
    expect((await b.service.listArchivedBrands())[0].archivedAt).toBe(archived.archivedAt);

    const found = b.repo.getBrand(brand.id);
    expect(found.archivedAt).toBe(archived.archivedAt);
    expect((await b.service.listWorks(brand.id)).map((w) => w.id)).toEqual([work.id]);
    expect(b.repo.getWork(work.id).title).toBe('Campaña');
    expect(fs.existsSync(brandDir)).toBe(true);
    expect(fs.readFileSync(brief, 'utf8')).toBe('# Campaña\n\n');

    const again = await b.service.archiveBrand(brand.id);
    expect(again.archivedAt).toBe(archived.archivedAt);

    const restored = await b.service.restoreBrand(brand.id);
    expect(restored.archivedAt).toBeNull();
    expect((await b.service.listBrands()).map((x) => x.id)).toEqual([brand.id]);
    expect(await b.service.listArchivedBrands()).toEqual([]);
    expect(fs.readFileSync(brief, 'utf8')).toBe('# Campaña\n\n');

    const idle = await b.service.restoreBrand(brand.id);
    expect(idle.archivedAt).toBeNull();
  });

  it('validates the id and refuses a missing brand', async () => {
    await expect(b.service.archiveBrand('not an id')).rejects.toThrow(/Invalid/);
    await expect(b.service.restoreBrand('brd_missing_brand_xx')).rejects.toBeInstanceOf(NotFoundError);
    await expect(b.service.archiveBrand('brd_missing_brand_xx')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses createWork on an archived brand with BRAND_ARCHIVED', async () => {
    const brand = await b.service.createBrand('Casa');
    await b.service.archiveBrand(brand.id);
    await expect(b.service.createWork(brand.id, 'Nuevo')).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    expect(await b.service.listWorks(brand.id)).toEqual([]);
    await b.service.restoreBrand(brand.id);
    expect((await b.service.createWork(brand.id, 'Nuevo')).title).toBe('Nuevo');
  });

  it('refuses prepareGeneration on an archived brand before writing a receipt or pin', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    b.repo.setMeta(FEATURE_KEYS.generation, FEATURE_ON);
    await b.service.archiveBrand(brand.id);
    const agentsBefore = fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8');
    await expect(b.service.prepareGeneration(work.id)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    expect(b.repo.listGenerationsForWork(work.id)).toEqual([]);
    expect(fs.existsSync(path.join(workDirOf(b, brand.id, work.id), '.latte', 'generations'))).toBe(false);
    expect(fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8')).toBe(agentsBefore);
  });

  it('refuses kit import, publish and work choice on an archived brand before touching the folder picker', async () => {
    let picked = 0;
    b.cleanup();
    b = await makeBackend({ chooseFolder: async () => { picked += 1; return null; } });
    b.repo.setMeta(FEATURE_KEYS.brandKits, FEATURE_ON);
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    await b.service.archiveBrand(brand.id);
    await expect(b.service.importBrandKit(work.id)).rejects.toBeInstanceOf(LatteError);
    await expect(b.service.importBrandKit(work.id)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.publishBrandKit(work.id, 0)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.setWorkBrandChoice(work.id, { identity: 'brand', signature: 'none' }, 0)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    expect(picked).toBe(0);
  });
});
