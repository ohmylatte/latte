import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { DocumentsView, type DocumentsViewProps } from './DocumentsView';
import { VersionRing } from './brand-marks';
import type { Revision, Work, WorkDocument } from '../shared/contracts';

/**
 * M4 — "los anillos son versiones".
 *
 * Cada versión es un anillo de 14 px con borde `--rust` de 2 px: la actual
 * llena, las anteriores al 35 %. Nunca se pintan todos: a partir de cinco se
 * ocultan y el contador `+N` dice cuántas quedaron afuera, en `--mono`.
 *
 * El anillo sólo se DIBUJA (0→360°, 300 ms) cuando se creó una versión
 * nueva: abrir el modal con siete versiones viejas no tiene por qué dibujar
 * nada. Y al lado del último, en `--mono`, el estado de la versión.
 */

const mocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  documentState: vi.fn(),
  listDocumentRevisions: vi.fn(),
  snapshotDocument: vi.fn(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.browserAPI,
      readDocument: mocks.readDocument,
      documentState: mocks.documentState,
      listDocumentRevisions: mocks.listDocumentRevisions,
      snapshotDocument: mocks.snapshotDocument,
    },
  };
});

const work: Work = {
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, outOfScopeStages: [], updatedAt: '2026-09-01T00:00:00.000Z',
};

const doc = (status: WorkDocument['status']): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Oferta de lanzamiento', fileName: 'oferta.md',
  status, funnelStages: ['discovery'], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const revision = (n: number): Revision => ({
  id: 'r' + n, workId: 'w1', documentId: 'a', source: 'human', content: '# v' + n,
  createdAt: `2026-09-0${n}T00:00:00.000Z`,
});

const base: DocumentsViewProps = {
  work,
  brandName: 'Casa Oliva',
  documents: [doc('approved')],
  selectedId: 'a',
  onSelect: () => {},
  onDocumentsChanged: async () => {},
  onWorkUpdated: () => {},
  onDirtyChange: () => {},
  onNotice: () => {},
  onError: () => {},
  onCreate: () => {},
  onUseFolder: () => {},
  funnel: false,
  onView: () => {},
  hasBrand: true,
  onStart: () => {},
  untracked: [],
  onTrack: async () => {},
  editors: {},
  busy: false,
  currentWorkId: 'w1',
  workTitles: {},
  showWorkDelta: false,
};

/** Las versiones llegan de la más nueva a la más vieja, como las ordena la API. */
const revisions = (count: number): Revision[] =>
  Array.from({ length: count }, (_, i) => revision(count - i));

const renderView = async (documents: WorkDocument[], list: Revision[]) => {
  mocks.listDocumentRevisions.mockReset().mockResolvedValue(list);
  const view = render(<DocumentsView {...base} documents={documents} />);
  await waitFor(() => expect(view.container.querySelector('.document-toolbar')).not.toBeNull());
  await waitFor(() => expect(mocks.listDocumentRevisions).toHaveBeenCalled());
  // Deja que la promesa de revisiones pase al estado y al DOM.
  await act(async () => {});
  return view;
};

beforeEach(() => {
  mocks.readDocument.mockReset().mockResolvedValue({ content: '# Oferta', fingerprint: 'fp', baseOutdated: false });
  mocks.documentState.mockReset().mockResolvedValue({ documentId: 'a', fingerprint: 'fp', modifiedAt: null, baseOutdated: false });
  mocks.snapshotDocument.mockReset();
  mocks.listDocumentRevisions.mockReset().mockResolvedValue([]);
});

