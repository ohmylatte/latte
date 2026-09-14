import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import type { BrandContextSnapshot } from '../../shared/generationContracts';
import { makeBackend, type TestBackend } from './helpers';

function workDirOf(b: TestBackend, brandId: string, workId: string): string {
  return path.join(b.dir, 'brands', brandId, 'works', workId);
}

describe('LatteService.prepareGeneration', () => {
  let b: TestBackend;

  beforeEach(async () => {
    b = await makeBackend();
  });

  afterEach(() => b.cleanup());

  it('refuses the call when the installation flag is off and does not write a receipt', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    await expect(b.service.prepareGeneration(work.id)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.listGenerationsForWork(work.id)).toEqual([]);
    const agents = fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('Pinned generation context');
  });

  it('with the flag on, pins a receipt, copies context.json, and refreshes instructions', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    b.repo.setMeta(FEATURE_KEYS.generation, FEATURE_ON);
    const out = await b.service.prepareGeneration(work.id);
    expect(out.pending).toBe(false);
    expect(out.instructionsRefreshed).toBe(true);
    expect(out.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.repo.getGeneration(out.generationId)?.brandId).toBe(brand.id);
    const pin = path.join(workDirOf(b, brand.id, work.id), '.latte', 'generations', out.generationId, 'context.json');
    expect(fs.existsSync(pin)).toBe(true);
    const agents = fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Pinned generation context');
    expect(agents).toContain(out.generationId);
  });

  it('keeps the receipt when members are live and does not rewrite CLAUDE.md/AGENTS.md', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    b.repo.setMeta(FEATURE_KEYS.generation, FEATURE_ON);
    const before = fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8');
    vi.spyOn(b.hub, 'liveMemberCount').mockReturnValue(3);
    const out = await b.service.prepareGeneration(work.id);
    expect(out.pending).toBe(true);
    expect(out.instructionsRefreshed).toBe(false);
    expect(b.repo.getGeneration(out.generationId)).not.toBeNull();
    const after = fs.readFileSync(path.join(workDirOf(b, brand.id, work.id), 'AGENTS.md'), 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain(out.generationId);
  });

  it('refuses a malformed workId after the flag is on, and always stores Work.brandId from the repository', async () => {
    b.repo.setMeta(FEATURE_KEYS.generation, FEATURE_ON);
    await expect(b.service.prepareGeneration('not an id')).rejects.toThrow(/Invalid/);
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    const out = await b.service.prepareGeneration(work.id);
    expect(b.repo.getGeneration(out.generationId)?.brandId).toBe(work.brandId);
  });

  it('pins assets from the injected brand port, not BrandingService', async () => {
    const ids = { workId: '', brandId: '' };
    const fakeBytes = Buffer.from('PORT-BYTES');
    b.cleanup();
    b = await makeBackend({
      brandContext: {
        resolveForWork: (workId) => {
          const snap: BrandContextSnapshot = {
            schemaVersion: 1,
            workId: ids.workId || workId,
            brandId: ids.brandId,
            choice: { identity: 'brand', signature: 'none' },
            identity: 'brand',
            sourceKit: { kitId: 'kit_fake', version: 1, hash: 'ab'.repeat(32) },
            rules: 'x',
            assets: [{ id: 'from-port', hash: 'cd'.repeat(32) }],
            signature: null,
            warnings: [],
          };
          return snap;
        },
        pinAssets: () => [{ id: 'from-port', origin: 'identity', bytes: fakeBytes }],
      },
    });
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Pieza');
    ids.workId = work.id;
    ids.brandId = brand.id;
    b.repo.setMeta(FEATURE_KEYS.generation, FEATURE_ON);
    const out = await b.service.prepareGeneration(work.id);
    const pinned = path.join(workDirOf(b, brand.id, work.id), '.latte', 'generations', out.generationId, 'assets', 'identity', 'from-port');
    expect(fs.readFileSync(pinned, 'utf8')).toBe('PORT-BYTES');
  });
});
