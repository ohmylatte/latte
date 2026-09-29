import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, VIEWS } from './App';
import { I18nProvider } from './i18n';
import { api, resetBrandDnaPreview, setBrandDnaPreviewStepMs } from './browser-api';
import type { OnboardingDraft, RuntimeStatus } from '../shared/contracts';

// Mounts the whole app, gate included. The library's 1s default is a race
// against the scheduler, not a statement about the product.
configure({ asyncUtilTimeout: 5_000 });

/**
 * The regression net for the first-run gate — Onboarding 2.0.
 *
 * The walk is THREE steps: Conectá tu IA → Traé tu marca → Inicio. The catalog
 * and its questions are NOT part of it anymore (they live in "Nuevo trabajo"),
 * so every test here asserts both halves: what the human sees instead of the
 * workspace, and the fact that the workspace is really gone (not hidden behind
 * a modal).
 *
 * The gate replaces the whole shell for a fresh install, so the assertions
 * always come in pairs: the gate's own screen, and `.app-shell` being null.
 */

const state = vi.hoisted(() => ({
  complete: false,
  draft: null as OnboardingDraft | null,
  completeError: false,
  /** The completion write rejects: the failure the gate has to survive. */
  completeWriteError: false,
  /** jsdom is not the desktop app; a test that needs the desktop path opts in. */
  isDesktop: false,
  /**
   * Runtime detection. Unavailable by default — the preview cannot detect an
   * agent runtime —, and the gate only claims "sin IA" when it is really on
   * the desktop (`isDesktop`), so the preview walk never hits that wall.
   */
  runtimes: [{ provider: 'opencode', available: false, detail: 'Requiere escritorio' }] as RuntimeStatus[],
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
    // A getter, not a snapshot: the desktop tests need the desktop path.
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
      runtimeStatus: async () => state.runtimes,
      saveBrandContext: async (brandId: string, text: string, fingerprint: string | null) => {
        state.saveBrandContextCalls.push({ brandId, text, fingerprint });
        return actual.browserAPI.saveBrandContext(brandId, text, fingerprint);
      },
    },
  };
});

const mount = () => render(<I18nProvider><App /></I18nProvider>);
/** Step one of the walk: "Conectá tu IA". */
const gateHeading = () => screen.findByRole('heading', { name: '¿Con qué cuenta trabajás?' });
/** Step two: "Traé tu marca". */
const bringHeading = () => screen.findByRole('heading', { name: 'Traé tu marca' });
const shell = (container: HTMLElement) => container.querySelector('.app-shell');
const stepsBar = (container: HTMLElement) => container.querySelector('.onboarding-steps')!;

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

/**
 * Conectá tu IA → Traé tu marca, without connecting anything: the walk's own
 * "Explorar con un proyecto demo", the only way past step one in the preview.
 */
const advanceFromConnect = () => clickCard(/Explorar con un proyecto demo/);

/** The preview store, to count what the walk really created. */
const store = () => JSON.parse(localStorage.getItem('latte-preview-v1') ?? '{}') as { works?: unknown[]; brands?: Array<{ id: string; name: string }> };
const works = () => store().works?.length ?? 0;
const brandNames = () => (store().brands ?? []).map((b) => b.name);

/** A draft parked on a given persisted step, as the walk can leave it. */
const draftOn = (step: OnboardingDraft['step'], overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  step,
  workTypeId: null,
  answers: {},
  assumptions: [],
  brandId: 'demo',
  usedDemo: true,
  linkFolderRequested: false,
  recommendedRoleId: 'assistant',
  brief: '',
  ...overrides,
});

