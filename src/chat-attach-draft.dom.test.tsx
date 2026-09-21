import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ChatSession } from '../shared/contracts';
import { formatMessage } from './i18n';

/**
 * Adjuntar no manda: deja el mensaje ESCRITO.
 *
 * Hallazgo de uso real: al elegir archivos, el panel llamaba `api.sendChat`
 * en el acto con una frase fija en castellano. Dos problemas en uno: la
 * persona no podía adjuntar Y pedir algo en el mismo mensaje (el agente
 * arrancaba a pensar sobre un "te dejé unos archivos" pelado), y el copy
 * vivía incrustado en el componente, contra los diccionarios tipados.
 *
 * Ahora el adjunto copia los archivos al trabajo y prellena el borrador. Se
 * envía cuando la persona aprieta enviar, con lo que ella haya agregado.
 */

const mocks = vi.hoisted(() => ({ sendChat: vi.fn<(chatId: string, text: string) => Promise<void>>() }));
const { sendChat } = mocks;

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, sendChat: mocks.sendChat } };
});

const { ChatPane } = await import('./ChatPane');
const { chatStore } = await import('./browser-api');

let sessionId = '';
const session = (): ChatSession => ({
  id: sessionId, workId: 'w1', provider: 'claude', model: null, accountId: null,
  label: 'Claude Code', resumed: false, roleId: 'strategist', roleName: 'Estrategia', historyRecovered: true,
});

/** La frase esperada sale del diccionario, no de una copia a mano del texto. */
const note = (files: string) => formatMessage('es-AR', 'chat.attach.note', { files });

let index = 0;
beforeEach(() => {
  sendChat.mockReset();
  sendChat.mockResolvedValue(undefined);
  sessionId = `chat-attach-${++index}`;
});
afterEach(() => { chatStore.forget(sessionId); });

function mount(files: string[]) {
  const onAttachFiles = vi.fn(async () => files);
  const view = render(<ChatPane session={session()} onStop={() => undefined} onError={() => undefined} onAttachFiles={onAttachFiles} />);
  const composer = view.getByLabelText(formatMessage('es-AR', 'ui.auto.019')) as HTMLTextAreaElement;
  const attach = view.getByLabelText(formatMessage('es-AR', 'chat.attach.label'));
  const form = view.container.querySelector('form.prompt-form') as HTMLFormElement;
  return { view, onAttachFiles, composer, attach, form };
}

describe('adjuntar archivos deja el borrador escrito, no lo manda', () => {
  it('copia los archivos y prellena el composer sin enviar nada', async () => {
    const { onAttachFiles, composer, attach } = mount(['brief.pdf']);

    fireEvent.click(attach);

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(sendChat).not.toHaveBeenCalled();
    expect(composer.value).toBe(note('`brief.pdf`'));
    expect(composer.value).toContain('brief.pdf');
    // El cursor queda al final para seguir escribiendo el pedido.
    expect(composer.selectionStart).toBe(composer.value.length);
  });

  it('nombra todos los archivos elegidos, no sólo el primero', async () => {
    const { composer, attach } = mount(['brief.pdf', 'metricas.csv']);

    fireEvent.click(attach);

    await waitFor(() => expect(composer.value).not.toBe(''));
    expect(composer.value).toBe(note('`brief.pdf`, `metricas.csv`'));
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('conserva lo que la persona ya había escrito: la frase va arriba, no encima', async () => {
    const { composer, attach } = mount(['brief.pdf']);

    fireEvent.change(composer, { target: { value: 'Resumime esto en cinco puntos.' } });
    fireEvent.click(attach);

    await waitFor(() => expect(composer.value).toContain('brief.pdf'));
    expect(composer.value).toBe(`${note('`brief.pdf`')}\n\nResumime esto en cinco puntos.`);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('manda el borrador completo recién cuando la persona envía', async () => {
    const { composer, attach, form } = mount(['brief.pdf']);

    fireEvent.click(attach);
    await waitFor(() => expect(composer.value).not.toBe(''));
    fireEvent.change(composer, { target: { value: `${composer.value}\n\n¿Qué contradicciones ves?` } });
    fireEvent.submit(form);

    await waitFor(() => expect(sendChat).toHaveBeenCalledTimes(1));
    const [chatId, text] = sendChat.mock.calls[0];
    expect(chatId).toBe(sessionId);
    expect(text).toBe(`${note('`brief.pdf`')}\n\n¿Qué contradicciones ves?`);
  });
});
