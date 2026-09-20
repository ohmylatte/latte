import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
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

  /**
   * Exactamente lo que manda `DecisionsView.confirmEdit`: un hire menos Y el
   * plan RECORTADO.
   *
   * Q4: antes esto mandaba el plan INTACTO, porque eso era lo que la interfaz
   * hacía. Era el bug: las tareas del rol destildado quedaban en el plan
   * aprobado, nacían `ready`, el primer despacho las mataba con
   * `ROLE_NOT_APPROVED` y `recomputeReadiness` derribaba a sus dependientes —
   * media planificación caída en silencio después de haber aprobado. Hoy la
   * interfaz recorta y el motor rechaza la aprobación que no puede cumplir
   * (`coordination-unapproved-plan-roles.test.ts` cubre ese rechazo). Lo que
   * ESTE archivo protege no cambia: al designer no lo contrata nadie, por
   * ninguna puerta.
   */
  function editedWithoutDesigner(): string {
    return JSON.stringify({
      ...proposal(),
      plan: [{ roleId: 'copywriter', spec: 'Escribir los textos' }],
      membersToHire: [{ roleId: 'copywriter', why: 'Nadie escribe todavía' }],
    });
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
    // Crítico 6: `resolveGate` ahora consulta `feature:coordination` PRIMERO —
    // el interruptor tiene que apagar también lo que ya está andando, no sólo
    // impedir encender. Este escenario aprueba por IPC, así que la bandera
    // tiene que estar arriba, igual que en una instalación donde la persona
    // la prendió.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);

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

  it('aprobar editando sin la contratación no contrata a nadie de ese rol, y su trabajo no queda colgado', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    // La contratación destildada NO ocurrió.
    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(b.repo.listMembers(workId).map((m) => m.roleId)).not.toContain('designer');
    const approved = JSON.parse(b.repo.getMeta(`coordination_approved_roles:${run.id}`) ?? '[]') as string[];
    expect(approved).toContain('copywriter');
    expect(approved).not.toContain('designer');

    // Q4: y la tarea del designer NO existe. Antes existía, `ready`, condenada:
    // al despacharla moría `failed` con `role_not_approved` y arrastraba a sus
    // dependientes. Una tarea que el motor sabe que no puede correr no se
    // escribe; la persona destildó esa contratación y eso se respeta entero.
    expect(b.repo.listCoordinationTasks(run.id).map((t) => t.roleId)).toEqual(['copywriter']);
    expect(send.mock.calls).toHaveLength(0);
  });

  // --- 2: el plan aprobado es el recortado, y la foto de roles lo acompaña ----

  it('el plan que queda guardado es el que la persona aprobó, sin el rol destildado', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    const saved = JSON.parse(b.repo.getCoordinationRun(run.id).planJson ?? '{}') as CoordinationProposal;
    expect(saved.plan.map((t) => t.roleId)).toEqual(['copywriter']);
    const approved = JSON.parse(b.repo.getMeta(`coordination_approved_roles:${run.id}`) ?? '[]') as string[];
    expect(approved).not.toContain('designer');
  });

  it('`latte_plan_submit` después de aprobado tampoco puede colar el rol destildado', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());

    // Con 'auto' no hay gate por despacho: si el rol se cuela, se contrata.
    await b.service.setCoordinationAuthority(workId, 'auto');
    // La herramienta que el agente coordinador tiene en la mano reescribe el
    // plan. Desde U10 ni siquiera llega a crear la tarea: el rol destildado se
    // rechaza DONDE NACE, así que la bitácora de la persona no se ensucia con
    // una tarea condenada a `failed`.
    const before = b.repo.listCoordinationTasks(run.id).length;
    expect(() => engine.planSubmit(run.id, [{ roleId: 'designer', spec: 'Colado por la ventana' }]))
      .toThrowError(expect.objectContaining({ code: 'ROLE_NOT_APPROVED' }));

    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(before);
    expect(members.map((m) => m.roleId)).toEqual(['copywriter']);
    expect(send.mock.calls).toHaveLength(0);
  });

  it('el puente de handoffs tampoco contrata un rol que nadie aprobó', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', editedWithoutDesigner());
    // Aprobar sube la autoridad a 'plan'; con 'auto' el puente llega derecho
    // a contratar, que es justamente el camino que hay que cerrar.
    await b.service.setCoordinationAuthority(workId, 'auto');

    // F7: el puente DEGRADA al borrador en vez de tirar. El chequeo de rol se
    // hace ahora ANTES de `createTaskRow` —antes se salteaba y la tarea nacía
    // igual, para morir `failed` tres saltos más adentro ensuciando la
    // bitácora—, y "no se puede convertir en tarea" es exactamente el mismo
    // hecho que "no hay run": `{bridged:false}`, el handoff sigue sobre la
    // mesa. Lo que este test protege —que NADIE se contrate— sigue intacto.
    const before = b.repo.listCoordinationTasks(run.id).length;
    await expect(engine.bridgeHandoffToTask(workId, 'designer', 'Diseñar algo')).resolves.toEqual({ bridged: false });

    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(before); // el puente no escribió ninguna tarea nueva
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
