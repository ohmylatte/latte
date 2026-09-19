import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

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

  /**
   * Los DOS finales dejan constancia. `run_done` existía desde el slice del
   * cierre; `cancelled` —el otro final, el que la persona aprieta— no tenía
   * entrada equivalente, así que la última línea de la bitácora de un run
   * cancelado era el despacho que quedó a medio camino: se leía como si el
   * equipo siguiera trabajando.
   */
  describe('la bitácora deja constancia de los DOS finales', () => {
    it('un run CANCELADO cierra con `run_cancelled`, contando lo hecho y lo que quedó sin terminar', async () => {
      const run = await engine.startRun(workId, 'mem_coordinator');
      approveCoordinationRoles(b, run.id, 'strategist'); // U10: crear una tarea exige el rol aprobado
      const done = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'a' });
      const pending = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'b' });
      b.repo.updateCoordinationTask(done.id, { status: 'done' }, new Date().toISOString());

      engine.cancelRun(run.id);

      const log = await b.service.listCoordinationLog(run.id);
      const closing = log.filter((entry) => entry.kind === 'run_cancelled');
      expect(closing).toHaveLength(1);
      expect(closing[0]).toMatchObject({ runId: run.id, tasksDone: 1, tasksPending: 1 });
      expect(closing[0].createdAt).toBe(b.repo.getCoordinationRun(run.id).updatedAt);
      // Y NO la del otro final: un run cancelado no "terminó".
      expect(log.filter((entry) => entry.kind === 'run_done')).toEqual([]);
      expect(pending.id).toBeTruthy();
    });

    it('un run VIVO todavía no tiene entrada de cierre de ninguna de las dos clases', async () => {
      const run = await engine.startRun(workId, 'mem_coordinator');
      approveCoordinationRoles(b, run.id, 'strategist'); // U10: crear una tarea exige el rol aprobado
      engine.taskCreate(run.id, { roleId: 'strategist', spec: 'a' });

      const log = await b.service.listCoordinationLog(run.id);
      expect(log.filter((entry) => entry.kind === 'run_cancelled')).toEqual([]);
      expect(log.filter((entry) => entry.kind === 'run_done')).toEqual([]);
    });

    it('un run TERMINADO cierra con `run_done`, nunca con `run_cancelled`', async () => {
      const run = await engine.startRun(workId, 'mem_coordinator');
      b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString(), null);

      const log = await b.service.listCoordinationLog(run.id);
      expect(log.filter((entry) => entry.kind === 'run_done')).toHaveLength(1);
      expect(log.filter((entry) => entry.kind === 'run_cancelled')).toEqual([]);
    });
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

  /**
   * D18: la tira dejó de ser "sólo lo activo" y pasó a ser la fuente de
   * "desde tu última visita". Un equipo que TERMINA es exactamente la novedad
   * que Inicio tiene que poder contar, y desaparecer de la fuente en el mismo
   * instante en que había algo que decir era el motivo por el que no la
   * contaba nunca. Sigue sin parecer vivo: viaja con su `status` real.
   */
  it('un run recién terminado sigue en la tira hasta que la persona lo mira', async () => {
    const run = await engine.startRun(workId, 'mem_coordinator');
    b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString(), null);

    const before = await b.service.listActiveCoordinationRuns();
    const row = before.find((r) => r.runId === run.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('done');

    await b.service.markCoordinationSeen(workId);

    const after = await b.service.listActiveCoordinationRuns();
    expect(after.some((r) => r.runId === run.id)).toBe(false);
  });
});
