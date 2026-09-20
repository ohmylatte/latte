import type { MessageKey } from './i18n';
import type { CoordinationDispatchStatus, CoordinationLogEntryView, Decision, DocumentState, TeamMember, Work, WorkDocument } from '../shared/contracts';
import { needsReview } from './document-organizer';
import { orientationSummary, type OrientationStep } from './orientation-summary';

/**
 * The pure core of the Resumen.
 *
 * The Resumen is the first in-work tab answering "¿dónde estamos?": the
 * current state of the work, the objective, the expected output, the brand and
 * scope, the pending decisions, the authorized actions, and — the one thing it
 * must not duplicate — the next-step ladder. Every decision lives here so it
 * can be tested without a document, and so the ladder has exactly ONE
 * implementation: this module reuses `orientationSummary` for the ladder and
 * `needsReview` for the review count, it never re-derives either.
 *
 * This module must stay free of React and of `browser-api`: importing it in a
 * Node test must not touch a window.
 */

/** The five estados of a work, in precedence order. */
export type ResumenEstado = 'live' | 'working' | 'review' | 'decisions' | 'idle';

export const RESUMEN_ESTADO_KEYS: Record<ResumenEstado, MessageKey> = {
  live: 'resumen.estado.live',
  working: 'resumen.estado.working',
  review: 'resumen.estado.review',
  decisions: 'resumen.estado.decisions',
  idle: 'resumen.estado.idle',
};

/** The five phases of the cycle, in order. Each names the surface that feeds it. */
export type CyclePhaseId = 'observar' | 'entender' | 'decidir' | 'actuar' | 'medir';
export interface CyclePhase { id: CyclePhaseId; labelKey: MessageKey; feedKey: MessageKey }

/** The cycle is a status map, not a wizard: fixed order, no next/back, no index. */
export const CYCLE_PHASES: readonly CyclePhase[] = [
  { id: 'observar', labelKey: 'cycle.observar', feedKey: 'cycle.observar.note' },
  { id: 'entender', labelKey: 'cycle.entender', feedKey: 'cycle.entender.note' },
  { id: 'decidir', labelKey: 'cycle.decidir', feedKey: 'cycle.decidir.note' },
  { id: 'actuar', labelKey: 'cycle.actuar', feedKey: 'cycle.actuar.note' },
  { id: 'medir', labelKey: 'cycle.medir', feedKey: 'cycle.medir.note' },
];

/** Everything the Resumen needs, already reduced to what it decides on. */
export interface ResumenInput {
  brandName: string;
  work: Pick<Work, 'id' | 'title' | 'brief' | 'folder' | 'expectedOutput' | 'resultPath'>;
  documents: readonly WorkDocument[];
  states: Readonly<Record<string, DocumentState>>;
  checking: boolean;
  decisions: readonly Decision[];
  team: readonly TeamMember[];
  /** True while an agent session of this work is running (`contextStatus.works[].live`). */
  live: boolean;
  brandContextDefined: boolean;
  /** Additive, optional (autonomous-coordination Phase 7 task 7.3): the Work's coordination bitácora, oldest first. `undefined` when the caller has not wired coordination state — the caller (`ResumenView`) keeps the whole section hidden, distinct from a wired-but-empty run. */
  coordinationLog?: readonly CoordinationLogEntryView[];
  coordinationHires?: readonly CoordinationHireEvent[];
}

/** The narrowed facts `resumenEstado` decides on, testable in isolation. */
export interface ResumenEstadoInput {
  live: boolean;
  team: readonly Pick<TeamMember, 'status'>[];
  reviewDocuments: number;
  pendingDecisions: number;
}

export interface ResumenDecisionRow {
  id: string;
  text: string;
  createdAt: string;
}

/**
 * One member hired by an approved coordination proposal (autonomous-
 * coordination, Phase 7 task 7.3) — how a caller (`useCoordination`, Phase
 * 7.11) reports a team that grew while the person was away, so it becomes a
 * bitácora event rather than a silent surprise.
 */
export interface CoordinationHireEvent {
  memberId: string;
  roleName: string;
  hiredAt: string;
}

/**
 * One bitácora row: either a `coordination_dispatch` lifecycle event (derived
 * strictly from `CoordinationLogEntryView`'s own timestamps — never narrative
 * text) or a member hired by an approved proposal. Merged and sorted
 * chronologically, oldest first, matching `listCoordinationLog`'s own order.
 */
