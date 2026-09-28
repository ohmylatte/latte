import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIRST_STEP_IDS,
  firstSteps,
  firstStepsProgress,
  isFunnelOpened,
  isFirstStepsClosed,
  markFunnelOpened,
  setFirstStepsClosed,
} from './first-steps';

/**
 * Inicio · Primeros pasos.
 *
 * Los cuatro pasos salen de datos reales; si el dato no está, el paso queda
 * pendiente. Nada acá mira una intención ni cuenta clics: es el mismo estado
 * que ya lee la app (ADN aprobado, trabajos, documentos, Embudo).
 */

const base = { dnaApproved: false, hasWork: false, hasApprovedDocument: false, funnelOpened: false };

const storage = () => {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  });
  return map;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('los cuatro pasos, de los datos', () => {
  it('con nada hecho, los cuatro están pendientes y el orden es el del recorrido', () => {
    const steps = firstSteps(base);
    expect(steps.map((s) => s.id)).toEqual([...FIRST_STEP_IDS]);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(firstStepsProgress(steps)).toEqual({ done: 0, total: 4, complete: false });
  });

  it('cada dato marca SU paso, y sólo ese', () => {
    expect(firstSteps({ ...base, dnaApproved: true }).filter((s) => s.done).map((s) => s.id)).toEqual(['dna']);
    expect(firstSteps({ ...base, hasWork: true }).filter((s) => s.done).map((s) => s.id)).toEqual(['work']);
    expect(firstSteps({ ...base, hasApprovedDocument: true }).filter((s) => s.done).map((s) => s.id)).toEqual(['document']);
    expect(firstSteps({ ...base, funnelOpened: true }).filter((s) => s.done).map((s) => s.id)).toEqual(['funnel']);
  });

  it('cada paso tiene su frase', () => {
    const labels = firstSteps(base).map((s) => s.labelKey);
    expect(labels).toEqual(['firstSteps.dna', 'firstSteps.work', 'firstSteps.document', 'firstSteps.funnel']);
  });

  it('recién con los cuatro el progreso está completo: ahí la tarjeta se va', () => {
    const almost = firstSteps({ ...base, dnaApproved: true, hasWork: true, hasApprovedDocument: true });
    expect(firstStepsProgress(almost).complete).toBe(false);
    const all = firstSteps({ ...base, dnaApproved: true, hasWork: true, hasApprovedDocument: true, funnelOpened: true });
    expect(firstStepsProgress(all)).toEqual({ done: 4, total: 4, complete: true });
  });
});

describe('las preferencias de la tarjeta', () => {
  it('cerrada: se guarda como cualquier otra preferencia de vista', () => {
    const map = storage();
    expect(isFirstStepsClosed()).toBe(false);
    setFirstStepsClosed(true);
    expect(map.get('latte:first-steps-closed')).toBe('1');
    expect(isFirstStepsClosed()).toBe(true);
    setFirstStepsClosed(false);
    expect(isFirstStepsClosed()).toBe(false);
    expect(map.has('latte:first-steps-closed')).toBe(false);
  });

  it('el Embudo se recuerda por marca: el de una marca no es el de otra', () => {
    storage();
    expect(isFunnelOpened('b1')).toBe(false);
    markFunnelOpened('b1');
    expect(isFunnelOpened('b1')).toBe(true);
    expect(isFunnelOpened('b2')).toBe(false);
    expect(isFunnelOpened('')).toBe(false);
  });

  it('una ventana privada no rompe nada: devuelve false y no tira', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    expect(isFirstStepsClosed()).toBe(false);
    expect(isFunnelOpened('b1')).toBe(false);
    expect(() => setFirstStepsClosed(true)).not.toThrow();
    expect(() => markFunnelOpened('b1')).not.toThrow();
  });
});
