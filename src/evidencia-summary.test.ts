import { describe, expect, it } from 'vitest';
import { DECISION_STATUS_TAG, DOCUMENT_KIND_TAG, EVIDENCE_TAG_KEYS, evidenciaSummary, type EvidenceInput } from './evidencia-summary';
import type { Decision, UntrackedFile, Work, WorkDocument } from '../shared/contracts';

/**
 * The pure core of the Evidencia view: the two classification maps and the
 * derived metadata.
 *
 * The maps are the acceptance-critical net: a DocumentKind mislabelled in the
 * taxonomy (research as "hipótesis", copy as "cálculo") is exactly what these
 * pins catch. `cálculo` and `hipótesis` are declared but have NO persisted
 * source in this slice, so the summary returns them structurally empty — never
 * invented — and `brief`/`copy` are `null` (artefacts, not evidence).
 *
 * No DOM, no window: this module only decides, `EvidenciaView` only renders.
 */

const work = (): Pick<Work, 'id'> => ({ id: 'w1' });

const doc = (patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: 'a', workId: 'w1', kind: 'note', title: 'Nota', fileName: 'n.md', status: 'draft',
  funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null,
  baseFingerprint: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...patch,
});

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Decisión', rationale: '', alternativesRejected: [],
  evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-01-03T00:00:00.000Z', decidedAt: null, ...patch,
});

const untracked = (patch: Partial<UntrackedFile> = {}): UntrackedFile => ({
  fileName: 'u.md', title: 'U', kind: 'note', bytes: 10, modifiedAt: '2026-01-04T00:00:00.000Z', funnelStages: [], ...patch,
});

const input = (patch: Partial<EvidenceInput> = {}): EvidenceInput => ({
  work: work(), documents: [], decisions: [], untracked: [], ...patch,
});

describe('the DocumentKind → tag map (the mislabel net)', () => {
  it('classifies every kind exactly once: brief/copy are null, the rest carry a class', () => {
    expect(DOCUMENT_KIND_TAG).toEqual({
      brief: null,
      strategy: 'recomendacion',
      calendar: 'recomendacion',
      research: 'hecho',
      copy: null,
      note: 'hecho',
    });
  });

  it('never mislabels research as "hipótesis" nor copy as "cálculo"', () => {
    expect(DOCUMENT_KIND_TAG.research).toBe('hecho');
    expect(DOCUMENT_KIND_TAG.copy).toBeNull();
  });
});

describe('the Decision.status → tag map', () => {
  it('classifies pending as a recomendación and approved as a decisión', () => {
    expect(DECISION_STATUS_TAG.pending).toBe('recomendacion');
    expect(DECISION_STATUS_TAG.approved).toBe('decision');
  });

  it('excludes rejected, archived and superseded decisions', () => {
    expect(DECISION_STATUS_TAG.rejected).toBeUndefined();
    expect(DECISION_STATUS_TAG.archived).toBeUndefined();
    expect(DECISION_STATUS_TAG.superseded).toBeUndefined();
  });
});

describe('the five-class taxonomy', () => {
  it('names every class with a catalog key of its own', () => {
    expect(EVIDENCE_TAG_KEYS).toEqual({
      hecho: 'evidencia.tag.hecho',
      calculo: 'evidencia.tag.calculo',
      hipotesis: 'evidencia.tag.hipotesis',
      recomendacion: 'evidencia.tag.recomendacion',
      decision: 'evidencia.tag.decision',
    });
  });

  it('returns cálculo and hipótesis structurally empty, never invented', () => {
    const summary = evidenciaSummary(input({
      documents: [doc({ kind: 'research' }), doc({ id: 'c', kind: 'copy' })],
    }));
    expect(summary.calculo).toEqual([]);
    expect(summary.hipotesis).toEqual([]);
  });
});

