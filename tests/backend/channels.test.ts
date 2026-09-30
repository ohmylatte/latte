import { describe, expect, it } from 'vitest';
import {
  MAX_DNA_CHANNELS,
  normalizeChannel,
  parseChannelList,
  recognizeChannel,
  splitChannelList,
} from '../../shared/channels';

/**
 * OTROS CANALES — lo puro, sin React y sin red.
 *
 * La persona pega links de donde ya publica. Dos decisiones viven acá y en
 * ningún otro lado:
 *
 *  - QUÉ entra: un link http(s) o un `@usuario`, que se interpreta como
 *    Instagram. Un dominio pelado (`instagram.com/tumarca`) entra normalizado
 *    a `https://`, porque es así como la gente lo escribe;
 *  - QUIÉN es: el dominio decide la plataforma. Puro, sin fetch: el ícono y el
 *    nombre de al lado del link salen de esta tabla, no de una llamada.
 */
describe('canales de marca — normalizar', () => {
  it('acepta un link http(s) tal cual', () => {
    expect(normalizeChannel('https://instagram.com/ayulem')).toBe('https://instagram.com/ayulem');
    expect(normalizeChannel('http://linkedin.com/company/ayulem')).toBe('http://linkedin.com/company/ayulem');
  });

  it('un dominio pelado entra como link, que es como la gente lo escribe', () => {
    expect(normalizeChannel('instagram.com/tumarca')).toBe('https://instagram.com/tumarca');
    expect(normalizeChannel('  linkedin.com/company/tumarca  ')).toBe('https://linkedin.com/company/tumarca');
    expect(normalizeChannel('g.page/ayulem')).toBe('https://g.page/ayulem');
  });

  it('un @usuario entra como Instagram', () => {
    expect(normalizeChannel('@ayulem')).toBe('@ayulem');
    expect(normalizeChannel('@ayulem.oficial')).toBe('@ayulem.oficial');
  });

  it('lo que no es ni link ni @usuario no entra', () => {
    expect(normalizeChannel('')).toBeNull();
    expect(normalizeChannel('   ')).toBeNull();
    expect(normalizeChannel('ftp://ayulem.com')).toBeNull();
    expect(normalizeChannel('hola mundo')).toBeNull();
    expect(normalizeChannel('@')).toBeNull();
    expect(normalizeChannel('mailto:hola@ayulem.com')).toBeNull();
  });

  it(`sólo ${MAX_DNA_CHANNELS} canales por build`, () => {
    const text = Array.from({ length: 12 }, (_, i) => `https://ayulem.com/canal-${i}`).join('\n');
    expect(parseChannelList(text)).toHaveLength(MAX_DNA_CHANNELS);
  });
});

describe('canales de marca — el texto pegado', () => {
  it('parte por renglón y por coma, y tira lo vacío', () => {
    expect(parseChannelList('instagram.com/a\nlinkedin.com/company/b')).toEqual([
      'https://instagram.com/a',
      'https://linkedin.com/company/b',
    ]);
    expect(parseChannelList('instagram.com/a, linkedin.com/company/b, , ')).toEqual([
      'https://instagram.com/a',
      'https://linkedin.com/company/b',
    ]);
  });

  it('el mismo canal pegado dos veces cuenta una vez', () => {
    expect(parseChannelList('instagram.com/a\ninstagram.com/a\nhttps://instagram.com/a')).toEqual([
      'https://instagram.com/a',
    ]);
  });

  it('separa lo que entra de lo que no, para mostrarlo en la tarjeta', () => {
    expect(splitChannelList('instagram.com/a\nhola mundo\n@ayulem')).toEqual({
      valid: ['https://instagram.com/a', '@ayulem'],
      invalid: ['hola mundo'],
    });
  });
});

describe('canales de marca — la plataforma, por dominio', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://instagram.com/ayulem', 'Instagram'],
    ['https://www.instagram.com/ayulem/', 'Instagram'],
    ['instagram.com/ayulem', 'Instagram'],
    ['@ayulem', 'Instagram'],
    ['https://linkedin.com/company/ayulem', 'LinkedIn'],
    ['https://lnkd.in/ayulem', 'LinkedIn'],
    ['https://business.google.com/dashboard', 'Google Business Profile'],
    ['https://g.page/ayulem', 'Google Business Profile'],
    ['https://maps.app.goo.gl/xyz', 'Google Business Profile'],
    ['https://www.tiktok.com/@ayulem', 'TikTok'],
    ['https://vm.tiktok.com/xyz', 'TikTok'],
    ['https://youtube.com/@ayulem', 'YouTube'],
    ['https://youtu.be/abc', 'YouTube'],
    ['https://facebook.com/ayulem', 'Facebook'],
    ['https://m.facebook.com/ayulem', 'Facebook'],
    ['https://x.com/ayulem', 'X'],
    ['https://twitter.com/ayulem', 'X'],
    ['https://pinterest.com/ayulem', 'Pinterest'],
    ['https://pin.it/abc', 'Pinterest'],
    ['https://ayulem.com.ar', 'Link'],
    ['una cosa sin formato', 'Link'],
  ];

  for (const [value, label] of cases) {
    it(`${value} → ${label}`, () => {
      expect(recognizeChannel(value).label).toBe(label);
    });
  }

  it('el dominio manda, no el resto de la URL', () => {
    expect(recognizeChannel('https://instagram.com.evil.example/ayulem').label).toBe('Link');
    expect(recognizeChannel('https://evil.example/instagram.com').label).toBe('Link');
  });

  it('cada plataforma tiene id propio y "link" es el genérico', () => {
    expect(recognizeChannel('https://instagram.com/a').id).toBe('instagram');
    expect(recognizeChannel('https://x.com/a').id).toBe('x');
    expect(recognizeChannel('https://ayulem.com.ar').id).toBe('link');
  });
});
