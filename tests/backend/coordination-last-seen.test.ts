import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * "Desde tu última visita" no medía ninguna visita: no había timestamp
 * persistido en ningún lado, así que la tarjeta mostraba el estado ACTUAL
 * bajo un título que habla del pasado. Ahora la visita se marca de verdad,
 * en `coordination_last_seen:<workId>`, y viaja con cada run activo.
 */
describe('la última visita a la coordinación se mide de verdad', () => {
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

  it('marcar la visita guarda un ISO y devuelve el mismo que guardó', async () => {
    const at = await b.service.markCoordinationSeen(workId);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.repo.getMeta('coordination_last_seen:' + workId)).toBe(at);
  });

  it('volver a marcar PISA la visita anterior: la última visita es la última', async () => {
    const first = await b.service.markCoordinationSeen(workId);
    await new Promise((r) => setTimeout(r, 5));
    const second = await b.service.markCoordinationSeen(workId);
    expect(second >= first).toBe(true);
    expect(b.repo.getMeta('coordination_last_seen:' + workId)).toBe(second);
  });

  it('valida el workId: ni basura ni un Trabajo que no existe', async () => {
    await expect(b.service.markCoordinationSeen('')).rejects.toThrow();
    await expect(b.service.markCoordinationSeen('wrk_no_existe')).rejects.toThrow();
  });

  it('la visita es POR Trabajo: marcar uno no marca al otro', async () => {
    const brand = await b.service.createBrand('Otra');
    const other = await b.service.createWork(brand.id, 'Otro trabajo');
    await b.service.markCoordinationSeen(workId);
    expect(b.repo.getMeta('coordination_last_seen:' + other.id)).toBeNull();
  });

  it('cada run activo viaja con su `updatedAt` y con la visita de su Trabajo', async () => {
    await engine.startRun(workId, 'mem_coordinator');
    const before = await b.service.listActiveCoordinationRuns();
    expect(before).toHaveLength(1);
    expect(before[0].lastSeenAt).toBeNull();
    expect(before[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const at = await b.service.markCoordinationSeen(workId);
    const after = await b.service.listActiveCoordinationRuns();
    expect(after).toHaveLength(1);
    expect(after[0].lastSeenAt).toBe(at);
  });
});
