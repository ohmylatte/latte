import { describe, expect, it, vi } from 'vitest';
import { interpolate } from './i18n-core';

describe('i18n formatter', () => {
  it('falls back safely and interpolates without evaluating input', () => {
    expect(interpolate('en-US', '{count, plural, one {# role} other {# roles}}', { count: 1 })).toBe('1 role');
    expect(interpolate('en-US', '{count, plural, one {# role} other {# roles}}', { count: 3 })).toBe('3 roles');
    expect(interpolate('es-AR', 'Hola, {name}', { name: '<script>' })).toBe('Hola, <script>');
  });
});

describe('i18n catalogs', () => {
  /**
   * The type says `Record<MessageKey, string>`, which catches a missing key at
   * typecheck time. This is the runtime half: a key added to one locale and
   * forgotten in the other must not wait for a typecheck to be noticed.
   */
  it('has exactly the same named keys in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    expect(Object.keys(catalogs['en-US']).sort()).toEqual(Object.keys(catalogs['es-AR']).sort());
    expect(Object.keys(catalogs['es-AR']).length).toBeGreaterThan(0);
  });

  it('never leaves a brand-context string untranslated in either locale', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    for (const key of Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('context.'))) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
  });

  it('resolves every onboarding key in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const keys = Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('onboarding.') || k.startsWith('work.') || k.startsWith('question.') || k.startsWith('assumption.'));
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
  });
});
