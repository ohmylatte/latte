import { describe, expect, it } from 'vitest';
import { hasFirstResult, momentoDeValor } from './momento-de-valor';
import type { Decision, DocumentStatus, WorkDocument } from '../shared/contracts';

const doc = (workId: string, status: DocumentStatus, patch: Partial<WorkDocument> = {}): WorkDocument => ({
  id: `${workId}-${status}-${Math.random()}`, workId, kind: 'strategy', title: 'Estrategia', fileName: 'strategy.md',
  status, funnelStages: [], proposedFunnelStages: [], baseDocumentId: null, baseRevisionId: null, baseFingerprint: null,
  createdAt: '', updatedAt: '', ...patch,
});

const decision = (workId: string, patch: Partial<Decision> = {}): Decision => ({
  id: `dec-${Math.random()}`, workId, text: 'Usar tono cálido', rationale: '', alternativesRejected: [], evidenceRefs: [],
  status: 'approved', source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: '', createdAt: '', decidedAt: null, ...patch,
});

describe('hasFirstResult: el primer resultado tangible de un Trabajo', () => {
  it('sin documentos, no hay resultado', () => {
    expect(hasFirstResult([], 'w1')).toBe(false);
  });

  it('un documento en borrador todavía no es un resultado', () => {
    expect(hasFirstResult([doc('w1', 'draft')], 'w1')).toBe(false);
  });

  it('un documento en revisión ya es el primer resultado', () => {
    expect(hasFirstResult([doc('w1', 'review')], 'w1')).toBe(true);
  });

  it('un documento aprobado también cuenta', () => {
    expect(hasFirstResult([doc('w1', 'approved')], 'w1')).toBe(true);
  });

  it('nunca mira el documento de OTRO Trabajo', () => {
    expect(hasFirstResult([doc('w2', 'approved')], 'w1')).toBe(false);
  });
});

describe('momentoDeValor: el resumen del cierre', () => {
  it('es null mientras no hay un primer resultado que cerrar', () => {
    expect(momentoDeValor({ work: { id: 'w1' }, documents: [doc('w1', 'draft')], decisions: [], brandContextDefined: true })).toBeNull();
  });

  it('cuenta documentos, revisión, aprobados y decisiones, sólo de este Trabajo', () => {
    const documents = [
      doc('w1', 'review'), doc('w1', 'approved'), doc('w1', 'draft'),
      doc('w2', 'approved'), // de otro Trabajo: no cuenta
    ];
    const decisions = [decision('w1'), decision('w1'), decision('w2')];
    const summary = momentoDeValor({ work: { id: 'w1' }, documents, decisions, brandContextDefined: true });
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      workId: 'w1', documentCount: 3, reviewCount: 1, approvedCount: 1, decisionCount: 2, brandContextDefined: true,
    });
  });

  it('nunca inventa el contexto de marca: lo que trae el llamador es lo que se muestra', () => {
    const documents = [doc('w1', 'review')];
    const summary = momentoDeValor({ work: { id: 'w1' }, documents, decisions: [], brandContextDefined: false });
    expect(summary?.brandContextDefined).toBe(false);
  });
});
