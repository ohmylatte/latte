import { translate as t } from '../i18n';
import { memberDisplayName } from './names';
import type {
  AgentRole, ChatMessage, CoordinationAskView, CoordinationDispatchStatus, CoordinationGateView, CoordinationHireView,
  CoordinationLogEntryView, CoordinationMessageView, CoordinationRunView, TeamMember,
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
  /**
   * Su despacho se cerró SIN reporte: la persona rechazó su gate, o el barrido
   * de arranque lo liquidó. Ni reportó ni falló — se cerró, y eso es todo lo
   * que se puede afirmar.
   */
  | 'dispatchClosed'
  /** Le mandó un `latte_message` a otro miembro. */
  | 'sent'
  /** Otro miembro le mandó un `latte_message`. */
  | 'received'
  /** Preguntó algo (`latte_ask`) y espera una respuesta humana. */
  | 'ask'
  /** Su pregunta ya fue contestada. */
  | 'answer'
  /** Se sumó al equipo. */
  | 'hired'
  /**
   * La persona le escribió. Sólo existe en el hilo del coordinador: el modo
   * Equipo ES su conversación, así que su línea de tiempo tiene que traer
   * también lo que se habló, intercalado por hora con los hechos del run.
   */
  | 'said'
  /** El coordinador contestó. El otro lado de `said`. */
  | 'replied';

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
  /**
   * C3: la TAREA del despacho, cuando el hecho viene de uno. La linea de
   * tiempo dice "Despacho de X" con el titulo de la tarea y su spec debajo, y
   * ese titulo sale del plan --no del prompt, que es lo que el coordinador le
   * escribio al miembro y puede empezar con cualquier cosa.
   */
  taskId?: string;
  /**
   * C3: el texto ENTERO del hecho, sin recortar a su primera linea. `text` es
   * el renglon del buzon; esto es lo que la linea de tiempo puede leer con
   * lugar. Nunca es mas de lo que el motor mando: un `summaryPreview` ya viene
   * cortado a 120 caracteres del backend, y eso no se disimula.
   */
  detail?: string;
}

/**
 * C3 BUG (b): "REPORTÓ" SIN RESUMEN ERA UN REPORTE QUE NUNCA EXISTIÓ.
 *
 * Esto decidía el hecho con `settledAt != null` y `outcome === 'failed'`,
 * ignorando el `status` que la fila ya trae. Un despacho `rejected` (la
 * persona rechazó su gate) o `cancelled` (el barrido de arranque cierra lo que
 * quedó en vuelo tras un cierre de la app) tiene `settled_at` puesto y
 * `summary` en NULL: la pantalla decía "reportó", pelado, sobre una tarea que
 * NADIE reportó. No faltaba el resumen — sobraba el evento.
 *
 * Ahora el `status` manda, que es el campo que dice qué pasó, y un despacho
 * cerrado sin reportar tiene su propio hecho en vez de disfrazarse de reporte.
 */
export function settledKind(
  status: CoordinationDispatchStatus,
  outcome: string | null,
): Extract<InboxEventKind, 'reported' | 'dispatchFailed' | 'dispatchClosed'> {
  if (status === 'failed' || outcome === 'failed') return 'dispatchFailed';
  if (status === 'reported') return 'reported';
  // `rejected`, `cancelled` y cualquier estado que el motor cierre sin pasar
  // por `report()`: se cerró, y eso es todo lo que se puede afirmar.
  return 'dispatchClosed';
}

export interface InboxInput {
  log?: readonly CoordinationLogEntryView[];
  messages?: readonly CoordinationMessageView[];
  asks?: readonly CoordinationAskView[];
  hires?: readonly CoordinationHireView[];
  /**
   * La conversación de ESTE miembro con la persona, cuando la hay.
   *
   * Se pasa sólo para el hilo del coordinador, que es el único cuyo chat vive
   * en el modo Equipo. Los demás siguen teniendo su conversación en su propia
   * pestaña, y meterla acá duplicaría la misma charla en dos pantallas.
   */
  chat?: readonly ChatMessage[];
}

