import { describe, expect, it } from 'vitest';
import { groupByStage } from './document-organizer';
import { ALL_BRAND_SCOPE, documentOriginTitle, inKnowledgeScope, selectWorkBrief, workBrief, workTitles } from './brand-knowledge';
import type { WorkDocument } from '../shared/contracts';

const doc = (patch: Partial<WorkDocument>): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Doc', fileName: 'note.md', status: 'draft',
  funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null,
  baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});

describe('brand knowledge scope', () => {
  const a = doc({ id: '1', workId: 'w1', title: 'A', funnelStages: ['discovery'] });
  const b = doc({ id: '2', workId: 'w2', title: 'B', funnelStages: ['conversion'] });

  it('defaults to the whole brand and can filter to one work without dropping provenance', () => {
    expect(inKnowledgeScope([a, b], ALL_BRAND_SCOPE).map((d) => d.id)).toEqual(['1', '2']);
    expect(inKnowledgeScope([a, b], 'w1')).toEqual([a]);
    expect(inKnowledgeScope([a, b], 'w2')[0].workId).toBe('w2');
  });

  it('builds funnel stages from the aggregated set, not from a single work', () => {
    const all = groupByStage(inKnowledgeScope([a, b], ALL_BRAND_SCOPE));
    expect(all.discovery.map((d) => d.id)).toEqual(['1']);
    expect(all.conversion.map((d) => d.id)).toEqual(['2']);
    expect(groupByStage(inKnowledgeScope([a, b], 'w1')).conversion).toEqual([]);
  });

  it('maps work titles for origin labels', () => {
    expect(workTitles([{ id: 'w1', title: 'Lanzamiento' }, { id: 'w2', title: 'Retención' }])).toEqual({
      w1: 'Lanzamiento',
      w2: 'Retención',
    });
  });

  it('selects the current work brief when switching work, without mixing origin metadata', () => {
    const launch = doc({ id: 'doc-launch', workId: 'w1', kind: 'brief', fileName: 'brief.md', title: 'Lanzamiento' });
    const retain = doc({ id: 'doc-retain', workId: 'w2', kind: 'brief', fileName: 'brief.md', title: 'Retención Q4' });
    const titles = { w1: 'Lanzamiento', w2: 'Retención Q4' };
    expect(workBrief([launch, retain], 'w2')?.id).toBe('doc-retain');
    const after = selectWorkBrief({ brand: launch.id }, 'brand', 'w2', [launch, retain]);
    expect(after.brand).toBe(retain.id);
    expect(documentOriginTitle(launch.workId, 'Retención Q4', titles)).toBe('Lanzamiento');
    expect(documentOriginTitle(retain.workId, 'Retención Q4', titles)).toBe('Retención Q4');
    expect(selectWorkBrief(after, 'brand', 'w2', [launch, retain])).toBe(after);
  });
});
