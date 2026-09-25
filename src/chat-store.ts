import { useCallback, useRef, useSyncExternalStore } from 'react';
import { EMPTY_USAGE, type ChatEvent, type ChatMessage, type ChatPermission, type ChatQuestion, type ChatStatus, type ChatUsage, type LatteAPI } from '../shared/contracts';
import { editsInProgress } from './active-edits';

export interface ChatState {
  messages: ChatMessage[];
  /** What the human typed but has not sent. Lives here so the pane can unmount (Settings, member switch) without losing it. */
  draft: string;
  status: ChatStatus;
  statusDetail: string;
  permissions: ChatPermission[];
  questions: ChatQuestion[];
  /** Conexiones MCP que se vencieron mientras este chat estaba abierto. Una por conexión, sin repetir. */
  expiredConnections: Array<{ connectionId: string; label: string; detail: string }>;
  error: string | null;
  closed: boolean;
  /** Lifetime consumption as last reported: seeded from the team roster, kept current by every `usage` event. */
  usage: ChatUsage;
  /** What the most recent turn alone consumed. Empty until the first `usage` event of this session. */
  lastTurn: ChatUsage;
}

const EMPTY: ChatState = { messages: [], draft: '', status: 'idle', statusDetail: '', permissions: [], questions: [], expiredConnections: [], error: null, closed: false, usage: EMPTY_USAGE, lastTurn: EMPTY_USAGE };

type Api = Pick<LatteAPI, 'onChatEvent' | 'listChatMessages'>;

/**
 * Renderer-side mirror of every chat, fed by one global event subscription
 * created at app start (so no event is lost while a pane is not mounted).
 * Messages are stored immutably per chat so React re-renders cheaply.
 */
