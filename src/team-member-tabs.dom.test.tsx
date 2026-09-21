import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B3.3: LA PESTAÑA DE UN MIEMBRO DICE EN QUÉ ANDA.
 *
 * Con el buzón mudado a la vista Equipo, la tira de pestañas del chat se
 * quedaba con el nombre del rol y nada más: para saber qué le pasó a ese
 * miembro había que cambiar de pestaña del Trabajo. Bajo el nombre va una
 * línea chica con su último intercambio, recortada, con el texto entero en el
 * `title`.
 *
 * Y el chip de coordinación se calla cuando no tiene nada que decir. La
 * captura del dueño mostraba tres miembros con "arrancando" y el run
 * `cancelled`: nadie estaba arrancando nada. El chip habla de un PROCESO, así
 * que sólo se muestra con el run vivo y el miembro con proceso.
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
import type {
  CoordinationLogEntryView, CoordinationMemberSupport, CoordinationRunView, TeamMember, TeamMemberStatus, Work,
} from '../shared/contracts';

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const member = (id: string, roleName: string, status: TeamMemberStatus = 'idle'): TeamMember => ({
  id, workId: 'w1', roleId: id, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status, tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'cm',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksPending: 0, ...patch,
});
const support = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: 'cm', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: false,
  runtimeReportsInjection: true, ...patch,
});
const dispatchRow = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'cm', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir 3 posts', summaryPreview: 'Quedaron los 3 posts, uno por canal, con su copy y su imagen de referencia',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-01T10:00:00.000Z', settledAt: '2026-09-01T11:00:00.000Z', ...patch,
});

const base: TeamPanelProps = {
  work, team: [member('cm', 'CM')], chats: {}, selectedId: null, roles: [], primaryLabel: 'Claude', primaryDetail: '',
  primaryReady: true, checking: false, primaryRuntime: 'claude', primaryAccountId: null, primaryModel: null,
  choices: [], busy: false, isDesktop: true, mode: 'simple',
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

describe('B3.3: el subtítulo de la pestaña', () => {
  it('bajo el nombre va el último intercambio de ese miembro', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    const line = container.querySelector('.team-tab .team-tab-last')!;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain('Quedaron los 3 posts');
  });

  it('el texto entero viaja en el `title`: recortar no es callar', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    const line = container.querySelector('.team-tab .team-tab-last') as HTMLElement;
    expect(line.title).toContain('uno por canal');
  });

  it('sin un solo hecho no se dibuja un renglón vacío', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelector('.team-tab-last')).toBeNull();
  });

  it('el nombre del rol sigue estando: el subtítulo no lo reemplaza', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    expect(container.querySelector('.team-tab-name')!.textContent).toBe('CM');
  });
});

describe('B3.3: el chip de coordinación se calla cuando no hay proceso', () => {
  const wired = (patch: Partial<TeamPanelProps>) => mount({ coordinationSupport: [support()], ...patch });
  const chip = (c: HTMLElement) => c.querySelector('.team-tab .team-member-state');

  it('con el run vivo y el miembro con proceso, se muestra', () => {
    const { container } = wired({ coordinationRun: run() });
    expect(chip(container)!.getAttribute('data-state')).toBe('starting');
  });

  /**
   * EL HALLAZGO, EXACTO: la captura mostraba los tres miembros con
   * "arrancando" y el run `cancelled`. Nadie estaba arrancando nada.
   */
  it('con el run CANCELADO no se muestra: nadie está arrancando nada', () => {
    const { container } = wired({ coordinationRun: run({ status: 'cancelled', active: false }) });
    expect(chip(container)).toBeNull();
  });

  it('con el run TERMINADO tampoco', () => {
    const { container } = wired({ coordinationRun: run({ status: 'done', active: false }) });
    expect(chip(container)).toBeNull();
  });

  it('sin run tampoco: un chip de coordinación sin coordinación no dice nada', () => {
    const { container } = wired({});
    expect(chip(container)).toBeNull();
  });

  it('un miembro EN PAUSA no tiene proceso del que hablar', () => {
    const { container } = wired({ coordinationRun: run(), team: [member('cm', 'CM', 'paused')] });
    expect(chip(container)).toBeNull();
  });

  it('un miembro TERMINADO tampoco', () => {
    const { container } = wired({ coordinationRun: run(), team: [member('cm', 'CM', 'ended')] });
    expect(chip(container)).toBeNull();
  });

  it('un miembro trabajando sí', () => {
    const { container } = wired({ coordinationRun: run(), team: [member('cm', 'CM', 'working')] });
    expect(chip(container)).not.toBeNull();
  });

  it('sin `coordinationSupport` no se inventa un estado, aunque el run esté vivo', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(chip(container)).toBeNull();
  });
});
