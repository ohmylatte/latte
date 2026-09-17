import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { I18nProvider } from './i18n';

// This file mounts the whole app next to 90 other files. The library's 1s
// default is a race against the scheduler, not a statement about the product.
configure({ asyncUtilTimeout: 5_000 });

/**
 * The orientation strip, in the real workspace.
 *
 * `orientation-strip-view.test.ts` pins what it says; this pins where it is and
 * that it stays there. Every query below walks the DOM instead of the
 * accessibility tree on purpose: the strip lives inside `<main>`, which is
 * `inert` while a work opens in conversation focus, and orientation has to be
 * found in the tree regardless of which layout is showing.
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
const strip = (container: HTMLElement) => container.querySelector<HTMLElement>('.orientation-strip');
const pane = (container: HTMLElement) => container.querySelector<HTMLElement>('.doc-pane');
const tab = (container: HTMLElement, label: RegExp) => [...container.querySelectorAll<HTMLButtonElement>('.tabs button')].find(b => label.test(b.textContent ?? ''));
/**
 * A returning user lands on Inicio, not inside a work. The way in is the work's
 * own row in the "Continuar" card — the topbar's in-work modes are not on a
 * global surface, so "Revisar" is no longer reachable from here. The row opens
 * the work in conversation focus, which is the layout the strip has to be found
 * in anyway.
 */
const enterWork = async (container: HTMLElement) => {
  await screen.findByRole('button', { name: 'Lanzamiento primavera' });
  fireEvent.click(container.querySelector('.home-continue .home-row') as HTMLButtonElement);
};

describe('the orientation strip in the workspace', () => {
  it('mounts above the toolbar, as the first child of the document pane', async () => {
    const { container } = mount();
    await enterWork(container);

    const region = await waitFor(() => {
      const found = strip(container);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Dónde estamos');

    expect(pane(container)?.firstElementChild).toBe(region);
    const toolbar = container.querySelector<HTMLElement>('.document-toolbar');
    expect(toolbar).not.toBeNull();
    expect(region.compareDocumentPosition(toolbar as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('survives a document switch without losing its place', async () => {
    // A second document of the same work, so there is something to switch to.
    const { api } = await import('./browser-api');
    await api.createDocument('demo-work', 'note', 'Nota de prueba', null);

    const { container } = mount();
    await enterWork(container);
    await waitFor(() => expect(container.querySelectorAll('.doc-row').length).toBeGreaterThan(1));

    const rows = [...container.querySelectorAll<HTMLElement>('.doc-row')];
    const other = rows.find(row => row.getAttribute('aria-current') !== 'true') as HTMLElement;
    fireEvent.click(other);
    await waitFor(() => expect(other.getAttribute('aria-current')).toBe('true'));

    expect(strip(container)).not.toBeNull();
    expect(pane(container)?.firstElementChild).toBe(strip(container));
  });

  it('is not rendered in the funnel, where the document pane is not', async () => {
    const { container } = mount();
    await enterWork(container);
    await waitFor(() => expect(strip(container)).not.toBeNull());

    fireEvent.click(tab(container, /^Embudo/) as HTMLButtonElement);
    await waitFor(() => expect(strip(container)).toBeNull());
    expect(container.querySelector('.funnel-view')).not.toBeNull();
  });
});
