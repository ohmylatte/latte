import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { I18nProvider } from './i18n';
import { EMPTY_USAGE } from '../shared/contracts';
import type {
  CoordinationActiveRunSummary, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudget, CoordinationEvent,
  CoordinationGateView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationProposal, CoordinationRunView, CoordinatorGrant,
  HandoffRequest,
} from '../shared/contracts';

/**
 * Ronda 2 del juicio: los callejones sin salida de la UI. Pausar era una
 * trampa de ida, una `latte_ask` dejaba el run trabado sin superficie para
 * responderla, el puente de handoffs no tenía gatillo, y el hook escribía
 * estado de la Marca A sobre la Marca B sin ningún guard de generación.
 */

const mocks = vi.hoisted(() => ({
  getCoordinationAuthority: vi.fn<(workId: string) => Promise<CoordinationAuthorityMode>>(),
  getCoordinationBudget: vi.fn<(workId: string) => Promise<CoordinationBudget | null>>(),
  getCoordinatorGrant: vi.fn<(workId: string) => Promise<CoordinatorGrant>>(),
  coordinationRuntimeSupport: vi.fn<(workId: string) => Promise<CoordinationMemberSupport[]>>(),
  getCoordinationRun: vi.fn<(workId: string) => Promise<CoordinationRunView | null>>(),
  listCoordinationGates: vi.fn<(runId: string) => Promise<CoordinationGateView[]>>(),
  listCoordinationLog: vi.fn<(runId: string) => Promise<CoordinationLogEntryView[]>>(),
  listOpenCoordinationAsks: vi.fn<(runId: string) => Promise<CoordinationAskView[]>>(),
  listActiveCoordinationRuns: vi.fn<() => Promise<CoordinationActiveRunSummary[]>>(),
  resolveCoordinationGate: vi.fn(),
  answerCoordinationAsk: vi.fn(),
  settleCoordinationDispatch: vi.fn(),
  pauseCoordinationRun: vi.fn(),
  resumeCoordinationRun: vi.fn(),
  cancelCoordinationRun: vi.fn(),
  onCoordinationEvent: vi.fn<(cb: (event: CoordinationEvent) => void) => () => void>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { useCoordination } = await import('./useCoordination');
const { DecisionsView } = await import('./DecisionsView');
const { TeamPanel } = await import('./TeamPanel');
const { TeamCards } = await import('./coordination/TeamCards');

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z', tasksDone: 0, tasksFailed: 0, tasksPending: 0, ...patch,
});

const ask = (patch: Partial<CoordinationAskView> = {}): CoordinationAskView => ({
  id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '¿Seguimos con el naming largo?',
  answer: null, deadlineAt: '2026-09-01T00:30:00.000Z', answeredAt: null, createdAt: '2026-09-01T00:00:00.000Z', ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCoordinationAuthority.mockResolvedValue('manual');
  mocks.getCoordinationBudget.mockResolvedValue(null);
  mocks.getCoordinatorGrant.mockResolvedValue(null);
  mocks.coordinationRuntimeSupport.mockResolvedValue([]);
  mocks.getCoordinationRun.mockResolvedValue(null);
  mocks.listCoordinationGates.mockResolvedValue([]);
  mocks.listCoordinationLog.mockResolvedValue([]);
  mocks.listOpenCoordinationAsks.mockResolvedValue([]);
  mocks.listActiveCoordinationRuns.mockResolvedValue([]);
  mocks.resolveCoordinationGate.mockResolvedValue(run());
  mocks.answerCoordinationAsk.mockResolvedValue(ask({ answer: 'Sí', answeredAt: '2026-09-01T00:10:00.000Z' }));
  mocks.settleCoordinationDispatch.mockResolvedValue({ id: 'task1', runId: 'run1', roleId: 'strategist', spec: '', status: 'done', attempts: 1, resultSummary: 'Listo' });
  mocks.pauseCoordinationRun.mockResolvedValue(run({ status: 'suspended', suspendReason: 'paused_by_human' }));
  mocks.resumeCoordinationRun.mockResolvedValue(run());
  mocks.cancelCoordinationRun.mockResolvedValue(run({ status: 'cancelled' }));
  mocks.onCoordinationEvent.mockImplementation(() => () => undefined);
});

describe('useCoordination: pausar tiene vuelta (juicio #2)', () => {
  it('expone resumeRun y cancelRun, no sólo pauseRun', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    expect(typeof result.current.resumeRun).toBe('function');
    expect(typeof result.current.cancelRun).toBe('function');
    result.current.resumeRun('run1');
    expect(mocks.resumeCoordinationRun).toHaveBeenCalledWith('run1');
    result.current.cancelRun('run1');
    expect(mocks.cancelCoordinationRun).toHaveBeenCalledWith('run1');
  });
});

