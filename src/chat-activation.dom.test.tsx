import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatSession } from '../shared/contracts';

/**
 * ENTREGA 1A: LA TARJETA "BRIEF - ENVIADO AL EMPEZAR" Y LA TIRA DE PROGRESO.
 *
 * La tarjeta reemplaza la burbuja del primer turno SOLO cuando ese mensaje ES
 * el brief (mismo texto exacto que `work.brief`), nunca por ser el primero
 * nomas -- un miembro sumado a mano tambien tiene un primer mensaje, y ese no
 * es este caso. "Editar" nunca reescribe el turno ya mandado: carga el texto
 * en el borrador, mismo patron que `acceptHandoff` (cargado, nunca mandado
 * solo).
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

const { render } = await import('@testing-library/react');
const { I18nProvider } = await import('./i18n');
const { ChatPane } = await import('./ChatPane');
const { chatStore } = await import('./browser-api');

let index = 0;
let currentSessionId = '';
afterEach(() => { if (currentSessionId) chatStore.forget(currentSessionId); });

const session = (): ChatSession => ({
  id: currentSessionId, workId: 'w1', provider: 'claude', model: null, accountId: null, label: 'Claude',
  resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: true,
});

const userMessage = (id: string, text: string): ChatMessage => ({
  id, chatId: currentSessionId, role: 'user', parts: [{ type: 'text', id: `${id}-p`, text }], createdAt: '2026-09-27T10:00:00.000Z', completed: true, error: null,
});

function pushMessage(message: ChatMessage) {
  mocks.emit!({ chatId: currentSessionId, type: 'message', message });
}

let reserved = false;
/** Reserves a fresh session id (so a message pushed before mounting lands in the right chat) without mounting yet. */
function nextSessionId(): string {
  currentSessionId = `chat-activation-${++index}`;
  reserved = true;
  return currentSessionId;
}

function mount(activation: Parameters<typeof ChatPane>[0]['activation']) {
  if (!reserved) nextSessionId();
  reserved = false;
  return render(<I18nProvider><ChatPane session={session()} onStop={() => undefined} onError={() => undefined} activation={activation} /></I18nProvider>);
}

describe('Entrega 1A: la tarjeta del brief enviado al empezar', () => {
  it('reemplaza la burbuja cuando el primer mensaje humano ES el brief', () => {
    const brief = '## Objetivo\n\nLanzar la cosecha 2026';
    nextSessionId();
    pushMessage(userMessage('u1', brief));
    const { container, getByText, queryByText } = mount({ pinnedBrief: brief });

    expect(getByText('Brief · enviado al empezar')).toBeDefined();
    const card = container.querySelector('.chat-brief-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Lanzar la cosecha 2026');
    // La burbuja plana del mismo turno no se duplica.
    expect(container.querySelectorAll('.chat-message.user')).toHaveLength(0);
    expect(queryByText('Lanzar la cosecha 2026', { selector: '.chat-bubble' })).toBeNull();
  });

  it('no dibuja la tarjeta cuando el primer mensaje NO coincide con el brief', () => {
    nextSessionId();
    pushMessage(userMessage('u2', 'Un mensaje cualquiera, no el brief.'));
    const { container, queryByText } = mount({ pinnedBrief: '## Objetivo\n\nOtra cosa' });

    expect(queryByText('Brief · enviado al empezar')).toBeNull();
    expect(container.querySelectorAll('.chat-message.user')).toHaveLength(1);
  });

  it('"Editar" carga el brief en el borrador; nunca lo reenvía sola', () => {
    const brief = 'Pedido original';
    nextSessionId();
    pushMessage(userMessage('u3', brief));
    const onEditBrief = vi.fn();
    const { getByRole } = mount({ pinnedBrief: brief, onEditBrief });

    getByRole('button', { name: 'Editar' }).click();
    expect(onEditBrief).toHaveBeenCalledTimes(1);
  });

  it('sin `activation`, ChatPane se dibuja exactamente como antes', () => {
    nextSessionId();
    pushMessage(userMessage('u4', 'Hola'));
    const { container, queryByText } = mount(undefined);
    expect(queryByText('Brief · enviado al empezar')).toBeNull();
    expect(container.querySelectorAll('.chat-message.user')).toHaveLength(1);
  });
});

describe('Entrega 1A: la tira de pasos de negocio', () => {
  it('dibuja un chip por paso, con su tono y su frase — nunca sólo color', () => {
    const { container, getByText } = mount({
      steps: [
        { id: 'brief', labelKey: 'activation.step.brief', tone: 'done' },
        { id: 'working', labelKey: 'activation.step.working', tone: 'current' },
        { id: 'approval', labelKey: 'activation.step.approval', tone: 'pending' },
      ],
    });
    expect(getByText('Brief enviado').closest('.chip')?.getAttribute('data-tone')).toBe('verified');
    expect(getByText('Tu equipo está trabajando').closest('.chip')?.getAttribute('data-tone')).toBe('running');
    expect(getByText('Esperando tu aprobación').closest('.chip')?.getAttribute('data-tone')).toBe('draft');
    expect(container.querySelectorAll('.activation-progress .chip')).toHaveLength(3);
  });

  it('el detalle técnico sólo aparece cuando quien llama lo manda (modo avanzado)', () => {
    const { queryByText } = mount({
      steps: [{ id: 'working', labelKey: 'activation.step.working', tone: 'current' }],
    });
    expect(queryByText(/Ejecuta/)).toBeNull();

    const { getByText } = mount({
      steps: [{ id: 'working', labelKey: 'activation.step.working', tone: 'current' }],
      workingDetail: 'Ejecuta wc -l brief.md',
    });
    expect(getByText('Ejecuta wc -l brief.md')).toBeDefined();
  });

  it('sin pasos, no dibuja la tira', () => {
    const { container } = mount({ steps: [] });
    expect(container.querySelector('.activation-progress')).toBeNull();
  });
});
