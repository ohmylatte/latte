import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemberTab } from './TeamPanel';

/**
 * M3 — UN HILO DE VAPOR POR ROL.
 *
 * El vapor dice "está haciendo algo"; el punto quieto dice "no está haciendo
 * nada"; el punto con halo dice "te necesita". Son TRES hechos distintos, y
 * cada uno lleva su forma —ninguno se comunica sólo por el color.
 *
 * La marca es UNA por fila: mientras el rol trabaja el hilo reemplaza al
 * punto del avatar, porque dos marcas para el mismo hecho es exactamente lo
 * que el criterio 5 evita. El hilo nace sólo del estado real del chat
 * (`status: 'working'`), nunca como decoración: si el rol se queda quieto,
 * el hilo desaparece y vuelve el punto `--neutral-mid`.
 *
 * "Necesita atención" es el caso de hoy, intacto: punto `--rust` con halo.
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

describe('M3: un hilo de vapor por rol, sólo cuando trabaja', () => {
  it('el rol trabajando lleva el hilo de vapor de SU color, y no el punto', () => {
    mocks.state = { ...baseState, status: 'working', closed: false };
    const { container } = renderTab();

    const wisp = container.querySelector('svg.team-steam');
    expect(wisp, 'rol trabajando sin hilo de vapor').not.toBeNull();
    expect(wisp!.getAttribute('width')).toBe('10');
    expect(wisp!.getAttribute('height')).toBe('16');
    // El color sale de un token de rol, nunca de un literal.
    expect(wisp!.getAttribute('style')).toContain('var(--role-strategist)');
    expect(wisp!.querySelector('path')!.getAttribute('stroke')).toBe('currentColor');

    // UNA sola marca para el mismo hecho.
    expect(container.querySelector('.coord-dot-live')).toBeNull();
    expect(container.querySelector('.coord-dot')).toBeNull();
    expect(container.querySelector('.team-tab-dot')).toBeNull();
    // Y el estado se dice también con texto, no sólo con la forma.
    expect(container.querySelector('.visually-hidden')!.textContent).toContain('Trabajando');
  });

  it('el rol ocioso cae en el punto quieto y el hilo se va', () => {
    mocks.state = { ...baseState, status: 'idle', closed: false };
    const { container } = renderTab();
    expect(container.querySelector('.team-steam')).toBeNull();
    expect(container.querySelector('.coord-av .coord-dot-idle')).not.toBeNull();
    expect(container.querySelector('.coord-dot-live')).toBeNull();
  });

  /** Un permiso pendiente TE espera: eso es acento, por el criterio 2. */
  it('el rol que necesita algo tuyo conserva el punto vivo con halo, sin hilo', () => {
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

  /** Sin chat no hay proceso: nada de vapor decorativo. */
  it('una pestaña sin conversación no lleva hilo', () => {
    mocks.state = { ...baseState, status: 'working', closed: false };
    const { container } = render(
      <MemberTab member={member as never} chat={null} selected={false} busy={false} mode="simple" onSelect={() => {}} />,
    );
    expect(container.querySelector('.team-steam')).toBeNull();
  });
});
