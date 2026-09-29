import { describe, expect, it } from 'vitest';
import type { BrandDnaView } from '../shared/contracts';
import {
  ALL_WORK_TYPES,
  DNA_ANSWER_FIELDS,
  FREE_FORM_WORK_TYPE,
  SHIPPED_ROLE_IDS,
  dnaPrefillFor,
  findWorkType,
  intentGroups,
  isAnswered,
  isShippedRoleId,
  recommendRole,
  workTypes,
  workTypesForIntent,
  type Answer,
  type WorkType,
} from './work-catalog';

describe('work catalog', () => {
  it('groups the catalog in four funnel blocks, each with a distinct name key', () => {
    expect(intentGroups.map((g) => g.id)).toEqual(['plan', 'produce', 'operate', 'measure']);
    const names = intentGroups.map((g) => g.nameKey);
    expect(new Set(names).size).toBe(4);
  });

  it('QA1: every block offers two or three start options, in the documented order', () => {
    for (const g of intentGroups) {
      const list = workTypesForIntent(g.id);
      expect(list.length, g.id).toBeGreaterThanOrEqual(2);
      expect(list.length, g.id).toBeLessThanOrEqual(3);
    }
    expect(workTypesForIntent('plan').map((w) => w.id)).toEqual(['campaign-new', 'strategy', 'content-calendar']);
    expect(workTypesForIntent('produce').map((w) => w.id)).toEqual(['copy-pieces', 'adapt-pieces', 'presentation']);
    expect(workTypesForIntent('operate').map((w) => w.id)).toEqual(['campaign-ops', 'campaign-optimize', 'budget-review']);
    expect(workTypesForIntent('measure').map((w) => w.id)).toEqual(['paid-media-audit', 'period-compare', 'report-build']);
  });

  it('QA1: the new work types ask a short set: one required question, every optional one declares its assumption', () => {
    for (const id of ['strategy', 'content-calendar', 'adapt-pieces', 'presentation', 'budget-review', 'period-compare']) {
      const w = findWorkType(id)!;
      expect(w, id).not.toBeNull();
      expect(w.questions.length, id).toBeGreaterThanOrEqual(2);
      expect(w.questions.length, id).toBeLessThanOrEqual(4);
      expect(w.questions.filter((q) => q.required), id).toHaveLength(1);
    }
  });

  it('every optional question in the catalog declares the assumption it falls back to', () => {
    for (const w of ALL_WORK_TYPES) {
      for (const q of w.questions) if (!q.required) expect(q.assumptionKey, `${w.id}.${q.id}`).toBeTruthy();
    }
  });

  it('every question id has a localized brief heading (never the raw id)', () => {
    for (const w of workTypes) {
      const brief = w.brief({}, { locale: 'es-AR' });
      for (const q of w.questions) expect(brief, `${w.id}.${q.id}`).not.toContain(`## ${q.id}
`);
    }
  });

  it('has unique work type ids and every work type belongs to a known intent', () => {
    const ids = ALL_WORK_TYPES.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    const intents = new Set(intentGroups.map((g) => g.id));
    for (const w of workTypes) expect(intents.has(w.intent)).toBe(true);
  });

  it('keeps question ids unique within each work type and options valid', () => {
    for (const w of ALL_WORK_TYPES) {
      const qids = w.questions.map((q) => q.id);
      expect(new Set(qids).size).toBe(qids.length);
      for (const q of w.questions) {
        expect(['text', 'single', 'multi']).toContain(q.kind);
        if (q.kind === 'text') {
          expect(q.options).toBeUndefined();
        } else {
          expect(q.options?.length).toBeGreaterThan(0);
          for (const option of q.options ?? []) {
            expect(typeof option.value).toBe('string');
            expect(option.labelKey).toBeTruthy();
          }
        }
        expect(typeof q.required).toBe('boolean');
      }
    }
  });

  it('recommends only shipped roles', () => {
    for (const w of ALL_WORK_TYPES) {
      expect(SHIPPED_ROLE_IDS).toContain(w.recommendedRoleId);
      expect(recommendRole(w)).toBe(w.recommendedRoleId);
    }
  });

  it('maps intents to their documented recommended roles', () => {
    const byId = Object.fromEntries(ALL_WORK_TYPES.map((w) => [w.id, w]));
    expect(byId['campaign-new'].recommendedRoleId).toBe('strategist');
    expect(byId['copy-pieces'].recommendedRoleId).toBe('sales-copywriter');
    expect(byId['campaign-ops'].recommendedRoleId).toBe('assistant');
    expect(byId['paid-media-audit'].recommendedRoleId).toBe('paid-media');
    expect(byId['campaign-optimize'].recommendedRoleId).toBe('analyst');
    expect(byId['report-build'].recommendedRoleId).toBe('assistant');
    expect(byId['strategy'].recommendedRoleId).toBe('strategist');
    expect(byId['content-calendar'].recommendedRoleId).toBe('strategist');
    expect(byId['adapt-pieces'].recommendedRoleId).toBe('sales-copywriter');
    expect(byId['presentation'].recommendedRoleId).toBe('strategist');
    expect(byId['budget-review'].recommendedRoleId).toBe('paid-media');
    expect(byId['period-compare'].recommendedRoleId).toBe('analyst');
    expect(byId[FREE_FORM_WORK_TYPE.id].recommendedRoleId).toBe('assistant');
  });

  it('recommendRole falls back to assistant for an unknown role', () => {
    const bogus = { recommendedRoleId: 'wizard' } as WorkType;
    expect(recommendRole(bogus)).toBe('assistant');
  });

  it('workTypesForIntent only returns grouped types, never the free-form one', () => {
    for (const g of intentGroups) {
      const list = workTypesForIntent(g.id);
      expect(list.length).toBeGreaterThan(0);
      expect(list.some((w) => w.id === FREE_FORM_WORK_TYPE.id)).toBe(false);
    }
  });

  it('findWorkType resolves every listed work type and misses unknown ids', () => {
    for (const w of ALL_WORK_TYPES) expect(findWorkType(w.id)?.id).toBe(w.id);
    expect(findWorkType('does-not-exist')).toBeNull();
  });

  it('renders an honest brief from answers, with placeholders for gaps', () => {
    const campaign = findWorkType('campaign-new')!;
    const empty = campaign.brief({}, { locale: 'es-AR' });
    expect(empty).toContain('## Objetivo');
    expect(empty).toContain('Por definir');

    const full: Record<string, Answer> = {
      objetivo: 'Vender la edición limitada',
      audiencia: 'Cocineros caseros',
      oferta: 'Cosecha 2026',
      canales: ['instagram', 'email'],
      restricciones: 'Pauta USD 400',
    };
    const seeded = campaign.brief(full, { locale: 'es-AR' });
    expect(seeded).toContain('## Objetivo');
    expect(seeded).toContain('Vender la edición limitada');
    expect(seeded).toContain('instagram, email');
    expect(seeded).not.toContain('Por definir');
  });

  it('localizes the brief headings', () => {
    const campaign = findWorkType('campaign-new')!;
    const es = campaign.brief({}, { locale: 'es-AR' });
    const en = campaign.brief({}, { locale: 'en-US' });
    expect(es).toContain('## Objetivo');
    expect(en).toContain('## Goal');
    expect(en).toContain('To be defined');
  });

  it('the free-form work type asks nothing and seeds an empty brief', () => {
    expect(FREE_FORM_WORK_TYPE.questions).toHaveLength(0);
    expect(FREE_FORM_WORK_TYPE.brief({}, { locale: 'es-AR' })).toBe('');
  });
});

