import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemberTab } from './TeamPanel';

/**
 * C2: EL PUNTO DEL AVATAR ES EL ESTADO, Y NO DICE NI UNA PALABRA.
 *
 * M3 ponía un hilo de vapor en lugar del punto mientras el rol trabajaba. La
 * pestaña pasó a tener la MISMA anatomía que toda fila del producto (criterio
 * 1), y en esa anatomía el estado vive en UN lugar: el punto del avatar, con
 * halo en el acento cuando está vivo. Dos marcas distintas para el mismo
 * hecho, en la misma fila, es exactamente lo que el criterio 5 evita.
 *
 * La regla de M3 se conserva entera: la señal viva sólo aparece cuando el rol
 * está HACIENDO algo, nunca como decoración.
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

const renderTab = (mode: 'simple' | 'advanced' = 'simple') =>
  render(<MemberTab member={member as never} chat={chat as never} selected={false} busy={false} mode={mode} onSelect={() => {}} />);

beforeEach(() => {
  mocks.state = { ...baseState };
});

describe('C2: el punto del avatar dice el estado del rol', () => {
  it('el rol trabajando lleva el punto vivo, con halo', () => {
    mocks.state = { ...baseState, status: 'working', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.coord-av .coord-dot-live')).not.toBeNull();
    // Ninguna segunda marca para el mismo hecho.
    expect(container.querySelector('.team-steam')).toBeNull();
    expect(container.querySelector('.team-tab-dot')).toBeNull();
  });

  it('el rol ocioso cae en el punto quieto', () => {
    mocks.state = { ...baseState, status: 'idle', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.coord-av .coord-dot-idle')).not.toBeNull();
    expect(container.querySelector('.coord-dot-live')).toBeNull();
  });

  /** Un permiso pendiente TE espera: eso es acento, por el criterio 2. */
  it('el rol que necesita algo tuyo lleva el punto vivo', () => {
    mocks.state = { ...baseState, status: 'working', closed: false, permissions: [{ id: 'p1' }] };
    const { container } = renderTab();
    expect(container.querySelector('.coord-av .coord-dot-live')).not.toBeNull();
    expect(container.querySelector('.team-steam')).toBeNull();
  });

  /** Criterio 5: ninguna palabra de estado en la pestaña. */
  it('el estado no se escribe: no hay pastilla con una palabra', () => {
    mocks.state = { ...baseState, status: 'working', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.team-member-state')).toBeNull();
  });
});
