import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * H1: LA LÍNEA DE "PLAN APROBADO" SE VA CUANDO LA PERSONA ABRE EL EQUIPO.
 *
 * Aprobar deja una línea en la conversación del coordinador: "Plan aprobado ·
 * el equipo trabaja", con un solo verbo —"Ver equipo"— para ir a mirarlos
 * trabajar. Esa línea es un AVISO, no un estado: existe para llevar a la
 * persona una vez. Quedarse ahí todo el run la convertía en decoración fija
 * arriba del composer, ocupando el alto que la conversación necesita.
 *
 * Decisión del dueño: "que se vaya cuando se abre el equipo, no tiene sentido
 * mantenerlo". Así que la línea aparece tras aprobar y desaparece en cuanto la
 * persona abre el modo Equipo de ESE trabajo —por el verbo o por el segmento
 * Conversación|Equipo—, y no vuelve para ese run. El "visto" es del RUN, no de
 * la sesión: otro run nuevo vuelve a avisar, porque es otro aviso.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement, useState } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamCards } = await import('./coordination/TeamCards');
const { TeamPanel } = await import('./TeamPanel');
const { useTeamSeen, TEAM_SEEN_STORAGE_KEY } = await import('./useTeamSeen');
import type { TeamCardsProps } from './coordination/TeamCards';
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, avatar: null, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador'), member('cm', 'CM')];

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '2026-09-13T17:17:00.000Z', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

const mountCards = (props: Partial<TeamCardsProps> = {}) => {
  ui.locale = 'es-AR';
  return render(createElement(TeamCards, {
    memberId: 'coord', coordinationRun: run(), team, roles: [], gates: [], openAsks: [],
    formatDate: (v: string) => v, formatTime: (v: string) => v, ...props,
  }));
};

describe('H1 (a): la línea sólo se dibuja mientras el aviso no se haya visto', () => {
  it('tras aprobar, la línea está', () => {
    const { container } = mountCards();
    expect(container.querySelector('.coord-approved')).not.toBeNull();
  });

  it('con el equipo ya visto para este run, la línea no se dibuja', () => {
    const { container } = mountCards({ teamSeen: true });
    expect(container.querySelector('.coord-approved')).toBeNull();
  });

  it('un run que todavía no aprobó nada no tiene línea, visto o no', () => {
    const { container } = mountCards({ coordinationRun: run({ planApproved: false }), teamSeen: false });
    expect(container.querySelector('.coord-approved')).toBeNull();
  });
});

/**
 * H1 (b): el recorrido completo, con el MISMO cableado que la app: el rail de
 * `TeamPanel` avisa que se abrió el equipo, `useTeamSeen` lo anota por run, y
 * `TeamCards` deja de dibujar la línea. Un harness, porque montar `App` entero
 * para esto sería montar la app entera para mirar una línea.
 */
function Harness({ runId, onRail }: { runId: string; onRail?: (rail: 'chat' | 'team') => void }) {
  const seen = useTeamSeen();
  const [rail, setRail] = useState<'chat' | 'team'>('chat');
  const current = run({ id: runId });
  return createElement('div', null,
    createElement('button', {
      type: 'button', className: 'go-team',
      onClick: () => { setRail('team'); seen.markSeen(runId); onRail?.('team'); },
    }, 'Equipo'),
    createElement('button', {
      type: 'button', className: 'go-chat',
      onClick: () => { setRail('chat'); onRail?.('chat'); },
    }, 'Conversación'),
    rail === 'chat' ? createElement(TeamCards, {
      memberId: 'coord', coordinationRun: current, team, roles: [], gates: [], openAsks: [],
      formatDate: (v: string) => v, formatTime: (v: string) => v, teamSeen: seen.seen(runId),
    }) : null,
  );
}

describe('H1 (b): abrir el equipo apaga el aviso, y volver a la conversación no lo enciende', () => {
  beforeEach(() => { try { window.localStorage.removeItem(TEAM_SEEN_STORAGE_KEY); } catch { /* sin storage, el estado vive en memoria */ } });

  it('aparece, se va al abrir Equipo, y volver a Conversación no la trae', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(Harness, { runId: 'run-a' }));
    expect(container.querySelector('.coord-approved')).not.toBeNull();
    fireEvent.click(container.querySelector('.go-team')!);
    fireEvent.click(container.querySelector('.go-chat')!);
    expect(container.querySelector('.coord-approved')).toBeNull();
  });

  it('otro run nuevo vuelve a avisar: el visto es del run, no de la app', () => {
    ui.locale = 'es-AR';
    const first = render(createElement(Harness, { runId: 'run-a' }));
    fireEvent.click(first.container.querySelector('.go-team')!);
    fireEvent.click(first.container.querySelector('.go-chat')!);
    expect(first.container.querySelector('.coord-approved')).toBeNull();
    const second = render(createElement(Harness, { runId: 'run-b' }));
    expect(second.container.querySelector('.coord-approved')).not.toBeNull();
  });

  it('el visto sobrevive a un remontaje: queda anotado, no en el estado del componente', () => {
    ui.locale = 'es-AR';
    const first = render(createElement(Harness, { runId: 'run-a' }));
    fireEvent.click(first.container.querySelector('.go-team')!);
    first.unmount();
    const again = render(createElement(Harness, { runId: 'run-a' }));
    expect(again.container.querySelector('.coord-approved')).toBeNull();
  });
});

/** H1 (c): el rail es el que avisa — por el segmento y por "Ver equipo". */
const base: TeamPanelProps = {
  work, team, chats: {}, selectedId: 'cm', roles: [], primaryLabel: 'Claude', primaryDetail: '', primaryReady: true,
  checking: false, primaryRuntime: 'claude', primaryAccountId: null, primaryModel: null, choices: [], busy: false,
  isDesktop: true, mode: 'simple',
  onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
};

describe('H1 (c): el segmento Conversación|Equipo avisa que el equipo se abrió', () => {
  it('pasar a Equipo llama a `onTeamOpened` una sola vez', () => {
    ui.locale = 'es-AR';
    const onTeamOpened = vi.fn();
    const { container } = render(createElement(TeamPanel, {
      ...base, formatDate: (v: string) => v, coordinationRun: run(),
      chatCoordination: { coordinationRun: run(), team, roles: [], onTeamOpened },
    }));
    expect(onTeamOpened).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.team-rail-team')!);
    expect(onTeamOpened).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.team-rail-chat')!);
    expect(onTeamOpened).toHaveBeenCalledTimes(1);
  });
});
