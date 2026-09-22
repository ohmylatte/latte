import { translate as t } from '../i18n';
import { firstLine, inboxEvents, type InboxInput } from './inbox';
import { memberDisplayName } from './names';
import { titleOf } from './text';
import type {
  AgentRole, CoordinationAskView, CoordinationDispatchLogEntryView,
  CoordinationLogEntryView, CoordinationRunView, TeamMember,
} from '../../shared/contracts';

/**
 * C2: LA MISMA ANATOMÍA PARA TODA FILA — la parte que se puede probar sin DOM.
 *
 * Criterio 1: estado · nombre · qué hace ahora · cuándo. El nombre lo resuelve
 * `./names`; la hora la formatea `./time`; el ESTADO y el QUÉ HACE AHORA se
 * derivan acá, de las mismas filas persistidas que alimentan el buzón.
 *
 * Criterio 5: el estado es una SEÑAL, no una frase en una pastilla. Por eso
 * esto devuelve `dot: 'live' | 'ok' | 'idle'` y no un texto: la palabra
 * "arrancando" desaparece, el punto queda.
 */

export type MemberDot =
  /** Trabajando ahora mismo, o esperándote: el acento, con halo. */
  | 'live'
  /** Su último hecho fue un reporte y está ocioso. */
  | 'ok'
  /**
   * Su ultimo despacho volvio mal. Criterio 2: fallar no es estar quieto --es
   * un hecho que la persona tiene que ver-- y tampoco es el acento, que
   * significa vivo.
   */
  | 'failed'
  /** Quieto. Todo lo que no es ninguna de las dos de arriba. */
  | 'idle';

export interface MemberSignal {
  dot: MemberDot;
  /** Qué hace ahora, en UNA línea. Nunca vacío: sin un solo hecho dice que no hay novedades. */
  line: string;
  /** El instante de esa línea, o `null` cuando la línea no cuenta un hecho fechado. */
  at: string | null;
  /** Preguntas abiertas de este miembro para la persona. Con una o más, la fila lleva badge en vez de hora. */
  asks: number;
  /** La línea habla de algo que te está esperando: se lee en el acento, no en gris. */
  urgent: boolean;
}

/** Cómo se resuelve el título de una tarea a partir de su id. Sin resolver, la fila cae en el texto del despacho. */
export type TaskTitle = (taskId: string) => string;

/** Los despachos de este miembro que salieron y todavía no volvieron. */
function inFlightFor(log: readonly CoordinationLogEntryView[] | undefined, memberId: string): CoordinationDispatchLogEntryView[] {
  const out: CoordinationDispatchLogEntryView[] = [];
  for (const entry of log ?? []) {
    if (entry.kind === 'run_done' || entry.kind === 'run_cancelled') continue;
    if (entry.memberId !== memberId) continue;
    if (entry.settledAt) continue;
    if (entry.status !== 'dispatched' && entry.status !== 'running') continue;
    out.push(entry);
  }
  return out;
}

/** Todo lo que está en vuelo en el run, de cualquier miembro. Es lo que el coordinador está esperando. */
function allInFlight(log: readonly CoordinationLogEntryView[] | undefined): CoordinationDispatchLogEntryView[] {
  const out: CoordinationDispatchLogEntryView[] = [];
  for (const entry of log ?? []) {
    if (entry.kind === 'run_done' || entry.kind === 'run_cancelled') continue;
    if (entry.settledAt) continue;
    if (entry.status !== 'dispatched' && entry.status !== 'running') continue;
    out.push(entry);
  }
  return out;
}

function openAsksFor(asks: readonly CoordinationAskView[] | undefined, memberId: string): CoordinationAskView[] {
  return (asks ?? []).filter((ask) => ask.memberId === memberId && !ask.answeredAt);
}

export interface MemberSignalInput extends InboxInput {
  team: readonly TeamMember[];
  roles?: readonly AgentRole[];
  run?: CoordinationRunView | null;
  /** El título de la tarea de un despacho. Sin esto se usa el texto del despacho, que es lo que ya había. */
  taskTitle?: TaskTitle;
}

/**
 * Qué hace ahora este miembro, y con qué señal.
 *
 * El orden NO es arbitrario: es la escala de urgencia del criterio 2. Primero
 * lo que te está esperando (una pregunta), después lo que está pasando (un
 * despacho en vuelo), después lo que el coordinador espera, y recién al final
 * lo último que pasó.
 */
