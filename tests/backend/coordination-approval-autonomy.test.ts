import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import type { CoordinationProposal } from '../../electron/coordination/engine';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * LA AUTONOMÍA QUE EL MOTOR YA TENÍA Y NADIE USABA.
 *
 * Lo que pasó en uso real: la persona pide "coordiná al equipo", la propuesta
 * aparece en Decisiones, la aprueba, y después SILENCIO. El coordinador no se
 * entera de que aprobaron. Cuando la persona se lo dice por chat, el agente
 * arranca y VUELVE A CREAR las tareas —no tiene ninguna herramienta para ver
 * las que `commitProposal` ya creó: `latte_check` devuelve `[]` por diseño—, y
 * como esas tareas nuevas nacen con `inPlan:false` bajo autoridad `plan`, cada
 * despacho abre un gate. El agente termina pidiéndole a la persona que apruebe
 * el dispatch en Latte, que es exactamente lo que la aprobación existía para
 * evitar.
 *
 * Tres piezas, todas por la capa real (IPC para aprobar, JSON-RPC sobre el
 * servidor MCP de `createBackend` para las tools):
 *   A1. aprobar AVISA al coordinador, y si está ocupado el aviso se encola;
 *   A2. `latte_task_list` le deja VER las tareas en vez de recrearlas;
 *   A5. bajo autoridad `plan` esas tareas se despachan solas; una creada fuera
 *       del plan, no.
 */
