import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * N4: EL CHAT COMPLETO DEL COORDINADOR TIENE QUE PODER ABRIRSE.
 *
 * Desde que su conversación ES el modo Equipo, el coordinador no tiene
 * pestaña en la tira y su detalle no ofrecía "Conversación". La captura del
 * dueño: el Asistente coordinando y pausado, y ninguna forma de ver su chat
 * entero (herramientas, razonamiento, permisos, preguntas). El hilo del modo
 * Equipo es la conversación, pero no reemplaza al chat completo.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement, useState } = await import('react');
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
const { TeamView } = await import('./TeamView');
import type { TeamPanelProps } from './TeamPanel';
import type { TeamViewProps } from './TeamView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { ChatPermission, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

afterEach(() => cleanup());

const work: Work = { id: 'w1', brandId: 'b1', title: 'Ayulem', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, patch: Partial<TeamMember> = {}): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'paused', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const team = [member('coord', 'Asistente'), member('cm', 'CM')];
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};

const base: Omit<TeamPanelProps, 'selectedId' | 'onSelect'> = {
  work, team, chats: {}, roles: [], primaryLabel: 'Claude', primaryDetail: '', primaryReady: true,
  checking: false, primaryRuntime: 'claude', primaryAccountId: null, primaryModel: null, choices: [], busy: false,
  isDesktop: true, mode: 'simple',
  onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
  coordinationRun: run, formatDate: (v: string) => v,
};

/** El panel con la selección viva, como la maneja App. */
function Harness({ initial, members = team }: { initial: string; members?: TeamMember[] }) {
  const [selectedId, setSelected] = useState<string | null>(initial);
  return createElement(TeamPanel, { ...base, team: members, selectedId, onSelect: setSelected });
}

const tabNames = (c: HTMLElement) => [...c.querySelectorAll('.team-tab-strip .team-tab .team-tab-name')].map((n) => n.textContent);

describe('N4: la conversación del coordinador, desde el modo Equipo', () => {
  it('pausado y sin pestaña; su detalle ofrece "Conversación", que abre su chat con una pestaña transitoria', () => {
    const { container } = render(createElement(Harness, { initial: 'cm' }));
    // La premisa: en la tira no está.
    expect(tabNames(container)).toEqual(['CM']);

    fireEvent.click(container.querySelector('.team-rail-team')!);
    // El hilo abierto por defecto es el suyo, y ofrece su conversación.
    const open = container.querySelector('.coord-detail-chat');
    expect(open).not.toBeNull();
    fireEvent.click(open!);

    // Se abre la columna del chat, con él primero y marcado como coordinador.
    expect(container.querySelector('.team-view')).toBeNull();
    const tabs = [...container.querySelectorAll('.team-tab-strip .team-tab')];
    expect(tabNames(container)).toEqual(['Asistente', 'CM']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.querySelector('.coord-row-coordinator')).not.toBeNull();

    // Volver al modo Equipo la quita.
    fireEvent.click(container.querySelector('.team-rail-team')!);
    expect(container.querySelector('.team-view')).not.toBeNull();
    fireEvent.click(container.querySelector('.team-rail-chat')!);
    expect(tabNames(container)).toEqual(['CM']);
  });

  it('elegir a otro miembro también quita la pestaña transitoria', () => {
    const { container } = render(createElement(Harness, { initial: 'cm' }));
    fireEvent.click(container.querySelector('.team-rail-team')!);
    fireEvent.click(container.querySelector('.coord-detail-chat')!);
    expect(tabNames(container)).toEqual(['Asistente', 'CM']);
    fireEvent.click(container.querySelectorAll('.team-tab-strip .team-tab')[1]!);
    expect(tabNames(container)).toEqual(['CM']);
    expect(container.querySelector('.team-view')).toBeNull();
  });

  it('con el coordinador solo en el equipo, también se llega y se vuelve', () => {
    const { container } = render(createElement(Harness, { initial: 'coord', members: [team[0]!] }));
    expect(container.querySelector('.team-view')).not.toBeNull();
    fireEvent.click(container.querySelector('.coord-detail-chat')!);
    expect(tabNames(container)).toEqual(['Asistente']);
    fireEvent.click(container.querySelector('.team-rail-team')!);
    expect(container.querySelector('.team-view')).not.toBeNull();
  });
});

describe('N4: los permisos del coordinador se ven en su hilo del modo Equipo', () => {
  it('un permiso pendiente se dibuja con la misma tarjeta que en su chat, y cuenta como pendiente', () => {
    const permission = { id: 'perm1', permission: 'Write', title: 'estrategia.md', patterns: ['estrategia.md'], always: [] } as unknown as ChatPermission;
    const props: TeamViewProps = {
      work, team: [member('coord', 'Asistente', { status: 'idle' }), member('cm', 'CM')], roles: [], mode: 'simple', busy: false,
      selectedMemberId: null, onSelectMember: () => {}, coordinationRun: run, teamChatTargetId: 'coord',
      teamChatPermissions: [permission], onError: () => {}, formatTime: (v: string) => v,
    };
    const { container } = render(createElement(TeamView, props));
    const card = container.querySelector('.team-view-thread .chat-card.permission');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('estrategia.md');
    expect(container.querySelector('[data-member-id="coord"] .coord-badge')!.textContent).toBe('1');
  });
});
