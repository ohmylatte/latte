import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

// `translate` follows the language the provider last rendered with. Here the
// test picks it, with no provider: the markup is rendered to a string.
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { CycleMap } = await import('./CycleMap');
const { CYCLE_PHASES } = await import('./resumen-summary');

const render = (locale: 'es-AR' | 'en-US'): string => {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(CycleMap, { phases: CYCLE_PHASES }));
};

describe('the cycle map', () => {
  it('renders the five phases in a fixed, non-sequential order', () => {
    const html = render('es-AR');
    const ids = [...html.matchAll(/data-phase="([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['observar', 'entender', 'decidir', 'actuar', 'medir']);
  });

  it('names the surface that feeds each phase, in Spanish', () => {
    const html = render('es-AR');
    for (const text of [
      'Observar', 'Entender', 'Decidir', 'Actuar', 'Medir',
      'Lo alimenta: Contexto', 'Lo alimenta: Documentos', 'Lo alimenta: Decisiones',
      'Lo alimenta: Conversación', 'Lo alimenta: Embudo',
    ]) expect(html).toContain(text);
  });

  it('renders the same phases in English, with nothing left in Spanish', () => {
    const html = render('en-US');
    for (const text of [
      'Observe', 'Understand', 'Decide', 'Act', 'Measure',
      'Fed by: Context', 'Fed by: Documents', 'Fed by: Decisions',
      'Fed by: Conversation', 'Fed by: Funnel',
    ]) expect(html).toContain(text);
    for (const spanish of ['Observar', 'Entender', 'Decidir', 'Actuar', 'Medir', 'Lo alimenta']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('is a map, not a wizard: no next/back controls and no step index', () => {
    const html = render('es-AR');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('1 / 5');
    expect(html).not.toContain('Anterior');
    expect(html).not.toContain('Siguiente');
    expect(html).not.toContain('Previous');
    expect(html).not.toContain('Next');
  });

  it('is presentational: no handler, no ref, no literal copy', () => {
    const source = readFileSync(resolve('src/CycleMap.tsx'), 'utf8');
    expect(source).not.toMatch(/\bonClick\b/);
    expect(source).not.toMatch(/\buseRef\b/);
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
  });
});
