import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

// `translate` follows the language the provider last rendered with. Here the
// test picks it, with no provider and no DOM: the markup is rendered to a string.
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
vi.stubGlobal('window', {});
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { OrientationStrip } = await import('./OrientationStrip');

type ViewProps = Parameters<typeof OrientationStrip>[0];
const base: ViewProps = {
  brandContextDefined: true,
  pendingDecisions: 0,
  reviewDocuments: 0,
  expectedOutput: '',
  checking: false,
};

function render(locale: 'es-AR' | 'en-US', props: Partial<ViewProps>): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(OrientationStrip, { ...base, ...props }));
}

/** Every state the strip can show, in one pass: brand, outcome, review count, decisions and all five rungs. */
const everyState = (locale: 'es-AR' | 'en-US'): string => [
  render(locale, { brandContextDefined: false, pendingDecisions: 3, reviewDocuments: 2 }),
  render(locale, { brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 1 }),
  render(locale, { brandContextDefined: true, pendingDecisions: 2, reviewDocuments: 0 }),
  render(locale, { brandContextDefined: true, pendingDecisions: 1, reviewDocuments: 3 }),
  render(locale, { brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 0, checking: true }),
  render(locale, { brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 0 }),
  render(locale, { brandContextDefined: true, pendingDecisions: 0, reviewDocuments: 2, expectedOutput: 'Un PDF de dos páginas' }),
].join('\n');

describe('the orientation strip, in both interface languages', () => {
  it('speaks Spanish from the catalog, every cell and the next step included', () => {
    const html = everyState('es-AR');
    for (const text of [
      'aria-label="Dónde estamos"', 'role="region"',
      '<strong>Marca</strong>', '>Vacío<', '>Definido<',
      '<strong>Resultado esperado</strong>', '<em>sin definir</em>', 'Un PDF de dos páginas',
      '<strong>Para revisar</strong>', '<strong>Decisiones pendientes</strong>', '<strong>Siguiente paso</strong>',
      'Definir el contexto de marca', 'Revisar 2 decisiones pendientes', 'Revisar 1 decisión pendiente',
      'Revisar 1 documento', 'Revisar 2 documentos', 'Revisando qué falta…', 'Sin pendientes',
      'data-cell="brand"', 'data-cell="outcome"', 'data-cell="review"', 'data-cell="decisions"',
    ]) expect(html).toContain(text);
  });

  it('renders the same states in English, with nothing left in Spanish', () => {
    const html = everyState('en-US');
    for (const text of [
      'aria-label="Where we are"',
      '<strong>Brand</strong>', '>Empty<', '>Defined<',
      '<strong>Expected output</strong>', '<em>not set</em>', 'Un PDF de dos páginas',
      '<strong>To review</strong>', '<strong>Pending decisions</strong>', '<strong>Next step</strong>',
      'Define the brand context', 'Review 2 pending decisions', 'Review 1 pending decision',
      'Review 1 document', 'Review 2 documents', 'Checking what is left…', 'Nothing pending',
    ]) expect(html).toContain(text);
    for (const spanish of ['Dónde', 'Marca', 'Vacío', 'Definido', 'Resultado', 'sin definir', 'Para revisar', 'Decisiones', 'Siguiente', 'Definir', 'Revisar', 'Revisando', 'Sin pendientes']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('never claims a review count before the sweep has answered, and says it is checking', () => {
    const html = render('es-AR', { checking: true, reviewDocuments: 0 });
    expect(html).toContain('data-state="pending"');
    expect(html).toContain('>…<');
    expect(html).toContain('Revisando qué falta…');
    expect(html).not.toContain('Sin pendientes');
  });

  it('picks the singular and the plural branch of the next step, in both languages', () => {
    expect(render('es-AR', { reviewDocuments: 1 })).toContain('Revisar 1 documento');
    expect(render('es-AR', { reviewDocuments: 2 })).toContain('Revisar 2 documentos');
    expect(render('en-US', { reviewDocuments: 1 })).toContain('Review 1 document');
    expect(render('en-US', { reviewDocuments: 2 })).toContain('Review 2 documents');
    expect(render('es-AR', { pendingDecisions: 1 })).toContain('Revisar 1 decisión pendiente');
    expect(render('en-US', { pendingDecisions: 1 })).toContain('Review 1 pending decision');
  });

  it('leaves no literal copy in the component: every word a human reads comes from a key', () => {
    const source = readFileSync(new URL('./OrientationStrip.tsx', import.meta.url), 'utf8');
    // No attribute a screen reader or a tooltip reads is a literal.
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
    // The strip is read-only: no action, no handler and no ref.
    expect(source).not.toMatch(/\bonClick\b/);
    expect(source).not.toMatch(/\buseRef\b/);
  });
});
