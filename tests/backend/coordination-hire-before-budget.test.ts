import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationEngine, CoordinationGrant } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R2: EL PRESUPUESTO SE CONSULTA ANTES DE CONTRATAR.
 *
 * `startDispatch` contrataba primero —`reserveTargetMember` + `hub.addMember`,
 * o sea fila, token, cupo de techo y PROCESO REAL— y recién después, ya dentro
 * de la transacción, miraba `max_concurrent`, `reserveDispatch`, el tope global
 * y la legibilidad del presupuesto. Cuando alguno decía que no, el rollback no
 * despedía a nadie (a diferencia de `resolveProposalGate`, que sí compensa), y
 * como `recordHire` vive DENTRO de la transacción, el alta ni siquiera quedaba
 * en la bitácora: dos miembros en el equipo, una sola alta registrada.
 *
 * El arreglo tiene tres partes y las tres se prueban acá:
 *   (a) un pre-chequeo barato, sincrónico, en el MISMO tick del reclamo de la
 *       tarea y ANTES del await: con el presupuesto ya agotado no se contrata a
 *       nadie;
 *   (b) la transacción posterior re-chequea igual que siempre, porque el mundo
 *       cambia durante el spawn;
 *   (c) si la transacción deniega y el miembro se contrató PARA ESTE despacho,
 *       se compensa con `hub.removeMember`; y si la compensación falla, el alta
 *       se registra igual — la verdad manda.
 */
describe('R2: el presupuesto se consulta antes de contratar, y si niega se deshace', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  async function setup(maxDispatches: number, hold?: () => Promise<void> | void) {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    const hub = fakeCoordinationHub(b, members, hold ? { hold } : {});
    engine = b.service.coordinationEngine;
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b', 'role_c');
    return hub;
  }

  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- (a) el tope ya agotado: no se contrata a nadie ------------------------

  it('con el tope agotado, el segundo despacho de un rol sin miembro no contrata ni levanta nada', async () => {
    const { send } = await setup(1);
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const second = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    await engine.startDispatch({ grant: coordinator(), taskId: first.id });
    expect(members).toHaveLength(1); // la primera contratación sí pasó

    await expect(engine.startDispatch({ grant: coordinator(), taskId: second.id })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    expect(members).toHaveLength(1); // cero miembros nuevos
    expect(send.mock.calls).toHaveLength(1); // cero procesos puestos a trabajar
    expect(await b.service.listCoordinationHires(runId)).toHaveLength(1);
    // Y la denegación queda anotada donde se anotan todas: la tarea vuelve a la
    // cola y el run se suspende con su razón.
    expect(b.repo.getCoordinationTask(second.id).status).toBe('ready');
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('max_dispatches');
  });

  // --- (b)+(c) el tope se agota DURANTE el spawn: se compensa ----------------

  it('el presupuesto se agota mientras se levanta el proceso: la contratación se deshace', async () => {
    const spawn = deferred<void>();
    await setup(2, () => spawn.promise);
    // La compensación tiene que llegar al hub de verdad; el hub falso no tiene
    // fila para estos miembros, así que se observa y se aplica sobre la lista.
    const removed: string[] = [];
    vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
      removed.push(memberId);
      const at = members.findIndex((m) => m.id === memberId);
      if (at !== -1) members.splice(at, 1);
    });
    const tasks = (['role_a', 'role_b', 'role_c'] as const).map((roleId) => engine.taskCreate(runId, { roleId, spec: roleId }));

    // Los tres despachos entran a la vez: los tres pasan el pre-chequeo (nadie
    // reservó todavía) y los tres quedan parados en el spawn.
    const flights = tasks.map((t) => engine.startDispatch({ grant: coordinator(), taskId: t.id }).then(() => 'ok' as const, (e: { code?: string }) => e.code ?? 'error'));
    await settle();
    expect(members).toHaveLength(3);
    spawn.resolve();
    const outcomes = await Promise.all(flights);

    // Dos entran, el tercero choca contra el tope en la transacción.
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
    expect(outcomes).toContain('BUDGET_EXCEEDED');
    // Y su contratación se deshizo: el miembro no quedó en el equipo ni en la bitácora.
    expect(removed).toHaveLength(1);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.id)).not.toContain(removed[0]);
    const hires = await b.service.listCoordinationHires(runId);
    expect(hires).toHaveLength(2);
    expect(hires.map((h) => h.memberId)).not.toContain(removed[0]);
  });

  it('si la compensación falla, el alta se registra igual: la bitácora dice la verdad', async () => {
    const spawn = deferred<void>();
    await setup(2, () => spawn.promise);
    const attempted: string[] = [];
    vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
      attempted.push(memberId);
      throw new Error('el proceso ya no responde');
    });
    const tasks = (['role_a', 'role_b', 'role_c'] as const).map((roleId) => engine.taskCreate(runId, { roleId, spec: roleId }));

    const flights = tasks.map((t) => engine.startDispatch({ grant: coordinator(), taskId: t.id }).then(() => 'ok' as const, (e: { code?: string }) => e.code ?? 'error'));
    await settle();
    spawn.resolve();
    const outcomes = await Promise.all(flights);

    expect(outcomes).toContain('BUDGET_EXCEEDED');
    expect(attempted).toHaveLength(1);
    // El miembro sigue vivo, así que el alta TIENE que estar anotada: ocultarla
    // dejaría un proceso contratado que ninguna bitácora nombra.
    expect(members).toHaveLength(3);
    const hires = await b.service.listCoordinationHires(runId);
    expect(hires).toHaveLength(3);
    expect(hires.map((h) => h.memberId)).toContain(attempted[0]);
  });
});
