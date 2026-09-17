import type { MessageKey } from './i18n';
import type { Decision, Work } from '../shared/contracts';

/**
 * The pure core of the Resultados view.
 *
 * Resultados answers "¿qué entregó este trabajo?": it derives, at render time,
 * the linked `documento` (the `WorkOutcome.resultPath`) and the approved
 * decisions of this work. The `entregable` class is the self-fetching
 * `Deliverables` panel, so it is not derived here. The four remaining classes
 * — diagnóstico, experimento, cambio ejecutado, medición — are declared but
 * have NO persisted source in this slice, so the view renders them empty,
 * never invented.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window.
 */

/** The seven result classes, in the order the view renders them. */
export type ResultadoType = 'documento' | 'entregable' | 'decision' | 'diagnostico' | 'experimento' | 'cambio' | 'medicion';

export const RESULTADO_TYPE_KEYS: Record<ResultadoType, MessageKey> = {
  documento: 'resultados.documento',
  entregable: 'resultados.entregable',
  decision: 'resultados.decision',
  diagnostico: 'resultados.diagnostico',
  experimento: 'resultados.experimento',
  cambio: 'resultados.cambio',
  medicion: 'resultados.medicion',
};

/** The four result classes with no producer in this slice: declared, never invented. */
export const NON_DERIVED_RESULTADOS: readonly ResultadoType[] = ['diagnostico', 'experimento', 'cambio', 'medicion'];

/** The linked result document, present only when a `resultPath` is set. */
export interface ResultadosDocumento {
  expectedOutput: string | null;
  resultPath: string;
}

export interface ResultadosDecision {
  id: string;
  text: string;
  decidedAt: string | null;
}

export interface ResultadosSummary {
  documento: ResultadosDocumento | null;
  decisionesAprobadas: ResultadosDecision[];
}

export interface ResultadosInput {
  work: Pick<Work, 'id' | 'expectedOutput' | 'resultPath'>;
  decisions: readonly Decision[];
}

/** The whole derivation, ready to render. Timestamps are carried, never stored. */
export function resultadosSummary(input: ResultadosInput): ResultadosSummary {
  const workDecisions = input.decisions.filter((decision) => decision.workId === input.work.id);
  const decisionesAprobadas = workDecisions
    .filter((decision) => decision.status === 'approved')
    .map((decision) => ({ id: decision.id, text: decision.text, decidedAt: decision.decidedAt }));

  const resultPath = input.work.resultPath?.trim() || null;
  const expectedOutput = input.work.expectedOutput?.trim() || null;
  const documento = resultPath ? { expectedOutput, resultPath } : null;

  return { documento, decisionesAprobadas };
}
