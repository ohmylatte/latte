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
