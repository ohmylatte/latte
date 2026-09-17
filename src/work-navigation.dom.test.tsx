import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

configure({ asyncUtilTimeout: 5_000 });

/**
 * Navigating to a document has to arrive AS a document.
 *
 * `focusChat` is `layout === 'conversation' && view === 'brief'`, and an effect
 * on `work.id` used to reset `layout` to `'conversation'` after every caller
 * had already decided. So each surface that wanted the document — the Embudo,
 * Inicio's review queue — was silently turned into the chat, and the document
 * sat behind an `inert` workspace. Entering a work now states its layout once,
 * in `selectWork`, and nothing overwrites it afterwards.
 */

const state = vi.hoisted(() => ({
  /** Resolves the work's permissions read, so a test can order two of them. */
  permissionGate: null as null | { hold: Promise<void>; release: () => void },
  permissionReads: [] as string[],
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      // Two works, because the race needs a switch between them: one work
      // cannot re-trigger an effect keyed on its own id.
      listWorks: async (brandId: string) => {
        const list = await actual.browserAPI.listWorks(brandId);
        const first = list[0];
        return first ? [first, { ...first, id: 'second-work', title: 'Rebranding otoño' }] : list;
      },
      getWorkPermissions: async (workId: string) => {
        state.permissionReads.push(workId);
        const first = state.permissionReads.length === 1;
        // The value is decided BEFORE the wait: read late, it still carries
        // what the first work answered, which is the whole point.
        const value = first ? 'auto' as const : 'ask' as const;
        if (first && state.permissionGate) await state.permissionGate.hold;
        return value;
      },
    },
  };
});

const mount = () => render(<I18nProvider><App /></I18nProvider>);
const continueRow = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.home-continue .home-row');
const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.tabs button')]
    .find((button) => button.textContent?.startsWith(name)) as HTMLButtonElement;
const isChat = (container: HTMLElement) => Boolean(container.querySelector('.app-shell')?.className.includes('conversation-focus'));

async function enterWork(container: HTMLElement) {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(continueRow(container) as HTMLButtonElement);
  await waitFor(() => expect(container.querySelector('.tabs')).not.toBeNull());
}

describe('navigating inside a work', () => {
  it('opens a document picked in the Embudo as a document, not as a chat', async () => {
    const { container } = mount();
    await enterWork(container);

    fireEvent.click(tab(container, 'Embudo'));
    await waitFor(() => expect(container.querySelector('.funnel-mode')).not.toBeNull());

    // The funnel's own card for the seeded document: picking it means "show it".
    const card = container.querySelector('.funnel-mode button.funnel-card[data-document-id]') as HTMLButtonElement;
    expect(card).not.toBeNull();
    fireEvent.click(card);

    await waitFor(() => expect(tab(container, 'Documentos').className).toContain('selected'));
    expect(isChat(container)).toBe(false);
  });

  it('marks the open work in the sidebar while the Embudo is the tab', async () => {
    const { container } = mount();
    await enterWork(container);
    fireEvent.click(tab(container, 'Embudo'));
    await waitFor(() => expect(tab(container, 'Embudo').className).toContain('selected'));

    // The Embudo is one of the seven tabs of a work, so the work is open.
    expect(container.querySelector('.work-nav .work-active')).not.toBeNull();
  });

  it('keeps the permissions of the work on screen when a slower read answers late', async () => {
    let release!: () => void;
    state.permissionReads = [];
    state.permissionGate = { hold: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };

    const { container } = mount();
    const workButton = async (title: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>('.work-nav button')]
        .find((candidate) => candidate.title === title);
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    };
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });

    // Open the first work, whose permissions read is held open...
    fireEvent.click(await workButton('Lanzamiento primavera'));
    await waitFor(() => expect(state.permissionReads.length).toBe(1));

    // ...then move to the second, whose read answers right away.
    fireEvent.click(await workButton('Rebranding otoño'));
    await waitFor(() => expect(state.permissionReads.length).toBe(2));

    // Now the stale answer lands. It must not decide what agents may write:
    // the first read returns 'auto' (write without asking), the second 'ask'.
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.permissionGate = null;

    fireEvent.click(tab(container, 'Trabajo'));
    await waitFor(() => expect(container.querySelector('.trabajo-permission-mode')).not.toBeNull());
    expect(container.querySelector('.trabajo-permission-mode')?.textContent).toBe('Preguntar siempre');
  });
});
