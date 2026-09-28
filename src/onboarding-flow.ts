import type { MessageKey } from './i18n';
import type { Brand, OnboardingDraft, OnboardingStep } from '../shared/contracts';
import { findWorkType, isAnswered, type Answer, type OnboardingQuestion, type WorkType } from './work-catalog';

/**
 * The onboarding state machine, kept pure so the whole walk is testable
 * without React. The gate component owns the in-memory `OnboardingState`; this
 * module only decides transitions, assumptions, completion and how that state
 * persists as a resumable draft.
 */

export type { OnboardingStep };

export interface OnboardingState {
  step: OnboardingStep;
  workTypeId: string | null;
  answers: Record<string, Answer>;
  /** Already-localized assumption phrases for the optional questions skipped. */
  assumptions: { text: string }[];
  brandId: string | null;
  usedDemo: boolean;
  /** Records the intent to link an existing folder (honoured at the start CTA). */
  linkFolderRequested: boolean;
  recommendedRoleId: string;
  brief: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = ['intent', 'context', 'brand', 'connect', 'prepare'];

/** A fresh walk, or a resumed one when a persisted draft exists. */
export function initialState(draft?: OnboardingDraft | null): OnboardingState {
  if (!draft) {
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
    };
  }
  return {
    step: draft.step,
    workTypeId: draft.workTypeId,
    answers: { ...draft.answers },
    assumptions: draft.assumptions.map((text) => ({ text })),
    brandId: draft.brandId,
    usedDemo: draft.usedDemo,
    linkFolderRequested: draft.linkFolderRequested,
    recommendedRoleId: draft.recommendedRoleId || 'assistant',
    brief: draft.brief,
  };
}

/** The persisted shape of the in-memory state, minus any React-only detail. */
export function toDraft(state: OnboardingState): OnboardingDraft {
  return {
    step: state.step,
    workTypeId: state.workTypeId,
    answers: { ...state.answers },
    assumptions: state.assumptions.map((a) => a.text),
    brandId: state.brandId,
    usedDemo: state.usedDemo,
    linkFolderRequested: state.linkFolderRequested,
    recommendedRoleId: state.recommendedRoleId,
    brief: state.brief,
  };
}

export function nextStep(state: OnboardingState): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(state.step);
  if (index < 0 || index >= ONBOARDING_STEPS.length - 1) return state.step;
  return ONBOARDING_STEPS[index + 1];
}

export function previousStep(state: OnboardingState): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(state.step);
  if (index <= 0) return state.step;
  return ONBOARDING_STEPS[index - 1];
}

/**
 * Optional questions left blank become assumptions. A required question left
 * blank blocks completion (see `completeOnboarding`) instead of being assumed,
 * so it never shows up here. The phrases arrive already localized via `t`.
 */
export function declareAssumptions(workType: WorkType, answers: Record<string, Answer>, t: (key: MessageKey) => string): string[] {
  const assumptions: string[] = [];
  for (const question of workType.questions) {
    if (isAnswered(answers[question.id])) continue;
    if (question.required) continue;
    if (question.assumptionKey) assumptions.push(t(question.assumptionKey));
  }
  return assumptions;
}

/**
 * The required questions still unanswered, in catalog order. The gate uses this
 * to block the step and to name what is missing: a required field is never a
 * silent trap. `completeOnboarding` stays the single source of truth for "can
 * the walk finish".
 */
export function missingRequiredQuestions(workType: WorkType, answers: Record<string, Answer>): OnboardingQuestion[] {
  return workType.questions.filter((question) => question.required && !isAnswered(answers[question.id]));
}

/**
 * The demo brand's ids: the one the desktop seeds (`electron/services/seed.ts`
 * `DEMO_BRAND_ID`) and the one the web preview seeds (`browser-api.ts`). A test
 * reads both sources, so a renamed id fails loudly instead of leaking the demo
 * into the "existing brands" list. Never matched by name: a real brand called
 * "Demo Studio" belongs to the person.
 */
export const DEMO_BRAND_IDS: readonly string[] = ['brd_demo_casa_oliva', 'demo'];

export function isDemoBrand(brand: Pick<Brand, 'id'>): boolean {
  return DEMO_BRAND_IDS.includes(brand.id);
}

export interface BrandChoices {
  /** The seeded demo, when present. Offered as its own secondary action, never as a brand. */
  demo: Brand | null;
  /** The person's own brands, most relevant first. */
  userBrands: Brand[];
  /** "Seguir con {marca}": the brand used last in this walk, else the last one created. */
  primary: Brand | null;
  /** Every other user brand, for "Otra marca". */
  others: Brand[];
}

/**
 * QA1 · B: what the brand step offers. A clean install (only the demo) has no
 * primary brand; an existing one leads with the brand the person used last.
 */
export function brandChoices(brands: Brand[], lastUsedBrandId: string | null): BrandChoices {
  const demo = brands.find(isDemoBrand) ?? null;
  const own = brands
    .map((brand, index) => ({ brand, index }))
    .filter(({ brand }) => !isDemoBrand(brand))
    // Newest first; the later one in the list wins a tie (same-millisecond creations).
    .sort((a, b) => b.brand.createdAt.localeCompare(a.brand.createdAt) || b.index - a.index)
    .map(({ brand }) => brand);
  const lastUsed = lastUsedBrandId ? own.find((b) => b.id === lastUsedBrandId) ?? null : null;
  const userBrands = lastUsed ? [lastUsed, ...own.filter((b) => b.id !== lastUsed.id)] : own;
  const primary = userBrands[0] ?? null;
  return { demo, userBrands, primary, others: userBrands.slice(1) };
}

/**
 * True when the selected work type has every required question answered. Brand
 * selection is gated in the gate component, not here: this function answers
 * exactly "are the required questions answered", as documented.
 */
export function completeOnboarding(state: OnboardingState): boolean {
  if (!state.workTypeId) return false;
  const workType = findWorkType(state.workTypeId);
  if (!workType) return false;
  return workType.questions.every((q) => !q.required || isAnswered(state.answers[q.id]));
}
