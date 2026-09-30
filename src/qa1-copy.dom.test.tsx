import { describe, expect, it } from 'vitest';
import { catalogs, type MessageKey } from './i18n';

/**
 * QA1 · D: LA COPY DE ONBOARDING, CATÁLOGO Y "CONECTÁ TU IA" DICE QUÉ HACE LATTE.
 *
 * Regla del dueño: nunca tranquilizar por negación ("sin tecnicismos", "sin
 * inventar", "nunca…", "sin copiar nada") — suena condescendiente y
 * sospechoso. Y mucho menos texto: los subtítulos que repetían el título se
 * fueron del catálogo.
 */
const SCREEN_PREFIXES = ['onboarding.', 'work.', 'question.', 'assumption.', 'connectAI.'];
const screenKeys = (locale: 'es-AR' | 'en-US') =>
  (Object.keys(catalogs[locale]) as MessageKey[]).filter((k) => SCREEN_PREFIXES.some((p) => k.startsWith(p)));

describe('QA1 · copy de onboarding, catálogo y conectar', () => {
  it('ninguna frase tranquiliza por negación (es)', () => {
    for (const key of screenKeys('es-AR')) {
      const text = catalogs['es-AR'][key];
      expect(text, key).not.toMatch(/\bnunca\b|sin tecnicismos|sin inventar|sin copiar|\bno guarda|^Sigo sin\b/i);
    }
  });

  it('ninguna frase tranquiliza por negación (en)', () => {
    for (const key of screenKeys('en-US')) {
      const text = catalogs['en-US'][key];
      expect(text, key).not.toMatch(/\bnever\b|without copying|without jargon|^Proceeding without\b/i);
    }
  });

  it('los supuestos dicen qué hace Latte con el dato que falta, en una línea corta', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      for (const key of screenKeys(locale).filter((k) => k.startsWith('assumption.'))) {
        const text = catalogs[locale][key];
        expect(text.length, `${locale} ${key}`).toBeLessThanOrEqual(60);
        expect(text, `${locale} ${key}`).toMatch(/^[^:]+: /);
      }
    }
  });

  it('las opciones del catálogo son cortas: título de hasta 28 caracteres, tooltip de una línea', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      for (const key of screenKeys(locale).filter((k) => /^work\.[^.]+\.title$/.test(k))) {
        expect(catalogs[locale][key].length, `${locale} ${key}`).toBeLessThanOrEqual(28);
      }
      for (const key of screenKeys(locale).filter((k) => /^work\.[^.]+\.description$/.test(k))) {
        expect(catalogs[locale][key].length, `${locale} ${key}`).toBeLessThanOrEqual(60);
      }
    }
  });

  it('se fueron el subtítulo del catálogo y la frase repetida del demo en "Conectá tu IA"', () => {
    const keys = Object.keys(catalogs['es-AR']);
    expect(keys).not.toContain('onboarding.subtitle');
    expect(keys).not.toContain('onboarding.connect.demoAvailable');
  });

  it('los títulos que pidió el dueño', () => {
    expect(catalogs['es-AR']['onboarding.title']).toBe('¿En qué querés trabajar?');
    expect(catalogs['es-AR']['onboarding.connect.title']).toBe('¿Con qué cuenta trabajás?');
    expect(catalogs['es-AR']['connectAI.title']).toBe('¿Con qué cuenta trabajás?');
  });
});
