import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSession } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * ENTREGA 1A (Brief 01, tarea 3): "NUEVO TRABAJO" EN EL SHELL YA VIVO.
 *
 * El propio `WorkCatalogModal` ya se prueba a fondo, aparte y sin `App`
 * (`work-catalog-modal.dom.test.tsx`). Esto prueba sólo el cableado: el botón
 * "Nuevo trabajo" del shell abre el catálogo (no el formulario de sólo
 * título de antes), y terminarlo dentro de un trabajo ya en curso activa el
 * rol recomendado con el MISMO camino que el onboarding — `activateWork`,
 * nunca una segunda copia.
 */
const state = vi.hoisted(() => ({ addTeamMemberCalls: [] as Array<{ workId: string; roleId: string }>, sendChatCalls: [] as Array<{ chatId: string; text: string }> }));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: true,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => true,
      getOnboardingDraft: async () => null,
      chatStatus: async () => ({ available: true, detail: 'OpenCode listo.', version: null, models: [], defaultModel: null }),
      getPrimaryAgent: async () => null,
      listAgentRuntimes: async () => [],
      addTeamMember: async (workId: string, roleId: string): Promise<ChatSession> => {
        state.addTeamMemberCalls.push({ workId, roleId });
        return { id: 'sess-' + roleId, workId, provider: 'claude', model: null, accountId: null, label: roleId, resumed: false, roleId, roleName: roleId, historyRecovered: false };
      },
      listTeam: async () => [],
      sendChat: async (chatId: string, text: string) => { state.sendChatCalls.push({ chatId, text }); },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

beforeEach(() => { state.addTeamMemberCalls = []; state.sendChatCalls = []; localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Entrega 1A: "Nuevo trabajo" abre el catálogo en un shell ya vivo', () => {
  it('crea el trabajo con el catálogo y activa el rol recomendado, como el onboarding', async () => {
    const { container } = render(<I18nProvider><App /></I18nProvider>);
    await screen.findByRole('button', { name: 'Lanzamiento primavera' });

    // El botón del pie de la barra lateral, no el de Inicio (los dos se
    // llaman "Nuevo trabajo"): éste es el que siempre está, en cualquier vista.
    fireEvent.click(container.querySelector('.sidebar-bottom button') as HTMLButtonElement);
    // El catálogo, no el formulario de sólo título: hay bloques del embudo.
    expect(await screen.findByRole('heading', { name: '¿En qué querés trabajar?' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Medir y reportar' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Análisis de paid media/ }));
    fireEvent.change(screen.getByPlaceholderText('¿Qué cuenta administramos?'), { target: { value: 'Cuenta principal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: '¿En qué querés trabajar?' })).toBeNull());
    // El nuevo trabajo queda seleccionado (no el de demo).
    await waitFor(() => expect(document.querySelector('.breadcrumb strong')?.textContent).toBe('Análisis de paid media'));
    await waitFor(() => expect(state.addTeamMemberCalls).toEqual([{ workId: expect.any(String), roleId: 'paid-media' }]));
    await waitFor(() => expect(state.sendChatCalls).toHaveLength(1));
    expect(state.sendChatCalls[0].text).toContain('Cuenta principal');
  });
});
