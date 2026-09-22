import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE, type AgentRole, type ChatRuntime, type ChatSession, type CoordinationRunView, type HandoffRequest, type TeamMember, type Work, type WorkPermissionMode } from '../shared/contracts';

/**
 * B4.1: DURANTE UNA COORDINACIÓN, LA PERSONA NO QUEDA EN EL MEDIO.
 *
 * La prueba real: con un run vivo, el coordinador dejó un archivo de traspaso
 * (`para: community-manager`) para adelantarle trabajo a una tarea que todavía
 * no podía despachar. Latte mostró el aviso y, al aceptarlo, PRELLENÓ el
 * borrador del chat del CM esperando que la PERSONA apretara enviar. Desde
 * afuera eso se lee como "despachó y nadie arrancó nada".
 *
 * Con un run activo la acción primaria ya no prellena nada: crea la tarea y la
 * despacha con la autoridad del run (`acceptHandoffAsTask`, que ya existía de
 * punta a punta). Sin run activo el camino de siempre se conserva.
 */

const work: Work = { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', folder: null, updatedAt: '' };
const roles: AgentRole[] = [{ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Strategist', builtin: false, tier: 'deep', avatar: null }];
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null,
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const chat: ChatSession = { id: 'm1', workId: 'w1', provider: 'opencode', model: null, accountId: null, label: 'OpenCode', resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: false };

const handoff: HandoffRequest = {
  fileName: 'piezas-para-produccion-cm.md', roleId: 'community-manager', roleName: 'Community Manager',
  request: 'Adelantá las piezas de producción', known: true,
};

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 2, ...patch,
});

function panelProps(mode: LatteMode = 'simple') {
  return {
    work, team: [member], chats: { m1: chat } as Record<string, ChatSession>, selectedId: 'm1', roles,
    primaryLabel: 'OpenCode', primaryDetail: 'Listo', primaryReady: true, checking: false,
    primaryRuntime: 'opencode' as ChatRuntime, primaryAccountId: null, primaryModel: null,
    choices: [] as RuntimeChoice[], busy: false, isDesktop: false,
    onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {},
    onFinish: async () => {}, onRestart: async () => {}, onContinue: async () => {},
    handoffs: [handoff], onDismissHandoff: async () => {},
    onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {}, onModel: () => {}, onTier: () => {},
    onError: () => {}, onAttachFiles: async () => [], untracked: [] as string[], onAdoptFile: () => {},
    permissions: 'ask' as WorkPermissionMode, permissionBusy: false, onPermissions: () => {},
    mode,
  };
}

/** El botón primario del aviso de traspaso. */
function acceptButton(container: HTMLElement): HTMLButtonElement {
  const banner = container.querySelector('.doc-banner.handoff');
  expect(banner, 'el aviso de traspaso no se dibujó').not.toBeNull();
  const button = banner!.querySelector<HTMLButtonElement>('button.primary');
  expect(button, 'el aviso no ofrece ninguna acción primaria').not.toBeNull();
  return button!;
}

describe('B4.1: el traspaso durante un run no pasa por el borrador de la persona', () => {
  it('con un run activo, la acción primaria despacha como tarea del equipo', () => {
    const onAcceptHandoff = vi.fn(async (_handoff: HandoffRequest) => {});
    const onAcceptHandoffAsTask = vi.fn(async (_handoff: HandoffRequest) => {});
    const { container } = render(<I18nProvider><TeamPanel {...panelProps()}
      onAcceptHandoff={onAcceptHandoff} onAcceptHandoffAsTask={onAcceptHandoffAsTask}
      coordinationRun={run()} /></I18nProvider>);
    const button = acceptButton(container);
    // La copy tiene que decir lo que va a pasar: una tarea del equipo, no un borrador.
    expect(button.textContent).toContain('tarea');
    fireEvent.click(button);
    expect(onAcceptHandoffAsTask).toHaveBeenCalledTimes(1);
    expect(onAcceptHandoffAsTask.mock.calls[0]![0]).toEqual(handoff);
    // Y NUNCA el camino que prellena el borrador del otro miembro.
    expect(onAcceptHandoff).not.toHaveBeenCalled();
  });

  it('sin run activo, el camino de siempre se conserva: el borrador', () => {
    const onAcceptHandoff = vi.fn(async (_handoff: HandoffRequest) => {});
    const onAcceptHandoffAsTask = vi.fn(async (_handoff: HandoffRequest) => {});
    const { container } = render(<I18nProvider><TeamPanel {...panelProps()}
      onAcceptHandoff={onAcceptHandoff} onAcceptHandoffAsTask={onAcceptHandoffAsTask}
      coordinationRun={null} /></I18nProvider>);
    fireEvent.click(acceptButton(container));
    expect(onAcceptHandoff).toHaveBeenCalledTimes(1);
    expect(onAcceptHandoffAsTask).not.toHaveBeenCalled();
  });

  /** Un run que ya cerró no es un run: su traspaso vuelve al borrador. */
  it('un run terminado no despacha nada: vuelve al borrador', () => {
    const onAcceptHandoff = vi.fn(async (_handoff: HandoffRequest) => {});
    const onAcceptHandoffAsTask = vi.fn(async (_handoff: HandoffRequest) => {});
    const { container } = render(<I18nProvider><TeamPanel {...panelProps()}
      onAcceptHandoff={onAcceptHandoff} onAcceptHandoffAsTask={onAcceptHandoffAsTask}
      coordinationRun={run({ status: 'done', active: false })} /></I18nProvider>);
    fireEvent.click(acceptButton(container));
    expect(onAcceptHandoff).toHaveBeenCalledTimes(1);
    expect(onAcceptHandoffAsTask).not.toHaveBeenCalled();
  });

  /** Sin el puente cableado no se promete un despacho que nadie puede hacer. */
  it('sin `onAcceptHandoffAsTask`, ni con run activo se ofrece despachar', () => {
    const onAcceptHandoff = vi.fn(async (_handoff: HandoffRequest) => {});
    const { container } = render(<I18nProvider><TeamPanel {...panelProps()}
      onAcceptHandoff={onAcceptHandoff} coordinationRun={run()} /></I18nProvider>);
    fireEvent.click(acceptButton(container));
    expect(onAcceptHandoff).toHaveBeenCalledTimes(1);
  });

  /**
   * El botón llama a la prop; la prop la cablea `App`. Sin este candado el
   * panel podía quedar correcto y la pantalla real seguir prellenando el
   * borrador, que es EXACTAMENTE el bug de la prueba de hoy.
   */
  it('App le pasa el puente al panel, y el puente es `acceptHandoffAsTask`', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(source).toContain('onAcceptHandoffAsTask={acceptHandoffAsTask}');
    // Y el camino del borrador sigue siendo el de siempre para el resto.
    expect(source).toContain('onAcceptHandoff={acceptHandoff}');
  });
});
