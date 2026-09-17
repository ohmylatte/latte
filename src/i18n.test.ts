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

  it('exposes every trabajo/evidencia key in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const keys = Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('trabajo.') || k.startsWith('evidencia.'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
  });

  it('exposes every decision/resultados key in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const keys = Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('decision.') || k.startsWith('resultados.'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
    // The two new surfaces must actually be present, not just pass on the
    // pre-existing `decision.authority.*` keys.
    expect(keys.filter((k) => k.startsWith('decision.permissions.')).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith('resultados.')).length).toBeGreaterThan(0);
  });

  it('exposes the mode settings keys in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const keys = ['settings.advanced', 'settings.advancedLead', 'settings.modeLabel', 'settings.modeSimple', 'settings.modeAdvanced', 'settings.modeHelp'];
    for (const key of keys) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
  });

  it('exposes every funnel action and out-of-scope key in both locales', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const keys = Object.keys(catalogs['es-AR']).filter((k) => k.startsWith('funnel.'));
    expect(keys).toContain('funnel.analyze');
    expect(keys).toContain('funnel.outOfScope');
    expect(keys).toContain('funnel.outOfScopeUndo');
    expect(keys).toContain('funnel.associateEmpty');
    expect(keys.filter((k) => k.startsWith('funnel.doc.')).length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(catalogs['es-AR'][key as keyof typeof catalogs['es-AR']], `es-AR ${key}`).toBeTruthy();
      expect(catalogs['en-US'][key as keyof typeof catalogs['en-US']], `en-US ${key}`).toBeTruthy();
    }
  });
});

describe('i18n encoding', () => {
  /**
   * Four Spanish entries shipped with their accents replaced by a literal `?`
   * (`versi?n`, `conversaci?n`, `?siempre?`), and nobody saw it for months
   * because the components that showed that copy had their own hardcoded,
   * correctly written duplicate. Wiring them to the dictionary would have put
   * the mangled text on screen. A dictionary is the single source of the words
   * a person reads, so a mangled character in it is a shipped typo.
   */
  it('has no accent mangled into a question mark or a replacement character', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    const { catalogs } = await import('./i18n');
    const { generatedEn, generatedEs } = await import('./i18n-generated');

    const mangled: string[] = [];
    const scan = (label: string, entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        // A `?` glued to a letter is an accent that did not survive a save;
        // U+FFFD is the same wound from the other direction.
        if (/\?[\p{Ll}\p{Lu}]/u.test(value) || value.includes('�')) mangled.push(`${label} ${key}: ${value}`);
      }
    };
    scan('es-AR', catalogs['es-AR']);
    scan('en-US', catalogs['en-US']);
    scan('generated es-AR', generatedEs as unknown as Record<string, string>);
    scan('generated en-US', generatedEn as unknown as Record<string, string>);

    expect(mangled).toEqual([]);
  });
});
