import { describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, VIEWS } from './App';
import { I18nProvider } from './i18n';

// This file mounts the whole app, twice over, and runs next to 86 other files.
// The library's 1s default is a race against the scheduler, not a statement
// about the product: the assertions below are unchanged, only the wait is.
configure({ asyncUtilTimeout: 5_000 });

/**
 * The regression net for the Contexto view.
 *
 * A shipped release had no `view === 'context'` branch at all: the brand nav
 * had a second, duplicated `<nav>` inside `<main>` whose button flipped the
 * state and rendered nothing. Brand context stayed empty, so every work's agent
 * asked the same brand questions forever.
 *
 * These tests render the real `App` in a real document and would have failed.
 */

const { pending, superseded } = vi.hoisted(() => {
  const pending = {
    id: 'proposal-1',
    brandId: 'demo',
    workId: 'demo-work',
    source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
    text: 'Audiencia: 25-40 años, urbanos.',
    rationale: 'La investigación lo sugiere.',
    mode: 'replace' as const,
    status: 'pending' as const,
    fingerprint: 'fp-1',
    baseFingerprint: '',
    stale: false,
    clientRequestId: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    decidedAt: null,
    decidedReason: null,
    supersededBy: null,
  };
  // A proposal a newer one replaced: the trail the Contexto view must show.
  const superseded = {
    ...pending,
    id: 'proposal-0',
    text: 'Primer borrador.',
    status: 'rejected' as const,
    decidedReason: 'superseded' as const,
    supersededBy: 'proposal-1',
    decidedAt: '2026-09-15T00:00:00.000Z',
  };
  return { pending, superseded };
});

// The preview API is real here (jsdom gives it localStorage); only the proposals
// are injected, because a proposal cannot be created from the preview. The rest
// of the status (fingerprint, works, history) stays real, so the save and restore
// paths under test are the ones that ship.
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      // These tests describe the workspace of a returning user: the first-run
      // gate has already been completed, so the shell mounts directly.
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      listBrandContextProposals: async (brandId: string) => [{ ...superseded, brandId }, { ...pending, brandId }],
      brandContextStatus: async (brandId: string) => ({
        ...(await actual.browserAPI.brandContextStatus(brandId)),
        pending: { ...pending, brandId },
        proposals: [{ ...superseded, brandId }, { ...pending, brandId }],
      }),
    },
  };
});

const mount = () => render(<I18nProvider><App /></I18nProvider>);

/** Every view has to render a region of its own; an empty workspace is the bug. */
const REGION: Record<(typeof VIEWS)[number], string> = {
  home: '.home-view',
  resumen: '.resumen-view',
  trabajo: '.trabajo-view',
  evidencia: '.evidencia-view',
  brief: '.document-scroll',
  funnel: '.funnel-view',
  context: '.context-editor',
  memory: '.document-scroll',
  // Marca → Equipo (esquema 14): el plantel de la marca.
  roster: '.brand-team-view',
  identity: '.identity-view',
  decisions: '.document-scroll',
  resultados: '.resultados-view',
};

const CONTROL: Record<(typeof VIEWS)[number], RegExp> = {
  home: /^Inicio/,
  resumen: /^Resumen/,
  trabajo: /^Trabajo/,
  evidencia: /^Evidencia/,
  brief: /^Documentos/,
  funnel: /^Embudo/,
  context: /^Contexto/,
  memory: /^Memoria/,
  roster: /^Equipo/,
  identity: /^Identidad/,
  decisions: /^Decisiones/,
  resultados: /^Resultados/,
};

