import { describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

/**
 * B2.2: NOMBRES, NO IDS.
 *
 * Cada superficie de coordinación resolvía el `memberId` por su cuenta y todas
 * caían en el mismo `?? id`: cuando el miembro ya no estaba en el equipo —
 * contratado por un run que terminó y después borrado — la persona leía
 * `mem_a1b2c3`, que no le dice absolutamente nada y encima parece un error.
 *
 * La resolución vive en UN solo lugar (`coordination/names`) y siempre termina
 * en algo legible: el rol del miembro, el rol que traiga la fila, o "miembro
 * que ya no está". El id pelado sólo puede quedar en un `title` o en un
 * `data-*`, que son para depurar, no para leer.
 */

const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { render } = await import('@testing-library/react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { memberDisplayName, roleDisplayName } = await import('./coordination/names');
const { TeamView } = await import('./TeamView');
const { TeamCards } = await import('./coordination/TeamCards');
const { ResumenView } = await import('./ResumenView');
import type { TeamViewProps } from './TeamView';
import type { ResumenViewProps } from './ResumenView';
import { EMPTY_USAGE } from '../shared/contracts';
import type {
  AgentRole, Brand, CoordinationAskView, CoordinationLogEntryView, CoordinationMemberSupport,
  CoordinationMessageView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';

/** Un id con la forma real de la base: lo que la persona NO tiene que leer nunca. */
const GONE = 'mem_9f3a11c4';

const member = (id: string, roleName: string, roleId = id): TeamMember => ({
  id, workId: 'w1', roleId, roleName, initial: roleName[0]!, runtime: 'claude', model: null, accountId: null,
  label: 'Claude', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '',
});
const team = [member('coord', 'Coordinador'), member('cm', 'CM')];
const roles: AgentRole[] = [{ id: 'paid', name: 'Paid Media', initial: 'P', summary: '', builtin: true, tier: 'balanced' }];

describe('el helper: una sola resolución para todas las superficies', () => {
  it('devuelve el rol del miembro cuando el miembro sigue en el equipo', () => {
    expect(memberDisplayName('cm', team)).toBe('CM');
  });

  it('cae al rol que trae la fila cuando el miembro ya no está', () => {
    expect(memberDisplayName(GONE, team, 'paid', roles)).toBe('Paid Media');
  });

  it('dice "miembro que ya no está" cuando no queda ni el rol — nunca el id', () => {
    const name = memberDisplayName(GONE, team);
    expect(name).toBe('miembro que ya no está');
    expect(name).not.toContain('mem_');
  });

  it('nunca devuelve el id pelado ni con un memberId vacío', () => {
    expect(memberDisplayName(null, team)).toBe('miembro que ya no está');
  });

  it('resuelve un roleId contra el equipo primero y contra el catálogo después', () => {
    expect(roleDisplayName('cm', roles, team)).toBe('CM');
    expect(roleDisplayName('paid', roles, team)).toBe('Paid Media');
  });

  it('habla inglés cuando la interfaz habla inglés', () => {
    ui.locale = 'en-US';
    expect(memberDisplayName(GONE, team)).toBe('member no longer here');
    ui.locale = 'es-AR';
  });
});

// ---------------------------------------------------------------- TeamPanel

const work: Work = { id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: '', folder: null, updatedAt: '' };
const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'coord',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true,
  suspendReason: null, active: true, createdAt: '', updatedAt: '', lastEventAt: '',
  tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});
const support = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: GONE, canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true,
  runtimeReportsInjection: true, ...patch,
} as CoordinationMemberSupport);

const basePanel: TeamViewProps = {
  work, team, roles: [], mode: 'advanced', busy: false,
  selectedMemberId: null, onSelectMember: () => {},
};
const mountPanel = (props: Partial<TeamViewProps> = {}, locale: 'es-AR' | 'en-US' = 'es-AR') => {
  ui.locale = locale;
  return render(createElement(TeamView, { ...basePanel, formatDate: (v: string) => v, ...props }));
};

