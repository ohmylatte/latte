import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageKey } from './i18n';

// `translate` follows the language the provider last rendered with. Here the
// test picks it, with no provider: the markup is rendered to a string.
const ui = vi.hoisted(() => ({ locale: 'es-AR' as 'es-AR' | 'en-US' }));
vi.mock('./i18n', async (importOriginal) => {
  const real = await importOriginal<typeof import('./i18n')>();
  return { ...real, translate: (key: MessageKey, params?: Record<string, string | number>) => real.formatMessage(ui.locale, key, params) };
});

const { createElement } = await import('react');
const { fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { DecisionsView } = await import('./DecisionsView');
import type { DecisionsViewProps } from './DecisionsView';
import { EMPTY_USAGE } from '../shared/contracts';
import type { AgentRole, CoordinationAskView, CoordinationDegradedReason, CoordinationGateView, CoordinationMemberSupport, CoordinationProposal, Decision, HandoffRequest, TeamMember, Work } from '../shared/contracts';

const work = (patch: Partial<Work> = {}): Work => ({
  id: 'w1', brandId: 'b1', title: 'Lanzamiento', brief: 'Lanzar la campaña.',
  folder: null, updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', workId: 'w1', text: 'Elegimos X', rationale: '', alternativesRejected: [], evidenceRefs: [], status: 'pending',
  source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null },
  clientRequestId: null, fingerprint: 'fp', createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, ...patch,
});
const member = (patch: Partial<TeamMember> = {}): TeamMember => ({
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', avatar: null, runtime: 'opencode', model: null,
  accountId: null, label: 'OpenCode', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const role = (patch: Partial<AgentRole> = {}): AgentRole => ({ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Compara opciones.', builtin: false, tier: 'deep', avatar: null, ...patch });
const handoff = (patch: Partial<HandoffRequest> = {}): HandoffRequest => ({ fileName: 'h.md', roleId: 'strategist', roleName: 'Estratega', known: true, request: 'Pido permiso.', ...patch });
const gateView = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'plan', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const askView = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '¿Seguimos con el mismo tono?',
  answer: null, deadlineAt: '2026-09-02T00:00:00.000Z', answeredAt: null, createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const support = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, runtimeReportsInjection: true, ...patch,
});
const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
  plan: [{ roleId: 'copywriter', spec: 'Escribir 3 posts para el lanzamiento' }],
  estimatedDispatches: 8,
  membersToHire: [{ roleId: 'designer', why: 'Necesitamos piezas visuales para las 3 posts' }],
  rationale: 'El equipo actual no alcanza para el volumen del mes.',
  ...patch,
});

const base: DecisionsViewProps = {
  work: work(),
  decisions: [],
  team: [],
  roles: [],
  permissions: 'ask',
  handoffs: [],
  decisionAuthority: 'suggest',
  draft: '',
  busy: false,
  formatDate: () => 'hace un rato',
  titlesByWork: { w1: 'Lanzamiento' },
  onDraftChange: () => {},
  onAdd: () => {},
  onApprove: () => {},
  onEditApprove: () => {},
  onReject: () => {},
  onArchive: () => {},
  onAuthorityChange: () => {},
};

beforeEach(() => { ui.locale = 'es-AR'; });

function renderView(locale: 'es-AR' | 'en-US', props: Partial<DecisionsViewProps> = {}) {
  ui.locale = locale;
  return render(createElement(DecisionsView, { ...base, ...props }));
}

describe('the Decisions, in both interface languages', () => {
  it('renders responsables, alternatives, evidence and the permission summary in Spanish', () => {
    const { container } = renderView('es-AR', {
      decisions: [decision({
        status: 'approved',
        source: { chatId: null, messageId: null, memberId: null, roleId: 'strategist', runtime: null },
        alternativesRejected: ['Opción A'],
        evidenceRefs: ['doc.md'],
      })],
      team: [member({ roleId: 'strategist', roleName: 'Estratega' })],
    });
    expect(container.textContent).toContain('Responsable');
    expect(container.textContent).toContain('Estratega');
    expect(container.textContent).toContain('Alternativas descartadas');
    expect(container.textContent).toContain('Opción A');
    expect(container.textContent).toContain('Evidencia');
    expect(container.textContent).toContain('doc.md');
    expect(container.textContent).toContain('PERMISOS Y TRASPASOS');
    expect(container.textContent).toContain('Aprobación ≠ autorización');
    expect(container.textContent).toContain('Sin solicitudes de permiso');
  });

  it('renders the same Decisions in English, with nothing left in Spanish', () => {
    const { container } = renderView('en-US', {
      decisions: [decision({
        status: 'approved',
        source: { chatId: null, messageId: null, memberId: null, roleId: 'strategist', runtime: null },
        alternativesRejected: ['Option A'],
        evidenceRefs: ['doc.md'],
      })],
      team: [member({ roleId: 'strategist', roleName: 'Strategist' })],
    });
    for (const text of ['Responsible', 'Strategist', 'Alternatives rejected', 'Option A', 'Evidence', 'doc.md', 'PERMISSIONS AND HAND-OFFS', 'Approval ≠ authorization', 'No permission requests']) {
      expect(container.textContent).toContain(text);
    }
    for (const spanish of ['Responsable', 'Alternativas descartadas', 'Evidencia', 'Sin solicitudes']) {
      expect(container.textContent).not.toContain(spanish);
    }
  });
});

