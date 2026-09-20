import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 8 (M9): UN MOTIVO DE SUSPENSIÓN QUE DICE LA VERDAD.
 *
 * `answerAsk` levanta la suspensión `all_blocked_on_ask` cuando el cálculo que
 * la decidió deja de ser cierto — salvo con `feature:coordination` apagada,
 * donde N6 decidió, con razón, que contestar no puede ENCENDER un equipo.
 *
 * Pero la fila quedaba con `suspendReason: 'all_blocked_on_ask'` cuando eso ya
 * era FALSO: la pregunta está contestada y hay tareas despachables. El motivo
 * que la persona ve —y del que depende `listGates` para no inventar una
 * decisión de presupuesto— mentía sobre por qué el equipo está detenido. Lo
 * detiene el interruptor, no las preguntas.
 */
describe('Ronda 8 / M9: con el flag apagado, el motivo de suspensión es el flag', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  async function createTask(spec: string): Promise<string> {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec }));
    expect(created.ok, spec).toBe(true);
    return (created.data as { taskId: string }).taskId;
  }

  /** Deja el run `suspended` con `all_blocked_on_ask` y devuelve el id de la pregunta que lo traba. */
  async function suspendOnAsk(): Promise<string> {
    const task = await createTask('la única, trabada por una pregunta');
    const asked = envelope(await call('latte_ask', { question: '¿seguimos?', taskId: task, ttlMinutes: 120 }));
    expect(asked.ok).toBe(true);
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('all_blocked_on_ask');
    return (asked.data as { askId: string }).askId;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_worker', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('con la bandera ARRIBA, contestar levanta la suspensión (la premisa)', async () => {
    const askId = await suspendOnAsk();
    await b.service.answerCoordinationAsk(askId, 'sí, seguimos');
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('running');
    expect(run.suspendReason).toBeNull();
  });

  it('con la bandera ABAJO, el equipo sigue detenido pero el motivo es el interruptor', async () => {
    const askId = await suspendOnAsk();
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');

    await b.service.answerCoordinationAsk(askId, 'sí, seguimos');

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended'); // N6: contestar no enciende
    expect(run.suspendReason).toBe('coordination_disabled'); // …y lo dice
  });

  it('ese motivo NO inventa una decisión de presupuesto en Decisiones', async () => {
    const askId = await suspendOnAsk();
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');
    await b.service.answerCoordinationAsk(askId, 'sí, seguimos');

    const gates = await b.service.listCoordinationGates(runId);
    expect(gates.filter((g) => g.kind === 'budget')).toEqual([]);
  });

  it('y cuando la bandera vuelve a subir, el tick lo reactiva: el motivo dejó de ser cierto', async () => {
    const askId = await suspendOnAsk();
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');
    await b.service.answerCoordinationAsk(askId, 'sí, seguimos');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('coordination_disabled');

    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.service.sweepCoordination();

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('running');
    expect(run.suspendReason).toBeNull();
  });

  /**
   * L3 (ronda 9): CON LA BANDERA ABAJO, EL MOTIVO ES LA BANDERA, aunque las
   * preguntas también traben.
   *
   * La ronda 8 leía este caso al revés: dejaba `all_blocked_on_ask` porque
   * "sigue trabado de verdad". Las dos cosas son ciertas, y por eso el orden
   * importa — el motivo tiene UNA sola línea y la persona lee ahí qué hacer.
   * Contestar todas las preguntas con la bandera abajo no reactiva nada: lo
   * que detiene al equipo, y lo único que puede soltarlo, es el interruptor.
   */
  it('con la bandera abajo el motivo es el interruptor, aunque otra pregunta siga trabando todo', async () => {
    // La pregunta general (sin tarea) no traba nada, así que contestarla no
    // cambia el cálculo: la única tarea sigue esperando SU respuesta.
    const task = await createTask('la única');
    const general = envelope(await call('latte_ask', { question: '¿el tono sigue igual?', ttlMinutes: 120 }));
    expect(general.ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // la premisa: todavía no traba nada
    expect(envelope(await call('latte_ask', { question: '¿esta la hacemos?', taskId: task, ttlMinutes: 120 })).ok).toBe(true);
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');

    await b.service.answerCoordinationAsk((general.data as { askId: string }).askId, 'sí');

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('coordination_disabled');
    // Y cuando la bandera vuelve, el motivo vuelve a ser el que sigue siendo
    // cierto: la pregunta que todavía traba la única tarea.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.service.sweepCoordination();
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('all_blocked_on_ask');
  });
});