export function memberSignal(input: MemberSignalInput, memberId: string): MemberSignal {
  const { team, roles = [], run = null } = input;
  const live = run == null || run.active;
  const asks = live ? openAsksFor(input.asks, memberId) : [];
  const title = (entry: CoordinationDispatchLogEntryView) =>
    (input.taskTitle ? input.taskTitle(entry.taskId) : '') || titleOf(entry.promptPreview);

  if (asks.length > 0) {
    const ask = asks[asks.length - 1]!;
    return {
      dot: 'live',
      line: t('coord.member.asking', { text: titleOf(ask.question, 80) }),
      at: ask.createdAt,
      asks: asks.length,
      urgent: true,
    };
  }

  const mine = live ? inFlightFor(input.log, memberId) : [];
  if (mine.length > 0) {
    const entry = mine[mine.length - 1]!;
    return { dot: 'live', line: title(entry), at: entry.startedAt ?? entry.createdAt, asks: 0, urgent: false };
  }

  // El coordinador no tiene despacho propio: lo suyo es esperar los ajenos.
  // Se dice con el NOMBRE de a quién espera cuando es uno solo; con más de
  // uno, cuántos — nombrar tres roles en una línea no entra y no ayuda.
  if (live && run?.coordinatorMemberId === memberId) {
    const waiting = allInFlight(input.log).filter((entry) => entry.memberId !== memberId);
    if (waiting.length === 1) {
      const role = memberDisplayName(waiting[0]!.memberId, team, null, roles);
      return { dot: 'idle', line: t('coord.member.waitingFor', { role }), at: waiting[0]!.startedAt ?? waiting[0]!.createdAt, asks: 0, urgent: false };
    }
    if (waiting.length > 1) {
      return { dot: 'idle', line: t('coord.member.waitingCount', { count: waiting.length }), at: null, asks: 0, urgent: false };
    }
  }

  const events = inboxEvents(input, memberId);
  const last = events.length === 0 ? null : events[events.length - 1]!;
  if (!last) return { dot: 'idle', line: t('team.inbox.nothing'), at: null, asks: 0, urgent: false };

  switch (last.kind) {
    case 'reported': {
      const entry = (input.log ?? []).find((e) => e.kind !== 'run_done' && e.kind !== 'run_cancelled' && `${e.id}:settled` === last.id) as CoordinationDispatchLogEntryView | undefined;
      const what = (entry ? title(entry) : '') || firstLine(last.text, 80);
      return { dot: 'ok', line: what ? t('coord.member.reported', { text: what }) : t('team.inbox.reportedBare'), at: last.at, asks: 0, urgent: false };
    }
    case 'dispatchClosed':
      return { dot: 'idle', line: t('coord.member.closed'), at: last.at, asks: 0, urgent: false };
    case 'dispatchFailed':
      return { dot: 'failed', line: last.text ? t('coord.member.failed', { text: firstLine(last.text, 80) }) : t('team.inbox.dispatchFailedBare'), at: last.at, asks: 0, urgent: false };
    case 'answer':
      return { dot: 'idle', line: t('coord.member.answered'), at: last.at, asks: 0, urgent: false };
    case 'ask':
      // Una pregunta YA contestada (o de un run cerrado) no te espera: se
      // cuenta como lo último que pasó, en gris.
      return { dot: 'idle', line: t('coord.member.asking', { text: titleOf(last.text, 80) }), at: last.at, asks: 0, urgent: false };
    case 'dispatched':
      return { dot: 'idle', line: titleOf(last.text) || t('team.inbox.dispatchedBare'), at: last.at, asks: 0, urgent: false };
    case 'sent': {
      const role = memberDisplayName(last.otherMemberId, team, last.otherRoleId, roles);
      return { dot: 'idle', line: t('coord.member.sent', { role }), at: last.at, asks: 0, urgent: false };
    }
    case 'received': {
      const role = memberDisplayName(last.otherMemberId, team, last.otherRoleId, roles);
      return { dot: 'idle', line: t('coord.member.received', { role }), at: last.at, asks: 0, urgent: false };
    }
    case 'hired':
      return { dot: 'idle', line: t('team.inbox.hired'), at: last.at, asks: 0, urgent: false };
    default: {
      const exhaustive: never = last.kind;
      return exhaustive;
    }
  }
}