describe('first-run onboarding gate', () => {
  beforeEach(() => {
    state.complete = false;
    state.draft = null;
    state.completeError = false;
    state.completeWriteError = false;
    state.isDesktop = false;
    state.runtimes = [{ provider: 'opencode', available: false, detail: 'Requiere escritorio' }];
    state.saveBrandContextCalls = [];
    state.draftReads = 0;
    state.holdRehydration = null;
    localStorage.clear();
    // El build simulado del ADN pasa a ser inmediato y arranca de cero: el
    // sondeo de la interfaz sigue siendo el de siempre (~1 s), sólo que con un
    // motor que no tarda.
    setBrandDnaPreviewStepMs(0);
    resetBrandDnaPreview();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the gate and NOT the workspace, with the three steps of the walk', async () => {
    const { container } = mount();
    await gateHeading();
    expect(shell(container)).toBeNull();
    expect(container.querySelector('main.workspace')).toBeNull();

    // The bar names the three steps and lights up the first one.
    expect(stepsBar(container).textContent).toBe('Conectá tu IATraé tu marcaInicio');
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 1 de 3');
    // One short title, no subtitle.
    expect(container.querySelector('.onboarding-content .intro')).toBeNull();
  });

  it('keeps the catalog and its questions OUT of the walk', async () => {
    const { container } = mount();
    await gateHeading();
    // Ni los bloques del embudo ni las preguntas de contexto viven acá: el
    // catálogo se usa cuando se crea un trabajo ("Nuevo trabajo").
    for (const block of ['Planificar', 'Producir', 'Operar y optimizar', 'Medir y reportar']) {
      expect(screen.queryByRole('heading', { name: block })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Empezar libremente/ })).toBeNull();
    expect(screen.queryByPlaceholderText('¿Qué querés lograr?')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Esto es lo que entendí' })).toBeNull();
    expect(container.querySelector('.onboarding-content .intro')).toBeNull();
  });

  it('shows the workspace and NOT the gate for a returning user', async () => {
    state.complete = true;
    const { container } = mount();
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿Con qué cuenta trabajás?' })).toBeNull();
  });

  it('replays the walk in front of Settings, starting at step one', async () => {
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
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 1 de 3');
    expect(screen.queryByRole('heading', { name: 'Traé tu marca' })).toBeNull();
  });

  it('does not resume a stale saved draft when the walk is replayed', async () => {
    // Completed, yet a draft parked on a later step survives: the flag write
    // clears it on disk, but the draft App read at boot is still in memory.
    state.complete = true;
    state.draft = draftOn('prepare');
    const { container } = mount();
    await openSettings(container);
    await replayOnboarding();

    // The gate must ignore the boot-time draft and open at step one, never at
    // "Traé tu marca" the finished walk had left behind.
    await gateHeading();
    expect(screen.queryByRole('heading', { name: 'Traé tu marca' })).toBeNull();
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 1 de 3');
  });

  it('falls back to the workspace when the flag cannot be read, never a dead gate', async () => {
    state.completeError = true;
    const { container } = mount();
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿Con qué cuenta trabajás?' })).toBeNull();
  });

  it('keeps a visible skip affordance and lands in the workspace with the flag set', async () => {
    const { container } = mount();
    await gateHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Saltar por ahora' }));
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: '¿Con qué cuenta trabajás?' })).toBeNull();
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
    expect(screen.queryByRole('heading', { name: '¿Con qué cuenta trabajás?' })).toBeNull();
  });

  it('QA1 · C: the connect step has one short title, no demo sentence, and the demo as a ghost action', async () => {
    mount();
    await gateHeading();
    expect(screen.queryByText(/El proyecto demo está siempre disponible/)).toBeNull();
    expect(screen.getByRole('button', { name: /Explorar con un proyecto demo/ }).classList.contains('primary')).toBe(false);
  });

  /**
   * EL RECORRIDO NUEVO: Conectá tu IA → Traé tu marca → Aprobar ADN → Inicio.
   *
   * En la vista previa, sin ninguna IA conectada: la marca se crea con el
   * nombre que pide la propia pantalla, el motor simulado arma la ficha y, al
   * aprobarla, la persona aterriza en Inicio SIN ningún trabajo creado — el
   * primero lo pide desde la caja de ahí.
   */
  it('conectar → traé tu marca → aprobar ADN → Inicio, sin crear ningún trabajo', async () => {
    const { container } = mount();
    await gateHeading();

    advanceFromConnect();

    // TRAE TU MARCA · instalación limpia: la pantalla pide el nombre y las fuentes.
    expect(await bringHeading()).toBeDefined();
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 2 de 3');
    expect(screen.getByText('Latte arma su ADN con lo que ya tenés.')).toBeDefined();
    // Sin ninguna fuente no hay ADN que armar: el CTA lo dice con su estado.
    expect((screen.getByRole('button', { name: /Armar mi marca/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Elegí una fuente/)).toBeDefined();

    fireEvent.change(screen.getByLabelText('Nombre de la marca'), { target: { value: 'Casa Nueva' } });
    fireEvent.change(screen.getByPlaceholderText('https://tuweb.com'), { target: { value: 'https://casanueva.com.ar' } });
    expect((screen.getByRole('button', { name: /Armar mi marca/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Armar mi marca/ }));

    // G · EL ADN DE TU MARCA
    expect(await screen.findByRole('heading', { name: 'El ADN de tu marca' })).toBeDefined();
    const approve = (await screen.findByRole('button', { name: /Aprobar ADN/ }, { timeout: 5_000 })) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    // Los pasos del build se narran con PALABRA, no sólo con color.
    const stepStates = [...container.querySelectorAll('.dna-step-state')];
    expect(stepStates.length).toBeGreaterThan(1);
    for (const s of stepStates) expect(s.textContent).toBeTruthy();
    // La ficha, con sus bloques y la fuente de cada dato.
    expect(container.querySelector('.dna-card')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Corregir/ })).toBeDefined();

    const before = works();
    fireEvent.click(approve);

    // INICIO
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(container.querySelector('.home-view')).not.toBeNull();
    expect(container.querySelector('.home-ask-title')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Esto es lo que entendí' })).toBeNull();
    // Ni trabajo creado ni marca huérfana: la que se creó es la del recorrido.
    expect(works()).toBe(before);
    expect(brandNames()).toContain('Casa Nueva');
    // Y "Traé tu marca" quedó marcado con el dato real del ADN aprobado.
    await waitFor(() => {
      const first = container.querySelector('.first-steps .first-step');
      expect(first).not.toBeNull();
      expect(first!.getAttribute('data-done')).toBe('true');
    });
  });

  it('"Empezar sin marca" crea la marca con su nombre y aterriza en Inicio sin ADN', async () => {
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    await bringHeading();

    fireEvent.change(screen.getByLabelText('Nombre de la marca'), { target: { value: 'Casa sin ADN' } });
    const before = works();
    fireEvent.click(screen.getByRole('button', { name: /Empezar sin marca/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(container.querySelector('.home-view')).not.toBeNull();
    // La marca existe con el nombre que escribió la persona...
    expect(brandNames()).toContain('Casa sin ADN');
    // ...sin ADN: "Traé tu marca" sigue pendiente en Primeros pasos, y sin trabajos.
    expect(works()).toBe(before);
    expect(container.querySelector('.first-steps .first-step')!.getAttribute('data-done')).toBe('false');
  });

  it('el camino demo: sin conectar nada, la marca demo llega a Inicio', async () => {
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    await bringHeading();

    // El demo nunca se presenta como una marca existente: es su propio enlace.
    const demo = screen.getByRole('button', { name: /Recorrer el demo/ });
    expect(demo.classList.contains('primary')).toBe(false);
    expect(screen.queryByText('Casa Oliva · Ejemplo')).toBeNull();
    fireEvent.click(demo);
    expect(await screen.findByText('Para Casa Oliva · Ejemplo')).toBeDefined();

    const before = works();
    fireEvent.click(screen.getByRole('button', { name: /Empezar sin marca/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(container.querySelector('.home-view')).not.toBeNull();
    expect(works()).toBe(before);
    expect(brandNames()).toContain('Casa Oliva · Ejemplo');
  });

  it('reanuda a mitad: el borrador vuelve a la pantalla donde quedó', async () => {
    // "Traé tu marca" persiste como `prepare` (el paso que siempre vino
    // después de conectar): el contrato de pasos no cambió con este recorrido.
    state.draft = draftOn('prepare', { brandId: 'demo' });
    const { container } = mount();
    expect(await bringHeading()).toBeDefined();
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 2 de 3');
    expect(await screen.findByText('Para Casa Oliva · Ejemplo')).toBeDefined();
  });

  /**
   * LA PRUEBA DE ESCRITORIO: la persona escribió la web y los canales, cerró
   * Latte y volvió. El formulario sólo vive en memoria, así que retomaba VACÍO
   * — sólo los logos volvían. Las fuentes son lo único que el backend guardó
   * cuando pidió "Armar mi marca", y vuelven solas.
   */
  it('al retomar una marca con lastSources, la web y los canales aparecen precargados', async () => {
    const brand = await api.createBrand('Casa Nueva');
    await api.buildBrandDna(brand.id, 'sources', {
      url: 'https://casanueva.com.ar',
      channels: ['@casanueva', 'https://linkedin.com/company/casanueva'],
      useIdentityFiles: false,
    });
    state.draft = draftOn('prepare', { brandId: brand.id, usedDemo: false });

    mount();
    expect(await bringHeading()).toBeDefined();

    // La web vuelve en su campo...
    await waitFor(() => expect((screen.getByPlaceholderText('https://tuweb.com') as HTMLInputElement).value).toBe('https://casanueva.com.ar'));
    // ...y los canales en el formato del textarea "Otros canales": uno por renglón.
    expect((screen.getByLabelText('Otros canales') as HTMLTextAreaElement).value).toBe('@casanueva\nhttps://linkedin.com/company/casanueva');
    // Con las fuentes a la vista, el CTA ya se enciende sin volver a escribir nada.
    expect((screen.getByRole('button', { name: /Armar mi marca/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('un borrador que todavía no conectaba vuelve a "Conectá tu IA"', async () => {
    state.draft = draftOn('brand');
    const { container } = mount();
    await gateHeading();
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 1 de 3');
    expect(screen.queryByRole('heading', { name: 'Traé tu marca' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '¿Con qué marca trabajamos?' })).toBeNull();
  });

  /**
   * SIN IA CONECTADA: "Traé tu marca" no puede componer, y lo dice con las tres
   * salidas que sí existen — conectar, seguir con el demo o empezar sin marca.
   * El ADN se arma después, desde Marca → ADN.
   *
   * Sólo el escritorio afirma esto: detectó los runtimes y ninguno está
   * disponible. En la vista previa no hay detección posible.
   */
  it('en el escritorio sin IA, ofrece conectar o seguir con el demo / sin marca', async () => {
    state.isDesktop = true;
    state.draft = draftOn('prepare', { brandId: 'otra', usedDemo: false });
    const { container } = mount();
    expect(await bringHeading()).toBeDefined();
    // La detección de runtimes del escritorio llega después del primer pintado.
    expect(await screen.findByText('Para componer el ADN hace falta una IA conectada.')).toBeDefined();

    // No se puede componer: ni el formulario de fuentes ni el CTA de armado.
    expect(screen.queryByPlaceholderText('https://tuweb.com')).toBeNull();
    expect(screen.queryByRole('button', { name: /Armar mi marca/ })).toBeNull();

    // Las tres salidas del requirement.
    expect(screen.getByRole('button', { name: 'Conectar IA' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Empezar sin marca/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Recorrer el demo/ })).toBeDefined();

    // "Conectar IA" vuelve al paso que la persona tiene que completar.
    fireEvent.click(screen.getByRole('button', { name: 'Conectar IA' }));
    expect(await gateHeading()).toBeDefined();
    expect(stepsBar(container).getAttribute('aria-label')).toBe('Paso 1 de 3');
  });

  it('does not freeze when the landing fails: it shows the failure and offers a retry', async () => {
    state.completeWriteError = true;
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    await bringHeading();
    fireEvent.change(screen.getByLabelText('Nombre de la marca'), { target: { value: 'Casa Fallida' } });
    fireEvent.click(screen.getByRole('button', { name: /Empezar sin marca/ }));

    // The completion did not land, so the gate is still the only thing on screen.
    expect(shell(container)).toBeNull();
    // The failure is visible INSIDE the gate; it used to vanish into the shell.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No pudimos terminar de abrir tu espacio de trabajo');
    // And the CTA is not left disabled forever.
    await waitFor(() => expect((screen.getByRole('button', { name: /Empezar sin marca/ }) as HTMLButtonElement).disabled).toBe(false));

    // The recovery action recovers, with the brand the first attempt created —
    // never a second one with the same name.
    const named = () => brandNames().filter((n) => n === 'Casa Fallida').length;
    expect(named()).toBe(1);
    state.completeWriteError = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(shell(container)).not.toBeNull());
    expect(container.querySelector('.home-view')).not.toBeNull();
    expect(named()).toBe(1);
  });

  it('QA1 · B: a clean install goes straight to the sources, with the demo as a small link', async () => {
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    expect(await bringHeading()).toBeDefined();

    // El nombre se pide UNA vez, en la misma pantalla que las fuentes: no hay
    // un paso de marca aparte duplicándolo.
    expect(screen.getByLabelText('Nombre de la marca')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Crear mi marca' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Otra marca' })).toBeNull();
    expect(screen.getByText('Latte arma su ADN con lo que ya tenés.')).toBeDefined();
    const demo = screen.getByRole('button', { name: /Recorrer el demo/ });
    expect(demo.classList.contains('primary')).toBe(false);
    // El camino que sigue sin componer está a la vista.
    expect(screen.getByRole('button', { name: /Empezar sin marca/ })).toBeDefined();
    expect(container.querySelector('.onboarding-content .intro')).not.toBeNull();
  });

  it('QA1 · B: an existing install chooses its brand inside "Traé tu marca"', async () => {
    await api.createBrand('Almacén Norte');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await api.createBrand('Bodega Sur');
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });

    const primary = screen.getByRole('button', { name: 'Seguir con Bodega Sur' });
    expect(primary.classList.contains('primary')).toBe(true);
    // The rest live behind "Otra marca", and the demo is never among them.
    expect(screen.queryByRole('button', { name: /Almacén Norte/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Otra marca' }));
    expect(screen.getByRole('button', { name: /Almacén Norte/ })).toBeDefined();
    expect(screen.queryByText('Casa Oliva · Ejemplo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Crear una marca' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Recorrer el demo/ }).classList.contains('primary')).toBe(false);

    fireEvent.click(primary);
    expect(await bringHeading()).toBeDefined();
    expect(await screen.findByText('Para Bodega Sur')).toBeDefined();
    // Y se puede volver a elegir sin salir del paso.
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar de marca' }));
    expect(await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' })).toBeDefined();
    expect(container.querySelector('main.workspace')).toBeNull();
  });

  it('reveals the optional brand-context field for a new brand and saves it exactly once when non-empty', async () => {
    await api.createBrand('Almacén Norte');
    const { container } = mount();
    await gateHeading();
    advanceFromConnect();
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    fireEvent.click(screen.getByRole('button', { name: 'Crear una marca' }));
    fireEvent.change(screen.getByPlaceholderText('Nombre de la marca'), { target: { value: 'Casa Nueva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi marca' }));

    // It stays on the brand screen so the context can arrive before the walk goes on.
    const field = await screen.findByLabelText('Contexto de marca (opcional)');
    expect(screen.getByText('El agente lo completa con vos en la primera conversación.')).toBeDefined();
    fireEvent.change(field, { target: { value: '  Tono cálido y preciso.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    await waitFor(() => expect(state.saveBrandContextCalls).toHaveLength(1));
    expect(state.saveBrandContextCalls[0].text).toBe('Tono cálido y preciso.');
    // A brand created seconds ago has nothing to compare against: null is safe.
    expect(state.saveBrandContextCalls[0].fingerprint).toBeNull();
    expect(await bringHeading()).toBeDefined();
    expect(await screen.findByText('Para Casa Nueva')).toBeDefined();
  });

  it('never writes an empty brand context', async () => {
    await api.createBrand('Almacén Norte');
    mount();
    await gateHeading();
    advanceFromConnect();
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    fireEvent.click(screen.getByRole('button', { name: 'Crear una marca' }));
    fireEvent.change(screen.getByPlaceholderText('Nombre de la marca'), { target: { value: 'Casa Vacía' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear mi marca' }));
    await screen.findByLabelText('Contexto de marca (opcional)');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(await bringHeading()).toBeDefined();
    expect(state.saveBrandContextCalls).toHaveLength(0);
  });

  it('keeps the gate a pre-shell branch: no new workspace view was added', () => {
    // `dna` no es del recorrido: es Marca → ADN, la vista de la marca para
    // quien ya usa Latte. El guard real es la línea de abajo.
    expect([...VIEWS]).toEqual(['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'roster', 'identity', 'dna', 'decisions', 'resultados']);
    expect((VIEWS as readonly string[])).not.toContain('onboarding');
  });
});
