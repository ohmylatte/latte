import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

configure({ asyncUtilTimeout: 5_000 });

/**
 * «Abrir el brief», from the Resumen, has to open the brief.
 *
 * `layout` starts at `'conversation'` and resets to it on every work change,
 * and `focusChat` is `layout === 'conversation' && view === 'brief'`. So a
 * handler that only set the view landed on the CHAT with the document behind
 * an `inert` workspace: the button named a document and delivered a
 * conversation. A link that promises a document sets the layout it needs.
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
const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.tabs button')]
    .find((button) => button.textContent?.startsWith(name)) as HTMLButtonElement;

async function openResumen(container: HTMLElement) {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(continueRow(container) as HTMLButtonElement);
  await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
  fireEvent.click(tab(container, 'Resumen'));
  await waitFor(() => expect(tab(container, 'Resumen').className).toContain('selected'));
}

describe('the Resumen link to the brief', () => {
  it('lands on the document, not on the chat', async () => {
    const { container } = mount();
    await openResumen(container);

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir el brief' }));

    // The documents surface is there AND reachable: an inert workspace means
    // the chat took the screen and the document is decoration behind it.
    await waitFor(() => expect(tab(container, 'Documentos').className).toContain('selected'));
    const main = workspace(container) as HTMLElement;
    expect(main.hasAttribute('inert')).toBe(false);
    expect(main.getAttribute('aria-hidden')).not.toBe('true');
    expect(container.querySelector('.app-shell')?.className).not.toContain('conversation-focus');
  });

  it('leaves the chat reachable from the topbar, which is what owns that switch', async () => {
    const { container } = mount();
    await openResumen(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir el brief' }));
    await waitFor(() => expect(tab(container, 'Documentos').className).toContain('selected'));

    // Opening the brief must not disable the way into the conversation: the
    // modes in the topbar stay the owner of that decision.
    fireEvent.click(screen.getByRole('button', { name: 'Conversar' }));
    await waitFor(() => expect(container.querySelector('.app-shell')?.className).toContain('conversation-focus'));
  });
});
