import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AcpTierModels, AgentRuntimeInfo } from '../shared/contracts';
import { ProvidersView } from './ProvidersView';

const state = vi.hoisted(() => ({ saved: [] as Array<[string, string, string | null]> }));

const none = { light: null, balanced: null, deep: null };
const defaults: AcpTierModels = {
  grok: { ...none },
  hermes: { light: 'openai-codex:gpt-5.6-luna', balanced: 'openai-codex:gpt-5.6-terra', deep: 'openai-codex:gpt-5.6-sol' },
};

const runtimes: AgentRuntimeInfo[] = [
  { runtime: 'grok', installed: true, version: '1.0.41', detail: 'Grok 1.0.41', accounts: [{ runtime: 'grok', id: 'acc_0000000000000001', label: 'Agencia X', system: false, loggedIn: true, detail: 'Sesión iniciada con grok.com', models: ['grok-4.7'] }] },
  { runtime: 'hermes', installed: true, version: '0.21.0', detail: 'Hermes 0.21.0', accounts: [{ runtime: 'hermes', id: 'acc_0000000000000002', label: 'Codex', system: false, loggedIn: true, detail: 'openai-codex · modelo openai-codex:gpt-5.6-sol', models: [] }] },
];

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: true,
    api: {
      ...actual.browserAPI,
      getPrimaryAgent: async () => null,
      listAgentRuntimes: async () => runtimes,
      listProviders: async () => [],
      listAccountModels: async () => ({ source: 'suggested', models: [], detail: '' }),
      getAcpTierModels: async () => ({ configured: { grok: { ...none }, hermes: { ...none } }, defaults }),
      setAcpTierModel: async (runtime: 'grok' | 'hermes', tier: 'light' | 'balanced' | 'deep', model: string | null) => {
        state.saved.push([runtime, tier, model]);
        return { grok: { ...none }, hermes: { ...none, [tier]: model } };
      },
    },
  };
});

afterEach(() => { cleanup(); state.saved = []; });

describe('Settings → Agents for Grok and Hermes', () => {
  it('shows both runtimes as Latte-only accounts, and signing out of Hermes is removing the account', async () => {
    render(<ProvidersView onChanged={() => {}} onNotice={() => {}} onError={() => {}} />);
    await screen.findByText('Grok');
    const grokCard = screen.getByText('Grok').closest('.runtime-card') as HTMLElement;
    const hermesCard = screen.getByText('Hermes').closest('.runtime-card') as HTMLElement;
    expect(within(grokCard).getByText(/Corre sólo con cuentas de Latte/)).toBeTruthy();
    expect(within(grokCard).queryAllByRole('button', { name: /Cerrar sesión/i }).length).toBe(1);
    expect(within(hermesCard).queryAllByRole('button', { name: /Cerrar sesión/i }).length).toBe(0);
  });

  it('edits the model of one level with the Latte default as the hint', async () => {
    render(<ProvidersView onChanged={() => {}} onNotice={() => {}} onError={() => {}} />);
    const group = await screen.findByRole('group', { name: /Modelo por nivel de esfuerzo · Hermes/ });
    const inputs = within(group).getAllByRole('textbox');
    expect(inputs.map((input) => (input as HTMLInputElement).placeholder)).toEqual(['openai-codex:gpt-5.6-luna', 'openai-codex:gpt-5.6-terra', 'openai-codex:gpt-5.6-sol']);
    const save = within(group).getByRole('button', { name: /Guardar/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(inputs[1], { target: { value: 'openai-codex:gpt-5.5' } });
    fireEvent.click(save);
    await waitFor(() => expect(state.saved).toEqual([['hermes', 'balanced', 'openai-codex:gpt-5.5']]));
    const grok = await screen.findByRole('group', { name: /Modelo por nivel de esfuerzo · Grok/ });
    expect(within(grok).getAllByRole('textbox').map((input) => (input as HTMLInputElement).placeholder)).toEqual(['modelo de la cuenta', 'modelo de la cuenta', 'modelo de la cuenta']);
  });
});
