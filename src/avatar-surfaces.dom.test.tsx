import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CoordAvatar, CoordRow } from './coordination/anatomy';
import { AvatarSprite } from './coordination/Avatar';
import { avatarOfMember, avatarOfRole } from './coordination/avatar-of';
import { avatarFromSeed, parseAvatar, serializeAvatar } from '../shared/avatar';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TeamPanel } from './TeamPanel';
import { EMPTY_USAGE, type AgentRole, type TeamMember } from '../shared/contracts';

/**
 * D5: DONDE HABÍA UNA INICIAL, VA EL AVATAR.
 *
 * El candado de este ítem es uno solo y es simple de decir: si un miembro
 * tiene avatar, ninguna superficie del equipo puede dibujar dos letras en su
 * lugar. Una inicial suelta no es un estilo distinto, es la señal de que
 * alguien se salteó el sistema.
 *
 * La anatomía de C2 no se movió: el punto de estado sigue siendo `coord-dot`,
 * con sus clases y su significado, y sigue estando AFUERA del SVG.
 */

const member = (patch: Partial<TeamMember> = {}): TeamMember => ({
  id: 'mem_1', workId: 'w1', roleId: 'reviewer', roleName: 'Reviewer', initial: 'V',
  avatar: 'long.2.2.earring', runtime: 'claude', model: null, accountId: null, label: 'Claude',
  status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});

const role = (patch: Partial<AgentRole> = {}): AgentRole => ({
  id: 'strategist', name: 'Strategist', initial: 'S', summary: '', builtin: false, tier: 'deep',
  avatar: 'bun.2.1.glasses-thick', ...patch,
});

const mount = (node: React.ReactNode) => render(<><AvatarSprite />{node}</>);

describe('CoordAvatar delega en el avatar sin mover la anatomia', () => {
  it('con cara, dibuja la cara y ni una letra', () => {
    const { container } = mount(<CoordAvatar name="Reviewer" avatar={avatarOfMember(member())} roleId="reviewer" />);
    const av = container.querySelector('.coord-av')!;
    expect(av.querySelector('.av-face')).not.toBeNull();
    expect(av.querySelector('.av-initial')).toBeNull();
    expect(av.textContent).toBe('');
    expect(av.getAttribute('aria-label')).toBe('Reviewer');
    expect(av.getAttribute('data-role')).toBe('reviewer');
  });

  it('el punto sigue siendo coord-dot, sigue siendo uno, y sigue fuera del SVG', () => {
    const { container } = mount(<CoordAvatar name="Reviewer" avatar={avatarOfMember(member())} roleId="reviewer" dot="live" />);
    const dots = container.querySelectorAll('.coord-dot');
    expect(dots).toHaveLength(1);
    expect(dots[0]!.className).toContain('coord-dot-live');
    expect(dots[0]!.closest('svg')).toBeNull();
    // Y sin estado no hay punto: el avatar de una tarea no tiene estado propio.
    expect(mount(<CoordAvatar name="x" avatar={avatarOfMember(member())} />).container.querySelector('.coord-dot')).toBeNull();
  });

  it('los tamanos de la anatomia se conservan: 22 el chico, 32 el normal', () => {
    const small = mount(<CoordAvatar name="x" small avatar={avatarOfMember(member())} />).container.querySelector('.coord-av')!;
    const normal = mount(<CoordAvatar name="x" avatar={avatarOfMember(member())} />).container.querySelector('.coord-av')!;
    expect(small.className).toContain('coord-av-s');
    expect(small.className).toContain('av-sm');
    expect(normal.className).toContain('av-md');
  });

  it('el icono de "sumar un rol" sigue reemplazando la cara entera', () => {
    const { container } = mount(<CoordAvatar name=""><span data-testid="icono" /></CoordAvatar>);
    expect(container.querySelector('[data-testid="icono"]')).not.toBeNull();
    expect(container.querySelector('.av-face')).toBeNull();
    expect(container.querySelector('.av-initial')).toBeNull();
  });

  it('sin cara —un fixture viejo, un miembro sin nada— cae a la inicial y no desaparece', () => {
    const { container } = mount(<CoordAvatar name="Community Manager" roleId="community-manager" />);
    expect(container.querySelector('.av-initial')!.textContent).toBe('CM');
  });

  it('la fila entera pasa la cara al avatar', () => {
    const { container } = mount(<CoordRow name="Reviewer" roleId="reviewer" avatar={avatarOfMember(member())} line="Revisando" />);
    expect(container.querySelector('.coord-av .av-face')).not.toBeNull();
    expect(container.querySelector('.coord-av')!.textContent).toBe('');
  });
});

