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
const { DocumentList } = await import('./DocumentList');
import type { DocumentState, WorkDocument } from '../shared/contracts';

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una campaña con nombre', fileName: 'oferta.md',
  status: 'review', funnelStages: ['discovery'], proposedFunnelStages: ['conversion'],
  baseDocumentId: null, baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});
const states: Record<string, DocumentState> = { a: { documentId: 'a', fingerprint: 'fp', modifiedAt: null, baseOutdated: true } };

function render(locale: 'es-AR' | 'en-US'): string {
  ui.locale = locale;
  return renderToStaticMarkup(createElement(DocumentList, {
    documents: [doc()],
    workId: 'w1',
    currentWorkId: 'w1',
    workTitles: { w1: 'Lanzamiento' },
    selectedId: null,
    states,
    failed: [],
    checking: false,
    onRefresh: () => {},
    onSelect: () => {},
    onCreate: () => {},
    onUseFolder: () => {},
    folder: null,
    untracked: [],
    onTrack: async () => {},
    suggestion: null,
    onImported: () => {},
    busy: false,
    showWorkDelta: false,
  }));
}

describe('DocumentList stage/status/review copy, wired through message keys', () => {
  it('speaks Spanish from the catalog in es-AR: stage filter, status filter, badge and review reasons', () => {
    const html = render('es-AR');
    expect(html).toContain('Descubrimiento'); // stage.discovery, in the stage filter
    expect(html).toContain('Consideración'); // stage.consideration
    expect(html).toContain('Conversión'); // stage.conversion, from proposedFunnelStages
    expect(html).toContain('Retención'); // stage.retention
    expect(html).toContain('Sin clasificar'); // stage.unclassified
    expect(html).toContain('Borrador'); // status.draft, in the status filter
    expect(html).toContain('En revisión'); // status.review, both as the row badge and a review reason
    expect(html).toContain('Aprobado'); // status.approved
    expect(html).toContain('Base desactualizada'); // review.outdated
  });

  it('renders the same labels in English in en-US, with nothing left in Spanish', () => {
    const html = render('en-US');
    expect(html).toContain('Discovery');
    expect(html).toContain('Consideration');
    expect(html).toContain('Conversion');
    expect(html).toContain('Retention');
    expect(html).toContain('Unclassified');
    expect(html).toContain('Draft');
    expect(html).toContain('In review');
    expect(html).toContain('Approved');
    expect(html).toContain('Outdated source');
    for (const spanish of ['Descubrimiento', 'Consideración', 'Conversión', 'Retención', 'Sin clasificar', 'Borrador', 'En revisión', 'Aprobado', 'Base desactualizada']) {
      expect(html).not.toContain(spanish);
    }
  });
});
