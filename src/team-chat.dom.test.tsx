import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * EL CHAT DE EQUIPO ES EL MODO EQUIPO, CON UN CUADRO DE TEXTO ABAJO.
 *
 * No habia dos pantallas duplicadas: habia un composer del lado equivocado. El
 * unico campo de texto de la app vivia en `ChatPane`, o sea que se miraba el
 * equipo en un lado y se escribia en el otro, a una pestana que competia con
 * las de los demas. De ahi "todo ocurre no se donde".
 *
 * Tres hechos, y ninguno inventa una pantalla nueva:
 * - El composer va al pie del modo Equipo, y lo que se escribe ahi va al
 *   coordinador. No existe "a todos": el coordinador ES el "a todos" — le pedis
 *   al equipo, el despacha. Hablarle a UNO sigue siendo su hilo.
 * - La linea de tiempo se vuelve conversacion: los mensajes de la persona y las
 *   respuestas del coordinador se intercalan POR HORA con despachos, reportes,
 *   preguntas y altas. Nada se saca.
 * - La pestana del coordinador sale de la tira: el rail deja de ser
 *   "conversacion vs equipo" y pasa a ser "uno vs el equipo".
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const mocks = vi.hoisted(() => ({
  sendChat: vi.fn<(chatId: string, text: string) => Promise<void>>(),
  listChatMessages: vi.fn<(chatId: string) => Promise<unknown[]>>(async () => []),
}));
/**
 * El store se rearma sobre la api doblada, no se hereda del modulo real: se
 * construye UNA vez al cargar `browser-api`, asi que un `chatStore` heredado
 * seguiria pidiendole el transcripto a la api de verdad y este archivo no
 * estaria probando el camino que dice probar.
 */
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const { createChatStore } = await import('./chat-store');
  const api = { ...actual.api, sendChat: mocks.sendChat, listChatMessages: mocks.listChatMessages };
  return { ...actual, api, chatStore: createChatStore(api as unknown as typeof actual.api) };
});

const { createElement } = await import('react');
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
const { TeamView } = await import('./TeamView');
const { chatStore } = await import('./browser-api');
import { formatMessage } from './i18n';
import type { TeamPanelProps } from './TeamPanel';
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type {
  ChatMessage, ChatSession, CoordinationLogEntryView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador', 'assistant'), member('cm', 'CM')];
const chat = (id: string): ChatSession => ({
  id, workId: 'w1', provider: 'claude', model: null, accountId: null, label: 'Claude',
  resumed: false, roleId: 'assistant', roleName: 'Coordinador', historyRecovered: true,
});

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const dispatchRow = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'coord', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir 3 posts', summaryPreview: 'Quedaron los 3 posts',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', settledAt: '2026-09-01T12:00:00.000Z', ...patch,
});

const chatMessage = (id: string, role: 'user' | 'assistant', text: string, createdAt: string): ChatMessage =>
  ({ id, chatId: 'coord', role, parts: [{ id: id + 'p', type: 'text', text }], createdAt, completed: true, error: null });

const basePanel: TeamPanelProps = {
  work, team, chats: { coord: chat('coord'), cm: chat('cm') }, selectedId: 'cm', roles: [],
  primaryLabel: 'Claude', primaryDetail: '', primaryReady: true, checking: false, primaryRuntime: 'claude',
  primaryAccountId: null, primaryModel: null, choices: [], busy: false, isDesktop: true, mode: 'simple',
  onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
};

const mountPanel = (props: Partial<TeamPanelProps> = {}) =>
  render(createElement(TeamPanel, { ...basePanel, formatDate: (v: string) => v, coordinationRun: run(), ...props }));

const baseView: TeamViewProps = {
  work, team, roles: [], mode: 'simple', busy: false, selectedMemberId: null, onSelectMember: () => {},
  coordinationRun: run(),
};
const mountView = (props: Partial<TeamViewProps> = {}) =>
  render(createElement(TeamView, { ...baseView, formatTime: (v: string) => v, ...props }));

const toTeam = (c: HTMLElement) => { const b = c.querySelector('.team-rail-team'); if (b) fireEvent.click(b); };
const composerOf = (c: HTMLElement) => c.querySelector('.team-view .prompt-form textarea') as HTMLTextAreaElement | null;

