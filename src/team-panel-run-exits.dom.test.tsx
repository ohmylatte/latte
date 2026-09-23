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
const roles: AgentRole[] = [{ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Strategist', builtin: false, tier: 'deep', avatar: null }];
const member: TeamMember = {
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null,
  runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
  tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const chat: ChatSession = { id: 'm1', workId: 'w1', provider: 'opencode', model: null, accountId: null, label: 'OpenCode', resumed: false, roleId: 'strategist', roleName: 'Estratega', historyRecovered: false };

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
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

/**
 * C7: EL ESTADO DEL RUN VIVE EN EL MODO EQUIPO.
 *
 * Las dos lineas de contadores arriba de la conversacion se fueron: eran el
 * deposito de texto que el rediseno saca. Todo lo que este archivo vigila
 * --que de un run vivo SIEMPRE se pueda salir-- sigue valiendo, un segmento
 * mas alla.
 */
const mount = (patch: Record<string, unknown> = {}, team: TeamMember[] = [member]) => {
  const view = render(<I18nProvider><TeamPanel {...panelProps(team)} {...patch} formatTime={(v: string) => v} /></I18nProvider>);
  const toTeam = view.container.querySelector('.team-rail-team');
  if (toTeam) fireEvent.click(toTeam);
  return view;
};

/**
 * B1.4: COMO TERMINO ESTE EQUIPO SE DICE DONDE ESTAN SUS CONTROLES.
 *
 * El cartel vivia en Decisiones, que es la pantalla de lo que PERMANECE. Un
 * run es lo contrario: pasa. `done` y `cancelled` son dos finales distintos y
 * no comparten frase --un run cancelado no "termino", y sus tareas sin empezar
 * no son fracasos de nadie--, y las tres cuentas viajan separadas por eso
 * mismo.
 */
describe('un run terminado, en el encabezado del pedido', () => {
  it('dice como termino, y las listas y las fallidas siguen separadas', () => {
    const { container } = mount({ coordinationRun: run({ status: 'done', active: false, tasksDone: 4, tasksFailed: 1, tasksInFlight: 0, tasksPending: 0 }) });
    const mark = container.querySelector('.coord-tic-lg')!;
    expect(mark.getAttribute('data-run-status')).toBe('done');
    expect(mark.className).toContain('coord-tic-ok');
    expect(container.querySelector('.coord-head-sub')!.textContent).toBe('Terminamos · 4 de 5');
    // Una sola vez: el subtitulo lo dice, la barra lo muestra. Lo fallido no
    // esta en el subtitulo, asi que eso si se sigue escribiendo.
    expect(container.querySelector('.coord-progress-done')).toBeNull();
    expect(container.querySelector('.coord-progress-rest')!.textContent).toBe('1 fallidas');
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('4');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
  });

  /**
   * EL CIERRE, EN UNA LINEA Y UN BOTON.
   *
   * Eran dos datos separados y ninguno decia lo que la persona quiere leer: la
   * hora ("Terminado a las 14:20") arriba y el avance ("4 de 5 listas") al
   * costado. La hora no es la noticia; la noticia es que terminamos, y cuanto
   * de lo pedido se hizo. La pregunta "seguir o desconectar" no existe: el
   * motor ya desconecto, y seguir es escribir.
   */
  it('cierra con una sola linea y un solo boton, Nuevo pedido', () => {
    const { container } = mount({
      coordinationRun: run({ status: 'done', active: false, tasksDone: 4, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0 }),
    });
    const head = container.querySelector('.coord-head')!;
    expect(head.querySelector('.coord-head-sub')!.textContent).toBe('Terminamos · 4 de 4');
    const buttons = [...head.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('Nuevo pedido');
  });

  it('un run cancelado lo dice con sus propias palabras, no con las del terminado', () => {
    const { container } = mount({ coordinationRun: run({ status: 'cancelled', active: false, tasksDone: 1, tasksFailed: 0, tasksInFlight: 0, tasksPending: 2 }) });
    const mark = container.querySelector('.coord-tic-lg')!;
    expect(mark.getAttribute('data-run-status')).toBe('cancelled');
    expect(mark.className).not.toContain('coord-tic-ok');
    const sub = container.querySelector('.coord-head-sub')!.textContent ?? '';
    expect(sub.toLowerCase()).toContain('cancelado');
    expect(sub).not.toContain('Terminamos');
    // Lo que quedo sin terminar sigue contandose: 1 de 3. Y el rotulo SIGUE
    // aca, a diferencia del run terminado: el subtitulo de un cancelado dice
    // la hora del corte, no las cuentas, asi que este es el unico lugar donde
    // se leen. Sacarlo seria perder el dato, no dejar de repetirlo.
    expect(container.querySelector('.coord-progress-done')!.textContent).toBe('1 de 3 listas');
  });
});

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

  /**
   * C7: un equipo sin despachos no es un equipo roto, y tampoco necesita una
   * palabra en una pastilla para decirlo (criterio 5). Un run que todavia
   * planifica no tiene ni una tarea en la tira: eso ES el estado. Lo que si
   * tiene, y es lo que este archivo vigila, es su salida.
   */
  it('un run `planning` no dibuja ninguna tarea, y conserva su salida', () => {
    const { container } = mount({ coordinationRun: run({ status: 'planning' }), onCancelCoordination: () => {} });
    expect(container.querySelector('.coord-head')).not.toBeNull();
    expect(container.querySelector('.coord-tasks')).toBeNull();
    expect(container.querySelector('.team-cancel-coordination')).not.toBeNull();
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
    expect(container.querySelector('.coord-head')).toBeNull();
    expect(container.querySelector('.team-coordination-controls')).toBeNull();
    expect(container.querySelector('.team-cancel-coordination')).toBeNull();
  });

  it('Cancelar respeta el flag en vuelo de su propio run', () => {
    const { container } = mount({ coordinationRun: run({ status: 'planning' }), onCancelCoordination: () => {}, pending: { 'run:run1': true } });
    expect((container.querySelector('.team-cancel-coordination') as HTMLButtonElement).disabled).toBe(true);
  });
});
