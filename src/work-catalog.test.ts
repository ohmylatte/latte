import { describe, expect, it } from 'vitest';
import {
  ALL_WORK_TYPES,
  FREE_FORM_WORK_TYPE,
  SHIPPED_ROLE_IDS,
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
  it('covers the six marketing intents, each with a distinct name key', () => {
    const ids = intentGroups.map((g) => g.id);
    expect(new Set(ids).size).toBe(6);
    const names = intentGroups.map((g) => g.nameKey);
    expect(new Set(names).size).toBe(6);
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
