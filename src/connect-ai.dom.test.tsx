import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentAccount, AgentRuntimeInfo, PrimaryAgent } from '../shared/contracts';

/**
 * Entrega 1C (Maqueta E) — "¿Con qué cuenta trabaja tu equipo?": tres
 * tarjetas (Claude, ChatGPT, Otra cuenta) sobre el motor de "onboarding sin
 * terminal" (shared/contracts.ts). El motor mismo ya está probado
 * (tests/backend/runtime-setup-*.test.ts, runtime-setup-preview.dom.test.tsx);
 * acá se prueba que ConnectAI lo dibuja bien, con la vista previa web como
 * doble honesto — ver `enableRuntimeSetupPreviewDemo` en browser-api.ts.
 *
 * `listAgentRuntimes`/`addAgentAccount`/`setPrimaryAgent` son cuentas
 * gestionadas por el escritorio real; la vista web los deja honestamente
 * indisponibles (`unavailable`), así que acá se los reemplaza por un
 * almacén en memoria — igual que hace `enableRuntimeSetupPreviewDemo` con el
 * motor de instalación/login.
 */

interface FakeAccount extends AgentAccount { }
const accountsStore = vi.hoisted(() => ({ byRuntime: new Map<string, FakeAccount[]>() }));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: false,
    api: {
      ...actual.browserAPI,
      listAgentRuntimes: async (): Promise<AgentRuntimeInfo[]> =>
        [...accountsStore.byRuntime.entries()].map(([runtime, accounts]) => ({ runtime: runtime as AgentRuntimeInfo['runtime'], installed: true, version: '1.0.0', detail: '', accounts })),
      addAgentAccount: async (runtime: string, label: string): Promise<FakeAccount> => {
        const account: FakeAccount = { runtime: runtime as FakeAccount['runtime'], id: `acc-${runtime}`, label, system: false, loggedIn: false, detail: '', models: [] };
        accountsStore.byRuntime.set(runtime, [...(accountsStore.byRuntime.get(runtime) ?? []), account]);
        return account;
      },
      setPrimaryAgent: async (choice: { runtime: string; model: string | null; accountId: string | null }): Promise<PrimaryAgent> =>
        ({ runtime: choice.runtime as PrimaryAgent['runtime'], model: choice.model, accountId: choice.accountId, label: choice.runtime }),
    },
  };
});

