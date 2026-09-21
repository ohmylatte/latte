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
const { cleanup, fireEvent, render } = await import('@testing-library/react');
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
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
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

describe('C2: la pestaña de miembro tiene la MISMA anatomía que la lista', () => {
  it('avatar con punto, nombre, una línea y la hora a la derecha', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()], formatTime: (v: string) => v });
    const tab = container.querySelector('.team-tab')!;
    expect(tab.querySelector('.coord-av')).not.toBeNull();
    expect(tab.querySelector('.coord-av .coord-dot')).not.toBeNull();
    expect(tab.querySelector('.team-tab-name')!.textContent).toBe('CM');
    expect(tab.querySelector('.team-tab-last')!.textContent).toContain('Reportó');
    expect(tab.querySelector('.coord-time')!.getAttribute('dateTime')).toBe('2026-09-01T11:00:00.000Z');
  });

  it('bajo el nombre va lo que ese miembro hace ahora, en UNA línea', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    const line = container.querySelector('.team-tab .team-tab-last')!;
    // La linea nombra la TAREA, no el resumen: el resumen entero vive en la
    // linea de tiempo del miembro, que es donde hay lugar para leerlo.
    expect(line.textContent).toBe('Reportó · Escribir 3 posts');
  });

  /** Recortar no es callar: la linea entera viaja en el `title` de la pestaña. */
  it('la línea entera viaja en el `title`', () => {
    const { container } = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    const tab = container.querySelector('.team-tab') as HTMLElement;
    expect(tab.title).toContain('Reportó · Escribir 3 posts');
  });

  it('sin un solo hecho dice que no hay novedades, en vez de dejar el renglón vacío', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelector('.team-tab-last')!.textContent).toBe('Sin novedades');
  });

  /** El punto es el estado: trabajando en el acento, reportó y ocioso en verde. */
  it('el punto dice el estado sin una sola palabra', () => {
    const working = mount({ coordinationRun: run(), coordinationLog: [dispatchRow({ status: 'running', outcome: null, summaryPreview: null, settledAt: null })] });
    expect(working.container.querySelector('.team-tab .coord-dot-live')).not.toBeNull();
    cleanup();
    const reported = mount({ coordinationRun: run(), coordinationLog: [dispatchRow()] });
    expect(reported.container.querySelector('.team-tab .coord-dot-ok')).not.toBeNull();
  });

  /** El coordinador lleva su ícono, igual que en la lista del modo Equipo. */
  it('el coordinador se nombra con un ícono', () => {
    const { container } = mount({ coordinationRun: run() });
    expect(container.querySelector('.team-tab .coord-row-coordinator')).not.toBeNull();
  });
});

/**
 * C2: EL CHIP DE COORDINACIÓN SE FUE DE LA PESTAÑA.
 *
 * "conectado", "arrancando", "sin confirmar" son FRASES adentro de una
 * pastilla — exactamente lo que el criterio 5 prohíbe — y encima repetían en
 * palabras lo que el punto ya dice. Lo que el runtime confirmó o no no se
 * pierde: sigue dicho entero, con su frase larga, al pie del modo Equipo en
 * modo avanzado (`describeCoordinationSupport`), que es donde hay lugar para
 * decirlo sin taparle la conversación a nadie.
 */
describe('C2: el chip de coordinación no vive más en la pestaña', () => {
  const wired = (patch: Partial<TeamPanelProps>) => mount({ coordinationSupport: [support()], ...patch });
  const chip = (c: HTMLElement) => c.querySelector('.team-tab .team-member-state');

  it('con el run vivo y el miembro con proceso, tampoco: el punto ya lo dice', () => {
    const { container } = wired({ coordinationRun: run(), coordinationLog: [dispatchRow({ status: 'running', outcome: null, summaryPreview: null, settledAt: null })] });
    expect(chip(container)).toBeNull();
    expect(container.textContent).not.toContain('arrancando');
    expect(container.querySelector('.team-tab .coord-dot-live')).not.toBeNull();
  });

  it('con el run cancelado no se muestra nada: nadie está arrancando nada', () => {
    const { container } = wired({ coordinationRun: run({ status: 'cancelled', active: false }) });
    expect(chip(container)).toBeNull();
    expect(container.textContent).not.toContain('arrancando');
  });

  /** Y la frase larga sigue existiendo, al pie y en modo avanzado. */
  it('lo que el runtime confirmó sigue dicho, entero, en lo avanzado del modo Equipo', () => {
    const { container } = wired({ coordinationRun: run(), mode: 'advanced' });
    fireEvent.click(container.querySelector('.team-rail-team')!);
    const advanced = container.querySelector('.team-advanced')!;
    expect(advanced.querySelector('.team-support-coordination')!.textContent).toBeTruthy();
    expect(advanced.querySelector('.team-support-memory')!.textContent).toBeTruthy();
  });
});
