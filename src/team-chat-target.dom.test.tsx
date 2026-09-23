import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * UNA SOLA VERDAD: EL DESTINATARIO DEL COMPOSER ES A QUIEN MUESTRA EL HILO.
 *
 * Lo que paso en uso real: el dueno escribio en el cuadro de texto del modo
 * Equipo con un run CANCELADO cuyo coordinador ya no estaba en el equipo. El
 * mensaje llego al Asistente --el composer ruteaba por el fallback-- y el
 * Asistente trabajo y contesto; pero la fila decia "Sin novedades" y el hilo
 * "Todavia no hay nada que contar de este miembro", porque la vista miraba a
 * `run.coordinatorMemberId`, que apuntaba a un miembro borrado.
 *
 * Dos verdades distintas para "con quien hablo" es exactamente el bug. Ahora el
 * destinatario se calcula UNA vez en `TeamPanel` y lo usan las dos: el composer
 * y el hilo. Un run terminado o cancelado nunca fija un coordinador fantasma.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const mocks = vi.hoisted(() => ({
  sendChat: vi.fn<(chatId: string, text: string) => Promise<void>>(),
  listChatMessages: vi.fn<(chatId: string) => Promise<unknown[]>>(async () => []),
  /** El emisor de eventos del store, para poner a alguien a trabajar sin un runtime. */
  emit: null as null | ((event: unknown) => void),
}));
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const { createChatStore } = await import('./chat-store');
  const api = {
    ...actual.api,
    sendChat: mocks.sendChat,
    listChatMessages: mocks.listChatMessages,
    onChatEvent: (handler: (event: unknown) => void) => { mocks.emit = handler; return () => { mocks.emit = null; }; },
  };
  return { ...actual, api, chatStore: createChatStore(api as unknown as typeof actual.api) };
});

const { createElement, act } = await import('react');
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
const { chatStore } = await import('./browser-api');
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type { ChatMessage, ChatSession, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
/** El Asistente y un miembro cualquiera. El coordinador del run NO esta: lo borraron. */
const team = [member('asis', 'Asistente', 'assistant'), member('cm', 'CM')];
const chat = (id: string): ChatSession => ({
  id, workId: 'w1', provider: 'claude', model: null, accountId: null, label: 'Claude',
  resumed: false, roleId: 'assistant', roleName: 'Asistente', historyRecovered: true,
});

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'fantasma',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const chatMessage = (id: string, chatId: string, role: 'user' | 'assistant', text: string, createdAt: string): ChatMessage =>
  ({ id, chatId, role, parts: [{ id: id + 'p', type: 'text', text }], createdAt, completed: true, error: null });

const basePanel: TeamPanelProps = {
  work, team, chats: {}, selectedId: null, roles: [],
  primaryLabel: 'Claude', primaryDetail: '', primaryReady: true, checking: false, primaryRuntime: 'claude',
  primaryAccountId: null, primaryModel: null, choices: [], busy: false, isDesktop: true, mode: 'simple',
  onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
};

const mountPanel = (props: Partial<TeamPanelProps> = {}) =>
  render(createElement(TeamPanel, { ...basePanel, formatTime: (v: string) => v, formatDate: (v: string) => v, ...props }));

const toTeam = (c: HTMLElement) => { const b = c.querySelector('.team-rail-team'); if (b) fireEvent.click(b); };
const composerOf = (c: HTMLElement) => c.querySelector('.team-view .prompt-form textarea') as HTMLTextAreaElement | null;
const rowOf = (c: HTMLElement, id: string) => c.querySelector(`.team-inbox-row[data-member-id="${id}"]`) as HTMLElement | null;
const send = async (c: HTMLElement, text: string) => {
  fireEvent.change(composerOf(c)!, { target: { value: text } });
  fireEvent.submit(c.querySelector('.team-view .prompt-form')!);
  await waitFor(() => expect(mocks.sendChat).toHaveBeenCalled());
};

const forgetAll = () => { chatStore.forget('asis'); chatStore.forget('cm'); chatStore.forget('fantasma'); };

describe('el destinatario del chat de equipo', () => {
  it('con un run CANCELADO y su coordinador borrado, escribe Y muestra el hilo del Asistente', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockImplementation(async (chatId: string) => (chatId === 'asis'
      ? [chatMessage('c1', 'asis', 'user', 'armame las piezas de la campana', '2026-09-01T09:00:00.000Z'),
        chatMessage('c2', 'asis', 'assistant', 'te dejo el brief y las preguntas', '2026-09-01T09:05:00.000Z')]
      : []));
    const { container } = mountPanel({ coordinationRun: run({ status: 'cancelled', active: false }) });
    toTeam(container);
    await send(container, 'seguimos con esto');
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('asis');
    // Y el hilo que se esta mirando es el de ESE mismo destinatario.
    await waitFor(() => expect(container.textContent).toContain('te dejo el brief y las preguntas'));
    expect(container.textContent).toContain('armame las piezas de la campana');
    expect(rowOf(container, 'asis')!.className).toContain('is-selected');
    forgetAll();
    cleanup();
  });

  it('con el run ACTIVO manda al coordinador del run', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockResolvedValue([]);
    const withCoordinator = [...team, member('coord', 'Coordinador', 'strategist')];
    const { container } = mountPanel({ team: withCoordinator, coordinationRun: run({ coordinatorMemberId: 'coord' }) });
    toTeam(container);
    await send(container, 'dale');
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('coord');
    chatStore.forget('coord');
    forgetAll();
    cleanup();
  });

  it('sin run y sin permiso de coordinacion, manda al Asistente', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockResolvedValue([]);
    const { container } = mountPanel({ coordinationRun: null });
    toTeam(container);
    await send(container, 'hola');
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('asis');
    forgetAll();
    cleanup();
  });

  /**
   * Mientras el destinatario contesta, las DOS superficies lo dicen: su fila
   * con el punto vivo y la palabra, y el final del hilo con el MISMO indicador
   * que usa la conversacion de un miembro.
   */
  it('mientras el destinatario trabaja, su fila dice Trabajando y el hilo muestra el indicador', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockResolvedValue([]);
    const { container } = mountPanel({ chats: { asis: chat('asis') }, coordinationRun: run({ status: 'cancelled', active: false }) });
    toTeam(container);
    expect(container.querySelector('.team-view .chat-status')).toBeNull();
    act(() => { mocks.emit?.({ chatId: 'asis', type: 'status', status: 'busy', detail: '' }); });
    await waitFor(() => expect(container.querySelector('.team-view .chat-status')).not.toBeNull());
    const row = rowOf(container, 'asis')!;
    expect(row.textContent).toContain('Trabajando');
    expect(row.querySelector('.coord-dot-live')).not.toBeNull();
    act(() => { mocks.emit?.({ chatId: 'asis', type: 'status', status: 'idle', detail: '' }); });
    await waitFor(() => expect(container.querySelector('.team-view .chat-status')).toBeNull());
    forgetAll();
    cleanup();
  });
});
