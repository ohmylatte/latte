import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * LA PREGUNTA NATIVA DEL CLI SE PUEDE RESPONDER.
 *
 * Un miembro de Claude Code llamo a `AskUserQuestion` y Latte no mostro nada:
 * la pregunta llegaba por el canal de los permisos y se contestaba sola. Con el
 * adaptador arreglado, la pregunta sale por el canal de preguntas y ESTA es su
 * tarjeta: la anatomia de las tarjetas del equipo (`coord-card`, el circulo con
 * `CircleHelp` en rust), las opciones como botones, un campo de texto libre, y
 * una sola accion.
 *
 * Al responder se pliega en una linea: lo que se respondio es un HECHO, y un
 * formulario ya usado ocupando media pantalla es ruido.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const mocks = vi.hoisted(() => ({
  replyQuestion: vi.fn<(chatId: string, requestId: string, answers: string[][] | null) => Promise<void>>(),
  emit: null as null | ((event: unknown) => void),
}));
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const { createChatStore } = await import('./chat-store');
  const api = {
    ...actual.api,
    replyQuestion: mocks.replyQuestion,
    listChatMessages: async () => [],
    onChatEvent: (handler: (event: unknown) => void) => { mocks.emit = handler; return () => { mocks.emit = null; }; },
  };
  return { ...actual, api, chatStore: createChatStore(api as unknown as typeof actual.api) };
});

const { createElement, act } = await import('react');
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { ChatPane } = await import('./ChatPane');
const { chatStore } = await import('./browser-api');
import type { ChatQuestion, ChatSession } from '../shared/contracts';

const session: ChatSession = {
  id: 'm1', workId: 'w1', provider: 'claude', model: null, accountId: null, label: 'Claude',
  resumed: false, roleId: 'assistant', roleName: 'Asistente', historyRecovered: true,
};

const question = (patch: Partial<ChatQuestion['questions'][number]> = {}): ChatQuestion => ({
  id: 'ask_1',
  questions: [{
    header: 'Tono',
    question: '¿Qué tono usamos?',
    options: [{ label: 'Cercano', description: 'De vos' }, { label: 'Formal', description: 'De usted' }],
    multiple: false,
    custom: true,
    ...patch,
  }],
});

const mount = () => render(createElement(ChatPane, {
  session, onStop: () => {}, onError: () => {},
}));

const ask = (request: ChatQuestion) => act(() => { mocks.emit?.({ chatId: 'm1', type: 'question', request }); });

describe('la tarjeta de una pregunta nativa', () => {
  it('muestra la pregunta y sus opciones con la anatomia de las tarjetas del equipo', () => {
    const { container } = mount();
    ask(question());
    const card = container.querySelector('.chat-card.question')!;
    expect(card.classList.contains('coord-card')).toBe(true);
    expect(card.querySelector('.coord-tic-live')).not.toBeNull();
    expect(card.textContent).toContain('¿Qué tono usamos?');
    const options = [...card.querySelectorAll('.chat-options button')].map((b) => b.textContent);
    expect(options).toEqual(['Cercano', 'Formal']);
    // El texto libre existe siempre: "Other" es parte del contrato de la herramienta.
    expect(card.querySelector('input[type="text"], input:not([type])')).not.toBeNull();
    chatStore.forget('m1');
    cleanup();
  });

  it('elegir y Responder manda la etiqueta al IPC, y despues la tarjeta queda plegada', async () => {
    mocks.replyQuestion.mockReset();
    mocks.replyQuestion.mockResolvedValue(undefined);
    const { container } = mount();
    ask(question());
    const card = () => container.querySelector('.chat-card.question')!;
    fireEvent.click([...card().querySelectorAll('.chat-options button')].find((b) => b.textContent === 'Cercano')!);
    fireEvent.click(card().querySelector('.chat-card-actions .primary')!);
    await waitFor(() => expect(mocks.replyQuestion).toHaveBeenCalledTimes(1));
    expect(mocks.replyQuestion.mock.calls[0]).toEqual(['m1', 'ask_1', [['Cercano']]]);
    // Plegada: lo que se respondio, en una linea, y sin formulario.
    await waitFor(() => expect(container.querySelector('.chat-question-answered')).not.toBeNull());
    expect(container.querySelector('.chat-question-answered')!.textContent).toContain('Cercano');
    expect(container.querySelector('.chat-options')).toBeNull();
    chatStore.forget('m1');
    cleanup();
  });

  it('con multiSelect une las etiquetas elegidas', async () => {
    mocks.replyQuestion.mockReset();
    mocks.replyQuestion.mockResolvedValue(undefined);
    const { container } = mount();
    ask(question({ multiple: true }));
    const option = (label: string) => [...container.querySelectorAll('.chat-options button')].find((b) => b.textContent?.includes(label))!;
    fireEvent.click(option('Cercano'));
    fireEvent.click(option('Formal'));
    fireEvent.click(container.querySelector('.chat-card-actions .primary')!);
    await waitFor(() => expect(mocks.replyQuestion).toHaveBeenCalledTimes(1));
    expect(mocks.replyQuestion.mock.calls[0]![2]).toEqual([['Cercano', 'Formal']]);
    await waitFor(() => expect(container.querySelector('.chat-question-answered')!.textContent).toContain('Cercano, Formal'));
    chatStore.forget('m1');
    cleanup();
  });

  it('el texto libre viaja como una respuesta mas', async () => {
    mocks.replyQuestion.mockReset();
    mocks.replyQuestion.mockResolvedValue(undefined);
    const { container } = mount();
    ask(question());
    const input = container.querySelector('.chat-question input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ninguno de los dos' } });
    fireEvent.click(container.querySelector('.chat-card-actions .primary')!);
    await waitFor(() => expect(mocks.replyQuestion).toHaveBeenCalledTimes(1));
    expect(mocks.replyQuestion.mock.calls[0]![2]).toEqual([['ninguno de los dos']]);
    chatStore.forget('m1');
    cleanup();
  });
});
