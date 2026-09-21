import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B3.1: EL EQUIPO ES UN MODO DE LA COLUMNA DEL CHAT, NO UNA PESTAÑA DEL TRABAJO.
 *
 * Las pestañas del Trabajo —Resumen, Evidencia, Documentos, Decisiones— son de
 * CONTEXTO: lo que permanece de este Trabajo. Trabajar en equipo es acotado y a
 * pedido, y necesita el mismo alto que la conversación. Así que vive donde vive
 * la conversación y la REEMPLAZA mientras se usa: nunca apilado encima de ella,
 * que es exactamente lo que el dueño vio en la captura de B1.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationAskView, CoordinationGateView, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador'), member('cm', 'CM')];
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});
const gate: CoordinationGateView = { id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '' };
const ask: CoordinationAskView = {
  id: 'a1', runId: 'run1', taskId: null, memberId: 'cm', question: '¿Seguimos?',
  answer: null, deadlineAt: '', answeredAt: null, createdAt: '',
};

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

const mount = (props: Partial<TeamPanelProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamPanel, { ...base, formatDate: (v: string) => v, ...props }));
};

const toTeam = (c: HTMLElement) => fireEvent.click(c.querySelector('.team-rail-team')!);

describe('B3.1: el toggle de la columna', () => {
  it('arranca en la conversación, con la vista del equipo sin dibujar', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelector('.team-rail-chat')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.team-view')).toBeNull();
    expect(container.querySelector('.team-tab-strip')).not.toBeNull();
  });

  /**
   * C7: la cabecera del rail se queda SOLO con el control segmentado. Las dos
   * lineas de contadores del run se fueron al encabezado del pedido, en el
   * modo Equipo: eran el deposito de texto compitiendo por el alto con lo
   * unico que la columna del chat tiene que hacer.
   */
  it('la cabecera lleva el control segmentado, y ningun contador del run', () => {
    const { container } = mount({ coordinationRun: run() });
    const head = container.querySelector('.team-rail-head')!;
    expect(head.querySelector('.team-rail-modes')).not.toBeNull();
    expect(head.querySelector('.team-coordination-controls')).toBeNull();
    expect(container.querySelector('.coord-head')).toBeNull();
  });

  it('el modo Equipo REEMPLAZA la conversación: nunca los dos a la vez', () => {
    const { container } = mount({ coordinationRun: run() });
    toTeam(container);
    expect(container.querySelector('.team-view')).not.toBeNull();
    expect(container.querySelector('.team-tab-strip')).toBeNull();
    expect(container.querySelector('.chat-pane')).toBeNull();
  });

  it('y se vuelve a la conversación por el mismo lugar', () => {
    const { container } = mount({ coordinationRun: run() });
    toTeam(container);
    fireEvent.click(container.querySelector('.team-rail-chat')!);
    expect(container.querySelector('.team-view')).toBeNull();
    expect(container.querySelector('.team-tab-strip')).not.toBeNull();
  });

  it('el botón lleva el contador del Trabajo: gates más preguntas', () => {
    const { container } = mount({ coordinationRun: run(), coordinationGates: [gate], coordinationAsks: [ask] });
    expect(container.querySelector('.team-rail-pending')!.textContent).toBe('2');
  });

  it('un run cerrado no espera nada: el contador no se dibuja', () => {
    const { container } = mount({ coordinationRun: run({ status: 'cancelled', active: false }), coordinationGates: [gate], coordinationAsks: [ask] });
    expect(container.querySelector('.team-rail-pending')).toBeNull();
  });

  it('sin equipo no se ofrece un modo que no tiene nada que mostrar', () => {
    const { container } = mount({ team: [], coordinationRun: run() });
    expect(container.querySelector('.team-rail-modes')).toBeNull();
  });

  it('"Ver hilo" desde la pestaña del miembro abre el modo Equipo con ESE miembro', () => {
    const { container } = mount({ coordinationRun: run(), selectedId: 'cm' });
    fireEvent.click(container.querySelector('.team-tab-thread')!);
    expect(container.querySelector('.team-view')).not.toBeNull();
    expect(container.querySelector('.team-inbox-row.is-selected')!.getAttribute('data-member-id')).toBe('cm');
  });

  /**
   * C2: EL "ABRIR CHAT" REPETIDO POR FILA SE FUE.
   *
   * Criterio 4: la fila ES la acción. Tocarla abre a ESE miembro en el panel
   * de al lado; el verbo que llevaba cada fila --tres veces la misma palabra
   * en una lista de tres-- ya no está.
   */
  it('la fila del modo Equipo elige al miembro, sin un verbo repetido al costado', () => {
    const { container } = mount({ coordinationRun: run() });
    toTeam(container);
    expect(container.querySelector('.team-inbox-open-chat')).toBeNull();
    fireEvent.click(container.querySelector('[data-member-id="cm"] .coord-row')!);
    expect(container.querySelector('.team-inbox-row.is-selected')!.getAttribute('data-member-id')).toBe('cm');
  });

  it('el mismo toggle en inglés, sin nada en castellano', () => {
    const { container } = mount({ coordinationRun: run() }, 'en-US');
    const modes = container.querySelector('.team-rail-modes')!.textContent ?? '';
    expect(modes).toContain('Conversation');
    expect(modes).toContain('Team');
    expect(modes).not.toContain('Conversación');
  });
});