describe('Contexto view', () => {
  it('is the only Contexto control, and <main> holds no stray nav', async () => {
    const { container } = mount();
    const buttons = await screen.findAllByRole('button', { name: 'Contexto' });
    expect(buttons).toHaveLength(1);
    expect(container.querySelectorAll('main nav')).toHaveLength(0);
  });

  it('shows the editor, a save action and the pending diff when opened', async () => {
    const { container } = mount();
    const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(button);

    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];

    const editor = screen.getByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement;
    expect(editor.value).toBe(brand.context);
    expect(screen.getByRole('button', { name: 'Guardar contexto' })).toBeDefined();

    // The proposals arrive from the app's own fetch, so wait for them.
    const diff = await waitFor(() => {
      const found = container.querySelector('.context-diff');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(diff.textContent).toContain(pending.text);
    expect(diff.querySelectorAll('.context-diff-add').length).toBeGreaterThan(0);
    expect(diff.querySelectorAll('.context-diff-del').length).toBeGreaterThan(0);
  });

  it('saves an edited context through the existing updateBrand path', async () => {
    mount();
    const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(button);

    const editor = screen.getByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Tono cercano y preciso.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contexto' }));

    const { api } = await import('./browser-api');
    await waitFor(async () => {
      const brands = await api.listBrands();
      expect(brands[0].context).toBe('Tono cercano y preciso.');
    });
    expect(await screen.findByText('Contexto guardado')).toBeDefined();
  });

  it('renders a region for every view', async () => {
    const { container } = mount();
    const main = () => container.querySelector('main') as HTMLElement;
    // Wait for the work to be listed, or `brief` shows its empty state instead.
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    // A returning user lands on Inicio; the way into a work is its own row in
    // the "Continuar" card (the topbar's in-work modes are not on Inicio). That
    // opens the work in conversation focus, which hides the whole workspace
    // (`aria-hidden` + `inert`). "Revisar", now in-work chrome, is the human's
    // way back to the document pane.
    fireEvent.click(container.querySelector('.home-continue .home-row') as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));

    // `home` is visited LAST: on Inicio the in-work tabs are hidden, so
    // `/^Documentos/` is unreachable mid-loop and `getByRole` would throw.
    for (const view of [...VIEWS.filter((v) => v !== 'home'), 'home' as const]) {
      fireEvent.click(screen.getByRole('button', { name: CONTROL[view] }));
      expect(main().querySelector(REGION[view]), `${view} rendered an empty workspace`).not.toBeNull();
    }
  });

  it('states the brand-wide truth and the current status', async () => {
    mount();
    const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(button);
    // One context, shared by every work of the brand, and where it stands.
    expect(await screen.findByText(/lo comparte 1 trabajo de esta marca/i)).toBeDefined();
    expect(screen.getByText('Pendiente')).toBeDefined();
  });

  it('shows the trail of a superseded proposal instead of letting it vanish', async () => {
    const { container } = mount();
    const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(button);
    const decided = await waitFor(() => {
      const found = container.querySelector('.context-decided');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(decided.textContent).toContain('Reemplazada por una propuesta más nueva');
  });

  it('marks the nav when the brand has no context at all', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];
    const brands = vi.spyOn(api, 'listBrands').mockResolvedValue([{ ...brand, context: '' }]);
    const fetched = vi.spyOn(api, 'getBrand').mockResolvedValue({ ...brand, context: '' });
    // No proposal either: the brand is empty AND has nothing waiting.
    const status = vi.spyOn(api, 'brandContextStatus').mockResolvedValue({
      brandId: brand.id, fingerprint: 'fp-empty', pending: null, proposals: [], works: [], ownerWorkId: null, revisions: [],
    });
    try {
      const { container } = mount();
      const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
      await waitFor(() => expect(container.querySelector('.nav-badge')).not.toBeNull());
      fireEvent.click(button);
      expect(await screen.findByText('Vacío')).toBeDefined();
    } finally {
      brands.mockRestore();
      fetched.mockRestore();
      status.mockRestore();
    }
  });

  it('lists the history newest-first and restores an older revision behind a confirm', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];
    await api.saveBrandContext(brand.id, 'Contexto viejo', null);
    await api.saveBrandContext(brand.id, 'Contexto nuevo', null);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const { container } = mount();
      const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
      fireEvent.click(button);

      const history = await waitFor(() => {
        const found = container.querySelector('.context-history');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      // Newest first: the value that is live now comes before the one it replaced.
      expect(history.textContent).toContain('Contexto nuevo');
      expect(history.textContent).toContain('Contexto viejo');

      const rows = [...history.querySelectorAll('li')];
      // The newest revision IS the live context. Restoring it would record
      // nothing and change nothing, so it is annotated instead of offering a
      // button that silently does nothing.
      expect(rows[0].textContent).toContain('Contexto nuevo');
      expect(rows[0].textContent).toContain('Ya es el contexto actual');
      expect(rows[0].querySelector('button')).toBeNull();

      // The entry that brings back the older value is a real action.
      const older = rows.find((row) => row.textContent?.includes('Contexto viejo'));
      const restoreButton = older?.querySelector('button');
      expect(restoreButton).not.toBeNull();
      fireEvent.click(restoreButton as HTMLButtonElement);

      await waitFor(async () => {
        expect((await api.listBrands()).find(b => b.id === brand.id)?.context).toBe('Contexto viejo');
      });
      // The restore is itself recorded, so it can be undone the same way.
      expect((await api.listBrandContextRevisions(brand.id))[0]).toMatchObject({ source: 'restore', content: 'Contexto viejo' });
      expect(confirm).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('never wipes on save, and clears only when the confirmation is accepted', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];
    await api.saveBrandContext(brand.id, 'No se toca', null);

    mount();
    const [navButton] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(navButton);
    const editor = await screen.findByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '   ' } });

    // A declined confirmation leaves the context exactly where it was.
    const declined = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Vaciar contexto' }));
    await waitFor(async () => {
      expect((await api.listBrands()).find(b => b.id === brand.id)?.context).toBe('No se toca');
    });
    declined.mockRestore();

    const accepted = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Vaciar contexto' }));
      await waitFor(async () => {
        expect((await api.listBrands()).find(b => b.id === brand.id)?.context).toBe('');
      });
      expect((await api.listBrandContextRevisions(brand.id))[0]).toMatchObject({ source: 'clear', content: '' });
    } finally {
      accepted.mockRestore();
    }
  });

  it('counts the revisions the history does not list', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];
    for (let index = 0; index < 24; index += 1) await api.saveBrandContext(brand.id, `Contexto ${index}`, null);

    mount();
    const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
    fireEvent.click(button);

    const revisions = await api.listBrandContextRevisions(brand.id);
    expect(revisions.length).toBeGreaterThan(20);
    expect(await screen.findByText(`y ${revisions.length - 20} más`)).toBeDefined();
    // 20 entries are shown and the newest one is the live value, so it is
    // annotated rather than offered as a restore that would do nothing: 19.
    expect((await screen.findAllByRole('button', { name: 'Restaurar' })).length).toBe(19);
    expect(screen.getByText('Ya es el contexto actual')).toBeDefined();
  });

  it('lets the human reload the current value when a save is refused as stale', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];
    await api.saveBrandContext(brand.id, 'Lo que hay ahora', null);

    const refuse = vi.spyOn(api, 'saveBrandContext').mockRejectedValueOnce(
      Object.assign(new Error('Brand context changed since it was loaded'), { code: 'CONTEXT_STALE' }),
    );
    try {
      mount();
      const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
      fireEvent.click(button);
      const editor = await screen.findByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: 'Mi borrador' } });
      fireEvent.click(screen.getByRole('button', { name: 'Guardar contexto' }));

      // The refusal is not a dead end and it is not silent: the draft survives
      // and the human is offered the two ways out.
      const reload = await screen.findByRole('button', { name: 'Recargar el actual' });
      expect(screen.getByRole('button', { name: 'Guardar mi versión' })).toBeDefined();
      expect((screen.getByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement).value).toBe('Mi borrador');

      fireEvent.click(reload);
      await waitFor(() => {
        expect((screen.getByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement).value).toBe('Lo que hay ahora');
      });
    } finally {
      refuse.mockRestore();
    }
  });

  it('lets the human override a refused save and keep their own version', async () => {
    const { api } = await import('./browser-api');
    const brand = (await api.listBrands())[0];

    const refuse = vi.spyOn(api, 'saveBrandContext').mockRejectedValueOnce(
      Object.assign(new Error('Brand context changed since it was loaded'), { code: 'CONTEXT_STALE' }),
    );
    try {
      mount();
      const [button] = await screen.findAllByRole('button', { name: 'Contexto' });
      fireEvent.click(button);
      const editor = await screen.findByLabelText(/CONTEXTO DE/) as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: 'Mi versión' } });
      fireEvent.click(screen.getByRole('button', { name: 'Guardar contexto' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Guardar mi versión' }));
      await waitFor(async () => {
        expect((await api.listBrands()).find(b => b.id === brand.id)?.context).toBe('Mi versión');
      });
    } finally {
      refuse.mockRestore();
    }
  });
});
