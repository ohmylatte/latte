import type { MessageKey } from './i18n';
import type { Decision, DecisionStatus, DocumentKind, UntrackedFile, Work, WorkDocument } from '../shared/contracts';

/**
 * The pure core of the Evidencia view.
 *
 * Evidencia answers "¿qué respalda este trabajo?": it classifies the work's
 * documents and decisions into evidence classes, derived at render time from
 * `Decision.status` + `DocumentKind`. The two maps are the acceptance-critical
 * bit: they are pinned by `evidencia-summary.test.ts` so a kind can never be
 * silently mislabelled.
 *
 * The 5-class taxonomy (`hecho`, `cálculo`, `hipótesis`, `recomendación`,
 * `decisión`) is honest: `cálculo` and `hipótesis` are declared but have NO
 * persisted source in this slice, so they are returned as structurally empty
 * arrays — never invented. `brief` (el encargo) and `copy` (un entregable) are
 * `null`: they are work artefacts, not evidence.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window.
 */

/** The five evidence classes, in the taxonomy order the legend renders. */
export type EvidenceTag = 'hecho' | 'calculo' | 'hipotesis' | 'recomendacion' | 'decision';

export const EVIDENCE_TAG_KEYS: Record<EvidenceTag, MessageKey> = {
  hecho: 'evidencia.tag.hecho',
  calculo: 'evidencia.tag.calculo',
  hipotesis: 'evidencia.tag.hipotesis',
  recomendacion: 'evidencia.tag.recomendacion',
  decision: 'evidencia.tag.decision',
};

/**
 * The DocumentKind → evidence-class map. `null` means "not evidence": the brief
 * is the encargo and a copy piece is an entregable, so neither is classified.
 * `note` and `research` capture what was observed (hecho); `strategy` and
 * `calendar` propose a direction (recomendación).
 */
export const DOCUMENT_KIND_TAG: Record<DocumentKind, EvidenceTag | null> = {
  brief: null,
  strategy: 'recomendacion',
  calendar: 'recomendacion',
  research: 'hecho',
  copy: null,
  note: 'hecho',
};

/**
 * The Decision.status → evidence-class map. Only `pending` (a recomendación the
 * human has not answered) and `approved` (a decisión aprobada) are evidence.
 * `rejected`, `archived` and `superseded` are deliberately excluded.
 */
export const DECISION_STATUS_TAG: Partial<Record<DecisionStatus, EvidenceTag>> = {
  pending: 'recomendacion',
  approved: 'decision',
};

export interface EvidenceItem {
  id: string;
  title: string;
  tag: EvidenceTag;
  source: 'document' | 'decision';
}

export interface EvidencePeriod { from: string | null; to: string | null }

export interface EvidenceSummary {
  /** research + note documents (hecho observado). */
  investigacion: EvidenceItem[];
  /** strategy + calendar documents, plus pending decisions (recomendación). */
  recomendaciones: EvidenceItem[];
  /** approved decisions (decisión aprobada). */
  decisionesAprobadas: EvidenceItem[];
  /** Structurally empty: cálculo has no persisted source in this slice. */
  calculo: EvidenceItem[];
  /** Structurally empty: hipótesis has no persisted source in this slice. */
  hipotesis: EvidenceItem[];
  /** Untracked file names the agent still has to adopt (datos importados). */
  importados: string[];
  /** Latest `updatedAt`/`decidedAt`/`modifiedAt`, or null when nothing exists. */
  fecha: string | null;
  /** Earliest `createdAt` → latest `updatedAt`; equal timestamps collapse in the view. */
  periodo: EvidencePeriod;
  /** Honest caveats as catalog keys, e.g. "sin fuentes". */
  limitaciones: MessageKey[];
}

export interface EvidenceInput {
  work: Pick<Work, 'id'>;
  documents: readonly WorkDocument[];
  decisions: readonly Decision[];
  untracked: readonly UntrackedFile[];
}

const latest = (values: readonly (string | null)[]): string | null => {
  const present = values.filter((value): value is string => Boolean(value));
  return present.length > 0 ? present.reduce((a, b) => (a >= b ? a : b)) : null;
};
const earliest = (values: readonly (string | null)[]): string | null => {
  const present = values.filter((value): value is string => Boolean(value));
  return present.length > 0 ? present.reduce((a, b) => (a <= b ? a : b)) : null;
};

/** The whole classification, ready to render. Timestamps are derived, never stored. */
export function evidenciaSummary(input: EvidenceInput): EvidenceSummary {
  const workDocuments = input.documents.filter((document) => document.workId === input.work.id);
  const workDecisions = input.decisions.filter((decision) => decision.workId === input.work.id);

  const investigacion: EvidenceItem[] = [];
  const recomendaciones: EvidenceItem[] = [];
  const decisionesAprobadas: EvidenceItem[] = [];

  for (const document of workDocuments) {
    const tag = DOCUMENT_KIND_TAG[document.kind];
    if (tag === 'hecho') investigacion.push({ id: document.id, title: document.title, tag, source: 'document' });
    else if (tag === 'recomendacion') recomendaciones.push({ id: document.id, title: document.title, tag, source: 'document' });
  }
  for (const decision of workDecisions) {
    const tag = DECISION_STATUS_TAG[decision.status];
    if (tag === 'recomendacion') recomendaciones.push({ id: decision.id, title: decision.text, tag, source: 'decision' });
    else if (tag === 'decision') decisionesAprobadas.push({ id: decision.id, title: decision.text, tag, source: 'decision' });
  }

  // Derived metadata: `fecha` is the freshest signal across documents, decisions
  // and untracked files; `período` spans the work's own record.
  const fecha = latest([
    ...workDocuments.map((document) => document.updatedAt),
    ...workDecisions.map((decision) => decision.decidedAt),
    ...input.untracked.map((file) => file.modifiedAt),
  ]);
  const periodo: EvidencePeriod = {
    from: earliest([
      ...workDocuments.map((document) => document.createdAt),
      ...workDecisions.map((decision) => decision.createdAt),
    ]),
    to: latest([
      ...workDocuments.map((document) => document.updatedAt),
      ...workDecisions.map((decision) => decision.decidedAt),
    ]),
  };

  // Fuentes = the documents that carry a class (brief/copy are artefacts, not sources).
  const sourceDocuments = workDocuments.filter((document) => DOCUMENT_KIND_TAG[document.kind] !== null);
  const limitaciones: MessageKey[] = sourceDocuments.length === 0 ? ['evidencia.limitacion.sinFuentes'] : [];

  return {
    investigacion,
    recomendaciones,
    decisionesAprobadas,
    calculo: [],
    hipotesis: [],
    importados: input.untracked.map((file) => file.fileName),
    fecha,
    periodo,
    limitaciones,
  };
}
