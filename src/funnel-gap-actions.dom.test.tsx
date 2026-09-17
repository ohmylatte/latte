import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { DocumentsView } from './DocumentsView';
import type { DocumentsViewProps } from './DocumentsView';
import type { Work, WorkDocument } from '../shared/contracts';

/**
 * F8 — the empty-gap triggers, wired to the backend.
 *
 * `FunnelView` is the presentational half: it names each trigger and hands the
 * intent up as `onCreateAction(stage, kind)` / `onToggleOutOfScope(stage)`.
 * `DocumentsView` is the acting half: it maps that intent to the real APIs.
 * The mapping under test is the kind: a proposal becomes a `strategy`, while
 * analysing and experimenting are both `research` — the only two document kinds
 * the funnel can honestly start from.
 */

const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  toggleOutOfScopeStage: vi.fn(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.browserAPI,
      createDocument: mocks.createDocument,
      toggleOutOfScopeStage: mocks.toggleOutOfScopeStage,
    },
  };
});

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, outOfScopeStages: [], updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});

const base: DocumentsViewProps = {
  work: work(),
  brandName: 'Casa Oliva',
  documents: [] as WorkDocument[],
  selectedId: null,
  onSelect: () => {},
  onDocumentsChanged: async () => {},
  onWorkUpdated: () => {},
  onDirtyChange: () => {},
  onNotice: () => {},
  onError: () => {},
  onCreate: () => {},
  onUseFolder: () => {},
  funnel: true,
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

const gapButton = (container: HTMLElement, stage: string, label: string): HTMLButtonElement => {
  const gap = container.querySelector<HTMLElement>(`.funnel-gap[data-stage="${stage}"]`)!;
  return Array.from(gap.querySelectorAll('button')).find((b) => b.textContent === label)!;
};

beforeEach(() => {
  mocks.createDocument.mockReset();
  mocks.toggleOutOfScopeStage.mockReset();
});

describe('F8 — the gap triggers reach the backend with the right kind', () => {
  it('maps "Preparar propuesta" to a strategy document', () => {
    const { container } = render(<DocumentsView {...base} />);
    fireEvent.click(gapButton(container, 'discovery', 'Preparar propuesta'));
    expect(mocks.createDocument).toHaveBeenCalledWith('w1', 'strategy', 'Propuesta · Descubrimiento');
    expect(mocks.toggleOutOfScopeStage).not.toHaveBeenCalled();
  });

  it('maps "Analizar" and "Crear experimento" to research documents', () => {
    const { container } = render(<DocumentsView {...base} />);
    fireEvent.click(gapButton(container, 'discovery', 'Analizar'));
    fireEvent.click(gapButton(container, 'discovery', 'Crear experimento'));
    expect(mocks.createDocument).toHaveBeenCalledWith('w1', 'research', 'Análisis · Descubrimiento');
    expect(mocks.createDocument).toHaveBeenCalledWith('w1', 'research', 'Experimento · Descubrimiento');
    // Never a strategy, never anything but the two honest kinds.
    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
  });

  it('names the target stage in the created document title', () => {
    const { container } = render(<DocumentsView {...base} />);
    fireEvent.click(gapButton(container, 'retention', 'Preparar propuesta'));
    expect(mocks.createDocument).toHaveBeenCalledWith('w1', 'strategy', 'Propuesta · Retención');
  });

  it('marks "Fuera de alcance" through the out-of-scope toggle', () => {
    const { container } = render(<DocumentsView {...base} />);
    fireEvent.click(gapButton(container, 'discovery', 'Fuera de alcance'));
    expect(mocks.toggleOutOfScopeStage).toHaveBeenCalledWith('w1', 'discovery');
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });
});