describe('isAnswered / isShippedRoleId', () => {
  it('treats empty strings and empty arrays as unanswered', () => {
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered('hola')).toBe(true);
    expect(isAnswered(['a'])).toBe(true);
  });

  it('recognizes only shipped role ids', () => {
    expect(isShippedRoleId('assistant')).toBe(true);
    expect(isShippedRoleId('paid-media')).toBe(true);
    expect(isShippedRoleId('wizard')).toBe(false);
  });
});

/**
 * Onboarding 2.0 · LAS PREGUNTAS NO PIDEN LO QUE EL ADN YA SABE.
 *
 * Audiencia, oferta y tono salen del ADN de la marca cuando la marca tiene uno
 * (aprobado, o en su defecto el borrador); sin ADN siguen preguntándose como
 * siempre. Puro: el modal sólo mira este resultado.
 */
describe('dnaPrefillFor: lo que el ADN de la marca ya contesta', () => {
  const entry = <T,>(value: T) => ({ value, sources: [{ kind: 'human' as const, label: 'agente' }], assumption: false });
  const dnaView = (fields: Partial<NonNullable<BrandDnaView['draft']>> | null, approved = true): BrandDnaView => ({
    brandId: 'b1',
    draft: fields as BrandDnaView['draft'],
    approved: approved && fields ? { version: 1, approvedAt: '2026-09-01T00:00:00.000Z', fields: fields as NonNullable<BrandDnaView['draft']> } : null,
    changedSinceApproval: false,
    proposals: [],
    ideas: [],
    ideasUpdatedAt: null,
  });
  /** Audiencia (requerida) + oferta + un campo que el ADN no conoce. */
  const type: WorkType = {
    id: 'fake', intent: 'plan', titleKey: 'work.campaign.title', descriptionKey: 'work.campaign.description',
    recommendedRoleId: 'strategist',
    questions: [
      { id: 'objetivo', labelKey: 'question.objective', kind: 'text', required: true },
      { id: 'audiencia', labelKey: 'question.audience', kind: 'text', required: false },
      { id: 'oferta', labelKey: 'question.offer', kind: 'text', required: false },
      { id: 'tono', labelKey: 'question.objective', kind: 'text', required: false },
      { id: 'canales', labelKey: 'question.channels', kind: 'multi', required: false },
    ],
    brief: () => '',
  };

  it('maps the three questions the brand already knows onto the DNA fields', () => {
    expect(DNA_ANSWER_FIELDS['audiencia']).toBe('audience');
    expect(DNA_ANSWER_FIELDS['oferta']).toBe('valueProp');
    expect(DNA_ANSWER_FIELDS['tono']).toBe('tone');
  });

  it('completes audiencia, oferta and tono from the approved DNA and claims those questions', () => {
    const view = dnaView({
      audience: entry('Cocineros caseros'),
      valueProp: entry('Cosecha 2026 en frasco'),
      tone: entry({ adjectives: ['cálido', 'preciso'], example: null }),
      wordsYes: entry(['cosecha']),
    });
    const prefill = dnaPrefillFor(view, type);
    expect(prefill.answers).toEqual({
      audiencia: 'Cocineros caseros',
      oferta: 'Cosecha 2026 en frasco',
      tono: 'cálido, preciso',
    });
    expect(prefill.questionIds).toEqual(['audiencia', 'oferta', 'tono']);
    // The question the ADN knows nothing about is still the person's to answer.
    expect(prefill.questionIds).not.toContain('objetivo');
    expect(prefill.questionIds).not.toContain('canales');
  });

  it('falls back to the draft when there is no approved version yet', () => {
    const view = dnaView({ audience: entry('Pastas caseras'), valueProp: entry('Fideos de sémola') }, false);
    expect(view.approved).toBeNull();
    const prefill = dnaPrefillFor(view, type);
    expect(prefill.answers['audiencia']).toBe('Pastas caseras');
    expect(prefill.answers['oferta']).toBe('Fideos de sémola');
  });

  it('answers nothing when the brand has no DNA at all', () => {
    expect(dnaPrefillFor(null, type)).toEqual({ answers: {}, questionIds: [] });
    expect(dnaPrefillFor(dnaView(null), type)).toEqual({ answers: {}, questionIds: [] });
  });

  it('never claims a field the DNA left empty', () => {
    const view = dnaView({ audience: entry('   '), valueProp: entry(''), tone: entry({ adjectives: [], example: null }) });
    expect(dnaPrefillFor(view, type)).toEqual({ answers: {}, questionIds: [] });
  });

  it('asks as always for a work type whose questions the DNA does not cover', () => {
    const audit = findWorkType('paid-media-audit')!;
    expect(dnaPrefillFor(dnaView({ audience: entry('Cocineros') }), audit)).toEqual({ answers: {}, questionIds: [] });
    expect(dnaPrefillFor(dnaView({ audience: entry('Cocineros') }), FREE_FORM_WORK_TYPE)).toEqual({ answers: {}, questionIds: [] });
  });
});
