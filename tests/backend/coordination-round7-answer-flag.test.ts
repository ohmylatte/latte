import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 7, N6: CONTESTAR NO ENCIENDE CON EL INTERRUPTOR APAGADO.
 *
 * O4 ya había decidido esto y lo aplicó en dos lugares: `resumeRun` (rechaza) y
 * el tick (`refreshAsks`, que con la bandera baja sólo cierra y vence, nunca
 * reactiva). `answerAsk` se quedó afuera: escribía `running` sobre un run
 * suspendido sin mirar la bandera, así que contestar una pregunta reactivaba
 * un equipo que el interruptor promete detenido — y por un camino que la
 * persona no asocia con "encender".
 *
 * La respuesta SÍ se guarda: apagar la coordinación no puede hacer que se
 * pierda lo que alguien escribió. Lo que no pasa es la reactivación.
 */
describe('Ronda 7 / N6: `answerAsk` con la bandera abajo', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

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
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  /** Un run suspendido por `all_blocked_on_ask`: una tarea, una pregunta encima. */
  async function suspendedOnAsk(): Promise<string> {
    const token = b.coordinationTokens.mint(workId, 'mem_coordinator');
    const rpc = (name: string, args: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const call = async (name: string, args: unknown) => {
      const result = await b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
      const parsed = JSON.parse(result.body) as { result: { structuredContent: { ok: boolean; data?: unknown } } };
      expect(parsed.result.structuredContent.ok).toBe(true);
      return parsed.result.structuredContent.data as Record<string, unknown>;
    };
    const created = await call('latte_task_create', { roleId: 'role_a', spec: 'la que espera una respuesta' });
    const asked = await call('latte_ask', { question: '¿qué tono?', taskId: created.taskId, ttlMinutes: 120 });
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended'); // la premisa
    expect(run.suspendReason).toBe('all_blocked_on_ask');
    return String(asked.askId);
  }

  it('con la bandera abajo la respuesta se guarda, pero el run NO vuelve a `running`', async () => {
    const askId = await suspendedOnAsk();

    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');
    await b.service.answerCoordinationAsk(askId, 'Cercano y directo');

    // Lo que la persona escribió está guardado: apagar no borra.
    expect(b.repo.getCoordinationAsk(askId).answer).toBe('Cercano y directo');
    expect(b.repo.getCoordinationAsk(askId).answeredAt).not.toBeNull();
    // Y el equipo sigue detenido, que es lo que el interruptor promete.
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
  });

  it('con la bandera arriba, la misma respuesta sí lo reactiva', async () => {
    const askId = await suspendedOnAsk();

    await b.service.answerCoordinationAsk(askId, 'Cercano y directo');

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  it('y con la bandera abajo, volver a prenderla y barrer lo reactiva: no quedó trabado para siempre', async () => {
    const askId = await suspendedOnAsk();
    b.repo.setMeta(FEATURE_KEYS.coordination, 'off');
    await b.service.answerCoordinationAsk(askId, 'Cercano y directo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');

    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.service.sweepCoordination();

    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });
});
