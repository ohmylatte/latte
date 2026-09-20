import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q4: UNA APROBACIÓN QUE NO SE PUEDE CUMPLIR NO SE ESCRIBE.
 *
 * `commitProposal` creaba una fila por cada item del plan sin pasar por
 * `assertRoleCreatable` — el mismo chequeo que `taskCreate`, `planSubmit` y el
 * puente de handoff sí hacen. Así que destildar una contratación en la
 * interfaz (que filtra `membersToHire` y manda `proposal.plan` intacto) dejaba
 * tareas de un rol que nadie aprobó: nacían `ready`, el primer despacho moría
 * con `ROLE_NOT_APPROVED`, la tarea quedaba `failed` y `recomputeReadiness`
 * derribaba a todas las que dependían de ella. La persona destildaba UNA
 * contratación y se le caía media planificación, en silencio, después de haber
 * aprobado.
 *
 * El motor es el único que sabe qué roles existen, así que es el que tiene que
 * decir que no — y decirlo ANTES de escribir, no descubrirlo tres saltos más
 * adentro. `assertCoordinationProposal` no cambia: la forma de la propuesta es
 * perfectamente válida.
 */
describe('Q4: aprobar un plan con roles que nadie va a poder hacer', () => {
  let b: TestBackend;
  let workId: string;
  let members: FakeTeamMember[];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function proposeTwoRoles() {
    const run = await b.service.coordinationEngine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proponente', role: 'worker' },
      {
        plan: [
          { roleId: 'strategist', spec: 'definir el naming' },
          { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
        ],
        membersToHire: [
          { roleId: 'strategist', why: 'no hay estratega' },
          { roleId: 'copywriter', why: 'no hay redactor' },
        ],
        estimatedDispatches: 4,
        rationale: 'porque sí',
      },
    );
    return run;
  }

  it('destildar una contratación y mandar el plan entero: la aprobación se rechaza y NO escribe nada', async () => {
    const run = await proposeTwoRoles();
    const edited = JSON.stringify({
      plan: [
        { roleId: 'strategist', spec: 'definir el naming' },
        { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
      ],
      // La persona sacó al redactor...
      membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    });

    await expect(b.service.resolveCoordinationGate('proposal:' + run.id, 'approve', edited))
      .rejects.toThrow(/PLAN_HAS_UNAPPROVED_ROLES|copywriter/);

    // Cero filas: ni tareas, ni altas, ni miembros levantados, y el run sigue
    // esperando una decisión que se pueda cumplir.
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
    expect(b.service.coordinationEngine.listHires(run.id)).toHaveLength(0);
    expect(members).toHaveLength(0);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
    // Ni el permiso del coordinador, ni la autoridad, ni la foto de roles.
    expect(b.repo.getMeta('coordination_approved_roles:' + run.id)).toBeNull();
  });

  it('el mismo plan recortado —sin la tarea del rol destildado— SÍ se aprueba', async () => {
    const run = await proposeTwoRoles();
    const edited = JSON.stringify({
      plan: [{ roleId: 'strategist', spec: 'definir el naming' }],
      membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    });

    const view = await b.service.resolveCoordinationGate('proposal:' + run.id, 'approve', edited);

    expect(view.status).toBe('running');
    expect(b.repo.listCoordinationTasks(run.id).map((t) => t.roleId)).toEqual(['strategist']);
    expect(members.map((m) => m.roleId)).toEqual(['strategist']);
  });

  it('un rol que YA es miembro del Trabajo no necesita contratación: el plan se aprueba igual', async () => {
    // El miembro de VERDAD, en la base: `workHasMemberForRole` mira el equipo
    // persistido, no la lista del hub que el fake mueve.
    const at = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({
      id: 'mem_ya_esta', workId, roleId: 'copywriter', roleName: 'Copywriter', initial: 'C',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
    members.push({ id: 'mem_ya_esta', workId, roleId: 'copywriter', status: 'idle' });
    const run = await proposeTwoRoles();
    const edited = JSON.stringify({
      plan: [
        { roleId: 'strategist', spec: 'definir el naming' },
        { roleId: 'copywriter', spec: 'escribir el copy', dependsOn: [0] },
      ],
      membersToHire: [{ roleId: 'strategist', why: 'no hay estratega' }],
      estimatedDispatches: 4,
      rationale: 'porque sí',
    });

    const view = await b.service.resolveCoordinationGate('proposal:' + run.id, 'approve', edited);

    expect(view.status).toBe('running');
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(2);
  });

  it('aprobar sin editar sigue funcionando: el plan y sus contrataciones vienen del mismo lado', async () => {
    const run = await proposeTwoRoles();

    const view = await b.service.resolveCoordinationGate('proposal:' + run.id, 'approve');

    expect(view.status).toBe('running');
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(2);
  });
});
