import { CircleCheck, CircleHelp, CircleX, Clock, Flag, MessageSquare, Pause, Play, Send, X } from 'lucide-react';
import { translate as t } from '../i18n';
import { CoordAvatar } from './anatomy';
import { AudienceBadge, isClientTask } from './audience';
import { avatarOfRole } from './avatar-of';
import { roleDisplayName } from './names';
import { taskTitle, TASK_TITLE_LONG } from '../../shared/taskTitle';
import { hourOf } from './time';
import { memberDisplayName } from './names';
import { nowLine, type NowLine } from './now-line';
import type {
  AgentRole, CoordinationAskView, CoordinationRunTaskView, CoordinationRunView, TeamMember,
} from '../../shared/contracts';

/**
 * C1: EL ENCABEZADO DEL RUN, Y LA TIRA DE TAREAS.
 *
 * Lo que había eran DOS líneas de contadores —"0 listas · 1 en curso · 0
 * fallidas · 3 sin empezar" y "Despachos: 0 usados · 1 en curso / 3"— más tres
 * botones con la palabra escrita al lado del ícono. Siete números y cuatro
 * palabras para decir algo que una barra dice sola.
 *
 * Criterio 5: el estado es una SEÑAL. La barra tiene tres tramos (listas en
 * verde, en curso en el acento, el resto gris) y debajo va el pedido entero,
 * una ficha por tarea, con el ícono haciendo el sustantivo (criterio 3).
 *
 * Criterio 1 del presupuesto de palabras: UNA línea de encabezado.
 */

export interface RunHeaderProps {
  run: CoordinationRunView;
  /**
   * El nombre del Trabajo, que es el RESPALDO del encabezado.
   *
   * R3: desde 1.2.0 el run guarda el pedido con el que nació (`run.request`) y
   * el encabezado lo prefiere. Esto queda para el run que no nació de un
   * pedido (`startRun`) o que es anterior: el nombre del Trabajo puede ser
   * "Campaña Q4" mientras el pedido fue "armar el calendario de octubre", y
   * hasta ahora era SIEMPRE lo que se leía acá.
   */
  title: string;
  /** El nombre visible del coordinador, nunca su id. `''` calla el subtítulo. */
  coordinatorName: string;
  tasks?: readonly CoordinationRunTaskView[];
  /** Las preguntas abiertas del run: la pastilla "Te necesita" y el ícono de la ficha. */
  asks?: readonly CoordinationAskView[];
  team?: readonly TeamMember[];
  roles?: readonly AgentRole[];
  busy?: boolean;
  pending?: Record<string, boolean>;
  onPause?: (runId: string) => void;
  onResume?: (runId: string) => void;
  onCancel?: (runId: string) => void;
  /** C5: el run terminado ofrece empezar otro, en el chat del coordinador. */
  onNewRequest?: () => void;
  /** Inyectable para los tests: la hora local de un ISO. */
  formatTime?: (value: string) => string;
  /**
   * O1: lo que la línea "Ahora" necesita saber del coordinador y que el run no
   * trae: si su proceso está vivo, cuántas preguntas nativas, permisos o
   * decisiones dejó esperándote, y cuántos mensajes del equipo no leyó.
   */
  coordinatorPaused?: boolean;
  coordinatorWaiting?: number;
  coordinatorUnread?: number;
  /** O1: el enlace de "X espera tu respuesta": abre la fila y el hilo de quien espera. */
  onOpenMember?: (memberId: string) => void;
  /** O1: "Reanudar" en la línea: el mismo reanudar de la tarjeta de pausa del miembro. */
  onResumeCoordinator?: (memberId: string) => void;
}

/** "A", "A y B", "A, B y C": la conjunción sale del diccionario. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return t('coord.now.and', { first: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

/** La frase de la línea "Ahora", en palabras. Una sola, sin ids. */
export function nowLineText(line: NowLine, nameOf: (memberId: string | null, roleId?: string) => string): string {
  switch (line.kind) {
    case 'waiting': return line.memberIds.length === 1
      ? t('coord.now.waitingOne', { name: nameOf(line.memberIds[0]) })
      : t('coord.now.waitingMany', { count: line.memberIds.length, names: joinNames(line.memberIds.map((id) => nameOf(id))) });
    case 'coordinatorPaused': {
      const name = nameOf(line.memberId);
      if (line.unread === 0) return t('coord.now.paused', { name });
      return line.unread === 1 ? t('coord.now.pausedUnreadOne', { name }) : t('coord.now.pausedUnreadMany', { name, count: line.unread });
    }
    case 'missing': return t(line.noBudget ? 'coord.now.missingNoBudget' : 'coord.now.missing', { title: line.title });
    case 'working': return line.workers.length === 1
      ? t('coord.now.workingOne', { name: nameOf(line.workers[0].memberId, line.workers[0].roleId), title: line.title })
      : t('coord.now.workingMany', { count: line.workers.length, names: joinNames(line.workers.map((w) => nameOf(w.memberId, w.roleId))) });
    default: return t('coord.now.calm');
  }
}

