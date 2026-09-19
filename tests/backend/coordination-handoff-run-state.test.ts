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
    // Q1: el booleano `dispatched` se reemplazó por el estado real del motor.
    expect(result.outcome).toBe('not_dispatched');
    expect(result.reason).toBe('BUDGET_EXCEEDED');
    // La tarea SÍ se creó: el run está vivo y la persona la pidió. Queda a la
    // vista, en la cola, para cuando haya presupuesto.
    expect(result.task).toMatchObject({ roleId: 'strategist', spec: 'Draft the Q3 brief.' });
    expect(b.repo.listCoordinationTasks(run.id).map((t) => t.roleId)).toContain('strategist');
  });
});

/**
 * Q1: EL RESULTADO DEL PUENTE DICE CUÁL DE LAS TRES COSAS PASÓ.
 *
 * `acceptHandoffAsTask` calculaba `dispatched: result.dispatch != null`, y
 * `startDispatch` devuelve una fila `pending_approval` cuando la autoridad
 * gatea. O sea que en el modo por defecto —`manual`, y también `plan`, porque
 * la tarea del puente nace `inPlan:false`— la interfaz anunciaba "despachada
 * al equipo" sobre una tarea que estaba esperando que la persona la aprobara,
 * en Decisiones, donde nadie le dijo que mirara.
 *
 * Tres estados, no dos: salió / espera tu aprobación / quedó en cola con una
 * razón. Este bloque los recorre por los TRES modos de autoridad; el de arriba
 * fija `auto` en su `beforeEach` y por eso nunca vio el caso por defecto.
 */
describe('Q1: el puente informa el estado real del despacho', () => {
  let b: TestBackend;
  let workId: string;
  let dir: string;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    dir = path.join(b.dir, 'brands', brand.id, 'works', workId);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  function writeHandoff(roleId: string, request: string) {
    fs.writeFileSync(path.join(dir, 'para-' + roleId + '.md'), `---\npara: ${roleId}\n---\n${request}\n`);
  }

  async function bridge(authority: 'manual' | 'plan' | 'auto') {
    await b.service.setCoordinationAuthority(workId, authority);
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist');
    writeHandoff('strategist', 'Draft the Q3 brief.');
    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    return { run, result };
  }

  it('autoridad `manual` (la de por defecto): la tarea espera una aprobación y el resultado NO dice "despachada"', async () => {
    const { run, result } = await bridge('manual');

    expect(result.bridged).toBe(true);
    expect(result.outcome).toBe('pending_approval');
    expect(result.reason).toBeNull();
    // Y es verdad de la base, no una etiqueta: hay un gate de despacho esperando
    // y nadie recibió una sola instrucción.
    expect(b.repo.listCoordinationDispatches(run.id).map((d) => d.status)).toEqual(['pending_approval']);
    expect(send).not.toHaveBeenCalled();
  });

  it('autoridad `plan`: la tarea del puente nace fuera del plan, así que también espera aprobación', async () => {
    const { run, result } = await bridge('plan');

    expect(result.outcome).toBe('pending_approval');
    expect(b.repo.listCoordinationDispatches(run.id).map((d) => d.status)).toEqual(['pending_approval']);
    expect(send).not.toHaveBeenCalled();
  });

  it('autoridad `auto`: salió de verdad, y recién ahí se dice "despachada"', async () => {
    const { run, result } = await bridge('auto');

    expect(result.outcome).toBe('dispatched');
    expect(b.repo.listCoordinationDispatches(run.id).map((d) => d.status)).toEqual(['dispatched']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('con el presupuesto agotado el estado es `not_dispatched`, con su razón', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 1 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await b.service.startCoordinationRun(workId);
    approveCoordinationRoles(b, run.id, 'strategist', 'analyst');
    const first = b.service.coordinationEngine.taskCreate(run.id, { roleId: 'analyst', spec: 'a' });
    await b.service.coordinationEngine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_c', role: 'coordinator' }, taskId: first.id });
    writeHandoff('strategist', 'Draft the Q3 brief.');

    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');

    expect(result.outcome).toBe('not_dispatched');
    expect(result.reason).toBe('BUDGET_EXCEEDED');
  });

  it('sin run no hay puente y no hay estado que inventar', async () => {
    writeHandoff('strategist', 'Draft the Q3 brief.');
    const result = await b.service.acceptHandoffAsTask(workId, 'para-strategist.md');
    expect(result.bridged).toBe(false);
    expect(result.outcome).toBeNull();
  });
});
