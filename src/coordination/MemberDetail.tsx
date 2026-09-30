import { ArrowUpRight, Brain, CircleCheck, CircleHelp, CircleX, CornerDownLeft, FileText, Flag, Globe, MessageSquare, PenLine, Plug, Search, Send, Terminal, UserPlus, Users, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { translate as t } from '../i18n';
import { CoordAvatar, CoordTime } from './anatomy';
import { AudienceBadge, isClientTask } from './audience';
import { avatarOfMember } from './avatar-of';
import type { DispatchSteps, StepKind } from './activity';
import type { InboxEvent } from './inbox';
import type { MemberSignal } from './member-line';
import { memberDisplayName } from './names';
import { bodyOf, reportFileNames, titleOf } from './text';
import { minutesUntil } from './time';
import { taskTitle, TASK_TITLE_LONG } from '../../shared/taskTitle';
import type { AgentRole, CoordinationAskView, CoordinationRunTaskView, CoordinationRunView, TeamMember } from '../../shared/contracts';

/**
 * C3: EL DETALLE DE UN MIEMBRO ES UNA LÍNEA DE TIEMPO.
 *
 * Lo que había era una `<ol>` de renglones "verbo: texto", todos iguales, en
 * gris, sin ninguna forma de distinguir de un vistazo un despacho de un
 * reporte de una pregunta. El criterio 3 dice que el ícono hace el sustantivo:
 * cada hecho entra por su círculo-ícono, la palabra sólo agrega lo específico
 * (a quién, qué tarea) y la hora vive en mono a la derecha.
 *
 * Descendente: lo último arriba. Una línea de tiempo de un equipo que está
 * trabajando se lee por lo que acaba de pasar, no por cómo empezó.
 */

export interface MemberDetailProps {
  memberId: string;
  team: readonly TeamMember[];
  roles?: readonly AgentRole[];
  run?: CoordinationRunView | null;
  events: readonly InboxEvent[];
  tasks?: readonly CoordinationRunTaskView[];
  /** Qué hace ahora y desde cuándo: la misma derivación que su fila de la lista. */
  signal: MemberSignal;
  formatTime?: (value: string) => string;
  /** Abre la conversación de ESTE miembro en la columna del chat. Sin handler, no se ofrece. */
  onOpenChat?: (memberId: string) => void;
  /** C4: las preguntas abiertas de ESTE miembro. La tarjeta grande va arriba de la línea de tiempo. */
  openAsks?: readonly CoordinationAskView[];
  onAnswerAsk?: (askId: string, answer: string) => void;
  pending?: Record<string, boolean>;
  /** El instante contra el que se cuenta "vence en N min". Inyectable para los tests. */
  now?: number;
  /**
   * ELEGIR QUE ESTE MIEMBRO COORDINE EL TRABAJO (escribe el permiso del
   * trabajo). Sin handler no se ofrece: un botón que no escribe nada es peor
   * que un botón que no está.
   */
  onCoordinate?: (memberId: string) => void;
  /** Ya coordina: el botón dice lo que es y no se aprieta. */
  coordinating?: boolean;
  /** Hay un run activo: manda su coordinador, y el botón dice por qué no se puede. */
  coordinateLocked?: boolean;
  /** Lo que el contenedor quiera meter entre el encabezado y la línea de tiempo. */
  children?: ReactNode;
  /**
   * N1: los pasos de cada despacho, por el id de su hecho `dispatched`. Van
   * debajo de la tarjeta de la tarea: lo que hizo entre el despacho y el
   * reporte. Sin esto, ningún paso.
   */
  steps?: Readonly<Record<string, DispatchSteps>>;
}

/**
 * C4: LA PREGUNTA QUE TE ESPERA, GRANDE Y CON SU ÚNICA ACCIÓN.
 *
 * Criterio 2: el acento significa "te necesita", así que esta tarjeta es lo
 * único del detalle que lo lleva. La pregunta se lee a 17px —es lo que hay que
 * leer— y debajo, en gris, para qué tarea es y cuánto falta para que venza.
 * Una sola acción: la respuesta misma.
 *
 * Después de responder la tarjeta se va sola: `openAsks` deja de traerla, y el
 * hecho queda en la línea de tiempo, que es donde vive lo que ya pasó.
 */
function AskCard({ ask, taskTitle, name, onAnswerAsk, pending, now }: {
  ask: CoordinationAskView;
  taskTitle: string;
  name: string;
  onAnswerAsk?: (askId: string, answer: string) => void;
  pending?: Record<string, boolean>;
  now: number;
}) {
  const [answer, setAnswer] = useState('');
  const busy = Boolean(pending?.[`ask:${ask.id}`]);
  const left = minutesUntil(ask.deadlineAt, now);
  const due = left == null ? '' : left > 0
    ? (taskTitle ? t('coord.ask.for', { task: taskTitle, count: left }) : t('coord.ask.due', { count: left }))
    : (taskTitle ? t('coord.ask.forOverdue', { task: taskTitle }) : t('coord.ask.overdue'));
  const send = () => { if (answer.trim()) { onAnswerAsk?.(ask.id, answer.trim()); setAnswer(''); } };
  return <div className="coord-ask-card" data-ask-id={ask.id}>
    <div className="coord-ask-top">
      <span className="coord-tic coord-tic-live"><CircleHelp size={14} /></span>
      <div className="coord-ask-text">
        <div className="coord-ask-question">{ask.question}</div>
        {due && <div className="coord-ask-due">{due}</div>}
      </div>
    </div>
    {onAnswerAsk && <div className="coord-ask-form">
      <label className="visually-hidden" htmlFor={`coord-answer-${ask.id}`}>{t('coord.ask.label', { name })}</label>
      <input id={`coord-answer-${ask.id}`} className="coord-ask-input" type="text"
        placeholder={t('coord.ask.placeholder')} value={answer} disabled={busy}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
      <button type="button" className="coord-btn coord-btn-primary coord-ask-send" disabled={busy || !answer.trim()} onClick={send}>
        <Send size={14} />{t('coord.ask.answer')}
      </button>
    </div>}
  </div>;
}

/** El ícono del hecho. Criterio 3: el ícono hace el sustantivo. */
function EventIcon({ kind }: { kind: InboxEvent['kind'] }) {
  switch (kind) {
    case 'dispatched': return <span className="coord-tic"><Send size={14} /></span>;
    case 'reported': return <span className="coord-tic coord-tic-ok"><CircleCheck size={14} /></span>;
    case 'dispatchFailed': return <span className="coord-tic coord-tic-bad"><CircleX size={14} /></span>;
    case 'dispatchClosed': return <span className="coord-tic"><CircleX size={14} /></span>;
    case 'ask': return <span className="coord-tic coord-tic-live"><CircleHelp size={14} /></span>;
    case 'answer': return <span className="coord-tic coord-tic-ok"><CircleCheck size={14} /></span>;
    case 'hired': return <span className="coord-tic"><UserPlus size={14} /></span>;
    case 'sent': case 'received': return <span className="coord-tic"><MessageSquare size={14} /></span>;
    // La conversacion con la persona: la flecha dice de que lado vino, y el
    // acento no se gasta aca -- nada de esto te esta esperando.
    case 'said': return <span className="coord-tic"><ArrowUpRight size={14} /></span>;
    case 'replied': return <span className="coord-tic"><CornerDownLeft size={14} /></span>;
    default: return <span className="coord-tic"><Flag size={14} /></span>;
  }
}

/** Tope de pasos a la vista por despacho: los anteriores quedan contados en "y N más". */
const MAX_STEPS = 50;

/** El ícono chico del paso: el tipo de herramienta, de un vistazo. */
function StepIcon({ kind }: { kind: StepKind }) {
  const size = 12;
  switch (kind) {
    case 'read': return <FileText size={size} />;
    case 'search': return <Search size={size} />;
    case 'write': return <PenLine size={size} />;
    case 'run': return <Terminal size={size} />;
    case 'web': return <Globe size={size} />;
    case 'memory': return <Brain size={size} />;
    case 'connection': return <Plug size={size} />;
    case 'coordinate': return <Users size={size} />;
    default: return <Wrench size={size} />;
  }
}

/**
 * N1: LO QUE HIZO ENTRE EL DESPACHO Y EL REPORTE.
 *
 * Una línea por herramienta: ícono, verbo y objeto, hora en mono. Mientras
 * trabaja se ven, y el último en curso lleva el punto; cuando reporta, se
 * pliegan en "N pasos" — lo que importa ahí es el reporte. Nunca el
 * razonamiento ni el output: eso es su chat.
 */
function StepList({ data, time }: { data: DispatchSteps; time: (value: string) => string }) {
  const { steps, settled } = data;
  if (steps.length === 0) return null;
  const hidden = Math.max(0, steps.length - MAX_STEPS);
  const shown = steps.slice(hidden);
  const list = <ol className="coord-steps" aria-label={t('coord.steps.label')}>
    {hidden > 0 && <li className="coord-steps-more">{t('coord.steps.more', { count: hidden })}</li>}
    {shown.map((step, index) => {
      const live = !settled && step.running && index === shown.length - 1;
      return <li key={step.id} className={'coord-step' + (live ? ' is-live' : '') + (step.failed ? ' is-failed' : '')} data-kind={step.kind}>
        <span className="coord-step-icon"><StepIcon kind={step.kind} /></span>
        <span className="coord-step-text" title={step.text}>{step.text}</span>
        {live && <i className="coord-step-dot" role="img" aria-label={t('coord.steps.live')} />}
        <CoordTime at={step.at} label={time(step.at)} />
      </li>;
    })}
  </ol>;
  if (!settled) return list;
  return <details className="coord-steps-fold">
    <summary className="coord-steps-summary">{t('coord.steps.count', { count: steps.length })}</summary>
    {list}
  </details>;
}

/**
 * El título corto del hecho. Nombres, no ids, y nunca una frase larga: lo
 * específico va abajo.
 */
function eventTitle(event: InboxEvent, props: MemberDetailProps): string {
  const roles = props.roles ?? [];
  const other = event.otherMemberId ? memberDisplayName(event.otherMemberId, props.team, event.otherRoleId, roles) : '';
  const self = memberDisplayName(event.memberId, props.team, null, roles);
  const coordinator = props.run?.coordinatorMemberId ?? null;
  const isCoordinator = coordinator === event.memberId;
  switch (event.kind) {
    case 'dispatched': {
      const from = coordinator && !isCoordinator ? memberDisplayName(coordinator, props.team, null, roles) : '';
      return from ? t('coord.event.dispatchFrom', { role: from }) : t('coord.event.dispatch');
    }
    case 'reported': return isCoordinator ? t('coord.event.reportedSelf') : t('coord.event.reported', { role: self });
    case 'dispatchFailed': return t('coord.event.failed');
    case 'dispatchClosed': return t('coord.event.closed');
    case 'ask': return t('coord.event.asked');
    case 'answer': return t('coord.event.answered');
    case 'hired': return t('coord.event.hired', { role: self });
    case 'sent': return t('coord.event.sent', { role: other });
    case 'received': return t('coord.event.received', { role: other });
    case 'said': return t('coord.event.said');
    case 'replied': return t('coord.event.replied');
    default: {
      const exhaustive: never = event.kind;
      return exhaustive;
    }
  }
}

export function MemberDetail(props: MemberDetailProps) {
  const roles = props.roles ?? [];
  const time = props.formatTime ?? ((value: string) => value);
  const name = memberDisplayName(props.memberId, props.team, null, roles);
  const member = props.team.find((m) => m.id === props.memberId) ?? null;
  const taskOf = (taskId: string | undefined) => (taskId ? (props.tasks ?? []).find((task) => task.id === taskId) ?? null : null);
  // Descendente: lo último arriba. `inboxEvents` entrega del más viejo al más
  // nuevo porque el buzón lo necesita así; acá se invierte una copia.
  const timeline = [...props.events].reverse();

  return <div className="coord-detail">
    <div className="coord-detail-head">
      <CoordAvatar name={name} dot={props.signal.dot} roleId={member?.roleId} avatar={member ? avatarOfMember(member) : null} gone={!member} />
      <div className="coord-detail-title">
        <div className="coord-detail-name">{name}</div>
        <div className="coord-detail-sub">{props.signal.at
          ? t('coord.detail.since', { what: props.signal.line, time: time(props.signal.at) })
          : props.signal.line}</div>
      </div>
      {/* Un verbo por botón, con ícono: el MISMO ícono que marca al coordinador en la lista. */}
      {props.onCoordinate && <button type="button" className="coord-btn coord-detail-coordinate"
        disabled={props.coordinating || props.coordinateLocked}
        title={props.coordinating ? t('coord.detail.coordinatingHelp', { name })
          : props.coordinateLocked ? t('coord.detail.coordinateLocked') : t('coord.detail.coordinateHelp', { name })}
        onClick={() => props.onCoordinate!(props.memberId)}>
        <Users size={14} />{props.coordinating ? t('coord.detail.coordinating') : t('coord.detail.coordinate')}
      </button>}
      {/* Criterio 4: UN verbo, con ícono. Sin handler no se ofrece un botón que no abre nada. */}
      {props.onOpenChat && <button type="button" className="coord-btn coord-detail-chat"
        title={t('coord.detail.conversationHelp', { name })}
        onClick={() => props.onOpenChat!(props.memberId)}>
        <MessageSquare size={14} />{t('coord.detail.conversation')}
      </button>}
    </div>
    {/* C4: la pregunta abierta, arriba de todo: es lo unico del detalle que te
        esta esperando, y por eso es lo unico que lleva el acento. */}
    {(props.openAsks ?? []).filter((ask) => !ask.answeredAt).map((ask) => <AskCard key={ask.id} ask={ask}
      taskTitle={taskTitle(taskOf(ask.taskId ?? undefined)?.spec, taskOf(ask.taskId ?? undefined)?.title)} name={name}
      onAnswerAsk={props.onAnswerAsk} pending={props.pending} now={props.now ?? Date.now()} />)}
    {props.children}
    <ol className="team-thread coord-timeline" aria-label={t('coord.timeline.label')}>
      {timeline.length === 0
        ? <li className="team-thread-empty coord-timeline-empty">{t('coord.timeline.empty')}</li>
        : timeline.map((event) => {
          const task = taskOf(event.taskId);
          /**
           * C3 BUG (a): EL NUMERAL DE MARKDOWN NO LLEGA A LA PANTALLA.
           *
           * El título del traspaso puenteado a tarea entraba con su `#` y se
           * leía literal: "despachó: # Piezas exactas…". Se limpia en el
           * puente, donde nace, Y acá: una fila vieja, ya guardada con su
           * numeral, sigue leyéndose bien.
           */
          const heading = task ? taskTitle(task.spec, task.title, TASK_TITLE_LONG) : taskTitle(event.detail || event.text, null, TASK_TITLE_LONG);
          const body = task ? bodyOf(task.spec) : bodyOf(event.detail || '');
          /**
           * C3 BUG (b): UN REPORTE MUESTRA SU RESUMEN.
           *
           * El `detail` del reporte es el `summaryPreview` entero, no su
           * primera línea: el renglón del buzón necesitaba una línea, esto
           * tiene lugar para el párrafo. Sin resumen no se inventa uno — el
           * motor puede cerrar un despacho sin él— y entonces el hecho queda
           * dicho por su ícono y su título, que ya dicen qué pasó.
           */
          const summary = event.kind === 'reported' || event.kind === 'dispatchFailed' ? titleOf(event.detail || event.text, 400) : '';
          const files = reportFileNames(event.files, event.detail || event.text);
          return <li key={event.id} className="team-thread-row coord-event" data-kind={event.kind}>
            <EventIcon kind={event.kind} />
            <div className="coord-event-body">
              <div className="coord-event-head">
                <span className="coord-event-title">{eventTitle(event, props)}</span>
                <CoordTime at={event.at} label={time(event.at)} />
              </div>
              {event.kind === 'dispatched' && heading && <div className="coord-event-card">
                <div className="coord-event-task">{heading}</div>
                {isClientTask(task) && <AudienceBadge />}
                {body && <div className="coord-event-spec">{body}</div>}
              </div>}
              {event.kind === 'dispatched' && props.steps?.[event.id] && <StepList data={props.steps[event.id]!} time={time} />}
              {summary && <p className="coord-event-text team-thread-text">{summary}</p>}
              {event.kind !== 'dispatched' && event.kind !== 'reported' && event.kind !== 'dispatchFailed' && event.kind !== 'dispatchClosed' && event.text
                && <p className="coord-event-text team-thread-text">{titleOf(event.detail || event.text, 400)}</p>}
              {event.kind === 'hired' && <p className="coord-event-text coord-event-muted">{t('coord.event.hiredHow')}</p>}
              {/* Criterio: NO se inventa una lista de archivos que el modelo de
                  datos no tiene. Si el resumen NOMBRA un archivo, eso es un
                  hecho del texto y se muestra; si no lo nombra, no hay ficha. */}
              {files.length > 0 && <div className="coord-files">
                {files.map((file) => <span key={file} className="coord-file"><FileText size={12} />{file}</span>)}
              </div>}
            </div>
          </li>;
        })}
    </ol>
  </div>;
}
