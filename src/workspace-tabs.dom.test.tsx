import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

configure({ asyncUtilTimeout: 5_000 });

/**
 * Where the tab strip sits, which is not a detail: it is the bar the person
 * navigates the work with.
 *
 * The strip used to be rendered BETWEEN two groups of views — the newer
 * surfaces (Resumen, Trabajo, Evidencia, Resultados) above it, the older ones
 * (Documentos, Embudo, Decisiones) below. So selecting an older tab left the
 * slots above empty and the bar drew at the top, while selecting a newer one
 * pushed the bar under a full page of content. The bar moved depending on
 * where you were, which is the one thing a navigation bar must never do.
 *
 * It is chrome, so it belongs before every view, for every view.
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
const workspace = (container: HTMLElement) => container.querySelector<HTMLElement>('main.workspace');
const continueRow = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.home-continue .home-row');

/** Every tab of the strip, old surfaces and new ones in one list. */
const TABS = ['Resumen', 'Trabajo', 'Evidencia', 'Documentos', 'Embudo', 'Decisiones', 'Resultados'];

/** The tab button, whose label carries a count on some tabs ("Documentos 9"). */
const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.tabs button')]
    .find((button) => button.textContent?.startsWith(name)) as HTMLButtonElement;

async function enterWork(container: HTMLElement) {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(continueRow(container) as HTMLButtonElement);
  await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
}

describe('the work tab strip', () => {
  it('stays above the content on every tab, old surfaces included', async () => {
    const { container } = mount();
    await enterWork(container);

    for (const name of TABS) {
      fireEvent.click(tab(container, name));
      await waitFor(() => expect(tab(container, name).className).toContain('selected'));

      const main = workspace(container) as HTMLElement;
      const strip = main.querySelector('.tabs') as HTMLElement;
      // Chrome first: whatever the view renders comes after the bar, so the
      // bar cannot slide to the bottom of a tall page.
      const position = strip.compareDocumentPosition(main.lastElementChild as HTMLElement);
      expect(strip === main.lastElementChild || position === Node.DOCUMENT_POSITION_FOLLOWING).toBe(true);
      expect([...main.children].indexOf(strip)).toBe(0);
    }
  });

  it('keeps the bar in the same place across a switch between an old and a new tab', async () => {
    const { container } = mount();
    await enterWork(container);

    // The exact pair that showed the jump: Documentos (old) ↔ Resumen (new).
    fireEvent.click(tab(container, 'Documentos'));
    await waitFor(() => expect(tab(container, 'Documentos').className).toContain('selected'));
    const fromOld = [...(workspace(container) as HTMLElement).children].indexOf(
      (workspace(container) as HTMLElement).querySelector('.tabs') as HTMLElement,
    );

    fireEvent.click(tab(container, 'Resumen'));
    await waitFor(() => expect(tab(container, 'Resumen').className).toContain('selected'));
    const fromNew = [...(workspace(container) as HTMLElement).children].indexOf(
      (workspace(container) as HTMLElement).querySelector('.tabs') as HTMLElement,
    );

    expect(fromNew).toBe(fromOld);
  });

  it('shows no tab strip on Inicio, which is not a work', async () => {
    const { container } = mount();
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(container.querySelector('.home-view')).not.toBeNull();
    expect(container.querySelector('.tabs')).toBeNull();
  });
});
