import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FunnelView } from './FunnelView';
import type { WorkDocument } from '../shared/contracts';

/**
 * M5 — "la etapa vacía". An empty funnel stage is not hidden: it shows a dotted
 * box that names the gap ("etapa vacía") and says no one is tending it. A
 * document that lives in several stages keeps its home stage and marks the
 * later appearances "mismo archivo ↔" instead of reading as a duplicate.
 */

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w', kind: 'note', title: 'Un documento', fileName: 'nota.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});

const renderFunnel = (documents: WorkDocument[]) =>
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
