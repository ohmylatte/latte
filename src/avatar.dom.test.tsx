import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, AvatarSprite } from './coordination/Avatar';
import { ROLE_PALETTE, roleColor, roleTone } from './coordination/role-color';
import { avatarFromSeed, parseAvatar } from '../shared/avatar';

/**
 * D2: EL COMPONENTE.
 *
 * Un avatar es tres promesas: que dibuje LAS CAPAS que dicen sus parámetros,
 * que el COLOR salga del rol y no de la cara, y que sin parámetros no
 * desaparezca —caiga a la inicial— porque hay roles y miembros anteriores a
 * todo esto.
 */

const face = (params: Parameters<typeof Avatar>[0]['params'], props: Partial<Parameters<typeof Avatar>[0]> = {}) =>
  render(<><AvatarSprite /><Avatar name="Estratega" params={params} {...props} /></>);

const layers = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.av-face use')).map((use) => use.getAttribute('href') ?? '');

describe('Avatar: las capas', () => {
  it('dibuja fondo, hombros, cabeza, pelo, ojos, boca y accesorio, en ese orden', () => {
    const { container } = face(parseAvatar('bun.2.1.glasses'));
    expect(layers(container)).toEqual(['#av-bg', '#av-body', '#av-head', '#av-hair-bun', '#av-eyes', '#av-mouth', '#av-glasses']);
  });

  it('sin accesorio son seis capas, no siete con una vacía', () => {
    const { container } = face(parseAvatar('curly.1.3.none'));
    expect(layers(container)).toEqual(['#av-bg', '#av-body', '#av-head', '#av-hair-curly', '#av-eyes', '#av-mouth']);
  });

  it('el gorro ocupa el lugar del pelo: es un peinado más, no una capa extra', () => {
    const { container } = face(parseAvatar('beanie.3.1.none'));
    expect(layers(container)).toContain('#av-hair-beanie');
    expect(layers(container).filter((id) => id.startsWith('#av-hair-'))).toHaveLength(1);
  });

  it('la piel y el pelo salen de los tokens que dijeron los parámetros', () => {
    const { container } = face(parseAvatar('short.4.2.none'));
    const use = (id: string) => container.querySelector(`.av-face use[href="${id}"]`)!;
    expect(use('#av-head').getAttribute('fill')).toBe('var(--av-skin-4)');
    expect(use('#av-hair-short').getAttribute('fill')).toBe('var(--av-hair-2)');
  });

  it('los auriculares rellenan y trazan; el aro va en --rust, no en tinta', () => {
    const { container: phones } = face(parseAvatar('bob.2.4.phones'));
    const p = phones.querySelector('use[href="#av-phones"]')!;
    expect(p.getAttribute('fill')).toBe('var(--ink)');
    expect(p.getAttribute('stroke')).toBe('var(--ink)');

    const { container: earring } = face(parseAvatar('long.2.2.earring'));
    const e = earring.querySelector('use[href="#av-earring"]')!;
    expect(e.getAttribute('fill')).toBe('var(--rust)');
    // Un trazo sobre un circulito de r=1.6 lo convertiría en una mancha.
    expect(e.getAttribute('stroke')).toBeNull();
  });

  it('cada símbolo que una capa referencia existe en el sprite', () => {
    const { container } = render(<AvatarSprite />);
    const ids = new Set(Array.from(container.querySelectorAll('symbol')).map((s) => s.id));
    for (const id of ids) expect(id.startsWith('av-'), id).toBe(true);
    for (let i = 0; i < 120; i += 1) {
      const params = avatarFromSeed(`capa-${i}`);
      const { container: one } = face(params);
      for (const href of layers(one)) expect(ids.has(href.slice(1)), href).toBe(true);
    }
  });
});

describe('Avatar: el color es el rol', () => {
  it('pone el color y el wash del rol como variables propias', () => {
    const { container } = face(parseAvatar('bun.2.1.glasses'), { roleId: 'strategist' });
    const root = container.querySelector('.av') as HTMLElement;
    expect(root.style.getPropertyValue('--av-color')).toBe('var(--role-strategist)');
    expect(root.style.getPropertyValue('--av-wash')).toBe('var(--role-strategist-wash)');
    expect(root.getAttribute('data-role')).toBe('strategist');
  });

  it('el fondo lleva el wash y los hombros el color pleno: el color nunca sale de la cara', () => {
    const { container } = face(parseAvatar('bob.2.4.phones'), { roleId: 'reviewer' });
    expect(container.querySelector('use[href="#av-bg"]')!.getAttribute('fill')).toBe('var(--av-wash)');
    expect(container.querySelector('use[href="#av-body"]')!.getAttribute('fill')).toBe('var(--av-color)');
  });

  it('dos miembros con la misma cara y distinto rol se distinguen por el color', () => {
    const same = parseAvatar('short.2.2.none');
    const a = face(same, { roleId: 'analyst' }).container.querySelector('.av') as HTMLElement;
    const b = face(same, { roleId: 'researcher' }).container.querySelector('.av') as HTMLElement;
    expect(a.style.getPropertyValue('--av-color')).not.toBe(b.style.getPropertyValue('--av-color'));
  });
});

