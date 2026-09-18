import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON, featureEnabled, isFeatureOn, readFeatureFlags, requireFeature } from '../../electron/core/features';
import { makeBackend, type TestBackend } from './helpers';

const payload = {
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
};

describe('feature flags helper', () => {
  it('treats only the value on as enabled', () => {
    expect(isFeatureOn('on')).toBe(true);
    expect(isFeatureOn('1')).toBe(false);
    expect(isFeatureOn(null)).toBe(false);
    expect(FEATURE_KEYS.generation).toBe('feature:generation');
    expect(FEATURE_KEYS.brandKits).toBe('feature:brand-kits');
    expect(FEATURE_KEYS.learning).toBe('feature:learning');
    expect(FEATURE_ON).toBe('on');
    const meta: Record<string, string> = {};
    expect(featureEnabled((k) => meta[k] ?? null, 'generation')).toBe(false);
    expect(() => requireFeature((k) => meta[k] ?? null, 'learning')).toThrow(/FEATURE_DISABLED|disabled/i);
  });

  // Task 8.1 (rollout gate): coordination reuses this SAME generic mechanism
  // -- no flag existed for it before this task. Off by default, like every
  // other feature ("no secrets").
  it('carries a coordination key too, off by default like every other feature', () => {
    expect(FEATURE_KEYS.coordination).toBe('feature:coordination');
    const meta: Record<string, string> = {};
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(false);
    expect(() => requireFeature((k) => meta[k] ?? null, 'coordination')).toThrow(/./);
    try {
      requireFeature((k) => meta[k] ?? null, 'coordination');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'FEATURE_DISABLED' });
    }
    meta[FEATURE_KEYS.coordination] = FEATURE_ON;
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(true);
    expect(readFeatureFlags((k) => meta[k] ?? null)).toEqual({
      generation: false,
      brandKits: false,
      learning: false,
      coordination: true,
    });
  });
});

describe('public entry points stay inert when their feature is off', () => {
  let b: TestBackend;
  beforeEach(async () => { b = await makeBackend(); });
  afterEach(() => b.cleanup());

  it('branding IPC does not write kit rows when off', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    await expect(b.service.readAgencyProfile()).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    await expect(b.service.setWorkBrandChoice(work.id, { identity: 'neutral', signature: 'none' }, 0))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.branding.approvedKitForBrand(brand.id)).toBeNull();
  });

  it('learning does not persist a candidate when off', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    expect(() => b.service.learningService.persistValidatedCandidate({
      scopeKey: `brand:${brand.id}`,
      payload,
      evidenceJson: '[]',
      createdAt: '2026-01-01T00:00:00.000Z',
    })).toThrow(/FEATURE_DISABLED|disabled/i);
    expect(() => b.service.learningService.captureExplicit({
      workId: work.id, sourceKey: 'human:off', payload,
    })).toThrow(/FEATURE_DISABLED|disabled/i);
    expect(b.service.learningService.listInbox()).toEqual([]);
  });

  it('prepareGeneration does not write a receipt when generation is off', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    await expect(b.service.prepareGeneration(work.id)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(b.repo.listGenerationsForWork(work.id)).toEqual([]);
  });
});