/** Qué controles tiene este run. Mismo criterio que `planRunControls`, sin la frase de estado: el estado ya lo dice la barra. */
function controlsFor(run: CoordinationRunView): { pause: boolean; resume: boolean; cancel: boolean } {
  if (!run.active) return { pause: false, resume: false, cancel: false };
  switch (run.status) {
    case 'planning': return { pause: false, resume: false, cancel: true };
    case 'running': return { pause: true, resume: false, cancel: true };
    case 'suspended': return { pause: false, resume: true, cancel: true };
    default: return { pause: false, resume: false, cancel: false };
  }
}

/** El estado de una ficha de tarea: lo que decide su ícono y su color. */
export type TaskChipState = 'done' | 'live' | 'failed' | 'asking' | 'pending';

export function taskChipState(task: CoordinationRunTaskView, askedTaskIds: ReadonlySet<string>): TaskChipState {
  if (askedTaskIds.has(task.id)) return 'asking';
  switch (task.status) {
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'dispatched': case 'running': return 'live';
    default: return 'pending';
  }
}

function taskLabel(state: TaskChipState): string {
  switch (state) {
    case 'done': return t('coord.task.done');
    case 'live': return t('coord.task.live');
    case 'failed': return t('coord.task.failed');
    case 'asking': return t('coord.task.asking');
    default: return t('coord.task.pending');
  }
}

function TaskIcon({ state }: { state: TaskChipState }) {
  if (state === 'done') return <CircleCheck size={14} className="coord-ic-ok" />;
  if (state === 'failed') return <CircleX size={14} className="coord-ic-bad" />;
  if (state === 'asking') return <CircleHelp size={14} className="coord-ic-live" />;
  if (state === 'live') return <i className="coord-dot coord-dot-live" />;
  return <Clock size={14} className="coord-ic-idle" />;
}

