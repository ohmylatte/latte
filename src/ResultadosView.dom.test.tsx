import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

// `translate` follows the language the provider last rendered with. Here the
// test picks it, with no provider: the markup is rendered to a string.
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

// The Deliverables panel self-fetches on the desktop; the web preview forces
// `isDesktop` off and leaves the derived content as the only thing to test.
const browser = vi.hoisted(() => ({
  isDesktop: false,
  listDeliverables: vi.fn<() => Promise<DeliverableListing>>(),
}));
vi.mock('./browser-api', () => ({
  // A getter so the view's named `isDesktop` import follows the flag the test
  // toggles per-case (a plain value would be captured at import time).
  get isDesktop() { return browser.isDesktop; },
  api: { listDeliverables: browser.listDeliverables },
}));

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { render, waitFor } = await import('@testing-library/react');
const { ResultadosView } = await import('./ResultadosView');
import type { ResultadosViewProps } from './ResultadosView';
import type { Decision, DeliverableListing, Work } from '../shared/contracts';

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: 'casa-oliva', expectedOutput: 'Un PDF de dos páginas', resultPath: 'propuesta.pdf',
  updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'approved',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-01-03T00:00:00.000Z', decidedAt: '2026-01-04T00:00:00.000Z', ...patch,
});

const base: ResultadosViewProps = {
  work: work(),
  decisions: [],
  formatDate: () => 'hace un rato',
};

beforeEach(() => {
  browser.isDesktop = false;
  browser.listDeliverables.mockReset();
  browser.listDeliverables.mockResolvedValue({ files: [], truncated: false });
});

function renderMarkup(locale: 'es-AR' | 'en-US', props: Partial<ResultadosViewProps> = {}): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(ResultadosView, { ...base, ...props }));
}

/** A populated work: a linked documento and an approved decision. */
const populated = (): Partial<ResultadosViewProps> => ({
  decisions: [decision({ id: 'a1', status: 'approved', text: 'Usamos un tono cercano' })],
});

describe('the Resultados, in both interface languages', () => {
  it('speaks Spanish from the catalog: documento, entregables, decisión and the empty classes', () => {
    const html = renderMarkup('es-AR', populated());
    for (const text of [
      'aria-label="Resultados"', 'role="region"',
      'LO QUE QUEDÓ HECHO',
      'Documento', 'Un PDF de dos páginas', 'propuesta.pdf',
      'Entregables', 'Decisiones aprobadas', 'Usamos un tono cercano', 'hace un rato',
      'Diagnóstico', 'Experimento', 'Cambio ejecutado', 'Medición',
      'Nada por aquí todavía',
    ]) expect(html).toContain(text);
  });

  it('renders the same Resultados in English, with nothing left in Spanish', () => {
    const html = renderMarkup('en-US', populated());
    for (const text of [
      'aria-label="Results"',
      'WHAT GOT DONE',
      'Document', 'Un PDF de dos páginas', 'propuesta.pdf',
      'Deliverables', 'Approved decisions', 'Usamos un tono cercano', 'hace un rato',
      'Diagnosis', 'Experiment', 'Change executed', 'Measurement',
      'Nothing here yet',
    ]) expect(html).toContain(text);
    for (const spanish of ['LO QUE QUEDÓ', 'Documento', 'Entregables', 'Decisiones aprobadas', 'Diagnóstico', 'Experimento', 'Medición', 'Nada por aquí']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('renders the four non-produced classes as empty states, never invented', () => {
    const html = renderMarkup('es-AR', populated());
    for (const tag of ['diagnostico', 'experimento', 'cambio', 'medicion']) {
      expect(html).toContain(`data-tag="${tag}"`);
    }
    expect(html).toContain('Nada por aquí todavía');
  });

  it('shows an honest empty documento when no result is linked', () => {
    const html = renderMarkup('es-AR', { work: work({ resultPath: null, expectedOutput: null }) });
    expect(html).toContain('Sin documento vinculado todavía');
    expect(html).not.toContain('propuesta.pdf');
  });

  it('shows an honest empty decisión when nothing is approved', () => {
    const html = renderMarkup('es-AR', { decisions: [decision({ id: 'p1', status: 'pending', text: 'Pendiente' })] });
    expect(html).toContain('Sin decisiones aprobadas todavía');
    expect(html).not.toContain('Pendiente');
  });

  it('renders a safe empty state when no work is selected, with no derived content', () => {
    const html = renderMarkup('es-AR', { work: null });
    expect(html).toContain('aria-label="Resultados"');
    expect(html).not.toContain('Documento');
    expect(html).not.toContain('LO QUE QUEDÓ');
  });

  it('flags the linked documento as present when it is in the Deliverables listing', async () => {
    browser.isDesktop = true;
    browser.listDeliverables.mockResolvedValue({ files: [{ fileName: 'propuesta.pdf', extension: 'pdf', bytes: 10, modifiedAt: '' }], truncated: false });
    const { container } = render(createElement(ResultadosView, { ...base, work: work({ resultPath: 'propuesta.pdf' }) }));
    await waitFor(() => {
      expect(container.querySelector('.resultados-documento-path')?.getAttribute('data-state')).toBe('present');
    });
    expect(container.textContent).not.toContain('no está en entregables/');
  });

  it('flags the linked documento as missing when it left the Deliverables listing', async () => {
    browser.isDesktop = true;
    browser.listDeliverables.mockResolvedValue({ files: [], truncated: false });
    const { container } = render(createElement(ResultadosView, { ...base, work: work({ resultPath: 'propuesta.pdf' }) }));
    await waitFor(() => {
      expect(container.querySelector('.resultados-documento-path')?.getAttribute('data-state')).toBe('missing');
    });
    expect(container.textContent).toContain('no está en entregables/');
  });

  it('composes the self-fetching Deliverables panel', () => {
    const source = readFileSync(resolve('src/ResultadosView.tsx'), 'utf8');
    expect(source).toContain('<Deliverables');
  });

  it('leaves no literal copy in the component: every word a human reads comes from a key', () => {
    const source = readFileSync(resolve('src/ResultadosView.tsx'), 'utf8');
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
  });
});
