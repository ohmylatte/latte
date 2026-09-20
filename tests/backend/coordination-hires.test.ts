import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * `coordinationHires` estaba testeado en tres archivos del renderer y NO TENÍA
 * FUENTE DE DATOS: nadie lo alimentaba, así que la bitácora nunca mostró una
 * sola contratación. Ahora la contratación se anota donde pasa —en la misma
 * transacción sincrónica que commitea el despacho— y la vista la lee de ahí.
 */
describe('las contrataciones del run tienen fuente de datos', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  const coordinator = (): CoordinationGrant => ({ workId, runId, memberId: 'mem_coordinator', role: 'coordinator' });

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [{ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' }];
    fakeCoordinationHub(b, members);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, 'mem_coordinator');
    runId = run.id;
    approveCoordinationRoles(b, runId, 'strategist', 'copywriter');
  });
  afterEach(() => b.cleanup());

  async function dispatch(roleId: string) {
    const task = engine.taskCreate(runId, { roleId, spec: 'Hacer algo' });
    return engine.startDispatch({ grant: coordinator(), taskId: task.id });
  }

  it('un run sin despachos no tiene ninguna contratación anotada', async () => {
    expect(await b.service.listCoordinationHires(runId)).toEqual([]);
  });

  it('un despacho que REUSA un miembro que ya estaba no anota ninguna contratación', async () => {
    const outcome = await dispatch('strategist'); // mem_coordinator ya existe con ese rol
    expect(outcome.status).toBe('dispatched');
    expect(await b.service.listCoordinationHires(runId)).toEqual([]);
  });

  it('un despacho que CONTRATA lo deja anotado, con el rol y el instante', async () => {
    const outcome = await dispatch('copywriter'); // nadie tiene ese rol todavía
    expect(outcome.status).toBe('dispatched');
    const hires = await b.service.listCoordinationHires(runId);
    expect(hires).toHaveLength(1);
    expect(hires[0].roleId).toBe('copywriter');
    expect(hires[0].memberId).not.toBe('');
    expect(hires[0].hiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // La vista muestra un NOMBRE, nunca un id crudo.
    expect(hires[0].roleName.length).toBeGreaterThan(0);
  });

  it('contratar una vez y reusar después deja UNA sola contratación', async () => {
    await dispatch('copywriter');
    await dispatch('copywriter');
    expect(await b.service.listCoordinationHires(runId)).toHaveLength(1);
  });

  it('el registro es POR run: otro run no ve las contrataciones de éste', async () => {
    await dispatch('copywriter');
    expect(await b.service.listCoordinationHires(runId)).toHaveLength(1);
    engine.cancelRun(runId);
    const other = await engine.startRun(workId, 'mem_coordinator');
    expect(await b.service.listCoordinationHires(other.id)).toEqual([]);
  });

  it('un registro ilegible se lee como vacío, nunca tumba la bitácora entera', async () => {
    b.repo.setMeta('coordination_hires:' + runId, '{no es json');
    expect(await b.service.listCoordinationHires(runId)).toEqual([]);
  });
});