export function createChatStore(api: Api) {
  const chats = new Map<string, ChatState>();
  const listeners = new Set<() => void>();

  const notify = () => { for (const l of listeners) l(); };
  const update = (chatId: string, fn: (state: ChatState) => ChatState) => {
    chats.set(chatId, fn(chats.get(chatId) ?? EMPTY));
    notify();
  };

  const upsertMessage = (messages: ChatMessage[], message: ChatMessage): ChatMessage[] => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index === -1) return [...messages, message];
    const next = messages.slice();
    next[index] = { ...message, parts: message.parts.length ? message.parts : messages[index].parts };
    return next;
  };

  api.onChatEvent((event: ChatEvent) => {
    switch (event.type) {
      case 'message':
        update(event.chatId, (s) => ({ ...s, messages: upsertMessage(s.messages, event.message) }));
        return;
      case 'part':
        update(event.chatId, (s) => {
          const messages = s.messages.slice();
          let index = messages.findIndex((m) => m.id === event.messageId);
          if (index === -1) {
            messages.push({ id: event.messageId, chatId: event.chatId, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null });
            index = messages.length - 1;
          }
          const message = messages[index];
          const parts = message.parts.slice();
          const partIndex = parts.findIndex((p) => p.id === event.part.id);
          if (partIndex === -1) parts.push(event.part); else parts[partIndex] = event.part;
          messages[index] = { ...message, parts };
          return { ...s, messages };
        });
        return;
      case 'delta':
        update(event.chatId, (s) => {
          const messages = s.messages.slice();
          let index = messages.findIndex((m) => m.id === event.messageId);
          if (index === -1) {
            messages.push({ id: event.messageId, chatId: event.chatId, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null });
            index = messages.length - 1;
          }
          const message = messages[index];
          const parts = message.parts.slice();
          const partIndex = parts.findIndex((p) => p.id === event.partId);
          if (partIndex === -1) parts.push({ type: 'text', id: event.partId, text: event.delta });
          else {
            const part = parts[partIndex];
            if (part.type === 'text' || part.type === 'reasoning') parts[partIndex] = { ...part, text: part.text + event.delta };
          }
          messages[index] = { ...message, parts };
          return { ...s, messages };
        });
        return;
      case 'status':
        update(event.chatId, (s) => ({ ...s, status: event.status, statusDetail: event.detail, error: event.status === 'busy' ? null : s.error }));
        return;
      case 'permission':
        update(event.chatId, (s) => ({ ...s, permissions: s.permissions.some((p) => p.id === event.request.id) ? s.permissions : [...s.permissions, event.request] }));
        return;
      case 'permission-resolved':
        update(event.chatId, (s) => ({ ...s, permissions: s.permissions.filter((p) => p.id !== event.requestId) }));
        return;
      case 'question':
        update(event.chatId, (s) => ({ ...s, questions: s.questions.some((q) => q.id === event.request.id) ? s.questions : [...s.questions, event.request] }));
        return;
      case 'question-resolved':
        update(event.chatId, (s) => ({ ...s, questions: s.questions.filter((q) => q.id !== event.requestId) }));
        return;
      case 'usage':
        update(event.chatId, (s) => ({ ...s, usage: event.total, lastTurn: event.turn }));
        return;
      case 'connection-expired':
        // Una sola tarjeta por conexión: el gateway avisa una vez, pero un
        // reinicio de la app o un segundo miembro no pueden apilar dos.
        update(event.chatId, (s) => ({
          ...s,
          expiredConnections: s.expiredConnections.some((c) => c.connectionId === event.connectionId)
            ? s.expiredConnections
            : [...s.expiredConnections, { connectionId: event.connectionId, label: event.label, detail: event.detail }],
        }));
        return;
      case 'connection-restored':
        update(event.chatId, (s) => ({ ...s, expiredConnections: s.expiredConnections.filter((c) => c.connectionId !== event.connectionId) }));
        return;
      case 'error':
        update(event.chatId, (s) => ({ ...s, error: event.message, status: 'idle' }));
        return;
      case 'closed':
        update(event.chatId, (s) => ({ ...s, closed: true, status: 'idle' }));
        return;
    }
  });

  // Cached so useSyncExternalStore keeps a stable reference between renders.
  let editsKey = '';
  let editsValue: Record<string, string[]> = {};

  return {
    /** Files each open chat is writing to right now, by chat id. */
    activeEdits(fileNames: string[]): Record<string, string[]> {
      const next: Record<string, string[]> = {};
      for (const [chatId, state] of chats) {
        const editing = editsInProgress(state.messages, fileNames);
        if (editing.length > 0) next[chatId] = editing;
      }
      const key = JSON.stringify(next);
      if (key !== editsKey) { editsKey = key; editsValue = next; }
      return editsValue;
    },
    get(chatId: string): ChatState {
      return chats.get(chatId) ?? EMPTY;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Pulls the authoritative history from the backend (e.g. right after a resume). */
    async sync(chatId: string): Promise<void> {
      const messages = await api.listChatMessages(chatId);
      update(chatId, (s) => ({ ...s, messages }));
    },
    setDraft(chatId: string, draft: string): void {
      update(chatId, (s) => ({ ...s, draft }));
    },
    /**
     * Backfills a chat's lifetime usage from the team roster (TeamMember.usage),
     * e.g. right after the team list loads or after a mutation (model/tier
     * change) that restarts the runtime without itself emitting a `usage`
     * event. Never guesses: the caller only passes what the backend persisted.
     */
    seedUsage(chatId: string, usage: ChatUsage): void {
      update(chatId, (s) => ({ ...s, usage }));
    },
    clearError(chatId: string): void {
      update(chatId, (s) => ({ ...s, error: null }));
    },
    forget(chatId: string): void {
      chats.delete(chatId);
      notify();
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;

export function useChatState(store: ChatStore, chatId: string | null): ChatState {
  return useSyncExternalStore(store.subscribe, () => (chatId ? store.get(chatId) : EMPTY), () => EMPTY);
}

const NO_EDITS: Record<string, string[]> = {};

/** Who is writing to which document, live. Empty when nothing is being written. */
export function useActiveEdits(store: ChatStore, fileNames: string[]): Record<string, string[]> {
  const key = fileNames.join(' ');
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(() => store.activeEdits(key ? key.split(' ') : []), [store, key]);
  return useSyncExternalStore(subscribe, snapshot, () => NO_EDITS);
}

const NO_CHATS: Readonly<Record<string, ChatMessage[]>> = {};

/**
 * N1: la conversación de VARIOS chats a la vez, por id — lo que el modo Equipo
 * necesita para decir qué hace cada miembro. La referencia es estable
 * mientras ninguno de esos chats cambie, así React no redibuja de más.
 */
export function useChatMessagesOf(store: ChatStore, chatIds: readonly string[]): Readonly<Record<string, ChatMessage[]>> {
  const key = chatIds.join(' ');
  const cache = useRef<{ key: string; value: Record<string, ChatMessage[]> } | null>(null);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const snapshot = useCallback(() => {
    const ids = key ? key.split(' ') : [];
    const previous = cache.current;
    let same = previous !== null && previous.key === key;
    const next: Record<string, ChatMessage[]> = {};
    for (const id of ids) {
      next[id] = store.get(id).messages;
      if (same && previous!.value[id] !== next[id]) same = false;
    }
    if (same) return previous!.value;
    cache.current = { key, value: next };
    return next;
  }, [store, key]);
  return useSyncExternalStore(subscribe, snapshot, () => NO_CHATS);
}
