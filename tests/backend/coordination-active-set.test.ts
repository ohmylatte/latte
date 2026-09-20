import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { MAX_ACTIVE_COORDINATION_RUNS } from '../../electron/coordination/limits';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * El conjunto ACTIVO del repositorio no puede incluir lo terminado.
 *
 * D18 hizo que la TIRA (la vista de `latteService`) sume el último run
 * terminado de cada Trabajo mientras la persona no haya pasado por ahí. Eso es
 * una decisión de presentación y vive en el servicio. El conjunto del
 * REPOSITORIO es otra cosa: es lo que alimenta el techo
 * `MAX_ACTIVE_COORDINATION_RUNS`, el gasto comprometido del agregado y el
 * índice único parcial de un run activo por Trabajo. Si un `done` se colara
 * ahí, cuatro equipos TERMINADOS volverían a dejar a la aplicación sin poder
 * coordinar nunca más — exactamente el crítico 1 del brief, por la puerta de
 * atrás.
 *
 * Este archivo lo fija con tests, del lado del repo y del lado del servicio.
 */
describe('el conjunto activo del repositorio contra la vista de la tira', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function newWork(title: string): Promise<string> {
    const work = await b.service.createWork(brandId, title);
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    return work.id;
  }

  it('un run `done` y uno `cancelled` salen del conjunto activo del repo, en lista y en conteo', async () => {
    const doneWork = await newWork('Terminado');
    const cancelledWork = await newWork('Cancelado');
    const liveWork = await newWork('Vivo');
    const done = await engine.startRun(doneWork, null);
    const cancelled = await engine.startRun(cancelledWork, null);
    const live = await engine.startRun(liveWork, null);
    b.repo.updateCoordinationRunStatus(done.id, 'done', new Date().toISOString());
    engine.cancelRun(cancelled.id);

    const active = b.repo.listActiveCoordinationRuns();
    // El largo primero: un `.every`/`.some` sobre una lista vacía miente.
    expect(active).toHaveLength(1);
    expect(active.map((run) => run.id)).toEqual([live.id]);
    expect(b.repo.countActiveCoordinationRuns()).toBe(1);
  });

  it('el techo de runs activos NO lo ocupan los terminados: con cuatro cerrados se puede coordinar de nuevo', async () => {
    for (let i = 0; i < MAX_ACTIVE_COORDINATION_RUNS; i += 1) {
      const workId = await newWork(`Terminado ${i}`);
      const run = await engine.startRun(workId, null);
      b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString());
    }
    expect(b.repo.countActiveCoordinationRuns()).toBe(0);

    const fresh = await newWork('Uno más');
    const run = await engine.startRun(fresh, null);
    expect(run.status).toBe('running');
    expect(b.repo.countActiveCoordinationRuns()).toBe(1);
  });

  it('el mismo Trabajo puede volver a coordinar después de que su run terminó (el índice único lee el conjunto activo)', async () => {
    const workId = await newWork('Reincidente');
    const first = await engine.startRun(workId, null);
    b.repo.updateCoordinationRunStatus(first.id, 'done', new Date().toISOString());

    const second = await engine.startRun(workId, null);
    expect(second.id).not.toBe(first.id);
    expect(b.repo.listActiveCoordinationRuns().map((r) => r.id)).toEqual([second.id]);
  });

  it('la VISTA de `latteService` sí agrega el terminado, con su `status` real y sin disfrazarlo de vivo', async () => {
    const workId = await newWork('Terminado');
    const run = await engine.startRun(workId, null);
    b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString());

    const rows = await b.service.listActiveCoordinationRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: run.id, workId, status: 'done' });
    // Y la vista por Trabajo lo declara NO activo: ninguna acción de run vivo.
    const view = await b.service.getCoordinationRun(workId);
    expect(view).not.toBeNull();
    expect(view!.status).toBe('done');
    expect(view!.active).toBe(false);
  });

  it('una vez que la persona pasó por ahí, el terminado deja de aparecer en la tira', async () => {
    const workId = await newWork('Terminado');
    const run = await engine.startRun(workId, null);
    b.repo.updateCoordinationRunStatus(run.id, 'done', new Date().toISOString());
    expect(await b.service.listActiveCoordinationRuns()).toHaveLength(1);

    await b.service.markCoordinationSeen(workId);

    expect(await b.service.listActiveCoordinationRuns()).toEqual([]);
  });
});
