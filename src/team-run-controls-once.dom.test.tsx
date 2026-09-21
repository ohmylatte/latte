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
 *
 * C1: y en modo Equipo ya no hay contadores. Las dos líneas —"0 listas · 1 en
 * curso · 0 fallidas · 2 sin empezar" y "Despachos: 0 usados · 1 en curso /
 * 10"— eran siete números para decir lo que una barra dice sola. En su lugar
 * hay UN encabezado con el título del pedido, la barra y el presupuesto en una
 * pastilla; los botones del run pasaron a ser sólo ícono, cada uno nombrado.
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
    mode, coordinationRun: run, formatTime: (value: string) => value,
  };
}

const mount = () => render(<I18nProvider><TeamPanel {...panelProps()} /></I18nProvider>);
const openTeam = (container: HTMLElement) => { fireEvent.click(container.querySelector('.team-rail-team')!); };

describe('B5.4 + C1: el estado del run se dibuja una sola vez', () => {
  /**
   * C7: en modo conversación no hay NI controles NI encabezado. Las dos líneas
   * de contadores eran el depósito de texto que el rediseño saca, y el
   * encabezado del pedido vive donde está el equipo, a un segmento de acá.
   */
  it('en modo conversación no hay ni contadores ni encabezado del run', () => {
    const { container } = mount();
    expect(container.querySelectorAll('.team-coordination-controls')).toHaveLength(0);
    expect(container.querySelectorAll('.coord-head')).toHaveLength(0);
    expect(container.querySelector('.team-rail-modes')).not.toBeNull();
  });

  it('en modo Equipo hay un encabezado, ningún contador viejo y una sola salida', () => {
    const { container } = mount();
    openTeam(container);

    expect(container.querySelectorAll('.team-coordination-controls')).toHaveLength(0);
    const heads = container.querySelectorAll('.coord-head');
    expect(heads).toHaveLength(1);
    expect(container.querySelector('.team-view')!.contains(heads[0]!)).toBe(true);
    expect(container.querySelector('.team-rail-head')!.contains(heads[0]!)).toBe(false);
    expect(container.querySelectorAll('.team-cancel-coordination')).toHaveLength(1);
  });

  /** Criterio 5: el avance es una BARRA, y hay exactamente una. */
  it('el avance es una barra, no una frase con cuatro contadores', () => {
    const { container } = mount();
    openTeam(container);
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(1);
    // Tres tareas: 0 listas, 1 en curso, 2 sin empezar.
    expect(bars[0]!.getAttribute('aria-valuemax')).toBe('3');
    expect(bars[0]!.getAttribute('aria-valuenow')).toBe('0');
    expect(container.querySelector('.coord-progress-done')!.textContent).toContain('3');
    expect(container.textContent).not.toContain('sin empezar');
    expect(container.textContent).not.toContain('fallidas');
  });

  /** El encabezado nombra el pedido y a quién lo coordina, en una línea. */
  it('el encabezado dice el pedido y quién coordina', () => {
    const { container } = mount();
    openTeam(container);
    expect(container.querySelector('.coord-head-name')!.textContent).toBe('Trabajo');
    expect(container.querySelector('.coord-head-sub')!.textContent).toContain('Estratega');
  });

  /** Criterio 4 del presupuesto de palabras: un botón sólo-ícono siempre se nombra. */
  it('los botones del run son sólo ícono, y cada uno se nombra', () => {
    const { container } = mount();
    openTeam(container);
    for (const selector of ['.team-cancel-coordination', '.team-pause-coordination']) {
      const button = container.querySelector(selector);
      expect(button, selector + ' no está').not.toBeNull();
      expect(button!.textContent).toBe('');
      expect(button!.getAttribute('aria-label')).toBeTruthy();
      expect(button!.getAttribute('title')).toBeTruthy();
    }
  });
});
