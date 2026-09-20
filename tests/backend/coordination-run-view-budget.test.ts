import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q10: LA VISTA DEL RUN TOLERA UN PRESUPUESTO ILEGIBLE.
 *
 * `toCoordinationRunView` hacía `JSON.parse(run.budgetJson)` a pelo mientras
 * todos sus vecinos —la tira global, el getter del presupuesto del Trabajo, el
 * camino de despacho— ya pasaban por el parser discriminado. Una fila con
 * `budget_json` roto tiraba desde el fondo de `getCoordinationRun` Y de
 * `cancelCoordinationRun`: la persona se quedaba sin ver su equipo y, peor, sin
 * la única salida que le queda cuando algo se rompe, que es cancelarlo.
 *
 * Ilegible no es "sin tope": se dice que está roto, igual que en la tira.
 */
describe('Q10: `budget_json` roto en la vista del run', () => {
  let b: TestBackend;
  let workId: string;
  let runId: string;
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
    runId = (await b.service.startCoordinationRun(workId)).id;
    // Los bytes se rompen después, como se rompen de verdad: la fila ya existía.
    b.repo.updateActiveCoordinationRunBudget(workId, '{no es json', new Date().toISOString());
    expect(b.repo.getCoordinationRun(runId).budgetJson).toBe('{no es json');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('`getCoordinationRun` contesta, y dice que el presupuesto está roto', async () => {
    const view = await b.service.getCoordinationRun(workId);

    expect(view).not.toBeNull();
    expect(view!.id).toBe(runId);
    expect(view!.budgetInvalid).toBe(true);
    // Nunca un presupuesto inventado, y nunca "sin tope".
    expect(view!.budget).toBeNull();
    expect(view!.status).toBe('running');
  });

  it('y cancelar sigue siendo posible: la salida no puede depender de bytes sanos', async () => {
    const cancelled = await b.service.cancelCoordinationRun(runId);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.budgetInvalid).toBe(true);
    expect(b.repo.getCoordinationRun(runId).status).toBe('cancelled');
  });

  it('con los bytes sanos no cambia nada: el presupuesto viaja y no se declara roto', async () => {
    b.repo.updateActiveCoordinationRunBudget(workId, JSON.stringify({ maxDispatches: 7, unlimitedConfirmedAt: null }), new Date().toISOString());

    const view = await b.service.getCoordinationRun(workId);

    expect(view!.budgetInvalid).toBe(false);
    expect(view!.budget).toMatchObject({ maxDispatches: 7 });
  });
});