describe('responsable resolution', () => {
  it('resolves memberId through the team by id', () => {
    const { container } = renderView('es-AR', {
      decisions: [decision({ status: 'approved', source: { chatId: null, messageId: null, memberId: 'm1', roleId: 'strategist', runtime: null } })],
      team: [member({ id: 'm1', roleId: 'strategist', roleName: 'Estratega' })],
    });
    expect(container.textContent).toContain('Estratega');
  });

  it('resolves roleId through the team by roleId', () => {
    const { container } = renderView('es-AR', {
      decisions: [decision({ status: 'approved', source: { chatId: null, messageId: null, memberId: null, roleId: 'strategist', runtime: null } })],
      team: [member({ id: 'm1', roleId: 'strategist', roleName: 'Estratega' })],
    });
    expect(container.textContent).toContain('Estratega');
  });

  it('falls back to the role name when no team member carries that role', () => {
    const { container } = renderView('es-AR', {
      decisions: [decision({ status: 'approved', source: { chatId: null, messageId: null, memberId: null, roleId: 'strategist', runtime: null } })],
      roles: [role({ id: 'strategist', name: 'Strategist' })],
    });
    expect(container.textContent).toContain('Strategist');
  });

  it('renders no responsable for a human decision with no source', () => {
    const { container } = renderView('es-AR', {
      decisions: [decision({ status: 'approved', source: { chatId: null, messageId: null, memberId: null, roleId: null, runtime: null } })],
    });
    expect(container.textContent).not.toContain('Responsable');
  });
});

describe('alternatives and evidence', () => {
  it('renders no alternatives/evidence rows when the arrays are empty', () => {
    const { container } = renderView('es-AR', { decisions: [decision({ status: 'approved' })] });
    expect(container.textContent).not.toContain('Alternativas descartadas');
    expect(container.textContent).not.toContain('Evidencia');
  });
});

describe('the permission summary', () => {
  it('is a distinct section that never offers a control to change the permission mode', () => {
    const { container } = renderView('es-AR', {
      permissions: 'auto',
      handoffs: [handoff({ fileName: 'h.md', roleName: 'Estratega' })],
      decisions: [decision({ status: 'pending' })],
    });
    const section = container.querySelector('.decision-permissions');
    expect(section).not.toBeNull();
    expect(section!.querySelector('select')).toBeNull();
    expect(section!.querySelector('button')).toBeNull();
    expect(section!.textContent).toContain('Automático');
    expect(section!.textContent).toContain('Estratega');
  });

  it('shows an honest empty message when there are no handoffs', () => {
    const { container } = renderView('es-AR', { permissions: 'ask', handoffs: [] });
    expect(container.textContent).toContain('Sin solicitudes de permiso');
  });
});

describe('callbacks', () => {
  it('fires draft, authority, approve, reject and archive callbacks', () => {
    const onDraftChange = vi.fn();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onArchive = vi.fn();
    const onAuthorityChange = vi.fn();
    renderView('es-AR', {
      draft: 'texto',
      onDraftChange, onApprove, onReject, onArchive, onAuthorityChange,
      decisions: [
        decision({ id: 'p1', status: 'pending', text: 'Pendiente' }),
        decision({ id: 'a1', status: 'approved', text: 'Aprobada', source: { chatId: 'c1', messageId: null, memberId: null, roleId: null, runtime: 'opencode' } }),
      ],
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nuevo' } });
    expect(onDraftChange).toHaveBeenCalledWith('nuevo');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'auto-record' } });
    expect(onAuthorityChange).toHaveBeenCalledWith('auto-record');
    fireEvent.click(screen.getByText('Agregar'));
    expect(onApprove).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByText('Descartar'));
    expect(onReject).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByText('Deshacer'));
    expect(onArchive).toHaveBeenCalledWith('a1');
  });
});

