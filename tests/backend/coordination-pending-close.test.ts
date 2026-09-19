import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult } from '../../electron/agents/types';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F1: el cierre pendiente no puede depender de que el coordinador siga vivo.
 *
 * `finishRunIfComplete` aparca el run en `pendingClose` cuando el coordinador
 * está a mitad de turno (D17), y el ÚNICO destrabador era `noteTurnEnded`,
 * llamado sólo desde un `status:'idle'`. Un coordinador que se muere —o al que
 * la persona pausa— nunca emite `idle`: emite `closed`, y esa rama de
 * `createBackend` hacía `return` antes de avisarle al motor. El run quedaba
 * `running` para siempre, ocupando uno de los cupos app-wide, con todo su
 * trabajo terminado.
 *
 * Los dos tests entran por donde entra la realidad: `b.emitChat` (el chokepoint
 * por el que pasa TODO evento de adaptador) y `pauseTeamMember` por IPC. Y el
 * reporte que deja el cierre pendiente entra por `settleCoordinationDispatch`,
 * o sea por el motor DEL SERVICIO — `pendingClose` vive en memoria de UNA
 * instancia, así que probarlo contra un motor de costado no probaría nada.
 */
describe('F1: un cierre pendiente se destraba aunque el coordinador no vuelva', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }

  function makeEngine(): CoordinationEngine {
    return new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON); // se entra por IPC: la bandera tiene que estar arriba
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el coordinador se muere a mitad de turno: el `closed` destraba el cierre', async () => {
    fakeCoordinationHub(b, members);
    // El permiso de coordinador, escrito donde el motor lo lee. No pasa por
    // `setCoordinatorGrant` porque el miembro del hub falso no tiene fila.
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'working' });
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    engine = makeEngine();
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    await engine.startDispatch({ grant: coordinator(), taskId: task.id });

    // El coordinador está pensando cuando entra el último reporte.
    const busy = vi.spyOn(b.hub, 'isMemberBusy').mockReturnValue(true);
    await b.service.settleCoordinationDispatch(task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // el cierre queda pendiente

    // Y se muere: nunca va a emitir un `idle`.
    busy.mockReturnValue(false);
    b.emitChat({ chatId: 'mem_coordinator', type: 'closed', reason: 'Codex app-server exited (code 1)' });

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });

  it('la persona pausa al coordinador por IPC: el run igual termina', async () => {
    // Un adaptador de verdad, con filas de miembro de verdad: `pauseTeamMember`
    // pasa por `hub.pauseMember`, que exige la fila, y `stop` sólo emite el
    // `closed` si un adaptador es dueño del chat.
    const open = new Set<string>();
    vi.spyOn(b.claude, 'owns').mockImplementation((chatId: string) => open.has(chatId));
    vi.spyOn(b.claude, 'isBusy').mockReturnValue(true);
    vi.spyOn(b.claude, 'stop').mockImplementation((chatId: string) => {
      open.delete(chatId);
      b.emitChat({ chatId, type: 'closed', reason: 'stopped' });
    });
    vi.spyOn(b.claude, 'start').mockImplementation(async (input: AdapterStartInput): Promise<AdapterStartResult> => {
      open.add(input.chatId ?? '');
      return { session: sessionFrom(input, 'claude', null, null, input.label, false), runtimeSessionId: 'sess_fake' };
    });
    vi.spyOn(b.hub, 'send').mockResolvedValue(undefined);
    b.hub.setPrimary({ runtime: 'claude', model: null, accountId: null });

    const coord = await b.service.addTeamMember(workId, 'strategist');
    await b.service.setCoordinatorGrant(workId, coord.id);
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'analyst');
    engine = makeEngine();
    const task = engine.taskCreate(runId, { roleId: 'analyst', spec: 'a' });
    await engine.startDispatch({ grant: { workId, runId, memberId: coord.id, role: 'coordinator' }, taskId: task.id });

    await b.service.settleCoordinationDispatch(task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationRun(runId).status).toBe('running'); // el coordinador sigue ocupado

    await b.service.pauseTeamMember(coord.id);

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
  });
});
