import { describe, expect, it } from 'vitest';
import { trabajoSummary, type TrabajoInput } from './trabajo-summary';
import { orientationSummary } from './orientation-summary';
import { needsReview } from './document-organizer';
import { EMPTY_USAGE, type Decision, type DocumentState, type HandoffRequest, type TeamMember, type Work, type WorkDocument } from '../shared/contracts';

/**
 * The pure core of the Trabajo view: which encargo to show, which documents and
 * handoffs are in scope, how the estado and the counts are derived, and — the
 * acceptance-critical bit — that the next-step ladder is REUSED from
 * `orientation-summary`, never forked.
 *
 * No DOM, no window: this module only decides, `TrabajoView` only renders.
 */

const work = (patch: Partial<Pick<Work, 'id' | 'title' | 'brief' | 'expectedOutput' | 'resultPath'>> = {}): Pick<Work, 'id' | 'title' | 'brief' | 'expectedOutput' | 'resultPath'> => ({
  id: 'w1',
  title: 'Lanzamiento',
  brief: 'Lanzar la campaña de primavera.',
  expectedOutput: 'Un PDF de dos páginas',
  resultPath: 'propuesta.pdf',
  ...patch,
});

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Una campaña con nombre', fileName: 'oferta.md',
  status: 'draft', funnelStages: [], proposedFunnelStages: [], baseDocumentId: null,
  baseRevisionId: null, baseFingerprint: null, createdAt: '', updatedAt: '', ...patch,
});

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos un tono cercano', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '', decidedAt: null, ...patch,
});

const member = (patch: Partial<TeamMember> = {}): TeamMember => ({
  id: 'm1', workId: 'w1', roleId: 'r1', roleName: 'Estratega', initial: 'E',
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'idle',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});

const handoff = (patch: Partial<HandoffRequest> = {}): HandoffRequest => ({
  fileName: 'brief.md', roleId: 'r2', roleName: 'Diseñadora', known: false, request: 'Necesito a alguien de diseño.', ...patch,
});

const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const input = (patch: Partial<TrabajoInput> = {}): TrabajoInput => ({
  work: work(),
  documents: [],
  decisions: [],
  states: {},
  checking: false,
  team: [],
  handoffs: [],
  live: false,
  brandContextDefined: true,
  ...patch,
});

describe('the derived trabajo summary', () => {
  it('reuses the orientation ladder: the step is orientationSummary step for the same facts (no fork)', () => {
    const facts = input({
      brandContextDefined: true,
      decisions: [decision(), decision({ id: 'd2' })],
      documents: [doc({ id: 'a', status: 'review' })],
    });
    const summary = trabajoSummary(facts);
    const reference = orientationSummary({
      brandContextDefined: facts.brandContextDefined,
      pendingDecisions: facts.decisions.filter((d) => d.status === 'pending').length,
      reviewDocuments: facts.documents.filter((d) => needsReview(d, facts.states[d.id]?.baseOutdated ?? false)).length,
      expectedOutput: facts.work.expectedOutput ?? '',
      checking: facts.checking,
    });
    expect(summary.step).toBe(reference.step);
    expect(summary.stepKey).toBe(reference.stepKey);
    expect(summary.stepParams).toEqual(reference.stepParams);
  });

  it('scopes documents and decisions to the current work, not the whole brand', () => {
    const summary = trabajoSummary(input({
      documents: [
        doc({ id: 'a', workId: 'w1', kind: 'note' }),
        doc({ id: 'c', workId: 'w2', kind: 'research' }), // another work — must NOT appear
      ],
      decisions: [
        decision({ id: 'd1', workId: 'w1' }),
        decision({ id: 'd2', workId: 'w2' }), // another work — must NOT count
      ],
    }));
    expect(summary.documents.map((d) => d.id)).toEqual(['a']);
    expect(summary.pendingDecisions).toBe(1);
  });

  it('derives estado actual with the resumen precedence (live > working > review > decisions > idle)', () => {
    expect(trabajoSummary(input({ live: true })).estado).toBe('live');
    expect(trabajoSummary(input({ team: [member({ status: 'working' })] })).estado).toBe('working');
    expect(trabajoSummary(input({ documents: [doc({ status: 'review' })] })).estado).toBe('review');
    expect(trabajoSummary(input({ decisions: [decision()] })).estado).toBe('decisions');
    expect(trabajoSummary(input()).estado).toBe('idle');
  });

  it('counts the working members and the documents that ask for a look', () => {
    const summary = trabajoSummary(input({
      team: [
        member({ status: 'working' }),
        member({ id: 'm2', status: 'working' }),
        member({ id: 'm3', status: 'idle' }),
      ],
      documents: [
        doc({ id: 'a', status: 'review' }),
        doc({ id: 'b', status: 'approved' }),
      ],
      states: { b: outdated('b') },
    }));
    expect(summary.workingMembers).toBe(2);
    expect(summary.reviewDocuments).toBe(2);
  });

  it('flags the documents that need review, from status and a moved base', () => {
    const summary = trabajoSummary(input({
      documents: [
        doc({ id: 'a', status: 'review' }),
        doc({ id: 'b', status: 'draft' }),
        doc({ id: 'c', status: 'approved' }),
      ],
      states: { c: outdated('c') },
    }));
    expect(summary.documents.find((d) => d.id === 'a')?.needsReview).toBe(true);
    expect(summary.documents.find((d) => d.id === 'b')?.needsReview).toBe(false);
    expect(summary.documents.find((d) => d.id === 'c')?.needsReview).toBe(true);
  });

  it('passes the handoffs through unchanged', () => {
    const handoffs = [handoff(), handoff({ fileName: 'otro.md' })];
    expect(trabajoSummary(input({ handoffs })).handoffs).toEqual(handoffs);
  });

  it('is honest about an empty work: no documents, no handoffs, idle', () => {
    const summary = trabajoSummary(input());
    expect(summary.documents).toEqual([]);
    expect(summary.handoffs).toEqual([]);
    expect(summary.estado).toBe('idle');
    expect(summary.pendingDecisions).toBe(0);
    expect(summary.reviewDocuments).toBe(0);
  });

  it('passes the encargo facts through unchanged', () => {
    const summary = trabajoSummary(input({
      work: work({ title: 'Lanzamiento', brief: 'Lanzar.', expectedOutput: 'Un PDF', resultPath: 'p.pdf' }),
    }));
    expect(summary.title).toBe('Lanzamiento');
    expect(summary.brief).toBe('Lanzar.');
    expect(summary.expectedOutput).toBe('Un PDF');
    expect(summary.resultPath).toBe('p.pdf');
  });
});
