import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q6: `latte_ask_status` NUNCA INFORMABA UN VENCIMIENTO.
 *
 * Devolvía `expiredAt: ask.answeredAt`, o sea el instante en que ALGUIEN cerró
 * la pregunta. Y al que la cierra por vencimiento es al barrido, que corre en
 * los caminos de escritura: un agente que pregunta y después sólo consulta
 * —que es exactamente para lo que existe esta herramienta— leía `expiredAt:
 * null` para siempre y se quedaba esperando una respuesta cuyo plazo había
 * pasado hacía horas. Lo que hace que una pregunta esté vencida es su PLAZO,
 * no que alguien haya pasado a anotarlo.
 *
 * Con Q7 esto dejó de ser un detalle: las lecturas ya no escriben, así que
 * entre dos ticks nadie iba a anotar nada.
 */
describe('Q6: una pregunta vencida se informa como vencida, la haya cerrado alguien o no', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  const TZERO = new Date('2026-09-18T10:00:00.000Z');

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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TZERO);
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
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); b.cleanup(); });

  async function askSomething(ttlMinutes: number): Promise<string> {
    const asked = envelope(await call('latte_ask', { question: '¿lo publicamos?', ttlMinutes }));
    expect(asked.ok).toBe(true);
    return (asked.data as { askId: string }).askId;
  }

  it('con el plazo pasado y nadie que haya anotado el cierre, `expiredAt` ya viene', async () => {
    const askId = await askSomething(30);
    const before = envelope(await call('latte_ask_status', { askId })).data as { answered: boolean; expiredAt: string | null };
    expect(before.answered).toBe(false);
    expect(before.expiredAt).toBeNull(); // todavía vigente

    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    // Nadie barrió: la fila sigue abierta en la base.
    expect(b.repo.listOpenCoordinationAsks(runId)).toHaveLength(1);

    const after = envelope(await call('latte_ask_status', { askId })).data as { answered: boolean; answer: string | null; deadline: string; expiredAt: string | null };

    expect(after.answered).toBe(false);
    expect(after.answer).toBeNull();
    expect(after.expiredAt).not.toBeNull();
    // Y el instante que se informa es el del PLAZO, que es lo que venció.
    expect(after.expiredAt).toBe(after.deadline);
  });

  it('una pregunta ya cerrada por el barrido sigue informando su vencimiento', async () => {
    const askId = await askSomething(30);
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    b.service.sweepCoordination();

    const status = envelope(await call('latte_ask_status', { askId })).data as { answered: boolean; expiredAt: string | null };

    expect(status.answered).toBe(false);
    expect(status.expiredAt).not.toBeNull();
  });

  it('una contestada NO se informa como vencida aunque el plazo haya pasado', async () => {
    const askId = await askSomething(30);
    await b.service.answerCoordinationAsk(askId, 'sí, dale');
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));

    const status = envelope(await call('latte_ask_status', { askId })).data as { answered: boolean; answer: string | null; expiredAt: string | null };

    expect(status.answered).toBe(true);
    expect(status.answer).toBe('sí, dale');
    expect(status.expiredAt).toBeNull();
  });
});
