import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE, type AgentRole, type ChatRuntime, type ChatSession, type CoordinationRunView, type HandoffRequest, type TeamMember, type Work, type WorkPermissionMode } from '../shared/contracts';

/**
 * "Pausar equipo" mid-dispatch (autonomous-coordination Phase 7 task 7.7):
 * `pauseCoordinationRun` already exists (Phase 3) — this is UI only. Additive,
 * optional props (`coordinationRun?`, `onPauseCoordination?`), gated so an
 * unwired caller (App.tsx does not pass them yet — that is task 7.11) sees
 * zero change, exactly the pattern Phase 2 used for `DecisionsView`.
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
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z', ...patch,
});

function panelProps(mode: LatteMode = 'simple') {
  return {
    work, team: [member], chats: { m1: chat }, selectedId: 'm1', roles,
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

const mount = (patch: Record<string, unknown> = {}) => render(<I18nProvider><TeamPanel {...panelProps()} {...patch} /></I18nProvider>);

describe('"Pausar equipo" (additive, autonomous-coordination Phase 7 task 7.7)', () => {
  it('does not render when the caller has not wired coordination state', () => {
    const { container } = mount();
    expect(container.querySelector('.team-pause-coordination')).toBeNull();
  });

  it('does not render when there is no active run', () => {
    const { container } = mount({ coordinationRun: null });
    expect(container.querySelector('.team-pause-coordination')).toBeNull();
  });

  it('does not render once the run is no longer running (already paused, done, etc.)', () => {
    const { container } = mount({ coordinationRun: run({ status: 'suspended' }) });
    expect(container.querySelector('.team-pause-coordination')).toBeNull();
  });

  it('renders "Pausar equipo" for a running coordination run and calls onPauseCoordination with the run id', () => {
    const onPauseCoordination = vi.fn();
    const { container } = mount({ coordinationRun: run({ id: 'run-xyz', status: 'running' }), onPauseCoordination });
    const button = container.querySelector('.team-pause-coordination') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Pausar equipo');
    fireEvent.click(button);
    expect(onPauseCoordination).toHaveBeenCalledWith('run-xyz');
  });

  // Un run terminado no puede PARECER vivo: ni acciones de run vivo, ni
  // silencio. Se dice cómo terminó.
  it('un run TERMINADO no ofrece ninguna acción de run vivo, y dice su estado final', () => {
    const { container } = mount({
      coordinationRun: run({ status: 'done', active: false }),
      onPauseCoordination: vi.fn(), onResumeCoordination: vi.fn(), onCancelCoordination: vi.fn(),
    });
    expect(container.querySelector('.team-pause-coordination')).toBeNull();
    expect(container.querySelector('.team-resume-coordination')).toBeNull();
    expect(container.querySelector('.team-cancel-coordination')).toBeNull();
    const finished = container.querySelector('.team-finished-coordination');
    expect(finished).not.toBeNull();
    expect(finished!.textContent).toContain('Terminado');
  });

  it('un run CANCELADO se dice cancelado, no terminado', () => {
    const { container } = mount({ coordinationRun: run({ status: 'cancelled', active: false }), onCancelCoordination: vi.fn() });
    expect(container.querySelector('.team-cancel-coordination')).toBeNull();
    expect(container.querySelector('.team-finished-coordination')!.textContent).toContain('Cancelado');
  });

  // Un run SUSPENDIDO sigue vivo: reanudar y cancelar tienen que estar.
  it('un run suspendido sigue siendo un run vivo: conserva sus acciones y no se anuncia terminado', () => {
    const { container } = mount({ coordinationRun: run({ status: 'suspended' }), onResumeCoordination: vi.fn(), onCancelCoordination: vi.fn() });
    expect(container.querySelector('.team-resume-coordination')).not.toBeNull();
    expect(container.querySelector('.team-finished-coordination')).toBeNull();
  });

  it('renders the same control in English, with nothing left in Spanish', async () => {
    localStorage.setItem('latte-ui-locale', 'en-US');
    const { container } = render(<I18nProvider><TeamPanel {...panelProps()} coordinationRun={run()} /></I18nProvider>);
    await waitFor(() => expect(container.querySelector('.team-pause-coordination')?.textContent).toContain('Pause team'));
    localStorage.removeItem('latte-ui-locale');
  });
});
