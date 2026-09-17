import type { ContentLocale } from '../shared/contracts';
import type { MessageKey } from './i18n';

/**
 * The first-run work catalog: pure data, no React and no backend. It maps the
 * marketing intents a person opens Latte with to concrete work types, the
 * adaptive questions each one asks, and the brief those answers become.
 *
 * Adding a work type is data-only: edit this file, nothing in the JSX changes.
 */

export type IntentId = 'plan' | 'produce' | 'operate' | 'analyze' | 'optimize' | 'report';
export type QuestionKind = 'text' | 'single' | 'multi';
export type Answer = string | string[];

export interface OnboardingQuestionOption {
  value: string;
  labelKey: MessageKey;
}

export interface OnboardingQuestion {
  id: string;
  labelKey: MessageKey;
  kind: QuestionKind;
  options?: OnboardingQuestionOption[];
  /** A required question blocks completion; an optional one is assumed when skipped. */
  required: boolean;
  /** Stated when an optional question is left unanswered. */
  assumptionKey?: MessageKey;
}

export interface WorkType {
  id: string;
  intent: IntentId;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  questions: OnboardingQuestion[];
  recommendedRoleId: string;
  /** Renders the answers into the seed brief of the created work. */
  brief: (answers: Record<string, Answer>, opts: { locale: ContentLocale }) => string;
}

/** The roles this build actually ships (assistant + the marketing-core pack). */
export const SHIPPED_ROLE_IDS = ['assistant', 'strategist', 'researcher', 'analyst', 'paid-media', 'sales-copywriter', 'reviewer'] as const;
export type ShippedRoleId = (typeof SHIPPED_ROLE_IDS)[number];

export function isShippedRoleId(value: string): value is ShippedRoleId {
  return (SHIPPED_ROLE_IDS as readonly string[]).includes(value);
}

