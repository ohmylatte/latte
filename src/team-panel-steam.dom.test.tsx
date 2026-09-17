import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemberTab } from './TeamPanel';

/**
 * M3 — "un hilo de vapor por rol". The steam replaces the dot ONLY while the
 * role is working; every other state (idle, ended, paused, attention) keeps the
 * quiet dot. This locks the "Verdaderas" rule: the wisp never shows when the
 * role is not doing anything.
 */

const mocks = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    chatStore: {
      subscribe: () => () => {},
      get: () => mocks.state,
    },
  };
});

const baseState = {
  messages: [], draft: '', status: 'working', statusDetail: '',
  permissions: [], questions: [], error: null, closed: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  lastTurn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
};

const member = {
  roleId: 'strategist', roleName: 'Estratega', initial: 'E', runtime: 'opencode', status: 'working',
} as unknown;

const chat = { id: 'c1' } as unknown;

const renderTab = () =>
  render(<MemberTab member={member as never} chat={chat as never} selected={false} busy={false} onSelect={() => {}} />);

beforeEach(() => {
  mocks.state = { ...baseState };
});

describe('M3 — working role shows steam, not a dot', () => {
  it('shows the steam wisp while the role is working', () => {
    mocks.state = { ...baseState, status: 'working', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.team-steam')).not.toBeNull();
    expect(container.querySelector('.team-tab-dot')).toBeNull();
  });

  it('falls back to the quiet dot when idle', () => {
    mocks.state = { ...baseState, status: 'idle', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.team-steam')).toBeNull();
    expect(container.querySelector('.team-tab-dot')).not.toBeNull();
  });

  it('never shows steam when the role needs attention', () => {
    mocks.state = { ...baseState, status: 'working', closed: false, permissions: [{ id: 'p1' }] };
    const { container } = renderTab();
    expect(container.querySelector('.team-steam')).toBeNull();
    expect(container.querySelector('.team-tab-dot')).not.toBeNull();
  });
});
