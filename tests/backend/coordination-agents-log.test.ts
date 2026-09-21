import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * B5.5: EL CIRCUITO SE LEE EN `agents.log`.
 *
 * Después de la prueba real, `data/logs/agents.log` no tenía UNA SOLA línea de
 * coordinación: ni el alta, ni el despacho, ni el envío, ni el reporte, ni la
 * liquidación. Lo único que se veía era un warning de rate limit del
 * asistente. El motor ya tenía `deps.log` cableado a `backendLog` desde
 * siempre y lo usaba nada más que para errores, así que cuando algo quedaba a
 * medias —que es exactamente lo que pasó— no había dónde mirar.
 *
 * Ids, roles y estados. Nunca resúmenes, prompts ni nombres de archivo: eso
 * vive en la base y en el aviso al coordinador, no en un log de texto plano.
 */
describe('B5.5: el circuito de coordinación deja rastro en el log', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let logLines: string[];

  function rpc(name: string, args: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: Record<string, unknown>, token: string) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  const lines = (needle: string) => logLines.filter((l) => l.includes(needle));

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

  it('alta → despacho → reporte → cierre dejan sus líneas, con ids y sin contenido', async () => {
    fakeCoordinationHub(b, members);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    const token = b.coordinationTokens.mint(workId, 'mem_coordinator');

    // Sin nadie del rol en el equipo, el despacho CONTRATA: el alta es del motor.
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'un secreto que no debe aparecer en el log' }, token));
    const taskId = (created.data as { taskId: string }).taskId;
    expect(envelope(await call('latte_dispatch', { taskId }, token)).ok).toBe(true);
    const dispatch = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!;

    const hire = lines('coordination hire');
    expect(hire).toHaveLength(1);
    expect(hire[0]).toContain(dispatch.memberId);
    expect(hire[0]).toContain('role=role_a');
    expect(hire[0]).toContain(runId);

    const sent = lines('coordination dispatch sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(dispatch.id);
    expect(sent[0]).toContain(taskId);
    expect(sent[0]).toContain(dispatch.memberId);

    const workerToken = b.coordinationTokens.mint(workId, dispatch.memberId);
    expect(envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'otro secreto' }, workerToken)).ok).toBe(true);

    const report = lines('coordination report');
    expect(report).toHaveLength(1);
    expect(report[0]).toContain(dispatch.id);
    expect(report[0]).toContain(taskId);
    expect(report[0]).toContain('outcome=succeeded');

    // Era la única tarea: el run cerró solo, y eso también se lee.
    const closed = lines('coordination run closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain(runId);
    expect(closed[0]).toContain('status=done');

    // Y el aviso al coordinador dejó su propia línea, del hecho y no del texto.
    expect(lines('coordination notice').length).toBeGreaterThan(0);

    // NADA del contenido: ni el spec de la tarea ni el resumen del reporte.
    const whole = logLines.join('\n');
    expect(whole).not.toContain('un secreto que no debe aparecer en el log');
    expect(whole).not.toContain('otro secreto');
  });
});
