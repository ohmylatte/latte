import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R3: EL PUENTE DE HANDOFF MIRA EL ESTADO DEL RUN ANTES DE ESCRIBIR, Y NO TIRA.
 *
 * `bridgeHandoffToTask` usaba `findActiveCoordinationRun`, que incluye
 * `planning` y `suspended`, y llamaba a `createTaskRow` ANTES de que
 * `startDispatch` rebotara con `COORDINATION_NOT_APPROVED` / `RUN_NOT_ACTIVE`.
 * Resultado: una tarea `ready` colada en un run que la persona todavía no
 * aprobó —con autoridad `auto` se despacharía sin gate en cuanto el run
 * arrancara— y una excepción subiendo hasta la interfaz por el mero hecho de
 * haber aceptado un pedido.
 *
 * Y el otro lado de la misma moneda: con el run vivo pero el presupuesto
 * agotado, el puente tiraba igual. Aceptar un pedido no puede explotarle en la
 * cara a la persona: el fallo del despacho se DEVUELVE en el resultado, con su
 * razón, y la tarea queda creada y visible.
 */
describe('R3: el puente de handoff respeta el estado del run', () => {
  let b: TestBackend;
  let workId: string;
  let dir: string;
  let members: FakeTeamMember[];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    dir = path.join(b.dir, 'brands', brand.id, 'works', workId);
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    await b.service.setCoordinationAuthority(workId, 'auto');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  function writeHandoff(fileName: string, roleId: string, request: string) {
    fs.writeFileSync(path.join(dir, fileName), `---\npara: ${roleId}\n---\n${request}\n`);
  }

  it('run `planning`: no puentea, no crea ninguna tarea y el pedido queda intacto', async () => {
    // Una propuesta sin aprobar: el run existe y está `planning`.
    const run = await b.service.coordinationEngine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proponente', role: 'worker' },
      { plan: [{ roleId: 'strategist', spec: 'algo' }], estimatedDispatches: 3, rationale: 'porque sí' },
    );
    expect(run.status).toBe('planning');
    approveCoordinationRoles(b, run.id, 'strategist'); // aun así aprobado el rol: lo que frena es el ESTADO
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');
    const before = await b.service.listHandoffs(workId);

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result.bridged).toBe(false);
    expect(result.task).toBeNull();
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
    expect(await b.service.listHandoffs(workId)).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'para-strategist.md'))).toBe(true);
  });

  it('run `suspended`: igual — nada se escribe mientras el equipo está detenido', async () => {
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist');
    await b.service.pauseCoordinationRun(run.id);
    expect(b.repo.getCoordinationRun(run.id).status).toBe('suspended');
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');
    const before = await b.service.listHandoffs(workId);

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result.bridged).toBe(false);
    expect(result.task).toBeNull();
    expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
    expect(await b.service.listHandoffs(workId)).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'para-strategist.md'))).toBe(true);
  });

  it('run `running` con el presupuesto agotado: no tira, y el resultado dice por qué no se despachó', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 1 });
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist', 'analyst');
    // Se consume el único despacho del presupuesto.
    const first = b.service.coordinationEngine.taskCreate(run.id, { roleId: 'analyst', spec: 'a' });
    await b.service.coordinationEngine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_c', role: 'coordinator' }, taskId: first.id });
    writeHandoff('para-strategist.md', 'strategist', 'Draft the Q3 brief.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result.bridged).toBe(true);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('BUDGET_EXCEEDED');
    // La tarea SÍ se creó: el run está vivo y la persona la pidió. Queda a la
    // vista, en la cola, para cuando haya presupuesto.
    expect(result.task).toMatchObject({ roleId: 'strategist', spec: 'Draft the Q3 brief.' });
    expect(b.repo.listCoordinationTasks(run.id).map((t) => t.roleId)).toContain('strategist');
  });
});
