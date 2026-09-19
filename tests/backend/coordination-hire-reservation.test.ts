import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F3: la reserva de contratación no se toma antes de lo que puede fallar.
 *
 * `reserveTargetMember` hacía `assigning.add('hire:<work>|<rol>')` y RECIÉN
 * DESPUÉS llamaba a `memberContext(workId)`, que hace I/O de disco y puede
 * tirar. Si tiraba, `startDispatch` todavía no había copiado la clave en
 * `reservationKey` —sigue `null`—, así que ni el `catch` ni el `finally` la
 * soltaban: la clave quedaba en el Set para toda la sesión y TODO despacho
 * siguiente de ese rol moría con `MEMBER_BUSY`. Un fallo transitorio de disco
 * dejaba un rol inhabilitado para siempre.
 *
 * El contexto se resuelve ANTES de reservar: lo que puede fallar falla sin
 * haber tomado nada.
 */
describe('F3: un contexto que falla no deja la contratación reservada', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;
  let engine: CoordinationEngine;
  let failNextContext = false;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    members = [];
    fakeCoordinationHub(b, members);
    failNextContext = false;
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => {
        if (failNextContext) {
          failNextContext = false;
          throw new Error('EBUSY: no se pudo leer el directorio del Trabajo');
        }
        return { workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} };
      },
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el segundo despacho del mismo rol no rebota con MEMBER_BUSY', async () => {
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    failNextContext = true;
    await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toThrow(/EBUSY/);
    // El reclamo se soltó: la tarea volvió a la cola tal cual estaba.
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');

    // Y la contratación no quedó reservada por nadie.
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

    expect(outcome.status).toBe('dispatched');
    expect(b.repo.getCoordinationDispatch(outcome.dispatchId).memberId).not.toBe('');
  });
});
