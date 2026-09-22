import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionExpiredCard } from './ChatPane';
import { createChatStore } from './chat-store';
import { formatMessage } from './i18n';
import { api } from './browser-api';
import type { ChatEvent } from '../shared/contracts';

/**
 * El aviso de conexión vencida (G6 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`): una tarjeta EN EL
 * HILO con el botón de volver a entrar, no un toast que se va solo.
 */
const t = (key: Parameters<typeof formatMessage>[1], params?: Record<string, string | number>) => formatMessage('es-AR', key, params);

describe('la tarjeta', () => {
  it('nombra la conexión, explica qué pasó y ofrece volver a entrar', () => {
    render(<ConnectionExpiredCard connection={{ connectionId: 'con_1', label: 'The Agentcy', detail: 'venció' }} onError={() => {}} />);
    expect(screen.getByText(t('connections.expiredCardTitle', { name: 'The Agentcy' }))).toBeTruthy();
    expect(screen.getByText(t('connections.expiredCardBody'))).toBeTruthy();
    expect(screen.getByText(t('connections.reenter'))).toBeTruthy();
  });

  it('el botón vuelve a entrar a ESA conexión', async () => {
    const reconnect = vi.spyOn(api, 'reconnectConnection').mockResolvedValue({} as never);
    render(<ConnectionExpiredCard connection={{ connectionId: 'con_1', label: 'The Agentcy', detail: '' }} onError={() => {}} />);
    fireEvent.click(screen.getByText(t('connections.reenter')));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith('con_1'));
    reconnect.mockRestore();
  });

  it('si volver a entrar falla, lo dice en vez de quedarse girando', async () => {
    const reconnect = vi.spyOn(api, 'reconnectConnection').mockRejectedValue(new Error('se cerró la ventana'));
    const onError = vi.fn();
    render(<ConnectionExpiredCard connection={{ connectionId: 'con_1', label: 'The Agentcy', detail: '' }} onError={onError} />);
    fireEvent.click(screen.getByText(t('connections.reenter')));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('se cerró la ventana'));
    reconnect.mockRestore();
  });
});

describe('el estado del chat', () => {
  function store() {
    let emit: (event: ChatEvent) => void = () => {};
    const created = createChatStore({
      onChatEvent: (callback) => { emit = callback; return () => {}; },
      listChatMessages: async () => [],
    });
    return { store: created, emit: (event: ChatEvent) => emit(event) };
  }

  it('guarda el aviso en el chat del miembro', () => {
    const s = store();
    s.emit({ chatId: 'mem_1', type: 'connection-expired', connectionId: 'con_1', label: 'The Agentcy', detail: 'venció' });
    expect(s.store.get('mem_1').expiredConnections).toEqual([{ connectionId: 'con_1', label: 'The Agentcy', detail: 'venció' }]);
    // Y no se cuela en el de al lado.
    expect(s.store.get('mem_2').expiredConnections).toEqual([]);
  });

  it('no apila dos tarjetas de la misma conexión', () => {
    const s = store();
    const event: ChatEvent = { chatId: 'mem_1', type: 'connection-expired', connectionId: 'con_1', label: 'The Agentcy', detail: 'venció' };
    s.emit(event);
    s.emit(event);
    expect(s.store.get('mem_1').expiredConnections).toHaveLength(1);
  });

  it('volver a entrar la retira, sin reiniciar a nadie', () => {
    const s = store();
    s.emit({ chatId: 'mem_1', type: 'connection-expired', connectionId: 'con_1', label: 'The Agentcy', detail: 'venció' });
    s.emit({ chatId: 'mem_1', type: 'connection-expired', connectionId: 'con_2', label: 'Gmail', detail: 'venció' });
    s.emit({ chatId: 'mem_1', type: 'connection-restored', connectionId: 'con_1' });
    expect(s.store.get('mem_1').expiredConnections.map((c) => c.connectionId)).toEqual(['con_2']);
  });
});
