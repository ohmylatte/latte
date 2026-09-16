import { describe, expect, it } from 'vitest';
import type { OnboardingDraft } from '../shared/contracts';
import { findWorkType, type Answer } from './work-catalog';
import {
  ONBOARDING_STEPS,
  completeOnboarding,
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
    step: 'intent',
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

describe('onboarding step machine', () => {
  it('moves forward through the five steps and stays on prepare', () => {
    let s = baseState({ step: 'intent' });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(s.step);
      s = { ...s, step: nextStep(s) };
    }
    expect(seen).toEqual(['intent', 'context', 'brand', 'connect', 'prepare', 'prepare']);
  });

  it('moves backward and stays on intent', () => {
    let s = baseState({ step: 'prepare' });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(s.step);
      s = { ...s, step: previousStep(s) };
    }
    expect(seen).toEqual(['prepare', 'connect', 'brand', 'context', 'intent', 'intent']);
  });

  it('exposes the canonical step order', () => {
    expect(ONBOARDING_STEPS).toEqual(['intent', 'context', 'brand', 'connect', 'prepare']);
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
  const draft: OnboardingDraft = {
    step: 'brand',
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

  it('falls back to a safe role when the draft has none', () => {
    const s = initialState({ ...draft, recommendedRoleId: '' });
    expect(s.recommendedRoleId).toBe('assistant');
  });
});
