import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, AvatarSprite } from './coordination/Avatar';
import { AVATAR_MOVES, AVATAR_VARIANTS, AvatarDefs, avatarBeat, avatarIdPrefix, avatarPulse } from './coordination/avatar-art';
import { ROLE_PALETTE, roleColor, roleTone } from './coordination/role-color';
import { AVATAR_ACCESSORIES, avatarFromSeed, parseAvatar } from '../shared/avatar';

/**
 * D2: EL COMPONENTE.
 *
 * Un avatar es tres promesas: que dibuje LAS CAPAS que dicen sus parametros,
 * que el COLOR salga del rol y no de la cara, y que sin parametros no
 * desaparezca —caiga a la inicial— porque hay roles y miembros anteriores a
 * todo esto.
 *
 * Lo que este archivo NO fija es la FORMA. Ni un `d=`, ni un `<path>`, ni una
 * coordenada: el estilo de dibujo va a cambiar entero —lo que hay hoy es un
 * placeholder— y un test que fije la forma se rompe el dia que cambie sin que
 * se haya roto nada. Lo que se fija es la ESTRUCTURA: que cada capa este, que
 * sea la que corresponde a esos parametros, y que se pinte con el token que
 * corresponde. Por eso cada `<use>` lleva `data-part`, y los tests miran eso.
 */

const face = (params: Parameters<typeof Avatar>[0]['params'], props: Partial<Parameters<typeof Avatar>[0]> = {}) =>
  render(<><AvatarSprite /><Avatar name="Estratega" params={params} {...props} /></>);

/** Que piezas hay, en orden. Nunca con que formas. */
const parts = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.av-face [data-part]')).map((node) => node.getAttribute('data-part') ?? '');

const layer = (container: HTMLElement, part: string) => container.querySelector(`.av-face [data-part="${part}"]`)!;

/**
 * ESTE jsdom NO TRAE `matchMedia`. Nada en el entorno responde la pregunta
 * "pediste menos movimiento?", asi que los tests la responden ellos: sin
 * stub, el componente no puede preguntar y —por prudencia— no anima; con
 * stub, se exige la respuesta que corresponda. Dejarlo librado al default de
 * jsdom seria probar una sola de las dos ramas sin saberlo.
 */
function stubMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') && reduce,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

