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
const overrides: Array<{ roleId: string; avatar: string | null }> = [];

vi.mock('./browser-api', async () => {
  const profiles = [
    { id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Decide.', soul: 'SOUL', skills: '', avatar: 'bun.2.1.glasses-thick', tier: 'deep', builtin: false, source: 'builtin', directory: null, fingerprint: 'fp-strategist' },
    { id: 'growth', name: 'Growth', initial: 'G', summary: 'Crece.', soul: 'SOUL', skills: '', avatar: 'bob.2.4.phones', tier: 'balanced', builtin: false, source: 'custom', directory: '/p/growth', fingerprint: 'fp-growth' },
  ];
  return {
    isDesktop: true,
    api: {
      listProfiles: async () => profiles,
      saveProfile: async (input: { id: string; avatar?: string | null }, fingerprint: string | null) => {
        saved.push({ input, fingerprint });
        return { ...profiles[1], ...input, avatar: input.avatar ?? null };
      },
      setRoleAvatar: async (roleId: string, avatar: string | null) => {
        overrides.push({ roleId, avatar });
        const role = profiles.find((r) => r.id === roleId);
        if (role && avatar) role.avatar = avatar;
        return [];
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
  /**
   * D9 (2): EL PICKER ESTA DESDE QUE SE ABRE EL FORMULARIO.
   *
   * Colgaba del id, y el id de un perfil nuevo arranca vacio: se abria
   * "Nuevo perfil" y no habia NADA para elegir hasta escribir algo. La
   * semilla ahora es del formulario, no del id.
   */
  it('un perfil nuevo trae ocho caras antes de escribir el id', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    const options = faces(container);
    expect(options).toHaveLength(8);
    expect(new Set(options).size).toBe(8);
    expect(container.querySelectorAll('.av-pick.is-chosen')).toHaveLength(1);
  });

  it('escribir el id despues NO le cambia la cara que ya eligio', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByText('Nuevo perfil'));
    fireEvent.click(container.querySelectorAll('.av-pick')[4]!);
    const chosen = container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value');

    fireEvent.change(container.querySelector('#profile-id')!, { target: { value: 'paid-media-lead' } });
    expect(container.querySelector('.av-pick.is-chosen')!.getAttribute('data-avatar-value')).toBe(chosen);
  });

  it('cada formulario nuevo tira su propia semilla', async () => {
    const { container } = mount();
    // El de la cabecera: con el formulario abierto, el titulo repite el texto.
    const nuevo = () => fireEvent.click(container.querySelector('.profiles-heading button')!);
    nuevo();
    const first = faces(container);
    nuevo();
    expect(faces(container)).not.toEqual(first);
  });

  it('al editar un rol que ya existe, su cara actual es la primera y esta elegida', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByText('Growth'));
    await waitFor(() => expect(faces(container).length).toBe(8));
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
    await waitFor(() => expect(faces(container).length).toBe(8));
    fireEvent.change(container.querySelector('#profile-summary')!, { target: { value: 'Otra cosa.' } });
    fireEvent.click(screen.getByText('Guardar perfil'));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.input.avatar).toBe('bob.2.4.phones');
  });
});

/**
 * D9 (1): EN UN ROL INCLUIDO TAMBIEN SE ELIGE LA CARA.
 *
 * El formulario de un rol del pack es de solo lectura, y estaba bien que lo
 * fuera: su comportamiento es un archivo del programa. Pero la cara no es
 * comportamiento, es IDENTIDAD, y esa la elige quien usa Latte. El picker
 * aparecia con las ocho caras apagadas: se veia la oferta y no se podia tocar.
 *
 * Va por su propio canal —un override de instalacion que gana sobre el pack y
 * sobrevive a una actualizacion— y se guarda al instante: no hay un borrador
 * que confirmar, hay una eleccion.
 */
describe('la cara de un rol incluido se elige, y se guarda sola', () => {
  it('el picker queda habilitado aunque el resto del formulario no', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByText('Strategist'));
    await waitFor(() => expect(faces(container).length).toBe(8));

    const picker = container.querySelector('.av-picker') as HTMLFieldSetElement;
    expect(picker.disabled).toBe(false);
    for (const button of Array.from(container.querySelectorAll('.av-pick'))) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
    // Y el resto sigue de solo lectura: la cara es lo unico que se toca.
    expect((container.querySelector('#profile-name') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('#profile-soul') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('su cara actual es la primera, y es la que trae el pack', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByText('Strategist'));
    await waitFor(() => expect(faces(container).length).toBe(8));
    expect(faces(container)[0]).toBe('bun.2.1.glasses-thick');
  });

  it('elegir una llama a setRoleAvatar y no al guardado del perfil', async () => {
    overrides.length = 0;
    saved.length = 0;
    const { container } = mount();
    fireEvent.click(await screen.findByText('Strategist'));
    await waitFor(() => expect(faces(container).length).toBe(8));

    const wanted = faces(container)[3]!;
    fireEvent.click(container.querySelectorAll('.av-pick')[3]!);
    await waitFor(() => expect(overrides).toHaveLength(1));
    expect(overrides[0]).toEqual({ roleId: 'strategist', avatar: wanted });
    // Un rol incluido no se guarda como perfil: eso tiraria "solo lectura".
    expect(saved).toHaveLength(0);
    // Y no hay boton que apretar: el guardado ya paso.
    expect(container.querySelector('.av-picker button[type="submit"]')).toBeNull();
  });
});
