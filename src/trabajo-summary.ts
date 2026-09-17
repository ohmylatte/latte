import type { MessageKey } from './i18n';
import type { Decision, DocumentKind, DocumentState, DocumentStatus, HandoffRequest, TeamMember, Work, WorkDocument } from '../shared/contracts';
import { needsReview } from './document-organizer';
import { orientationSummary, type OrientationStep } from './orientation-summary';
import { resumenEstado, RESUMEN_ESTADO_KEYS, type ResumenEstado } from './resumen-summary';

/**
 * The pure core of the Trabajo view.
 *
 * Trabajo answers "¿cómo viene el trabajo?": the current encargo, the documents
 * in scope, the permission requests, the real progress and the one next step.
 * Every decision lives here so it can be tested without a document, and so the
 * ladder has exactly ONE implementation: this module reuses `orientationSummary`
 * for the next step and `resumenEstado` for the estado, it never re-derives
 * either. The document rows reuse `needsReview` for the same reason.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window.
 */

/** A document as the Trabajo lists it: title, kind, status and the review flag. */
export interface TrabajoDocumentRow {
  id: string;
  title: string;
  kind: DocumentKind;
  status: DocumentStatus;
  needsReview: boolean;
}

export interface TrabajoInput {
  work: Pick<Work, 'id' | 'title' | 'brief' | 'expectedOutput' | 'resultPath'>;
  documents: readonly WorkDocument[];
  decisions: readonly Decision[];
  states: Readonly<Record<string, DocumentState>>;
  checking: boolean;
  team: readonly TeamMember[];
  handoffs: readonly HandoffRequest[];
  /** True while an agent session of this work is running. */
  live: boolean;
  brandContextDefined: boolean;
}

export interface TrabajoSummary {
  // encargo actual
  title: string;
  brief: string;
  expectedOutput: string | null;
  resultPath: string | null;
  // documentos en alcance
  documents: TrabajoDocumentRow[];
  // solicitudes de permiso
  handoffs: readonly HandoffRequest[];
  // estado + progreso
  estado: ResumenEstado;
  estadoKey: MessageKey;
  live: boolean;
  workingMembers: number;
  reviewDocuments: number | null;
  pendingDecisions: number;
  // próximos pasos (la escalera reutilizada)
  step: OrientationStep;
  stepKey: MessageKey;
  stepParams: Record<string, string | number>;
}

/** The whole summary, ready to render. The ladder and the estado are reused, never re-derived. */
export function trabajoSummary(input: TrabajoInput): TrabajoSummary {
  // Scope to THIS work: a multi-work brand must never leak another work's
  // documents or decisions into the list and the counts the surface renders.
  const workDocuments = input.documents.filter((document) => document.workId === input.work.id);
  const workDecisions = input.decisions.filter((decision) => decision.workId === input.work.id);
  const pendingDecisions = workDecisions.filter((decision) => decision.status === 'pending');
  const reviewDocuments = workDocuments.filter((document) => needsReview(document, input.states[document.id]?.baseOutdated ?? false)).length;
  const workingMembers = input.team.filter((member) => member.status === 'working').length;
  const ladder = orientationSummary({
    brandContextDefined: input.brandContextDefined,
    pendingDecisions: pendingDecisions.length,
    reviewDocuments,
    expectedOutput: input.work.expectedOutput ?? '',
    checking: input.checking,
  });
  const estado = resumenEstado({
    live: input.live,
    team: input.team,
    reviewDocuments,
    pendingDecisions: pendingDecisions.length,
  });
  return {
    title: input.work.title,
    brief: input.work.brief,
    expectedOutput: ladder.expectedOutput,
    resultPath: input.work.resultPath ?? null,
    documents: workDocuments.map((document) => ({
      id: document.id,
      title: document.title,
      kind: document.kind,
      status: document.status,
      needsReview: needsReview(document, input.states[document.id]?.baseOutdated ?? false),
    })),
    handoffs: input.handoffs,
    estado,
    estadoKey: RESUMEN_ESTADO_KEYS[estado],
    live: input.live,
    workingMembers,
    reviewDocuments: ladder.reviewDocuments,
    pendingDecisions: pendingDecisions.length,
    step: ladder.step,
    stepKey: ladder.stepKey,
    stepParams: ladder.stepParams,
  };
}
