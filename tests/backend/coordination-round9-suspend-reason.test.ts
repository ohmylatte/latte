import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_OFF, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 9 (L3): EL MOTIVO DE SUSPENSIÓN SE CALCULA EN UN SOLO LUGAR.
 *
 * Había dos fórmulas parciales y ninguna completa. `answerAsk` sabía renombrar
 * a `coordination_disabled` con la bandera abajo; `refreshAsks` sólo sabía
 * REACTIVAR, y sólo con la bandera arriba: sin rama `else`, un vencimiento con
 * la bandera abajo dejaba la fila diciendo `all_blocked_on_ask` cuando ya no
 * quedaba una sola pregunta esperando, y una bandera que vuelve con preguntas
 * NUEVAS dejaba la fila diciendo `coordination_disabled` cuando lo que
 * detenía al equipo ya eran las preguntas.
 *
 * `reconcileSuspendReason` es la fórmula entera, y la llaman los cuatro
 * caminos que pueden cambiar la respuesta.
 */
describe('Ronda 9: el motivo de suspensión se calcula en un solo lugar', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let token: string;
  let enabled: boolean;

  const T0 = '2026-09-19T10:00:00.000Z';
  const at = (minutes: number) => new Date(new Date(T0).getTime() + minutes * 60_000);

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  const call = (name: string, args: unknown) =>
    b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');

  async function createTask(spec: string): Promise<string> {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec }));
    expect(created.ok, spec).toBe(true);
    return (created.data as { taskId: string }).taskId;
  }

  const run = () => b.repo.getCoordinationRun(runId);

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    enabled = true;
    // La bandera se lee a través de una función del motor, así que el test la
    // maneja como la maneja la app: encendida al arrancar, y bajada a mano.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    const meta = b.repo.getMeta.bind(b.repo);
    vi.spyOn(b.repo, 'getMeta').mockImplementation((key: string) =>
      // 1.2.0 (R1): la fila ausente ya no apaga nada. Bajar la bandera en
      // este fake es devolver el `off` explícito, el mismo que guarda Ajustes.
      (key === FEATURE_KEYS.coordination && !enabled ? FEATURE_OFF : meta(key)));
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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); b.cleanup(); });

  /** Deja el run `suspended` por `all_blocked_on_ask`: una sola tarea, trabada por una pregunta. */
  async function suspendOnAsk(ttlMinutes: number): Promise<string> {
    const taskId = await createTask('la única que hay');
    expect(envelope(await call('latte_ask', { question: '¿y esto?', taskId, ttlMinutes })).ok).toBe(true);
    expect(run().status).toBe('suspended');
    expect(run().suspendReason).toBe('all_blocked_on_ask');
    return taskId;
  }

  it('la pregunta se vence con la bandera abajo: el motivo pasa a ser el interruptor, que es el que ahora lo detiene', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    await suspendOnAsk(60);

    enabled = false;
    vi.setSystemTime(at(61)); // la pregunta venció: ya no espera a nadie
    b.service.sweepCoordination();

    // ASSERT DESPUÉS del punto donde `refreshAsks` se iba sin rama `else`.
    expect(run().status).toBe('suspended');
    expect(run().suspendReason).toBe('coordination_disabled');
  });

  it('la bandera vuelve con preguntas NUEVAS: el motivo vuelve a ser las preguntas', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    await suspendOnAsk(60);

    enabled = false;
    vi.setSystemTime(at(61));
    b.service.sweepCoordination();
    expect(run().suspendReason).toBe('coordination_disabled');

    // La tarea volvió a la cola al vencer la pregunta; con la bandera arriba y
    // una pregunta nueva, lo que detiene al equipo vuelve a ser la pregunta.
    enabled = true;
    const tasks = b.repo.listCoordinationTasks(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('ready');
    expect(envelope(await call('latte_ask', { question: '¿y ahora?', taskId: tasks[0]!.id, ttlMinutes: 120 })).ok).toBe(true);

    b.service.sweepCoordination();
    expect(run().status).toBe('suspended');
    expect(run().suspendReason).toBe('all_blocked_on_ask');
  });

  it('la bandera vuelve sin preguntas: el equipo vuelve a correr', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    await suspendOnAsk(60);

    enabled = false;
    vi.setSystemTime(at(61));
    b.service.sweepCoordination();
    expect(run().suspendReason).toBe('coordination_disabled');

    enabled = true;
    b.service.sweepCoordination();
    expect(run().status).toBe('running');
    expect(run().suspendReason).toBeNull();
  });

  it('`paused_by_human` no lo toca nadie: lo puso una persona y lo saca una persona', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    await createTask('la que queda en la cola');
    await b.service.pauseCoordinationRun(runId);
    expect(run().suspendReason).toBe('paused_by_human');

    enabled = false;
    b.service.sweepCoordination();
    expect(run().suspendReason).toBe('paused_by_human');
    enabled = true;
    b.service.sweepCoordination();
    expect(run().suspendReason).toBe('paused_by_human');
  });
});
