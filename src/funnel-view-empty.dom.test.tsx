import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { FunnelView } from './FunnelView';
import type { FunnelStage, WorkDocument } from '../shared/contracts';

/**
 * M5 — "la etapa vacía". An empty funnel stage is not hidden: it shows a dotted
 * box that names the gap ("etapa vacía") and says no one is tending it. A
 * document that lives in several stages keeps its home stage and marks the
 * later appearances "mismo archivo ↔" instead of reading as a duplicate.
 *
 * F8 — an empty gap is also actionable: five triggers (analyze, propose,
 * experiment, associate an existing piece, mark out of scope) close the gap.
 * Out-of-scope stages stay visible but muted, with an undo to restore them.
 */

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w', kind: 'note', title: 'Un documento', fileName: 'nota.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});

interface Overrides {
  currentWorkId?: string | null;
  outOfScopeStages?: FunnelStage[];
  onCreateAction?: (stage: FunnelStage, kind: 'analyze' | 'propose' | 'experiment') => void;
  onAssociate?: (documentId: string, stage: FunnelStage) => void;
  onToggleOutOfScope?: (stage: FunnelStage) => void;
}

const renderFunnel = (documents: WorkDocument[], overrides: Overrides = {}) =>
  render(
    <FunnelView
      documents={documents}
      selectedId={null}
      states={{}}
      checking={false}
      onRefresh={() => {}}
      onSelect={() => {}}
      busy={false}
      currentWorkId="w"
      workTitles={{}}
      outOfScopeStages={[]}
      onCreateAction={() => {}}
      onAssociate={() => {}}
      onToggleOutOfScope={() => {}}
      {...overrides}
    />,
  );

describe('M5 — empty funnel stage', () => {
  it('shows the empty stage as a dotted box with the brand copy', () => {
    const { container, getAllByText } = renderFunnel([doc({ funnelStages: ['discovery'] })]);
    // discovery is the only populated stage; consideration/conversion/retention are empty
    expect(container.querySelectorAll('.funnel-gap')).toHaveLength(3);
    expect(getAllByText('etapa vacía').length).toBeGreaterThanOrEqual(3);
    expect(getAllByText('nadie la está atendiendo').length).toBeGreaterThanOrEqual(3);
  });

  it('hides the empty-stage copy when every stage has a document', () => {
    const { container } = renderFunnel([
      doc({ id: '1', funnelStages: ['discovery'] }),
      doc({ id: '2', funnelStages: ['consideration'] }),
      doc({ id: '3', funnelStages: ['conversion'] }),
      doc({ id: '4', funnelStages: ['retention'] }),
    ]);
    expect(container.querySelector('.funnel-gap')).toBeNull();
  });

  it('marks the second appearance of a multi-stage document', () => {
    const { container, getAllByText } = renderFunnel([
      doc({ id: 'multi', funnelStages: ['discovery', 'conversion'] }),
    ]);
    expect(container.querySelectorAll('.funnel-card.repeat')).toHaveLength(1);
    expect(getAllByText('mismo archivo ↔')).toHaveLength(1);
  });

  it('shows the approval stamp only on approved documents', () => {
    const { container } = renderFunnel([
      doc({ id: 'a', title: 'Aprobado', status: 'approved', funnelStages: ['discovery'] }),
      doc({ id: 'b', title: 'Borrador', status: 'draft', funnelStages: ['consideration'] }),
    ]);
    expect(container.querySelectorAll('.row-stamp')).toHaveLength(1);
  });
});

describe('F8 — actionable empty gap', () => {
  it('renders the five gap actions in every empty stage', () => {
    const { container, getAllByText } = renderFunnel([doc({ funnelStages: ['discovery'] })]);
    expect(container.querySelectorAll('.funnel-gap-actions')).toHaveLength(3);
    expect(getAllByText('Analizar')).toHaveLength(3);
    expect(getAllByText('Preparar propuesta')).toHaveLength(3);
    expect(getAllByText('Crear experimento')).toHaveLength(3);
    expect(getAllByText('Asociar pieza')).toHaveLength(3);
    expect(getAllByText('Fuera de alcance')).toHaveLength(3);
  });

  it('opens the associate picker listing only this work’s available pieces', () => {
    const onAssociate = vi.fn();
    const { container } = renderFunnel([
      doc({ id: 'a', title: 'Propuesta', funnelStages: ['discovery'] }),
      doc({ id: 'b', title: 'Análisis', funnelStages: [] }),
      doc({ id: 'c', title: 'Ajeno', workId: 'other', funnelStages: [] }),
    ], { onAssociate });
    const gap = container.querySelector('.funnel-gap[data-stage="consideration"]')!;
    fireEvent.click(Array.from(gap.querySelectorAll('button')).find(b => b.textContent === 'Asociar pieza')!);
    const picker = container.querySelector('.funnel-associate')!;
    expect(picker).toBeTruthy();
    // Both pieces of this work are candidates; another work's piece is not.
    expect(picker.querySelector('button[data-document-id="a"]')).toBeTruthy();
    expect(picker.querySelector('button[data-document-id="b"]')).toBeTruthy();
    expect(picker.querySelector('button[data-document-id="c"]')).toBeNull();
    fireEvent.click(picker.querySelector('button[data-document-id="b"]')!);
    expect(onAssociate).toHaveBeenCalledWith('b', 'consideration');
  });

  it('shows the empty message when this work has no candidate piece to associate', () => {
    const { container, getByText } = renderFunnel([doc({ id: 'a', funnelStages: ['discovery'] })], { currentWorkId: 'other' });
    const gap = container.querySelector('.funnel-gap[data-stage="consideration"]')!;
    fireEvent.click(Array.from(gap.querySelectorAll('button')).find(b => b.textContent === 'Asociar pieza')!);
    expect(getByText('No hay piezas de este trabajo para asociar a esta etapa.')).toBeTruthy();
  });

  it('marks an out-of-scope stage muted with an undo action, and leaves it out of the actionable list', () => {
    const onToggleOutOfScope = vi.fn();
    const { container } = renderFunnel([doc({ id: 'a', funnelStages: ['discovery'] })], { outOfScopeStages: ['retention'], onToggleOutOfScope });
    const parked = container.querySelector('.funnel-gap.out-of-scope[data-stage="retention"]')!;
    expect(parked).toBeTruthy();
    expect(parked.textContent).toContain('fuera de alcance');
    // consideration + conversion remain actionable; retention is parked, not a gap action row.
    expect(container.querySelectorAll('.funnel-gap-actions')).toHaveLength(2);
    fireEvent.click(Array.from(parked.querySelectorAll('button')).find(b => b.textContent === 'Desmarcar')!);
    expect(onToggleOutOfScope).toHaveBeenCalledWith('retention');
  });
});
