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
const { fireEvent, render, screen } = await import('@testing-library/react');
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
  id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', runtime: 'opencode', model: null,
  accountId: null, label: 'OpenCode', status: 'idle', tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '', ...patch,
});
const role = (patch: Partial<AgentRole> = {}): AgentRole => ({ id: 'strategist', name: 'Strategist', initial: 'S', summary: 'Compara opciones.', builtin: false, tier: 'deep', ...patch });
const handoff = (patch: Partial<HandoffRequest> = {}): HandoffRequest => ({ fileName: 'h.md', roleId: 'strategist', roleName: 'Estratega', known: true, request: 'Pido permiso.', ...patch });
const gateView = (patch: Partial<CoordinationGateView> = {}): CoordinationGateView => ({
  id: 'g1', kind: 'plan', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const askView = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '¿Seguimos con el mismo tono?',
  answer: null, deadlineAt: '2026-09-02T00:00:00.000Z', answeredAt: null, createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});
const support = (patch: Partial<CoordinationMemberSupport> = {}): CoordinationMemberSupport => ({
  memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, ...patch,
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

describe('the coordination settings summary (additive, Phase 2 of autonomous-coordination)', () => {
  it('does not render when the caller has not wired coordination state, and the other two settings are unaffected', () => {
    const { container } = renderView('es-AR');
    expect(container.querySelector('.decision-coordination')).toBeNull();
    expect(container.querySelector('select')).not.toBeNull();
    expect(container.querySelector('.decision-permissions')).not.toBeNull();
  });

  it('renders a read-only summary of authority, budget and coordinator grant, offering no control, without touching the other two settings', () => {
    const { container } = renderView('es-AR', {
      coordinationAuthority: 'auto',
      coordinationBudget: { maxDispatches: 10, unlimitedConfirmedAt: null },
      coordinatorGrant: 'm1',
      team: [member({ id: 'm1', roleId: 'strategist', roleName: 'Estratega' })],
      permissions: 'ask',
      handoffs: [],
    });
    const section = container.querySelector('.decision-coordination');
    expect(section).not.toBeNull();
    expect(section!.querySelector('select')).toBeNull();
    expect(section!.querySelector('button')).toBeNull();
    expect(section!.textContent).toContain('Automático');
    expect(section!.textContent).toContain('10');
    expect(section!.textContent).toContain('Estratega');
    // The two pre-existing settings still render, untouched.
    expect(container.querySelector('select')).not.toBeNull();
    expect(container.querySelector('.decision-permissions')).not.toBeNull();
  });

  it('shows the unset/no-coordinator state honestly instead of inventing a value', () => {
    const { container } = renderView('es-AR', {
      coordinationAuthority: 'manual',
      coordinationBudget: null,
      coordinatorGrant: null,
    });
    const section = container.querySelector('.decision-coordination');
    expect(section!.textContent).toContain('Sin presupuesto configurado');
    expect(section!.textContent).toContain('Sin coordinador asignado');
  });

  it('renders the same summary in English, with nothing left in Spanish', () => {
    const { container } = renderView('en-US', {
      coordinationAuthority: 'plan',
      coordinationBudget: { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' },
      coordinatorGrant: null,
    });
    const section = container.querySelector('.decision-coordination');
    expect(section!.textContent).toContain('By plan');
    expect(section!.textContent).toContain('No dispatch limit');
    expect(section!.textContent).toContain('No coordinator assigned');
    expect(section!.textContent).not.toContain('Sin');
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

describe('coordination gates (additive, autonomous-coordination Phase 7 tasks 7.4-7.6)', () => {
  it('does not render when the caller has not wired gate state', () => {
    const { container } = renderView('es-AR');
    expect(container.querySelector('.decision-gates')).toBeNull();
  });

  it('renders no section when wired but there is nothing pending — zero rows is never a zero', () => {
    const { container } = renderView('es-AR', { gates: [], openAsks: [] });
    expect(container.querySelector('.decision-gates')).toBeNull();
  });

  it('renders the plan, dispatch and budget gates simultaneously, plus an open ask', () => {
    const { container } = renderView('es-AR', {
      gates: [
        gateView({ id: 'g-plan', kind: 'plan' }),
        gateView({ id: 'g-dispatch', kind: 'dispatch', taskId: 't1', dispatchId: 'd1', prompt: 'Escribir el post de lanzamiento' }),
        gateView({ id: 'g-budget', kind: 'budget' }),
      ],
      openAsks: [askView()],
    });
    expect(container.querySelectorAll('.decision-gate-plan')).toHaveLength(1);
    expect(container.querySelectorAll('.decision-gate-dispatch')).toHaveLength(1);
    expect(container.querySelectorAll('.decision-gate-budget')).toHaveLength(1);
    expect(container.querySelectorAll('.decision-ask')).toHaveLength(1);
    expect(container.textContent).toContain('Escribir el post de lanzamiento');
    expect(container.textContent).toContain('¿Seguimos con el mismo tono?');
  });

  it('gives the budget-exhausted gate exactly 2 actions — the three-action triple is a pattern, not a contract', () => {
    const { container } = renderView('es-AR', { gates: [gateView({ id: 'g-budget', kind: 'budget' })] });
    const actions = container.querySelectorAll('.decision-gate-budget .decision-gate-actions button');
    expect(actions).toHaveLength(2);
    expect([...actions].map((b) => b.textContent)).toEqual(['Aprobar', 'Rechazar']);
  });

  it('gives the plan gate exactly 2 actions too — there is nothing to edit at plan-approval, the engine ignores it', () => {
    const { container } = renderView('es-AR', { gates: [gateView({ id: 'g-plan', kind: 'plan' })] });
    const actions = container.querySelectorAll('.decision-gate-plan .decision-gate-actions button');
    expect(actions).toHaveLength(2);
  });

  it('gives the dispatch gate all 3 actions, since its prompt is genuinely editable', () => {
    const { container } = renderView('es-AR', { gates: [gateView({ id: 'g-dispatch', kind: 'dispatch', prompt: 'Prompt original' })] });
    const actions = container.querySelectorAll('.decision-gate-dispatch .decision-gate-actions button');
    expect(actions).toHaveLength(3);
  });

  it('resolves the plan and budget gates through the real approve/reject verb', () => {
    const onResolveGate = vi.fn();
    const { container } = renderView('es-AR', {
      gates: [gateView({ id: 'g-plan', kind: 'plan' }), gateView({ id: 'g-budget', kind: 'budget' })],
      onResolveGate,
    });
    fireEvent.click(container.querySelector('.decision-gate-plan .decision-gate-actions button')!);
    expect(onResolveGate).toHaveBeenCalledWith('g-plan', 'approve');
    const budgetButtons = container.querySelectorAll('.decision-gate-budget .decision-gate-actions button');
    fireEvent.click(budgetButtons[1]);
    expect(onResolveGate).toHaveBeenCalledWith('g-budget', 'reject');
  });

  it('edits the dispatch prompt and approves the edited payload through the same verb every other gate uses', () => {
    const onResolveGate = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('Prompt editado');
    const { container } = renderView('es-AR', { gates: [gateView({ id: 'g-dispatch', kind: 'dispatch', prompt: 'Prompt original' })], onResolveGate });
    const actions = container.querySelectorAll('.decision-gate-dispatch .decision-gate-actions button');
    fireEvent.click(actions[1]); // Editar y aprobar
    expect(onResolveGate).toHaveBeenCalledWith('g-dispatch', 'approve', 'Prompt editado');
    vi.restoreAllMocks();
  });

  it('answers an open ask through onAnswerAsk, never through onResolveGate', () => {
    const onAnswerAsk = vi.fn();
    const onResolveGate = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('Sí, mismo tono');
    const { container } = renderView('es-AR', { openAsks: [askView({ id: 'ask1' })], onAnswerAsk, onResolveGate });
    fireEvent.click(container.querySelector('.decision-ask button')!);
    expect(onAnswerAsk).toHaveBeenCalledWith('ask1', 'Sí, mismo tono');
    expect(onResolveGate).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe('the proposal gate — the WOW surface (task 7.5)', () => {
    it('renders the plan, the hires with their reasons, the budget and the rationale, offering exactly the 3 real actions', () => {
      const { container } = renderView('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal',
          proposalJson: JSON.stringify(proposal()),
          aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 },
        })],
        roles: [role({ id: 'copywriter', name: 'Redactor' }), role({ id: 'designer', name: 'Diseñador' })],
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('Redactor');
      expect(card.textContent).toContain('Escribir 3 posts para el lanzamiento');
      expect(card.textContent).toContain('Diseñador');
      expect(card.textContent).toContain('Necesitamos piezas visuales');
      expect(card.textContent).toContain('El equipo actual no alcanza para el volumen del mes.');
      expect(card.textContent).toContain('8');
      const actions = card.querySelectorAll('.decision-gate-actions button');
      expect(actions).toHaveLength(3);
    });

    it('asserts there is no separate settings form anywhere in the flow: no dropdown, no modal dialog, just the plan', () => {
      const { container } = renderView('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      expect(card.textContent).toContain('No hay ningún formulario de configuración');
      expect(card.querySelector('select')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      // Even after opening the edit affordance, still no dialog and no dropdown.
      fireEvent.click(card.querySelectorAll('.decision-gate-actions button')[1]);
      expect(card.querySelector('select')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('lets you drop a hire and lower the cap, approving the EDITED payload through resolveCoordinationGate(id,"approve",edited)', () => {
      const onResolveGate = vi.fn();
      const { container } = renderView('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
        onResolveGate,
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      fireEvent.click(card.querySelectorAll('.decision-gate-actions button')[1]); // Editar y aprobar
      const numberInput = card.querySelector('input[type="number"]') as HTMLInputElement;
      fireEvent.change(numberInput, { target: { value: '3' } });
      const hireCheckbox = card.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(hireCheckbox);
      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      expect(onResolveGate).toHaveBeenCalledTimes(1);
      const [gateId, decision, editedJson] = onResolveGate.mock.calls[0];
      expect(gateId).toBe('g-proposal');
      expect(decision).toBe('approve');
      const edited = JSON.parse(editedJson as string) as CoordinationProposal;
      expect(edited.estimatedDispatches).toBe(3);
      expect(edited.membersToHire).toEqual([]);
    });

    it('discard grants nothing: reject calls onResolveGate with no edited payload', () => {
      const onResolveGate = vi.fn();
      const { container } = renderView('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()), aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 } })],
        onResolveGate,
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      const actions = card.querySelectorAll('.decision-gate-actions button');
      fireEvent.click(actions[2]); // Rechazar
      expect(onResolveGate).toHaveBeenCalledWith('g-proposal', 'reject');
      expect(onResolveGate).not.toHaveBeenCalledWith('g-proposal', 'reject', expect.anything());
    });
  });

  describe('the aggregate — never hidden (task 7.6)', () => {
    it('shows this work, other teams now, and the total if approved', () => {
      const { container } = renderView('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 2, otherCommittedDispatches: 10, totalIfApproved: 18 },
        })],
      });
      const text = container.querySelector('.decision-gate-proposal')!.textContent!;
      expect(text).toContain('8');
      expect(text).toContain('2');
      expect(text).toContain('10');
      expect(text).toContain('18');
    });

    it('says so instead of printing a fabricated total when another run is explicitly unlimited', () => {
      const { container } = renderView('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 1, otherCommittedDispatches: null, totalIfApproved: null },
        })],
      });
      const text = container.querySelector('.decision-gate-proposal')!.textContent!;
      expect(text).toContain('no podemos calcular el total');
      expect(text).not.toContain('null');
    });
  });

  it('renders the same gates in English, with nothing left in Spanish', () => {
    const { container } = renderView('en-US', {
      gates: [
        gateView({ id: 'g-budget', kind: 'budget' }),
        gateView({
          id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal({ estimatedDispatches: 8 })),
          aggregate: { otherActiveRuns: 1, otherCommittedDispatches: null, totalIfApproved: null },
        }),
      ],
    });
    expect(container.textContent).toContain('Budget exhausted');
    expect(container.textContent).toContain('COORDINATION PROPOSAL');
    expect(container.textContent).toContain('cannot calculate a total');
    expect(container.textContent).toContain('There is no settings form');
    for (const spanish of ['Presupuesto agotado', 'PROPUESTA DE COORDINACIÓN', 'no podemos calcular']) {
      expect(container.textContent).not.toContain(spanish);
    }
  });
});

/**
 * Degraded badges (additive, autonomous-coordination Phase 7 task 7.9):
 * per-member coordination/memory status from `coordinationRuntimeSupport`.
 * Coordination and memory are two INDEPENDENT injection policies (task
 * 6.29) — a coordination-degraded member still shows memory as available,
 * and vice versa. Never silent, never a capability presented as working.
 */
describe('coordination support badges (additive, autonomous-coordination Phase 7 task 7.9)', () => {
  it('does not render when the caller has not wired support state', () => {
    const { container } = renderView('es-AR');
    expect(container.querySelector('.decision-coordination-support')).toBeNull();
  });

  it('renders nothing for an empty list — zero rows is never a zero', () => {
    const { container } = renderView('es-AR', { coordinationSupport: [] });
    expect(container.querySelector('.decision-coordination-support')).toBeNull();
  });

  it('renders one row per member, resolved to its display name — never a raw id', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1' })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Estratega');
  });

  it('a coordination-degraded member still shows memory as available — the two policies are independent', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'codex_run_cap', memoryInjected: true })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row.textContent).toContain('tope de miembros de Codex coordinados por corrida');
    expect(row.textContent).toContain('Memoria disponible');
  });

  it('vice versa: a memory-degraded member (engram missing) still shows coordination as unrestricted', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: 'engram_not_installed', memoryInjected: false })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row.textContent).toContain('Falta el binario de Engram');
    expect(row.textContent).toContain('Sin restricciones para coordinar');
  });

  it('each of the six degraded reasons renders its own distinct, honest sentence', () => {
    const reasons: Array<[CoordinationDegradedReason, string]> = [
      ['claude_below_floor', 'anterior a la mínima soportada'],
      ['codex_run_cap', 'tope de miembros de Codex coordinados por corrida'],
      ['codex_global_cap', 'tope de procesos de Codex coordinados en toda la app'],
      ['codex_process_ceiling', 'tope total de procesos de Codex en toda la app'],
      ['opencode_shared_server', 'OpenCode comparte un solo servidor'],
      ['engram_not_installed', 'Falta el binario de Engram'],
    ];
    for (const [reason, phrase] of reasons) {
      const { container, unmount } = renderView('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason, memoryInjected: reason !== 'engram_not_installed' })],
      });
      expect(container.querySelector('.decision-support-row')!.textContent, reason).toContain(phrase);
      unmount();
    }
  });

  it('a member with neither degradation shows both as available, never silent', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row.textContent).toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('Memoria disponible');
  });

  it('task 8.1: canPropose false with NO reason (the coordination feature flag itself is off) is never rendered as "available" — that would be a silent failure', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: null, memoryInjected: true })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row.textContent).not.toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('desactivada en esta instalación');
    // Memory is unaffected -- the two policies stay independent even in this new state.
    expect(row.textContent).toContain('Memoria disponible');
  });

  // Crítico 7 (c): hasta acá "sin restricciones para coordinar" se mostraba
  // igual para un miembro cuyo runtime confirmó la inyección y para uno cuyo
  // runtime nunca pudo decir nada. Latte escribió el archivo: eso es lo único
  // que se sabía, y se leía como si el servidor estuviera andando.
  it('un reclamo SIN confirmar del runtime no se muestra como conectado', () => {
    const { container } = renderView('es-AR', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false })],
    });
    const row = container.querySelector('.decision-support-row')!;
    expect(row.textContent).not.toContain('Sin restricciones para coordinar');
    expect(row.textContent).toContain('El runtime todavía no confirmó');
    // La memoria del mismo miembro tampoco se puede afirmar: la confirmación
    // es una sola, y viene del mismo reporte.
    expect(row.textContent).not.toContain('Memoria disponible');
    expect(row.textContent).toContain('sin confirmar');
  });

  it('el mismo estado sin confirmar, en inglés, sin nada en castellano', () => {
    const { container } = renderView('en-US', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false })],
    });
    expect(container.textContent).toContain('The runtime has not confirmed');
    expect(container.textContent).not.toContain('El runtime todavía no confirmó');
  });

  it('renders the same badges in English, with nothing left in Spanish', () => {
    const { container } = renderView('en-US', {
      team: [member({ id: 'm1', roleName: 'Estratega' })],
      coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'engram_not_installed', memoryInjected: false })],
    });
    expect(container.textContent).toContain('The Engram binary is missing');
    expect(container.textContent).not.toContain('Falta el binario de Engram');
  });
});
