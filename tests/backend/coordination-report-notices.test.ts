import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import type { CoordinationProposal } from '../../electron/coordination/engine';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * M1: EL COORDINADOR SE ENTERA DE LOS REPORTES, O NO CONSOLIDA NADA.
 *
 * El criterio del dueño del producto: «cada bot se concentra en lo suyo
 * aislado, otro consolida». El motor tenía despacho (coordinador → miembro) y
 * reporte (miembro → base), y ahí moría: el resultado quedaba en una fila que
 * el coordinador no tenía cómo ver —`latte_check` devolvía `[]` por diseño—,
 * así que consolidaba a ciegas o rehacía el trabajo él mismo. Y el final del
 * run tampoco se avisaba: después del último reporte venía el silencio.
 *
 * Todo por la capa real: JSON-RPC sobre el servidor MCP que arma
 * `createBackend`, IPC para lo de la persona, y el hub falso para ver qué
 * turno le llega a quién.
 */

const COORDINATOR = 'mem_coordinator';

function rpc(name: string, args: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

interface Envelope { ok: boolean; authority: string; data: unknown; error?: { code: string; message: string } }

function envelope(result: { body: string }): Envelope {
  const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
  expect(parsed.error).toBeUndefined();
  return (parsed.result as { structuredContent: Envelope }).structuredContent;
}

describe('cada reporte le llega al coordinador, y el cierre también', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  function call(name: string, args: unknown, token = coordinatorToken) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  /** Todo lo que se le mandó al coordinador, concatenado. */
  function noticesTo(memberId = COORDINATOR): string {
    return send.mock.calls.filter((c) => c[0] === memberId).map((c) => c[1] as string).join('\n---\n');
  }

  function proposal(plan: CoordinationProposal['plan'], hires: Array<{ roleId: string; why: string }>): CoordinationProposal {
    return { plan, estimatedDispatches: 8, membersToHire: hires, rationale: 'Coordinar el lanzamiento.' };
  }

  async function proposeAndApprove(p: CoordinationProposal): Promise<string> {
    expect(envelope(await call('latte_request_coordination', p)).ok).toBe(true);
    const id = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${id}`, 'approve');
    await settle();
    return id;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 3 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    coordinatorToken = b.coordinationTokens.mint(workId, COORDINATOR);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('M1: el reporte de un miembro le llega al coordinador con rol, tarea, resultado, resumen, archivos y el conteo del run', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'copywriter', spec: 'Escribir los textos' }, { roleId: 'designer', spec: 'Diseñar las piezas' }],
      [{ roleId: 'copywriter', why: 'Nadie escribe' }, { roleId: 'designer', why: 'Nadie diseña' }],
    ));
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'copywriter')!;
    expect(envelope(await call('latte_dispatch', { taskId: task.id })).ok).toBe(true);
    await settle();
    const workerId = b.repo.getCoordinationTask(task.id).assignedMemberId!;
    expect(workerId).not.toBe(COORDINATOR);
    send.mockClear();

    const reported = envelope(await call(
      'latte_report',
      { taskId: task.id, outcome: 'succeeded', summary: 'Tres textos listos', files: 'textos.md' },
      b.coordinationTokens.mint(workId, workerId),
    ));
    expect(reported.ok).toBe(true);
    await settle();

    const notice = noticesTo();
    expect(notice).toContain('«copywriter»');
    expect(notice).toContain(workerId);
    expect(notice).toContain(task.id);
    expect(notice).toContain('succeeded');
    expect(notice).toContain('Tres textos listos');
    expect(notice).toContain('textos.md');
    // El conteo del run, que es lo que el coordinador necesita para consolidar.
    expect(notice).toContain('1/2 done');
    expect(notice).toContain('1 ready');
  });

  it('M1: sin archivos el aviso dice `none`, y no inventa una lista vacía', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'copywriter', spec: 'Escribir los textos' }, { roleId: 'designer', spec: 'Diseñar las piezas' }],
      [{ roleId: 'copywriter', why: 'Nadie escribe' }, { roleId: 'designer', why: 'Nadie diseña' }],
    ));
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'copywriter')!;
    await call('latte_dispatch', { taskId: task.id });
    await settle();
    const workerId = b.repo.getCoordinationTask(task.id).assignedMemberId!;
    send.mockClear();

    await call('latte_report', { taskId: task.id, outcome: 'failed', summary: 'No pude' }, b.coordinationTokens.mint(workId, workerId));
    await settle();

    expect(noticesTo()).toContain('Files: none');
    expect(noticesTo()).toContain('failed');
  });

  it('M1: con el coordinador ocupado el aviso se ENCOLA y se entrega en su próximo `idle`', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'copywriter', spec: 'Escribir los textos' }, { roleId: 'designer', spec: 'Diseñar las piezas' }],
      [{ roleId: 'copywriter', why: 'Nadie escribe' }, { roleId: 'designer', why: 'Nadie diseña' }],
    ));
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'copywriter')!;
    await call('latte_dispatch', { taskId: task.id });
    await settle();
    const workerId = b.repo.getCoordinationTask(task.id).assignedMemberId!;
    send.mockClear();
    members.find((m) => m.id === COORDINATOR)!.status = 'working';

    await call('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Listo' }, b.coordinationTokens.mint(workId, workerId));
    await settle();
    expect(noticesTo()).toBe(''); // nada encima de su turno en vuelo

    members.find((m) => m.id === COORDINATOR)!.status = 'idle';
    b.emitChat({ chatId: COORDINATOR, type: 'status', status: 'idle', detail: '' });
    await settle();

    expect(noticesTo()).toContain('reported task');
  });

  it('M1: el coordinador que reporta SU PROPIA tarea no se avisa a sí mismo', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'strategist', spec: 'Revisar el plan' }, { roleId: 'designer', spec: 'Diseñar las piezas' }],
      [{ roleId: 'designer', why: 'Nadie diseña' }],
    ));
    const own = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'strategist')!;
    await call('latte_dispatch', { taskId: own.id });
    await settle();
    expect(b.repo.getCoordinationTask(own.id).assignedMemberId).toBe(COORDINATOR);
    send.mockClear();

    await call('latte_report', { taskId: own.id, outcome: 'succeeded', summary: 'Revisado' });
    await settle();

    expect(noticesTo()).not.toContain('reported task');
  });

  it('M1: cuando el run termina, el coordinador recibe el cierre', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'copywriter', spec: 'Escribir los textos' }],
      [{ roleId: 'copywriter', why: 'Nadie escribe' }],
    ));
    const task = b.repo.listCoordinationTasks(runId)[0];
    await call('latte_dispatch', { taskId: task.id });
    await settle();
    const workerId = b.repo.getCoordinationTask(task.id).assignedMemberId!;
    send.mockClear();

    await call('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Listo' }, b.coordinationTokens.mint(workId, workerId));
    await settle();

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    expect(noticesTo()).toContain('Run finished: 1 done, 0 failed');
    expect(noticesTo()).toContain('Nothing left to dispatch');
  });

  it('M1: cancelar el run también se avisa, en vez de dejar al coordinador esperando', async () => {
    runId = await proposeAndApprove(proposal(
      [{ roleId: 'copywriter', spec: 'Escribir los textos' }],
      [{ roleId: 'copywriter', why: 'Nadie escribe' }],
    ));
    send.mockClear();

    await b.service.cancelCoordinationRun(runId);
    await settle();

    expect(noticesTo()).toContain('Run cancelled by the person');
  });
});

