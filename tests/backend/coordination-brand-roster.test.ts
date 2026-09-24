import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { MAX_CALLED_UP_MEMBERS_PER_RUN } from '../../electron/coordination/limits';
import type { BrandMemberRecord } from '../../electron/storage/repository';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * LA COORDINACIÓN CONVOCA DEL PLANTEL (brief
 * `docs/briefs/2026-09-23-equipo-de-marca.md`, sección 4).
 *
 * El circuito no cambia —el coordinador propone, la persona aprueba, la
 * aprobación trae a la gente—; cambia QUÉ trae. Y un miembro del plantel que
 * nadie convocó en este trabajo no existe para las herramientas: escribirle
 * arrancaría un proceso que nadie pidió, así que se contesta con un límite
 * claro, igual que a un miembro de otro trabajo.
 */

const COORDINATOR = 'mem_coordinator';
const NOW = '2026-09-23T12:00:00.000Z';

function rpc(name: string, args: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

interface Envelope { ok: boolean; data: unknown; error?: { code: string; message: string } }

function envelope(result: { body: string }): Envelope {
  const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown } };
  return (parsed.result as { structuredContent: Envelope }).structuredContent;
}

function person(id: string, brandId: string, roleId: string): BrandMemberRecord {
  return {
    id, brandId, roleId, roleName: roleId, initial: roleId[0]!.toUpperCase(), avatar: null, runtime: 'codex', model: null, accountId: null,
    tier: 'balanced', coordinator: false, lastCalledAt: NOW, retiredAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

describe('la coordinación y el plantel de la marca', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let brandId: string;
  let token: string;

  function call(name: string, args: unknown, bearer = token) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${bearer}`, '127.0.0.1');
  }

  async function propose(membersToHire: Array<{ roleId: string; why: string }>, plan = membersToHire.map((h) => ({ roleId: h.roleId, spec: `Hacer lo de ${h.roleId}` }))) {
    return envelope(await call('latte_request_coordination', { plan, estimatedDispatches: 8, membersToHire, rationale: 'Coordinar.' }));
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 3 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    fakeCoordinationHub(b, members);
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    token = b.coordinationTokens.mint(workId, COORDINATOR);
    // Una analista en el plantel de la marca que nadie convocó a este trabajo.
    b.repo.insertBrandMember(person('bm_analyst', brandId, 'analyst'));
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('la propuesta dice a quién CONVOCA del plantel y a quién suma nuevo a la marca', async () => {
    expect((await propose([{ roleId: 'analyst', why: 'Mirar números' }, { roleId: 'designer', why: 'Nadie diseña' }])).ok).toBe(true);
    const gate = (await b.service.listCoordinationGates(b.repo.findActiveCoordinationRun(workId)!.id)).find((g) => g.kind === 'proposal')!;
    expect(gate.rosterHires).toEqual(['analyst']);
  });

  it('un traspaso a un rol del plantel explica que lo convoca, no que nadie lo hace', async () => {
    const bridged = await b.service.coordinationEngine.bridgeHandoffToTask(workId, 'analyst', 'Mirar números', { coordinatorMemberId: COORDINATOR });
    expect(bridged.bridged).toBe(true);
    const proposal = JSON.parse(b.repo.findActiveCoordinationRun(workId)!.planJson!) as { membersToHire: Array<{ why: string }> };
    expect(proposal.membersToHire[0]!.why).toMatch(/Brand's team/);
  });

  it('latte_message a alguien del plantel que no está convocado: FORBIDDEN, sin escribir nada', async () => {
    expect((await propose([{ roleId: 'copywriter', why: 'Nadie escribe' }])).ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();

    for (const to of ['bm_analyst', 'analyst']) {
      const result = envelope(await call('latte_message', { to, text: '¿Me pasás los números?' }));
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FORBIDDEN');
      expect(result.error?.message).toMatch(/not called up in this Work/);
      expect(result.error?.message).toMatch(/membersToHire/);
    }
    expect(b.repo.listCoordinationMessages(runId)).toEqual([]);
  });

  it('latte_message a alguien de OTRA marca: FORBIDDEN, el límite es la marca', async () => {
    const other = await b.service.createBrand('Otra');
    b.repo.insertBrandMember(person('bm_foreign', other.id, 'designer'));
    expect((await propose([{ roleId: 'copywriter', why: 'Nadie escribe' }])).ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();

    const result = envelope(await call('latte_message', { to: 'bm_foreign', text: 'Hola' }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(result.error?.message).toMatch(/another Brand/);
  });

  it('latte_message a una persona del plantel que SÍ está convocada llega a su hilo en este trabajo', async () => {
    expect((await propose([{ roleId: 'copywriter', why: 'Nadie escribe' }])).ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    b.repo.insertMember({
      id: 'mem_analyst_here', workId, roleId: 'analyst', roleName: 'analyst', initial: 'A', runtime: 'codex', model: null, accountId: null,
      sessionId: '', done: false, brandMemberId: 'bm_analyst', createdAt: NOW, updatedAt: NOW,
    });
    members.push({ id: 'mem_analyst_here', workId, roleId: 'analyst', status: 'idle' });

    const result = envelope(await call('latte_message', { to: 'bm_analyst', text: 'Hola' }));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ to: 'mem_analyst_here' });
  });

  it('crear una tarea para un rol del plantel que la persona no aprobó explica que hay que convocarlo', async () => {
    expect((await propose([{ roleId: 'copywriter', why: 'Nadie escribe' }])).ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();

    const result = envelope(await call('latte_task_create', { roleId: 'analyst', spec: 'Mirar números' }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ROLE_NOT_APPROVED');
    expect(result.error?.message).toMatch(/Brand's team but not called up in this Work/);
  });

  it(`una propuesta no convoca a más de ${MAX_CALLED_UP_MEMBERS_PER_RUN} de una vez`, async () => {
    const roles = ['r-uno', 'r-dos', 'r-tres', 'r-cuatro', 'r-cinco', 'r-seis', 'r-siete'].slice(0, MAX_CALLED_UP_MEMBERS_PER_RUN + 1);
    const result = await propose(roles.map((roleId) => ({ roleId, why: 'Hace falta' })));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(new RegExp(`at most ${MAX_CALLED_UP_MEMBERS_PER_RUN}`));
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('un despacho que tendría que convocar a alguien más con el run ya en su tope se niega con TOO_MANY_CALLED_UP', async () => {
    expect((await propose([{ roleId: 'copywriter', why: 'Nadie escribe' }])).ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    // El copywriter entró con la aprobación; se lo saca del equipo para que el
    // despacho tenga que convocar de nuevo, con el registro de altas lleno.
    members.splice(members.findIndex((m) => m.roleId === 'copywriter'), 1);
    const hires = Array.from({ length: MAX_CALLED_UP_MEMBERS_PER_RUN }, (_, i) => ({ memberId: `mem_h${i}`, roleId: 'copywriter', hiredAt: NOW }));
    b.repo.setMeta('coordination_hires:' + runId, JSON.stringify(hires));
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'copywriter')!;

    const result = envelope(await call('latte_dispatch', { taskId: task.id }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOO_MANY_CALLED_UP');
  });
});