describe('the derived groups', () => {
  it('puts research and note into investigación', () => {
    const summary = evidenciaSummary(input({
      documents: [
        doc({ id: 'r', kind: 'research', title: 'Investigación' }),
        doc({ id: 'n', kind: 'note', title: 'Nota' }),
      ],
    }));
    expect(summary.investigacion.map((item) => ({ id: item.id, tag: item.tag }))).toEqual([
      { id: 'r', tag: 'hecho' },
      { id: 'n', tag: 'hecho' },
    ]);
  });

  it('puts strategy, calendar and pending decisions into recomendaciones', () => {
    const summary = evidenciaSummary(input({
      documents: [
        doc({ id: 's', kind: 'strategy', title: 'Estrategia' }),
        doc({ id: 'k', kind: 'calendar', title: 'Calendario' }),
      ],
      decisions: [decision({ id: 'p', status: 'pending', text: 'Pendiente' })],
    }));
    expect(summary.recomendaciones.map((item) => item.id)).toEqual(['s', 'k', 'p']);
    expect(summary.recomendaciones.every((item) => item.tag === 'recomendacion')).toBe(true);
  });

  it('puts approved decisions into decisiones aprobadas and ignores the rest', () => {
    const summary = evidenciaSummary(input({
      decisions: [
        decision({ id: 'a1', status: 'approved', text: 'Aprobada' }),
        decision({ id: 'r1', status: 'rejected', text: 'Rechazada' }),
        decision({ id: 'x1', status: 'archived', text: 'Archivada' }),
      ],
    }));
    expect(summary.decisionesAprobadas.map((item) => item.id)).toEqual(['a1']);
    expect(summary.recomendaciones).toEqual([]);
  });

  it('lists the untracked file names as importados', () => {
    const summary = evidenciaSummary(input({ untracked: [untracked({ fileName: 'u1.md' }), untracked({ fileName: 'u2.md' })] }));
    expect(summary.importados).toEqual(['u1.md', 'u2.md']);
  });

  it('scopes documents and decisions to the current work', () => {
    const summary = evidenciaSummary(input({
      documents: [doc({ id: 'a', workId: 'w1', kind: 'research' }), doc({ id: 'b', workId: 'w2', kind: 'research' })],
      decisions: [decision({ id: 'd1', workId: 'w1', status: 'approved' }), decision({ id: 'd2', workId: 'w2', status: 'approved' })],
    }));
    expect(summary.investigacion.map((item) => item.id)).toEqual(['a']);
    expect(summary.decisionesAprobadas.map((item) => item.id)).toEqual(['d1']);
  });
});

describe('the derived metadata', () => {
  it('derives fecha as the latest updatedAt/decidedAt across documents and decisions', () => {
    const summary = evidenciaSummary(input({
      documents: [doc({ updatedAt: '2026-01-02T00:00:00.000Z' })],
      decisions: [decision({ decidedAt: '2026-01-05T00:00:00.000Z' })],
    }));
    expect(summary.fecha).toBe('2026-01-05T00:00:00.000Z');
  });

  it('derives fecha as null when nothing has a timestamp', () => {
    const summary = evidenciaSummary(input({ documents: [doc({ updatedAt: '' })] }));
    expect(summary.fecha).toBeNull();
  });

  it('derives período as earliest createdAt → latest updatedAt', () => {
    const summary = evidenciaSummary(input({
      documents: [
        doc({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-09T00:00:00.000Z' }),
        doc({ id: 'b', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' }),
      ],
    }));
    expect(summary.periodo).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-09T00:00:00.000Z' });
  });

  it('reports "sin fuentes" only when no source document exists', () => {
    // Only a brief (encargo): not a source → "sin fuentes".
    expect(evidenciaSummary(input({ documents: [doc({ kind: 'brief' })] })).limitaciones).toEqual(['evidencia.limitacion.sinFuentes']);
    expect(evidenciaSummary(input()).limitaciones).toEqual(['evidencia.limitacion.sinFuentes']);
    // A research document is a source → no limitation.
    expect(evidenciaSummary(input({ documents: [doc({ kind: 'research' })] })).limitaciones).toEqual([]);
  });

  it('is pure: the same facts produce the same summary', () => {
    const facts = input({ documents: [doc({ kind: 'research' })], decisions: [decision({ status: 'approved' })] });
    expect(evidenciaSummary(facts)).toEqual(evidenciaSummary(facts));
  });
});