/**
 * EL CANDADO. Si el miembro tiene avatar, ninguna superficie puede poner una
 * inicial en su lugar.
 */
describe('ninguna superficie dibuja una inicial cuando hay cara', () => {
  const surfaces: Array<[string, React.ReactNode]> = [
    ['fila', <CoordRow name="Reviewer" roleId="reviewer" avatar={avatarOfMember(member())} line="x" dot="live" />],
    ['avatar suelto', <CoordAvatar name="Reviewer" roleId="reviewer" avatar={avatarOfMember(member())} />],
    ['mini de tarea', <CoordAvatar name="Reviewer" small roleId="reviewer" avatar={avatarOfRole('reviewer', [role({ id: 'reviewer', avatar: 'long.2.2.earring' })], [])} />],
  ];

  for (const [label, node] of surfaces) {
    it(`${label}: cara si, inicial no`, () => {
      const { container } = mount(node);
      expect(container.querySelector('.av-face'), label).not.toBeNull();
      expect(container.querySelector('.av-initial'), label).toBeNull();
      // El texto visible del avatar es vacio: el nombre viaja por aria-label.
      expect(container.querySelector('.av')!.textContent, label).toBe('');
    });
  }
});

describe('de donde sale la cara de cada superficie', () => {
  it('una persona lleva la suya; dos del mismo rol no se confunden', () => {
    const first = member({ id: 'a', avatar: 'long.2.2.earring' });
    const second = member({ id: 'b', avatar: serializeAvatar(avatarFromSeed('b')) });
    expect(avatarOfMember(first)).toEqual(parseAvatar('long.2.2.earring'));
    expect(avatarOfMember(second)).not.toEqual(avatarOfMember(first));
  });

  it('un miembro sin avatar guardado no se queda sin cara: la deriva de su rol', () => {
    expect(avatarOfMember(member({ avatar: null }))).toEqual(avatarFromSeed('reviewer'));
  });

  it('un puesto toma la cara de quien lo ocupa, y si no hay nadie la que el rol declara', () => {
    const team = [member({ roleId: 'strategist', avatar: 'bob.2.4.phones' })];
    expect(avatarOfRole('strategist', [role()], team)).toEqual(parseAvatar('bob.2.4.phones'));
    expect(avatarOfRole('strategist', [role()], [])).toEqual(parseAvatar('bun.2.1.glasses-thick'));
    // Un rol que ya no esta en el catalogo tampoco deja la fila vacia.
    expect(avatarOfRole('fantasma', [], [])).toEqual(avatarFromSeed('fantasma'));
    // Y sin rol no hay cara que inventar.
    expect(avatarOfRole(null)).toBeNull();
  });
});

/**
 * D7: EL FALLBACK NO SE ESTIRA.
 *
 * En el picker de "Sumar miembro" el avatar sin cara salia como una PILDORA
 * ancha con la inicial adentro. La causa no estaba en el componente sino en el
 * vecino: `.role-card>span:not(.team-avatar)` le daba `flex:1` —o sea
 * `flex:1 1 0%`— y le ganaba en especificidad (0,2,1) a `.av-lg` (0,1,0), asi
 * que la base de 40px se perdia y el hijo flex crecia a lo ancho.
 *
 * Y se veia JUSTO en el peor momento: un rol llega sin `avatar` mientras el
 * lado Electron no se reinicio, que es cuando menos se quiere ver algo roto.
 *
 * jsdom no aplica la hoja ni calcula cascada, asi que este es un caso donde el
 * test de DOM solo NO alcanza: se fija lo que el componente promete (un `.av`
 * con su clase de tamano, nunca un `<span>` suelto) y aparte se fija la HOJA,
 * que es donde estaba el error de verdad.
 */
