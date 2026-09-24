import { taskTitle } from '../../shared/taskTitle';
import type { CoordinationAskView, CoordinationRunTaskView, CoordinationRunView } from '../../shared/contracts';

/**
 * O1: LA LÍNEA "AHORA". UNA FRASE QUE CONTESTA LA ÚNICA PREGUNTA QUE IMPORTA.
 *
 * Lo que vio el dueño (2026-09-24): "2 de 3 listas · 0 en curso · 2/3
 * despachos", la tercera tarea sin empezar, un miembro que había reportado y
 * un coordinador que no contestaba. "Literal no sé si terminaron, si tengo que
 * hacer algo, es rarísimo." La barra dice cuánto; nada decía qué pasa ahora ni
 * qué se espera de la persona.
 *
 * El orden ES la regla, y cada rama existe porque la anterior no se cumplió:
 *
 *  1. algo te espera (una `latte_ask` abierta, o una pregunta nativa o un
 *     permiso del coordinador): nada es más urgente que lo que sólo vos podés
 *     destrabar;
 *  2. el coordinador está en pausa con el run activo: los avisos se le
 *     encolan y el equipo se queda quieto sin decirlo;
 *  3. falta una tarea y nadie la tiene: ni despachada ni esperando una
 *     dependencia viva (y si el presupuesto se agotó, se dice);
 *  4. alguien trabaja: quién y en qué;
 *  5. nada de lo anterior: nada te espera.
 *
 * Un run terminado no tiene línea (`null`): su subtítulo ya dice
 * "Terminamos · 3 de 3", y decirlo dos veces es el error que C1 sacó.
 *
 * Pura y sin copy: devuelve QUÉ decir; el encabezado lo pone en palabras.
 */

export type NowLine =
  | { kind: 'waiting'; memberIds: string[] }
  | { kind: 'coordinatorPaused'; memberId: string; unread: number }
  | { kind: 'missing'; taskId: string; title: string; noBudget: boolean }
  | { kind: 'working'; workers: Array<{ memberId: string | null; roleId: string }>; title: string }
  | { kind: 'calm' };

export interface NowLineInput {
  run: CoordinationRunView;
  tasks: readonly CoordinationRunTaskView[];
  /** Todas las del run: las contestadas se descartan acá. */
  asks: readonly CoordinationAskView[];
  /** El coordinador no tiene proceso vivo (la persona lo pausó, o se cayó). */
  coordinatorPaused: boolean;
  /** Preguntas nativas y permisos que el coordinador dejó pendientes. */
  coordinatorWaiting: number;
  /** Mensajes del equipo al coordinador que todavía no leyó. */
  coordinatorUnread: number;
}

const IN_FLIGHT = new Set<CoordinationRunTaskView['status']>(['dispatched', 'running']);
const TERMINAL = new Set<CoordinationRunTaskView['status']>(['done', 'failed']);

export function nowLine(input: NowLineInput): NowLine | null {
  const { run, tasks } = input;
  if (!run.active) return null;
  const coordinatorId = run.coordinatorMemberId;

  // 1. Lo que te espera.
  const openAsks = input.asks.filter((ask) => !ask.answeredAt);
  const waiting: string[] = [];
  for (const ask of openAsks) if (!waiting.includes(ask.memberId)) waiting.push(ask.memberId);
  if (input.coordinatorWaiting > 0 && coordinatorId && !waiting.includes(coordinatorId)) waiting.push(coordinatorId);
  if (waiting.length > 0) return { kind: 'waiting', memberIds: waiting };

  // 2. El coordinador en pausa. El motivo del run alcanza solo: el motor lo
  // escribe cuando le llega un aviso que no puede entregar.
  if (coordinatorId && (input.coordinatorPaused || run.suspendReason === 'coordinator_paused')) {
    return { kind: 'coordinatorPaused', memberId: coordinatorId, unread: input.coordinatorUnread };
  }

  // 3. Lo que falta y nadie tiene. `pending` sólo falta si ninguna de sus
  // dependencias sigue viva: la que espera a una en curso ya tiene dueño.
  const statusOf = new Map(tasks.map((task) => [task.id, task.status]));
  const askedTaskIds = new Set(openAsks.map((ask) => ask.taskId).filter((id): id is string => Boolean(id)));
  const missing = tasks.find((task) => {
    if (askedTaskIds.has(task.id)) return false;
    if (task.status === 'ready') return true;
    if (task.status !== 'pending') return false;
    return task.dependsOn.every((dep) => { const status = statusOf.get(dep); return status == null || TERMINAL.has(status); });
  });
  if (missing) {
    const max = run.budget?.maxDispatches ?? null;
    const committed = run.tasksDone + run.tasksFailed + run.tasksInFlight;
    const noBudget = /^(global_)?max_/.test(run.suspendReason ?? '') || (max != null && committed >= max);
    return { kind: 'missing', taskId: missing.id, title: taskTitle(missing.spec, missing.title), noBudget };
  }

  // 4. Quién trabaja.
  const live = tasks.filter((task) => IN_FLIGHT.has(task.status));
  if (live.length > 0) {
    const workers: Array<{ memberId: string | null; roleId: string }> = [];
    for (const task of live) {
      const key = task.assignedMemberId ?? task.roleId;
      if (workers.some((w) => (w.memberId ?? w.roleId) === key)) continue;
      workers.push({ memberId: task.assignedMemberId, roleId: task.roleId });
    }
    return { kind: 'working', workers, title: taskTitle(live[0].spec, live[0].title) };
  }

  // 5. Nada te espera.
  return { kind: 'calm' };
}
