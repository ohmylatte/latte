import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B4.3b: EL CHIP DE ESTADO NO SE MONTA ENCIMA DEL NOMBRE.
 *
 * La tira de pestañas era UNA fila de 190 px con el avatar, el nombre, el
 * chip («conectado»), el punto y el contador. Con un nombre real —«Community
 * Manager»— el chip terminaba pisándolo.
 *
 * jsdom no mide layout, así que acá se prueba lo único que jsdom sí sabe y que
 * es lo que decide el pisado: la ESTRUCTURA. El nombre y el chip dejan de
 * compartir renglón — arriba avatar, nombre y punto; abajo chip y último
 * intercambio — y el CSS de esos dos renglones lo fija `team-styles.dom.test`.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render } = await import('@testing-library/react');
const { TeamPanel } = await import('./TeamPanel');
import type { TeamPanelProps } from './TeamPanel';
import { EMPTY_USAGE } from '../shared/contracts';
import type { CoordinationLogEntryView, CoordinationMemberSupport, CoordinationRunView, TeamMember, Work } from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
/** El nombre largo de la captura real, no uno de laboratorio. */
const member: TeamMember = {
  id: 'cm', workId: 'w1', roleId: 'community-manager', roleName: 'Community Manager', initial: 'C',
  runtime: 'claude', model: null, accountId: null, label: 'Claude', status: 'working', tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'cm',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0,
};
const support: CoordinationMemberSupport = {
  memberId: 'cm', canPropose: true, memoryInjected: true, reason: null,
  runtimeConfirmed: true, runtimeReportsInjection: true,
};
const dispatched: CoordinationLogEntryView = {
  id: 'd1', taskId: 't1', memberId: 'cm', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir 3 posts', summaryPreview: 'Quedaron los 3 posts, uno por canal, con su copy',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', settledAt: '2026-09-01T11:00:00.000Z',
};

const base: TeamPanelProps = {
  work, team: [member], chats: {}, selectedId: null, roles: [], primaryLabel: 'Claude', primaryDetail: '',
  primaryReady: true, checking: false, primaryRuntime: 'claude', primaryAccountId: null, primaryModel: null,
  choices: [], busy: false, isDesktop: true, mode: 'simple',
  onSelect: () => {}, onAdd: async () => {}, onOpen: async () => {}, onPause: async () => {}, onFinish: async () => {},
  onRestart: async () => {}, onContinue: async () => {}, handoffs: [], onAcceptHandoff: async () => {},
  onDismissHandoff: async () => {}, onRemove: async () => {}, onProviders: () => {}, onRecheck: () => {},
  onModel: () => {}, onTier: () => {}, onError: () => {}, onAttachFiles: async () => [], untracked: [],
  onAdoptFile: () => {}, permissions: 'ask', permissionBusy: false, onPermissions: () => {},
};

const mount = () => render(createElement(TeamPanel, {
  ...base, formatDate: (v: string) => v,
  coordinationRun: run, coordinationSupport: [support], coordinationLog: [dispatched],
}));

describe('B4.3b: la pestaña de un miembro son dos renglones', () => {
  it('el nombre y el chip NO comparten renglón', () => {
    const { container } = mount();
    const tab = container.querySelector('.team-tab')!;
    const top = tab.querySelector('.team-tab-top');
    const bottom = tab.querySelector('.team-tab-bottom');
    expect(top, 'la pestaña no tiene renglón de arriba').not.toBeNull();
    expect(bottom, 'la pestaña no tiene renglón de abajo').not.toBeNull();

    const name = tab.querySelector('.team-tab-name')!;
    const chip = tab.querySelector('.team-member-state')!;
    expect(name.textContent).toBe('Community Manager');
    expect(chip.textContent).toBeTruthy();
    // Lo que producía el pisado: los dos en la MISMA fila.
    expect(top!.contains(name)).toBe(true);
    expect(top!.contains(chip)).toBe(false);
    expect(bottom!.contains(chip)).toBe(true);
    expect(bottom!.contains(name)).toBe(false);
  });

  it('el avatar y el punto viajan con el nombre, arriba', () => {
    const { container } = mount();
    const top = container.querySelector('.team-tab .team-tab-top')!;
    expect(top.querySelector('.team-avatar')).not.toBeNull();
    // `working` dibuja el vapor en lugar del punto: cualquiera de los dos, arriba.
    expect(top.querySelector('.team-tab-dot, .team-steam')).not.toBeNull();
  });

  it('el último intercambio acompaña al chip, abajo', () => {
    const { container } = mount();
    const bottom = container.querySelector('.team-tab .team-tab-bottom')!;
    expect(bottom.querySelector('.team-tab-last')!.textContent).toContain('Quedaron los 3 posts');
  });
});
