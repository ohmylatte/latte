import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { MAX_DEPENDENCY_DEPTH } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * O1c: LA PROFUNDIDAD SE MIDE EN LA VALIDACIÓN, NO DESPUÉS DE CONTRATAR.
 *
 * `createTaskRow` aplica `MAX_DEPENDENCY_DEPTH` y tira `DEPTH_CAP`, pero eso
 * corre adentro de `commitProposal` — o sea DESPUÉS de que `resolveGate`
 * contrató al equipo y levantó los procesos, porque las altas van antes de la
 * transacción por diseño. `assertCoordinationProposal` no medía la
 * profundidad, así que una cadena más larga que el tope pasaba entera: la
 * persona apretaba "Aprobar", se contrataba a todo el mundo y el run se caía.
 *
 * Los dos caminos por los que entra una propuesta, cada uno por su puerta
 * real: JSON-RPC (`latte_request_coordination`, lo que manda el agente) e IPC
 * (`resolveCoordinationGate` con la propuesta editada, lo que manda la
 * pantalla).
 */
describe('O1: una cadena de dependencias más larga que el tope se rechaza validando', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let brandId: string;
  let workId: string;
  let token: string;

  /** Una cadena de `n` tareas, cada una dependiendo de la anterior: profundidad `n - 1`. */
  function chain(n: number): CoordinationProposal['plan'] {
    return Array.from({ length: n }, (_, i) => ({
      roleId: 'copywriter',
      spec: `paso ${i}`,
      ...(i === 0 ? {} : { dependsOn: [i - 1] }),
    }));
  }

  function proposal(plan: CoordinationProposal['plan']): CoordinationProposal {
    return {
      plan,
      estimatedDispatches: 8,
      membersToHire: [{ roleId: 'copywriter', why: 'Nadie escribe todavía' }],
      rationale: 'Coordinar al equipo y preparar el contenido del mes.',
    };
  }

  function proposerGrant(): CoordinationGrant {
    return { workId, runId: null, memberId: 'mem_proposer', role: 'worker' };
  }

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    b.repo.insertMember({
      id: 'mem_proposer', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 500 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    token = b.coordinationTokens.mint(workId, 'mem_proposer');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('JSON-RPC: el plan demasiado profundo se rechaza con VALIDATION, sin un solo run ni un alta', async () => {
    const tooDeep = proposal(chain(MAX_DEPENDENCY_DEPTH + 2)); // profundidad MAX + 1

    const result = envelope(await b.coordinationMcpServer.handleMcpRequest(
      rpc('latte_request_coordination', tooDeep), `Bearer ${token}`, '127.0.0.1',
    ));

    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('VALIDATION');
    expect(result.error!.message).toContain(String(MAX_DEPENDENCY_DEPTH));
    // Cero runs, cero altas, cero despachos: nada se escribió.
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
    expect(members).toHaveLength(0);
    expect(send.mock.calls).toHaveLength(0);
  });

  it('JSON-RPC: la cadena que llega JUSTO al tope sí entra — el rechazo no es del largo del plan', async () => {
    const atCap = proposal(chain(MAX_DEPENDENCY_DEPTH + 1)); // profundidad MAX exacta

    const result = envelope(await b.coordinationMcpServer.handleMcpRequest(
      rpc('latte_request_coordination', atCap), `Bearer ${token}`, '127.0.0.1',
    ));

    expect(result.ok).toBe(true);
    expect(b.repo.findActiveCoordinationRun(workId)).not.toBeNull();
  });

  it('IPC: la propuesta EDITADA demasiado profunda tampoco contrata a nadie antes de rebotar', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal(chain(2)));
    expect(members).toHaveLength(0); // la premisa: proponer no contrata

    const edited = JSON.stringify(proposal(chain(MAX_DEPENDENCY_DEPTH + 2)));
    await expect(b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', edited))
      .rejects.toMatchObject({ code: 'VALIDATION' });

    // Ni una contratación, ni una tarea, y el run sigue esperando una decisión.
    expect(members).toHaveLength(0);
    expect(b.repo.listMembers(workId).map((m) => m.roleId)).not.toContain('copywriter');
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
  });
});