describe('M4 — el anillo del documento', () => {
  it('el anillo mide 14 px, con borde --rust de 2 px; la actual llena y las viejas al 35 %', () => {
    const { container } = render(<><VersionRing filled={false} /><VersionRing filled /></>);
    const rings = [...container.querySelectorAll('svg.version-ring')];
    expect(rings).toHaveLength(2);
    for (const ring of rings) {
      expect(ring.getAttribute('width')).toBe('14');
      const circle = ring.querySelector('circle')!;
      expect(circle.getAttribute('stroke')).toBe('var(--rust)');
      expect(circle.getAttribute('stroke-width')).toBe('2');
    }
    expect(rings[0].querySelector('circle')!.getAttribute('fill')).toBe('none');
    expect(rings[1].querySelector('circle')!.getAttribute('fill')).toBe('var(--rust)');
    expect(rings[0].getAttribute('class')).toContain('version-ring');
    expect(rings[0].getAttribute('class')).not.toContain('filled');
    expect(rings[1].getAttribute('class')).toContain('filled');
  });

  it('en la barra del documento: hasta cinco anillos, y +N antes del primero', async () => {
    const { container } = await renderView([doc('approved')], revisions(7));
    const strip = container.querySelector('.version-strip')!;
    expect(strip).not.toBeNull();
    expect(strip.querySelectorAll('.version-ring')).toHaveLength(5);
    const more = strip.querySelector('.version-more')!;
    expect(more).not.toBeNull();
    expect(more.textContent).toBe('+2');
    // El contador va ANTES del primer anillo.
    expect([...strip.children].indexOf(more)).toBeLessThan([...strip.children].indexOf(strip.querySelector('.version-ring')!));
    expect(strip.querySelector('.version-label')!.textContent).toBe('v7 · aprobada');
  });

  it('sin aprobación el rótulo no dice aprobada', async () => {
    const { container } = await renderView([doc('review')], revisions(2));
    expect(container.querySelector('.version-label')!.textContent).toBe('v2');
    expect(container.querySelector('.version-label')!.textContent).not.toContain('aprobada');
  });

  it('cinco versiones o menos no llevan contador', async () => {
    const { container } = await renderView([doc('approved')], revisions(5));
    expect(container.querySelector('.version-strip')!.querySelectorAll('.version-ring')).toHaveLength(5);
    expect(container.querySelector('.version-more')).toBeNull();
  });

  it('sin versiones no hay tira que dibujar', async () => {
    const { container } = await renderView([doc('approved')], []);
    expect(container.querySelector('.version-strip')).toBeNull();
  });

  it('el anillo se dibuja sólo al crear una versión nueva, no al abrir la vista', async () => {
    const fresh = { ...revision(4), id: 'r-nueva' };
    mocks.listDocumentRevisions
      .mockReset()
      .mockResolvedValueOnce([revision(3), revision(2), revision(1)])
      .mockResolvedValue([fresh, revision(3), revision(2), revision(1)]);
    mocks.snapshotDocument.mockReset().mockResolvedValue(fresh);

    const { container } = render(<DocumentsView {...base} />);
    await waitFor(() => expect(container.querySelector('.version-strip')).not.toBeNull());
    // Recién abierta: ninguna versión se está dibujando.
    expect(container.querySelector('.version-ring.drawing')).toBeNull();

    const keep = [...container.querySelectorAll('.doc-actions button')].find(b => b.textContent === 'Conservar versión')!;
    fireEvent.click(keep);
    await waitFor(() => expect(container.querySelector('.version-ring.drawing')).not.toBeNull());
    expect(mocks.snapshotDocument).toHaveBeenCalledWith('a');
    expect(container.querySelector('.version-ring.drawing')!.classList.contains('filled')).toBe(true);
  });

  it('el modal de versiones respeta el tope de cinco y el contador', async () => {
    const { container } = await renderView([doc('approved')], revisions(7));
    fireEvent.click([...container.querySelectorAll('.doc-actions button')].find(b => b.textContent === 'Versiones')!);
    await waitFor(() => expect(container.querySelector('.revision-list')).not.toBeNull());
    const list = container.querySelector('.revision-list')!;
    expect(list.querySelectorAll('.version-ring')).toHaveLength(5);
    expect(list.querySelector('.version-more')!.textContent).toBe('+2');
    expect(list.querySelectorAll('.revision-version')).toHaveLength(5);
    expect(list.querySelector('.revision-version')!.textContent).toBe('v7 · aprobada');
    // Nada nuevo: nada se dibuja.
    expect(container.querySelector('.version-ring.drawing')).toBeNull();
  });
});