export type BitacoraRow =
  | { kind: 'dispatch'; id: string; taskId: string; memberId: string; status: CoordinationDispatchStatus; at: string }
  | { kind: 'runDone'; id: string; tasksDone: number; tasksFailed: number; at: string }
  | { kind: 'runCancelled'; id: string; tasksDone: number; tasksFailed: number; tasksPending: number; at: string }
  | { kind: 'hire'; id: string; memberId: string; roleName: string; at: string };

/** Pure merge + sort: no invented rows, no invented order. */
export function bitacoraRows(log: readonly CoordinationLogEntryView[], hires: readonly CoordinationHireEvent[]): BitacoraRow[] {
  const dispatchRows: BitacoraRow[] = log.map((entry): BitacoraRow => {
    if (entry.kind === 'run_done') return { kind: 'runDone', id: entry.id, tasksDone: entry.tasksDone, tasksFailed: entry.tasksFailed, at: entry.createdAt };
    if (entry.kind === 'run_cancelled') return { kind: 'runCancelled', id: entry.id, tasksDone: entry.tasksDone, tasksFailed: entry.tasksFailed, tasksPending: entry.tasksPending, at: entry.createdAt };
    return { kind: 'dispatch', id: entry.id, taskId: entry.taskId, memberId: entry.memberId, status: entry.status, at: entry.createdAt };
  });
  const hireRows: BitacoraRow[] = hires.map((event, index) => ({
    kind: 'hire', id: `hire:${event.memberId}:${index}`, memberId: event.memberId, roleName: event.roleName, at: event.hiredAt,
  }));
  return [...dispatchRows, ...hireRows].sort((a, b) => a.at.localeCompare(b.at));
}

export interface ResumenSummary {
  // objetivo
  title: string;
  brief: string;
  // resultado esperado
  expectedOutput: string | null;
  resultPath: string | null;
  // marca y alcance
  brandName: string;
  folder: string | null;
  // estado actual
  estado: ResumenEstado;
  estadoKey: MessageKey;
  // the reused ladder + cells
  step: OrientationStep;
  stepKey: MessageKey;
  stepParams: Record<string, string | number>;
  brandStateKey: MessageKey;
  reviewDocuments: number | null;
  pendingDecisions: ResumenDecisionRow[];
  // the cycle, handed to the presentational map
  cycle: readonly CyclePhase[];
  /** Empty for both an unwired caller and a wired one with nothing to report — zero rows is never a zero. */
  bitacoraRows: BitacoraRow[];
}

/**
 * The ladder alone: the acceptance-critical bit, testable in isolation.
 *
 * Precedence is fixed (first match wins): a live session outranks a working
 * member, a working member outranks a review, a review outranks pending
 * decisions, and only the clear work is idle.
 */
export function resumenEstado(input: ResumenEstadoInput): ResumenEstado {
  if (input.live) return 'live';
  if (input.team.some((member) => member.status === 'working')) return 'working';
  if (input.reviewDocuments > 0) return 'review';
  if (input.pendingDecisions > 0) return 'decisions';
  return 'idle';
}

/** The whole summary, ready to render. The ladder is reused, never re-derived. */
export function resumenSummary(input: ResumenInput): ResumenSummary {
  // Scope to THIS work: the Resumen is a per-work summary, so a multi-work
  // brand must never leak another work's documents or decisions into the
  // counts and rows the surface renders.
  const workDocuments = input.documents.filter((document) => document.workId === input.work.id);
  const workDecisions = input.decisions.filter((decision) => decision.workId === input.work.id);
  const pendingDecisions = workDecisions.filter((decision) => decision.status === 'pending');
  const reviewDocuments = workDocuments.filter((document) => needsReview(document, input.states[document.id]?.baseOutdated ?? false)).length;
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
    brandName: input.brandName,
    folder: input.work.folder ?? null,
    estado,
    estadoKey: RESUMEN_ESTADO_KEYS[estado],
    step: ladder.step,
    stepKey: ladder.stepKey,
    stepParams: ladder.stepParams,
    brandStateKey: ladder.brandStateKey,
    reviewDocuments: ladder.reviewDocuments,
    pendingDecisions: pendingDecisions.map((decision) => ({ id: decision.id, text: decision.text, createdAt: decision.createdAt })),
    cycle: CYCLE_PHASES,
    bitacoraRows: bitacoraRows(input.coordinationLog ?? [], input.coordinationHires ?? []),
  };
}
