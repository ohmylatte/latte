import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession } from '../shared/contracts';

/**
 * ADN DE MARCA: EL BLOQUE `latte-dna` ES PARA LATTE, NO PARA LA PERSONA.
 *
 * Un agente propone un cambio al ADN con un bloque de protocolo dentro de su
 * mensaje (mismo patrón que `latte-decision` y `latte-brand-context`). Latte
 * lo lee y lo convierte en una propuesta aprobable; en el chat, la persona ve
 * la prosa del agente y nunca el JSON crudo.
 */

const mocks = vi.hoisted(() => ({ emit: null as null | ((event: unknown) => void) }));
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const { createChatStore } = await import('./chat-store');
  const api = {
    ...actual.api,
    listChatMessages: async () => [],
    onChatEvent: (handler: (event: unknown) => void) => { mocks.emit = handler; return () => { mocks.emit = null; }; },
  };
  return { ...actual, api, chatStore: createChatStore(api as unknown as typeof actual.api) };
});

const { render, screen, act } = await import('@testing-library/react');
const { I18nProvider } = await import('./i18n');
const { ChatPane } = await import('./ChatPane');
const { chatStore } = await import('./browser-api');

const chatId = 'chat-dna-fence';
afterEach(() => { chatStore.forget(chatId); });

const session: ChatSession = {
  id: chatId, workId: 'w1', provider: 'claude', model: null, accountId: null, label: 'Claude',
  resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: true,
};

describe('ChatPane · bloque latte-dna', () => {
  it('muestra la prosa del agente y esconde el bloque de protocolo del ADN', async () => {
    render(<I18nProvider><ChatPane session={session} onStop={() => undefined} onError={() => undefined} /></I18nProvider>);
    const text = 'Anoté que la marca evita "oferta".\n\n```latte-dna\n{"field":"wordsNo","next":["oferta"],"reason":"La persona lo corrigió","source":{"kind":"correction","label":"corrección en el chat"}}\n```';
    const message: ChatMessage = {
      id: 'm1', chatId, role: 'assistant', parts: [{ type: 'text', id: 'm1-p', text }],
      createdAt: '2026-09-28T10:00:00.000Z', completed: true, error: null,
    };
    await act(async () => { mocks.emit!({ chatId, type: 'message', message }); });
    expect(await screen.findByText(/Anoté que la marca evita/)).toBeDefined();
    expect(document.body.textContent).not.toContain('latte-dna');
    expect(document.body.textContent).not.toContain('"field"');
  });
});