describe('Avatar: las piezas', () => {
  it('dibuja fondo, hombros, cabeza, pelo, cejas, ojos, boca y accesorio, en ese orden', () => {
    const { container } = face(parseAvatar('bun.2.1.glasses-thick'));
    expect(parts(container)).toEqual(['bg', 'body', 'head', 'hair', 'brows', 'eyes', 'mouth', 'accessory']);
  });

  it('sin accesorio son siete piezas, no ocho con una vacia', () => {
    const { container } = face(parseAvatar('curly.1.3.none'));
    expect(parts(container)).toEqual(['bg', 'body', 'head', 'hair', 'brows', 'eyes', 'mouth']);
  });

  /**
   * La bufanda y el cordon de la credencial NACEN en los hombros: si se
   * dibujan encima de la cabeza quedan colgando del aire. Van debajo.
   */
  it('lo que nace en los hombros se dibuja debajo de la cabeza', () => {
    for (const value of ['short.2.2.scarf', 'short.2.2.lanyard']) {
      const order = parts(face(parseAvatar(value)).container);
      expect(order.indexOf('accessory'), value).toBeLessThan(order.indexOf('head'));
    }
    // Y los anteojos, que se apoyan en la cara, van encima de todo.
    const over = parts(face(parseAvatar('short.2.2.glasses')).container);
    expect(over.indexOf('accessory')).toBeGreaterThan(over.indexOf('mouth'));
  });

  it('el peinado que dicen los parametros es el que se referencia, y es uno solo', () => {
    for (const [value, hair] of [['bun.2.1.glasses', 'bun'], ['curly.1.3.none', 'curly'], ['beanie.3.1.none', 'beanie'], ['long.2.2.earring', 'long']] as const) {
      const { container } = face(parseAvatar(value));
      // El gorro ocupa el lugar del pelo: es un peinado mas, no una capa extra.
      expect(parts(container).filter((part) => part === 'hair'), value).toHaveLength(1);
      expect(layer(container, 'hair').getAttribute('href'), value).toContain(hair);
    }
  });

  it('la piel y el pelo salen de los tokens que dijeron los parametros', () => {
    const { container } = face(parseAvatar('short.4.2.none'));
    expect(layer(container, 'head').getAttribute('fill')).toBe('var(--av-skin-4)');
    expect(layer(container, 'hair').getAttribute('fill')).toBe('var(--av-hair-2)');
  });

  it('cada accesorio del vocabulario tiene su forma, y ninguno comparte la de otro', () => {
    const drawn = new Map<string, string>();
    for (const accessory of AVATAR_ACCESSORIES) {
      const { container } = face(parseAvatar(`short.2.2.${accessory}`));
      const node = container.querySelector('.av-face [data-part="accessory"]');
      if (accessory === 'none') { expect(node).toBeNull(); continue; }
      expect(node, accessory).not.toBeNull();
      expect(node!.getAttribute('data-accessory'), accessory).toBe(accessory);
      drawn.set(accessory, node!.getAttribute('href')!);
    }
    expect(drawn.size).toBe(AVATAR_ACCESSORIES.length - 1);
    expect(new Set(drawn.values()).size).toBe(drawn.size);
  });

  it('la barba y el bigote se pintan con el color de PELO, no con la tinta', () => {
    for (const accessory of ['beard', 'moustache']) {
      const { container } = face(parseAvatar(`short.2.3.${accessory}`));
      expect(layer(container, 'accessory').getAttribute('fill'), accessory).toBe('var(--av-hair-3)');
    }
    // El aro, en cambio, es una joya: va en --rust.
    expect(layer(face(parseAvatar('long.2.2.earring')).container, 'accessory').getAttribute('fill')).toBe('var(--rust)');
  });

  it('cada forma que una pieza referencia existe en el sprite', () => {
    const { container } = render(<AvatarSprite />);
    const ids = new Set(Array.from(container.querySelectorAll('[id]')).map((node) => node.id));
    expect(ids.size).toBeGreaterThan(0);
    for (let i = 0; i < 150; i += 1) {
      const { container: one } = face(avatarFromSeed(`capa-${i}`));
      for (const use of Array.from(one.querySelectorAll('.av-face use'))) {
        const href = use.getAttribute('href')!;
        expect(ids.has(href.slice(1)), href).toBe(true);
      }
    }
  });
});

/**
 * LA VIDA. Parpadeo y un micro-movimiento, nunca los dos a la vez, nunca en
 * los avatares chicos, y nunca si esta persona pidio que nada se mueva.
 */
