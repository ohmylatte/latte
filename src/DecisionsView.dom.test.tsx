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
      coordinationBudget: { state: 'set', budget: { maxDispatches: 10, unlimitedConfirmedAt: null } },
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
      coordinationBudget: { state: 'unset' },
      coordinatorGrant: null,
    });
    const section = container.querySelector('.decision-coordination');
    expect(section!.textContent).toContain('Sin presupuesto configurado');
    expect(section!.textContent).toContain('Sin coordinador asignado');
  });

  // Crítico 8, nivel Trabajo: `invalid` llegaba como `null` y se leía "sin
  // presupuesto configurado" — que manda a la persona a buscar un campo vacío
  // que en realidad tiene bytes rotos adentro, mientras cada despacho se
  // deniega contra esos mismos bytes.
  it('un presupuesto ILEGIBLE se dice con su propia frase, nunca como "sin presupuesto configurado"', () => {
    const { container } = renderView('es-AR', {
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'invalid' },
      coordinatorGrant: null,
    });
    const line = container.querySelector('.decision-coordination-budget')!;
    expect(line).not.toBeNull();
    expect(line.textContent).not.toContain('Sin presupuesto configurado');
    expect(line.textContent).toContain('no se pudo leer');
  });

  it('el mismo presupuesto ilegible en inglés, sin nada en castellano', () => {
    const { container } = renderView('en-US', {
      coordinationAuthority: 'manual',
      coordinationBudget: { state: 'invalid' },
      coordinatorGrant: null,
    });
    const line = container.querySelector('.decision-coordination-budget')!;
    expect(line.textContent).toContain('could not be read');
    expect(line.textContent).not.toContain('no se pudo leer');
  });

  it('renders the same summary in English, with nothing left in Spanish', () => {
    const { container } = renderView('en-US', {
      coordinationAuthority: 'plan',
      coordinationBudget: { state: 'set', budget: { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' } },
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
        // N10: las tres acciones existen PORQUE hay un handler. Sin
        // `onResolveGate` la tarjeta es de sólo lectura y no las ofrece —ver
        // `decisions-round7-proposal.dom.test.tsx`—; la app siempre lo pasa.
        onResolveGate: vi.fn(),
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
        onResolveGate: vi.fn(), // N10: sin handler no hay botones que abrir
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

  /**
   * O1: EL "APROBAR" SIMPLE NO PUEDE MANDAR LO QUE LA PANTALLA NO MUESTRA.
   *
   * `confirmEdit` cerraba el editor en el mismo tick del clic, sin esperar al
   * motor. Cuando el motor rechazaba, el gate seguía en pantalla con el editor
   * CERRADO, las casillas destildadas perdidas y el "Aprobar" simple de vuelta:
   * un clic más mandaba `onResolveGate(id,'approve')` sin payload, o sea el
   * plan GUARDADO entero, con todas las altas que la persona había rechazado.
   */
  describe('O1: el editor cierra cuando el motor acepta, y el "Aprobar" simple sólo existe intacto', () => {
    const twoHires = () => proposal({
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los textos' },
        { roleId: 'designer', spec: 'Diseñar las piezas' },
      ],
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
    });
    const proposalGate = () => gateView({
      id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(twoHires()),
      aggregate: { otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 },
    });

    it('la mutación RECHAZA: el editor queda abierto, las casillas intactas y no reaparece el "Aprobar" simple', async () => {
      const onResolveGate = vi.fn().mockRejectedValue(new Error('DEPTH_CAP'));
      const { container } = renderView('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.decision-gate-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      const boxes = () => [...card.querySelectorAll('.decision-gate-edit-hire input[type="checkbox"]')] as HTMLInputElement[];
      expect(boxes()).toHaveLength(2); // la premisa: el editor SÍ se abrió
      fireEvent.click(boxes()[1]!); // destildo al diseñador

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      await waitFor(() => expect(onResolveGate).toHaveBeenCalledTimes(1));

      // El editor sigue abierto, con la casilla destildada como la dejó.
      expect(card.querySelector('.decision-gate-edit')).not.toBeNull();
      expect(boxes().map((b) => b.checked)).toEqual([true, false]);
      // Y NO hay ningún botón "Aprobar" pelado que pueda mandar el plan guardado.
      const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels).not.toContain('Aprobar');
    });

    it('la mutación resuelve `false` (el contrato de `useCoordination`): el editor tampoco cierra', async () => {
      const onResolveGate = vi.fn().mockResolvedValue(false);
      const { container } = renderView('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.decision-gate-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      fireEvent.click(card.querySelectorAll('.decision-gate-edit-hire input[type="checkbox"]')[1]!);

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));
      await waitFor(() => expect(onResolveGate).toHaveBeenCalledTimes(1));

      expect(card.querySelector('.decision-gate-edit')).not.toBeNull();
    });

    it('la mutación resuelve bien: el editor cierra', async () => {
      const onResolveGate = vi.fn().mockResolvedValue(true);
      const { container } = renderView('es-AR', { gates: [proposalGate()], onResolveGate });
      const card = container.querySelector('.decision-gate-proposal')!;
      fireEvent.click(screen.getByText('Editar y aprobar'));
      fireEvent.click(card.querySelectorAll('.decision-gate-edit-hire input[type="checkbox"]')[1]!);

      fireEvent.click(screen.getByText('Confirmar edición y aprobar'));

      await waitFor(() => expect(card.querySelector('.decision-gate-edit')).toBeNull());
    });

    it('el formulario MODIFICADO no ofrece "Aprobar" simple; cancelar la edición lo devuelve', () => {
      const { container } = renderView('es-AR', { gates: [proposalGate()], onResolveGate: vi.fn() });
      const card = container.querySelector('.decision-gate-proposal')!;
      const labels = () => [...card.querySelectorAll('.decision-gate-actions button')].map((b) => b.textContent);
      // Intacto, el botón existe: la premisa de este test.
      expect(labels()).toContain('Aprobar');

      // Con el editor ABIERTO y el formulario intacto sigue estando: lo que lo
      // esconde es la edición, no el editor.
      fireEvent.click(screen.getByText('Editar y aprobar'));
      expect(labels()).toContain('Aprobar');

      // Basta destildar un alta para que desaparezca: el único camino pasa a
      // ser el payload derivado.
      fireEvent.click(card.querySelectorAll('.decision-gate-edit-hire input[type="checkbox"]')[1]!);
      expect(labels()).not.toContain('Aprobar');

      // Y con el tope cambiado, lo mismo.
      fireEvent.click(card.querySelectorAll('.decision-gate-edit-hire input[type="checkbox"]')[1]!); // vuelvo a tildar
      expect(labels()).toContain('Aprobar');
      fireEvent.change(card.querySelector('input[type="number"]') as HTMLInputElement, { target: { value: '3' } });
      expect(labels()).not.toContain('Aprobar');

      fireEvent.click(screen.getByText('Cancelar edición')); // vuelve al estado inicial
      expect(labels()).toContain('Aprobar');
    });
  });

  /**
   * O3: LO QUE SE CAE SE VE, SE ABRA O NO LA EDICIÓN.
   *
   * Los avisos de "se quitan N tareas" y "se quita N contratación sin tareas"
   * vivían dentro del bloque `{editing && ...}`, y la lista de contrataciones
   * no tachaba nada. Por el camino de "Aprobar" simple —un plan con un rol
   * huérfano que arrastra la única tarea de un alta— el payload salía sin esa
   * alta y la persona nunca se enteraba: leía una contratación que no iba a
   * ocurrir.
   *
   * O12: y un plan ENTERAMENTE huérfano dejaba los dos botones primarios
   * grises, sin una palabra afuera de la edición.
   */
  describe('O3/O12: el recorte automático se ve sin abrir la edición', () => {
    /**
     * Un huérfano (`ghost`) y un alta (`designer`) cuya única tarea depende de
     * la del huérfano: al caerse el huérfano cae la tarea del diseñador por
     * arrastre, y con ella el alta.
     */
    const orphanGate = () => gateView({
      id: 'g-proposal', kind: 'proposal',
      proposalJson: JSON.stringify(proposal({
        plan: [
          { roleId: 'ghost', spec: 'La que nadie puede hacer' },
          { roleId: 'designer', spec: 'La que depende de la anterior', dependsOn: [0] },
        ],
        membersToHire: [{ roleId: 'designer', why: 'Nadie diseña todavía' }],
      })),
      roleCoverage: [{ roleId: 'ghost', coverage: 'orphan' }, { roleId: 'designer', coverage: 'hire' }],
    });

    it('la nota del alta caída y su renglón tachado se ven SIN abrir la edición, y el payload no la lleva', () => {
      const onResolveGate = vi.fn();
      const { container } = renderView('es-AR', {
        gates: [orphanGate()],
        roles: [role({ id: 'designer', name: 'Diseñador' })],
        onResolveGate,
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      // Sin tocar "Editar y aprobar": el editor ni existe.
      expect(card.querySelector('.decision-gate-edit')).toBeNull();

      expect(card.querySelector('.decision-gate-edit-hire-dropped')).not.toBeNull();
      const dropped = card.querySelector('.decision-gate-hire-dropped')!;
      expect(dropped).not.toBeNull();
      expect(dropped.querySelector('s')!.textContent).toContain('Diseñador');
      expect(dropped.textContent).toContain('se quedó sin tareas');

      // O12: con TODO el plan caído, la frase de la única salida.
      expect(card.querySelector('.decision-gate-empty-plan')!.textContent).toContain('Ninguna tarea del plan tiene quien la haga');

      // Y si hubiera algo que aprobar, el payload no llevaría esa alta. Acá no
      // queda nada, así que el botón está deshabilitado: se comprueba que no
      // mandó nada.
      expect(onResolveGate).not.toHaveBeenCalled();
    });

    it('con una tarea que SÍ sobrevive, el "Aprobar" manda el payload derivado sin el alta caída', () => {
      const onResolveGate = vi.fn();
      const { container } = renderView('es-AR', {
        gates: [gateView({
          id: 'g-proposal', kind: 'proposal',
          proposalJson: JSON.stringify(proposal({
            plan: [
              { roleId: 'ghost', spec: 'La que nadie puede hacer' },
              { roleId: 'designer', spec: 'La que depende de la anterior', dependsOn: [0] },
              { roleId: 'copywriter', spec: 'La que se puede hacer igual' },
            ],
            membersToHire: [{ roleId: 'designer', why: 'Nadie diseña todavía' }],
          })),
          roleCoverage: [
            { roleId: 'ghost', coverage: 'orphan' },
            { roleId: 'designer', coverage: 'hire' },
            { roleId: 'copywriter', coverage: 'member' },
          ],
        })],
        onResolveGate,
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      // El alta tachada, y la frase de plan vacío NO (queda una tarea).
      expect(card.querySelector('.decision-gate-hire-dropped')).not.toBeNull();
      expect(card.querySelector('.decision-gate-empty-plan')).toBeNull();

      fireEvent.click(screen.getByText('Aprobar'));

      const [, , editedJson] = onResolveGate.mock.calls[0]!;
      const edited = JSON.parse(editedJson as string) as CoordinationProposal;
      expect(edited.membersToHire).toEqual([]);
      expect(edited.plan.map((task) => task.roleId)).toEqual(['copywriter']);
    });

    it('sin nada que recortar no se inventa ninguna nota ni ningún tachado', () => {
      const { container } = renderView('es-AR', {
        gates: [gateView({ id: 'g-proposal', kind: 'proposal', proposalJson: JSON.stringify(proposal()) })],
      });
      const card = container.querySelector('.decision-gate-proposal')!;
      expect(card.querySelector('.decision-gate-hire-dropped')).toBeNull();
      expect(card.querySelector('.decision-gate-edit-hire-dropped')).toBeNull();
      expect(card.querySelector('.decision-gate-empty-plan')).toBeNull();
      expect(card.querySelector('.decision-gate-edit-dropped')).toBeNull();
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

  /**
   * Los TRES estados de la confirmación, que hasta acá eran dos. "Sin
   * confirmar" promete que la confirmación puede llegar; para un runtime que
   * no tiene forma de informarla nunca —OpenCode: su servidor no expone
   * ningún endpoint que liste servidores MCP— esa frase deja a la persona
   * esperando algo que no va a pasar. `runtimeReportsInjection` separa
   * "todavía no" de "nunca", y ninguno de los dos habilita decir "conectado".
   */
  describe('confirmado / sin confirmar / no informa: los tres estados, nunca dos', () => {
    const notReporting = { canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false, runtimeReportsInjection: false } as const;

    it('CONFIRMADO: el runtime habló, y recién ahí se afirma que anda', () => {
      const { container } = renderView('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: true, runtimeReportsInjection: true })],
      });
      const row = container.querySelector('.decision-support-row')!;
      expect(row.textContent).toContain('Sin restricciones para coordinar');
      expect(row.textContent).toContain('Memoria disponible');
      expect(row.textContent).not.toContain('no informa la conexión');
    });

    it('SIN CONFIRMAR: el runtime puede hablar y todavía no lo hizo', () => {
      const { container } = renderView('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: true, reason: null, memoryInjected: true, runtimeConfirmed: false, runtimeReportsInjection: true })],
      });
      const row = container.querySelector('.decision-support-row')!;
      expect(row.textContent).toContain('El runtime todavía no confirmó');
      expect(row.textContent).toContain('sin confirmar');
      expect(row.textContent).not.toContain('no informa la conexión');
      expect(row.textContent).not.toContain('Sin restricciones para coordinar');
      expect(row.textContent).not.toContain('Memoria disponible');
    });

    it('NO INFORMA: el runtime no tiene forma de confirmar, y se dice así — nunca "todavía"', () => {
      const { container } = renderView('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', ...notReporting })],
      });
      const row = container.querySelector('.decision-support-row')!;
      const coordination = row.querySelector('.decision-support-coordination')!.textContent ?? '';
      const memory = row.querySelector('.decision-support-memory')!.textContent ?? '';
      expect(coordination).toContain('Este runtime no informa la conexión');
      expect(memory).toContain('no informa la conexión');
      // Ni la promesa de que va a llegar...
      expect(row.textContent).not.toContain('todavía no confirmó');
      // ...ni la afirmación de que anda.
      expect(row.textContent).not.toContain('Sin restricciones para coordinar');
      expect(row.textContent).not.toContain('Memoria disponible');
    });

    it('NO INFORMA, en inglés, sin nada en castellano', () => {
      const { container } = renderView('en-US', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', ...notReporting })],
      });
      expect(container.textContent).toContain('This runtime does not report the connection');
      expect(container.textContent).toContain('Memory requested; this runtime does not report the connection');
      expect(container.textContent).not.toContain('no informa la conexión');
      expect(container.textContent).not.toContain('has not confirmed');
    });

    it('un runtime que no informa PERO ya está degradado dice su degradación, no la falta de reporte', () => {
      // `canPropose:false` gana: la razón concreta explica más que "no
      // informa", y decir las dos a la vez sería ruido.
      const { container } = renderView('es-AR', {
        team: [member({ id: 'm1', roleName: 'Estratega' })],
        coordinationSupport: [support({ memberId: 'm1', canPropose: false, reason: 'opencode_shared_server', memoryInjected: false, runtimeConfirmed: false, runtimeReportsInjection: false })],
      });
      const row = container.querySelector('.decision-support-row')!;
      expect(row.textContent).toContain('OpenCode comparte un solo servidor');
      expect(row.textContent).not.toContain('Este runtime no informa la conexión');
    });
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