/** El texto de un mensaje de chat: sólo las partes de texto, que es lo que se lee. */
function chatText(message: ChatMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).filter((text) => text.trim() !== '').join('\n').trim();
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
    out.push({ id: `${entry.id}:dispatched`, memberId, kind: 'dispatched', at: entry.createdAt, text: firstLine(entry.promptPreview), detail: entry.promptPreview ?? '', taskId: entry.taskId });
    if (entry.settledAt) {
      out.push({
        id: `${entry.id}:settled`,
        memberId,
        kind: settledKind(entry.status, entry.outcome),
        at: entry.settledAt,
        text: firstLine(entry.summaryPreview),
        detail: entry.summaryPreview ?? '',
        taskId: entry.taskId,
      });
    }
  }
  for (const message of input.messages ?? []) {
    if (message.from?.memberId === memberId) {
      out.push({ id: `${message.id}:sent`, memberId, kind: 'sent', at: message.createdAt, text: firstLine(message.text), detail: message.text, otherMemberId: message.to.memberId, otherRoleId: message.to.roleId });
    } else if (message.to.memberId === memberId) {
      // `from: null` es un mensaje que escribió Latte, no un miembro: llega
      // igual, y su remitente queda sin nombrar en vez de inventado.
      out.push({ id: `${message.id}:received`, memberId, kind: 'received', at: message.createdAt, text: firstLine(message.text), detail: message.text, otherMemberId: message.from?.memberId, otherRoleId: message.from?.roleId });
    }
  }
  for (const ask of input.asks ?? []) {
    if (ask.memberId !== memberId) continue;
    out.push({ id: `${ask.id}:ask`, memberId, kind: 'ask', at: ask.createdAt, text: firstLine(ask.question), detail: ask.question });
    if (ask.answeredAt && ask.answer) out.push({ id: `${ask.id}:answer`, memberId, kind: 'answer', at: ask.answeredAt, text: firstLine(ask.answer), detail: ask.answer });
  }
  for (const hire of input.hires ?? []) {
    if (hire.memberId !== memberId) continue;
    out.push({ id: `hire:${hire.memberId}`, memberId, kind: 'hired', at: hire.hiredAt, text: '' });
  }
  // La conversación, intercalada por hora como un hecho más. Un mensaje vacío
  // —una respuesta que todavía no escribió una sola palabra, un turno que sólo
  // trajo herramientas— no es una línea: no se dibuja un renglón en blanco.
  for (const message of input.chat ?? []) {
    if (message.chatId !== memberId) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = chatText(message);
    if (!text) continue;
    out.push({
      id: `${message.id}:${message.role === 'user' ? 'said' : 'replied'}`,
      memberId,
      kind: message.role === 'user' ? 'said' : 'replied',
      at: message.createdAt,
      text: firstLine(text),
      detail: text,
    });
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
 * Cómo se lee un hecho del buzón, en una sola línea. El rol del otro extremo
 * se resuelve contra el equipo: un id pelado no le dice nada a nadie.
 *
 * Vive acá, y no en la pantalla que lo dibuja, porque desde B3 lo dibujan DOS:
 * la vista Equipo (la lista y el hilo) y el subtítulo de la pestaña de miembro
 * del chat. Una misma fila tiene que leerse igual en las dos.
 */
export function describeInboxEvent(event: InboxEvent, team: readonly TeamMember[], roles: readonly AgentRole[]): string {
  // Sin `otherMemberId` el remitente es Latte, no un miembro: queda sin
  // nombrar, como estaba. Con uno, la cadena de `memberDisplayName` termina
  // siempre en algo legible.
  const other = event.otherMemberId ? memberDisplayName(event.otherMemberId, team, event.otherRoleId, roles) : '';
  /**
   * B3.4: LOS DOS PUNTOS SON DEL TEXTO, NO DEL VERBO.
   *
   * La captura del dueno mostraba, literal, "reporto:" y despues nada: el
   * motor puede cerrar un despacho sin `summaryPreview` y el formato con el
   * hueco vacio anuncia algo que no llega. Sin texto se usa la forma entera
   * del verbo, que dice el hecho igual y no promete nada.
   */
  const text = event.text.trim();
  switch (event.kind) {
    case 'dispatched': return text ? t('team.inbox.dispatched', { text }) : t('team.inbox.dispatchedBare');
    case 'reported': return text ? t('team.inbox.reported', { text }) : t('team.inbox.reportedBare');
    case 'dispatchFailed': return text ? t('team.inbox.dispatchFailed', { text }) : t('team.inbox.dispatchFailedBare');
    case 'dispatchClosed': return t('team.inbox.dispatchClosed');
    case 'sent': return text ? t('team.inbox.sent', { role: other, text }) : t('team.inbox.sentBare', { role: other });
    case 'received': return text ? t('team.inbox.received', { role: other, text }) : t('team.inbox.receivedBare', { role: other });
    case 'ask': return text ? t('team.inbox.ask', { text }) : t('team.inbox.askBare');
    case 'answer': return text ? t('team.inbox.answer', { text }) : t('team.inbox.answerBare');
    case 'hired': return t('team.inbox.hired');
    case 'said': return text ? t('team.inbox.said', { text }) : t('team.inbox.saidBare');
    case 'replied': return text ? t('team.inbox.replied', { text }) : t('team.inbox.repliedBare');
    default: {
      const exhaustive: never = event.kind;
      return exhaustive;
    }
  }
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

/**
 * B3.1: lo que el TRABAJO entero está esperando — el número de la pestaña
 * "Equipo". Gates más preguntas, sin repartir por miembro: la pestaña no
 * promete a quién le toca, promete que hay algo.
 *
 * Un run que cerró no espera nada, exactamente igual que arriba.
 */
export function pendingForWork(
  gates: readonly CoordinationGateView[] | undefined,
  asks: readonly CoordinationAskView[] | undefined,
  run: CoordinationRunView | null | undefined,
): number {
  if (run != null && !run.active) return 0;
  return (gates ?? []).length + (asks ?? []).length;
}
