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
  /** `saveBrief` REJECTS after `createWork` already succeeded: the work exists. */
  briefWriteError: false,
  /** jsdom is not the desktop app; a test that needs the folder picker opts in. */
  isDesktop: false,
  useFolderCalls: 0,
  /** The folder picker was accepted but the link itself failed. */
  useFolderError: false,
  saveBrandContextCalls: [] as Array<{ brandId: string; text: string; fingerprint: string | null }>,
  /** Draft reads so far: the first is App's boot read, the next is the gate's re-hydration. */
  draftReads: 0,
  /** When set, the gate's re-hydration read waits on it: the slow-disk race, on demand. */
  holdRehydration: null as Promise<void> | null,
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
      getOnboardingDraft: async () => {
        state.draftReads += 1;
        // Snapshot before waiting: the late read returns what the disk held then.
        const draft = state.completeError ? null : state.draft;
        if (state.draftReads > 1 && state.holdRehydration) await state.holdRehydration;
        return draft;
      },
      setOnboardingComplete: async (complete: boolean) => {
        if (state.completeWriteError) throw new Error('no se pudo guardar');
        // The real write also drops the saved draft on disk. Without modelling
        // that, a replayed walk would re-hydrate from a draft the flag write
        // already cleared and the replay test would pass on a fiction.
        state.draft = null;
        return actual.browserAPI.setOnboardingComplete(complete);
      },
      saveBrief: async (workId: string, brief: string, baseFingerprint?: string | null) => {
        if (state.briefWriteError) throw new Error('no se pudo guardar el brief');
        if (state.briefConflict) return { status: 'conflict' } as unknown as SaveOutcome;
        return actual.browserAPI.saveBrief(workId, brief, baseFingerprint ?? null);
      },
      useFolder: async () => {
        state.useFolderCalls += 1;
        if (state.useFolderError) throw new Error('La carpeta ya la usa otro trabajo');
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

/** Opens Ajustes from the shell's own sidebar; the gate never shows it. */
const openSettings = async (container: HTMLElement) => {
  await waitFor(() => expect(shell(container)).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
};

/** Ajustes → Espacio local, then the replay button that owns this regression. */
const replayOnboarding = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Espacio local' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Volver a ver el recorrido inicial' }));
};

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

/** A resumed draft parked on the summary step, as the walk can land there. */
const summaryDraft = (brief: string, overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  step: 'prepare',
  workTypeId: 'campaign-new',
  answers: {},
  assumptions: ['Sigo sin audiencia definida; la confirmamos después.'],
  brandId: 'demo',
  usedDemo: true,
  linkFolderRequested: false,
  recommendedRoleId: 'strategist',
  brief,
  ...overrides,
});

