import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { readStoredCoordinationBudget } from '../../electron/coordination/budget';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * El MISMO defecto del crítico 8, un nivel más abajo: el presupuesto de ESTE
 * Trabajo. `engine.readBudget` y `latteService.readCoordinationBudget` hacían
 * cada uno su `JSON.parse` a mano y devolvían `null` ante bytes ilegibles, así
 * que "no se pudo leer" se disfrazaba de "nunca se configuró" — y la pantalla
 * dice "sin presupuesto configurado" sobre un dato roto que además deniega.
 *
 * Tres estados, un solo parser, el mismo veredicto en los dos lados.
 */
describe('el presupuesto de un Trabajo ilegible se muestra y deniega (crítico 8, nivel Trabajo)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;

  const BYTES_ILEGIBLES = '{maxDispatches: 10'; // ni JSON: una escritura a medias

  const metaKey = () => 'coordination_budget:' + workId;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
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
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  });
  afterEach(() => b.cleanup());

  // --- el getter dice la verdad ----------------------------------------------

  it('ante bytes ilegibles el getter devuelve `invalid`, nunca "sin presupuesto configurado"', async () => {
    b.repo.setMeta(metaKey(), BYTES_ILEGIBLES);
    expect(await b.service.getCoordinationBudget(workId)).toEqual({ state: 'invalid' });
  });

  it('ausente es `unset` y configurado es `set`, con su presupuesto adentro', async () => {
    b.repo.deleteMeta(metaKey());
    expect(await b.service.getCoordinationBudget(workId)).toEqual({ state: 'unset' });
    await b.service.setCoordinationBudget(workId, { maxDispatches: 7 });
    expect(await b.service.getCoordinationBudget(workId)).toMatchObject({ state: 'set', budget: { maxDispatches: 7 } });
  });

  it('para los mismos bytes, el parser y el getter IPC dan el mismo veredicto', async () => {
    const casos: Array<{ label: string; raw: string | null; kind: 'unset' | 'set' | 'invalid' }> = [
      { label: 'ausente', raw: null, kind: 'unset' },
      { label: 'vacío', raw: '', kind: 'unset' },
      { label: 'válido', raw: JSON.stringify({ maxDispatches: 10, unlimitedConfirmedAt: null }), kind: 'set' },
      { label: 'no es JSON', raw: BYTES_ILEGIBLES, kind: 'invalid' },
      { label: 'JSON que el validador rechaza', raw: JSON.stringify({ maxDispatches: 0 }), kind: 'invalid' },
      { label: 'ilimitado sin confirmar', raw: JSON.stringify({ maxDispatches: null }), kind: 'invalid' },
      { label: 'no es un objeto', raw: '"10"', kind: 'invalid' },
    ];
    expect(casos).toHaveLength(7);
    for (const caso of casos) {
      expect(readStoredCoordinationBudget(caso.raw).kind, caso.label).toBe(caso.kind);
      if (caso.raw == null) b.repo.deleteMeta(metaKey());
      else b.repo.setMeta(metaKey(), caso.raw);
      expect((await b.service.getCoordinationBudget(workId)).state, caso.label).toBe(caso.kind);
    }
  });

  // --- arrancar un run con el presupuesto roto no dice "no hay presupuesto" ---

  it('`startRun` con el presupuesto ilegible falla con su propia razón, no con BUDGET_UNSET', async () => {
    b.repo.setMeta(metaKey(), BYTES_ILEGIBLES);
    await expect(engine.startRun(workId, 'mem_coordinator')).rejects.toMatchObject({ code: 'COORDINATION_BUDGET_INVALID' });
  });

  it('sin presupuesto SÍ sigue siendo BUDGET_UNSET: los dos estados no se confunden', async () => {
    b.repo.deleteMeta(metaKey());
    await expect(engine.startRun(workId, 'mem_coordinator')).rejects.toMatchObject({ code: 'BUDGET_UNSET' });
  });

  // --- el despacho deniega con una razón que se lee ---------------------------

  it('un despacho contra un presupuesto de run ilegible se deniega con `budget_invalid` en la bitácora y en la suspensión', async () => {
    const run = await engine.startRun(workId, 'mem_coordinator');
    approveCoordinationRoles(b, run.id, 'strategist');
    // El snapshot del run se corrompe (una escritura a medias, una migración
    // a mano): el camino de despacho lo lee de ahí.
    b.repo.updateActiveCoordinationRunBudget(workId, BYTES_ILEGIBLES, new Date().toISOString());

    const task = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'Hacer algo' });
    const coordinator: CoordinationGrant = { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' };
    await expect(engine.startDispatch({ grant: coordinator, taskId: task.id })).rejects.toMatchObject({ code: 'COORDINATION_BUDGET_INVALID' });

    expect(b.hub.send).not.toHaveBeenCalled();
    const after = b.repo.getCoordinationRun(run.id);
    expect(after.status).toBe('suspended');
    expect(after.suspendReason).toBe('budget_invalid');
    const denied = b.repo.listCoordinationCostLedger(run.id).filter((row) => row.kind === 'denied');
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0].detailJson ?? '{}')).toMatchObject({ reason: 'budget_invalid' });
  });

  it('escribir un presupuesto válido encima lo repara: el getter vuelve a `set` y el despacho sale', async () => {
    b.repo.setMeta(metaKey(), BYTES_ILEGIBLES);
    expect(await b.service.getCoordinationBudget(workId)).toEqual({ state: 'invalid' });

    await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
    expect(await b.service.getCoordinationBudget(workId)).toMatchObject({ state: 'set', budget: { maxDispatches: 5 } });

    const run = await engine.startRun(workId, 'mem_coordinator');
    approveCoordinationRoles(b, run.id, 'strategist');
    const task = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'Hacer algo' });
    const outcome = await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' }, taskId: task.id });
    expect(outcome.status).toBe('dispatched');
  });
});