describe('Avatar: la cara respira', () => {
  it('los ojos son elipses, que es lo unico que se puede cerrar animando ry', () => {
    const { container } = face(parseAvatar('short.2.2.none'));
    const eyes = Array.from(container.querySelectorAll('.av-eye'));
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      expect(eye.tagName.toLowerCase()).toBe('ellipse');
      expect(eye.getAttribute('ry')).not.toBeNull();
      expect(eye.getAttribute('rx')).not.toBeNull();
    }
    // Las cejas son dos trazos, no una mancha.
    expect(layer(container, 'brows').querySelectorAll('path')).toHaveLength(2);
  });

  it('el ritmo sale de la semilla: entre 4 y 7 segundos, y con su propio desfase', () => {
    const beats = Array.from({ length: 200 }, (_, i) => avatarBeat(`mem_${i}`));
    for (const beat of beats) {
      expect(beat.blink).toBeGreaterThanOrEqual(4);
      expect(beat.blink).toBeLessThanOrEqual(7);
      expect(AVATAR_MOVES).toContain(beat.move);
    }
    // Determinista, y con los tres movimientos representados.
    expect(avatarBeat('mem_1')).toEqual(avatarBeat('mem_1'));
    expect(new Set(beats.map((b) => b.move)).size).toBe(AVATAR_MOVES.length);
    // Un equipo no parpadea al unisono: los desfases se reparten.
    expect(new Set(beats.map((b) => b.delay)).size).toBeGreaterThan(20);
  });

  it('una cara viva lleva UN solo micro-movimiento, y el parpadeo no se le cruza', () => {
    const pulse = avatarPulse(avatarBeat('mem_abc'));
    const moves = AVATAR_MOVES.filter((move) => pulse.className.includes(`av-move-${move}`));
    expect(moves).toHaveLength(1);
    // El movimiento dura el doble del parpadeo y arranca a mitad de su ciclo:
    // por construccion no pueden estar los dos corriendo en el mismo instante.
    const beat = avatarBeat('mem_abc');
    const style = pulse.style as Record<string, string>;
    expect(style['--av-move']).toBe(`${(beat.blink * 2).toFixed(2)}s`);
    expect(style['--av-move-delay']).toBe(`${(beat.delay + beat.blink / 2).toFixed(2)}s`);
  });

  it('a 22px la cara esta quieta: ahi un parpadeo no es vida, es ruido', () => {
    stubMotion(false);
    const { container } = face(parseAvatar('short.2.2.none'), { size: 'sm' });
    expect(container.querySelector('.av-face')!.getAttribute('class') ?? '').not.toContain('av-alive');
    // Y a 32 y 40, con la misma respuesta del navegador, SI respira.
    for (const size of ['md', 'lg'] as const) {
      const { container: bigger } = face(parseAvatar('short.2.2.none'), { size });
      expect(bigger.querySelector('.av-face')!.getAttribute('class') ?? '', size).toContain('av-alive');
    }
  });

  it('con prefers-reduced-motion no hay clase de animacion en ningun tamano', () => {
    stubMotion(true);
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = face(parseAvatar('short.2.2.none'), { size });
      const cls = container.querySelector('.av-face')!.getAttribute('class') ?? '';
      expect(cls, size).not.toContain('av-alive');
      for (const move of AVATAR_MOVES) expect(cls, `${size}/${move}`).not.toContain(`av-move-${move}`);
    }
  });

  it('sin forma de preguntar, no se mueve: la duda se resuelve a favor de la quietud', () => {
    // Un entorno sin `matchMedia` no puede decir si esta persona pidio menos
    // movimiento. Animar igual seria decidir por ella.
    const { container } = face(parseAvatar('short.2.2.none'), { size: 'lg' });
    expect(container.querySelector('.av-face')!.getAttribute('class') ?? '').not.toContain('av-alive');
  });

  it('la hoja apaga toda animacion bajo prefers-reduced-motion', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    const guard = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(guard).toContain('.av-face');
    expect(guard).toContain('animation:none');
    // Y cada clase que el componente promete tiene una regla que la anima.
    for (const move of AVATAR_MOVES) expect(css).toContain(`.av-alive.av-move-${move}`);
    expect(css).toContain('@keyframes av-blink');
  });
});

describe('Avatar: el papel del fondo', () => {
  it('el grano va SOLO en el fondo, nunca en la cara', () => {
    const { container } = face(parseAvatar('short.2.2.none'), { size: 'lg' });
    expect(layer(container, 'bg').getAttribute('filter')).toBe('url(#av-flat-grain)');
    for (const part of ['body', 'head', 'hair', 'eyes', 'mouth']) {
      expect(layer(container, part).getAttribute('filter'), part).toBeNull();
    }
  });

  it('a 22px no hay grano: no se ve y se paga igual', () => {
    const { container } = face(parseAvatar('short.2.2.none'), { size: 'sm' });
    expect(layer(container, 'bg').getAttribute('filter')).toBeNull();
  });

  it('el grano es un filtro del sprite, y es leve de verdad', () => {
    const { container } = render(<AvatarSprite />);
    const filter = container.querySelector('filter#av-flat-grain')!;
    expect(filter).not.toBeNull();
    expect(filter.querySelector('feTurbulence')).not.toBeNull();
    const slope = Number(filter.querySelector('feFuncA')!.getAttribute('slope'));
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeLessThanOrEqual(0.08);
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
