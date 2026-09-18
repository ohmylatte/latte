import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Destildar una contratación tiene que impedirla DE VERDAD.
 *
 * La foto de roles aprobados (`coordination_approved_roles:<runId>`) se armaba
 * desde `proposal.plan` Y desde `membersToHire`, mientras que la interfaz
 * (`DecisionsView.confirmEdit`) sólo filtra `membersToHire`. Como cada
 * contratación existe PORQUE el plan la necesita, el rol seguía aprobado igual
 * y el primer `startDispatch` lo contrataba y le levantaba un proceso sin
 * ningún gate: la interfaz renderizaba un rechazo que el motor ignoraba.
 *
 * Los tests entran por la capa IPC real (`resolveCoordinationGate`, con el id
 * de gate con `:` tal como lo manda la interfaz), no llamando al motor de
 * costado.
 */
describe('la contratación que la persona destildó', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let brandId: string;
  let workId: string;

  function proposerGrant(): CoordinationGrant {
    return { workId, runId: null, memberId: 'mem_proposer', role: 'worker' };
  }

  function coordinator(runId: string): CoordinationGrant {
    return { workId, runId, memberId: 'mem_proposer', role: 'coordinator' };
  }

  function proposal(overrides: Partial<CoordinationProposal> = {}): CoordinationProposal {
    return {
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los textos' },
        { roleId: 'designer', spec: 'Diseñar las piezas' },
      ],
      estimatedDispatches: 8,
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
      rationale: 'Coordinar al equipo y preparar el contenido del mes.',
      ...overrides,
    };
  }

  /** Exactamente lo que manda `DecisionsView.confirmEdit`: el plan INTACTO, un hire menos. */
  function editedWithoutDesigner(): string {
    return JSON.stringify({ ...proposal(), membersToHire: [{ roleId: 'copywriter', why: 'Nadie escribe todavía' }] });
  }

  function taskFor(runId: string, roleId: string): string {
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === roleId);
    expect(task).toBeDefined();
    return task!.id;
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
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    await b.service.setCoordinationAuthority(workId, 'auto'); // sin gate por despacho: el único freno tiene que ser la aprobación
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- 1: aprobar editando y quitar un hire ----------------------------------

  it('aprobar editando sin la contratación deja la tarea de ese rol `blocked`, sin miembro y sin proceso', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    // La contratación destildada NO ocurrió.
    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(b.repo.listMembers(workId).map((m) => m.roleId)).not.toContain('designer');
    const approved = JSON.parse(b.repo.getMeta(`coordination_approved_roles:${run.id}`) ?? '[]') as string[];
    expect(approved).toContain('copywriter');
    expect(approved).not.toContain('designer');

    const designerTask = taskFor(run.id, 'designer');
    await expect(engine.startDispatch({ grant: coordinator(run.id), taskId: designerTask })).rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });

    // Ni miembro nuevo, ni proceso levantado, ni tarea que desaparece en silencio.
    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(send.mock.calls).toHaveLength(0);
    expect(b.repo.getCoordinationTask(designerTask).status).toBe('blocked');
    // Y la razón queda escrita en la bitácora, no sólo en el error que se tiró.
    const entries = engine.listLog(run.id).filter((entry) => entry.kind !== 'run_done' && entry.taskId === designerTask);
    expect(entries).toHaveLength(1);
    const row = b.repo.listCoordinationDispatches(run.id).find((d) => d.taskId === designerTask);
    expect(row).toBeDefined();
    expect(row!.outcome).toBe('role_not_approved');
    expect(row!.summary ?? '').toMatch(/designer/);
  });

  // --- 2: el plan no puede reintroducir el rol -------------------------------

  it('el rol sigue en `proposal.plan` intacto y aun así no se contrata: el plan no aprueba nada', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    // El plan que la persona aprobó SIGUE nombrando al designer — la interfaz no lo toca.
    const saved = JSON.parse(b.repo.getCoordinationRun(run.id).planJson ?? '{}') as CoordinationProposal;
    expect(saved.plan.map((t) => t.roleId)).toContain('designer');
    // Y la tarea existe, con su rol: no se borra, se bloquea.
    const designerTask = taskFor(run.id, 'designer');
    expect(b.repo.getCoordinationTask(designerTask).roleId).toBe('designer');
    const approved = JSON.parse(b.repo.getMeta(`coordination_approved_roles:${run.id}`) ?? '[]') as string[];
    expect(approved).not.toContain('designer');
  });

  it('`latte_plan_submit` después de aprobado tampoco puede colar el rol destildado', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    // Con 'auto' no hay gate por despacho: si el rol se cuela, se contrata.
    await b.service.setCoordinationAuthority(workId, 'auto');
    // La herramienta que el agente coordinador tiene en la mano reescribe el plan.
    const created = engine.planSubmit(run.id, [{ roleId: 'designer', spec: 'Colado por la ventana' }]);
    expect(created).toHaveLength(1);

    await expect(engine.startDispatch({ grant: coordinator(run.id), taskId: created[0].id })).rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });
    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(send.mock.calls).toHaveLength(0);
  });

  it('el puente de handoffs tampoco contrata un rol que nadie aprobó', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());
    // Aprobar sube la autoridad a 'plan'; con 'auto' el puente llega derecho
    // a contratar, que es justamente el camino que hay que cerrar.
    await b.service.setCoordinationAuthority(workId, 'auto');

    await expect(engine.bridgeHandoffToTask(workId, 'designer', 'Diseñar algo')).rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });

    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(send.mock.calls).toHaveLength(0);
  });

  // --- 3: un rol que YA es del equipo sigue pudiendo trabajar ----------------

  it('un rol que ya es miembro del Trabajo recibe tareas aunque no esté en `membersToHire`', async () => {
    // El estratega ya está en el equipo desde antes de cualquier propuesta.
    members.push({ id: 'mem_proposer', workId, roleId: 'strategist', status: 'idle' });
    const run = await engine.requestCoordination(proposerGrant(), proposal({
      plan: [{ roleId: 'strategist', spec: 'Ordenar el mes' }],
      membersToHire: [],
    }));

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');

    const task = taskFor(run.id, 'strategist');
    const outcome = await engine.startDispatch({ grant: coordinator(run.id), taskId: task });

    expect(outcome.status).toBe('dispatched');
    expect(b.repo.getCoordinationDispatch(outcome.dispatchId).memberId).toBe('mem_proposer');
    expect(members).toHaveLength(1); // se reutilizó al que ya estaba, no se contrató a nadie
    expect(send.mock.calls).toHaveLength(1);
  });

  // --- 4: el camino feliz, sin editar, sigue igual ---------------------------

  it('aprobar sin editar contrata a los dos y despacha normalmente (regresión)', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');

    expect(members.map((m) => m.roleId).sort()).toEqual(['copywriter', 'designer']);
    const designerTask = taskFor(run.id, 'designer');
    const outcome = await engine.startDispatch({ grant: coordinator(run.id), taskId: designerTask });
    expect(outcome.status).toBe('dispatched');
    expect(b.repo.getCoordinationTask(designerTask).status).toBe('dispatched');
    expect(send.mock.calls).toHaveLength(1);
  });
});
