import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CoordinationActiveRunSummary, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudget, CoordinationBudgetView, CoordinationEvent, CoordinationGateView, CoordinationHireView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationMessageView, CoordinationRunView, CoordinatorGrant } from '../shared/contracts';

/**
 * `useCoordination(workId)` (autonomous-coordination Phase 7 task 7.11):
 * finally wires Phase 2's three `DecisionsView` props to real IPC data, and
 * the run/gates/log/support/activeRuns surfaces built across Phases 3 and
 * 6. Renders no JSX of its own — `renderHook` needs jsdom (a wrapper
 * component still mounts), so this lives in `.dom.test.tsx` per the
 * project's strict-DOM-suffix rule even though nothing here touches the
 * DOM directly.
 */

const mocks = vi.hoisted(() => ({
  getCoordinationAuthority: vi.fn<(workId: string) => Promise<CoordinationAuthorityMode>>(),
  getCoordinationBudget: vi.fn<(workId: string) => Promise<CoordinationBudgetView>>(),
  getCoordinatorGrant: vi.fn<(workId: string) => Promise<CoordinatorGrant>>(),
  coordinationRuntimeSupport: vi.fn<(workId: string) => Promise<CoordinationMemberSupport[]>>(),
  getCoordinationRun: vi.fn<(workId: string) => Promise<CoordinationRunView | null>>(),
  listCoordinationGates: vi.fn<(runId: string) => Promise<CoordinationGateView[]>>(),
  listCoordinationLog: vi.fn<(runId: string) => Promise<CoordinationLogEntryView[]>>(),
  listCoordinationHires: vi.fn<(runId: string) => Promise<CoordinationHireView[]>>(),
  listCoordinationMessages: vi.fn<(workId: string) => Promise<CoordinationMessageView[]>>(),
  listActiveCoordinationRuns: vi.fn<() => Promise<CoordinationActiveRunSummary[]>>(),
  listOpenCoordinationAsks: vi.fn<(runId: string) => Promise<CoordinationAskView[]>>(),
  resolveCoordinationGate: vi.fn(),
  answerCoordinationAsk: vi.fn(),
  settleCoordinationDispatch: vi.fn(),
  pauseCoordinationRun: vi.fn(),
  onCoordinationEvent: vi.fn<(cb: (event: CoordinationEvent) => void) => () => void>(),
}));

vi.mock('./browser-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { useCoordination } = await import('./useCoordination');

const run = (patch: Partial<CoordinationRunView> = {}): CoordinationRunView => ({
  id: 'run1', workId: 'w1', status: 'running', coordinatorMemberId: 'm1',
  budget: { maxDispatches: 10, unlimitedConfirmedAt: null }, budgetInvalid: false, planApproved: true, suspendReason: null, request: null, active: true,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastEventAt: '2026-09-01T00:00:00.000Z', tasksDone: 0, tasksFailed: 0, tasksInFlight: 0, tasksPending: 0, ...patch,
});

let coordinationEventCallback: ((event: CoordinationEvent) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCoordinationAuthority.mockResolvedValue('manual');
  mocks.getCoordinationBudget.mockResolvedValue({ state: 'unset' });
  mocks.getCoordinatorGrant.mockResolvedValue(null);
  mocks.coordinationRuntimeSupport.mockResolvedValue([]);
  mocks.getCoordinationRun.mockResolvedValue(null);
  mocks.listCoordinationGates.mockResolvedValue([]);
  mocks.listCoordinationLog.mockResolvedValue([]);
  mocks.listCoordinationHires.mockResolvedValue([]);
  mocks.listCoordinationMessages.mockResolvedValue([]);
  mocks.listActiveCoordinationRuns.mockResolvedValue([]);
  mocks.listOpenCoordinationAsks.mockResolvedValue([]);
  mocks.resolveCoordinationGate.mockResolvedValue(run());
  mocks.answerCoordinationAsk.mockResolvedValue({ id: 'ask1', runId: 'run1', taskId: null, memberId: 'm1', question: '', answer: 'Sí', deadlineAt: '', answeredAt: '', createdAt: '' });
  mocks.settleCoordinationDispatch.mockResolvedValue({ id: 'task1', runId: 'run1', roleId: 'strategist', spec: '', status: 'done', attempts: 1, resultSummary: 'Listo' });
  mocks.pauseCoordinationRun.mockResolvedValue(run());
  mocks.onCoordinationEvent.mockImplementation((cb) => { coordinationEventCallback = cb; return () => { coordinationEventCallback = null; }; });
});

