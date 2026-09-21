import type {
  CoordinationAskView, CoordinationGateView, CoordinationHireView,
  CoordinationLogEntryView, CoordinationMessageView, CoordinationRunView,
} from '../../shared/contracts';

/**
 * EL PANEL DEL EQUIPO ES UN BUZÓN.
 *
 * "Cada bot se concentra en lo suyo aislado, otro consolida, y si uno necesita
 * algo se lo pide a otro." Eso ya pasaba —hay despachos, reportes,
 * `latte_message` entre miembros, preguntas— y no había una sola pantalla
 * donde se viera. El panel mostraba el nombre del miembro y su estado de
 * proceso: nada de lo que el equipo estuvo haciendo.
 *
 * Acá vive la derivación, sin React y sin `browser-api`, porque es lo único
 * que hay que poder probar sin montar medio panel: qué le pasó a cada miembro,
 * en orden, y cuál fue lo último.
 *
 * Todo sale de filas persistidas (la bitácora, los mensajes, las preguntas,
 * las altas). Nada se narra: si no hay una fila, no hay una línea.
 */

export type InboxEventKind =
  /** Le llegó un despacho (el prompt, recortado). */
  | 'dispatched'
  /** Reportó el resultado de un despacho. */
  | 'reported'
  /** Su despacho terminó mal. `failed` y `reported` son dos hechos distintos. */
  | 'dispatchFailed'
  /** Le mandó un `latte_message` a otro miembro. */
  | 'sent'
  /** Otro miembro le mandó un `latte_message`. */
  | 'received'
  /** Preguntó algo (`latte_ask`) y espera una respuesta humana. */
  | 'ask'
  /** Su pregunta ya fue contestada. */
  | 'answer'
  /** Se sumó al equipo. */
  | 'hired';

export interface InboxEvent {
  /** Estable y único dentro del hilo de un miembro: sirve de `key` de React. */
  id: string;
  /** El miembro cuyo hilo cuenta este hecho. */
  memberId: string;
  kind: InboxEventKind;
  /** El instante del hecho, ISO. Es la clave de orden. */
  at: string;
  /** El recorte legible, ya en una sola línea. Vacío cuando el hecho no trae texto (un alta). */
  text: string;
  /** El OTRO extremo de un mensaje: el que lo recibió (`sent`) o el que lo mandó (`received`). */
  otherMemberId?: string;
  /**
   * El ROL del otro extremo, que la fila del mensaje ya trae. B2.2: cuando ese
   * miembro ya no está en el equipo, el `memberId` no resuelve contra nada y
   * sin esto la única salida era escupir el id.
   */
  otherRoleId?: string;
}

export interface InboxInput {
  log?: readonly CoordinationLogEntryView[];
  messages?: readonly CoordinationMessageView[];
  asks?: readonly CoordinationAskView[];
  hires?: readonly CoordinationHireView[];
}

/** La primera línea, recortada: un renglón del buzón es un renglón. */
export function firstLine(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > max ? line.slice(0, max) : line;
}

/**
 * Todo lo que le pasó a `memberId`, del más viejo al más nuevo.
 *
 * Un despacho produce DOS hechos, no uno: le llegó, y después reportó (bien o
 * mal). Colapsarlos en el estado final borraría el momento en que la persona
 * podía ver qué se le pidió a ese miembro — que es justo lo que quiere ver
 * mientras todavía está corriendo.
 */
export function inboxEvents(input: InboxInput, memberId: string): InboxEvent[] {
  const out: InboxEvent[] = [];
  for (const entry of input.log ?? []) {
    if (entry.kind === 'run_done' || entry.kind === 'run_cancelled') continue;
    if (entry.memberId !== memberId) continue;
    out.push({ id: `${entry.id}:dispatched`, memberId, kind: 'dispatched', at: entry.createdAt, text: firstLine(entry.promptPreview) });
    if (entry.settledAt) {
      out.push({
        id: `${entry.id}:settled`,
        memberId,
        kind: entry.outcome === 'failed' ? 'dispatchFailed' : 'reported',
        at: entry.settledAt,
        text: firstLine(entry.summaryPreview),
      });
    }
  }
  for (const message of input.messages ?? []) {
    if (message.from?.memberId === memberId) {
      out.push({ id: `${message.id}:sent`, memberId, kind: 'sent', at: message.createdAt, text: firstLine(message.text), otherMemberId: message.to.memberId, otherRoleId: message.to.roleId });
    } else if (message.to.memberId === memberId) {
      // `from: null` es un mensaje que escribió Latte, no un miembro: llega
      // igual, y su remitente queda sin nombrar en vez de inventado.
      out.push({ id: `${message.id}:received`, memberId, kind: 'received', at: message.createdAt, text: firstLine(message.text), otherMemberId: message.from?.memberId, otherRoleId: message.from?.roleId });
    }
  }
  for (const ask of input.asks ?? []) {
    if (ask.memberId !== memberId) continue;
    out.push({ id: `${ask.id}:ask`, memberId, kind: 'ask', at: ask.createdAt, text: firstLine(ask.question) });
    if (ask.answeredAt && ask.answer) out.push({ id: `${ask.id}:answer`, memberId, kind: 'answer', at: ask.answeredAt, text: firstLine(ask.answer) });
  }
  for (const hire of input.hires ?? []) {
    if (hire.memberId !== memberId) continue;
    out.push({ id: `hire:${hire.memberId}`, memberId, kind: 'hired', at: hire.hiredAt, text: '' });
  }
  // Orden estable: mismo instante, mismo id, mismo orden en dos renders.
  return out.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
}

/** Lo último que le pasó a este miembro, o `null` cuando todavía no le pasó nada — nunca un renglón inventado. */
export function lastInboxEvent(input: InboxInput, memberId: string): InboxEvent | null {
  const events = inboxEvents(input, memberId);
  return events.length === 0 ? null : events[events.length - 1]!;
}

/**
 * Cuántas decisiones está esperando ESTE miembro: los gates, que son del
 * coordinador, y las preguntas que hizo él. Exactamente el mismo ruteo que
 * usan las tarjetas del chat — si acá dijera otra cosa, el contador mandaría
 * a la persona a un chat donde no hay nada.
 *
 * Un run que cerró no espera nada de nadie.
 */
export function pendingForMember(
  memberId: string,
  gates: readonly CoordinationGateView[] | undefined,
  asks: readonly CoordinationAskView[] | undefined,
  run: CoordinationRunView | null | undefined,
): number {
  if (run != null && !run.active) return 0;
  const coordinator = run?.coordinatorMemberId ?? null;
  let count = coordinator === memberId ? (gates ?? []).length : 0;
  for (const ask of asks ?? []) {
    const target = ask.memberId || coordinator;
    if (target === memberId) count += 1;
  }
  return count;
}
