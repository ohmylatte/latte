import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_BRAND_KITS } from '../../electron/branding/types';
import { LEARNING_CAPTURE_KEY, LEARNING_FEATURE_KEY } from '../../electron/learning/types';
import { GENERATION_ENABLED_META } from '../../shared/generationContracts';
import type { CandidatePayload } from '../../electron/learning/types';
import { makeBackend, makeTempDir, MINIMAL_PNG, removeDir, type TestBackend } from '../backend/helpers';

function samplePayload(overrides: Partial<CandidatePayload> = {}): CandidatePayload {
  return {
    name: 'informe-mensual-comprobable',
    description: 'Crear informes mensuales con métricas autorizadas y trazables; no usar para estimar datos faltantes.',
    markdown: [
      '# Informe mensual comprobable',
      '## Entradas',
      'Período, métricas autorizadas y contexto de marca resuelto.',
      '## Procedimiento',
      '1. Comprobar período y procedencia de cada métrica.',
      '2. Separar observaciones, inferencias y datos faltantes.',
      '3. Redactar usando el kit recibido; no incorporar identidades del historial.',
      '## Verificación',
      'Cada cifra tiene fuente autorizada; no se inventaron valores ni branding.',
      '## Límites',
      'Detener la sección que requiera datos inexistentes; indicar qué falta.',
    ].join('\n'),
    targetSkillId: null,
    base: null,
    ...overrides,
  };
}

function writeKit(root: string, rules = 'Usar el logo sin deformar.'): string {
  const dir = path.join(root, 'brand');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'logo.png'), MINIMAL_PNG);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    permitsAgencySignature: false,
    assets: [{ id: 'logo-primary', kind: 'logo', relativePath: 'assets/logo.png', required: true }],
  }));
  fs.writeFileSync(path.join(dir, 'brand.md'), rules);
  return dir;
}

describe('wired generation ports', () => {
  const backends: TestBackend[] = [];
  const extras: string[] = [];
  afterEach(() => {
    for (const b of backends.splice(0)) b.cleanup();
    for (const dir of extras.splice(0)) removeDir(dir);
  });

  it('pins a sealed kit and approved learned skill; later edits do not mutate the receipt; brand B is isolated', async () => {
    const kitDir = makeTempDir('kit-int-');
    extras.push(kitDir);
    const brandFolder = writeKit(kitDir);
    const b = await makeBackend({ chooseFolder: async () => brandFolder });
    backends.push(b);
    b.repo.setMeta(FEATURE_BRAND_KITS, 'on');
    b.repo.setMeta(LEARNING_FEATURE_KEY, 'on');
    b.repo.setMeta(LEARNING_CAPTURE_KEY, 'manual');
    b.repo.setMeta(GENERATION_ENABLED_META, 'on');

    const alpha = await b.service.createBrand('Alpha');
    const beta = await b.service.createBrand('Beta');
    const workA = await b.service.createWork(alpha.id, 'A');
    const workB = await b.service.createWork(beta.id, 'B');

    await b.service.importBrandKit(workA.id);
    const published = await b.service.publishBrandKit(workA.id, 0);
    await b.service.setWorkBrandChoice(workA.id, { identity: 'brand', signature: 'none' }, 0);

    const candidate = b.service.learningService.captureExplicit({
      workId: workA.id, sourceKey: 'human:v1', payload: samplePayload(),
    });
    await b.service.approveSkillCandidate({
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      expectedHash: candidate.contentHash,
      requestId: 'req-int-v1',
    });

    const first = await b.service.prepareGeneration(workA.id);
    const receipt = b.repo.getGeneration(first.generationId);
    expect(receipt).not.toBeNull();
    expect(receipt!.context.brandId).toBe(alpha.id);
    expect(receipt!.context.brandContext).not.toBeNull();
    expect(receipt!.context.brandContext?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt!.context.skillRefs).toHaveLength(1);
    expect(receipt!.context.skillRefs[0]?.skillId).toBe(candidate.skillId);
    expect(receipt!.context.skillRefs[0]?.version).toBe(1);
    const pinnedHash = receipt!.contextHash;
    const pinnedSkillHash = receipt!.context.skillRefs[0]!.hash;

    fs.writeFileSync(path.join(brandFolder, 'brand.md'), 'Usar el logo sin deformar. Paleta v2.');
    await b.service.importBrandKit(workA.id);
    const publishedV2 = await b.service.publishBrandKit(workA.id, 1);
    expect(publishedV2.version).toBe(2);
    expect(publishedV2.hash).not.toBe(published.hash);

    const patch = b.service.learningService.captureExplicit({
      workId: workA.id,
      sourceKey: 'human:v2',
      payload: samplePayload({
        markdown: samplePayload().markdown + '\nPaso extra de verificación humana.',
        targetSkillId: candidate.skillId,
        base: { version: 1, hash: pinnedSkillHash },
      }),
    });
    await b.service.approveSkillCandidate({
      candidateId: patch.id,
      expectedRevision: patch.revision,
      expectedHash: patch.contentHash,
      requestId: 'req-int-v2',
    });

    expect(b.repo.getGeneration(first.generationId)?.contextHash).toBe(pinnedHash);
    expect(b.repo.getGeneration(first.generationId)?.context.skillRefs[0]?.version).toBe(1);

    const second = await b.service.prepareGeneration(workA.id);
    expect(second.generationId).not.toBe(first.generationId);
    const latest = b.repo.getGeneration(second.generationId)!;
    expect(latest.context.skillRefs[0]?.version).toBe(2);
    expect(latest.contextHash).not.toBe(pinnedHash);

    const other = await b.service.prepareGeneration(workB.id);
    const isolated = b.repo.getGeneration(other.generationId)!;
    expect(isolated.context.brandId).toBe(beta.id);
    expect(isolated.context.skillRefs).toEqual([]);
    expect(isolated.context.brandContext).toBeNull();
  });

  it('with generation.enabled off, prepareGeneration refuses and refreshInstructions matches shipped behaviour', async () => {
    const b = await makeBackend();
    backends.push(b);
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const before = b.files.readDocument(brand.id, work.id, 'AGENTS.md').content;
    await expect(b.service.prepareGeneration(work.id)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.listGenerationsForWork(work.id)).toEqual([]);
    expect(b.files.readDocument(brand.id, work.id, 'AGENTS.md').content).toBe(before);
    expect(before).not.toContain('Pinned generation context');
  });
});
