import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, VIEWS } from './App';
import { I18nProvider } from './i18n';
import type { ChatSession, OnboardingDraft, SaveOutcome } from '../shared/contracts';

// Mounts the whole app, gate included. The library's 1s default is a race
// against the scheduler, not a statement about the product.
configure({ asyncUtilTimeout: 5_000 });

/**
 * The regression net for the first-run gate.
 *
 * The gate replaces the whole shell for a fresh install, so every test here
 * asserts both halves: what the human sees instead of the workspace, and the
 * fact that the workspace is really gone (not hidden behind a modal).
 */

const state = vi.hoisted(() => ({
  complete: false,
  draft: null as OnboardingDraft | null,
  completeError: false,
  /** The completion write rejects: the failure the gate has to survive. */
  completeWriteError: false,
  /** `saveBrief` reports a conflict: the disk version won, the text was not saved. */
  briefConflict: false,
  /** jsdom is not the desktop app; a test that needs the folder picker opts in. */
  isDesktop: false,
  useFolderCalls: 0,
  saveBrandContextCalls: [] as Array<{ brandId: string; text: string; fingerprint: string | null }>,
}));

// The preview API stays real (jsdom gives it localStorage); only the gate's own
// reads, the writes whose failure the tests force, and the brand-context write
// are observed, so the flows under test are the ones that ship.
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    // A getter, not a snapshot: the folder-link test needs the desktop path.
    get isDesktop() { return state.isDesktop; },
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => {
        if (state.completeError) throw new Error('onboarding flag unreadable');
        return state.complete;
      },
      getOnboardingDraft: async () => (state.completeError ? null : state.draft),
      setOnboardingComplete: async (complete: boolean) => {
        if (state.completeWriteError) throw new Error('no se pudo guardar');
        return actual.browserAPI.setOnboardingComplete(complete);
      },
      saveBrief: async (workId: string, brief: string, baseFingerprint?: string | null) => {
        if (state.briefConflict) return { status: 'conflict' } as unknown as SaveOutcome;
        return actual.browserAPI.saveBrief(workId, brief, baseFingerprint ?? null);
      },
      useFolder: async () => {
        state.useFolderCalls += 1;
        return null;
      },
      // Only reached when a test opts into the desktop path; the preview throws.
      addTeamMember: async (workId: string, roleId: string): Promise<ChatSession> => ({
        id: 'sess-' + roleId, workId, provider: 'claude', model: null, accountId: null, label: roleId, resumed: false, roleId, roleName: roleId, historyRecovered: false,
      }),
      saveBrandContext: async (brandId: string, text: string, fingerprint: string | null) => {
        state.saveBrandContextCalls.push({ brandId, text, fingerprint });
        return actual.browserAPI.saveBrandContext(brandId, text, fingerprint);
      },
    },
  };
});

const mount = () => render(<I18nProvider><App /></I18nProvider>);
const gateHeading = () => screen.findByRole('heading', { name: '¿En qué querés trabajar?' });
const shell = (container: HTMLElement) => container.querySelector('.app-shell');

/** Clicks a card by the visible text of its title. */
const clickCard = (title: RegExp) => fireEvent.click(screen.getByRole('button', { name: title }));

/** The page footer's primary action ("Continuar" / "Empezar trabajo"). */
const pageFooter = (container: HTMLElement) => {
  const footers = [...container.querySelectorAll<HTMLElement>('.onboarding-footer')];
  return footers[footers.length - 1];
};

/** Creates a brand in the gate and stays on the brand step, as designed. */
function createBrand(container: HTMLElement, name: string) {
  const input = screen.getByPlaceholderText('Nombre de la marca');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(input.parentElement!.querySelector('button') as HTMLButtonElement);
}

/** The demo brand lives in its own section; the same name appears in "existing". */
function chooseDemoBrand() {
  const section = screen.getByRole('heading', { name: 'Explorar con el proyecto demo' }).closest('section') as HTMLElement;
  fireEvent.click(section.querySelector('button') as HTMLButtonElement);
}