describe('D7: el avatar es un circulo de tamano fijo, con cara o sin ella', () => {
  const roles: AgentRole[] = [
    { id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Decide', builtin: false, tier: 'deep', avatar: null },
    { id: 'assistant', name: 'Asistente', initial: 'A', summary: 'Arranca', builtin: true, tier: 'balanced', avatar: null },
  ];

  const panel = (rolesIn: AgentRole[]) => render(<TeamPanel
    work={{ id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' }}
    team={[]} chats={{}} selectedId={null} roles={rolesIn}
    primaryLabel="OpenCode" primaryDetail="Listo" primaryReady checking={false}
    primaryRuntime="opencode" primaryAccountId={null} primaryModel={null}
    choices={[]} busy={false} isDesktop={false}
    onSelect={() => {}} onAdd={async () => {}} onOpen={async () => {}} onPause={async () => {}}
    onFinish={async () => {}} onRestart={async () => {}} onContinue={async () => {}}
    handoffs={[]} onAcceptHandoff={async () => {}} onDismissHandoff={async () => {}}
    onRemove={async () => {}} onProviders={() => {}} onRecheck={() => {}} onModel={() => {}} onTier={() => {}}
    onError={() => {}} onAttachFiles={async () => []} untracked={[]} onAdoptFile={() => {}}
    permissions="ask" permissionBusy={false} onPermissions={() => {}}
    mode="simple"
  />);

  it('un rol SIN avatar sigue siendo un circulo con su clase de tamano, no un span suelto', () => {
    const { container } = panel(roles);
    const cards = Array.from(container.querySelectorAll('.role-card'));
    expect(cards.length).toBe(2);
    for (const card of cards) {
      const av = card.querySelector('.av')!;
      expect(av, card.textContent ?? '').not.toBeNull();
      expect(av.className).toContain('av-lg');
      // Sin cara, la inicial; pero dentro del circulo, no en lugar de el.
      expect(av.querySelector('.av-initial')).not.toBeNull();
      expect(av.querySelector('.av-face')).toBeNull();
      // Y el hijo que SI tiene derecho a estirarse es el del texto, no este.
      expect(av.getAttribute('role')).toBe('img');
    }
  });

  it('con avatar, el mismo circulo del mismo tamano: el fallback no es otra caja', () => {
    const { container } = panel(roles.map((r) => ({ ...r, avatar: 'bun.2.1.glasses-thick' })));
    for (const card of Array.from(container.querySelectorAll('.role-card'))) {
      const av = card.querySelector('.av')!;
      expect(av.className).toContain('av-lg');
      expect(av.querySelector('.av-face')).not.toBeNull();
      expect(av.querySelector('.av-initial')).toBeNull();
    }
  });

  it('la hoja: nada puede estirar un avatar', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const lines = css.split(/\r?\n/);
    const ruleFor = (selector: string) => lines.find((line) => line.startsWith(selector + '{')) ?? '';

    // Cada tamano declara el `flex` COMPLETO, no solo la base: `flex-basis`
    // solo se lo lleva puesto cualquier `flex:1` de un contenedor.
    for (const [size, px] of [['sm', 22], ['md', 32], ['lg', 40]] as const) {
      expect(ruleFor(`.av-${size}`), size).toContain(`flex:0 0 ${px}px`);
      expect(ruleFor(`.av-${size}`), size).toContain(`width:${px}px`);
      expect(ruleFor(`.av-${size}`), size).toContain(`height:${px}px`);
    }
    expect(ruleFor('.team-resume-av')).toContain('flex:0 0 54px');
    // El avatar grande de "la conversacion esta en pausa" mide 54, no 40:
    // misma especificidad que `.av-lg`, asi que gana por venir DESPUES. Si
    // alguien mueve el bloque, el avatar encoge sin que nadie lo note.
    expect(lines.findIndex((l) => l.startsWith('.team-resume-av{'))).toBeGreaterThan(lines.findIndex((l) => l.startsWith('.av-lg{')));
    // Y la pestana del miembro usa el chico, que es el de una tira compacta.
    expect(ruleFor('.team-tab .av')).toContain('flex:0 0 22px');
    // La base: cuadrado siempre, aunque alguien lo meta en una caja rara.
    expect(ruleFor('.av')).toContain('aspect-ratio:1');
    expect(ruleFor('.av')).toContain('flex:0 0 auto');

    // Y la regla culpable ya no alcanza a `.av`.
    const offenders = lines.filter((line) => {
      const brace = line.indexOf('{');
      if (brace < 0) return false;
      const selector = line.slice(0, brace);
      if (!/\.role-card\s*>\s*span/.test(selector)) return false;
      return !selector.includes(':not(.av)') && /flex:\s*1/.test(line);
    });
    expect(offenders).toEqual([]);
  });
});
