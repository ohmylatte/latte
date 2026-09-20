import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q5: PREGUNTAR DESDE UNA TAREA EN VUELO NO DETIENE AL EQUIPO.
 *
 * `ask()` sólo mueve a `blocked` una tarea `ready`/`pending`, y con razón: una
 * tarea despachada sigue en vuelo y su reporte tiene que poder entrar. Pero
 * `allBlockedOnAsks` contaba esa MISMA tarea como "despachable y esperando una
 * respuesta", así que `maybeSelfSuspendOnAsks` suspendía el run entero con
 * `all_blocked_on_ask` mientras el miembro estaba trabajando. Y el caso es el
 * real: el worker pregunta MIENTRAS trabaja, que es cuando le aparece la duda.
 *
 * Decisión: una tarea con un despacho vivo no se suspende. El worker sigue, y
 * consulta `latte_ask_status` cuando quiera. La descripción publicada de
 * `latte_ask` lo dice con todas las letras, porque lo que se publica es lo que
 * el agente cree.
 */
describe('Q5: una pregunta desde una tarea en vuelo', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
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
    fakeCoordinationHub(b, members);
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  /** Crea una tarea y la despacha; devuelve su id y el token del miembro que la está haciendo. */
  async function dispatchedTask(): Promise<{ taskId: string; workerToken: string }> {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'escribir el copy' }));
    const taskId = (created.data as { taskId: string }).taskId;
    await call('latte_dispatch', { taskId });
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.memberId;
    return { taskId, workerToken: b.coordinationTokens.mint(workId, memberId) };
  }

  it('la tarea sigue `dispatched` y el run sigue `running`: el miembro no se queda esperando', async () => {
    const { taskId, workerToken } = await dispatchedTask();
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');

    const asked = envelope(await call('latte_ask', { question: '¿en qué tono?', taskId }, workerToken));

    expect(asked.ok).toBe(true);
    // Lo que NO pasa: el run no se auto-suspende con el miembro trabajando.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBeNull();
    // Y la tarea sigue en vuelo: su reporte tiene que poder entrar.
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.status).toBe('dispatched');
    // La pregunta existe igual y se puede consultar.
    expect(b.repo.listOpenCoordinationAsks(runId)).toHaveLength(1);
  });

  it('y el miembro puede reportar su trabajo con la pregunta todavía abierta', async () => {
    const { taskId, workerToken } = await dispatchedTask();
    await call('latte_ask', { question: '¿en qué tono?', taskId }, workerToken);

    const reported = envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'listo' }, workerToken));

    expect(reported.ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('done');
  });

  it('sobre una tarea en cola sigue trabando como siempre: ahí sí no hay nadie trabajando', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'escribir el copy' }));
    const taskId = (created.data as { taskId: string }).taskId;
    expect(b.repo.getCoordinationTask(taskId).status).toBe('ready');

    const asked = envelope(await call('latte_ask', { question: '¿en qué tono?', taskId }));

    expect(asked.ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('blocked');
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');
  });

  it('una tarea en cola trabada NO se salva porque otra esté en vuelo: la suspensión sigue existiendo cuando corresponde', async () => {
    // Todo lo despachable trabado por preguntas, y nada en vuelo: se suspende.
    const a = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'a' }));
    const b2 = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'b' }));
    const idA = (a.data as { taskId: string }).taskId;
    const idB = (b2.data as { taskId: string }).taskId;
    await call('latte_ask', { question: 'la primera', taskId: idA });
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // queda `b` para despachar
    await call('latte_ask', { question: 'la segunda', taskId: idB });
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
  });

  /**
   * Q6 (regresión de Q5): el arreglo de Q5 excluía del conjunto elegible las
   * tareas con despacho vivo. Con UNA tarea en cola trabada y OTRA en vuelo, el
   * conjunto quedaba con la trabada sola y `every` daba verdadero: el run se
   * suspendía `all_blocked_on_ask` con un miembro trabajando. La señal correcta
   * no es excluir: es que con algo EN VUELO no se suspende nada.
   */
  it('con una tarea en cola trabada y otra en vuelo el run sigue `running`', async () => {
    const a = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'a' }));
    const idA = (a.data as { taskId: string }).taskId;
    const bTask = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'b' }));
    const idB = (bTask.data as { taskId: string }).taskId;

    await call('latte_dispatch', { taskId: idB });
    expect(b.repo.getCoordinationTask(idB).status).toBe('dispatched');

    const asked = envelope(await call('latte_ask', { question: '¿y esta?', taskId: idA }));

    expect(asked.ok).toBe(true);
    expect(b.repo.getCoordinationTask(idA).status).toBe('blocked');
    // Hay alguien trabajando: el equipo no está bloqueado.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBeNull();
  });

  it('y cuando la tarea en vuelo termina, con la otra todavía trabada, ahí sí se suspende', async () => {
    const a = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'a' }));
    const idA = (a.data as { taskId: string }).taskId;
    const bTask = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'b' }));
    const idB = (bTask.data as { taskId: string }).taskId;
    await call('latte_dispatch', { taskId: idB });
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === idB)!.memberId;
    const workerToken = b.coordinationTokens.mint(workId, memberId);
    await call('latte_ask', { question: '¿y esta?', taskId: idA });
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');

    await call('latte_report', { taskId: idB, outcome: 'succeeded', summary: 'listo' }, workerToken);
    // El reporte no escribe la suspensión; el tick, que es quien barre, sí.
    b.service.sweepCoordination();

    // Ya no queda nada en vuelo y lo único despachable sigue trabado.
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');
  });

  it('la descripción publicada de `latte_ask` dice la verdad de los dos casos', () => {
    const ask = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_ask');
    expect(ask).toBeDefined();
    const text = ask!.description;
    // En cola: se suspende hasta la respuesta.
    expect(text).toMatch(/still queued/i);
    // En vuelo: seguí trabajando, y consultá el estado.
    expect(text).toMatch(/keep working/i);
    expect(text).toContain('latte_ask_status');
    // Y la letra chica que el agente necesita: la respuesta sólo vuelve en el
    // prompt si la tarea se vuelve a despachar.
    expect(text).toMatch(/re-?dispatch/i);
  });
});