describe('useCoordination(workId): no Work open', () => {
  it('defaults everything to a safe, honest shape and fetches no per-work data', async () => {
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.authority).toBe('manual'));
    expect(result.current.budget).toEqual({ state: 'unset' });
    expect(result.current.coordinatorGrant).toBeNull();
    expect(result.current.run).toBeNull();
    expect(result.current.gates).toEqual([]);
    expect(result.current.log).toEqual([]);
    expect(result.current.support).toEqual([]);
    expect(mocks.getCoordinationAuthority).not.toHaveBeenCalled();
    expect(mocks.getCoordinationRun).not.toHaveBeenCalled();
  });

  it('still fetches the GLOBAL active-runs strip even with no Work open', async () => {
    mocks.listActiveCoordinationRuns.mockResolvedValue([{ runId: 'r1', workId: 'w9', workTitle: 'Otro', brandId: 'b9', brandName: 'Otra marca', status: 'running', dispatchesUsed: 1, maxDispatches: 5, pendingGates: 0, budgetInvalid: false, updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z', lastSeenAt: null }]);
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.activeRuns).toHaveLength(1));
  });
});

describe('useCoordination(workId): a Work is open', () => {
  it('fetches authority, budget, coordinator grant and runtime support for that Work', async () => {
    mocks.getCoordinationAuthority.mockResolvedValue('plan');
    mocks.getCoordinationBudget.mockResolvedValue({ state: 'set', budget: { maxDispatches: 20, unlimitedConfirmedAt: null } });
    mocks.getCoordinatorGrant.mockResolvedValue('m1');
    mocks.coordinationRuntimeSupport.mockResolvedValue([{ memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, runtimeReportsInjection: true }]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.authority).toBe('plan'));
    expect(result.current.budget).toEqual({ state: 'set', budget: { maxDispatches: 20, unlimitedConfirmedAt: null } });
    expect(result.current.coordinatorGrant).toBe('m1');
    expect(result.current.support).toEqual([{ memberId: 'm1', canPropose: true, memoryInjected: true, reason: null, runtimeConfirmed: true, runtimeReportsInjection: true }]);
    expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w1');
  });

  it('when a run exists, also fetches its gates and its bitácora', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationGates.mockResolvedValue([{ id: 'g1', kind: 'dispatch', runId: 'run1', createdAt: '2026-09-01T00:00:00.000Z' }]);
    mocks.listCoordinationLog.mockResolvedValue([{ id: 'l1', taskId: 't1', memberId: 'm1', status: 'running', outcome: null, promptPreview: '', summaryPreview: null, createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', settledAt: null }]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.run).not.toBeNull());
    expect(mocks.listCoordinationGates).toHaveBeenCalledWith('run1');
    expect(mocks.listCoordinationLog).toHaveBeenCalledWith('run1');
    expect(result.current.gates).toHaveLength(1);
    expect(result.current.log).toHaveLength(1);
  });

  /**
   * B1.2: EL BUZON SE PIDE CON EL MISMO RITMO QUE LA BITACORA.
   *
   * El panel de equipo dibuja las dos cosas en UNA linea por miembro. Con dos
   * ritmos distintos esa linea se contradiria consigo misma entre un refresco
   * y el siguiente: el ultimo despacho de una lectura y el ultimo mensaje de
   * otra. `listCoordinationMessages` se pide por `workId` --resuelve el run
   * por su cuenta-- y viaja en el mismo refresco por-Trabajo.
   */
  it('pide los mensajes entre miembros del Trabajo y los expone', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationMessages.mockResolvedValue([
      { id: 'msg1', runId: 'run1', from: { memberId: 'm1', roleId: 'strategist' }, to: { memberId: 'm2', roleId: 'copywriter' }, text: 'Pasame el copy', readAt: null, createdAt: '2026-09-01T00:00:00.000Z' },
    ]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(mocks.listCoordinationMessages).toHaveBeenCalledWith('w1');
  });

  it('sin Trabajo abierto el buzon queda vacio y no se pide nada', async () => {
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.messages).toEqual([]));
    expect(mocks.listCoordinationMessages).not.toHaveBeenCalled();
  });

  it('when there is no run, gates and log stay empty without ever calling listCoordinationGates', async () => {
    mocks.getCoordinationRun.mockResolvedValue(null);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationRun).toHaveBeenCalled());
    expect(result.current.gates).toEqual([]);
    expect(result.current.log).toEqual([]);
    expect(mocks.listCoordinationGates).not.toHaveBeenCalled();
  });

  // El hook vaciaba bitácora, gates y preguntas en cuanto el run terminaba,
  // porque el getter contestaba `null`. Ahora el run terminado llega con
  // `active: false`, y lo que tiene que sobrevivir es JUSTO la bitácora: la
  // entrada de cierre `run_done` no se veía nunca.
  it('con el run TERMINADO, la bitácora persiste y muestra la entrada de cierre', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run({ status: 'done', active: false }));
    mocks.listCoordinationGates.mockResolvedValue([]);
    mocks.listCoordinationLog.mockResolvedValue([
      { id: 'l1', taskId: 't1', memberId: 'm1', status: 'reported', outcome: 'succeeded', promptPreview: '', summaryPreview: null, createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', settledAt: '2026-09-01T00:01:00.000Z' },
      { id: 'l2', kind: 'run_done', tasksDone: 1, tasksFailed: 0, createdAt: '2026-09-01T00:02:00.000Z' },
    ] as never);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.log).toHaveLength(2));
    expect(result.current.run).toMatchObject({ status: 'done', active: false });
    expect(mocks.listCoordinationLog).toHaveBeenCalledWith('run1');
  });

  // `coordinationHires` estaba testeado en tres archivos del renderer y no lo
  // llenaba NADIE: la bitácora no mostró jamás una sola alta. Ahora tiene
  // fuente, y este hook la trae junto con el resto del run.
  it('trae las contrataciones del run junto con su bitácora', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationHires.mockResolvedValue([{ memberId: 'm2', roleId: 'copywriter', roleName: 'Copywriter', hiredAt: '2026-09-01T09:00:00.000Z' }]);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.hires).toHaveLength(1));
    expect(mocks.listCoordinationHires).toHaveBeenCalledWith('run1');
    expect(result.current.hires[0].roleName).toBe('Copywriter');
  });

  it('sin run no se pide ninguna contratación, y la lista queda vacía', async () => {
    mocks.getCoordinationRun.mockResolvedValue(null);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationRun).toHaveBeenCalled());
    expect(result.current.hires).toEqual([]);
    expect(mocks.listCoordinationHires).not.toHaveBeenCalled();
  });

  it('re-fetches for a new Work when workId changes', async () => {
    const { rerender } = renderHook(({ workId }) => useCoordination(workId), { initialProps: { workId: 'w1' as string | null } });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w1'));
    rerender({ workId: 'w2' });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w2'));
  });
});