describe('Avatar: la reserva y el estado', () => {
  it('sin params cae a la inicial del nombre, con el color del rol', () => {
    const { container } = face(null, { roleId: 'analyst', name: 'Community Manager' });
    expect(container.querySelector('.av-face')).toBeNull();
    expect(container.querySelector('.av-initial')!.textContent).toBe('CM');
    expect((container.querySelector('.av') as HTMLElement).style.getPropertyValue('--av-color')).toBe('var(--role-analyst)');
  });

  it('se anuncia como imagen con el nombre visible, y el SVG no vuelve a decirlo', () => {
    const { container } = face(parseAvatar('curly.1.3.none'), { name: 'Paid Media' });
    const root = container.querySelector('.av')!;
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('Paid Media');
    expect(container.querySelector('.av-face')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('el punto de estado es un elemento aparte, nunca una capa del SVG', () => {
    const { container } = face(parseAvatar('bob.2.4.phones'), { status: 'live' });
    const dot = container.querySelector('.av-dot')!;
    expect(dot.tagName.toLowerCase()).toBe('i');
    expect(dot.closest('svg')).toBeNull();
    expect(dot.className).toContain('av-dot-live');
    // Y sin `status` no hay punto: un avatar de una tarea no tiene estado propio.
    expect(face(parseAvatar('bob.2.4.phones')).container.querySelector('.av-dot')).toBeNull();
  });

  it('los tamaños son 22 · 32 · 40, por clase', () => {
    for (const [size, px] of [['sm', 22], ['md', 32], ['lg', 40]] as const) {
      const { container } = face(null, { size });
      expect(container.querySelector('.av')!.className).toContain(`av-${size}`);
      expect(readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')).toContain(`.av-${size}{width:${px}px`);
    }
  });
});

describe('roleColor: ningún rol se queda sin identidad', () => {
  it('los cinco de siempre conservan su token', () => {
    for (const id of ['assistant', 'strategist', 'researcher', 'analyst', 'reviewer']) {
      expect(roleColor(id).color).toBe(`var(--role-${id})`);
    }
  });

  it('los roles que caían en --role-default ahora tienen el suyo', () => {
    for (const id of ['paid-media', 'community-manager', 'sales-copywriter']) {
      expect(roleColor(id).color).not.toBe('var(--role-default)');
      expect(ROLE_PALETTE).toContain(roleTone(id));
    }
  });

  it('es determinista y usa toda la paleta', () => {
    expect(roleTone('mi-rol-propio')).toBe(roleTone('mi-rol-propio'));
    const tones = new Set(Array.from({ length: 200 }, (_, i) => roleTone(`rol-propio-${i}`)));
    expect(tones.size).toBe(ROLE_PALETTE.length);
  });

  it('sin rol, el default; y trae siempre un wash que hace juego', () => {
    expect(roleColor(null)).toEqual({ color: 'var(--role-default)', wash: 'var(--role-default-wash)' });
    // El wash siempre es el del MISMO tono que el color: nunca una mezcla.
    for (const id of ['assistant', 'paid-media', 'community-manager', 'mi-rol', 'otro-rol']) {
      const tone = roleTone(id);
      expect(roleColor(id)).toEqual({ color: `var(--role-${tone})`, wash: `var(--role-${tone}-wash)` });
    }
  });
});

/**
 * Los tokens tienen que EXISTIR en la hoja, y el color pleno lleva la inicial
 * de reserva encima: texto de 12px, o sea 4.5:1 contra `--on-accent`. Esta es
 * la extensión del candado de contraste de C8 a la paleta completa.
 */
describe('D2: la hoja', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
  const token = (name: string) => {
    const match = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(css);
    expect(match, 'falta el token --' + name).not.toBeNull();
    return match![1]!;
  };
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('los ocho tonos de la paleta y sus washes existen', () => {
    for (const tone of ROLE_PALETTE) { token(`role-${tone}`); token(`role-${tone}-wash`); }
    token('role-default'); token('role-default-wash');
  });

  it('los cuatro tonos de piel y los cuatro de pelo existen y son distintos', () => {
    const skins = [1, 2, 3, 4].map((n) => token(`av-skin-${n}`));
    const hairs = [1, 2, 3, 4].map((n) => token(`av-hair-${n}`));
    expect(new Set(skins).size).toBe(4);
    expect(new Set(hairs).size).toBe(4);
  });

  it('cada color de la paleta llega a 4.5:1 contra --on-accent', () => {
    const ink = token('on-accent');
    const failures = [...ROLE_PALETTE, 'default']
      .map((tone) => ({ tone, ratio: contrast(token(`role-${tone}`), ink) }))
      .filter((row) => row.ratio < 4.5)
      .map((row) => `${row.tone}: ${row.ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  it('las reglas de `.av-` sólo hablan en tokens: ningún hex suelto fuera de :root', () => {
    const offenders = css.split(/\r?\n/).filter((line) => {
      const brace = line.indexOf('{');
      if (brace < 0) return false;
      if (!/^\s*\.av[\w-]*(\s|,|\.|:|\{)/.test(line.slice(0, brace + 1))) return false;
      return /#[0-9a-fA-F]{3,8}\b/.test(line) || line.includes('--text-xs');
    });
    expect(offenders).toEqual([]);
  });
});
