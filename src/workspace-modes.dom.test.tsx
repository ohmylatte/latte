import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

// This file mounts the whole app next to 90 other files. The library's 1s
// default is a race against the scheduler, not a statement about the product.
configure({ asyncUtilTimeout: 5_000 });

/**
 * The topbar's workspace modes (Conversar / Revisar).
 *
 * They are in-work chrome: they say which layout the open work is in, so they
 * only mean something once a work is open. Inicio is a global attention
 * surface — the shell still selects a work to summarize the brand, so the old
 * `work &&` guard rendered the toggle there and it read as "a work is open
 * behind this list". The guard is now the view, not the selection.
 *
 * This is the regression net for that: absent on Inicio even with a work
 * selected, present the moment a work is entered through Inicio's own row.
 */

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
    },
  };
});

const mount = () => render(<I18nProvider><App /></I18nProvider>);
const modes = (container: HTMLElement) => container.querySelector<HTMLElement>('.workspace-modes');
/** The work's own row in the "Continuar" card: Inicio's way into a work. */
const continueRow = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.home-continue .home-row');

describe('the topbar workspace modes', () => {
  it('is absent on Inicio, even though the shell has a work selected', async () => {
    const { container } = mount();
    // The work list has loaded, so the absence below cannot be the brand still
    // resolving: Inicio is rendered and a work is selected behind it.
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(container.querySelector('.home-view')).not.toBeNull();
    expect(container.querySelector('.breadcrumb strong')?.textContent).toBe('Lanzamiento primavera');

    expect(modes(container)).toBeNull();
  });

  it('appears once a work is entered from Inicio', async () => {
    const { container } = mount();
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });

    const row = continueRow(container) as HTMLButtonElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);

    await waitFor(() => expect(modes(container)).not.toBeNull());
    // The same toggle, unchanged: the two in-work layouts, Conversar pressed.
    expect(modes(container)?.textContent).toContain('Conversar');
    expect(modes(container)?.textContent).toContain('Revisar');
    expect(modes(container)?.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Conversar');
  });
});
