import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { avatarFromSeed, serializeAvatar } from '../shared/avatar';

/**
 * D4: ELEGIR LA CARA AL CREAR O EDITAR UN ROL.
 *
 * Lo que se prueba es la promesa, no el dibujo: que se autogenere sin pedir
 * nada, que la elegida esté marcada, que "otras ocho" traiga otras ocho sin
 * sacarte la tuya, y —lo único que de verdad importa— que lo elegido LLEGUE
 * al guardado. Un picker lindo que manda otra cosa es peor que no tenerlo.
 */

const saved: Array<{ input: { id: string; avatar?: string | null }; fingerprint: string | null }> = [];

vi.mock('./browser-api', async () => {
  const profiles = [
    { id: 'growth', name: 'Growth', initial: 'G', summary: 'Crece.', soul: 'SOUL', skills: '', avatar: 'bob.2.4.phones', tier: 'balanced', builtin: false, source: 'custom', directory: '/p/growth', fingerprint: 'fp-growth' },
  ];
  return {
    isDesktop: true,
    api: {
      listProfiles: async () => profiles,
      saveProfile: async (input: { id: string; avatar?: string | null }, fingerprint: string | null) => {
        saved.push({ input, fingerprint });
        return { ...profiles[0], ...input, avatar: input.avatar ?? null };
      },
    },
  };
});

const { ProfilesView } = await import('./ProfilesView');

const mount = () => render(
  <ProfilesView onChanged={() => {}} onError={() => {}} onNotice={() => {}} onDirtyChange={() => {}} />,
);

const faces = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.av-pick')).map((node) => node.getAttribute('data-avatar-value')!);

describe('el picker aparece solo, con la cara que al rol ya le toca', () => {
  it('sin id no hay nada que elegir; apenas hay id, se autogenera', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    expect(container.querySelector('.av-picker')).toBeNull();

    fireEvent.change(container.querySelector('#profile-id')!, { target: { value: 'paid-media-lead' } });
    const options = faces(container);
    expect(options).toHaveLength(8);
    expect(new Set(options).size).toBe(8);
    // La primera es la que el id se gana: nadie tiene que elegir para tener cara.
    expect(options[0]).toBe(serializeAvatar(avatarFromSeed('paid-media-lead')));
    expect(container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value')).toBe(options[0]);
    expect(container.querySelectorAll('.av-pick.is-chosen')).toHaveLength(1);
  });

  it('al editar un rol que ya existe, su cara actual es la primera y esta elegida', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByText('Growth'));
    await waitFor(() => expect(container.querySelector('.av-picker')).not.toBeNull());
    expect(faces(container)[0]).toBe('bob.2.4.phones');
    expect(container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value')).toBe('bob.2.4.phones');
  });

  it('la elegida se anuncia como tal, no solo con un borde', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    fireEvent.change(container.querySelector('#profile-id')!, { target: { value: 'community' } });
    const chosen = container.querySelector('.av-pick.is-chosen')!;
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
    // Cada cara se anuncia con su lugar en la grilla, no con su serializacion.
    expect(chosen.getAttribute('aria-label')).toMatch(/1/);
  });
});

describe('"Otras ocho" cambia las ocho, pero no te saca la tuya', () => {
  it('trae otra tanda y conserva la elegida en el primer lugar', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    fireEvent.change(container.querySelector('#profile-id')!, { target: { value: 'community' } });
    const before = faces(container);

    fireEvent.click(screen.getByText('Otras ocho'));
    const after = faces(container);
    expect(after).toHaveLength(8);
    expect(new Set(after).size).toBe(8);
    // La elegida sigue estando, y sigue elegida.
    expect(after[0]).toBe(before[0]);
    expect(container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value')).toBe(before[0]);
    // Y las otras siete son otras: no es el mismo tablero con otro orden.
    expect(after.slice(1)).not.toEqual(before.slice(1));
    expect(after.slice(1).filter((value) => before.includes(value)).length).toBeLessThan(7);
  });
});

describe('lo elegido es lo que se guarda', () => {
  it('elegir una cara y guardar manda ESE avatar al saveProfile', async () => {
    saved.length = 0;
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    fireEvent.change(container.querySelector('#profile-id')!, { target: { value: 'community' } });
    fireEvent.change(container.querySelector('#profile-name')!, { target: { value: 'Community' } });
    fireEvent.change(container.querySelector('#profile-initial')!, { target: { value: 'C' } });
    fireEvent.change(container.querySelector('#profile-summary')!, { target: { value: 'Habla.' } });
    fireEvent.change(container.querySelector('#profile-soul')!, { target: { value: 'SOUL' } });

    const options = faces(container);
    const wanted = options[5]!;
    expect(wanted).not.toBe(options[0]);
    fireEvent.click(container.querySelectorAll('.av-pick')[5]!);
    expect(container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value')).toBe(wanted);

    fireEvent.click(screen.getByText('Guardar perfil'));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.input.avatar).toBe(wanted);
    expect(saved[0]!.input.id).toBe('community');
  });

  it('sin tocar nada, se guarda la que se autogenero: nadie queda sin cara', async () => {
    saved.length = 0;
    const { container } = mount();
    fireEvent.click(await screen.findByText('Growth'));
    await waitFor(() => expect(container.querySelector('.av-picker')).not.toBeNull());
    fireEvent.change(container.querySelector('#profile-summary')!, { target: { value: 'Otra cosa.' } });
    fireEvent.click(screen.getByText('Guardar perfil'));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.input.avatar).toBe('bob.2.4.phones');
  });
});