describe('al aprobar un plan, el coordinador se entera y arranca solo', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  const COORDINATOR = 'mem_coordinator';

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; authority: string; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown, token = coordinatorToken) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  function proposal(overrides: Partial<CoordinationProposal> = {}): CoordinationProposal {
    return {
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los textos del lanzamiento' },
        { roleId: 'designer', spec: 'Diseñar las piezas', dependsOn: [0] },
      ],
      estimatedDispatches: 6,
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
      rationale: 'Coordinar al equipo para el lanzamiento del mes.',
      ...overrides,
    };
  }

  /** El texto del aviso que le llegó al coordinador, o `null` si no le llegó ninguno. */
  function noticeTo(memberId = COORDINATOR): string | null {
    const calls = send.mock.calls.filter((c) => c[0] === memberId);
    return calls.length === 0 ? null : (calls[calls.length - 1][1] as string);
  }

  /** Propone y aprueba, devolviendo el id del run. */
  async function proposeAndApprove(decision: 'approve' | 'reject' = 'approve'): Promise<string> {
    const created = envelope(await call('latte_request_coordination', proposal()));
    expect(created.ok).toBe(true);
    const id = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${id}`, decision);
    return id;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 2 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    coordinatorToken = b.coordinationTokens.mint(workId, COORDINATOR);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- A1: el aviso ----------------------------------------------------------

  it('A1: aprobar le manda al coordinador la autoridad, el presupuesto, las tareas creadas y la orden de NO recrearlas', async () => {
    runId = await proposeAndApprove();
    await settle();

    const notice = noticeTo();
    expect(notice).not.toBeNull();
    expect(notice).toContain('Your plan was approved');
    // La autoridad resultante y el presupuesto, para que no tenga que adivinarlos.
    // `commitProposal` funde la estimación de la propuesta sobre el
    // presupuesto configurado: `maxDispatches` queda en 6 y `maxConcurrent`,
    // que la propuesta no toca, se preserva en 2.
    expect(notice).toContain('Authority: plan');
    expect(notice).toContain('6 dispatches');
    expect(notice).toContain('2 at a time');
    // Las tareas que `commitProposal` YA creó, con su id y su dependencia.
    const tasks = b.repo.listCoordinationTasks(runId);
    expect(tasks).toHaveLength(2);
    for (const task of tasks) expect(notice).toContain(task.id);
    expect(notice).toContain('copywriter');
    expect(notice).toContain('designer');
    // Los miembros contratados.
    for (const hired of members.filter((m) => m.id !== COORDINATOR)) expect(notice).toContain(hired.id);
    // Y la instrucción explícita, que es lo que cierra el agujero.
    expect(notice).toContain('latte_task_list');
    expect(notice).toContain('latte_dispatch');
    expect(notice).toContain('latte_task_create');
    expect(notice).toMatch(/do NOT recreate/i);
  });

  it('A1: con el coordinador ocupado el aviso se ENCOLA, y se entrega cuando su turno termina', async () => {
    members.find((m) => m.id === COORDINATOR)!.status = 'working'; // `isMemberBusy` lo lee como un turno en vuelo
    runId = await proposeAndApprove();
    await settle();

    expect(noticeTo()).toBeNull(); // nada se le mandó encima del turno en curso

    members.find((m) => m.id === COORDINATOR)!.status = 'idle';
    b.emitChat({ chatId: COORDINATOR, type: 'status', status: 'idle', detail: '' });
    await settle();

    expect(noticeTo()).toContain('Your plan was approved');
  });

  it('A1: si el `send` falla, la aprobación sigue siendo válida', async () => {
    send.mockRejectedValue(new Error('el proceso se murió'));

    runId = await proposeAndApprove();

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('running');
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(2);
  });

  it('A1: rechazar también avisa, para que el agente no espere para siempre', async () => {
    runId = await proposeAndApprove('reject');
    await settle();

    expect(noticeTo()).toContain('Your plan was rejected');
  });

  // --- A2: `latte_task_list` -------------------------------------------------

  it('A2: `latte_task_list` devuelve las tareas del run activo en vez de obligar a recrearlas', async () => {
    runId = await proposeAndApprove();
    const tasks = b.repo.listCoordinationTasks(runId);
    const first = tasks.find((t) => t.roleId === 'copywriter')!;
    const second = tasks.find((t) => t.roleId === 'designer')!;

    const result = envelope(await call('latte_task_list', {}));

    expect(result.ok).toBe(true);
    const rows = result.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === first.id)!;
    expect(a).toMatchObject({ id: first.id, roleId: 'copywriter', status: 'ready', inPlan: true, attempts: 0, assignedMemberId: null });
    expect(a.dependsOn).toEqual([]);
    expect(a.spec).toBe('Escribir los textos del lanzamiento');
    const dep = rows.find((r) => r.id === second.id)!;
    expect(dep.dependsOn).toEqual([first.id]);
  });

  it('A2: un `spec` largo se trunca, y la tool exige el grant de coordinador y un run activo', async () => {
    runId = await proposeAndApprove();
    const long = 'x'.repeat(500);
    envelope(await call('latte_task_create', { roleId: 'copywriter', spec: long }));

    const rows = envelope(await call('latte_task_list', {})).data as Array<{ spec: string }>;
    const truncated = rows.map((r) => r.spec).find((s) => s.startsWith('xxx'))!;
    expect(truncated.length).toBeLessThanOrEqual(210);
    expect(truncated.length).toBeGreaterThan(190);

    // Un worker no coordina: ni ve la lista.
    members.push({ id: 'mem_worker', workId, roleId: 'copywriter', status: 'idle' });
    const worker = envelope(await call('latte_task_list', {}, b.coordinationTokens.mint(workId, 'mem_worker')));
    expect(worker.ok).toBe(false);
    expect(worker.error?.code).toBe('FORBIDDEN');
  });

  it('A2: sin run activo la tool responde NO_ACTIVE_RUN, no una lista vacía', async () => {
    const result = envelope(await call('latte_task_list', {}));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_ACTIVE_RUN');
  });

  // --- A5: la autoridad, de punta a punta ------------------------------------

  it('A5: bajo autoridad `plan`, una tarea del plan se despacha sin gate y una creada fuera del plan lo abre', async () => {
    runId = await proposeAndApprove();
    expect(b.repo.getMeta('coordination_authority:' + workId)).toBe('plan');

    const planned = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'copywriter')!;
    const dispatched = envelope(await call('latte_dispatch', { taskId: planned.id }));
    expect(dispatched.ok).toBe(true);
    expect((dispatched.data as { status: string }).status).toBe('dispatched');

    // Y una tarea que NO estaba en el plan aprobado sigue necesitando a la persona.
    const extra = envelope(await call('latte_task_create', { roleId: 'copywriter', spec: 'Algo que nadie aprobó' }));
    const extraId = (extra.data as { taskId: string }).taskId;
    expect(b.repo.getCoordinationTask(extraId).inPlan).toBe(false);
    const gated = envelope(await call('latte_dispatch', { taskId: extraId }));
    expect(gated.ok).toBe(true);
    expect((gated.data as { status: string }).status).toBe('pending_approval');
  });
});

/**
 * A4: LA RESPUESTA A UNA PREGUNTA LE LLEGA A QUIEN PREGUNTÓ.
 *
 * `coordination_ask` guarda `memberId`, así que la respuesta tiene destinatario
 * desde siempre: lo que faltaba era mandársela. Una pregunta CON tarea vuelve
 * en el prompt del re-despacho (R7); ésta es la del coordinador, que no está
 * despachado a nada y se quedaba puliendo `latte_ask_status` para siempre.
 */
describe('la respuesta a un `latte_ask` le llega al que preguntó', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;

  const COORDINATOR = 'mem_coordinator';

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown } };
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, COORDINATOR);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('A4: contestar le manda la respuesta al miembro que preguntó, con su pregunta adentro', async () => {
    const token = b.coordinationTokens.mint(workId, COORDINATOR);
    const asked = envelope(await b.coordinationMcpServer.handleMcpRequest(
      rpc('latte_ask', { question: '¿Publicamos el jueves o el viernes?' }), `Bearer ${token}`, '127.0.0.1'));
    const askId = (asked.data as { askId: string }).askId;

    await b.service.answerCoordinationAsk(askId, 'El jueves.');
    await settle();

    const delivered = send.mock.calls.filter((c) => c[0] === COORDINATOR).map((c) => c[1] as string).join('\n');
    expect(delivered).toContain('¿Publicamos el jueves o el viernes?');
    expect(delivered).toContain('El jueves.');
  });

  it('A4: con el miembro ocupado, la respuesta se encola y se entrega al terminar su turno', async () => {
    const token = b.coordinationTokens.mint(workId, COORDINATOR);
    const asked = envelope(await b.coordinationMcpServer.handleMcpRequest(
      rpc('latte_ask', { question: '¿Seguimos?' }), `Bearer ${token}`, '127.0.0.1'));
    const askId = (asked.data as { askId: string }).askId;
    members.find((m) => m.id === COORDINATOR)!.status = 'working';

    await b.service.answerCoordinationAsk(askId, 'Dale.');
    await settle();
    expect(send.mock.calls.filter((c) => c[0] === COORDINATOR)).toHaveLength(0);

    members.find((m) => m.id === COORDINATOR)!.status = 'idle';
    b.emitChat({ chatId: COORDINATOR, type: 'status', status: 'idle', detail: '' });
    await settle();

    expect(send.mock.calls.filter((c) => c[0] === COORDINATOR).map((c) => c[1] as string).join('\n')).toContain('Dale.');
  });
});
