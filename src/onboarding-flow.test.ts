import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Brand, OnboardingDraft } from '../shared/contracts';
import { findWorkType, type Answer } from './work-catalog';
import {
  DEMO_BRAND_IDS,
  GATE_STEPS,
  ONBOARDING_STEPS,
  brandChoices,
  completeOnboarding,
  gateStepFor,
  isDemoBrand,
  declareAssumptions,
  initialState,
  missingRequiredQuestions,
  nextStep,
  previousStep,
  toDraft,
  type OnboardingState,
} from './onboarding-flow';

const t = (key: string) => `t(${key})`;

function baseState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    step: 'connect',
    workTypeId: null,
    answers: {},
    assumptions: [],
    brandId: null,
    usedDemo: false,
    linkFolderRequested: false,
    recommendedRoleId: 'assistant',
    brief: '',
    ...overrides,
  };
}

/**
 * Onboarding 2.0: the walk is TWO persisted screens plus the landing
 * (Conectá tu IA → Traé tu marca → Inicio). `home` never reaches this machine:
 * it is where the gate hands the shell over, not a step it can go back from.
 */
describe('onboarding step machine', () => {
  it('moves forward through the two persisted steps and stays on the last', () => {
    let s = baseState({ step: 'connect' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(s.step);
      s = { ...s, step: nextStep(s) };
    }
    expect(seen).toEqual(['connect', 'brand', 'brand', 'brand']);
  });

  it('moves backward and stays on the first step', () => {
    let s = baseState({ step: 'brand' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(s.step);
      s = { ...s, step: previousStep(s) };
    }
    expect(seen).toEqual(['brand', 'connect', 'connect', 'connect']);
  });

  it('exposes the contract vocabulary unchanged: the persisted steps are the five of always', () => {
    expect(ONBOARDING_STEPS).toEqual(['intent', 'context', 'brand', 'connect', 'prepare']);
    expect(GATE_STEPS).toEqual(['connect', 'brand']);
  });

  /**
   * The contract (`ONBOARDING_STEPS` in shared/contracts.ts) is the backend's
   * and does not change with this walk, so the two visible screens are mapped
   * onto values it already accepts: "Conectá tu IA" keeps `connect` (same
   * meaning as always) and "Traé tu marca" takes `prepare`, the step that has
   * always come AFTER connecting. Only `prepare` can mean "Traé tu marca", so a
   * draft read from disk is never ambiguous.
   */
  it('maps every persisted value onto the new walk without inventing a step', () => {
    for (const legacy of ['intent', 'context', 'brand', 'connect'] as const) {
      expect(gateStepFor(legacy), legacy).toBe('connect');
    }
    expect(gateStepFor('prepare')).toBe('brand');
  });

  it('round-trips state → draft → state through the contract values', () => {
    for (const step of GATE_STEPS) {
      const draft = toDraft(baseState({ step }));
      expect(ONBOARDING_STEPS).toContain(draft.step);
      expect(initialState(draft).step).toBe(step);
    }
  });
});

describe('declareAssumptions', () => {
  it('declares an assumption for each unanswered optional question', () => {
    const campaign = findWorkType('campaign-new')!;
    const answers: Record<string, Answer> = { objetivo: 'Vender' };
    const assumptions = declareAssumptions(campaign, answers, t as never);
    // campaign-new optional questions: audiencia, oferta, canales, restricciones
    expect(assumptions).toEqual([
      't(assumption.audience)',
      't(assumption.offer)',
      't(assumption.channels)',
      't(assumption.constraints)',
    ]);
  });

  it('does not assume answered optional questions and never assumes the required one', () => {
    const campaign = findWorkType('campaign-new')!;
    const answers: Record<string, Answer> = {
      objetivo: 'Vender',
      audiencia: 'Cocineros',
    };
    const assumptions = declareAssumptions(campaign, answers, t as never);
    expect(assumptions).not.toContain('t(assumption.audience)');
    expect(assumptions).not.toContain('t(assumption.objective)');
    expect(assumptions).toContain('t(assumption.offer)');
  });

  it('returns no assumptions for a fully answered work type', () => {
    const report = findWorkType('report-build')!;
    const answers: Record<string, Answer> = {
      audiencia: 'Dirección',
      periodo: 'Q1',
      fuentes: ['ads'],
      indicadores: ['roas'],
      decision: 'Renovar presupuesto',
    };
    expect(declareAssumptions(report, answers, t as never)).toEqual([]);
  });
});

describe('completeOnboarding', () => {
  it('requires a selected work type', () => {
    expect(completeOnboarding(baseState())).toBe(false);
  });

  it('blocks while a required question is unanswered', () => {
    const s = baseState({ workTypeId: 'campaign-new', answers: {} });
    expect(completeOnboarding(s)).toBe(false);
  });

  it('allows completion once every required question is answered', () => {
    const s = baseState({ workTypeId: 'campaign-new', answers: { objetivo: 'Vender' } });
    expect(completeOnboarding(s)).toBe(true);
  });

  it('the free-form type has no required questions and completes immediately', () => {
    const s = baseState({ workTypeId: 'free-form' });
    expect(completeOnboarding(s)).toBe(true);
  });
});

describe('missingRequiredQuestions', () => {
  it('lists the required questions still unanswered, in catalog order', () => {
    const campaign = findWorkType('campaign-new')!;
    expect(missingRequiredQuestions(campaign, {}).map((q) => q.id)).toEqual(['objetivo']);
    expect(missingRequiredQuestions(campaign, { objetivo: 'Vender' })).toEqual([]);
  });

  it('never lists an optional question, answered or not', () => {
    const campaign = findWorkType('campaign-new')!;
    const missing = missingRequiredQuestions(campaign, { audiencia: 'Cocineros' });
    expect(missing.every((q) => q.required)).toBe(true);
    expect(missing.map((q) => q.id)).not.toContain('audiencia');
  });

  it('treats blank text and empty lists as unanswered', () => {
    const report = findWorkType('report-build')!;
    expect(missingRequiredQuestions(report, { audiencia: '   ' }).map((q) => q.id)).toEqual(['audiencia']);
  });

  it('agrees with completeOnboarding: no missing required questions means complete', () => {
    const campaign = findWorkType('campaign-new')!;
    const answers: Record<string, Answer> = { objetivo: 'Vender' };
    const s = baseState({ workTypeId: 'campaign-new', answers });
    expect(missingRequiredQuestions(campaign, answers)).toEqual([]);
    expect(completeOnboarding(s)).toBe(true);
  });
});

describe('draft resumability', () => {
  // `prepare` is where "Traé tu marca" persists (see the mapping above).
  const draft: OnboardingDraft = {
    step: 'prepare',
    workTypeId: 'campaign-new',
    answers: { objetivo: 'Vender', canales: ['instagram', 'email'] },
    assumptions: ['Sigo sin audiencia definida; la confirmamos después.'],
    brandId: null,
    usedDemo: false,
    linkFolderRequested: true,
    recommendedRoleId: 'strategist',
    brief: '## Objetivo\n\nVender\n',
  };

  it('starts fresh when no draft is provided', () => {
    const s = initialState(null);
    expect(s).toEqual(baseState());
  });

  it('resumes at the persisted step with prior answers preserved', () => {
    const s = initialState(draft);
    expect(s.step).toBe('brand');
    expect(s.workTypeId).toBe('campaign-new');
    expect(s.answers).toEqual({ objetivo: 'Vender', canales: ['instagram', 'email'] });
    expect(s.assumptions).toEqual([{ text: 'Sigo sin audiencia definida; la confirmamos después.' }]);
    expect(s.linkFolderRequested).toBe(true);
    expect(s.recommendedRoleId).toBe('strategist');
    expect(s.brief).toBe('## Objetivo\n\nVender\n');
  });

  it('round-trips state → draft → state without loss', () => {
    const s = initialState(draft);
    const back = toDraft(s);
    expect(back).toEqual(draft);
    expect(initialState(back)).toEqual(s);
  });

  it('normalizes a draft written by the old walk: only the summary resumes at "Traé tu marca"', () => {
    // A person who had not connected yet (intent/context/brand) comes back at
    // "Conectá tu IA"; one who had (prepare = the old summary) comes back at
    // "Traé tu marca". Nothing else can be deduced from a stale draft.
    expect(initialState({ ...draft, step: 'intent' }).step).toBe('connect');
    expect(initialState({ ...draft, step: 'context' }).step).toBe('connect');
    expect(initialState({ ...draft, step: 'brand' }).step).toBe('connect');
    expect(initialState({ ...draft, step: 'connect' }).step).toBe('connect');
    expect(initialState({ ...draft, step: 'prepare' }).step).toBe('brand');
  });

  it('falls back to a safe role when the draft has none', () => {
    const s = initialState({ ...draft, recommendedRoleId: '' });
    expect(s.recommendedRoleId).toBe('assistant');
  });
});

/**
 * QA1 · B: EL DEMO NO ES UNA MARCA EXISTENTE.
 *
 * El demo se reconoce por id — el que siembra el escritorio
 * (`electron/services/seed.ts`) y el de la vista previa web
 * (`src/browser-api.ts`) —, nunca por el nombre: una marca real que se llame
 * "Demo Studio" es de la persona.
 */
describe('demo brand vs. user brands', () => {
  const brand = (id: string, name: string, createdAt: string): Brand => ({ id, name, context: '', createdAt, archivedAt: null });
  const demoDesktop = brand('brd_demo_casa_oliva', 'Casa Oliva (demo)', '2026-01-01T00:00:00.000Z');
  const demoPreview = brand('demo', 'Casa Oliva · Ejemplo', '2026-01-01T00:00:00.000Z');

  it('knows the demo ids the desktop seed and the web preview actually use', () => {
    const seed = readFileSync(new URL('../electron/services/seed.ts', import.meta.url), 'utf8');
    const seedId = /export const DEMO_BRAND_ID = '([^']+)'/.exec(seed)?.[1];
    expect(seedId).toBeTruthy();
    expect(DEMO_BRAND_IDS).toContain(seedId);
    const preview = readFileSync(new URL('./browser-api.ts', import.meta.url), 'utf8');
    const previewId = /brands: \[\{ id: '([^']+)'/.exec(preview)?.[1];
    expect(previewId).toBeTruthy();
    expect(DEMO_BRAND_IDS).toContain(previewId);
  });

  it('recognizes the demo by id, never by name', () => {
    expect(isDemoBrand(demoDesktop)).toBe(true);
    expect(isDemoBrand(demoPreview)).toBe(true);
    expect(isDemoBrand(brand('b1', 'Demo Studio', '2026-02-01'))).toBe(false);
  });

  it('a clean install has no user brands: only the demo', () => {
    const c = brandChoices([demoDesktop], null);
    expect(c.demo?.id).toBe(demoDesktop.id);
    expect(c.primary).toBeNull();
    expect(c.others).toEqual([]);
    expect(c.userBrands).toEqual([]);
  });

  it('an existing install proposes the last created user brand and keeps the demo out of the picker', () => {
    const a = brand('a', 'Almacén Norte', '2026-03-01T00:00:00.000Z');
    const b = brand('b', 'Bodega Sur', '2026-05-01T00:00:00.000Z');
    const c = brandChoices([demoPreview, a, b], null);
    expect(c.primary?.id).toBe('b');
    expect(c.others.map((x) => x.id)).toEqual(['a']);
    expect(c.userBrands.map((x) => x.id)).toEqual(['b', 'a']);
    expect(c.demo?.id).toBe('demo');
  });

  it('the brand used last in this walk wins over the last created one', () => {
    const a = brand('a', 'Almacén Norte', '2026-03-01T00:00:00.000Z');
    const b = brand('b', 'Bodega Sur', '2026-05-01T00:00:00.000Z');
    const c = brandChoices([demoPreview, a, b], 'a');
    expect(c.primary?.id).toBe('a');
    expect(c.others.map((x) => x.id)).toEqual(['b']);
    // The demo id is never "the last used user brand".
    expect(brandChoices([demoPreview, a], 'demo').primary?.id).toBe('a');
  });
});