describe('useCoordination: las preguntas abiertas llegan a la UI (juicio #7)', () => {
  it('con un run vivo, pide las asks abiertas y las expone', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listOpenCoordinationAsks.mockResolvedValue([ask()]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.openAsks).toHaveLength(1));
    expect(mocks.listOpenCoordinationAsks).toHaveBeenCalledWith('run1');
  });

  it('sin run, no pide asks y la lista queda vacía', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationRun).toHaveBeenCalled());
    expect(result.current.openAsks).toEqual([]);
    expect(mocks.listOpenCoordinationAsks).not.toHaveBeenCalled();
  });
});

describe('useCoordination: guard de generación y errores (juicio #12)', () => {
  it('la respuesta lenta del Trabajo anterior NO pisa el estado del Trabajo actual', async () => {
    let releaseSlow: (value: CoordinationAuthorityMode) => void = () => undefined;
    mocks.getCoordinationAuthority.mockImplementation((workId: string) => {
      if (workId === 'w1') return new Promise<CoordinationAuthorityMode>((resolve) => { releaseSlow = resolve; });
      return Promise.resolve('auto');
    });
    const { result, rerender } = renderHook(({ workId }) => useCoordination(workId), { initialProps: { workId: 'w1' as string | null } });
    rerender({ workId: 'w2' });
    await waitFor(() => expect(result.current.authority).toBe('auto'));
    // Recién ahora contesta la Marca anterior: su respuesta tiene que caer al vacío.
    releaseSlow('plan');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.authority).toBe('auto');
  });

  it('un gate que el backend rechaza llega al canal de error, no a una promesa sin manejar', async () => {
    const onError = vi.fn();
    mocks.resolveCoordinationGate.mockRejectedValue(new Error('BUDGET_EXCEEDED'));
    const { result } = renderHook(() => useCoordination('w1', onError));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.resolveGate('g1', 'approve');
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('pauseRun también reporta su error en vez de fallar en silencio', async () => {
    const onError = vi.fn();
    mocks.pauseCoordinationRun.mockRejectedValue(new Error('NOT_FOUND'));
    const { result } = renderHook(() => useCoordination('w1', onError));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.pauseRun('run1');
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});

// --- Vistas ----------------------------------------------------------------

const decisionsProps = {
  work: { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', outcome: '', resultPath: null, folder: '', createdAt: '', updatedAt: '' },
  decisions: [], team: [], roles: [], permissions: 'ask' as const, handoffs: [] as readonly HandoffRequest[],
  decisionAuthority: 'suggest' as const, draft: '', busy: false,
  formatDate: (v: string) => v, titlesByWork: {},
  onDraftChange: () => undefined, onAdd: () => undefined, onApprove: () => undefined, onEditApprove: () => undefined,
  onReject: () => undefined, onArchive: () => undefined, onAuthorityChange: () => undefined,
};

const renderDecisions = (extra: Record<string, unknown>) =>
  render(<I18nProvider><DecisionsView {...decisionsProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

/**
 * B1.1: las tarjetas se mudaron al chat del miembro al que le corresponden.
 * `m1` es el coordinador de este run Y quien hace la pregunta, asi que su
 * chat es donde caen las dos cosas. Las aserciones no cambiaron.
 */
const cardsProps = { memberId: 'm1', coordinationRun: run(), team: [], roles: [], formatDate: (v: string) => v };
const renderCards = (extra: Record<string, unknown>) =>
  render(<I18nProvider><TeamCards {...cardsProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

describe('TeamCards: la pregunta abierta se puede responder (juicio #7)', () => {
  it('renderiza la ask y su acción de responder', () => {
    const onAnswerAsk = vi.fn();
    const { container } = renderCards({ openAsks: [ask()], onAnswerAsk });
    const card = container.querySelector('.team-card-ask');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('naming largo');
  });
});

describe('DecisionsView: un handoff se puede aceptar (juicio #14)', () => {
  const handoff: HandoffRequest = { fileName: 'para-copy.md', roleId: 'copywriter', roleName: 'Copywriter', request: 'Escribi el copy', known: true };

  it('sin `onAcceptHandoff` la lista sigue siendo sólo lectura', () => {
    const { container } = renderDecisions({ handoffs: [handoff] });
    expect(container.querySelector('.decision-handoff-accept')).toBeNull();
  });

  it('con `onAcceptHandoff` cada handoff conocido trae su acción, y dispara con el fileName', () => {
    const onAcceptHandoff = vi.fn();
    const { container } = renderDecisions({ handoffs: [handoff], onAcceptHandoff });
    const button = container.querySelector('.decision-handoff-accept') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onAcceptHandoff).toHaveBeenCalledWith(handoff);
  });
});

describe('DecisionsView: el adaptador que se negó se dice con su propia frase (juicio #5)', () => {
  it('`runtime_refused_injection` nunca se lee como "sin restricciones" ni como "la función está apagada"', () => {
    const support: CoordinationMemberSupport[] = [{ memberId: 'm1', canPropose: false, memoryInjected: false, reason: 'runtime_refused_injection', runtimeConfirmed: true, runtimeReportsInjection: true }];
    const { container } = renderDecisions({ coordinationSupport: support });
    const row = container.querySelector('.decision-support-coordination');
    expect(row).not.toBeNull();
    // La aserción vieja (`not.toContain('Sin restricciones')` + `length > 0`) la
    // pasaba también una búsqueda de i18n rota que pintara la clave cruda
    // `coordination.degraded.runtimeRefused` — ninguna de las dos condiciones
    // la descarta. Acá se compara contra la frase es-AR real de `i18n.tsx`.
    expect(row!.textContent).toBe('El runtime no inyectó las herramientas que se habían decidido: este miembro no las tiene en su proceso.');
  });
});

describe('TeamPanel: un equipo pausado se puede reanudar o cancelar (juicio #2)', () => {
  const teamProps = {
    work: { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', outcome: '', resultPath: null, folder: '', createdAt: '', updatedAt: '' },
    team: [], chats: {}, selectedId: null, roles: [], primaryLabel: '', primaryDetail: '', primaryReady: true,
    checking: false, primaryRuntime: 'claude' as const, primaryAccountId: null, primaryModel: null, choices: [],
    busy: false, isDesktop: true, mode: 'advanced' as const,
    onSelect: () => undefined, onAdd: async () => undefined, onOpen: async () => undefined, onPause: async () => undefined,
    onFinish: async () => undefined, onRestart: async () => undefined, onContinue: async () => undefined,
    handoffs: [], onAcceptHandoff: async () => undefined, onDismissHandoff: async () => undefined,
    onRemove: async () => undefined, onProviders: () => undefined, onRecheck: () => undefined,
    onModel: () => undefined, onTier: () => undefined, onError: () => undefined,
    onAttachFiles: async () => [], untracked: [], onAdoptFile: () => undefined,
    permissions: 'ask' as const, permissionBusy: false, onPermissions: () => undefined,
  };

  const mount = (extra: Record<string, unknown>) =>
    render(<I18nProvider><TeamPanel {...teamProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

  it('mientras corre sólo ofrece pausar', () => {
    // Un equipo (aunque vacío de miembros no renderiza la barra), así que se
    // monta con un miembro para que la barra de pestañas exista.
    const team = [{ id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', runtime: 'claude' as const, model: null, accountId: null, label: 'Claude', status: 'idle' as const, tier: 'balanced' as const, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, contextTokens: null, contextLimit: null }, continuedFrom: null, createdAt: '', updatedAt: '' }];
    const { container } = mount({ team, coordinationRun: run(), onPauseCoordination: vi.fn(), onResumeCoordination: vi.fn(), onCancelCoordination: vi.fn() });
    expect(container.querySelector('.team-pause-coordination')).not.toBeNull();
    expect(container.querySelector('.team-resume-coordination')).toBeNull();
  });

  it('pausado ofrece reanudar Y cancelar: el botón de pausa no puede ser una trampa de ida', () => {
    const team = [{ id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', runtime: 'claude' as const, model: null, accountId: null, label: 'Claude', status: 'idle' as const, tier: 'balanced' as const, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: null, contextTokens: null, contextLimit: null }, continuedFrom: null, createdAt: '', updatedAt: '' }];
    const onResumeCoordination = vi.fn();
    const onCancelCoordination = vi.fn();
    const { container } = mount({
      team, coordinationRun: run({ status: 'suspended', suspendReason: 'paused_by_human' }),
      onPauseCoordination: vi.fn(), onResumeCoordination, onCancelCoordination,
    });
    const resume = container.querySelector('.team-resume-coordination') as HTMLButtonElement | null;
    const cancel = container.querySelector('.team-cancel-coordination') as HTMLButtonElement | null;
    expect(resume).not.toBeNull();
    expect(cancel).not.toBeNull();
    fireEvent.click(resume!);
    expect(onResumeCoordination).toHaveBeenCalledWith('run1');
  });
});

// Ronda 4 del juicio, ítem 14: ningún control de gate/ask/run tenía estado
// `disabled` — un doble click en el gate de PROPUESTA corría `hub.addMember`
// (la contratación) dos veces antes de que la transacción del perdedor
// tirara, dejando un proceso de agente spawneado sin gate ni token.
describe('TeamCards + useCoordination: un click doble no puede disparar la misma mutación dos veces (ítem 14)', () => {
  function Harness() {
    const coordination = useCoordination('w1');
    return <TeamCards {...cardsProps} coordinationRun={coordination.run} gates={coordination.gates} onResolveGate={coordination.resolveGate} pending={coordination.pending} />;
  }

  it('click doble y síncrono en "Aprobar" de un gate de propuesta sólo llama a resolveCoordinationGate una vez', async () => {
    let releaseGate!: () => void;
    mocks.resolveCoordinationGate.mockImplementation(() => new Promise<CoordinationRunView>((resolve) => { releaseGate = () => resolve(run()); }));
    const proposal: CoordinationProposal = {
      plan: [{ roleId: 'strategist', spec: 'Definir el naming' }],
      membersToHire: [],
      estimatedDispatches: 10,
      rationale: 'Porque sí',
    };
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationGates.mockResolvedValue([{ id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', proposalJson: JSON.stringify(proposal) }]);

    const { container } = render(<I18nProvider><Harness /></I18nProvider>);
    await waitFor(() => expect(container.querySelector('.team-card-proposal')).not.toBeNull());
    const approve = container.querySelector('.team-card-actions button.primary') as HTMLButtonElement;
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(mocks.resolveCoordinationGate).toHaveBeenCalledTimes(1);
    releaseGate();
  });
});

// Ronda 4 del juicio, ítem 15: el aviso de "sin tope" y el "Aprobar" simple del
// gate de propuesta miraban el estado del FORMULARIO de edición, no el de la
// propuesta -- y "Cancelar" no reseteaba nada.
describe('TeamCards: el gate de propuesta no confunde el estado del formulario con el de la propuesta (ítem 15)', () => {
  const cappedProposal: CoordinationProposal = {
    plan: [{ roleId: 'strategist', spec: 'Definir el naming' }],
    membersToHire: [],
    estimatedDispatches: 10,
    rationale: 'Porque sí',
  };
  const cappedGate: CoordinationGateView = { id: 'g1', kind: 'proposal', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z', proposalJson: JSON.stringify(cappedProposal) };

  it('abrir la edición, borrar el número y Cancelar: el "Aprobar" simple sigue ahí y el aviso de ilimitado NO aparece', () => {
    const onResolveGate = vi.fn();
    const { container } = renderCards({ gates: [cappedGate], onResolveGate });
    // "Editar y aprobar": el único botón sin `.primary` en las acciones del gate, antes de editar.
    fireEvent.click(container.querySelector('.team-card-actions button:not(.primary)')!);
    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(numberInput, { target: { value: '' } });
    // "Cancelar", en el formulario de edición -- no en las acciones del gate.
    fireEvent.click(container.querySelector('.team-card-edit-actions button:not(.primary)')!);
    expect(container.querySelector('.team-card-actions button.primary')).not.toBeNull();
    expect(container.querySelector('.team-card-unlimited-note')).toBeNull();
    expect(onResolveGate).not.toHaveBeenCalled();
  });

  /**
   * O1: LA REGLA SE ENDURECIÓ, y este test la sigue.
   *
   * Decía "mientras se está editando, el Aprobar simple no se renderiza".
   * Mirar `editing` dejaba pasar justo el caso que importa: el editor CERRADO
   * sobre un formulario modificado, que es lo que producía `confirmEdit`
   * cerrando sin esperar al motor — ahí el "Aprobar" simple reaparecía y
   * mandaba el plan GUARDADO entero. Hoy la condición es el estado del
   * FORMULARIO: con una edición sin guardar no hay "Aprobar" simple, esté el
   * editor abierto o cerrado; con el formulario intacto no hay ninguna edición
   * que descartar, así que el botón puede convivir con el editor abierto.
   */
  it('con una edición sin guardar, el "Aprobar" simple no se renderiza: no puede descartarla en silencio', () => {
    // N10: sin `onResolveGate` la tarjeta es de sólo lectura y no renderiza
    // ningún botón. Lo que este test mira es el estado del FORMULARIO, así que
    // el handler va puesto y no se usa.
    const { container } = renderCards({ gates: [cappedGate], onResolveGate: vi.fn() });
    fireEvent.click(container.querySelector('.team-card-actions button:not(.primary)')!);
    // Abierto e intacto: nada que descartar, el botón sigue.
    expect(container.querySelector('.team-card-actions button.primary')).not.toBeNull();

    fireEvent.change(container.querySelector('input[type="number"]') as HTMLInputElement, { target: { value: '4' } });

    expect(container.querySelector('.team-card-actions button.primary')).toBeNull();
  });
});

// TeamPanel también recibe `pending` (ítem 14): el `busy` global que ya tenía
// no lo cubría, porque una mutación de `useCoordination` nunca lo toca.
describe('TeamPanel: los controles de pausar/reanudar/cancelar honran `pending` (ítem 14)', () => {
  const teamProps = {
    work: { id: 'w1', brandId: 'b1', title: 'Trabajo', brief: '', outcome: '', resultPath: null, folder: '', createdAt: '', updatedAt: '' },
    team: [{ id: 'm1', workId: 'w1', roleId: 'strategist', roleName: 'Estratega', initial: 'E', runtime: 'claude' as const, model: null, accountId: null, label: 'Claude', status: 'idle' as const, tier: 'balanced' as const, usage: EMPTY_USAGE, continuedFrom: null, createdAt: '', updatedAt: '' }],
    chats: {}, selectedId: null, roles: [], primaryLabel: '', primaryDetail: '', primaryReady: true,
    checking: false, primaryRuntime: 'claude' as const, primaryAccountId: null, primaryModel: null, choices: [],
    busy: false, isDesktop: true, mode: 'advanced' as const,
    onSelect: () => undefined, onAdd: async () => undefined, onOpen: async () => undefined, onPause: async () => undefined,
    onFinish: async () => undefined, onRestart: async () => undefined, onContinue: async () => undefined,
    handoffs: [], onAcceptHandoff: async () => undefined, onDismissHandoff: async () => undefined,
    onRemove: async () => undefined, onProviders: () => undefined, onRecheck: () => undefined,
    onModel: () => undefined, onTier: () => undefined, onError: () => undefined,
    onAttachFiles: async () => [], untracked: [], onAdoptFile: () => undefined,
    permissions: 'ask' as const, permissionBusy: false, onPermissions: () => undefined,
  };
  const mount = (extra: Record<string, unknown>) =>
    render(<I18nProvider><TeamPanel {...teamProps} {...(extra as Record<string, unknown>)} /></I18nProvider>);

  it('con `pending["run:run1"]` en true, "Pausar equipo" queda deshabilitado aunque `busy` sea false', () => {
    const { container } = mount({ coordinationRun: run(), onPauseCoordination: vi.fn(), pending: { 'run:run1': true } });
    const button = container.querySelector('.team-pause-coordination') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
  });

  it('sin `pending`, "Pausar equipo" sigue habilitado (caller no wireado -> cero cambio)', () => {
    const { container } = mount({ coordinationRun: run(), onPauseCoordination: vi.fn() });
    const button = container.querySelector('.team-pause-coordination') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