describe('first-run onboarding gate', () => {
  beforeEach(() => {
    state.complete = false;
    state.draft = null;
    state.completeError = false;
    state.completeWriteError = false;
    state.briefConflict = false;
    state.isDesktop = false;
    state.useFolderCalls = 0;
    state.saveBrandContextCalls = [];
    localStorage.clear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the gate and NOT the workspace for a fresh install', async () => {
    const { container } = mount();
    await gateHeading();
    expect(shell(container)).toBeNull();
    expect(container.querySelector('main.workspace')).toBeNull();
    // The catalog is data-driven: six intents plus the free-form entry.
    for (const intent of ['Planificar', 'Producir', 'Operar', 'Analizar', 'Optimizar', 'Reportar']) {
      expect(screen.getByRole('heading', { name: intent })).toBeDefined();
    }
    expect(screen.getByRole('button', { name: /Empezar libremente/ })).toBeDefined();
  });

  it('shows the workspace and NOT the gate for a returning user', async () => {
    state.complete = true;
    const { container } = mount();
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull();
  });

  it('falls back to the workspace when the flag cannot be read, never a dead gate', async () => {
    state.completeError = true;
    const { container } = mount();
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull();
  });

  it('keeps a visible skip affordance and lands in the workspace with the flag set', async () => {
    const { container } = mount();
    await gateHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Saltar por ahora' }));
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull();
    const stored = JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}');
    expect(stored.onboardingComplete).toBe(true);
  });

  it('skips the context step entirely for the free-form work type', async () => {
    mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    expect(await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' })).toBeDefined();
    expect(screen.queryByText('¿Qué querés lograr?')).toBeNull();
  });

  it('blocks completion on a required question and declares an assumption for the optional ones', async () => {
    const { container } = mount();
    await gateHeading();
    clickCard(/Campaña nueva/);
    // Straight through with the required question blank.
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    const start = await screen.findByRole('button', { name: /Empezar trabajo/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    // Back to the context step, answer the required one, and the optional gaps
    // are stated as assumptions instead of blocking.
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    const objective = screen.getByPlaceholderText('¿Qué querés lograr?');
    fireEvent.change(objective, { target: { value: 'Lanzar la cosecha 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    const enabled = await screen.findByRole('button', { name: /Empezar trabajo/ });
    await waitFor(() => expect((enabled as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Sigo sin audiencia definida; la confirmamos después.')).toBeDefined();
    expect(pageFooter(container)).toBeDefined();
  });

  it('reveals the optional brand-context field for a new brand and saves it exactly once when non-empty', async () => {
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    createBrand(container, 'Casa Nueva');
    // It stays on the brand step so the context can arrive before the walk ends.
    const field = await screen.findByLabelText('Contexto de marca (opcional)');
    expect(screen.getByText('Si lo dejás vacío, el agente te lo va a preguntar en la primera conversación.')).toBeDefined();
    fireEvent.change(field, { target: { value: '  Tono cálido y preciso.  ' } });
    fireEvent.click(pageFooter(container).querySelector('button.primary') as HTMLButtonElement);

    await waitFor(() => expect(state.saveBrandContextCalls).toHaveLength(1));
    expect(state.saveBrandContextCalls[0].text).toBe('Tono cálido y preciso.');
    // A brand created seconds ago has nothing to compare against: null is safe.
    expect(state.saveBrandContextCalls[0].fingerprint).toBeNull();
    expect(await screen.findByRole('heading', { name: '¿Cómo querés conectar la IA?' })).toBeDefined();
  });

  it('never writes an empty brand context', async () => {
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    createBrand(container, 'Casa Vacía');
    await screen.findByLabelText('Contexto de marca (opcional)');
    fireEvent.click(pageFooter(container).querySelector('button.primary') as HTMLButtonElement);
    expect(await screen.findByRole('heading', { name: '¿Cómo querés conectar la IA?' })).toBeDefined();
    expect(state.saveBrandContextCalls).toHaveLength(0);
  });

  it('lands the created work in the shipped workspace and opens it in conversation focus', async () => {
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull();
    // The new work is the one selected, not the seeded demo work.
    await waitFor(() => expect(container.querySelector('.breadcrumb strong')?.textContent).toBe('Empezar libremente'));

    // The shipped landing is conversation focus, which leaves the workspace
    // inert. "Revisar" is the human's way back in, exactly as for a returning user.
    const main = container.querySelector('main.workspace') as HTMLElement;
    expect(main.getAttribute('inert')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }));
    await waitFor(() => expect(main.getAttribute('inert')).toBeNull());
    expect(await screen.findByRole('button', { name: /^Documentos/ })).toBeDefined();
  });

  it('does not freeze when the completion path fails: it shows the failure and offers a retry', async () => {
    state.completeWriteError = true;
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    // The completion did not land, so the gate is still the only thing on screen.
    expect(shell(container)).toBeNull();
    // The failure is visible INSIDE the gate; it used to vanish into the shell.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No pudimos terminar de abrir tu espacio de trabajo');
    // And the CTA is not left disabled forever.
    await waitFor(() => expect((screen.getByRole('button', { name: /Empezar trabajo/ }) as HTMLButtonElement).disabled).toBe(false));

    // The recovery action recovers, and it lands the work already created
    // instead of creating a second one.
    const worksBefore = (JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}') as { works?: unknown[] }).works?.length ?? 0;
    state.completeWriteError = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(shell(container)).not.toBeNull());
    const worksAfter = (JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}') as { works?: unknown[] }).works?.length ?? 0;
    expect(worksAfter).toBe(worksBefore);
  });

  it('surfaces a brief conflict in the shell and never claims the brief was saved', async () => {
    state.briefConflict = true;
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    const conflicts = await screen.findAllByText('El trabajo quedó creado, pero el brief conserva la versión en disco: tu texto no se guardó.');
    const notice = conflicts[0].closest('.message') as HTMLElement;
    expect(notice.textContent).toContain('no se guardó');
    // No success claim anywhere in the shell's notice.
    expect(notice.textContent).not.toContain('guardado');
  });

  it('requires the confirmation before linking and never claims a declined link', async () => {
    state.isDesktop = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    // Ask to link a folder, then decline the confirmation.
    fireEvent.click(screen.getByRole('button', { name: /Vincular una carpeta o archivos/ }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    // The confirmation the human saw was the folder-link one, not the
    // unsaved-changes guard.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('¿Elegimos la carpeta?'));
    // A declined confirmation means nothing was linked: useFolder never ran.
    expect(state.useFolderCalls).toBe(0);
    // And the shell says so instead of claiming a link (it renders the notice
    // in the workspace and in the agent panel, hence findAll).
    const notices = await screen.findAllByText('No se vinculó ninguna carpeta: el trabajo quedó creado igual.');
    expect(notices.length).toBeGreaterThan(0);
  });

  it('links only after an accepted confirmation', async () => {
    state.isDesktop = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    fireEvent.click(screen.getByRole('button', { name: /Vincular una carpeta o archivos/ }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(state.useFolderCalls).toBe(1);
  });

  it('keeps the gate a pre-shell branch: no new workspace view was added', () => {
    expect([...VIEWS]).toEqual(['brief', 'funnel', 'context', 'memory', 'decisions']);
    expect((VIEWS as readonly string[])).not.toContain('onboarding');
  });
});
