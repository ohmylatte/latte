import { describe, expect, it } from 'vitest';
import {
  ASK_TTL_DEFAULT_MINUTES,
  ASK_TTL_MAX_MINUTES,
  MAX_ATTEMPTS_PER_TASK,
  MAX_CHECK_WAIT_SECONDS,
  MAX_COORDINATED_CODEX_MEMBERS,
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

  it('caps coordinated Codex members at 3 processes per account', () => {
    expect(MAX_COORDINATED_CODEX_MEMBERS).toBe(3);
  });
});
