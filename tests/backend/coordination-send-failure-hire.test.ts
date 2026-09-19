import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q9: UN ENVÍO FALLIDO DESHACE LA CONTRATACIÓN QUE HIZO PARA ÉL.
 *
 * `hub.send` es el último efecto del despacho y corre DESPUÉS del commit. Su
 * `catch` ya liquidaba la reserva sin cargo y devolvía la tarea a `ready` —no
 * se cobra un despacho que nunca salió—, pero el miembro que se había
 * contratado para ESE despacho quedaba: su fila, su token, su cupo del techo de
 * la app y su proceso, para un trabajo que no se hizo y que al reintentarse va
 * a contratar de nuevo. R2 ya compensaba así las otras dos salidas de este
 * mismo método (la denegación y el throw de la transacción); ésta se había
 * quedado afuera.
 *
 * Y sólo cuando el miembro es NUEVO: si el despacho reusó a alguien del equipo,
 * ese alguien no se contrató para nada y echarlo sería despedir a un miembro
 * por un fallo de red.
 */
describe('Q9: `hub.send` falla después de una contratación fresca', () => {
  let b: TestBackend;
  let workId: string;
  let runId: string;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await b.service.startCoordinationRun(workId);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  function dispatch(taskId: string) {
    return b.service.coordinationEngine.startDispatch({ grant: { workId, runId, memberId: 'mem_c', role: 'coordinator' }, taskId });
  }

  it('el miembro recién contratado se despide, y no queda anotado como alta', async () => {
    const removed: string[] = [];
    vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
      removed.push(memberId);
      const idx = members.findIndex((m) => m.id === memberId);
      if (idx >= 0) members.splice(idx, 1);
    });
    send.mockRejectedValue(new Error('el proceso del miembro se murió'));
    const task = b.service.coordinationEngine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    await expect(dispatch(task.id)).rejects.toThrow(/se murió/);

    expect(removed).toHaveLength(1);
    expect(members).toHaveLength(0);
    // Ni un alta en la bitácora: nadie se sumó al equipo por este despacho.
    expect(b.service.coordinationEngine.listHires(runId)).toHaveLength(0);
    // Y lo que ya estaba bien sigue estando bien: la tarea vuelve a la cola sin
    // cargo, para que el próximo intento la encuentre.
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  it('con un miembro REUTILIZADO no se toca a nadie: no hubo ninguna contratación que deshacer', async () => {
    const removed: string[] = [];
    vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => { removed.push(memberId); });
    members.push({ id: 'mem_ya_estaba', workId, roleId: 'role_a', status: 'idle' });
    send.mockRejectedValue(new Error('el proceso del miembro se murió'));
    const task = b.service.coordinationEngine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    await expect(dispatch(task.id)).rejects.toThrow(/se murió/);

    expect(removed).toEqual([]);
    expect(members.map((m) => m.id)).toEqual(['mem_ya_estaba']);
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  it('si ni siquiera se puede despedir, el alta queda anotada: el miembro sigue ahí y eso se dice', async () => {
    vi.spyOn(b.hub, 'removeMember').mockImplementation(() => { throw new Error('no se pudo cerrar el proceso'); });
    send.mockRejectedValue(new Error('el proceso del miembro se murió'));
    const task = b.service.coordinationEngine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    await expect(dispatch(task.id)).rejects.toThrow(/se murió/);

    // El miembro sobrevivió al intento de echarlo, así que sigue contando como
    // alta: borrar el registro de alguien que sigue en el equipo sería mentir.
    expect(b.service.coordinationEngine.listHires(runId).map((h) => h.roleId)).toEqual(['role_a']);
  });
});
