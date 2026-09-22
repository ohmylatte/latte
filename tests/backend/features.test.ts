import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, FEATURE_OFF, FEATURE_ON, featureEnabled, isFeatureOn, readFeatureFlags, requireFeature } from '../../electron/core/features';
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

  // 1.2.0 (R1): coordination sigue usando ESTE mecanismo genérico, pero su
  // default se dio vuelta. La fila ausente ya no quiere decir "apagada": la
  // coordinación es cómo trabaja el equipo, así que una instalación nueva la
  // trae puesta y lo que hay que poder hacer es APAGARLA.
  it('carries a coordination key too, ON by default -- the only feature that is', () => {
    expect(FEATURE_KEYS.coordination).toBe('feature:coordination');
    const meta: Record<string, string> = {};
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(true);
    expect(() => requireFeature((k) => meta[k] ?? null, 'coordination')).not.toThrow();
    expect(readFeatureFlags((k) => meta[k] ?? null)).toEqual({
      generation: false,
      brandKits: false,
      learning: false,
      coordination: true,
    });
  });

  // El `off` explícito es el interruptor de emergencia: se respeta, y se
  // respeta POR SER EXPLÍCITO. Borrar la fila vuelve al default, que es on.
  it('an explicit off is respected, and deleting the row goes back to the default', () => {
    const meta: Record<string, string> = { [FEATURE_KEYS.coordination]: FEATURE_OFF };
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(false);
    try {
      requireFeature((k) => meta[k] ?? null, 'coordination');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'FEATURE_DISABLED' });
    }
    expect(readFeatureFlags((k) => meta[k] ?? null).coordination).toBe(false);
    meta[FEATURE_KEYS.coordination] = FEATURE_ON;
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(true);
    delete meta[FEATURE_KEYS.coordination];
    expect(featureEnabled((k) => meta[k] ?? null, 'coordination')).toBe(true);
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