describe('useCoordination(workId): actions surface the existing IPC verbs, never reinvent them', () => {
  it('resolveGate calls resolveCoordinationGate with the exact same verb every other gate uses', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.resolveGate('g1', 'approve', 'edited-json');
    expect(mocks.resolveCoordinationGate).toHaveBeenCalledWith('g1', 'approve', 'edited-json');
  });

  it('answerAsk calls answerCoordinationAsk', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.answerAsk('ask1', 'Sí');
    expect(mocks.answerCoordinationAsk).toHaveBeenCalledWith('ask1', 'Sí');
  });

  it('settleDispatch surfaces settleCoordinationDispatch (task 3.19) — it does not reinvent it', async () => {
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    result.current.settleDispatch('task1', 'succeeded', 'Listo');
    expect(mocks.settleCoordinationDispatch).toHaveBeenCalledWith('task1', 'succeeded', 'Listo');
  });

  // Pausar ya no aplica el run devuelto: re-lee el estado como toda otra
  // mutación, para que los gates y las asks queden consistentes con él.
  //
  // El mock devuelve 'running' en la PRIMERA llamada y 'suspended' recién
  // desde la segunda: si `getCoordinationRun` volviera 'suspended' desde el
  // arranque, el refresh INICIAL del hook ya satisface el `waitFor` de abajo
  // y el test pasa sin que `pauseRun` haya disparado ningún re-lectura real
  // (probado: ver la salida RED capturada al sacar el `.finally` de `mutate`).
  it('pauseRun calls pauseCoordinationRun and re-reads the Work afterwards', async () => {
    mocks.pauseCoordinationRun.mockResolvedValue(run({ status: 'suspended' }));
    mocks.getCoordinationRun
      .mockResolvedValueOnce(run({ status: 'running' }))
      .mockResolvedValue(run({ status: 'suspended' }));
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.run?.status).toBe('running'));
    result.current.pauseRun('run1');
    await waitFor(() => expect(result.current.run?.status).toBe('suspended'));
    expect(mocks.pauseCoordinationRun).toHaveBeenCalledWith('run1');
    // La única forma de llegar a 'suspended' es una SEGUNDA lectura real.
    expect(mocks.getCoordinationRun).toHaveBeenCalledTimes(2);
  });
});

