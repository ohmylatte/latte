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

/** Statuses that can never resolve on their own — a dependent on one of these must not be marked ready. */
const POISONED: ReadonlySet<CoordinationTaskStatus> = new Set(['failed', 'blocked']);

function directDependencies(edges: DagEdge[], taskId: string): string[] {
  return edges.filter((e) => e.taskId === taskId).map((e) => e.dependsOnId);
}

/**
 * Every `pending` task whose dependencies (if any) are ALL `done`. A task
 * with no dependencies is ready immediately. A task with any non-`done`
 * dependency — including a `failed`/`blocked` one — is never returned here;
 * see `computeBlockedTasks` for that case.
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
 * Every task that must move to `blocked` because a dependency (direct or
 * transitive) is itself `failed` or `blocked`. Computed to a fixed point in
 * one call, so a chain blocks all the way down without the caller having to
 * re-invoke this per hop — a task never stalls `pending` forever.
 */
export function computeBlockedTasks(tasks: DagTask[], edges: DagEdge[]): string[] {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (blocked.has(task.id)) continue;
      const status = statusById.get(task.id);
      if (status !== 'pending' && status !== 'ready') continue;
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
