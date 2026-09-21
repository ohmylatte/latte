import { describe, expect, it } from 'vitest';
import { CYCLE_PHASES, RESUMEN_ESTADO_KEYS, resumenEstado, resumenSummary, type ResumenEstadoInput, type ResumenInput } from './resumen-summary';
import { orientationSummary } from './orientation-summary';
import { needsReview } from './document-organizer';
import { EMPTY_USAGE, type Decision, type DocumentState, type TeamMember, type Work, type WorkDocument } from '../shared/contracts';

/**
 * The pure core of the Resumen: which "estado actual" wins, how the pending
 * decisions and the cycle feed are shaped, and — the acceptance-critical bit —
 * that the next-step ladder is REUSED from `orientation-summary`, never forked.
 *
 * No DOM, no window: this module only decides, `ResumenView` only renders.
 */

const work = (patch: Partial<Pick<Work, 'id' | 'title' | 'brief' | 'folder' | 'expectedOutput' | 'resultPath'>> = {}): Pick<Work, 'id' | 'title' | 'brief' | 'folder' | 'expectedOutput' | 'resultPath'> => ({
  id: 'w1',
  title: 'Lanzamiento',
  brief: 'Lanzar la campaña de primavera.',
  folder: 'C:\\casa-oliva\\primavera',
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

const outdated = (id: string): DocumentState => ({ documentId: id, fingerprint: 'fp', modifiedAt: null, baseOutdated: true });

const input = (patch: Partial<ResumenInput> = {}): ResumenInput => ({
  brandName: 'Casa Oliva',
  work: work(),
  documents: [],
  states: {},
  checking: false,
  decisions: [],
  team: [],
  live: false,
  brandContextDefined: true,
  ...patch,
});

const ladder = (patch: Partial<ResumenEstadoInput> = {}): ResumenEstadoInput => ({
  live: false,
  team: [],
  reviewDocuments: 0,
  pendingDecisions: 0,
  ...patch,
});

describe('the derived estado actual ladder', () => {
  it('is live while an agent session is running, outranking everything else', () => {
    expect(resumenEstado(ladder({ live: true, team: [{ status: 'working' }], reviewDocuments: 2, pendingDecisions: 3 }))).toBe('live');
  });

  it('is working while a team member is answering, above review and decisions', () => {
    expect(resumenEstado(ladder({ team: [{ status: 'working' }], reviewDocuments: 2, pendingDecisions: 1 }))).toBe('working');
  });

  it('asks for a review before naming pending decisions', () => {
    expect(resumenEstado(ladder({ reviewDocuments: 2, pendingDecisions: 1 }))).toBe('review');
  });

  it('names pending decisions only when nothing is being reviewed', () => {
    expect(resumenEstado(ladder({ pendingDecisions: 1 }))).toBe('decisions');
  });

  it('is idle only when every fact is clear', () => {
    expect(resumenEstado(ladder())).toBe('idle');
  });

  it('never lets a working member outrank a live session', () => {
    expect(resumenEstado(ladder({ live: true }))).toBe('live');
  });

  it('names every estado with a catalog key of its own', () => {
    expect(RESUMEN_ESTADO_KEYS).toEqual({
      live: 'resumen.estado.live',
      working: 'resumen.estado.working',
      review: 'resumen.estado.review',
      decisions: 'resumen.estado.decisions',
      idle: 'resumen.estado.idle',
    });
  });
});

describe('the cycle feed', () => {
  it('is the five phases, in order, each naming the surface that feeds it', () => {
    expect(CYCLE_PHASES.map((phase) => phase.id)).toEqual(['observar', 'entender', 'decidir', 'actuar', 'medir']);
    expect(CYCLE_PHASES).toEqual([
      { id: 'observar', labelKey: 'cycle.observar', feedKey: 'cycle.observar.note' },
      { id: 'entender', labelKey: 'cycle.entender', feedKey: 'cycle.entender.note' },
      { id: 'decidir', labelKey: 'cycle.decidir', feedKey: 'cycle.decidir.note' },
      { id: 'actuar', labelKey: 'cycle.actuar', feedKey: 'cycle.actuar.note' },
      { id: 'medir', labelKey: 'cycle.medir', feedKey: 'cycle.medir.note' },
    ]);
  });
});

describe('the summary the Resumen renders', () => {
  it('reuses the orientation ladder: the step is orientationSummary step for the same facts (no fork)', () => {
    const facts = input({
      brandContextDefined: true,
      decisions: [decision(), decision({ id: 'd2' })],
      documents: [doc({ id: 'a', status: 'review' })],
    });
    const summary = resumenSummary(facts);
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

  it('counts a review from the document status and from a moved base', () => {
    const summary = resumenSummary(input({
      documents: [
        doc({ id: 'a', status: 'review' }),
        doc({ id: 'b', status: 'approved' }),
        doc({ id: 'c', status: 'draft' }),
      ],
      states: { b: outdated('b') },
    }));
    expect(summary.reviewDocuments).toBe(2);
  });

  it('reports a review count of null only while the first sweep has not answered', () => {
    expect(resumenSummary(input({ checking: true })).reviewDocuments).toBeNull();
    expect(resumenSummary(input({ checking: false })).reviewDocuments).toBe(0);
    expect(resumenSummary(input({ checking: true, documents: [doc({ status: 'review' })] })).reviewDocuments).toBe(1);
  });

  it('turns an absent expected output into null, and trims the one there is', () => {
    expect(resumenSummary(input({ work: work({ expectedOutput: '' }) })).expectedOutput).toBeNull();
    expect(resumenSummary(input({ work: work({ expectedOutput: '   ' }) })).expectedOutput).toBeNull();
    expect(resumenSummary(input({ work: work({ expectedOutput: '  Un PDF  ' }) })).expectedOutput).toBe('Un PDF');
  });

  it('carries the pending decisions as rows, and only the pending ones', () => {
    const summary = resumenSummary(input({
      decisions: [
        decision({ id: 'd1', text: 'Elegimos X' }),
        decision({ id: 'd2', status: 'approved', text: 'Ya decidido' }),
        decision({ id: 'd3', status: 'rejected', text: 'Descartado' }),
      ],
    }));
    expect(summary.pendingDecisions).toEqual([{ id: 'd1', text: 'Elegimos X', createdAt: '' }]);
  });

  it('scopes documents and decisions to the current work, not the whole brand', () => {
    const summary = resumenSummary(input({
      documents: [
        doc({ id: 'a', workId: 'w1', status: 'review' }),
        doc({ id: 'b', workId: 'w1', status: 'draft' }),
        doc({ id: 'c', workId: 'w2', status: 'review' }), // another work — must NOT count
      ],
      decisions: [
        decision({ id: 'd1', workId: 'w1', text: 'De este trabajo' }),
        decision({ id: 'd2', workId: 'w2', text: 'De otro trabajo' }), // must NOT appear
      ],
    }));
    expect(summary.reviewDocuments).toBe(1);
    expect(summary.pendingDecisions).toEqual([{ id: 'd1', text: 'De este trabajo', createdAt: '' }]);
  });

  it('derives estado actual and names it with its key', () => {
    expect(resumenSummary(input({ live: true })).estado).toBe('live');
    expect(resumenSummary(input({ live: true })).estadoKey).toBe('resumen.estado.live');
    expect(resumenSummary(input({ team: [member({ status: 'working' })] })).estado).toBe('working');
    expect(resumenSummary(input({ documents: [doc({ status: 'review' })] })).estado).toBe('review');
    expect(resumenSummary(input({ decisions: [decision()] })).estado).toBe('decisions');
    expect(resumenSummary(input()).estado).toBe('idle');
  });

  it('passes the objective, the folder and the brand name through unchanged', () => {
    const summary = resumenSummary(input({
      brandName: 'Casa Oliva',
      work: work({ title: 'Lanzamiento', brief: 'Lanzar la campaña.', folder: 'C:\\oliva', expectedOutput: 'Un PDF', resultPath: 'propuesta.pdf' }),
    }));
    expect(summary.title).toBe('Lanzamiento');
    expect(summary.brief).toBe('Lanzar la campaña.');
    expect(summary.folder).toBe('C:\\oliva');
    expect(summary.resultPath).toBe('propuesta.pdf');
    expect(summary.brandName).toBe('Casa Oliva');
  });

  it('exposes the cycle feed for the presentational map', () => {
    expect(resumenSummary(input()).cycle).toBe(CYCLE_PHASES);
  });

  it('is pure: the same facts produce the same summary', () => {
    const facts = input({ decisions: [decision()], documents: [doc({ status: 'review' })], checking: true });
    expect(resumenSummary(facts)).toEqual(resumenSummary(facts));
  });
});

describe('the bitácora (additive, autonomous-coordination Phase 7 task 7.3)', () => {
  it('is empty when no dispatch log and no hires are given', () => {
    expect(resumenSummary(input()).bitacoraRows).toEqual([]);
  });

  it('derives one row per coordination_dispatch entry, strictly from its own timestamps', () => {
    const summary = resumenSummary(input({
      coordinationLog: [
        { id: 'cd1', taskId: 't1', memberId: 'm1', status: 'reported', outcome: 'succeeded', promptPreview: '', summaryPreview: null, createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:01:00.000Z', settledAt: '2026-09-01T10:05:00.000Z' },
      ],
    }));
    expect(summary.bitacoraRows).toEqual([
      { kind: 'dispatch', id: 'cd1', taskId: 't1', memberId: 'm1', status: 'reported', at: '2026-09-01T10:00:00.000Z' },
    ]);
  });

  it('adds one row for a member hired by an approved proposal, distinct from a dispatch row', () => {
    const summary = resumenSummary(input({
      coordinationHires: [{ memberId: 'm2', roleName: 'Diseñador', hiredAt: '2026-09-01T09:00:00.000Z' }],
    }));
    expect(summary.bitacoraRows).toEqual([
      { kind: 'hire', id: 'hire:m2:0', memberId: 'm2', roleName: 'Diseñador', at: '2026-09-01T09:00:00.000Z' },
    ]);
  });

  it('merges dispatch and hire rows in chronological order, oldest first', () => {
    const summary = resumenSummary(input({
      coordinationLog: [
        { id: 'cd1', taskId: 't1', memberId: 'm1', status: 'reported', outcome: null, promptPreview: '', summaryPreview: null, createdAt: '2026-09-01T10:00:00.000Z', startedAt: null, settledAt: null },
      ],
      coordinationHires: [{ memberId: 'm2', roleName: 'Diseñador', hiredAt: '2026-09-01T09:00:00.000Z' }],
    }));
    expect(summary.bitacoraRows.map((r) => r.kind)).toEqual(['hire', 'dispatch']);
  });
});
