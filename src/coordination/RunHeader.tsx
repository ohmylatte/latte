import { CircleCheck, CircleHelp, CircleX, Clock, Flag, MessageSquare, Pause, Play, Send, X } from 'lucide-react';
import { translate as t } from '../i18n';
import { CoordAvatar } from './anatomy';
import { roleDisplayName } from './names';
import { initialsOf, titleOf } from './text';
import { hourOf } from './time';
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
  /** El título del pedido, ya resuelto por quien tiene el Trabajo a mano. */
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

  return <div className="coord-head">
    <div className="coord-head-top">
      {finished && <span className="coord-tic coord-tic-ok coord-tic-lg"><Flag size={16} /></span>}
      <div className="coord-head-title">
        <div className="coord-head-name">{props.title}</div>
        <div className="coord-head-sub">{finished
          ? t('coord.done.at', { time: time(run.updatedAt) })
          : props.coordinatorName
            ? t('coord.run.coordinates', { name: props.coordinatorName, time: time(run.createdAt) })
            : ''}</div>
      </div>
      {!finished && openAsks.length > 0 && <span className="coord-pill coord-pill-live"><CircleHelp size={13} />{t('coord.run.needsYou')}</span>}
      <div className="coord-progress">
        <div className="coord-progress-line">
          <span className="coord-progress-done">{t('coord.run.progress', { done, total })}</span>
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
          {controls.resume && <button type="button" className="coord-btn coord-icon-btn team-resume-coordination" aria-label={t('coord.run.resume')} title={t('coord.run.resume')} disabled={inFlightAction} onClick={() => props.onResume?.(run.id)}><Play size={14} /></button>}
          {controls.cancel && <button type="button" className="coord-btn coord-icon-btn team-cancel-coordination" aria-label={t('coord.run.cancel')} title={t('coord.run.cancel')} disabled={inFlightAction} onClick={() => props.onCancel?.(run.id)}><X size={14} /></button>}
        </div>}
    </div>
    {(props.tasks?.length ?? 0) > 0 && <ul className="coord-tasks" aria-label={t('coord.tasks.label')}>
      {props.tasks!.map((task) => {
        const state = taskChipState(task, askedTaskIds);
        const owner = roleDisplayName(task.roleId, roles, team);
        return <li key={task.id} className={'coord-task is-' + state} data-task-state={state} title={taskLabel(state) + ' · ' + titleOf(task.spec)}>
          <TaskIcon state={state} />
          <span className="coord-task-title">{titleOf(task.spec)}</span>
          <CoordAvatar name={owner} small roleId={task.roleId} />
          <span className="visually-hidden">{taskLabel(state)}</span>
        </li>;
      })}
    </ul>}
  </div>;
}

/** Las iniciales que la tira dibuja, expuestas para quien necesite el mismo avatar en otra fila. */
export const ownerInitials = (roleId: string, roles: readonly AgentRole[], team: readonly TeamMember[]) =>
  initialsOf(roleDisplayName(roleId, roles, team));