/** True when an answer is present and non-empty. */
export function isAnswered(value: Answer | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

const channelsOptions: OnboardingQuestionOption[] = [
  { value: 'instagram', labelKey: 'question.option.instagram' },
  { value: 'email', labelKey: 'question.option.email' },
  { value: 'meta-ads', labelKey: 'question.option.metaAds' },
  { value: 'google-ads', labelKey: 'question.option.googleAds' },
  { value: 'whatsapp', labelKey: 'question.option.whatsapp' },
  { value: 'other', labelKey: 'question.option.other' },
];

const currencyOptions: OnboardingQuestionOption[] = [
  { value: 'usd', labelKey: 'question.option.usd' },
  { value: 'ars', labelKey: 'question.option.ars' },
  { value: 'eur', labelKey: 'question.option.eur' },
];

const attributionOptions: OnboardingQuestionOption[] = [
  { value: 'last-click', labelKey: 'question.option.lastClick' },
  { value: 'first-click', labelKey: 'question.option.firstClick' },
  { value: 'linear', labelKey: 'question.option.linear' },
  { value: 'data-driven', labelKey: 'question.option.dataDriven' },
];

const channelOptions: OnboardingQuestionOption[] = [
  { value: 'instagram', labelKey: 'question.option.instagram' },
  { value: 'landing', labelKey: 'question.option.landing' },
  { value: 'newsletter', labelKey: 'question.option.newsletter' },
  { value: 'other', labelKey: 'question.option.other' },
];

const metricsOptions: OnboardingQuestionOption[] = [
  { value: 'reach', labelKey: 'question.option.reach' },
  { value: 'clicks', labelKey: 'question.option.clicks' },
  { value: 'conversions', labelKey: 'question.option.conversions' },
  { value: 'cost', labelKey: 'question.option.cost' },
  { value: 'roas', labelKey: 'question.option.roas' },
];

const sourcesOptions: OnboardingQuestionOption[] = [
  { value: 'ads', labelKey: 'question.option.ads' },
  { value: 'analytics', labelKey: 'question.option.analytics' },
  { value: 'crm', labelKey: 'question.option.crm' },
  { value: 'newsletter', labelKey: 'question.option.newsletter' },
  { value: 'other', labelKey: 'question.option.other' },
];

const actionsOptions: OnboardingQuestionOption[] = [
  { value: 'pause', labelKey: 'question.option.pause' },
  { value: 'adjust-budget', labelKey: 'question.option.adjustBudget' },
  { value: 'change-bids', labelKey: 'question.option.changeBids' },
  { value: 'edit-copy', labelKey: 'question.option.editCopy' },
];

const approvalOptions: OnboardingQuestionOption[] = [
  { value: 'self', labelKey: 'question.option.self' },
  { value: 'manager', labelKey: 'question.option.manager' },
  { value: 'client', labelKey: 'question.option.client' },
];

/** Short, localized headings for the seed brief, keyed by question id. */
const BRIEF_SECTIONS: Record<string, { es: string; en: string }> = {
  objetivo: { es: 'Objetivo', en: 'Goal' },
  audiencia: { es: 'Audiencia', en: 'Audience' },
  oferta: { es: 'Oferta', en: 'Offer' },
  canales: { es: 'Canales', en: 'Channels' },
  restricciones: { es: 'Restricciones', en: 'Constraints' },
  cuenta: { es: 'Cuenta', en: 'Account' },
  acciones: { es: 'Acciones autorizadas', en: 'Authorized actions' },
  limites: { es: 'Límites', en: 'Limits' },
  aprobacion: { es: 'Aprobación', en: 'Approval' },
  verificacion: { es: 'Verificación', en: 'Verification' },
  periodo: { es: 'Período', en: 'Period' },
  conversion: { es: 'Conversión', en: 'Conversion' },
  moneda: { es: 'Moneda', en: 'Currency' },
  atribucion: { es: 'Atribución', en: 'Attribution' },
  indicadores: { es: 'Indicadores', en: 'Metrics' },
  fuentes: { es: 'Fuentes', en: 'Sources' },
  decision: { es: 'Decisión', en: 'Decision' },
  canal: { es: 'Canal', en: 'Channel' },
  promesa: { es: 'Promesa', en: 'Promise' },
  prueba: { es: 'Evidencia', en: 'Evidence' },
  cta: { es: 'Llamado a la acción', en: 'Call to action' },
};

const placeholder = (locale: ContentLocale): string => (locale === 'en-US' ? 'To be defined' : 'Por definir');

function formatAnswer(value: Answer | undefined): string {
  if (!isAnswered(value)) return '';
  return Array.isArray(value) ? value.join(', ') : String(value).trim();
}

const lang = (locale: ContentLocale): 'es' | 'en' => (locale === 'en-US' ? 'en' : 'es');

function briefFrom(questions: OnboardingQuestion[], answers: Record<string, Answer>, locale: ContentLocale): string {
  const sections: string[] = [];
  for (const q of questions) {
    const heading = BRIEF_SECTIONS[q.id]?.[lang(locale)] ?? q.id;
    const value = formatAnswer(answers[q.id]);
    sections.push(`## ${heading}`, '', value || placeholder(locale), '');
  }
  return sections.join('\n').trim();
}

function makeWorkType(
  id: string,
  intent: IntentId,
  titleKey: MessageKey,
  descriptionKey: MessageKey,
  recommendedRoleId: string,
  questions: OnboardingQuestion[],
): WorkType {
  return { id, intent, titleKey, descriptionKey, recommendedRoleId, questions, brief: (answers, { locale }) => briefFrom(questions, answers, locale) };
}

/** The six intent groups, in the order a marketer thinks about them. */
export const intentGroups: Array<{ id: IntentId; nameKey: MessageKey }> = [
  { id: 'plan', nameKey: 'onboarding.intent.plan' },
  { id: 'produce', nameKey: 'onboarding.intent.produce' },
  { id: 'operate', nameKey: 'onboarding.intent.operate' },
  { id: 'analyze', nameKey: 'onboarding.intent.analyze' },
  { id: 'optimize', nameKey: 'onboarding.intent.optimize' },
  { id: 'report', nameKey: 'onboarding.intent.report' },
];

export const workTypes: WorkType[] = [
  makeWorkType('campaign-new', 'plan', 'work.campaign.title', 'work.campaign.description', 'strategist', [
    { id: 'objetivo', labelKey: 'question.objective', kind: 'text', required: true },
    { id: 'audiencia', labelKey: 'question.audience', kind: 'text', required: false, assumptionKey: 'assumption.audience' },
    { id: 'oferta', labelKey: 'question.offer', kind: 'text', required: false, assumptionKey: 'assumption.offer' },
    { id: 'canales', labelKey: 'question.channels', kind: 'multi', options: channelsOptions, required: false, assumptionKey: 'assumption.channels' },
    { id: 'restricciones', labelKey: 'question.constraints', kind: 'text', required: false, assumptionKey: 'assumption.constraints' },
  ]),
  makeWorkType('copy-pieces', 'produce', 'work.copy.title', 'work.copy.description', 'sales-copywriter', [
    { id: 'objetivo', labelKey: 'question.objective', kind: 'text', required: true },
    { id: 'canal', labelKey: 'question.channel', kind: 'single', options: channelOptions, required: false, assumptionKey: 'assumption.channel' },
    { id: 'promesa', labelKey: 'question.promise', kind: 'text', required: false, assumptionKey: 'assumption.promise' },
    { id: 'prueba', labelKey: 'question.proof', kind: 'text', required: false, assumptionKey: 'assumption.proof' },
    { id: 'cta', labelKey: 'question.cta', kind: 'text', required: false, assumptionKey: 'assumption.cta' },
  ]),
  makeWorkType('campaign-ops', 'operate', 'work.operation.title', 'work.operation.description', 'assistant', [
    { id: 'cuenta', labelKey: 'question.account', kind: 'text', required: true },
    { id: 'acciones', labelKey: 'question.actions', kind: 'multi', options: actionsOptions, required: false, assumptionKey: 'assumption.actions' },
    { id: 'limites', labelKey: 'question.limits', kind: 'text', required: false, assumptionKey: 'assumption.limits' },
    { id: 'aprobacion', labelKey: 'question.approval', kind: 'single', options: approvalOptions, required: false, assumptionKey: 'assumption.approval' },
    { id: 'verificacion', labelKey: 'question.verification', kind: 'text', required: false, assumptionKey: 'assumption.verification' },
  ]),
  makeWorkType('paid-media-audit', 'analyze', 'work.paidMedia.title', 'work.paidMedia.description', 'paid-media', [
    { id: 'cuenta', labelKey: 'question.account', kind: 'text', required: true },
    { id: 'periodo', labelKey: 'question.period', kind: 'text', required: false, assumptionKey: 'assumption.period' },
    { id: 'conversion', labelKey: 'question.conversion', kind: 'text', required: false, assumptionKey: 'assumption.conversion' },
    { id: 'moneda', labelKey: 'question.currency', kind: 'single', options: currencyOptions, required: false, assumptionKey: 'assumption.currency' },
    { id: 'atribucion', labelKey: 'question.attribution', kind: 'single', options: attributionOptions, required: false, assumptionKey: 'assumption.attribution' },
  ]),
  makeWorkType('campaign-optimize', 'optimize', 'work.optimize.title', 'work.optimize.description', 'analyst', [
    { id: 'objetivo', labelKey: 'question.objective', kind: 'text', required: true },
    { id: 'cuenta', labelKey: 'question.account', kind: 'text', required: false, assumptionKey: 'assumption.account' },
    { id: 'periodo', labelKey: 'question.period', kind: 'text', required: false, assumptionKey: 'assumption.period' },
    { id: 'indicadores', labelKey: 'question.metrics', kind: 'multi', options: metricsOptions, required: false, assumptionKey: 'assumption.metrics' },
    { id: 'restricciones', labelKey: 'question.constraints', kind: 'text', required: false, assumptionKey: 'assumption.constraints' },
  ]),
  makeWorkType('report-build', 'report', 'work.report.title', 'work.report.description', 'assistant', [
    { id: 'audiencia', labelKey: 'question.audience', kind: 'text', required: true },
    { id: 'periodo', labelKey: 'question.period', kind: 'text', required: false, assumptionKey: 'assumption.period' },
    { id: 'fuentes', labelKey: 'question.sources', kind: 'multi', options: sourcesOptions, required: false, assumptionKey: 'assumption.sources' },
    { id: 'indicadores', labelKey: 'question.metrics', kind: 'multi', options: metricsOptions, required: false, assumptionKey: 'assumption.metrics' },
    { id: 'decision', labelKey: 'question.decision', kind: 'text', required: false, assumptionKey: 'assumption.decision' },
  ]),
];

/** "Empezar libremente": a blank work type, listed apart from the six intents. */
export const FREE_FORM_WORK_TYPE_ID = 'free-form';
export const FREE_FORM_WORK_TYPE: WorkType = makeWorkType(FREE_FORM_WORK_TYPE_ID, 'plan', 'work.freeForm.title', 'work.freeForm.description', 'assistant', []);

/** Every selectable work type, free-form included. */
export const ALL_WORK_TYPES: WorkType[] = [...workTypes, FREE_FORM_WORK_TYPE];

export function workTypesForIntent(intent: IntentId): WorkType[] {
  return workTypes.filter((w) => w.intent === intent);
}

export function findWorkType(id: string): WorkType | null {
  return ALL_WORK_TYPES.find((w) => w.id === id) ?? null;
}

/**
 * The role a work type recommends. Data-driven: it reads the type's own
 * `recommendedRoleId` and only validates that the role really ships, falling
 * back to the neutral `assistant` when it does not.
 */
export function recommendRole(workType: WorkType): string {
  return isShippedRoleId(workType.recommendedRoleId) ? workType.recommendedRoleId : 'assistant';
}
