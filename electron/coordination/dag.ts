import { MAX_DEPENDENCY_DEPTH, MAX_TASKS_PER_RUN } from './limits';

/**
 * Pure task-DAG logic: readiness, cycle rejection, depth and fan-out caps.
 * No I/O, no DB, no clock — every function here takes plain data and returns
 * plain data. The caller (the repository, later the engine) is the one that
 * persists the result.
 */

export type CoordinationTaskStatus = 'pending' | 'ready' | 'dispatched' | 'running' | 'done' | 'failed' | 'blocked';

export interface DagTask {
  id: string;
  status: CoordinationTaskStatus;
}

/** One edge: `taskId` depends on `dependsOnId` (dependsOnId must finish first). */
export interface DagEdge {
  taskId: string;
  dependsOnId: string;
}

/**
 * El único estado del que un dependiente no se recupera nunca.
 *
 * `blocked` SALIÓ de este conjunto (decisión D1 de la ronda final): ya no
 * significa "muerta sin remedio" sino "esperando una respuesta", y una
 * pregunta se contesta — la tarea vuelve a `ready` y sus dependientes tienen
 * que poder correr detrás. Envenenar la cadena entera por una pregunta
 * abierta mataba trabajo que todavía iba a poder hacerse.
 */
const POISONED: ReadonlySet<CoordinationTaskStatus> = new Set(['failed']);

function directDependencies(edges: DagEdge[], taskId: string): string[] {
  return edges.filter((e) => e.taskId === taskId).map((e) => e.dependsOnId);
}

/**
 * Every `pending` task whose dependencies (if any) are ALL `done`. A task
 * with no dependencies is ready immediately. A task with any non-`done`
 * dependency — including a `failed`/`blocked` one — is never returned here;
 * see `computeDoomedTasks` for that case.
 */
export function computeReadyTasks(tasks: DagTask[], edges: DagEdge[]): string[] {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const ready: string[] = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const deps = directDependencies(edges, task.id);
    const allDone = deps.every((depId) => statusById.get(depId) === 'done');
    if (allDone) ready.push(task.id);
  }
  return ready;
}

/**
 * Toda tarea CONDENADA: una dependencia suya (directa o transitiva) terminó
 * `failed`, así que nunca va a poder correr. Se calcula a punto fijo en una
 * sola llamada, de modo que la cadena entera cae de una — el llamador no tiene
 * que reinvocar esto salto por salto, y ninguna tarea se queda `pending` para
 * siempre.
 *
 * Se llamaba `computeBlockedTasks` y el llamador las movía a `blocked`.
 * `blocked` no era terminal, así que el run quedaba vivo eternamente esperando
 * una intervención que nadie podía hacer: una dependencia `failed` no se
 * destraba. Hoy esto nombra lo que es —condena, no bloqueo— y el motor las
 * pasa a `failed` con outcome `dependency_failed`.
 */
export function computeDoomedTasks(tasks: DagTask[], edges: DagEdge[]): string[] {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (blocked.has(task.id)) continue;
      const status = statusById.get(task.id);
      // `blocked` (esperando una respuesta) entra igual: si la dependencia se
      // cayó, contestar la pregunta ya no la salva.
      if (status !== 'pending' && status !== 'ready' && status !== 'blocked') continue;
      const deps = directDependencies(edges, task.id);
      const poisoned = deps.some((depId) => POISONED.has(statusById.get(depId) as CoordinationTaskStatus) || blocked.has(depId));
      if (poisoned) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return [...blocked];
}

/**
 * True if the requested `dependsOnId` can already reach `taskId` by following
 * existing edges — meaning `taskId` (transitively) depends on `dependsOnId`
 * already, so adding "taskId depends on dependsOnId" would close a loop.
 * Also true for a task depending on itself.
 */
export function wouldCreateCycle(edges: DagEdge[], taskId: string, dependsOnId: string): boolean {
  if (taskId === dependsOnId) return true;
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of directDependencies(edges, current)) stack.push(next);
  }
  return false;
}

/** A task's depth is one more than its deepest direct dependency, or 0 with none. */
export function computeTaskDepth(dependencyDepths: number[]): number {
  return dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1;
}

export type CreateTaskDecision = { ok: true } | { ok: false; reason: 'task_cap' | 'depth_cap' };

/** Validates a new task against the run's fan-out and depth caps before it is ever created. */
export function canAddTask(input: { currentTaskCount: number; proposedDepth: number }): CreateTaskDecision {
  if (input.currentTaskCount >= MAX_TASKS_PER_RUN) return { ok: false, reason: 'task_cap' };
  if (input.proposedDepth > MAX_DEPENDENCY_DEPTH) return { ok: false, reason: 'depth_cap' };
  return { ok: true };
}
