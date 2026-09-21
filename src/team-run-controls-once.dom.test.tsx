import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE, type AgentRole, type ChatRuntime, type ChatSession, type CoordinationRunView, type HandoffRequest, type TeamMember, type Work, type WorkPermissionMode } from '../shared/contracts';

/**
 * B5.4: UN SOLO CONTROL DEL RUN.
 *
 * `TeamPanel` dibujaba `CoordinationRunControls` en su cabecera y `TeamView`
 * lo dibujaba otra vez arriba de sus columnas. En modo Equipo la persona veía
 * las cuentas, el presupuesto y los botones de pausar/reanudar/cancelar DOS
 * veces, uno encima del otro — dos "Cancelar equipo" para el mismo run.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' };
const roles: AgentRole[] = [{ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Strategist', builtin: false, tier: 'deep' }];
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E',
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const chat: ChatSession = { id: 'm1', workId: 'w1', provider: 'opencode', model: null, accountId: null, label: 'OpenCode', resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: false };

const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 1, tasksPending: 2,
};

function panelProps(mode: LatteMode = 'simple') {
  return {
    work, team: [member], chats: { m1: chat } as Record<string, ChatSession>, selectedId: 'm1', roles,
    primaryLabel: 'OpenCode', primaryDetail: 'Listo', primaryReady: true, checking: false,
    primaryRuntime: 'opencode' as ChatRuntime, primaryAccountId: null, primaryModel: null,
    choices: [] as RuntimeChoice[], busy: false, isDesktop: false,
    onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {},
    onFinish: async () => {}, onRestart: async () => {}, onContinue: async () => {},
    handoffs: [] as HandoffRequest[], onAcceptHandoff: async () => {}, onDismissHandoff: async () => {},
    onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {}, onModel: () => {}, onTier: () => {},
    onError: () => {}, onAttachFiles: async () => [], untracked: [] as string[], onAdoptFile: () => {},
    permissions: 'ask' as WorkPermissionMode, permissionBusy: false, onPermissions: () => {},
    mode, coordinationRun: run,
  };
}

const mount = () => render(<I18nProvider><TeamPanel {...panelProps()} /></I18nProvider>);

describe('B5.4: los controles del run se dibujan una sola vez', () => {
  it('en modo conversación hay exactamente uno', () => {
    const { container } = mount();
    expect(container.querySelectorAll('.team-coordination-controls')).toHaveLength(1);
  });

  it('en modo Equipo sigue habiendo exactamente uno, y es el de TeamView', () => {
    const { container } = mount();
    fireEvent.click(container.querySelector('.team-rail-team')!);

    const controls = container.querySelectorAll('.team-coordination-controls');
    expect(controls).toHaveLength(1);
    // El que queda es el de `TeamView`: vive adentro de la vista, no en la
    // cabecera del riel.
    expect(container.querySelector('.team-view')!.contains(controls[0])).toBe(true);
    expect(container.querySelector('.team-rail-head')!.contains(controls[0])).toBe(false);
    // Y una sola salida del run, no dos.
    expect(container.querySelectorAll('.team-cancel-coordination')).toHaveLength(1);
  });
});
