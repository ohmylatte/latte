import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { App } from './App';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE, type AgentRole, type ChatRuntime, type ChatSession, type HandoffRequest, type TeamMember, type Work, type WorkPermissionMode } from '../shared/contracts';

// Mounting the whole app is heavier than the library's 1s default; the boot
// races the scheduler, not the product.
configure({ asyncUtilTimeout: 5_000 });

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

/**
 * F3 + F9 — the everyday slice of the simple/advanced mode gate.
 *
 * `latte:mode` lives in App, is persisted like `latte:rail`, and gates only the
 * inline technical controls in the team panel plus the active-context footnote.
 * The default-role recommendation pre-selects the `assistant` generalist.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' };
// `assistant` is deliberately NOT first: the recommendation must not be `roles[0]`.
const roles: AgentRole[] = [
  { id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Strategist', builtin: false, tier: 'deep' },
  { id: 'assistant', name: 'Asistente', initial: 'A', summary: 'Asistente', builtin: true, tier: 'balanced' },
];
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'assistant', roleName: 'Asistente', initial: 'A',
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const chat: ChatSession = { id: 'm1', workId: 'w1', provider: 'opencode', model: null, accountId: null, label: 'OpenCode', resumed: false, roleId: 'assistant', roleName: 'Asistente', historyRecovered: false };

function panelProps(mode: LatteMode) {
  return {
    work, team: [member], chats: { m1: chat }, selectedId: 'm1', roles,
    primaryLabel: 'OpenCode', primaryDetail: 'Listo', primaryReady: true, checking: false,
    primaryRuntime: 'opencode' as ChatRuntime, primaryAccountId: null, primaryModel: null,
    choices: [] as RuntimeChoice[], busy: false, isDesktop: false,
    onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {},
    onFinish: async () => {}, onRestart: async () => {}, onContinue: async () => {},
    handoffs: [] as HandoffRequest[], onAcceptHandoff: async () => {}, onDismissHandoff: async () => {},
    onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {}, onModel: () => {}, onTier: () => {},
    onError: () => {}, onAttachFiles: async () => [], untracked: [] as string[], onAdoptFile: () => {},
    permissions: 'ask' as WorkPermissionMode, permissionBusy: false, onPermissions: () => {},
    mode,
  };
}

const renderPanel = (mode: LatteMode) => render(<TeamPanel {...panelProps(mode)} />);

describe('Latte mode gates inline technical controls', () => {
  it('simple mode hides the model and effort pickers but keeps permissions', () => {
    const { container } = renderPanel('simple');
    expect(container.querySelector('.team-model')).toBeNull();
    expect(container.querySelector('.effort-picker')).toBeNull();
    expect(container.querySelector('.folder-trust')).not.toBeNull();
  });

  it('advanced mode reveals the model and effort pickers and keeps permissions', () => {
    const { container } = renderPanel('advanced');
    expect(container.querySelector('.team-model')).not.toBeNull();
    expect(container.querySelector('.effort-picker')).not.toBeNull();
    expect(container.querySelector('.folder-trust')).not.toBeNull();
  });
});

describe('default role recommendation', () => {
  it('pre-selects the assistant generalist even when it is not the first role', () => {
    const { container } = render(<TeamPanel {...panelProps('simple')} team={[]} chats={{}} selectedId={null} />);
    const checked = container.querySelector('.role-card[aria-checked="true"]');
    expect(checked?.querySelector('[data-role]')?.getAttribute('data-role')).toBe('assistant');
  });

  it('respects a manually picked role: pre-selecting assistant does not revert it', () => {
    const { container } = render(<TeamPanel {...panelProps('simple')} team={[]} chats={{}} selectedId={null} />);
    const checkedRole = () => container.querySelector('.role-card[aria-checked="true"] [data-role]')?.getAttribute('data-role');
    expect(checkedRole()).toBe('assistant');
    const strategist = container.querySelector('.role-card [data-role="strategist"]')?.closest('button')!;
    fireEvent.click(strategist);
    expect(checkedRole()).toBe('strategist');
  });
});

describe('the add-member affordance', () => {
  it('labels the button "Personalizar equipo" in Spanish', () => {
    const { container } = renderPanel('simple');
    expect(container.querySelector('.team-tab-add')?.getAttribute('aria-label')).toBe('Personalizar equipo');
    expect(container.querySelector('.team-tab-add')?.getAttribute('title')).toBe('Personalizar equipo');
  });

  it('labels the button "Personalize team" in English', async () => {
    localStorage.setItem('latte-ui-locale', 'en-US');
    const { container } = render(<I18nProvider><TeamPanel {...panelProps('simple')} /></I18nProvider>);
    await waitFor(() => {
      expect(container.querySelector('.team-tab-add')?.getAttribute('aria-label')).toBe('Personalize team');
    });
  });
});

describe('the terminal permission line is never gated by mode', () => {
  beforeEach(() => localStorage.clear());

  const openAgents = async (container: HTMLElement) => {
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    fireEvent.click(screen.getByTitle('Ajustes'));
    await screen.findByText(/Iniciá una sesión con tu CLI/);
    return container;
  };

  it('shows the permission line in simple mode', async () => {
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await openAgents(container);
    expect(container.querySelector('.terminal-console')?.textContent).toContain('Iniciá una sesión con tu CLI instalado');
  });

  it('shows the permission line in advanced mode', async () => {
    localStorage.setItem('latte:mode', 'advanced');
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await openAgents(container);
    expect(container.querySelector('.terminal-console')?.textContent).toContain('Iniciá una sesión con tu CLI instalado');
  });
});

describe('Latte mode persistence and active-context footnote (App)', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to simple: the active-context footnote is hidden', async () => {
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(container.querySelector('.agent-footnote')).toBeNull();
  });

  it('seeds advanced from localStorage: the footnote is shown', async () => {
    localStorage.setItem('latte:mode', 'advanced');
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(container.querySelector('.agent-footnote')).not.toBeNull();
  });

  it('toggling the mode in Settings writes latte:mode', async () => {
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });
    expect(container.querySelector('.agent-footnote')).toBeNull();

    fireEvent.click(screen.getByTitle('Ajustes'));
    fireEvent.click(await screen.findByRole('button', { name: 'Avanzado' }));
    const select = await screen.findByLabelText('Modo de la interfaz');
    fireEvent.change(select, { target: { value: 'advanced' } });

    await waitFor(() => expect(localStorage.getItem('latte:mode')).toBe('advanced'));
  });
});
