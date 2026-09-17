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

// The canonical folder/entregables panels render nothing on the web preview, so
// the web test only exercises the derived content; `isDesktop` is forced false
// the same way the whole-app dom tests do.
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, isDesktop: false };
});

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { EvidenciaView } = await import('./EvidenciaView');
import type { EvidenciaViewProps } from './EvidenciaView';
import type { Decision, DocumentState, UntrackedFile, Work, WorkDocument } from '../shared/contracts';

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: 'casa-oliva', expectedOutput: 'Un PDF', resultPath: 'propuesta.pdf',
  updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una nota', fileName: 'n.md', status: 'draft',
  funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null,
  baseFingerprint: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos X', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'approved',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-01-03T00:00:00.000Z', decidedAt: '2026-01-04T00:00:00.000Z', ...patch,
});
const untracked = (patch: Partial<UntrackedFile> = {}): UntrackedFile => ({
  fileName: 'u.md', title: 'U', kind: 'note', bytes: 10, modifiedAt: '2026-01-05T00:00:00.000Z', funnelStages: [], ...patch,
});
const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const base: EvidenciaViewProps = {
  work: work(),
  workId: 'w1',
  documents: [],
  decisions: [],
  untracked: [],
  states: {},
  checking: false,
  formatDate: () => 'hace un rato',
  onTrack: async () => {},
  onImported: () => {},
  busy: false,
};

function renderMarkup(locale: 'es-AR' | 'en-US', props: Partial<EvidenciaViewProps> = {}): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(EvidenciaView, { ...base, ...props }));
}

/** A populated work: a research doc, a strategy, an approved decision and a file. */
const populated = (patch: Partial<EvidenciaViewProps> = {}): Partial<EvidenciaViewProps> => ({
  documents: [
    doc({ id: 'r', kind: 'research', title: 'Investigación de mercado' }),
    doc({ id: 's', kind: 'strategy', title: 'Estrategia de lanzamiento' }),
  ],
  decisions: [decision({ id: 'a1', status: 'approved', text: 'Usamos un tono cercano' })],
  untracked: [untracked({ fileName: 'datos.csv' })],
  ...patch,
});

describe('the Evidencia, in both interface languages', () => {
  it('speaks Spanish from the catalog: every group, every tag, the legend', () => {
    const html = renderMarkup('es-AR', populated());
    for (const text of [
      'aria-label="Evidencia"', 'role="region"',
      'LO QUE RESPALDA EL TRABAJO',
      'Actualizado', 'hace un rato', 'Período',
      'Investigación', 'Investigación de mercado', 'Hecho observado',
      'Recomendaciones', 'Estrategia de lanzamiento', 'Recomendación',
      'Decisiones aprobadas', 'Usamos un tono cercano', 'Decisión aprobada',
      'Datos importados', 'datos.csv',
      'Cálculo', 'Hipótesis',
      'Clasificación',
    ]) expect(html).toContain(text);
    // A populated work has sources, so no "sin fuentes" caveat.
    expect(html).not.toContain('Sin fuentes');
  });

  it('renders the same Evidencia in English, with nothing left in Spanish', () => {
    const html = renderMarkup('en-US', populated());
    for (const text of [
      'aria-label="Evidence"',
      'WHAT BACKS THE WORK',
      'Updated', 'hace un rato', 'Period',
      'Research', 'Investigación de mercado', 'Observed fact',
      'Recommendations', 'Estrategia de lanzamiento', 'Recommendation',
      'Approved decisions', 'Usamos un tono cercano', 'Approved decision',
      'Imported data', 'datos.csv',
      'Calculation', 'Hypothesis',
      'Classification',
    ]) expect(html).toContain(text);
    for (const spanish of ['DÓNDE', 'Recomendaciones', 'Decisiones aprobadas', 'Datos importados', 'Clasificación', 'Cálculo', 'Hipótesis', 'Hecho', 'Actualizado']) {
      expect(html).not.toContain(spanish);
    }
  });

  it('renders the classification tags on each evidence item', () => {
    const html = renderMarkup('es-AR', populated());
    expect(html).toContain('data-tag="hecho"');
    expect(html).toContain('data-tag="recomendacion"');
    expect(html).toContain('data-tag="decision"');
    // The legend renders the full 5-class taxonomy.
    for (const tag of ['hecho', 'calculo', 'hipotesis', 'recomendacion', 'decision']) {
      expect(html).toContain(`data-tag="${tag}"`);
    }
  });

  it('renders a safe empty state when no work is selected, with no derived content', () => {
    const html = renderMarkup('es-AR', { work: null });
    expect(html).toContain('aria-label="Evidencia"');
    expect(html).not.toContain('Investigación');
    expect(html).not.toContain('Clasificación');
  });

  it('shows empty messages and the "sin fuentes" caveat when nothing backs the work', () => {
    const html = renderMarkup('es-AR');
    expect(html).toContain('Sin evidencia todavía');
    expect(html).toContain('Sin fuentes: no hay documentos que respalden estos resultados');
  });

  it('leaves no literal copy in the component: every word a human reads comes from a key', () => {
    const source = readFileSync(resolve('src/EvidenciaView.tsx'), 'utf8');
    expect(source).not.toMatch(/\b(?:aria-label|title|placeholder)="/);
  });
});
