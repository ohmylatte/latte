import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { DocumentsView, type DocumentsViewProps } from './DocumentsView';
import type { Work, WorkDocument } from '../shared/contracts';

/**
 * M1 — "la L en la espuma".
 *
 * El sello es la firma humana: aparece SÓLO cuando el documento pasó a
 * APROBADO, junto al título de la barra de herramientas y en su fila de la
 * lista. Si la aprobación se revierte, el elemento se va del DOM —sin
 * animación de salida—, que es exactamente lo que pide el brief.
 *
 * El rebote (0→1, 400 ms, `--ease-brand`) se prueba en
 * `microinteractions-motion.dom.test.tsx`, sobre la hoja: jsdom no calcula
 * animaciones, y afirmar "no se anima" sobre el DOM sería mentir.
 */

const mocks = vi.hoisted(() => ({
  readDocument: vi.fn(),
  documentState: vi.fn(),
  listDocumentRevisions: vi.fn(),
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

beforeEach(() => {
  mocks.readDocument.mockReset().mockResolvedValue({ content: '# Oferta', fingerprint: 'fp', baseOutdated: false });
  mocks.documentState.mockReset().mockResolvedValue({ documentId: 'a', fingerprint: 'fp', modifiedAt: null, baseOutdated: false });
  mocks.listDocumentRevisions.mockReset().mockResolvedValue([]);
});

describe('M1 — el sello de aprobación', () => {
  it('aparece junto al título y en la fila, sólo con el documento aprobado', async () => {
    const { container } = render(<DocumentsView {...base} />);
    await waitFor(() => expect(container.querySelector('.document-toolbar')).not.toBeNull());

    const badge = container.querySelector('.approval-badge')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('role')).toBe('status');
    const stamp = badge.querySelector('svg.approval-stamp')!;
    expect(stamp).not.toBeNull();
    expect(stamp.getAttribute('width')).toBe('34');
    expect(badge.querySelector('em')!.textContent).toBe('aprobado por vos.');

    expect(container.querySelectorAll('.doc-row .row-stamp')).toHaveLength(1);
    await act(async () => {});
  });

  it('con el documento en revisión no hay sello en ninguna de las dos superficies', async () => {
    const { container } = render(<DocumentsView {...base} documents={[doc('review')]} />);
    await waitFor(() => expect(container.querySelector('.document-toolbar')).not.toBeNull());
    expect(container.querySelector('.approval-badge')).toBeNull();
    expect(container.querySelector('.approval-stamp')).toBeNull();
    expect(container.querySelectorAll('.row-stamp')).toHaveLength(0);
    expect(container.querySelector('.doc-row .doc-status-review')).not.toBeNull();
    await act(async () => {});
  });

  it('si la aprobación se revierte, el sello desaparece del todo', async () => {
    const { container, rerender } = render(<DocumentsView {...base} />);
    await waitFor(() => expect(container.querySelector('.approval-badge')).not.toBeNull());
    rerender(<DocumentsView {...base} documents={[doc('review')]} />);
    expect(container.querySelector('.approval-badge')).toBeNull();
    expect(container.querySelector('.approval-stamp')).toBeNull();
    await act(async () => {});
  });
});
