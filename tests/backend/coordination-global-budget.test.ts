import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { readCoordinationGlobalBudget } from '../../electron/coordination/budget';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Crítico 8: dos lectores del mismo dato con semánticas OPUESTAS.
 *
 * `getCoordinationGlobalBudget` (lo que ve la persona) devolvía `null` —"sin
 * tope"— ante un JSON ilegible, y `readGlobalBudget` (el camino de despacho)
 * TIRABA ante esos mismos bytes, y tirar deniega. La pantalla decía "sin tope
 * global" mientras cada despacho fallaba con un error opaco. Los dos leían el
 * mismo meta y contestaban cosas contrarias.
 *
 * Ahora hay UN solo parser con resultado discriminado, y los dos lo usan:
 * ausente / configurado / ilegible son tres estados, no dos.
 */
describe('el tope global ilegible se muestra y deniega, no se disfraza de sin tope (crítico 8)', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  const BYTES_ILEGIBLES = '{maxDispatches: 40'; // ni JSON: lo que deja un archivo truncado o una escritura a medias

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [{ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' }];
    fakeCoordinationHub(b, members);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto'); // sin gate por despacho: el único freno tiene que ser el tope global
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    const run = await engine.startRun(workId, 'mem_coordinator');
    runId = run.id;
    approveCoordinationRoles(b, runId, 'strategist');
  });
  afterEach(() => b.cleanup());

  async function dispatchOnce() {
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'Hacer algo' });
    return engine.startDispatch({ grant: coordinator(), taskId: task.id });
  }

  // --- el getter dice la verdad ----------------------------------------------

  it('ante bytes ilegibles el getter devuelve el estado inválido, NUNCA null disfrazado de "sin tope"', async () => {
    b.repo.setMeta('coordination_budget_global', BYTES_ILEGIBLES);
    expect(await b.service.getCoordinationGlobalBudget()).toEqual({ state: 'invalid' });
  });

  it('sin tope configurado el estado es `unset`, y con un tope válido es `set` con su presupuesto', async () => {
    expect(await b.service.getCoordinationGlobalBudget()).toEqual({ state: 'unset' });
    await b.service.setCoordinationGlobalBudget({ maxDispatches: 40 });
    expect(await b.service.getCoordinationGlobalBudget()).toMatchObject({ state: 'set', budget: { maxDispatches: 40 } });
  });

  // --- el despacho deniega con una razón que se lee ---------------------------

  it('un despacho con el tope global ilegible se deniega con una razón explícita, y esa razón queda en la bitácora y en la suspensión', async () => {
    b.repo.setMeta('coordination_budget_global', BYTES_ILEGIBLES);

    await expect(dispatchOnce()).rejects.toMatchObject({ code: 'GLOBAL_BUDGET_INVALID' });

    expect(b.hub.send).not.toHaveBeenCalled();
    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('global_budget_invalid');
    const denied = b.repo.listCoordinationCostLedger(runId).filter((row) => row.kind === 'denied');
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0].detailJson ?? '{}')).toMatchObject({ reason: 'global_budget_invalid' });
  });

  it('escribir un tope válido encima repara el estado: el getter vuelve a `set` y el despacho sale', async () => {
    b.repo.setMeta('coordination_budget_global', BYTES_ILEGIBLES);
    await expect(dispatchOnce()).rejects.toMatchObject({ code: 'GLOBAL_BUDGET_INVALID' });

    // El setter tiene que poder sobreescribir un valor corrupto: si no, la
    // persona queda encerrada en un estado del que no puede salir.
    await b.service.setCoordinationGlobalBudget({ maxDispatches: 40 });
    expect(await b.service.getCoordinationGlobalBudget()).toMatchObject({ state: 'set', budget: { maxDispatches: 40 } });

    engine.resumeRun(runId);
    const outcome = await dispatchOnce();
    expect(outcome.status).toBe('dispatched');
    expect(b.hub.send).toHaveBeenCalledTimes(1);
  });

  // --- los dos lectores, el mismo veredicto -----------------------------------

  describe('para los mismos bytes, los dos lectores dan el mismo veredicto', () => {
    const casos: Array<{ label: string; raw: string | null; kind: 'unset' | 'set' | 'invalid' }> = [
      { label: 'ausente', raw: null, kind: 'unset' },
      { label: 'vacío', raw: '', kind: 'unset' },
      { label: 'válido', raw: JSON.stringify({ maxDispatches: 40, unlimitedConfirmedAt: null }), kind: 'set' },
      { label: 'no es JSON', raw: '{maxDispatches: 40', kind: 'invalid' },
      { label: 'JSON que el validador rechaza', raw: JSON.stringify({ maxDispatches: 0 }), kind: 'invalid' },
      { label: 'ilimitado sin confirmar', raw: JSON.stringify({ maxDispatches: null }), kind: 'invalid' },
      { label: 'no es un objeto', raw: '"40"', kind: 'invalid' },
    ];

    for (const caso of casos) {
      it(`${caso.label}: el parser dice ${caso.kind} y el getter IPC dice lo mismo`, async () => {
        expect(readCoordinationGlobalBudget(caso.raw).kind).toBe(caso.kind);
        if (caso.raw == null) b.repo.deleteMeta('coordination_budget_global');
        else b.repo.setMeta('coordination_budget_global', caso.raw);
        expect((await b.service.getCoordinationGlobalBudget()).state).toBe(caso.kind);
      });
    }

    it('y el camino de despacho también: `invalid` deniega, `unset` no aplica tope, `set` aplica el suyo', async () => {
      // unset: no hay tope extra, el despacho sale.
      b.repo.deleteMeta('coordination_budget_global');
      expect((await dispatchOnce()).status).toBe('dispatched');

      // set, ya consumido: deniega por el tope, no por ilegible.
      await b.service.setCoordinationGlobalBudget({ maxDispatches: 1 });
      engine.resumeRun(runId);
      await expect(dispatchOnce()).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('global_max_dispatches');

      // invalid: deniega con SU razón, distinta de "se pasó del tope".
      b.repo.setMeta('coordination_budget_global', BYTES_ILEGIBLES);
      engine.resumeRun(runId);
      await expect(dispatchOnce()).rejects.toMatchObject({ code: 'GLOBAL_BUDGET_INVALID' });
      expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('global_budget_invalid');
    });
  });
});
