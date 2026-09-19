import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R7: LA RESPUESTA A UN `latte_ask` LE LLEGA A ALGUIEN.
 *
 * Preguntar estaba construido de punta a punta —la tool, el estado `blocked`,
 * la suspensión del run, la pantalla para contestar— y la respuesta no salía
 * de la base. El re-despacho armaba el prompt con `editedPrompt ??
 * existingPending.prompt ?? task.spec`: el agente volvía a recibir su tarea
 * EXACTAMENTE igual que la primera vez, sin una palabra de lo que preguntó ni
 * de lo que le contestaron. Y para una pregunta SIN tarea no había nada: no
 * existía `latte_ask_status` y `latte_check` devuelve `[]` por diseño.
 *
 * Dos caminos, los dos por el servidor MCP que construye `createBackend`:
 *   (a) la tarea que vuelve a la cola se despacha con la pregunta y la
 *       respuesta adentro del prompt;
 *   (b) el coordinador consulta su pregunta suelta con `latte_ask_status`.
 */
describe('R7: la respuesta a una pregunta vuelve al agente', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown, token = coordinatorToken) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- (a) el prompt del re-despacho lleva la pregunta y la respuesta --------

  it('la tarea que vuelve a la cola se despacha con la pregunta y su respuesta en el prompt', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'Escribí el post de lanzamiento' }));
    const taskId = (created.data as { taskId: string }).taskId;
    // La pregunta traba una tarea que TODAVÍA está en la cola (`ready`), que es
    // el único caso en que `blocked` significa algo: una tarea ya despachada
    // sigue en vuelo y su reporte tiene que poder entrar.
    const asked = envelope(await call('latte_ask', { question: '¿Lo firmamos con el nombre de la marca?', taskId }));
    expect(asked.ok).toBe(true);
    const askId = (asked.data as { askId: string }).askId;
    expect(askId).toMatch(/^cak_/);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('blocked');
    // La persona contesta por IPC y la tarea vuelve a la cola.
    await b.service.answerCoordinationAsk(askId, 'Sí, con el nombre completo y sin hashtags');
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');
    send.mockClear();

    expect(envelope(await call('latte_dispatch', { taskId })).ok).toBe(true);

    expect(send.mock.calls).toHaveLength(1);
    const prompt = send.mock.calls[0][1];
    expect(prompt).toContain('Escribí el post de lanzamiento'); // la tarea original sigue entera
    expect(prompt).toContain('¿Lo firmamos con el nombre de la marca?');
    expect(prompt).toContain('Sí, con el nombre completo y sin hashtags');
  });

  it('una tarea sin preguntas contestadas se despacha con su spec y nada más', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'Escribí el post' }));
    const taskId = (created.data as { taskId: string }).taskId;

    await call('latte_dispatch', { taskId });

    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0][1]).toBe('Escribí el post');
  });

  // --- (b) `latte_ask_status`, para la pregunta que no traba ninguna tarea ---

  it('`latte_ask_status` responde sin responder, y con la respuesta una vez contestada', async () => {
    const asked = envelope(await call('latte_ask', { question: '¿Publicamos hoy o mañana?' }));
    expect(asked.ok).toBe(true);
    const askId = (asked.data as { askId: string }).askId;

    const before = envelope(await call('latte_ask_status', { askId }));
    expect(before.ok).toBe(true);
    expect(before.data).toMatchObject({ answered: false, answer: null, expiredAt: null });

    await b.service.answerCoordinationAsk(askId, 'Mañana a la mañana');
    const after = envelope(await call('latte_ask_status', { askId }));

    expect(after.ok).toBe(true);
    expect(after.data).toMatchObject({ answered: true, answer: 'Mañana a la mañana', expiredAt: null });
  });

  it('una pregunta vencida se lee como SIN responder, y dice cuándo venció', async () => {
    const asked = envelope(await call('latte_ask', { question: '¿Seguimos?', ttlMinutes: 1 }));
    const askId = (asked.data as { askId: string }).askId;
    // El plazo pasa: se cierra sin respuesta, que es exactamente lo que pasó.
    b.repo.expireCoordinationAsk(askId, '2999-01-01T00:00:00.000Z');

    const status = envelope(await call('latte_ask_status', { askId }));

    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ answered: false, answer: null, expiredAt: '2999-01-01T00:00:00.000Z' });
  });

  it('una pregunta de OTRO Trabajo no se puede leer con este token', async () => {
    const otherBrand = await b.service.createBrand('Otra marca');
    const otherWork = await b.service.createWork(otherBrand.id, 'Otro trabajo');
    await b.service.setCoordinationBudget(otherWork.id, { maxDispatches: 5 });
    b.repo.setMeta('coordination_coordinator:' + otherWork.id, 'mem_otro');
    const otherRun = await b.service.startCoordinationRun(otherWork.id);
    const foreign = b.service.coordinationEngine.ask(
      { workId: otherWork.id, runId: otherRun.id, memberId: 'mem_otro', role: 'coordinator' },
      'Un secreto de la otra marca',
    );

    const status = envelope(await call('latte_ask_status', { askId: foreign.id }));

    expect(status.ok).toBe(false);
    expect(status.error?.code).toBe('NOT_FOUND');
    expect(JSON.stringify(status)).not.toContain('Un secreto de la otra marca');
  });
});