export function RunHeader(props: RunHeaderProps) {
  const { run } = props;
  const team = props.team ?? [];
  const roles = props.roles ?? [];
  const time = props.formatTime ?? ((value: string) => hourOf(value));
  const controls = controlsFor(run);
  const inFlightAction = Boolean(props.busy) || Boolean(props.pending?.[`run:${run.id}`]);
  const openAsks = (props.asks ?? []).filter((ask) => !ask.answeredAt);
  const askedTaskIds = new Set(openAsks.map((ask) => ask.taskId).filter((id): id is string => Boolean(id)));

  const done = run.tasksDone;
  const failed = run.tasksFailed;
  const inFlight = run.tasksInFlight;
  const total = done + failed + inFlight + run.tasksPending;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const used = done + failed;
  const max = run.budget?.maxDispatches ?? null;
  const finished = !run.active;
  const cancelled = run.status === 'cancelled';
  const line = nowLine({
    run, tasks: props.tasks ?? [], asks: props.asks ?? [],
    coordinatorPaused: Boolean(props.coordinatorPaused),
    coordinatorWaiting: props.coordinatorWaiting ?? 0,
    coordinatorUnread: props.coordinatorUnread ?? 0,
  });
  const nameOf = (memberId: string | null, roleId?: string) => memberDisplayName(memberId, team, roleId ?? null, roles);
  /**
   * O2: un equipo suspendido PORQUE SU COORDINADOR ESTÁ EN PAUSA se reanuda
   * reanudando al coordinador: es lo único que lo destraba (el motor entrega
   * la cola y vuelve a `running`). Reanudar sólo el run lo dejaría andando con
   * nadie que lea los avisos.
   */
  const resumeTeam = () => {
    if (run.suspendReason === 'coordinator_paused' && run.coordinatorMemberId && props.onResumeCoordinator) props.onResumeCoordinator(run.coordinatorMemberId);
    else props.onResume?.(run.id);
  };

  return <div className="coord-head">
    <div className="coord-head-top">
      {/* C7: TERMINADO Y CANCELADO SON DOS FINALES DISTINTOS.
          Un run cancelado no "termino": lo cortaron. Decirle lo mismo a los dos
          --bandera verde incluida-- le mentiria a la persona sobre lo que
          paso con su pedido. */}
      {finished && <span className={'coord-tic coord-tic-lg ' + (cancelled ? 'coord-tic-bad' : 'coord-tic-ok')} data-run-status={run.status}>{cancelled ? <CircleX size={16} /> : <Flag size={16} />}</span>}
      <div className="coord-head-title">
        <div className="coord-head-name">{run.request ?? props.title}</div>
        {/* EL CIERRE ES UNA LINEA: "Terminamos · 4 de 4".
            Eran dos datos separados y ninguno decia lo que se quiere leer: la
            hora arriba ("Terminado a las 14:20") y el avance al costado ("4 de
            4 listas"). La hora no es la noticia. Un run CANCELADO conserva la
            suya: no "terminamos" nada, lo cortaron, y la hora del corte es
            justamente lo que se busca despues. */}
        <div className="coord-head-sub">{finished
          ? (cancelled ? t('coord.cancelled.at', { time: time(run.updatedAt) }) : t('coord.done.together', { done, total }))
          : props.coordinatorName
            ? t('coord.run.coordinates', { name: props.coordinatorName, time: time(run.createdAt) })
            : ''}</div>
      </div>
      {!finished && openAsks.length > 0 && <span className="coord-pill coord-pill-live"><CircleHelp size={13} />{t('coord.run.needsYou')}</span>}
      <div className="coord-progress">
        <div className="coord-progress-line">
          {/* EL ROTULO NO SE REPITE. Sobre un run terminado el subtitulo ya dice
              "Terminamos · 4 de 4": escribir "4 de 4 listas" al costado es el
              mismo dato dos veces, y la barra llena lo muestra sin una palabra.
              Un run CANCELADO lo conserva: su subtitulo dice la hora del corte,
              no las cuentas, asi que este es el unico lugar donde se leen. */}
          {(!finished || cancelled) && <span className="coord-progress-done">{t('coord.run.progress', { done, total })}</span>}
          <span className="coord-progress-rest">{finished
            ? t('coord.run.failedCount', { count: failed })
            : t('coord.run.inFlight', { count: inFlight })}</span>
        </div>
        <div className="coord-bar" role="progressbar" aria-label={t('coord.run.progressLabel')}
          aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <i className="coord-bar-done" style={{ width: pct(done) + '%' }} />
          <i className="coord-bar-live" style={{ width: pct(inFlight) + '%' }} />
          <i className="coord-bar-failed" style={{ width: pct(failed) + '%' }} />
        </div>
      </div>
      <span className="coord-pill coord-pill-dispatches">
        <Send size={13} />
        {run.budgetInvalid
          ? t('coord.run.budgetInvalid')
          : max == null ? t('coord.run.dispatchesNoCap', { used }) : t('coord.run.dispatches', { used, max })}
      </span>
      {finished
        ? props.onNewRequest && <button type="button" className="coord-btn coord-btn-primary" onClick={props.onNewRequest}><MessageSquare size={14} />{t('coord.done.newRequest')}</button>
        : <div className="coord-head-actions">
          {controls.pause && <button type="button" className="coord-btn coord-icon-btn team-pause-coordination" aria-label={t('coord.run.pause')} title={t('coord.run.pause')} disabled={inFlightAction} onClick={() => props.onPause?.(run.id)}><Pause size={14} /></button>}
          {controls.resume && <button type="button" className="coord-btn coord-icon-btn team-resume-coordination" aria-label={t('coord.run.resume')} title={t('coord.run.resume')} disabled={inFlightAction} onClick={resumeTeam}><Play size={14} /></button>}
          {controls.cancel && <button type="button" className="coord-btn coord-icon-btn team-cancel-coordination" aria-label={t('coord.run.cancel')} title={t('coord.run.cancel')} disabled={inFlightAction} onClick={() => props.onCancel?.(run.id)}><X size={14} /></button>}
        </div>}
    </div>
    {/* O1: LA LINEA "AHORA". Una frase, siempre, con el run activo: que te
        espera, quien esta en pausa, que falta o quien trabaja. Sobre un run
        terminado no hay: el subtitulo ya dice "Terminamos · 3 de 3". */}
    {line && <p className={'coord-now' + (line.kind === 'waiting' ? ' is-waiting' : '')} data-now={line.kind} aria-label={t('coord.now.label')}>
      {line.kind === 'waiting' && props.onOpenMember
        ? <button type="button" className="coord-now-link" onClick={() => props.onOpenMember?.(line.memberIds[0])}><CircleHelp size={14} />{nowLineText(line, nameOf)}</button>
        : <span className="coord-now-text">{line.kind === 'waiting' && <CircleHelp size={14} />}{nowLineText(line, nameOf)}</span>}
      {line.kind === 'coordinatorPaused' && props.onResumeCoordinator && <>
        <span className="coord-now-sep" aria-hidden="true">·</span>
        <button type="button" className="coord-now-action" disabled={inFlightAction} onClick={() => props.onResumeCoordinator?.(line.memberId)}><Play size={13} />{t('coord.now.resume')}</button>
      </>}
    </p>}
    {(props.tasks?.length ?? 0) > 0 && <ul className="coord-tasks" aria-label={t('coord.tasks.label')}>
      {props.tasks!.map((task) => {
        const state = taskChipState(task, askedTaskIds);
        const owner = roleDisplayName(task.roleId, roles, team);
        const client = isClientTask(task);
        return <li key={task.id} className={'coord-task is-' + state} data-task-state={state} data-audience={client ? 'client' : undefined}
          title={taskLabel(state) + ' · ' + taskTitle(task.spec, task.title, TASK_TITLE_LONG) + (client ? ' · ' + t('coord.audience.client') : '')}>
          <TaskIcon state={state} />
          <span className="coord-task-title">{taskTitle(task.spec, task.title)}</span>
          {client && <AudienceBadge compact />}
          <CoordAvatar name={owner} small roleId={task.roleId} avatar={avatarOfRole(task.roleId, roles, team)} />
          <span className="visually-hidden">{taskLabel(state)}</span>
        </li>;
      })}
    </ul>}
  </div>;
}

