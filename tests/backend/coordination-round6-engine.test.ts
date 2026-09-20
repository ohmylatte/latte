import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_DISPATCH_STALE_MINUTES } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 6, lo que vive en el motor:
 *
 *  - O4: reanudar ES encender, así que el interruptor lo tiene que apagar.
 *        Cancelar sigue siendo la salida.
 *  - O6a: después de un reporte, la auto-suspensión se re-evalúa en el acto —
 *         no en el tick de 30 s.
 *  - O6b: un despacho ZOMBI (una fila `dispatched` que nunca liquida) deja de
 *         congelar "hay alguien trabajando" pasado el umbral.
 */
describe('Ronda 6: el motor', () => {
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

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto'); // sin gate por despacho
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: 'mem_worker', workId, roleId: 'role_a', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    token = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); b.cleanup(); });

  // --- O4 ---------------------------------------------------------------------

  describe('O4: reanudar con el interruptor apagado', () => {
    it('con la bandera abajo, `resumeCoordinationRun` rechaza y el run sigue suspendido; cancelar sigue funcionando', async () => {
      await b.service.pauseCoordinationRun(runId);
      expect(b.repo.getCoordinationRun(runId).status).toBe('suspended'); // la premisa

      b.repo.setMeta(FEATURE_KEYS.coordination, 'off');

      await expect(b.service.resumeCoordinationRun(runId)).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');

      // La salida sigue abierta: cancelar TERMINA trabajo, no lo empieza.
      await b.service.cancelCoordinationRun(runId);
      expect(b.repo.getCoordinationRun(runId).status).toBe('cancelled');
    });

    it('con la bandera arriba, el mismo reanudar sí enciende', async () => {
      await b.service.pauseCoordinationRun(runId);

      await b.service.resumeCoordinationRun(runId);

      expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    });
  });

  // --- O6a --------------------------------------------------------------------

  describe('O6a: el reporte re-evalúa la suspensión, sin esperar al tick', () => {
    it('la última tarea en vuelo reporta con otra trabada por una pregunta: `suspended` en el acto', async () => {
      const working = await createTask('la que se está haciendo');
      const blocked = await createTask('la que espera una respuesta');

      const dispatched = envelope(await call('latte_dispatch', { taskId: working }));
      expect(dispatched.ok).toBe(true);
      const asked = envelope(await call('latte_ask', { question: '¿qué tono?', taskId: blocked, ttlMinutes: 60 }));
      expect(asked.ok).toBe(true);
      // Con algo en vuelo, el equipo NO está bloqueado: esto es la premisa.
      expect(b.repo.getCoordinationRun(runId).status).toBe('running');

      const workerToken = b.coordinationTokens.mint(workId, 'mem_worker');
      const reported = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_report', { taskId: working, outcome: 'succeeded', summary: 'listo' }), `Bearer ${workerToken}`, '127.0.0.1',
      ));
      expect(reported.ok).toBe(true);

      // SIN un solo `sweepCoordination`.
      const run = b.repo.getCoordinationRun(runId);
      expect(run.status).toBe('suspended');
      expect(run.suspendReason).toBe('all_blocked_on_ask');
    });
  });

  // --- O6b --------------------------------------------------------------------

  describe('O6b: un despacho zombi no congela la auto-suspensión', () => {
    it('la fila en vuelo más vieja que el umbral deja de contar como trabajo vivo', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-19T10:00:00.000Z'));
      const zombie = await createTask('la que se murió sin avisar');
      const blocked = await createTask('la que espera una respuesta');
      expect(envelope(await call('latte_dispatch', { taskId: zombie })).ok).toBe(true);

      // El reloj avanza más allá del umbral: la fila sigue `dispatched`, sin
      // reporte, sin `closed`, sin barrido — exactamente el zombi.
      vi.setSystemTime(new Date(new Date('2026-09-19T10:00:00.000Z').getTime() + (IN_FLIGHT_DISPATCH_STALE_MINUTES + 5) * 60_000));
      expect(b.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched')).toHaveLength(1);

      // Y ahora la única tarea despachable se traba por una pregunta.
      expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 60 })).ok).toBe(true);

      const run = b.repo.getCoordinationRun(runId);
      expect(run.status).toBe('suspended');
      expect(run.suspendReason).toBe('all_blocked_on_ask');
    });

    it('pero un despacho RECIENTE sigue contando: el equipo con alguien trabajando no se suspende', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-19T10:00:00.000Z'));
      const working = await createTask('la que se está haciendo');
      const blocked = await createTask('la que espera una respuesta');
      expect(envelope(await call('latte_dispatch', { taskId: working })).ok).toBe(true);

      vi.setSystemTime(new Date(new Date('2026-09-19T10:00:00.000Z').getTime() + (IN_FLIGHT_DISPATCH_STALE_MINUTES - 5) * 60_000));
      expect(envelope(await call('latte_ask', { question: '¿seguimos?', taskId: blocked, ttlMinutes: 60 })).ok).toBe(true);

      expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    });
  });
});
