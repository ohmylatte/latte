import type { Decision, Work, WorkDocument } from '../shared/contracts';

/**
 * ENTREGA 1A: EL MOMENTO DE VALOR.
 *
 * Brief 01, "7. Momento de valor": el cierre tiene que explicar qué contexto,
 * fuentes y permisos usó Latte y qué produjo, nunca un genérico "listo". Esta
 * es la versión mínima, real y a nivel de Trabajo: se dispara la primera vez
 * que un documento de este Trabajo deja `draft` (entra en revisión o queda
 * aprobado) — el primer resultado tangible —, y sólo cuenta lo que ya está
 * cargado (documentos y decisiones del Trabajo, si la marca tiene contexto).
 *
 * PURO: sin React ni `browser-api`, para que "cuándo aparece" y "qué cuenta"
 * se puedan probar sin un componente ni un mock del store.
 */

export interface MomentoDeValorInput {
  work: Pick<Work, 'id'>;
  documents: readonly WorkDocument[];
  decisions: readonly Decision[];
  brandContextDefined: boolean;
}

export interface MomentoDeValorSummary {
  workId: string;
  /** Documentos de este Trabajo, sin importar su estado. */
  documentCount: number;
  /** Los que están esperando una mirada. */
  reviewCount: number;
  /** Los que ya se aprobaron. */
  approvedCount: number;
  decisionCount: number;
  brandContextDefined: boolean;
}

/** El primer resultado tangible: un documento de este Trabajo que ya dejó `draft`. */
export function hasFirstResult(documents: readonly WorkDocument[], workId: string): boolean {
  return documents.some((d) => d.workId === workId && d.status !== 'draft');
}

/**
 * El resumen del cierre, o `null` mientras no haya un primer resultado que
 * cerrar. Nunca inventa una fuente o un permiso que no se haya cargado: sólo
 * cuenta lo que el llamador ya trae en `documents`/`decisions`.
 */
export function momentoDeValor(input: MomentoDeValorInput): MomentoDeValorSummary | null {
  if (!hasFirstResult(input.documents, input.work.id)) return null;
  const workDocuments = input.documents.filter((d) => d.workId === input.work.id);
  const workDecisions = input.decisions.filter((d) => d.workId === input.work.id);
  return {
    workId: input.work.id,
    documentCount: workDocuments.length,
    reviewCount: workDocuments.filter((d) => d.status === 'review').length,
    approvedCount: workDocuments.filter((d) => d.status === 'approved').length,
    decisionCount: workDecisions.length,
    brandContextDefined: input.brandContextDefined,
  };
}
