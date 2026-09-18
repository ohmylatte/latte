import { describe, expect, it } from 'vitest';
import {
  canAddTask,
  computeBlockedTasks,
  computeReadyTasks,
  computeTaskDepth,
  wouldCreateCycle,
  type DagEdge,
  type DagTask,
} from '../../electron/coordination/dag';
import { MAX_DEPENDENCY_DEPTH, MAX_TASKS_PER_RUN } from '../../electron/coordination/limits';

describe('coordination dag (pure)', () => {
  it('readiness on dependency completion: T becomes ready once A and B are both done', () => {
    const tasks: DagTask[] = [
      { id: 'A', status: 'done' },
      { id: 'B', status: 'done' },
      { id: 'T', status: 'pending' },
    ];
    const edges: DagEdge[] = [
      { taskId: 'T', dependsOnId: 'A' },
      { taskId: 'T', dependsOnId: 'B' },
    ];
    expect(computeReadyTasks(tasks, edges)).toEqual(['T']);
  });

  it('readiness withheld while any dependency is unfinished', () => {
    const tasks: DagTask[] = [
      { id: 'A', status: 'done' },
      { id: 'B', status: 'running' },
      { id: 'T', status: 'pending' },
    ];
    const edges: DagEdge[] = [
      { taskId: 'T', dependsOnId: 'A' },
      { taskId: 'T', dependsOnId: 'B' },
    ];
    expect(computeReadyTasks(tasks, edges)).toEqual([]);
  });

  it('a task with no dependencies is immediately ready', () => {
    const tasks: DagTask[] = [{ id: 'solo', status: 'pending' }];
    expect(computeReadyTasks(tasks, [])).toEqual(['solo']);
  });

  it('dependency failure blocks the dependent, never leaves it pending forever', () => {
    const tasks: DagTask[] = [
      { id: 'A', status: 'failed' },
      { id: 'T', status: 'pending' },
    ];
    const edges: DagEdge[] = [{ taskId: 'T', dependsOnId: 'A' }];
    expect(computeBlockedTasks(tasks, edges)).toEqual(['T']);
    // A blocked/failed dependency must never also read as "ready".
    expect(computeReadyTasks(tasks, edges)).toEqual([]);
  });

  it('blocking cascades transitively through a chain', () => {
    const tasks: DagTask[] = [
      { id: 'A', status: 'failed' },
      { id: 'B', status: 'pending' },
      { id: 'C', status: 'pending' },
    ];
    const edges: DagEdge[] = [
      { taskId: 'B', dependsOnId: 'A' },
      { taskId: 'C', dependsOnId: 'B' },
    ];
    expect(computeBlockedTasks(tasks, edges).sort()).toEqual(['B', 'C']);
  });

  it('rejects a cycle A -> B -> C -> A', () => {
    const edges: DagEdge[] = [
      { taskId: 'A', dependsOnId: 'B' },
      { taskId: 'B', dependsOnId: 'C' },
    ];
    expect(wouldCreateCycle(edges, 'C', 'A')).toBe(true);
  });

  it('does not flag an unrelated new edge as a cycle', () => {
    const edges: DagEdge[] = [
      { taskId: 'A', dependsOnId: 'B' },
      { taskId: 'B', dependsOnId: 'C' },
    ];
    expect(wouldCreateCycle(edges, 'D', 'A')).toBe(false);
  });

  it('a task cannot depend on itself', () => {
    expect(wouldCreateCycle([], 'A', 'A')).toBe(true);
  });

  it('enforces the task-count cap: a run already at 200 tasks rejects a 201st', () => {
    expect(MAX_TASKS_PER_RUN).toBe(200);
    expect(canAddTask({ currentTaskCount: 199, proposedDepth: 0 })).toEqual({ ok: true });
    expect(canAddTask({ currentTaskCount: 200, proposedDepth: 0 })).toEqual({ ok: false, reason: 'task_cap' });
  });

  it('enforces the dependency-depth cap: a 21st link in a chain of 20 is rejected', () => {
    expect(MAX_DEPENDENCY_DEPTH).toBe(20);
    expect(canAddTask({ currentTaskCount: 0, proposedDepth: 20 })).toEqual({ ok: true });
    expect(canAddTask({ currentTaskCount: 0, proposedDepth: 21 })).toEqual({ ok: false, reason: 'depth_cap' });
  });

  it('computes a task depth as one more than its deepest direct dependency', () => {
    expect(computeTaskDepth([])).toBe(0);
    expect(computeTaskDepth([0])).toBe(1);
    expect(computeTaskDepth([3, 7, 2])).toBe(8);
  });
});
