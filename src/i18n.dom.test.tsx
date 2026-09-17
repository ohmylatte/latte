import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, useI18n } from './i18n';

/**
 * The FIRST paint of the shell, which is the one nobody can undo.
 *
 * The stored preference arrives over IPC, one tick after the window is
 * already on screen. Until this, the provider started at a hardcoded
 * `es-AR`, so an English install flashed Spanish on every launch. The
 * desktop preload writes the main process's locale into `<html lang>`
 * before the page loads, and the provider paints from there.
 */

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.browserAPI,
      // Never resolves: the assertions below are about the paint BEFORE the
      // preference is known, so the read must not be allowed to win the race.
      getUiLocale: () => new Promise<never>(() => undefined),
      getContentLocale: () => new Promise<never>(() => undefined),
    },
  };
});

function Probe() {
  const { locale, t } = useI18n();
  return <p>{locale} · {t('settings.title')}</p>;
}

const originalLang = document.documentElement.lang;
afterEach(() => { document.documentElement.lang = originalLang; });

describe('the locale of the first paint', () => {
  it('paints English when the preload says the install is English', async () => {
    document.documentElement.lang = 'en-US';
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText('en-US · Latte settings')).toBeDefined();
  });

  it('paints Spanish for every other system, which is the default', async () => {
    // What `index.html` ships, and what the web preview and jsdom both see.
    document.documentElement.lang = 'es';
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText('es-AR · Ajustes de Latte')).toBeDefined();
  });

  it('does not treat an unknown language as English', async () => {
    document.documentElement.lang = 'pt-BR';
    render(<I18nProvider><Probe /></I18nProvider>);
    await waitFor(() => expect(screen.getByText(/^es-AR/)).toBeDefined());
  });
});
