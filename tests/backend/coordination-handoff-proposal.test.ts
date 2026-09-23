import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../shared/contracts';
import { FEATURE_KEYS, FEATURE_OFF, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * UN TRASPASO SIN RUN SE CONVIERTE EN UNA PROPUESTA.
 *
 * Uso real (2026-09-23): la persona pidió en el chat de equipo "denle la tarea
 * a Paid Media", el Asistente escribió un archivo de traspaso y, como no había
 * run, Latte lo aceptó por el camino viejo: prellenó el borrador del chat de
 * Paid Media para que la PERSONA lo mandara a mano. "Pedís en el chat, aprobás
 * en el chat; nunca persona en el medio".
 *
 * Ahora, sin run, el puente arma una propuesta de UNA tarea por el mismo
 * camino que `latte_request_coordination` (run `planning`, tarjeta, Aprobar /
 * Editar / Rechazar) y el coordinador es quien escribió el traspaso. Todo por
 * la capa real (`LatteService`), con el hub de mentira del repo.
 */
describe('traspaso sin run → propuesta', () => {
  let b: TestBackend;
  let workId: string;
  let dir: string;
  let members: FakeTeamMember[];
  let transcripts: Record<string, ChatMessage[]>;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    dir = path.join(b.dir, 'brands', brand.id, 'works', workId);
    members = [
      { id: 'mem_asistente', workId, roleId: 'assistant', status: 'idle' },
      { id: 'mem_estratega', workId, roleId: 'strategist', status: 'idle' },
    ];
    fakeCoordinationHub(b, members);
    transcripts = {};
    vi.spyOn(b.hub, 'recentMessages').mockImplementation((memberId: string) => ({ messages: transcripts[memberId] ?? [], exposed: true }));
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  function writeHandoff(fileName: string, roleId: string, request: string) {
    fs.writeFileSync(path.join(dir, fileName), `---\npara: ${roleId}\n---\n${request}\n`);
  }

  /** Lo que un runtime reporta cuando un miembro escribe un archivo con su tool. */
  function wrote(memberId: string, fileName: string): void {
    transcripts[memberId] = [{
      id: 'msg_1', chatId: memberId, role: 'assistant', createdAt: '2026-09-23T09:00:00.000Z', completed: true, error: null,
      parts: [{ type: 'tool', id: 'tool_1', tool: 'Write', status: 'completed', title: `C:/trabajo/${fileName}`, input: '{}', output: '', error: '' }],
    }];
  }

  it('sin run y sin el rol en el equipo: run `planning` con una tarea y el alta del rol; el coordinador es quien escribió el traspaso', async () => {
    wrote('mem_estratega', 'para-paid-media.md');
    writeHandoff('para-paid-media.md', 'paid-media', '# Pedido: guía para levantar las campañas de Meta Ads\n\nDe: Asistente. Armá la guía.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-paid-media.md');

    expect(result.bridged).toBe(true);
    expect(result.outcome).toBe('proposed');
    expect(result.task).toBeNull();
    const run = b.repo.findActiveCoordinationRun(workId)!;
    expect(run.status).toBe('planning');
    expect(run.coordinatorMemberId).toBe('mem_estratega');
    const proposal = JSON.parse(run.planJson!);
    expect(proposal.plan).toEqual([{ roleId: 'paid-media', spec: 'Pedido: guía para levantar las campañas de Meta Ads\n\nDe: Asistente. Armá la guía.' }]);
    expect(proposal.membersToHire).toEqual([{ roleId: 'paid-media', why: expect.any(String) }]);
    expect(proposal.rationale).toBe('Pedido: guía para levantar las campañas de Meta Ads');
    expect(proposal.rationale.length).toBeLessThanOrEqual(100);
    expect(proposal.estimatedDispatches).toBeGreaterThan(0);
    // La MISMA tarjeta que una propuesta de agente: un gate `proposal`.
    const gates = await b.service.listCoordinationGates(run.id);
    expect(gates.map((g) => g.kind)).toEqual(['proposal']);
    // Nada se gastó ni se escribió en ningún chat.
    expect(b.hub.send).not.toHaveBeenCalled();
    // El pedido se consumió: ya no hay banner que ofrecer.
    expect(fs.existsSync(path.join(dir, 'para-paid-media.md'))).toBe(false);
    expect(await b.service.listHandoffs(workId)).toEqual([]);
  });

  it('con el rol ya en el equipo no propone ninguna alta', async () => {
    wrote('mem_asistente', 'para-strategist.md');
    writeHandoff('para-strategist.md', 'strategist', 'Armá la estrategia del trimestre.');

    await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    const run = b.repo.findActiveCoordinationRun(workId)!;
    expect(run.coordinatorMemberId).toBe('mem_asistente');
    expect(JSON.parse(run.planJson!).membersToHire ?? []).toEqual([]);
  });

  it('sin autor determinable, el coordinador es el destinatario del chat de equipo (el Asistente)', async () => {
    writeHandoff('para-strategist.md', 'strategist', 'Armá la estrategia del trimestre.');

    await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(b.repo.findActiveCoordinationRun(workId)!.coordinatorMemberId).toBe('mem_asistente');
  });

  it('aprobar la propuesta despacha la tarea, sin que nadie más la mande', async () => {
    writeHandoff('para-strategist.md', 'strategist', 'Armá la estrategia del trimestre.');
    await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    const run = b.repo.findActiveCoordinationRun(workId)!;
    const [gate] = await b.service.listCoordinationGates(run.id);

    await b.service.resolveCoordinationGate(gate.id, 'approve');

    const tasks = b.repo.listCoordinationTasks(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ roleId: 'strategist', status: 'dispatched' });
    const dispatches = b.repo.listCoordinationDispatches(run.id);
    expect(dispatches.map((d) => d.status)).toContain('dispatched');
    expect(vi.mocked(b.hub.send).mock.calls.some(([memberId]) => memberId === 'mem_estratega')).toBe(true);
  });

  it('aprobar con alta: contrata al rol y le despacha la tarea', async () => {
    writeHandoff('para-paid-media.md', 'paid-media', 'Guía de campañas de Meta Ads.');
    await b.service.acceptHandoffAsTask(workId, 'para-paid-media.md');
    const run = b.repo.findActiveCoordinationRun(workId)!;
    const [gate] = await b.service.listCoordinationGates(run.id);

    await b.service.resolveCoordinationGate(gate.id, 'approve');

    const hired = members.find((m) => m.roleId === 'paid-media');
    expect(hired).toBeDefined();
    expect(b.repo.listCoordinationTasks(run.id)[0]).toMatchObject({ roleId: 'paid-media', status: 'dispatched', assignedMemberId: hired!.id });
  });

  it('con un run corriendo sigue como antes: tarea nueva y despacho', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist');
    writeHandoff('para-strategist.md', 'strategist', 'Armá la estrategia del trimestre.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result).toMatchObject({ bridged: true, outcome: 'dispatched' });
    expect(b.repo.findActiveCoordinationRun(workId)!.id).toBe(run.id);
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(1);
  });

  it('con una propuesta ya pendiente no arma otra, y el motivo viaja (nunca un borrador)', async () => {
    writeHandoff('uno.md', 'strategist', 'Primer pedido.');
    await b.service.acceptHandoffAsTask(workId, 'uno.md');
    writeHandoff('dos.md', 'strategist', 'Segundo pedido.');

    const result = await b.service.acceptHandoffAsTask(workId, 'dos.md');

    expect(result).toEqual({ bridged: false, task: null, outcome: null, reason: 'RUN_ALREADY_ACTIVE' });
    expect(fs.existsSync(path.join(dir, 'dos.md'))).toBe(true);
  });

  it('un rol que Latte no conoce no se propone: el motivo es UNKNOWN_ROLE', async () => {
    writeHandoff('para-fantasma.md', 'fantasma', 'Algo.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-fantasma.md');

    expect(result).toEqual({ bridged: false, task: null, outcome: null, reason: 'UNKNOWN_ROLE' });
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('con la coordinación apagada devuelve el resultado que el renderer lee como borrador (motivo nulo)', async () => {
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_OFF);
    writeHandoff('para-strategist.md', 'strategist', 'Armá la estrategia del trimestre.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result).toEqual({ bridged: false, task: null, outcome: null, reason: null });
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'para-strategist.md'))).toBe(true);
  });
});
