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
const accountsStore = vi.hoisted(() => ({ byRuntime: new Map<string, FakeAccount[]>(), primary: null as string | null, logins: [] as string[] }));

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
      getPrimaryAgent: async (): Promise<PrimaryAgent | null> =>
        accountsStore.primary ? { runtime: accountsStore.primary as PrimaryAgent['runtime'], model: null, accountId: `acc-${accountsStore.primary}`, label: accountsStore.primary } : null,
      startBrowserLogin: async (runtime: Parameters<typeof actual.browserAPI.startBrowserLogin>[0], accountId: string) => {
        accountsStore.logins.push(`${runtime}:${accountId}`);
        return actual.browserAPI.startBrowserLogin(runtime, accountId);
      },
      setPrimaryAgent: async (choice: { runtime: string; model: string | null; accountId: string | null }): Promise<PrimaryAgent> => {
        accountsStore.primary = choice.runtime;
        return { runtime: choice.runtime as PrimaryAgent['runtime'], model: choice.model, accountId: choice.accountId, label: choice.runtime };
      },
    },
  };
});

const { ConnectAI } = await import('./ConnectAI');
const { enableRuntimeSetupPreviewDemo, RUNTIME_SETUP_PREVIEW_SCENARIOS } = await import('./browser-api');
const { I18nProvider, catalogs } = await import('./i18n');

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConnectAI', () => {
  let off: (() => void) | null = null;
  afterEach(() => { off?.(); off = null; accountsStore.byRuntime.clear(); accountsStore.primary = null; accountsStore.logins = []; });

  it('is honest by default: no demo means "No instalado" with the official guide, and "Usar" cannot promise an install', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const cards = await screen.findAllByText('No instalado');
    expect(cards.length).toBe(2); // Claude + ChatGPT; "Otra cuenta" is not expanded yet
    expect(screen.getAllByText('Ver la guía oficial').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Instalar/ })).toBeNull();
    const use = within(screen.getByRole('group', { name: 'Claude' })).getByRole('button', { name: 'Usar Claude' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
  });

  it('QA1: one action per card — "Usar {name}" — and the status said once, never twice', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    // While detecting, "Buscando…" is the status line and nothing else.
    expect(claudeCard().textContent!.match(/Buscando…/g) ?? []).toHaveLength(1);
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    expect(within(claudeCard()).getAllByRole('button')).toHaveLength(1);
    expect(within(claudeCard()).getByRole('button', { name: 'Usar Claude' })).toBeDefined();
    expect(within(screen.getByRole('group', { name: 'ChatGPT' })).getByRole('button', { name: 'Usar ChatGPT' })).toBeDefined();
    // Each provider gets its own decorative icon (never a third-party logo), so two "C" initials can't be confused.
    expect(claudeCard().querySelector('.connect-ai-monogram svg')).not.toBeNull();
    expect(claudeCard().querySelector('.connect-ai-monogram')?.innerHTML).not.toBe(within(screen.getByRole('group', { name: 'ChatGPT' })).getByText('ChatGPT').parentElement?.querySelector('.connect-ai-monogram')?.innerHTML);
    expect(claudeCard().querySelector('img')).toBeNull();
  });

  it('QA1: not installed → a small confirmation names what Latte installs; cancelling installs nothing', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    const codexCard = () => screen.getByRole('group', { name: 'ChatGPT' });
    await waitFor(() => expect(codexCard().textContent).toContain('No instalado'));
    fireEvent.click(within(codexCard()).getByRole('button', { name: 'Usar ChatGPT' }));
    const dialog = await screen.findByRole('dialog', { name: 'Para usar ChatGPT, Latte va a instalar Codex' });
    expect(dialog.textContent).toContain('Es la app oficial de OpenAI. Tarda un par de minutos.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await tick(30);
    expect(codexCard().textContent).toContain('No instalado');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('walks the whole chain from ONE click: confirm → install → browser login → use', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('No instalado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Usar Claude' }));
    const dialog = await screen.findByRole('dialog', { name: 'Para usar Claude, Latte va a instalar Claude Code' });
    expect(dialog.textContent).toContain('Es la app oficial de Anthropic. Tarda un par de minutos.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Instalar y usar' }));
    // No second click: installing chains into the login, the login into "use".
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('installed but signed out: "Usar" starts the browser login directly, no confirmation', async () => {
    off = enableRuntimeSetupPreviewDemo('already_installed', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('Falta iniciar sesión'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Usar Claude' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('installed and signed in: "Usar" uses it right away', async () => {
    accountsStore.byRuntime.set('claude', [{ runtime: 'claude', id: 'acc-claude', label: 'Claude', system: false, loggedIn: true, detail: '', models: [] }]);
    off = enableRuntimeSetupPreviewDemo('already_installed', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('Conectado'));
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Usar Claude' }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });

  it('the account in use says "En uso" instead of a button; "Usar" on another one switches it, visibly', async () => {
    accountsStore.byRuntime.set('claude', [{ runtime: 'claude', id: 'acc-claude', label: 'Claude', system: false, loggedIn: true, detail: '', models: [] }]);
    accountsStore.byRuntime.set('codex', [{ runtime: 'codex', id: 'acc-codex', label: 'ChatGPT', system: false, loggedIn: true, detail: '', models: [] }]);
    accountsStore.primary = 'claude';
    off = enableRuntimeSetupPreviewDemo('already_installed', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    const chatgptCard = () => screen.getByRole('group', { name: 'ChatGPT' });
    await waitFor(() => expect(claudeCard().textContent).toContain('En uso'));
    expect(within(claudeCard()).queryByRole('button', { name: 'Usar Claude' })).toBeNull();
    await waitFor(() => expect(chatgptCard().textContent).toContain('Conectado'));
    fireEvent.click(within(chatgptCard()).getByRole('button', { name: 'Usar ChatGPT' }));
    await waitFor(() => expect(chatgptCard().textContent).toContain('En uso'));
    expect(within(claudeCard()).getByRole('button', { name: 'Usar Claude' })).toBeDefined();
  });

  it('onboarding: the account already in use says "En uso" and "Seguir con {name}" moves on', async () => {
    accountsStore.byRuntime.set('claude', [{ runtime: 'claude', id: 'acc-claude', label: 'Claude', system: false, loggedIn: true, detail: '', models: [] }]);
    accountsStore.primary = 'claude';
    off = enableRuntimeSetupPreviewDemo('already_installed', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI showHeader={false} onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await waitFor(() => expect(claudeCard().textContent).toContain('En uso'));
    expect(within(claudeCard()).queryByRole('button', { name: 'Usar Claude' })).toBeNull();
    fireEvent.click(within(claudeCard()).getByRole('button', { name: 'Seguir con Claude' }));
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  for (const [runtime, name] of [['claude', 'Claude'], ['codex', 'ChatGPT'], ['grok', 'Grok']] as const) {
    it(`${name}: one "Usar" starts ONE browser login, even clicked again while it is on its way`, async () => {
      off = enableRuntimeSetupPreviewDemo('already_installed', 50);
      render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
      if (runtime === 'grok') fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
      const card = () => screen.getByRole('group', { name });
      await waitFor(() => expect(card().textContent).toContain('Falta iniciar sesión'));
      const use = within(card()).getByRole('button', { name: `Usar ${name}` });
      fireEvent.click(use);
      fireEvent.click(use);
      await waitFor(() => expect(card().textContent).toContain('Iniciando sesión'));
      await tick(30);
      expect(accountsStore.logins).toEqual([`${runtime}:acc-${runtime}`]);
      expect(accountsStore.byRuntime.get(runtime)).toHaveLength(1);
    });
  }

  const confirmInstall = async (card: () => HTMLElement, name: string) => {
    await waitFor(() => expect(card().textContent).toContain('No instalado'));
    fireEvent.click(within(card()).getByRole('button', { name: `Usar ${name}` }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Instalar y usar' }));
  };

  it('needs_prereq: asks before installing an optional prerequisite', async () => {
    off = enableRuntimeSetupPreviewDemo('needs_prereq', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await confirmInstall(claudeCard, 'Claude');
    await waitFor(() => expect(claudeCard().textContent).toContain('Git para Windows'), { timeout: 3000 });
    expect(within(claudeCard()).getByRole('button', { name: 'Instalarlo también' })).not.toBeNull();
  });

  it('install failure: one plain sentence, "Usar" to try again, and the official guide — never the raw terminal dump', async () => {
    off = enableRuntimeSetupPreviewDemo('blocked_by_antivirus', 0);
    const onError = vi.fn();
    render(<I18nProvider><ConnectAI onError={onError} /></I18nProvider>);
    const codexCard = () => screen.getByRole('group', { name: 'ChatGPT' });
    await confirmInstall(codexCard, 'ChatGPT');
    await waitFor(() => expect(codexCard().textContent).toContain('El antivirus bloqueó el instalador.'), { timeout: 3000 });
    expect(within(codexCard()).getByRole('button', { name: 'Usar ChatGPT' })).not.toBeNull();
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
    await confirmInstall(claudeCard, 'Claude');
    await waitFor(() => expect(claudeCard().textContent).toContain('Terminá de iniciar sesión acá abajo.'), { timeout: 3000 });
    expect(claudeCard().querySelector('.terminal-host')).not.toBeNull();
  });

  it('login not confirmed after finishing: one plain sentence', async () => {
    off = enableRuntimeSetupPreviewDemo('login_not_confirmed', 0);
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    const claudeCard = () => screen.getByRole('group', { name: 'Claude' });
    await confirmInstall(claudeCard, 'Claude');
    await waitFor(() => expect(claudeCard().textContent).toContain('Terminaste el ingreso, pero todavía no vemos la sesión iniciada.'), { timeout: 3000 });
    expect(within(claudeCard()).getByRole('button', { name: 'Usar Claude' })).not.toBeNull();
  });

  it('"Otra cuenta" expands to pick Grok, Hermes or OpenCode, each with its own full card', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    for (const name of ['Grok', 'Hermes', 'OpenCode']) expect(screen.getByRole('button', { name }).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Grok' })).getByRole('button', { name: 'Usar Grok' })).toBeDefined());
    await waitFor(() => expect(screen.getByRole('group', { name: 'Grok' })).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Otra cuenta/ }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Grok' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Hermes' })).not.toBeNull();
  });

  it('a picked account replaces the third card (no card inside a card); signing in shows "Abrir de nuevo" and "Cancelar" in one row, no "Usar"', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 100);
    const { container } = render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Grok' }));
    const grokCard = () => screen.getByRole('group', { name: 'Grok' });
    expect(within(grokCard()).getByRole('button', { name: '‹ Otra cuenta' })).toBeDefined();
    expect(container.querySelectorAll('.connect-ai-cards > .connect-ai-card')).toHaveLength(3);
    expect(container.querySelector('.connect-ai-card .connect-ai-card')).toBeNull();
    await confirmInstall(grokCard, 'Grok');
    const reopen = await within(grokCard()).findByRole('button', { name: 'Abrir de nuevo' }, { timeout: 3000 });
    const cancel = within(grokCard()).getByRole('button', { name: 'Cancelar' });
    expect(reopen.parentElement).toBe(cancel.parentElement);
    expect(within(grokCard()).queryByRole('button', { name: 'Usar Grok' })).toBeNull();
    expect(accountsStore.logins).toHaveLength(1);
  });

  it('OpenCode has no login concept here: "Usar OpenCode" installs it and uses it, no sign-in step', async () => {
    off = enableRuntimeSetupPreviewDemo('success', 0);
    const onConnected = vi.fn();
    render(<I18nProvider><ConnectAI onConnected={onConnected} onError={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
    const opencodeCard = () => screen.getByRole('group', { name: 'OpenCode' });
    await confirmInstall(opencodeCard, 'OpenCode');
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(within(opencodeCard()).queryByRole('button', { name: /Iniciar sesión/ })).toBeNull();
  });

  it('recheck row: "Volver a comprobar" re-detects and updates "Última comprobación"', async () => {
    render(<I18nProvider><ConnectAI onError={() => {}} /></I18nProvider>);
    await screen.findByText('Última comprobación: hace 0s');
    await tick(1100);
    const recheck = screen.getByRole('button', { name: /Volver a comprobar/ });
    // QA1: compact icon + text buttons.
    expect(recheck.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '¿Qué falta?' }).querySelector('svg')).not.toBeNull();
    fireEvent.click(recheck);
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
      const use = within(claudeCard()).getByRole('button', { name: 'Usar Claude' }) as HTMLButtonElement;
      if (!use.disabled) fireEvent.click(use);
      // "already_installed" starts past the install step (no confirmation).
      const confirm = screen.queryByRole('button', { name: 'Instalar y usar' });
      if (confirm) fireEvent.click(confirm);
      await tick(30);
      expect(container.textContent, scenario).not.toContain('undefined');
      unmount();
      stop();
    }
  });
});