describe('useCoordination(workId): the event subscription', () => {
  it('refreshes the GLOBAL strip on ANY event, even one for a Brand the person is not viewing', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'other-brand', workId: 'other-work', runId: null });
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(2));
  });

  it('does NOT re-fetch the open Work\'s own data for an event about a different Work', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'other-brand', workId: 'other-work', runId: null });
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(2));
    expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1);
  });

  it('DOES re-fetch the open Work\'s own data for an event about that same Work', async () => {
    renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(1));
    coordinationEventCallback?.({ brandId: 'b1', workId: 'w1', runId: null });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledTimes(2));
  });
});

// Ronda 4 del juicio, ítem 13e: la fuga cruzada de Marcas que la ronda 2 dio
// por cerrada seguía abierta en dos lugares distintos de este archivo.
describe('useCoordination(workId): mutate no pisa una Marca distinta a la que fue emitida (13e-b)', () => {
  it('una mutación emitida bajo w1 que resuelve DESPUÉS de pasar a w2 no vuelve a leer w1, y una lectura de w2 en vuelo sigue llegando', async () => {
    let releaseGateMutation!: () => void;
    mocks.resolveCoordinationGate.mockImplementation(() => new Promise((resolve) => { releaseGateMutation = () => resolve(run()); }));

    let releaseW2Authority!: (v: CoordinationAuthorityMode) => void;
    mocks.getCoordinationAuthority.mockImplementation((id: string) => {
      if (id === 'w2') return new Promise<CoordinationAuthorityMode>((resolve) => { releaseW2Authority = resolve; });
      return Promise.resolve('manual');
    });

    const { result, rerender } = renderHook(({ workId }) => useCoordination(workId), { initialProps: { workId: 'w1' as string | null } });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w1'));

    // Se emite la mutación con w1 todavía abierto; su promesa queda pendiente
    // mientras la persona navega a otra Marca.
    result.current.resolveGate('g1', 'approve');

    rerender({ workId: 'w2' });
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalledWith('w2'));
    const callsWithW1BeforeSettle = mocks.getCoordinationAuthority.mock.calls.filter(([id]) => id === 'w1').length;

    // Recién ahora resuelve la mutación vieja, con w2 ya abierto.
    releaseGateMutation();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const callsWithW1AfterSettle = mocks.getCoordinationAuthority.mock.calls.filter(([id]) => id === 'w1').length;
    expect(callsWithW1AfterSettle).toBe(callsWithW1BeforeSettle); // nunca vuelve a leer w1

    // La lectura de w2, en vuelo desde ANTES de que la mutación vieja resolviera,
    // tiene que seguir llegando: el `.finally` de la mutación vieja no puede
    // haber pisado el generation counter de las lecturas por Trabajo.
    releaseW2Authority('plan');
    await waitFor(() => expect(result.current.authority).toBe('plan'));
  });
});

