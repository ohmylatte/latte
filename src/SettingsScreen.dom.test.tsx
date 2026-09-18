import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { I18nProvider } from './i18n';
import type { CoordinationBudget } from '../shared/contracts';

/**
 * The optional app-wide coordination budget cap (autonomous-coordination
 * Phase 7 task 7.13): advanced settings only, progressive disclosure. Unset
 * shows an honest "no global cap" and applies nothing; the primary flow
 * (starting/approving a run) never routes through this control at all — it
 * is reachable only from Ajustes > Avanzado.
 */

const mocks = vi.hoisted(() => ({
  getCoordinationGlobalBudget: vi.fn<() => Promise<CoordinationBudget | null>>(),
  setCoordinationGlobalBudget: vi.fn<(budget: CoordinationBudget) => Promise<CoordinationBudget>>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      appInfo: async () => ({ version: '0.0.0', dataDir: '/tmp', engine: 'sqlite', engineReason: null, pack: 'marketing-core', packRoles: 5 }),
      getCoordinationGlobalBudget: mocks.getCoordinationGlobalBudget,
      setCoordinationGlobalBudget: mocks.setCoordinationGlobalBudget,
    },
  };
});

const { SettingsScreen } = await import('./SettingsScreen');

function settingsProps(patch: Record<string, unknown> = {}) {
  return {
    controls: null, onProfileDirtyChange: () => {}, section: 'advanced' as const, onSection: () => {},
    onClose: () => {}, onChanged: () => {}, onNotice: () => {}, onError: () => {}, notice: '', error: '',
    onDismiss: () => {}, mode: 'simple' as const, onModeChange: () => {}, ...patch,
  };
}

const mount = (patch: Record<string, unknown> = {}) => render(<I18nProvider><SettingsScreen {...settingsProps()} {...patch} /></I18nProvider>);

describe('the global coordination budget cap in advanced settings (task 7.13)', () => {
  beforeEach(() => { mocks.getCoordinationGlobalBudget.mockReset(); mocks.setCoordinationGlobalBudget.mockReset(); });

  it('shows an honest "no global cap" when unset', async () => {
    mocks.getCoordinationGlobalBudget.mockResolvedValue(null);
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.coordination-global-budget')?.textContent).toContain('Sin presupuesto configurado'));
  });

  it('shows the configured cap when set', async () => {
    mocks.getCoordinationGlobalBudget.mockResolvedValue({ maxDispatches: 40 });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.coordination-global-budget')?.textContent).toContain('40'));
  });

  it('saves a new cap through setCoordinationGlobalBudget, never inventing a limit on its own', async () => {
    mocks.getCoordinationGlobalBudget.mockResolvedValue(null);
    mocks.setCoordinationGlobalBudget.mockResolvedValue({ maxDispatches: 25 });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.coordination-global-budget-input')).not.toBeNull());
    const input = container.querySelector('.coordination-global-budget-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.click(container.querySelector('.coordination-global-budget-save')!);
    await waitFor(() => expect(mocks.setCoordinationGlobalBudget).toHaveBeenCalledWith({ maxDispatches: 25 }));
  });

  it('lives only in the advanced section — it does not render for any other settings section', async () => {
    mocks.getCoordinationGlobalBudget.mockResolvedValue(null);
    const { container } = mount({ section: 'workspace' });
    await waitFor(() => expect(container.querySelector('.settings-section')).not.toBeNull());
    expect(container.querySelector('.coordination-global-budget')).toBeNull();
    expect(mocks.getCoordinationGlobalBudget).not.toHaveBeenCalled();
  });
});