describe('el composer del modo Equipo', () => {
  it('existe al pie del modo Equipo', () => {
    const { container } = mountPanel();
    toTeam(container);
    expect(composerOf(container)).not.toBeNull();
  });

  /** Un mensaje al equipo es un mensaje al coordinador. No hay destinatario que elegir. */
  it('manda a la sesion del COORDINADOR, no al miembro abierto en el chat', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const { container } = mountPanel({ selectedId: 'cm' });
    toTeam(container);
    const textarea = composerOf(container)!;
    fireEvent.change(textarea, { target: { value: 'armame el calendario de octubre' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledTimes(1));
    expect(mocks.sendChat.mock.calls[0]).toEqual(['coord', 'armame el calendario de octubre']);
    chatStore.forget('coord');
  });

  /**
   * Sin run activo no hay coordinador designado: el mensaje va al Asistente,
   * que es el rol que siempre esta y el unico que puede pedir coordinacion.
   */
  it('sin run, el destinatario es el Asistente', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const { container } = mountPanel({ coordinationRun: null, selectedId: 'cm' });
    toTeam(container);
    fireEvent.change(composerOf(container)!, { target: { value: 'hola equipo' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledTimes(1));
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('coord');
    chatStore.forget('coord');
  });

  /** El coordinador puede estar pausado —cerrar un run lo apaga—: escribirle lo despierta. */
  it('despierta al coordinador antes de mandarle, cuando no tiene sesion viva', async () => {
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const onOpen = vi.fn(async () => {});
    const { container } = mountPanel({ chats: { cm: chat('cm') }, onOpen });
    toTeam(container);
    fireEvent.change(composerOf(container)!, { target: { value: 'seguimos' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalledTimes(1));
    expect(onOpen).toHaveBeenCalledWith('coord');
    chatStore.forget('coord');
  });
});

describe('una sola lista: la conversacion del coordinador vive en la linea de tiempo', () => {
  it('los mensajes de la persona y las respuestas del coordinador se intercalan por hora', () => {
    const { container } = mountView({
      selectedMemberId: 'coord',
      coordinationLog: [dispatchRow()],
      coordinatorChat: [
        chatMessage('c1', 'user', 'armame el calendario', '2026-09-01T09:00:00.000Z'),
        chatMessage('c2', 'assistant', 'lo reparto en tres tareas', '2026-09-01T11:00:00.000Z'),
      ],
    });
    const kinds = [...container.querySelectorAll('.coord-timeline .coord-event')].map((li) => li.getAttribute('data-kind'));
    // Descendente: lo ultimo arriba. Por hora: 09 pedido, 10 despacho, 11
    // respuesta, 12 reporte. Nada se saca y nada se agrupa aparte.
    expect(kinds).toEqual(['reported', 'replied', 'dispatched', 'said']);
    expect(container.textContent).toContain('armame el calendario');
    expect(container.textContent).toContain('lo reparto en tres tareas');
  });

  it('el hilo de OTRO miembro no se lleva la conversacion del coordinador', () => {
    const { container } = mountView({
      selectedMemberId: 'cm',
      coordinatorChat: [chatMessage('c1', 'user', 'armame el calendario', '2026-09-01T09:00:00.000Z')],
    });
    expect(container.textContent).not.toContain('armame el calendario');
  });

  /**
   * N4: el hilo del coordinador ES su conversacion, pero no su chat COMPLETO
   * (herramientas, razonamiento, permisos). Antes no ofrecia "Conversacion" y
   * con el coordinador pausado su chat no aparecia en ninguna parte: ahora lo
   * ofrece, igual que el de cualquier otro miembro.
   */
  it('el hilo del coordinador tambien ofrece "Conversacion", como el de otro miembro', () => {
    const onOpenChat = vi.fn();
    const own = mountView({ selectedMemberId: 'coord', onOpenChat });
    fireEvent.click(own.container.querySelector('.coord-detail-chat')!);
    expect(onOpenChat).toHaveBeenCalledWith('coord');
    cleanup();
    const other = mountView({ selectedMemberId: 'cm', onOpenChat: () => {} });
    expect(other.container.querySelector('.coord-detail-chat')).not.toBeNull();
  });
});

describe('la tira de miembros es "uno", no "el equipo"', () => {
  it('el coordinador no tiene pestana en la tira', () => {
    const { container } = mountPanel({ selectedId: 'cm' });
    const ids = [...container.querySelectorAll('.team-tab-strip .team-tab-name')].map((n) => n.textContent);
    expect(ids).toEqual(['CM']);
    expect(ids).not.toContain('Coordinador');
  });

  /** Elegir al coordinador por cualquier camino —Inicio, la tira de equipos— aterriza en el modo Equipo. */
  it('abrir al coordinador aterriza en el modo Equipo, con su hilo abierto', () => {
    const { container } = mountPanel({ selectedId: 'coord' });
    expect(container.querySelector('.team-view')).not.toBeNull();
    expect(container.querySelector('.team-tab-strip')).toBeNull();
    expect(container.querySelector('.team-inbox-row.is-selected')!.getAttribute('data-member-id')).toBe('coord');
  });

  /** Y un miembro que no coordina sigue teniendo su chat, igual que siempre. */
  it('un miembro no coordinador sigue abriendo su conversacion', () => {
    const { container } = mountPanel({ selectedId: 'cm' });
    expect(container.querySelector('.chat-pane')).not.toBeNull();
    expect(container.querySelector('.team-view')).toBeNull();
  });

  /** Volver a "Conversacion" desde el coordinador elige a alguien con quien hablar. */
  it('con el coordinador abierto, "Conversacion" elige al primer miembro que si tiene pestana', () => {
    const onSelect = vi.fn();
    const { container } = mountPanel({ selectedId: 'coord', onSelect });
    fireEvent.click(container.querySelector('.team-rail-chat')!);
    expect(onSelect).toHaveBeenCalledWith('cm');
  });

  /** Con el coordinador como unico miembro no hay "uno" con quien hablar: el modo Equipo ES la pantalla. */
  it('si el coordinador es el unico miembro, no se ofrece el toggle y manda el modo Equipo', () => {
    const { container } = mountPanel({ team: [team[0]!], selectedId: null });
    expect(container.querySelector('.team-rail-modes')).toBeNull();
    expect(container.querySelector('.team-view')).not.toBeNull();
  });
});

describe('las tarjetas del equipo salen donde ahora vive la conversacion', () => {
  it('la aprobacion que le toca al coordinador se dibuja en el modo Equipo', () => {
    const gates = [{ id: 'g1', kind: 'proposal' as const, runId: 'run1', createdAt: '2026-09-01T10:00:00.000Z', proposalJson: JSON.stringify({ tasks: [] }) }];
    const { container } = mountPanel({
      selectedId: 'cm',
      coordinationGates: gates,
      chatCoordination: { coordinationRun: run(), gates, team, roles: [], onResolveGate: () => {} },
    });
    toTeam(container);
    expect(container.querySelector('.team-view .team-cards-collapsed')).not.toBeNull();
  });
});

describe('el copy del chat de equipo, en los dos idiomas', () => {
  it('el composer se nombra igual que el del chat de miembro', () => {
    ui.locale = 'en-US';
    const { container } = mountPanel();
    toTeam(container);
    expect(composerOf(container)!.getAttribute('aria-label')).toBe(formatMessage('en-US', 'ui.auto.019'));
    ui.locale = 'es-AR';
  });
});

/**
 * EL RUN TERMINO Y LA CHARLA NO ESTABA.
 *
 * Cerrar un run apaga al coordinador, y pausar a un miembro hace
 * `chatStore.forget`: el renderer se queda sin una sola linea de su
 * conversacion. Mientras su chat era una pestana mas eso se arreglaba solo
 * (se abria la pestana y `openMember` sincronizaba el transcripto). Desde que
 * su conversacion ES el modo Equipo, el mismo olvido deja un vacio que MIENTE:
 * el equipo termino y lo que se hablo no esta en ningun lado.
 *
 * El modo Equipo pide el transcripto al entrar, y sin levantarle el proceso a
 * nadie: `listChatMessages` contesta con lo que Latte guarda cuando no hay
 * adaptador vivo. Se pide solo cuando NO hay sesion viva -- con una abierta el
 * store ya viene alimentado por eventos, y re-sincronizar encima de un turno
 * en vuelo le pisaria el mensaje que se esta escribiendo.
 */
describe('un run terminado no se lleva la conversacion del coordinador', () => {
  it('con el coordinador pausado, la lista igual muestra lo que se hablo', async () => {
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockImplementation(async (chatId: string) => (chatId === 'coord'
      ? [chatMessage('c1', 'user', 'armame el calendario', '2026-09-01T09:00:00.000Z'),
        chatMessage('c2', 'assistant', 'listo, quedaron cuatro tareas', '2026-09-01T11:00:00.000Z')]
      : []));
    // Sin sesion viva: es exactamente lo que `dropChat` deja despues de pausar.
    const { container } = mountPanel({
      chats: {}, selectedId: 'coord',
      coordinationRun: run({ status: 'done', active: false, tasksDone: 4, tasksFailed: 0 }),
      team: [{ ...team[0]!, status: 'paused' }, team[1]!],
    });
    await waitFor(() => expect(mocks.listChatMessages).toHaveBeenCalledWith('coord'));
    await waitFor(() => expect(container.textContent).toContain('listo, quedaron cuatro tareas'));
    expect(container.textContent).toContain('armame el calendario');
    chatStore.forget('coord');
  });

  /** Con la sesion viva no se pide nada: el store ya lo tiene, por eventos. */
  it('con sesion viva no vuelve a pedir el transcripto', async () => {
    mocks.listChatMessages.mockReset();
    mocks.listChatMessages.mockResolvedValue([]);
    const { container } = mountPanel({ selectedId: 'coord' });
    expect(container.querySelector('.team-view')).not.toBeNull();
    await Promise.resolve();
    expect(mocks.listChatMessages).not.toHaveBeenCalledWith('coord');
  });
});
