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
  id: 'cm', workId: 'w1', roleId: 'community-manager', roleName: 'Community Manager', initial: 'C', avatar: null,
  runtime: 'claude', model: null, accountId: null, label: 'Claude', status: 'working', tier: 'balanced',
  usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
};
const run: CoordinationRunView = {
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'cm',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, request: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
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

/**
 * C2: LA PESTAÑA ES UNA FILA CON LA MISMA ANATOMÍA, NO DOS RENGLONES APRETADOS.
 *
 * B4.3b había repartido el nombre arriba y el chip abajo porque en una sola
 * fila de 190 px el chip («conectado») se montaba encima del nombre. La
 * solución real era otra: el chip no tenía que existir. Es una FRASE adentro
 * de una pastilla —lo que el criterio 5 prohíbe— repitiendo en palabras lo que
 * el punto del avatar ya dice.
 *
 * Lo que queda es la anatomía del criterio 1, la misma que la lista del modo
 * Equipo: avatar con punto · nombre · qué hace ahora · cuándo.
 */
describe('C2: la pestaña de un miembro tiene la anatomía de toda fila', () => {
  it('el avatar lleva el punto, y el nombre no comparte renglón con ninguna pastilla', () => {
    const { container } = mount();
    const tab = container.querySelector('.team-tab')!;
    const top = tab.querySelector('.team-tab-top')!;
    expect(top, 'la pestaña no tiene renglón de arriba').not.toBeNull();
    expect(tab.querySelector('.coord-av .coord-dot'), 'el avatar no lleva punto').not.toBeNull();
    expect(top.querySelector('.team-tab-name')!.textContent).toBe('Community Manager');
    // El chip se fue entero: no hay ninguna pastilla con una palabra de estado.
    expect(tab.querySelector('.team-member-state')).toBeNull();
    expect(tab.querySelector('.team-tab-bottom')).toBeNull();
  });

  it('el avatar va afuera del texto, y el texto es nombre + una línea', () => {
    const { container } = mount();
    const tab = container.querySelector('.team-tab')!;
    const text = tab.querySelector('.team-tab-text')!;
    expect(text.contains(tab.querySelector('.coord-av'))).toBe(false);
    expect(text.querySelector('.team-tab-name')).not.toBeNull();
    expect(text.querySelector('.team-tab-last')).not.toBeNull();
  });

  /**
   * C8: el color por rol vuelve TAMBIEN a la pestaña. Es la misma persona en
   * las dos superficies: si la lista la pinta y la pestaña no, el avatar deja
   * de servir para reconocerla de un vistazo, que es lo unico que hace.
   */
  it('el avatar lleva el rol del miembro, para que se lo reconozca', () => {
    const { container } = mount();
    const avatar = container.querySelector('.team-tab .coord-av')!;
    expect(avatar.getAttribute('data-role')).toBe('community-manager');
    // Y el estado sigue estando en el punto, y en uno solo.
    expect(avatar.querySelectorAll('.coord-dot')).toHaveLength(1);
  });

  it('lo que ese miembro hace ahora va en UNA línea bajo el nombre', () => {
    const { container } = mount();
    const line = container.querySelector('.team-tab .team-tab-last')!;
    expect(line.textContent).toContain('Reportó');
    expect(line.childElementCount).toBe(0);
  });
});
