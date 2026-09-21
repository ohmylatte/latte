import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { DEFAULT_MAX_CONCURRENT } from '../../electron/coordination/limits';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda final, jueces adversariales — lo que una aprobación concede y lo que
 * una salida tiene que poder hacer.
 *
 * D4. Rechazar y cancelar son SALIDAS: apagan, así que la bandera baja no las
 *     frena. Sólo aprobar enciende.
 * D11. La foto de roles aprobados guarda sólo lo CONTRATABLE; los miembros que
 *     ya están se resuelven en vivo al despachar.
 * D12. La propuesta editada se valida como propuesta, en la frontera IPC.
 * D13. Las altas de la aprobación quedan anotadas.
 * D16. Aprobar sin presupuesto previo no deja `maxConcurrent` en `null`.
 */
describe('lo que una aprobación concede, y las salidas que la bandera no frena', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;

  function proposerGrant(): CoordinationGrant {
    return { workId, runId: null, memberId: 'mem_proposer', role: 'worker' };
  }

  function proposal(overrides: Partial<CoordinationProposal> = {}): CoordinationProposal {
    return {
      plan: [
        { roleId: 'copywriter', spec: 'Escribir los textos' },
        { roleId: 'designer', spec: 'Diseñar las piezas' },
      ],
      estimatedDispatches: 8,
      membersToHire: [
        { roleId: 'copywriter', why: 'Nadie escribe todavía' },
        { roleId: 'designer', why: 'Nadie diseña todavía' },
      ],
      rationale: 'Coordinar al equipo y preparar el contenido del mes.',
      ...overrides,
    };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => b.repo.getMeta(FEATURE_KEYS.coordination) === FEATURE_ON,
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  function turnFlagOff(): void {
    b.repo.deleteMeta(FEATURE_KEYS.coordination);
  }

  // --- D4: las salidas no se gatean ------------------------------------------

  it('D4: con la bandera baja, RECHAZAR la propuesta sigue siendo posible y cancela el run', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    turnFlagOff();

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'reject');

    expect(b.repo.getCoordinationRun(run.id).status).toBe('cancelled');
    expect(members).toHaveLength(0); // rechazar no concede nada, nunca
  });

  it('D4: con la bandera baja, rechazar un gate de despacho devuelve la tarea a la cola', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.setCoordinationAuthority(workId, 'manual');
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');
    const task = b.repo.listCoordinationTasks(run.id)[0];
    const pending = await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_proposer', role: 'coordinator' }, taskId: task.id });
    expect(pending.status).toBe('pending_approval');
    turnFlagOff();

    await b.service.resolveCoordinationGate(pending.dispatchId, 'reject');

    expect(b.repo.getCoordinationDispatch(pending.dispatchId).status).toBe('rejected');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('ready');
  });

  it('D4: con la bandera baja, cancelar el run sigue siendo la salida de emergencia', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');
    turnFlagOff();

    await b.service.cancelCoordinationRun(run.id);

    expect(b.repo.getCoordinationRun(run.id).status).toBe('cancelled');
  });

  it('D4: `acceptHandoffAsTask` con la bandera baja DEGRADA al borrador, no tira', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');
    const tasksBefore = b.repo.listCoordinationTasks(run.id).length;
    turnFlagOff();

    const result = await b.service.acceptHandoffAsTask(workId, 'no-existe.md');

    expect(result).toEqual({ bridged: false, task: null, outcome: null, reason: null }); // R3: sin puente no hay despacho del cual hablar
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(tasksBefore);
    // A1: el aviso de la aprobación (un `hub.send` al coordinador con las
    // tareas que ya existen) no es trabajo despachado. Lo que este test
    // protege es que con la bandera abajo NO SALGA NINGÚN DESPACHO.
    expect((b.hub.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => !String(c[1]).startsWith('Your plan was '))).toHaveLength(0);
  });

  // --- D13: las altas quedan anotadas ----------------------------------------

  it('D13: aprobar con dos contrataciones deja dos altas en la bitácora', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');

    const hires = await b.service.listCoordinationHires(run.id);
    expect(hires).toHaveLength(2);
    expect(hires.map((h) => h.roleId).sort()).toEqual(['copywriter', 'designer']);
    expect(hires.map((h) => h.memberId).sort()).toEqual(members.map((m) => m.id).sort());
  });

  // --- D16: el tope de concurrencia no nace en null ---------------------------

  it('D16: aprobar sin presupuesto previo deja un `maxConcurrent` de verdad, no `null`', async () => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());
    expect(await b.service.getCoordinationBudget(workId)).toEqual({ state: 'unset' });

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');

    const stored = await b.service.getCoordinationBudget(workId);
    expect(stored).toMatchObject({ state: 'set', budget: { maxConcurrent: DEFAULT_MAX_CONCURRENT } });
    expect(engine.budgetBlockForEnvelope(run.id).maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
  });

  // --- D11: los roles aprobados son sólo los contratables ---------------------

  it('D11: la foto guarda SÓLO los roles de `membersToHire`, no los que ya son miembros', async () => {
    b.repo.insertMember({
      id: 'mem_strategist', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');

    const approved = JSON.parse(b.repo.getMeta(`coordination_approved_roles:${run.id}`) ?? '[]') as string[];
    expect(approved.sort()).toEqual(['copywriter', 'designer']);
  });

  it('D11: el miembro que se borró y cuyo rol nadie contrató deja la tarea `failed` `role_not_approved`', async () => {
    members.push({ id: 'mem_strategist', workId, roleId: 'strategist', status: 'idle' });
    const run = await engine.requestCoordination(proposerGrant(), proposal({
      plan: [{ roleId: 'strategist', spec: 'Ordenar el mes' }],
      membersToHire: [],
    }));
    await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');
    await b.service.setCoordinationAuthority(workId, 'auto');
    const task = b.repo.listCoordinationTasks(run.id)[0];
    // El miembro se fue del equipo DESPUÉS de la aprobación: la foto no lo tenía
    // congelado, así que el lookup en vivo no encuentra a nadie de ese rol.
    members.length = 0;

    await expect(engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_proposer', role: 'coordinator' }, taskId: task.id }))
      .rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });

    expect(b.repo.getCoordinationTask(task.id).status).toBe('failed');
  });

  // --- D12: la propuesta editada se valida como propuesta ---------------------

  it.each([
    ['no es JSON', 'esto no es json'],
    ['plan nulo', '{"plan":null,"estimatedDispatches":3}'],
    ['plan vacío', '{"plan":[],"estimatedDispatches":3}'],
    ['sin estimatedDispatches', '{"plan":[{"roleId":"copywriter","spec":"x"}]}'],
    ['hire sin roleId', '{"plan":[{"roleId":"copywriter","spec":"x"}],"estimatedDispatches":3,"membersToHire":[{"why":"porque"}]}'],
    ['tarea sin spec', '{"plan":[{"roleId":"copywriter"}],"estimatedDispatches":3}'],
  ])('D12: aprobar con una propuesta editada inválida (%s) se rechaza por IPC y no spawnea nada', async (_label, edited) => {
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    await expect(b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve', edited))
      .rejects.toMatchObject({ code: 'VALIDATION' });

    expect(members).toHaveLength(0);
    expect(b.hub.send).not.toHaveBeenCalled();
    expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
  });

  it('D12: un presupuesto ilegible en OTRO run no rompe el agregado del gate', async () => {
    const other = await b.service.createWork(brandId, 'Otro');
    await b.service.setCoordinationBudget(other.id, { maxDispatches: 5 });
    const otherRun = await engine.startRun(other.id, null);
    b.repo.updateActiveCoordinationRunBudget(other.id, 'no-es-json', new Date().toISOString());
    void otherRun;
    const run = await engine.requestCoordination(proposerGrant(), proposal());

    const gates = await b.service.listCoordinationGates(run.id);

    const gate = gates.find((g) => g.kind === 'proposal');
    expect(gate).toBeDefined();
    // La fila rota no se suma ni se inventa: el agregado sigue existiendo.
    expect(gate!.aggregate).toBeDefined();
  });

  it('D12: un presupuesto ilegible no pone `pendingGates` en 0 en la tira', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
    const run = await engine.startRun(workId, null);
    b.repo.updateCoordinationRunStatus(run.id, 'suspended', new Date().toISOString(), 'max_dispatches');
    b.repo.updateActiveCoordinationRunBudget(workId, 'no-es-json', new Date().toISOString());

    const strip = await b.service.listActiveCoordinationRuns();

    const row = strip.find((r) => r.runId === run.id);
    expect(row).toBeDefined();
    expect(row!.budgetInvalid).toBe(true);
    expect(row!.pendingGates).toBe(1); // el gate de presupuesto sigue ahí, y hay que verlo
  });
});
