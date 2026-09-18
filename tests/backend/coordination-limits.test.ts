import { describe, expect, it } from 'vitest';
import * as limits from '../../electron/coordination/limits';
import {
  ASK_TTL_DEFAULT_MINUTES,
  ASK_TTL_MAX_MINUTES,
  MAX_ATTEMPTS_PER_TASK,
  MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK,
  MAX_CHECK_WAIT_SECONDS,
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

  it('caps latte_check server-side wait at 30 seconds', () => {
    expect(MAX_CHECK_WAIT_SECONDS).toBe(30);
  });

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
});