const { ConnectAI } = await import('./ConnectAI');
const { enableRuntimeSetupPreviewDemo, RUNTIME_SETUP_PREVIEW_SCENARIOS } = await import('./browser-api');
const { I18nProvider, catalogs } = await import('./i18n');

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConnectAI', () => {
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; accountsStore.byRuntime.clear(); });

  it('is honest by default: no demo means "No instalado" with the official guide, never a fake install button', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const cards = await screen.findAllByText('No instalado');
    expect(cards.length).toBe(2); // Claude + ChatGPT; "Otra cuenta" is not expanded yet
    expect(screen.getAllByText('Ver la guía oficial').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Instalar/ })).toBeNull();
  });

  it('walks the full happy path: install → connect → "Usar Claude" fires onConnected', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    const onConnected = vi.fn();
    const { container } = render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);

    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Falta iniciar sesión'), { timeout: 3000 });

    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Iniciar sesión en Claude/ }));
    // `stepMs: 0` can race past the intermediate "browser_opened"/"waiting"
    // states before this poll ever samples them; the real proof of the whole
    // pipeline is the terminal "Conectado" state, not catching every step.
    await waitFor(() => expect(claudeCard().textContent).toContain('Conectado'), { timeout: 3000 });

    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Usar Claude/ }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(container).toBeTruthy();
  });

  it('needs_prereq: asks before installing an optional prerequisite', async () => {
    off = enableRuntimeSetupPreviewDemo('needs_prereq', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Git para Windows'), { timeout: 3000 });
    expect(within(claudeCard()).getByRole('button', { name: 'Instalarlo también' })).not.toBeNull();
  });

  it('install failure: one plain sentence, a way to recheck, and the official guide — never the raw terminal dump', async () => {
    off = enableRuntimeSetupPreviewDemo('blocked_by_antivirus', 0);
    const onError = vi.fn();
    render(<I18nProvider><ConnectAI onError={onError} /></I18nProvider>);
    const codexCard = () => screen.getByRole('group', { name: 'ChatGPT' });
    await waitFor(() => expect(codexCard().textContent).toContain('No instalado'));
    fireEvent.click(within(codexCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(codexCard().textContent).toContain('El antivirus bloqueó el instalador.'), { timeout: 3000 });
    expect(within(codexCard()).getByRole('button', { name: /Ya lo hice, buscar de nuevo/ })).not.toBeNull();
    expect(within(codexCard()).getByText('Ver la guía oficial')).not.toBeNull();
    expect(codexCard().textContent).not.toMatch(/Operation did not complete/);
  });

  it('login falling back to the embedded terminal: one plain line, then the terminal pane', async () => {
    // jsdom has neither `matchMedia` nor `ResizeObserver`; @xterm/xterm reads
    // both from `Terminal.open()`/its fit addon. No other test in this repo
    // mounts a live TerminalPane, so this polyfill is local to the one test
    // that actually needs a real embedded terminal.
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      })) as typeof window.matchMedia;
    }
    if (typeof window.ResizeObserver === 'undefined') {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    }
    off = enableRuntimeSetupPreviewDemo('login_needs_terminal', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Falta iniciar sesión'), { timeout: 3000 });
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Iniciar sesión en Claude/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Este paso necesita que termines el ingreso acá abajo.'), { timeout: 3000 });
    expect(claudeCard().querySelector('.terminal-host')).not.toBeNull();
  });

  it('login not confirmed after finishing: one plain sentence', async () => {
    off = enableRuntimeSetupPreviewDemo('login_not_confirmed', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Falta iniciar sesión'), { timeout: 3000 });
    fireEvent.click(within(claudeCard()).getByRole('button', { name: /Iniciar sesión en Claude/ }));
    await waitFor(() => expect(claudeCard().textContent).toContain('Terminaste el ingreso, pero todavía no vemos la sesión iniciada.'), { timeout: 3000 });
  });

  it('"Otra cuenta" expands to pick Grok, Hermes or OpenCode, each with its own full card', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Grok' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Otra cuenta/ }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Grok' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Hermes' })).not.toBeNull();
  });

  it('OpenCode has no login concept here: once installed, it points at Configuración avanzada instead of a login button', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
    const opencodeCard = () => screen.getByRole('group', { name: 'OpenCode' });
    await waitFor(() => expect(opencodeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(opencodeCard()).getByRole('button', { name: /Instalar/ }));
    await waitFor(() => expect(opencodeCard().textContent).toContain('Configuración avanzada'), { timeout: 3000 });
    expect(within(opencodeCard()).queryByRole('button', { name: /Iniciar sesión/ })).toBeNull();
  });

  it('recheck row: "Volver a comprobar" re-detects and updates "Última comprobación"', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    await screen.findByText('Última comprobación: hace 0s');
    await tick(1100);
    fireEvent.click(screen.getByRole('button', { name: /Volver a comprobar/ }));
    await waitFor(() => expect(screen.getByText(/Última comprobación: hace \ds/).textContent).toBe('Última comprobación: hace 0s'));
  });

  it('diagnostic: "¿Qué falta?" shows one sentence per runtime and a copy button with a manual-select fallback', async () => {
    const original = (navigator as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '¿Qué falta?' }));
    await screen.findByText(/Claude: no instalado\./);
    fireEvent.click(screen.getByRole('button', { name: /Copiar diagnóstico/ }));
    await screen.findByText(/No pudimos copiarlo solos/);
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });

  it('the collapsed advanced box reveals the unchanged agents/terminal content, and only there', () => {
    const { container } = render(<I18nProvider><ConnectAI onError={() => {}} advanced={<div className="legacy-agents-block">legacy</div>} /></I18nProvider>);
    const details = container.querySelector('details.connect-ai-advanced')!;
    expect(details).not.toBeNull();
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('.legacy-agents-block')).not.toBeNull();
  });

  it('never mentions CLI/PATH/OAuth/runtime/MCP/token in its own copy (both locales)', () => {
    for (const locale of ['es-AR', 'en-US'] as const) {
      const keys = Object.keys(catalogs[locale]).filter((k) => k.startsWith('connectAI.'));
      expect(keys.length).toBeGreaterThan(50);
      for (const key of keys) {
        const text = catalogs[locale][key as keyof (typeof catalogs)['es-AR']];
        expect(text, `${locale} ${key}`).not.toMatch(/\bCLI\b|\bPATH\b|\bOAuth\b|\bruntime\b|\bMCP\b|\btoken\b/i);
      }
    }
  });

  it('plays every named preview scenario without crashing and without an empty/undefined sentence', async () => {
    for (const scenario of RUNTIME_SETUP_PREVIEW_SCENARIOS) {
      const stop = enableRuntimeSetupPreviewDemo(scenario, 0);
      const { unmount, container } = render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
      const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
      await waitFor(() => expect(claudeCard().textContent).not.toContain('Buscando'));
      // "already_installed" starts past the install step (no button to click).
      const installButton = within(claudeCard()).queryByRole('button', { name: /Instalar/ });
      if (installButton) fireEvent.click(installButton);
      await tick(30);
      expect(container.textContent, scenario).not.toContain('undefined');
      unmount();
      stop();
    }
  });
});
