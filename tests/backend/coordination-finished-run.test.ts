import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Un run que termina desaparecía de la interfaz. `getCoordinationRun` sólo
 * devolvía el run ACTIVO, así que en cuanto el run pasaba a `done` (o a
 * `cancelled`) el getter contestaba `null`, el hook limpiaba bitácora, gates y
 * preguntas, y la entrada de cierre `run_done` —la que el backend deriva justo
 * para contar cómo terminó— no se veía NUNCA.
 *
 * Terminar no es desaparecer: el último run terminado del Trabajo se sigue
 * devolviendo, con `active: false` para que nada lo confunda con uno vivo.
 */
describe('un run terminado se sigue viendo, con su bitácora (crítico: la UI borraba la bitácora)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [{ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' }];
    fakeCoordinationHub(b, members);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  });
  afterEach(() => b.cleanup());

  it('sin ningún run, el getter sigue devolviendo `null`', async () => {
    expect(await b.service.getCoordinationRun(workId)).toBeNull();
  });

  it('un run vivo viene marcado como activo', async () => {
    await engine.startRun(workId, 'mem_coordinator');
    const view = await b.service.getCoordinationRun(workId);
    expect(view).toMatchObject({ status: 'running', active: true });
  });

  it('un run CANCELADO se sigue devolviendo, con `active: false`', async () => {
    const run = await engine.startRun(workId, 'mem_coordinator');
    engine.cancelRun(run.id);
    const view = await b.service.getCoordinationRun(workId);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({ id: run.id, status: 'cancelled', active: false });
  });

  it('un run TERMINADO se sigue devolviendo, y su bitácora sigue en pie', async () => {
    const run = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString(), null);

    const view = await b.service.getCoordinationRun(workId);
    expect(view).toMatchObject({ id: run.id, status: 'done', active: false });
    // Y la bitácora se puede leer: ése es el punto — el hook la vaciaba porque
    // el getter contestaba `null`.
    await expect(b.service.listCoordinationLog(run.id)).resolves.toBeInstanceOf(Array);
  });

  it('un run NUEVO reemplaza al terminado: nunca se muestra el viejo por encima del vivo', async () => {
    const first = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(first.id, 'done', new Date().toISOString(), null);
    expect(await b.service.getCoordinationRun(workId)).toMatchObject({ id: first.id, active: false });

    const second = await engine.startRun(workId, 'mem_coordinator');
    expect(await b.service.getCoordinationRun(workId)).toMatchObject({ id: second.id, active: true });
  });

  it('entre dos runs terminados gana el ÚLTIMO', async () => {
    const first = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(first.id, 'done', '2026-09-01T00:00:00.000Z', null);
    const second = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(second.id, 'cancelled', '2026-09-02T00:00:00.000Z', null);
    expect(await b.service.getCoordinationRun(workId)).toMatchObject({ id: second.id, status: 'cancelled', active: false });
  });

  it('un run terminado NO aparece en la tira global de equipos activos', async () => {
    const run = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString(), null);
    const active = await b.service.listActiveCoordinationRuns();
    expect(active.some((row) => row.runId === run.id)).toBe(false);
  });
});