describe('first-run onboarding gate', () => {
  beforeEach(() => {
    state.complete = false;
    state.draft = null;
    state.completeError = false;
    state.completeWriteError = false;
    state.briefConflict = false;
    state.briefWriteError = false;
    state.isDesktop = false;
    state.useFolderCalls = 0;
    state.useFolderError = false;
    state.saveBrandContextCalls = [];
    state.draftReads = 0;
    state.holdRehydration = null;
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

  it('replays the walk in front of Settings, starting at the entry question', async () => {
    // A completed install: the shell is what the human is looking at.
    state.complete = true;
    const { container } = mount();
    await openSettings(container);
    await replayOnboarding();

    // The walk is the surface that renders. Settings has to close with the
    // click: it renders before the gate, so leaving it open would hide the walk
    // behind the screen the button was clicked from.
    await gateHeading();
    expect(shell(container)).toBeNull();
    expect(container.querySelector('.settings-shell')).toBeNull();
    // And it opens at the first step, not a later one.
    expect(screen.getByRole('heading', { name: '¿En qué querés trabajar?' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Esto es lo que entendí' })).toBeNull();
  });

  it('does not resume a stale saved draft when the walk is replayed', async () => {
    // Completed, yet a draft parked on a later step survives: the flag write
    // clears it on disk, but the draft App read at boot is still in memory.
    state.complete = true;
    state.draft = summaryDraft('## Objetivo\n\nPor definir\n');
    const { container } = mount();
    await openSettings(container);
    await replayOnboarding();

    // The gate must ignore the boot-time draft and open at the entry question,
    // never at the summary the finished walk had left behind.
    await gateHeading();
    expect(screen.queryByRole('heading', { name: 'Esto es lo que entendí' })).toBeNull();
    expect(screen.getByRole('button', { name: /Empezar libremente/ })).toBeDefined();
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

  it('shows a failed skip inside the gate with a retry, never a silent dead gate', async () => {
    state.completeWriteError = true;
    const { container } = mount();
    await gateHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Saltar por ahora' }));

    // The write failed, so the shell is still off-screen: an error routed there
    // would be invisible and the gate would look inert. It has to be HERE.
    expect(shell(container)).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No pudimos abrir tu espacio de trabajo. Reintentá para entrar.');
    // Not frozen: the recovery action is actionable and the skip stays offered.
    const retry = screen.getByRole('button', { name: 'Reintentar' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Saltar por ahora' })).toBeDefined();

    // And the recovery action actually recovers.
    state.completeWriteError = false;
    fireEvent.click(retry);
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull();
  });

  it('skips the context step entirely for the free-form work type', async () => {
    mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    expect(await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' })).toBeDefined();
    expect(screen.queryByText('¿Qué querés lograr?')).toBeNull();
  });

  it('blocks the context step on an unanswered required question and names what is missing', async () => {
    mount();
    await gateHeading();
    clickCard(/Campaña nueva/);
    await screen.findByRole('heading', { name: 'Campaña nueva' });

    // The required question is empty: the primary action is blocked and the
    // gate says exactly what is missing, instead of advancing in silence.
    const cont = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.getByText('Todavía falta responder: ¿Qué querés lograr?')).toBeDefined();

    // A click can never sneak past the missing field.
    fireEvent.click(cont);
    expect(screen.queryByRole('heading', { name: '¿Con qué marca trabajamos?' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Campaña nueva' })).toBeDefined();
  });

  it('declares an assumption for the optional questions once the required one is answered', async () => {
    const { container } = mount();
    await gateHeading();
    clickCard(/Campaña nueva/);
    await screen.findByRole('heading', { name: 'Campaña nueva' });
    // Answer the required one: the walk advances and the optional gaps become
    // assumptions instead of blocking.
    fireEvent.change(screen.getByPlaceholderText('¿Qué querés lograr?'), { target: { value: 'Lanzar la cosecha 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    const enabled = await screen.findByRole('button', { name: /Empezar trabajo/ });
    await waitFor(() => expect((enabled as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Sigo sin audiencia definida; la confirmamos después.')).toBeDefined();
    expect(pageFooter(container)).toBeDefined();
  });

  it('explains a disabled summary CTA and offers a way back to the missing required question', async () => {
    // A resumed draft can land on the summary with the required answer missing.
    state.draft = {
      step: 'prepare',
      workTypeId: 'campaign-new',
      answers: {},
      assumptions: ['Sigo sin audiencia definida; la confirmamos después.'],
      brandId: 'demo',
      usedDemo: true,
      linkFolderRequested: false,
      recommendedRoleId: 'strategist',
      brief: '## Objetivo\n\nPor definir\n',
    };
    mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });

    // The CTA is blocked, but the dead end is explained...
    const start = screen.getByRole('button', { name: /Empezar trabajo/ }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('No podés empezar todavía. Falta responder: ¿Qué querés lograr?')).toBeDefined();
    // ...and the recovery action returns to the field that needs it.
    fireEvent.click(screen.getByRole('button', { name: 'Completar ahora' }));
    expect(await screen.findByRole('heading', { name: 'Campaña nueva' })).toBeDefined();
    expect(screen.getByPlaceholderText('¿Qué querés lograr?')).toBeDefined();
  });

  it('keeps the step the human chose when the draft re-hydration resolves late', async () => {
    let release!: () => void;
    state.holdRehydration = new Promise<void>((resolve) => { release = resolve; });
    state.draft = summaryDraft('## Objetivo\n\nPor definir\n');
    mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });

    // The human acts BEFORE the gate's own draft read comes back...
    fireEvent.click(screen.getByRole('button', { name: 'Completar ahora' }));
    expect(await screen.findByRole('heading', { name: 'Campaña nueva' })).toBeDefined();

    // ...and the stale read must not rewind them to the summary.
    release();
    await waitFor(() => expect(state.draftReads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: 'Campaña nueva' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Esto es lo que entendí' })).toBeNull();
  });

  it('renders the summary brief instead of the raw Markdown symbols', async () => {
    state.draft = summaryDraft('## Objetivo\n\nPor definir\n');
    mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });

    // A marketer reads a heading, not the "## Objetivo" they reported as code.
    expect(await screen.findByRole('heading', { name: 'Objetivo' })).toBeDefined();
    expect(screen.queryByText(/##/)).toBeNull();
    // Editing is one click away, never in the way: no textarea until asked.
    expect(screen.queryByLabelText('Lo que voy a usar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Editar' })).toBeDefined();
  });

  it('reveals the plain editor on demand and shows the correction back in the rendered view', async () => {
    state.draft = summaryDraft('## Objetivo\n\nPor definir\n');
    mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const editor = await screen.findByLabelText('Lo que voy a usar') as HTMLTextAreaElement;
    expect(editor.tagName).toBe('TEXTAREA');
    // The editor holds the same value, not a copy.
    expect(editor.value).toBe('## Objetivo\n\nPor definir\n');

    fireEvent.change(editor, { target: { value: '## Objetivo\n\nLanzar la cosecha 2026\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ver resumen' }));
    expect(await screen.findByRole('heading', { name: 'Objetivo' })).toBeDefined();
    expect(screen.getByText('Lanzar la cosecha 2026')).toBeDefined();
    expect(screen.queryByLabelText('Lo que voy a usar')).toBeNull();
  });

  it('renders a readable empty state when the walk has no brief yet', async () => {
    // Free-form has no questions, so it reaches the summary with an empty brief.
    state.draft = summaryDraft('', { workTypeId: 'free-form', recommendedRoleId: 'assistant' });
    mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });
    expect(screen.getByText('Todavía no hay texto. Usá Editar para escribirlo.')).toBeDefined();
  });

  it('sends the corrected brief to the created work', async () => {
    // Free-form has no required questions, so the summary CTA is live.
    state.draft = summaryDraft('## Objetivo\n\nPor definir\n', { workTypeId: 'free-form', recommendedRoleId: 'assistant' });
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Esto es lo que entendí' });

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(await screen.findByLabelText('Lo que voy a usar'), { target: { value: '## Objetivo\n\nLanzar la cosecha 2026\n' } });
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    // The edit is the brief that shipped, not the one the walk generated.
    const stored = JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}') as { contents?: Record<string, string> };
    expect(Object.values(stored.contents ?? {}).some((text) => text.includes('Lanzar la cosecha 2026'))).toBe(true);
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

  it('resumes the completion instead of creating a second work when the brief write rejects', async () => {
    state.briefWriteError = true;
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    // `createWork` succeeded and `saveBrief` did not: the work EXISTS, so the
    // gate still owns the screen and must own this failure too.
    expect(shell(container)).toBeNull();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('El trabajo ya quedó creado');
    const createdWorks = () => (JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}') as { works?: Array<{ title: string }> }).works?.filter((w) => w.title === 'Empezar libremente').length ?? 0;
    expect(createdWorks()).toBe(1);

    // The retry resumes the failed step. Re-running createWork here is exactly
    // the duplicate the human would get charged for.
    state.briefWriteError = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(createdWorks()).toBe(1);
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

  it('surfaces a folder-link failure instead of losing it with the unmount', async () => {
    state.isDesktop = true;
    state.useFolderError = true;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    fireEvent.click(screen.getByRole('button', { name: /Vincular una carpeta o archivos/ }));
    chooseDemoBrand();
    clickCard(/Explorar con un proyecto demo/);
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    // The human said yes and the link itself failed. The gate unmounts here, so
    // the only surface left is the shell: silence is the bug.
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(state.useFolderCalls).toBe(1);
    const notices = await screen.findAllByText(/No se pudo vincular la carpeta/);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('keeps the gate a pre-shell branch: no new workspace view was added', () => {
    expect([...VIEWS]).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'roster', 'identity', 'decisions', 'resultados']);
    expect((VIEWS as readonly string[])).not.toContain('onboarding');
  });
});