describe('superficie: lo avanzado del equipo (.team-support y el coordinador)', () => {
  it('nombra al miembro que ya no está en vez de escupir su id', () => {
    const { container } = mountPanel({ coordinationSupport: [support()] });
    const row = container.querySelector('.team-support-row')!;
    expect(row.textContent).toContain('miembro que ya no está');
    expect(row.textContent).not.toContain('mem_');
    // El id sigue disponible para depurar, donde nadie lo lee como copy.
    expect(row.getAttribute('data-member-id')).toBe(GONE);
  });

  it('tampoco escupe el id del coordinador cuando ese miembro ya no está', () => {
    const { container } = mountPanel({ coordinatorGrant: GONE, coordinationAuthority: 'plan' });
    const line = container.querySelector('.team-advanced-coordinator')!;
    expect(line.textContent).toContain('miembro que ya no está');
    expect(line.textContent).not.toContain('mem_');
  });
});

describe('superficie: el buzón y el hilo del panel del equipo', () => {
  const message = (patch: Partial<CoordinationMessageView> = {}): CoordinationMessageView => ({
    id: 'msg1', runId: 'run1', from: { memberId: GONE, roleId: 'paid' }, to: { memberId: 'cm', roleId: 'cm' },
    text: 'Necesito el copy', readAt: null, createdAt: '2026-09-01T12:00:00.000Z', ...patch,
  });

  it('resuelve al otro extremo por su rol cuando ya no está en el equipo', () => {
    const { container } = mountPanel({ coordinationRun: run(), coordinationMessages: [message()], roles });
    const line = container.querySelector('[data-member-id="cm"] .team-inbox-line')!;
    expect(line.textContent).toContain('Paid Media');
    expect(line.textContent).not.toContain('mem_');
  });

  it('y si no queda ni el rol, lo dice con palabras', () => {
    const { container } = mountPanel({ coordinationRun: run(), coordinationMessages: [message({ from: { memberId: GONE, roleId: 'borrado' } })] });
    expect(container.querySelector('[data-member-id="cm"] .team-inbox-line')!.textContent).toContain('miembro que ya no está');
    expect(container.querySelector('.team-inbox')!.textContent).not.toContain('mem_');
  });
});

describe('superficie: la línea de "hay algo esperando en otro chat"', () => {
  const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
    id: 'ask1', runId: 'run1', taskId: null, memberId: GONE, question: '¿Seguimos?',
    answer: null, deadlineAt: '', answeredAt: null, createdAt: '', ...patch,
  });

  it('ofrece el salto con un nombre, nunca con un id', () => {
    ui.locale = 'es-AR';
    const { container } = render(createElement(TeamCards, {
      memberId: 'cm', team, roles, coordinationRun: run(), openAsks: [ask()],
      onSelectMember: () => {}, formatDate: (v: string) => v,
    }));
    const goto = container.querySelector('.team-cards-goto')!;
    expect(goto.textContent).toContain('miembro que ya no está');
    expect(goto.textContent).not.toContain('mem_');
  });
});

// --------------------------------------------------------------- Resumen

const brand: Brand = { id: 'b1', name: 'Casa Oliva', context: 'Tono cálido.', createdAt: '', archivedAt: null };
const baseResumen: ResumenViewProps = {
  brand, work: { ...work, expectedOutput: 'Un PDF', resultPath: null } as Work, documents: [], decisions: [], states: {},
  checking: false, team, permissions: 'ask', live: false, brandContextDefined: true,
  formatDate: () => 'hace un rato', onOpenBrief: () => {},
};
const dispatch = (patch: Partial<Extract<CoordinationLogEntryView, { taskId: string }>> = {}): CoordinationLogEntryView => ({
  id: 'd1', taskId: 't1', memberId: 'cm', status: 'reported', outcome: 'succeeded',
  promptPreview: 'Escribir', summaryPreview: 'Listo',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: null, settledAt: '2026-09-01T11:00:00.000Z', ...patch,
});

describe('superficie: la bitácora del Resumen', () => {
  const renderResumen = (props: Partial<ResumenViewProps>, locale: 'es-AR' | 'en-US' = 'es-AR') => {
    ui.locale = locale;
    return renderToStaticMarkup(createElement(ResumenView, { ...baseResumen, ...props }));
  };

  it('dice QUIÉN hizo cada despacho, con su nombre', () => {
    const html = renderResumen({ coordinationLog: [dispatch()], coordinationHires: [] });
    expect(html).toContain('CM');
    expect(html).toContain('Reportado');
  });

  it('y cuando ese miembro ya no está, lo dice con palabras y no con su id', () => {
    const html = renderResumen({ coordinationLog: [dispatch({ memberId: GONE })], coordinationHires: [] });
    expect(html).toContain('miembro que ya no está');
    expect(html).not.toContain('mem_');
  });
});
