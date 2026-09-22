import { describe, expect, it } from 'vitest';
import {
  AVATAR_ACCESSORIES,
  AVATAR_HAIRS,
  avatarFor,
  avatarFromSeed,
  avatarVariants,
  parseAvatar,
  serializeAvatar,
  type AvatarParams,
} from '../../shared/avatar';

/**
 * D1: el generador de avatares, puro y compartido.
 *
 * Lo que se le pide no es que dibuje lindo —eso lo juzga el ojo— sino que sea
 * DETERMINISTA (la misma semilla, la misma cara, en el main y en el renderer),
 * REVERSIBLE (lo que se guarda se vuelve a leer igual) y TOLERANTE (un
 * frontmatter escrito a mano no puede tirar la app abajo).
 */
describe('avatarFromSeed', () => {
  it('da siempre la misma cara para la misma semilla', () => {
    for (const seed of ['strategist', 'mem_abc123', '', 'ñandú 🐦', 'a'.repeat(300)]) {
      expect(avatarFromSeed(seed)).toEqual(avatarFromSeed(seed));
    }
  });

  it('devuelve parámetros dentro del vocabulario declarado', () => {
    for (let i = 0; i < 200; i += 1) {
      const params = avatarFromSeed(`seed-${i}`);
      expect(AVATAR_HAIRS).toContain(params.hair);
      expect(AVATAR_ACCESSORIES).toContain(params.accessory);
      expect([1, 2, 3, 4]).toContain(params.skin);
      expect([1, 2, 3, 4]).toContain(params.hairColor);
    }
  });

  it('semillas distintas dan caras distintas la mayoría de las veces', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(serializeAvatar(avatarFromSeed(`rol-${i}`)));
    // 384 combinaciones y 100 semillas: por el cumpleaños se esperan unas 88
    // distintas. Menos de 70 querría decir que el hash está colapsando.
    expect(seen.size).toBeGreaterThan(70);
  });

  it('reparte razonablemente: sobre 1000 semillas ningún peinado pasa del 30%', () => {
    const hairs = new Map<string, number>();
    const skins = new Map<number, number>();
    for (let i = 0; i < 1000; i += 1) {
      const params = avatarFromSeed(`member-${i}-${i * 7}`);
      hairs.set(params.hair, (hairs.get(params.hair) ?? 0) + 1);
      skins.set(params.skin, (skins.get(params.skin) ?? 0) + 1);
    }
    expect(hairs.size).toBe(AVATAR_HAIRS.length);
    for (const count of hairs.values()) expect(count).toBeLessThanOrEqual(300);
    // Ningún tono de piel puede quedar ausente ni acaparar: el sistema
    // representa a cuatro, no a uno con tres de adorno.
    expect(skins.size).toBe(4);
    for (const count of skins.values()) expect(count).toBeGreaterThan(100);
  });
});

describe('avatarVariants', () => {
  it('da ocho caras distintas entre sí, y siempre las mismas', () => {
    const variants = avatarVariants('growth-strategist');
    expect(variants).toHaveLength(8);
    expect(new Set(variants.map(serializeAvatar)).size).toBe(8);
    expect(variants).toEqual(avatarVariants('growth-strategist'));
  });

  it('la primera variante es la que se autogenera para esa semilla', () => {
    expect(avatarVariants('analyst')[0]).toEqual(avatarFromSeed('analyst'));
  });

  it('otra semilla, otras ocho', () => {
    const first = avatarVariants('analyst').map(serializeAvatar);
    const second = avatarVariants('analyst#otra').map(serializeAvatar);
    expect(second).not.toEqual(first);
  });

  it('respeta n y no se cuelga pidiendo más de las que hay', () => {
    expect(avatarVariants('x', 3)).toHaveLength(3);
    expect(avatarVariants('x', 0)).toHaveLength(0);
    const many = avatarVariants('x', 64);
    expect(new Set(many.map(serializeAvatar)).size).toBe(many.length);
  });
});

describe('serializeAvatar / parseAvatar', () => {
  it('va y vuelve sin perder nada', () => {
    for (let i = 0; i < 300; i += 1) {
      const params = avatarFromSeed(`roundtrip-${i}`);
      expect(parseAvatar(serializeAvatar(params))).toEqual(params);
    }
  });

  it('escribe la forma compacta del tablero', () => {
    const params: AvatarParams = { hair: 'bob', skin: 2, hairColor: 4, accessory: 'phones' };
    expect(serializeAvatar(params)).toBe('bob.2.4.phones');
    expect(parseAvatar('bob.2.4.phones')).toEqual(params);
  });

  it('lee las elecciones del tablero para los roles del pack', () => {
    for (const value of ['bun.2.1.glasses', 'curly.1.3.none', 'short.4.1.glasses', 'long.2.2.earring', 'beanie.3.1.none', 'curly.4.1.earring', 'short.2.2.none']) {
      expect(serializeAvatar(parseAvatar(value)!)).toBe(value);
    }
  });

  it('tolera espacios y mayúsculas, porque el frontmatter lo escribe una persona', () => {
    expect(parseAvatar('  BOB.2.4.Phones  ')).toEqual({ hair: 'bob', skin: 2, hairColor: 4, accessory: 'phones' });
  });

  it('cualquier basura es null, nunca una excepción', () => {
    const garbage: unknown[] = [
      null, undefined, 42, {}, [], true,
      '', '   ', 'bob', 'bob.2.4', 'bob.2.4.phones.extra',
      'mohawk.2.4.phones', 'bob.0.4.phones', 'bob.5.4.phones', 'bob.2.9.phones',
      'bob.2.4.sombrero', 'bob.x.4.phones', '....', 'bob..4.phones',
      'bob.2.4.phones\u0000', '<script>.2.4.none',
    ];
    for (const value of garbage) expect(parseAvatar(value)).toBeNull();
  });
});

describe('avatarFor', () => {
  it('prefiere lo guardado cuando es válido', () => {
    expect(avatarFor('bun.2.1.glasses', 'strategist')).toEqual({ hair: 'bun', skin: 2, hairColor: 1, accessory: 'glasses' });
  });

  it('deriva de la semilla cuando no hay nada guardado, o lo guardado no sirve', () => {
    const derived = avatarFromSeed('viejo-rol');
    expect(avatarFor(null, 'viejo-rol')).toEqual(derived);
    expect(avatarFor(undefined, 'viejo-rol')).toEqual(derived);
    expect(avatarFor('', 'viejo-rol')).toEqual(derived);
    expect(avatarFor('basura', 'viejo-rol')).toEqual(derived);
  });
});
