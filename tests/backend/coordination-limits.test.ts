import { describe, expect, it } from 'vitest';
import * as limits from '../../electron/coordination/limits';
import {
  ASK_TTL_DEFAULT_MINUTES,
  ASK_TTL_MAX_MINUTES,
  MAX_ACTIVE_COORDINATION_RUNS,
  MAX_ATTEMPTS_PER_TASK,
  MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK,
  MAX_CODEX_APP_SERVERS_TOTAL,
  MAX_COORDINATED_CODEX_MEMBERS_PER_RUN,
  MAX_COORDINATED_CODEX_PROCESSES,
  MAX_DEPENDENCY_DEPTH,
  MAX_TASKS_PER_RUN,
} from '../../electron/coordination/limits';

describe('coordination structural limits', () => {
  it('caps a run at 200 tasks', () => {
    expect(MAX_TASKS_PER_RUN).toBe(200);
  });

  it('caps the dependency chain at depth 20', () => {
    expect(MAX_DEPENDENCY_DEPTH).toBe(20);
  });

  it('caps attempts at 3 per task before it blocks', () => {
    expect(MAX_ATTEMPTS_PER_TASK).toBe(3);
  });

  // `MAX_CHECK_WAIT_SECONDS` se fue con el parámetro `wait` de `latte_check`:
  // el servidor nunca esperó y el buzón todavía no tiene productor, así que
  // ni la constante ni el parámetro se publican más.

  it('defaults an ask TTL to 30 minutes, capped at 1440', () => {
    expect(ASK_TTL_DEFAULT_MINUTES).toBe(30);
    expect(ASK_TTL_MAX_MINUTES).toBe(1440);
  });

  it('caps coordinated Codex members at 3 per run, 6 app-wide, plus a 1-member bootstrap slot (design-v2-conversational, the old app-wide-only name is gone)', () => {
    expect(MAX_COORDINATED_CODEX_MEMBERS_PER_RUN).toBe(3);
    expect(MAX_COORDINATED_CODEX_PROCESSES).toBe(6);
    expect(MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK).toBe(1);
    expect((limits as Record<string, unknown>).MAX_COORDINATED_CODEX_MEMBERS).toBeUndefined();
  });

  it('caps active coordination runs app-wide at 4 (task 6.15: never a silent queue past this)', () => {
    expect(MAX_ACTIVE_COORDINATION_RUNS).toBe(4);
  });

  it('caps every Latte-spawned codex app-server process (coordination-injected or engram-only) at 10 app-wide, of which at most 6 may be coordination-injected', () => {
    expect(MAX_CODEX_APP_SERVERS_TOTAL).toBe(10);
    expect(MAX_COORDINATED_CODEX_PROCESSES).toBeLessThanOrEqual(MAX_CODEX_APP_SERVERS_TOTAL);
  });
});