describe('useCoordination(workId): refreshActiveRuns tiene su PROPIO guard de generación (13e-a)', () => {
  it('una respuesta vieja de listActiveCoordinationRuns que llega DESPUÉS de una más nueva no la pisa', async () => {
    const resolvers: Array<(v: CoordinationActiveRunSummary[]) => void> = [];
    mocks.listActiveCoordinationRuns.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(1));

    // Un segundo refresh arranca (evento de otra Marca) mientras el primero
    // sigue en vuelo.
    coordinationEventCallback?.({ brandId: 'other', workId: 'other-work', runId: null });
    await waitFor(() => expect(mocks.listActiveCoordinationRuns).toHaveBeenCalledTimes(2));

    // La llamada MÁS NUEVA resuelve primero...
    resolvers[1]([{ runId: 'r2', workId: 'w2', workTitle: 'Nuevo', brandId: 'b2', brandName: 'Marca 2', status: 'running', dispatchesUsed: 0, maxDispatches: 5, pendingGates: 0, budgetInvalid: false, updatedAt: '2026-09-02T00:00:00.000Z', lastEventAt: '2026-09-02T00:00:00.000Z', lastSeenAt: null }]);
    await waitFor(() => expect(result.current.activeRuns).toHaveLength(1));

    // ...y la VIEJA resuelve después: no puede pisar las filas nuevas.
    resolvers[0]([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.activeRuns).toHaveLength(1);
    expect(result.current.activeRuns[0].runId).toBe('r2');
  });
});

// Ítem 14: ningún gate/ask/control de run exponía un estado "en vuelo" -- un
// doble click en el gate de PROPUESTA corría `hub.addMember` dos veces.
describe('useCoordination(workId): pending por acción (ítem 14)', () => {
  it('pending["gate:g1"] es true mientras resolveCoordinationGate no resolvió, y false apenas resuelve', async () => {
    let releaseGate!: (v: CoordinationRunView) => void;
    mocks.resolveCoordinationGate.mockImplementation(() => new Promise<CoordinationRunView>((resolve) => { releaseGate = resolve; }));
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.getCoordinationAuthority).toHaveBeenCalled());
    expect(result.current.pending['gate:g1']).toBeFalsy();
    result.current.resolveGate('g1', 'approve');
    await waitFor(() => expect(result.current.pending['gate:g1']).toBe(true));
    releaseGate(run());
    await waitFor(() => expect(result.current.pending['gate:g1']).toBeFalsy());
  });
});
/**
 * U3a: "Desde tu ultima visita" tiene que medir una visita de verdad.
 *
 * `App.tsx` marcaba visto en el MISMO tick en que la persona toca la pestana
 * Decisiones, antes de que cargara un solo gate: la visita quedaba registrada
 * sobre una pantalla que todavia estaba vacia, y todo lo que llegaba despues
 * -- justamente lo que la persona tenia que ver -- nacia ya "visto". El hook
 * publica `workLoaded`, que recien se prende cuando el recorte por-Trabajo
 * (run + gates + bitacora + altas + preguntas) termino de resolver.
 */
describe('useCoordination: `workLoaded`, la senal de que ya hay algo que mirar', () => {
  it('sin Trabajo abierto nunca se declara cargado: no hay nada que visitar', async () => {
    const { result } = renderHook(() => useCoordination(null));
    await waitFor(() => expect(result.current.authority).toBe('manual'));
    expect(result.current.workLoaded).toBe(false);
  });

  it('arranca en false y solo se prende cuando los gates y la bitacora ya resolvieron', async () => {
    let releaseGates: (value: CoordinationGateView[]) => void = () => {};
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationGates.mockImplementation(() => new Promise<CoordinationGateView[]>((resolve) => { releaseGates = resolve; }));

    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(mocks.listCoordinationGates).toHaveBeenCalled());
    // El run ya llego; los gates NO. Marcar visto aca seria marcar una
    // pantalla vacia.
    expect(result.current.workLoaded).toBe(false);

    releaseGates([]);
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
  });

  it('un Trabajo SIN run se declara cargado igual: no hay nada mas que esperar', async () => {
    mocks.getCoordinationRun.mockResolvedValue(null);
    const { result } = renderHook(() => useCoordination('w1'));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
  });

  it('cambiar de Trabajo apaga la senal hasta que el nuevo termine de cargar', async () => {
    mocks.getCoordinationRun.mockResolvedValue(null);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useCoordination(id), { initialProps: { id: 'w1' } });
    await waitFor(() => expect(result.current.workLoaded).toBe(true));

    let releaseRun: (value: CoordinationRunView | null) => void = () => {};
    mocks.getCoordinationRun.mockImplementation(() => new Promise<CoordinationRunView | null>((resolve) => { releaseRun = resolve; }));
    rerender({ id: 'w2' });
    expect(result.current.workLoaded).toBe(false);

    releaseRun(null);
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
  });
});

