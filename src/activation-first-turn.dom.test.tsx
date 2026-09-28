import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSession } from '../shared/contracts';

configure({ asyncUtilTimeout: 5_000 });

/**
 * ENTREGA 1A (Brief 01, tarea 1): "EMPEZAR TRABAJO" ARRANCA EL TRABAJO.
 *
 * Dos caminos reales, no inventados:
 *  - con una IA lista, terminar el recorrido abre la conversación del rol
 *    recomendado y le manda el brief como su primer turno (`api.sendChat`,
 *    el MISMO camino que ya usa `continueMember`);
 *  - sin ninguna lista, el trabajo y su brief quedan creados igual — nunca se
 *    pierden — y la pantalla ofrece una salida real: conectar una cuenta, o
 *    seguir explorando el proyecto demo (Brief 01, "Ningún proveedor
 *    disponible").
 */

const state = vi.hoisted(() => ({
  /** Controla si `chatStatus` reporta un runtime disponible (OpenCode listo). */
  primaryAvailable: false,
  addTeamMemberCalls: [] as Array<{ workId: string; roleId: string }>,
  sendChatCalls: [] as Array<{ chatId: string; text: string }>,
  sendChatShouldFail: false,
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return {
    ...actual,
    isDesktop: true,
    api: {
      ...actual.browserAPI,
      getOnboardingComplete: async () => false,
      getOnboardingDraft: async () => null,
      chatStatus: async () => ({ available: state.primaryAvailable, detail: state.primaryAvailable ? 'OpenCode listo.' : 'Sin runtime conectado.', version: null, models: [], defaultModel: null }),
      getPrimaryAgent: async () => null,
      listAgentRuntimes: async () => [],
      addTeamMember: async (workId: string, roleId: string): Promise<ChatSession> => {
        state.addTeamMemberCalls.push({ workId, roleId });
        return { id: 'sess-' + roleId, workId, provider: 'claude', model: null, accountId: null, label: roleId, resumed: false, roleId, roleName: roleId, historyRecovered: false };
      },
      listTeam: async () => [],
      sendChat: async (chatId: string, text: string) => {
        state.sendChatCalls.push({ chatId, text });
        if (state.sendChatShouldFail) throw new Error('no se pudo enviar');
      },
    },
  };
});

const { App } = await import('./App');
const { I18nProvider } = await import('./i18n');

const mount = () => render(<I18nProvider><App /></I18nProvider>);
const gateHeading = () => screen.findByRole('heading', { name: '¿En qué querés trabajar?' });
const shell = (container: HTMLElement) => container.querySelector('.app-shell');
const clickCard = (title: RegExp) => fireEvent.click(screen.getByRole('button', { name: title }));

/** El mismo recorrido que ya prueba `OnboardingGate.dom.test.tsx`: marca demo → conectar con el demo → "Traé tu marca" → el Resumen de siempre. */
async function chooseDemoBrandAndConnect() {
  fireEvent.click(screen.getByRole('button', { name: /Recorrer el demo/ }));
  clickCard(/Explorar con un proyecto demo/);
  fireEvent.click(await screen.findByRole('button', { name: /Empezar sin marca/ }));
}

beforeEach(() => {
  state.primaryAvailable = false;
  state.addTeamMemberCalls = [];
  state.sendChatCalls = [];
  state.sendChatShouldFail = false;
  localStorage.clear();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('Entrega 1A: empezar trabajo manda el brief como primer turno', () => {
  it('con una IA lista, abre el rol recomendado y le manda el brief compuesto', async () => {
    state.primaryAvailable = true;
    const { container } = mount();
    await gateHeading();
    clickCard(/Campaña nueva/);
    await screen.findByRole('heading', { name: 'Campaña nueva' });
    fireEvent.change(screen.getByPlaceholderText('¿Qué querés lograr?'), { target: { value: 'Lanzar la cosecha 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await chooseDemoBrandAndConnect();
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    await waitFor(() => expect(state.addTeamMemberCalls).toHaveLength(1));
    expect(state.addTeamMemberCalls[0].roleId).toBe('strategist');
    await waitFor(() => expect(state.sendChatCalls).toHaveLength(1));
    expect(state.sendChatCalls[0].chatId).toBe('sess-strategist');
    expect(state.sendChatCalls[0].text).toContain('## Objetivo');
    expect(state.sendChatCalls[0].text).toContain('Lanzar la cosecha 2026');
    // (La tarjeta "Brief · enviado al empezar" que reemplaza esta burbuja está
    // probada en detalle, con control total del chat store, en
    // `chat-activation.dom.test.tsx` — este mock no simula el eco del backend.)
  });

  it('sin ninguna IA lista, no falla en silencio: ofrece conectar o seguir en el demo', async () => {
    state.primaryAvailable = false;
    const { container } = mount();
    await gateHeading();
    clickCard(/Empezar libremente/);
    await screen.findByRole('heading', { name: '¿Con qué marca trabajamos?' });
    await chooseDemoBrandAndConnect();
    fireEvent.click(await screen.findByRole('button', { name: /Empezar trabajo/ }));

    await waitFor(() => expect(shell(container)).not.toBeNull());
    // Nunca se intentó abrir una conversación que de todos modos no iba a arrancar.
    expect(state.addTeamMemberCalls).toHaveLength(0);
    expect(state.sendChatCalls).toHaveLength(0);
    expect(await screen.findByText('Tu trabajo está listo, falta conectar una IA')).toBeDefined();
    const connect = screen.getByRole('button', { name: 'Conectar IA' });
    const continueDemo = screen.getByRole('button', { name: 'Seguir explorando el demo' });
    expect(connect).toBeDefined();

    // "Seguir explorando el demo" no reintenta solo: limpia el aviso y deja el
    // camino de siempre (sumar un rol a mano) a la vista.
    fireEvent.click(continueDemo);
    await waitFor(() => expect(screen.queryByText('Tu trabajo está listo, falta conectar una IA')).toBeNull());
    expect(state.addTeamMemberCalls).toHaveLength(0);
  });
});
