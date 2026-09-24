import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * B5.1: un turno que termina sin `latte_report` no queda en vuelo para siempre.
 *
 * Lo que pasó de verdad (run `crn_3f40b0633ab99bf4636b`): el motor contrató a
 * un miembro de paid-media, le mandó la tarea, el worker HIZO el trabajo
 * —escribió el archivo en la carpeta del Trabajo— y terminó su turno sin
 * reportar. Como el miembro seguía vivo, el barrido de despachos viejos (que
 * sólo alcanza a las filas SIN dueño) nunca lo miró: el despacho quedó
 * `dispatched` para siempre, el run `running` eterno, y el coordinador esperó
 * un reporte que no iba a llegar nunca.
 *
 * Todo entra por el camino de producción: la tarea se crea y se despacha por
 * las herramientas MCP del coordinador, y el fin del turno llega por
 * `b.emitChat` —el chokepoint por el que pasa TODO evento de adaptador—, que
 * es exactamente por donde llegaría el `status:'idle'` de un agente real.
 */
describe('B5.1: el turno que termina sin reportar', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let sent: ReturnType<typeof fakeCoordinationHub>['send'];
  let logLines: string[];

  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: Record<string, unknown>, token: string) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  /** El fin de un turno, tal como lo publica un adaptador de verdad. */
  function turnEnded(memberId: string): void {
    const member = members.find((m) => m.id === memberId);
    if (member) member.status = 'idle';
    b.emitChat({ chatId: memberId, type: 'status', status: 'idle', detail: '' });
  }

  async function dispatchViaMcp(roleId: string, coordinatorToken: string): Promise<{ taskId: string; memberId: string; dispatchId: string }> {
    const created = envelope(await call('latte_task_create', { roleId, spec: 'Piezas para producción\nsegunda línea' }, coordinatorToken));
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    const dispatched = envelope(await call('latte_dispatch', { taskId }, coordinatorToken));
    expect(dispatched.ok).toBe(true);
    const row = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId && d.status === 'dispatched')!;
    return { taskId, memberId: row.memberId, dispatchId: row.id };
  }

  /** El escenario común: run activo, coordinador con permiso, un worker con su tarea YA enviada. */
  async function setUp(): Promise<{ taskId: string; memberId: string; dispatchId: string; coordinatorToken: string }> {
    fakeCoordinationHub(b, members);
    sent = vi.mocked(b.hub.send);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');
    const dispatch = await dispatchViaMcp('role_a', coordinatorToken);
    sent.mockClear();
    return { ...dispatch, coordinatorToken };
  }

  /** Lo que el motor le mandó a ese miembro desde el último `mockClear`. */
  function messagesTo(memberId: string): string[] {
    return sent.mock.calls.filter((c) => c[0] === memberId).map((c) => String(c[1]));
  }

  beforeEach(async () => {
    logLines = [];
    b = await makeBackend({ log: (line: string) => logLines.push(line) });
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('primer turno sin reporte: un aviso que dice exactamente qué llamar; el despacho sigue en vuelo', async () => {
    const { taskId, memberId, dispatchId } = await setUp();

    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();

    const notices = messagesTo(memberId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('latte_report');
    expect(notices[0]).toContain(taskId);
    expect(notices[0]).toContain('Piezas para producción'); // el título de la tarea, no un id pelado
    expect(notices[0]).toContain('files'); // "si le dejaste trabajo a otro rol, decilo"
    // Un aviso no liquida nada: la tarea sigue siendo suya.
    expect(b.repo.getCoordinationDispatch(dispatchId).status).toBe('dispatched');
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(0);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(logLines.some((l) => l.includes('turn ended without report') && l.includes(dispatchId))).toBe(true);
  });

  it('segundo turno sin reporte: liquidado con motivo `no_report`, intento cobrado, coordinador avisado', async () => {
    const { taskId, memberId, dispatchId } = await setUp();

    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();
    sent.mockClear();
    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();

    const settled = b.repo.getCoordinationDispatch(dispatchId);
    expect(settled.status).toBe('cancelled');
    expect(settled.outcome).toBe('no_report'); // el motivo, VISIBLE en la bitácora
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(1); // el intento se cobra
    const toCoordinator = messagesTo('mem_coordinator');
    expect(toCoordinator).toHaveLength(1);
    expect(toCoordinator[0]).toContain(taskId);
    expect(toCoordinator[0]).toContain('no_report');
    expect(messagesTo(memberId)).toHaveLength(0); // al miembro no se le insiste una tercera vez
    expect(logLines.some((l) => l.includes('reason=no_report') && l.includes(dispatchId))).toBe(true);
  });

  it('CANDADO: un `latte_ask` abierto de ese miembro es ocio legítimo — no hay aviso', async () => {
    const { taskId, memberId } = await setUp();
    const workerToken = b.coordinationTokens.mint(workId, memberId);
    expect(envelope(await call('latte_ask', { question: '¿Con qué presupuesto?', taskId }, workerToken)).ok).toBe(true);
    sent.mockClear();

    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();

    expect(messagesTo(memberId)).toHaveLength(0);
  });

  it('CANDADO: el `idle` del spawn no dispara nada — todavía no le mandaron ninguna tarea', async () => {
    fakeCoordinationHub(b, members);
    sent = vi.mocked(b.hub.send);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    sent.mockClear();

    // Recién contratado/abierto: el hub publica su `idle` ANTES de que exista
    // tarea alguna para él. Dos turnos así no pueden liquidar nada.
    turnEnded('mem_a1');
    await Promise.resolve();
    turnEnded('mem_a1');
    await Promise.resolve();

    expect(sent).not.toHaveBeenCalled();
  });

  it('CANDADO: el coordinador termina su turno sin reportar todo el tiempo — nunca se lo empuja', async () => {
    const { coordinatorToken } = await setUp();
    // El coordinador se despacha una tarea a sí mismo: el único modo de que
    // tenga una fila en vuelo a su nombre.
    members.push({ id: 'mem_coordinator_worker', workId, roleId: 'strategist', status: 'idle' });
    approveCoordinationRoles(b, runId, 'role_a', 'strategist');
    const created = envelope(await call('latte_task_create', { roleId: 'strategist', spec: 'consolidar' }, coordinatorToken));
    const selfTask = (created.data as { taskId: string }).taskId;
    expect(envelope(await call('latte_dispatch', { taskId: selfTask }, coordinatorToken)).ok).toBe(true);
    const row = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === selfTask && d.status === 'dispatched')!;
    b.repo.setMeta('coordination_coordinator:' + workId, row.memberId); // ahora el que tiene la tarea ES el coordinador
    sent.mockClear();

    turnEnded(row.memberId);
    await Promise.resolve();
    turnEnded(row.memberId);
    await Promise.resolve();

    expect(messagesTo(row.memberId)).toHaveLength(0);
    expect(b.repo.getCoordinationDispatch(row.id).status).toBe('dispatched');
  });

  it('CANDADO: con el run cerrado no se avisa ni se liquida nada', async () => {
    const { memberId, dispatchId } = await setUp();
    await b.service.cancelCoordinationRun(runId);
    sent.mockClear();
    const statusBefore = b.repo.getCoordinationDispatch(dispatchId).status;

    turnEnded(memberId);
    await Promise.resolve();
    turnEnded(memberId);
    await Promise.resolve();

    expect(messagesTo(memberId)).toHaveLength(0);
    expect(b.repo.getCoordinationDispatch(dispatchId).status).toBe(statusBefore);
  });

  it('un `latte_report` normal después del aviso cierra todo como siempre: el nudge no deja residuo', async () => {
    const { taskId, memberId, dispatchId } = await setUp();

    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();
    expect(messagesTo(memberId)).toHaveLength(1);

    const workerToken = b.coordinationTokens.mint(workId, memberId);
    expect(envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }, workerToken)).ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('done');
    sent.mockClear();

    // El fin del turno en el que reportó: nada que empujar, nada que liquidar.
    turnEnded(memberId);
    await Promise.resolve();
    turnEnded(memberId);
    await Promise.resolve();

    expect(messagesTo(memberId)).toHaveLength(0);
    expect(b.repo.getCoordinationDispatch(dispatchId).outcome).not.toBe('no_report');
  });

  /**
   * O3: EL TURNO QUE TERMINA CON UNA PREGUNTA A LA PERSONA, EN PROSA.
   *
   * Lo que vio el dueño (2026-09-24): Paid Media cerró su chat con "El próximo
   * paso sigue siendo que decidas cómo darme ese acceso: ¿un conector de Meta
   * de sólo lectura o los exports?" sin `latte_ask`. Sin tarjeta, sin badge,
   * sin "te necesita": la pregunta no le llegó a nadie. El aviso de "terminaste
   * sin reportar" es el momento de decirle cuál es el canal.
   */
  function lastReply(memberId: string, text: string): void {
    vi.spyOn(b.hub, 'listMessages').mockImplementation((chatId: string) => chatId !== memberId ? [] : [
      { id: 'u1', chatId, role: 'user', parts: [{ type: 'text', id: 'p0', text: 'Tu tarea…' }], createdAt: '2026-09-24T10:00:00.000Z', completed: true, error: null },
      { id: 'a1', chatId, role: 'assistant', parts: [{ type: 'text', id: 'p1', text }], createdAt: '2026-09-24T10:05:00.000Z', completed: true, error: null },
    ]);
  }

  it('O3: si el turno terminó con una pregunta, el aviso le dice que la haga con `latte_ask` y que reporte', async () => {
    const { memberId, taskId } = await setUp();
    lastReply(memberId, 'Dejé el diagnóstico en el archivo.\r\n\r\nEl próximo paso sigue siendo que decidas cómo darme ese acceso: ¿un conector de Meta de sólo lectura o los exports de la sección 1.5?\r\n');

    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();

    const notice = messagesTo(memberId)[0] ?? '';
    const lines = notice.split(/\r?\n/);
    expect(lines.some((l) => /question for the person/i.test(l) && l.includes('`latte_ask`')), notice).toBe(true);
    expect(lines.some((l) => /`"failed"`/.test(l) && /latte_ask/.test(l)), notice).toBe(true);
    // Y sigue siendo el aviso de siempre: qué reportar y sobre qué tarea.
    expect(notice).toContain('latte_report');
    expect(notice).toContain(taskId);
  });

  it('O3: una pregunta con el signo de apertura solo (`¿`) también cuenta', async () => {
    const { memberId } = await setUp();
    lastReply(memberId, 'Listo el borrador.\n¿Lo querés con la tabla de pauta al final');
    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();
    expect(messagesTo(memberId)[0]).toContain('`latte_ask`');
  });

  it('O3: un turno que NO termina en pregunta recibe el aviso de siempre, sin la línea de `latte_ask`', async () => {
    const { memberId } = await setUp();
    lastReply(memberId, '¿Qué hice? Dejé el archivo listo.\nQuedó en la carpeta del Trabajo.');
    turnEnded(memberId);
    await Promise.resolve();
    await Promise.resolve();
    const notice = messagesTo(memberId)[0] ?? '';
    expect(notice).toContain('latte_report');
    expect(notice).not.toContain('latte_ask');
  });
});