/**
 * U6: el hook no puede tragarse los errores.
 *
 * Cada `.catch()` de las lecturas degradaba en silencio a un default seguro
 * -- `manual`, `unset`, `[]` -- y no llamaba a `report()` NUNCA. El estado
 * seguro esta bien; el silencio no: la persona veia "sin presupuesto
 * configurado" sobre un Trabajo cuyo presupuesto no se pudo leer, con cada
 * despacho denegandose por detras y sin una sola senal de que algo fallo. Es
 * la misma mentira que el resto de este slice arregla, del lado del renderer.
 *
 * El canal es el que las mutaciones ya usan: `onError`.
 */
describe('useCoordination: una lectura que falla se REPORTA, sin dejar de degradar', () => {
  const boom = (name: string) => new Error(`falla de ${name}`);

  it('cada lectura del recorte por-Trabajo que rechaza llega a `onError`, y el estado queda en su default seguro', async () => {
    mocks.getCoordinationAuthority.mockRejectedValue(boom('authority'));
    mocks.getCoordinationBudget.mockRejectedValue(boom('budget'));
    mocks.getCoordinatorGrant.mockRejectedValue(boom('grant'));
    mocks.coordinationRuntimeSupport.mockRejectedValue(boom('support'));
    mocks.getCoordinationRun.mockRejectedValue(boom('run'));
    const onError = vi.fn();

    const { result } = renderHook(() => useCoordination('w1', onError));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(5));
    const reported = onError.mock.calls.map(([e]) => (e as Error).message).sort();
    expect(reported).toEqual(['falla de authority', 'falla de budget', 'falla de grant', 'falla de run', 'falla de support']);
    // Y sigue degradando: reportar no puede costar el estado seguro.
    expect(result.current.authority).toBe('manual');
    expect(result.current.budget).toEqual({ state: 'unset' });
    expect(result.current.coordinatorGrant).toBeNull();
    expect(result.current.support).toEqual([]);
    expect(result.current.run).toBeNull();
    expect(result.current.gates).toEqual([]);
  });

  it('las cuatro lecturas de adentro del run tambien se reportan', async () => {
    mocks.getCoordinationRun.mockResolvedValue(run());
    mocks.listCoordinationGates.mockRejectedValue(boom('gates'));
    mocks.listCoordinationLog.mockRejectedValue(boom('log'));
    mocks.listCoordinationHires.mockRejectedValue(boom('hires'));
    mocks.listOpenCoordinationAsks.mockRejectedValue(boom('asks'));
    const onError = vi.fn();

    const { result } = renderHook(() => useCoordination('w1', onError));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(4));
    expect(onError.mock.calls.map(([e]) => (e as Error).message).sort())
      .toEqual(['falla de asks', 'falla de gates', 'falla de hires', 'falla de log']);
    expect(result.current.gates).toEqual([]);
    expect(result.current.log).toEqual([]);
    // Y la pantalla igual termino de cargar: un error no puede dejar la
    // visita colgada para siempre.
    expect(result.current.workLoaded).toBe(true);
  });

  it('la tira global tambien reporta, y se queda vacia en vez de vieja', async () => {
    mocks.listActiveCoordinationRuns.mockRejectedValue(boom('strip'));
    const onError = vi.fn();

    const { result } = renderHook(() => useCoordination(null, onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'falla de strip' })));
    expect(result.current.activeRuns).toEqual([]);
  });
});

