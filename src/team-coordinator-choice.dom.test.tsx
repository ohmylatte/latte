import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * ELEGIR QUIÉN COORDINA, DESDE EL MODO EQUIPO.
 *
 * Lo que pasó en uso real (dueño, 2026-09-24): quitó a todos, convocó a uno que
 * quedó como destinatario, convocó al anterior coordinador "sólo por su rol" y
 * la coordinación se fue con él. La cadena (run → permiso del trabajo →
 * Asistente → primero) decidía sola, y ninguna pantalla escribía el permiso:
 * no había forma de decir "coordina ÉSTE".
 *
 * Ahora el detalle de cada miembro ofrece "Que coordine". Elegir escribe el
 * permiso del trabajo; desde ese momento la fila marcada y el destinatario del
 * composer son el elegido. Con un run ACTIVO no se puede: manda el coordinador
 * del run, y el botón lo dice.
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
vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  const { createChatStore } = await import('./chat-store');
  const api = { ...actual.api, sendChat: mocks.sendChat, listChatMessages: mocks.listChatMessages };
  return { ...actual, api, chatStore: createChatStore(api as unknown as typeof actual.api) };
});

const { createElement, useState } = await import('react');
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('asis', 'Asistente', 'assistant'), member('cm', 'CM')];
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'asis',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

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

/** El contenedor de verdad guarda el permiso en `useCoordination`; acá, en un `useState`, que es lo mismo visto desde el panel. */
function Harness(props: Partial<TeamPanelProps> & { onChosen?: (memberId: string) => void }) {
  const [grant, setGrant] = useState<string | null>(null);
  const { onChosen, ...rest } = props;
  return createElement(TeamPanel, {
    ...basePanel, formatTime: (v: string) => v, formatDate: (v: string) => v,
    coordinatorGrant: grant,
    onSetCoordinator: (memberId: string) => { onChosen?.(memberId); setGrant(memberId); },
    ...rest,
  });
}

const toTeam = (c: HTMLElement) => { const b = c.querySelector('.team-rail-team'); if (b) fireEvent.click(b); };
const rowOf = (c: HTMLElement, id: string) => c.querySelector(`.team-inbox-row[data-member-id="${id}"]`) as HTMLElement;
const openRow = (c: HTMLElement, id: string) => fireEvent.click(rowOf(c, id).querySelector('button')!);
const coordinateButton = (c: HTMLElement) => c.querySelector('.coord-detail .coord-detail-coordinate') as HTMLButtonElement | null;

describe('elegir quién coordina un trabajo', () => {
  it('"Que coordine" escribe el permiso: la fila marcada y el destinatario del composer pasan a ser el elegido', async () => {
    ui.locale = 'es-AR';
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const chosen = vi.fn();
    const { container } = render(createElement(Harness, { onChosen: chosen }));
    toTeam(container);
    // Sin permiso nadie está marcado: el Asistente sólo recibe por descarte.
    expect(container.querySelector('.coord-row-coordinator')).toBeNull();
    openRow(container, 'cm');
    const button = coordinateButton(container)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('Que coordine');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(chosen).toHaveBeenCalledWith('cm');

    expect(rowOf(container, 'cm').querySelector('.coord-row-coordinator')).not.toBeNull();
    expect(rowOf(container, 'asis').querySelector('.coord-row-coordinator')).toBeNull();
    // En su detalle, el mismo botón dice lo que ya es, y no se puede volver a apretar.
    const current = coordinateButton(container)!;
    expect(current.textContent).toBe('Coordina');
    expect(current.disabled).toBe(true);

    fireEvent.change(container.querySelector('.team-view .prompt-form textarea')!, { target: { value: 'armá el calendario' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalled());
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('cm');
    cleanup();
  });

  it('con un run ACTIVO el botón está deshabilitado y dice por qué', () => {
    ui.locale = 'es-AR';
    const chosen = vi.fn();
    const { container } = render(createElement(Harness, { onChosen: chosen, coordinationRun: run() }));
    toTeam(container);
    openRow(container, 'cm');
    const button = coordinateButton(container)!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Termina el run para cambiar quién coordina');
    fireEvent.click(button);
    expect(chosen).not.toHaveBeenCalled();
    cleanup();
  });

  it('en inglés', () => {
    ui.locale = 'en-US';
    const { container } = render(createElement(Harness, { coordinationRun: run() }));
    toTeam(container);
    openRow(container, 'cm');
    const button = coordinateButton(container)!;
    expect(button.textContent).toBe('Make coordinator');
    expect(button.title).toBe('End the run to change who coordinates');
    cleanup();
    ui.locale = 'es-AR';
  });

  it('convocar a alguien (el Asistente incluido) no cambia la fila marcada ni el destinatario del composer', async () => {
    ui.locale = 'es-AR';
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const fixed = { ...member('cm', 'CM'), coordinates: true };
    const { container, rerender } = render(createElement(TeamPanel, { ...basePanel, team: [fixed], formatTime: (v: string) => v, formatDate: (v: string) => v }));
    // Llega el Asistente: el permiso del trabajo ya estaba fijado en CM.
    rerender(createElement(TeamPanel, { ...basePanel, team: [fixed, member('asis', 'Asistente', 'assistant')], formatTime: (v: string) => v, formatDate: (v: string) => v }));
    toTeam(container);
    expect(rowOf(container, 'cm').querySelector('.coord-row-coordinator')).not.toBeNull();
    expect(rowOf(container, 'asis').querySelector('.coord-row-coordinator')).toBeNull();
    fireEvent.change(container.querySelector('.team-view .prompt-form textarea')!, { target: { value: 'hola' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalled());
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('cm');
    cleanup();
  });

  it('el coordinador fijado del trabajo llega marcado en su miembro; elegir a otro le gana', async () => {
    ui.locale = 'es-AR';
    mocks.sendChat.mockReset();
    mocks.sendChat.mockResolvedValue(undefined);
    const habitual = [member('asis', 'Asistente', 'assistant'), { ...member('cm', 'CM'), coordinates: true }];
    const { container } = render(createElement(Harness, { team: habitual }));
    toTeam(container);
    expect(rowOf(container, 'cm').querySelector('.coord-row-coordinator')).not.toBeNull();
    fireEvent.change(container.querySelector('.team-view .prompt-form textarea')!, { target: { value: 'hola' } });
    fireEvent.submit(container.querySelector('.team-view .prompt-form')!);
    await waitFor(() => expect(mocks.sendChat).toHaveBeenCalled());
    expect(mocks.sendChat.mock.calls[0]![0]).toBe('cm');

    openRow(container, 'asis');
    fireEvent.click(coordinateButton(container)!);
    expect(rowOf(container, 'asis').querySelector('.coord-row-coordinator')).not.toBeNull();
    expect(rowOf(container, 'cm').querySelector('.coord-row-coordinator')).toBeNull();
    cleanup();
  });

  it('sin handler no se ofrece un botón que no escribe nada', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(TeamPanel, { ...basePanel, formatTime: (v: string) => v, formatDate: (v: string) => v }));
    toTeam(container);
    openRow(container, 'cm');
    expect(container.querySelector('.coord-detail')).not.toBeNull();
    expect(coordinateButton(container)).toBeNull();
    cleanup();
  });
});
