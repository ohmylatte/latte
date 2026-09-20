import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE, type AgentRole, type ChatRuntime, type ChatSession, type CoordinationRunStatus, type CoordinationRunView, type HandoffRequest, type TeamMember, type Work, type WorkPermissionMode } from '../shared/contracts';

/**
 * U2: de un equipo vivo SIEMPRE se puede salir.
 *
 * "Cancelar" sólo se renderizaba junto a "Reanudar", o sea únicamente sobre un
 * run `suspended`. Un run `planning` o `running` no tenía ninguna salida: la
 * única forma de cancelar era pausar primero. Y los tres controles vivían
 * adentro del guard `team.length > 0`, así que un Trabajo cuyo equipo todavía
 * no tiene miembros —exactamente el estado de un run `planning`— los perdía
 * enteros.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' };
const roles: AgentRole[] = [{ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Strategist', builtin: false, tier: 'deep' }];
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E',
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const chat: ChatSession = { id: 'm1', workId: 'w1', provider: 'opencode', model: null, accountId: null, label: 'OpenCode', resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: false };

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0, ...patch,
});

function panelProps(team: TeamMember[], mode: LatteMode = 'simple') {
  return {
    work, team, chats: (team.length ? { m1: chat } : {}) as Record<string, ChatSession>, selectedId: team.length ? 'm1' : null, roles,
    primaryLabel: 'OpenCode', primaryDetail: 'Listo', primaryReady: true, checking: false,
    primaryRuntime: 'opencode' as ChatRuntime, primaryAccountId: null, primaryModel: null,
    choices: [] as RuntimeChoice[], busy: false, isDesktop: false,
    onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {},
    onFinish: async () => {}, onRestart: async () => {}, onContinue: async () => {},
    handoffs: [] as HandoffRequest[], onAcceptHandoff: async () => {}, onDismissHandoff: async () => {},
    onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {}, onModel: () => {}, onTier: () => {},
    onError: () => {}, onAttachFiles: async () => [], untracked: [] as string[], onAdoptFile: () => {},
    permissions: 'ask' as WorkPermissionMode, permissionBusy: false, onPermissions: () => {},
    mode,
  };
}

const mount = (patch: Record<string, unknown> = {}, team: TeamMember[] = [member]) =>
  render(<I18nProvider><TeamPanel {...panelProps(team)} {...patch} /></I18nProvider>);

const ACTIVE: CoordinationRunStatus[] = ['planning', 'running', 'suspended'];

describe('siempre hay una salida de un run activo', () => {
  for (const status of ACTIVE) {
    it(`un run \`${status}\` ofrece Cancelar`, () => {
      const { container } = mount({ coordinationRun: run({ status }), onCancelCoordination: () => {} });
      expect(container.querySelector('.team-cancel-coordination')).not.toBeNull();
    });
  }

  it('un run terminado no ofrece Cancelar, ni Pausar, ni Reanudar', () => {
    for (const status of ['done', 'cancelled'] as CoordinationRunStatus[]) {
      const { container } = mount({ coordinationRun: run({ status, active: false }), onCancelCoordination: () => {} });
      expect(container.querySelector('.team-cancel-coordination')).toBeNull();
      expect(container.querySelector('.team-pause-coordination')).toBeNull();
      expect(container.querySelector('.team-resume-coordination')).toBeNull();
    }
  });

  it('Pausar sólo en `running`; Reanudar sólo en `suspended`', () => {
    const running = mount({ coordinationRun: run({ status: 'running' }) });
    expect(running.container.querySelector('.team-pause-coordination')).not.toBeNull();
    expect(running.container.querySelector('.team-resume-coordination')).toBeNull();

    const suspended = mount({ coordinationRun: run({ status: 'suspended' }) });
    expect(suspended.container.querySelector('.team-resume-coordination')).not.toBeNull();
    expect(suspended.container.querySelector('.team-pause-coordination')).toBeNull();

    const planning = mount({ coordinationRun: run({ status: 'planning' }) });
    expect(planning.container.querySelector('.team-pause-coordination')).toBeNull();
    expect(planning.container.querySelector('.team-resume-coordination')).toBeNull();
  });

  it('un run `planning` dice que está planificando: un equipo sin despachos no es un equipo roto', () => {
    const { container } = mount({ coordinationRun: run({ status: 'planning' }) });
    const label = container.querySelector('.team-coordination-status');
    expect(label).not.toBeNull();
    expect(label!.textContent?.toLowerCase()).toContain('planific');
  });

  it('con el equipo VACÍO y un run corriendo, Pausar y Cancelar siguen ahí', () => {
    const onCancelCoordination = vi.fn();
    const { container } = mount({ coordinationRun: run({ status: 'running' }), onCancelCoordination, onPauseCoordination: () => {} }, []);
    expect(container.querySelector('.team-pause-coordination')).not.toBeNull();
    const cancel = container.querySelector('.team-cancel-coordination') as HTMLButtonElement;
    expect(cancel).not.toBeNull();
    fireEvent.click(cancel);
    expect(onCancelCoordination).toHaveBeenCalledWith('run1');
  });

  it('sin run cableado no se renderiza ningún control de coordinación', () => {
    const { container } = mount();
    expect(container.querySelector('.team-coordination-controls')).toBeNull();
    expect(container.querySelector('.team-cancel-coordination')).toBeNull();
  });

  it('Cancelar respeta el flag en vuelo de su propio run', () => {
    const { container } = mount({ coordinationRun: run({ status: 'planning' }), onCancelCoordination: () => {}, pending: { 'run:run1': true } });
    expect((container.querySelector('.team-cancel-coordination') as HTMLButtonElement).disabled).toBe(true);
  });
});
