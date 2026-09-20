import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q6: UNA PROPUESTA CON UN ROL HUÉRFANO ERA UN CALLEJÓN SIN SALIDA.
 *
 * `assertCoordinationProposal` no exige que `membersToHire` cubra los roles del
 * plan, así que `requestCoordination` guardaba la propuesta igual. Después
 * `assertPlanIsFulfillable` tiraba `PLAN_HAS_UNAPPROVED_ROLES` al aprobar Y al
 * editar (el recorte de la interfaz sólo actuaba sobre las altas que la persona
 * destildaba, y acá no había ninguna destildada). El único camino que quedaba
 * era Rechazar: el agente nunca se enteraba, y la persona pagaba el error.
 *
 * Dos arreglos, en los dos extremos:
 *  - EN EL ORIGEN: `requestCoordination` rechaza, y el agente —que es quien
 *    puede corregirlo— recibe el error y vuelve a proponer.
 *  - EN LA APROBACIÓN: el gate publica la cobertura calculada de cada rol del
 *    plan (`hire` / `member` / `orphan`) para que la interfaz recorte lo que no
 *    se puede cumplir, sin recalcular el equipo por su cuenta. Los huérfanos
 *    siguen siendo posibles en bases viejas o si el equipo cambió entre la
 *    propuesta y la aprobación.
 */
describe('Q6: una propuesta con un rol que nadie va a contratar', () => {
  let b: TestBackend;
  let workId: string;
  let members: FakeTeamMember[];
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

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    const at = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({
      id: 'mem_proponente', workId, roleId: 'strategist', roleName: 'Estratega', initial: 'E',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
    members.push({ id: 'mem_proponente', workId, roleId: 'strategist', status: 'idle' });
    token = b.coordinationTokens.mint(workId, 'mem_proponente');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- (a) el rechazo en el origen, por la capa real ---------------------------

  it('JSON-RPC: proponer un plan con un rol sin alta ni miembro se rechaza, y no queda ningún run', async () => {
    const result = envelope(await call('latte_request_coordination', {
      plan: [
        { roleId: 'strategist', spec: 'definir el naming' },
        { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
      ],
      // El agente se olvidó de pedir al redactor.
      membersToHire: [],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    }));

    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('PLAN_HAS_UNAPPROVED_ROLES');
    // El error nombra el rol: es lo único que el agente necesita para corregir.
    expect(result.error!.message).toContain('copywriter');
    expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
  });

  it('y la misma propuesta con el alta que faltaba entra sin problema', async () => {
    const result = envelope(await call('latte_request_coordination', {
      plan: [
        { roleId: 'strategist', spec: 'definir el naming' },
        { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
      ],
      membersToHire: [{ roleId: 'copywriter', why: 'no hay redactor' }],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    }));

    expect(result.ok).toBe(true);
    expect(b.repo.findActiveCoordinationRun(workId)).not.toBeNull();
  });

  // --- (b) la cobertura publicada, y la aprobación del plan recortado ---------

  /** Una fila `planning` escrita a mano: exactamente lo que dejó una base vieja. */
  function insertLegacyRun(): string {
    const at = '2026-01-01T00:00:00.000Z';
    const run = b.repo.insertCoordinationRun({
      id: 'crn_vieja', workId, status: 'planning', coordinatorMemberId: 'mem_proponente',
      budgetJson: JSON.stringify({ maxDispatches: 4, unlimitedConfirmedAt: null }),
      planJson: JSON.stringify({
        plan: [
          { roleId: 'strategist', spec: 'definir el naming' },
          { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
        ],
        membersToHire: [],
        estimatedDispatches: 4,
        rationale: 'porque sí',
      }),
      planApprovedAt: null, suspendReason: null, createdAt: at, updatedAt: at,
    });
    return run.id;
  }

  it('IPC: el gate de una propuesta vieja publica la cobertura de cada rol del plan', async () => {
    const runId = insertLegacyRun();

    const gates = await b.service.listCoordinationGates(runId);

    const proposal = gates.find((g) => g.kind === 'proposal');
    expect(proposal).toBeDefined();
    const coverage = proposal!.roleCoverage;
    expect(coverage).toBeDefined();
    // `strategist` ya es miembro del Trabajo; `copywriter` no lo cubre nadie.
    expect([...coverage!].sort((x, y) => x.roleId.localeCompare(y.roleId))).toEqual([
      { roleId: 'copywriter', coverage: 'orphan' },
      { roleId: 'strategist', coverage: 'member' },
    ]);
  });

  it('IPC: aprobar con el payload recortado que arma la interfaz sí se puede cumplir', async () => {
    const runId = insertLegacyRun();
    const edited = JSON.stringify({
      // Lo que la interfaz manda: el plan sin las tareas del rol huérfano.
      plan: [{ roleId: 'strategist', spec: 'definir el naming' }],
      membersToHire: [],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    });

    const view = await b.service.resolveCoordinationGate('proposal:' + runId, 'approve', edited);

    expect(view.status).toBe('running');
    expect(b.repo.listCoordinationTasks(runId).map((t) => t.roleId)).toEqual(['strategist']);
  });

  it('un rol cubierto por un alta se publica como `hire`, no como `member`', async () => {
    const result = envelope(await call('latte_request_coordination', {
      plan: [
        { roleId: 'strategist', spec: 'definir el naming' },
        { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
      ],
      membersToHire: [{ roleId: 'copywriter', why: 'no hay redactor' }],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    }));
    expect(result.ok).toBe(true);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;

    const gates = await b.service.listCoordinationGates(runId);

    const coverage = gates.find((g) => g.kind === 'proposal')!.roleCoverage!;
    expect([...coverage].sort((x, y) => x.roleId.localeCompare(y.roleId))).toEqual([
      { roleId: 'copywriter', coverage: 'hire' },
      { roleId: 'strategist', coverage: 'member' },
    ]);
  });

  // --- (d) lo que el pack le pide al estratega --------------------------------

  it('el pack del estratega le pide cubrir todo rol del plan que no esté en el equipo', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync('packs/marketing-core/roles/strategist.md', 'utf8');
    const lines = text.split(/\r?\n/);
    const rule = lines.filter((l) => /membersToHire/.test(l) && /(plan|every role|todo rol)/i.test(l));
    expect(rule.length).toBeGreaterThan(0);
  });
});