/**
 * N9 (ronda 7): `mutate` NUNCA RECHAZA — TAMPOCO POR SU PROPIO `.finally`.
 *
 * El contrato escrito arriba de `mutate` es "nunca rechaza: `true` si el
 * backend resolvió, `false` si falló". El cuerpo del `.finally` lo rompía: un
 * throw SINCRÓNICO en `refreshActiveRuns`/`refreshWork` rechaza la promesa que
 * `.finally` devuelve aunque el `.then` haya resuelto `true`. `confirmEdit` lo
 * lee como "el motor rechazó" y deja el editor abierto sobre una aprobación
 * QUE SÍ ENTRÓ: la persona vuelve a apretar y aprueba dos veces.
 */
describe('N9: un refresco caído no puede desmentir una mutación que entró', () => {
  it('con `listActiveCoordinationRuns` tirando en seco, `resolveGate` igual devuelve `true`', async () => {
    const { result } = renderHook(() => useCoordination('w1', () => {}));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
    // El refresco del `.finally` explota SINCRÓNICAMENTE, que es el caso que
    // una promesa rechazada no cubre.
    mocks.listActiveCoordinationRuns.mockImplementation(() => { throw new Error('el refresco explotó'); });

    await expect(result.current.resolveGate('g1', 'approve')).resolves.toBe(true);
  });

  it('y cuando el backend SÍ falla sigue devolviendo `false`, no una promesa rechazada', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useCoordination('w1', onError));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
    mocks.resolveCoordinationGate.mockRejectedValue(new Error('el motor rechazó'));
    mocks.listActiveCoordinationRuns.mockImplementation(() => { throw new Error('el refresco explotó'); });

    await expect(result.current.resolveGate('g1', 'approve')).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'el motor rechazó' }));
  });
});

/**
 * M10 (ronda 8): LOS TRES PASOS DEL `.finally`, CADA UNO EN SU PROPIO `try`.
 *
 * N9 puso las tres llamadas del `.finally` bajo UN solo `try`: limpiar
 * `pending[key]`, refrescar la tira global y refrescar el Trabajo. Un throw
 * síncrono en cualquiera se llevaba puestas a las siguientes. Hoy el orden
 * salva a `setPending` por accidente —está primera—, y eso es exactamente el
 * tipo de garantía que se pierde la próxima vez que alguien reordena: si
 * limpiar el pendiente fallara, el botón quedaba deshabilitado PARA SIEMPRE y
 * la persona se quedaba sin poder resolver la decisión.
 *
 * Los tres son independientes: ninguno necesita que el anterior haya salido
 * bien.
 */
describe('M10: un paso caído del `.finally` no se lleva puestos a los otros', () => {
  it('si la tira global explota, el refresco del Trabajo corre igual', async () => {
    const { result } = renderHook(() => useCoordination('w1', () => {}));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
    mocks.listActiveCoordinationRuns.mockImplementation(() => { throw new Error('el refresco explotó'); });
    mocks.getCoordinationRun.mockClear();

    await expect(result.current.resolveGate('g1', 'approve')).resolves.toBe(true);

    // El tercer paso del `.finally`: sin él, la pantalla se queda con el gate
    // que la persona acaba de resolver dibujado hasta el próximo evento.
    expect(mocks.getCoordinationRun).toHaveBeenCalledWith('w1');
  });

  it('y el pendiente queda limpio igual: el botón no se traba por un refresco caído', async () => {
    const { result } = renderHook(() => useCoordination('w1', () => {}));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
    mocks.listActiveCoordinationRuns.mockImplementation(() => { throw new Error('el refresco explotó'); });

    await expect(result.current.resolveGate('g2', 'approve')).resolves.toBe(true);

    await waitFor(() => expect(result.current.pending['gate:g2']).toBeUndefined());
  });

  it('y si el refresco del Trabajo explota, la tira global ya se había refrescado', async () => {
    const { result } = renderHook(() => useCoordination('w1', () => {}));
    await waitFor(() => expect(result.current.workLoaded).toBe(true));
    mocks.listActiveCoordinationRuns.mockClear();
    mocks.getCoordinationRun.mockImplementation(() => { throw new Error('el Trabajo explotó'); });

    await expect(result.current.resolveGate('g3', 'approve')).resolves.toBe(true);

    expect(mocks.listActiveCoordinationRuns).toHaveBeenCalled();
    await waitFor(() => expect(result.current.pending['gate:g3']).toBeUndefined());
  });
});
