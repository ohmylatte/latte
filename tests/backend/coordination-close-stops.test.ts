import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { EMPTY_USAGE } from '../../shared/contracts';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * CERRAR EL RUN APAGA A LOS QUE EL RUN CONVOCÓ.
 *
 * `closeRun` avisaba, borraba el permiso y escribía el estado; no tocaba UN
 * SOLO PROCESO. Terminado el run, cada miembro que participó seguía vivo,
 * ocioso, comiendo memoria y una ranura de los techos de `limits.ts`, hasta que
 * la persona lo pausara a mano o cerrara la app.
 *
 * Las tres reglas, y por qué cada una:
 * - Se apaga con `pauseMember`, NUNCA con `finishMember`: pausar cierra la
 *   conversación y deja la fila viva y reanudable. `finishMember` además marca
 *   `done`, y un run que termina no "termina" a nadie — la bitácora, el uso y
 *   la sesión siguen ahí para leerse.
 * - Se apaga a los que el run convocó: las altas (`listHires`) y los que
 *   recibieron un despacho. Al que la persona abrió A MANO no lo convocó nadie,
 *   así que el cierre no lo toca.
 * - Un turno en curso no se interrumpe: ese miembro se apaga cuando su turno
 *   termina (`noteTurnEnded`), que es el mismo camino por el que ya se destraba
 *   el cierre pendiente del coordinador.
 */
describe('cerrar el run apaga a los convocados', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let hub: ReturnType<typeof fakeCoordinationHub>;
  let workId: string;
  let runId: string;
  let lines: string[];

  const coordinator = (): CoordinationGrant => ({ workId, runId, memberId: 'mem_coordinator', role: 'coordinator' });
  const worker = (memberId: string): CoordinationGrant => ({ workId, runId, memberId, role: 'worker' });

  const paused = (memberId: string) => members.find((m) => m.id === memberId)?.status === 'paused';

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    lines = [];
    members = [{ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' }];
    hub = fakeCoordinationHub(b, members);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
      log: (line) => lines.push(line),
    });
    const run = await engine.startRun(workId, 'mem_coordinator');
    runId = run.id;
    approveCoordinationRoles(b, runId, 'strategist', 'copywriter', 'designer');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  /** Despacha una tarea de ese rol y devuelve a quién le tocó. */
  async function dispatch(roleId: string): Promise<string> {
    const task = engine.taskCreate(runId, { roleId, spec: 'Hacer algo de ' + roleId });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    return b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
  }

  it('el alta del run se apaga al cancelar', async () => {
    const hired = await dispatch('copywriter');
    expect(await b.service.listCoordinationHires(runId)).toHaveLength(1);

    engine.cancelRun(runId);
    await settle();

    expect(hub.pauseMember).toHaveBeenCalledWith(hired);
    expect(paused(hired)).toBe(true);
  });

  it('el que recibió un despacho se apaga aunque no sea un alta de este run', async () => {
    // Ya estaba en el equipo antes del run: no es un alta, pero el run lo usó.
    members.push({ id: 'mem_veterano', workId, roleId: 'designer', status: 'idle' });
    const target = await dispatch('designer');
    expect(target).toBe('mem_veterano');
    expect(await b.service.listCoordinationHires(runId)).toEqual([]);

    engine.cancelRun(runId);
    await settle();

    expect(paused('mem_veterano')).toBe(true);
  });

  it('al ajeno al run —el que la persona abrió a mano— no lo toca', async () => {
    members.push({ id: 'mem_amano', workId, roleId: 'designer', status: 'idle' });
    await dispatch('copywriter');

    engine.cancelRun(runId);
    await settle();

    expect(hub.pauseMember).not.toHaveBeenCalledWith('mem_amano');
    expect(paused('mem_amano')).toBe(false);
  });

  it('el coordinador también se apaga, una vez que no queda nada en vuelo', async () => {
    engine.cancelRun(runId);
    await settle();
    expect(paused('mem_coordinator')).toBe(true);
  });

  it('respeta el turno en curso: ese se apaga recién cuando termina', async () => {
    const hired = await dispatch('copywriter');
    members.find((m) => m.id === hired)!.status = 'working';

    engine.cancelRun(runId);
    await settle();

    // En medio de un turno no se le corta el proceso abajo.
    expect(hub.pauseMember).not.toHaveBeenCalledWith(hired);

    members.find((m) => m.id === hired)!.status = 'idle';
    engine.noteTurnEnded(hired);
    await settle();

    expect(hub.pauseMember).toHaveBeenCalledWith(hired);
    expect(paused(hired)).toBe(true);
  });

  it('el run que termina SOLO también apaga: pausa, no da por terminado a nadie', async () => {
    const task = engine.taskCreate(runId, { roleId: 'copywriter', spec: 'la única tarea' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const hired = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;

    await engine.report(worker(hired), task.id, 'succeeded', 'listo');
    await settle();

    expect(b.repo.getCoordinationRun(runId).status).toBe('done');
    expect(paused(hired)).toBe(true);
    // La fila queda reanudable: `finishMember` marcaría `done` y ésta no es la
    // muerte del miembro, es el final del run.
    expect(members.find((m) => m.id === hired)!.status).not.toBe('ended');
  });

  it('el cierre no se lleva puesta la bitácora: el alta sigue anotada', async () => {
    const hired = await dispatch('copywriter');
    engine.cancelRun(runId);
    await settle();
    const hires = await b.service.listCoordinationHires(runId);
    expect(hires).toHaveLength(1);
    expect(hires[0].memberId).toBe(hired);
  });

  it('deja línea en la bitácora del proceso, con ids y sin contenido', async () => {
    const hired = await dispatch('copywriter');
    engine.cancelRun(runId);
    await settle();
    const stops = lines.filter((line) => line.includes('coordination member stopped'));
    expect(stops.some((line) => line.includes(hired) && line.includes(runId))).toBe(true);
    expect(stops.every((line) => !line.includes('Hacer algo'))).toBe(true);
  });

  it('un `pauseMember` que tira no puede voltear el cierre del run', async () => {
    const hired = await dispatch('copywriter');
    hub.pauseMember.mockImplementation(() => { throw new Error('el proceso ya no está'); });

    expect(() => engine.cancelRun(runId)).not.toThrow();
    await settle();
    expect(b.repo.getCoordinationRun(runId).status).toBe('cancelled');
    expect(hub.pauseMember).toHaveBeenCalledWith(hired);
  });

  /**
   * Y LA CONVERSACION DEL QUE SE APAGO SE SIGUE PUDIENDO LEER.
   *
   * `hub.listMessages` enruta por adaptador y tira `NotFoundError` cuando
   * ninguno posee el chat, o sea sobre cualquier miembro PAUSADO — que desde
   * este bloque es el estado normal de un coordinador cuyo equipo termino, y su
   * conversacion es lo primero que la persona vuelve a buscar. Se contesta con
   * lo que Latte guarda, y NUNCA levantando un proceso: apagar y volver a
   * prender para leer seria deshacer lo que el cierre acaba de hacer.
   */
  it('leer la conversacion de un miembro pausado no le levanta el proceso', async () => {
    const now = new Date().toISOString();
    b.repo.insertMember({
      id: 'mem_pausado', workId, roleId: 'copywriter', roleName: 'Redactor', initial: 'R',
      runtime: 'claude', model: null, accountId: null, sessionId: '', done: false, continuedFrom: null,
      tier: 'balanced', usage: EMPTY_USAGE,
      createdAt: now, updatedAt: now,
    });
    const said = { id: 'msg1', chatId: 'mem_pausado', role: 'user' as const, parts: [{ id: 'p1', type: 'text' as const, text: 'armame el calendario' }], createdAt: now, completed: true, error: null };
    const recent = vi.spyOn(b.hub, 'recentMessages').mockReturnValue({ messages: [said], exposed: true });
    const open = vi.spyOn(b.hub, 'openMember');

    expect(await b.service.listChatMessages('mem_pausado')).toEqual([said]);
    expect(recent).toHaveBeenCalledWith('mem_pausado');
    expect(open).not.toHaveBeenCalled();
  });

  /** Un id que no es de nadie sigue siendo un error: taparlo con vacio miente distinto. */
  it('un id que no pertenece a ningun miembro sigue fallando', async () => {
    await expect(b.service.listChatMessages('mem_no_existe')).rejects.toThrow();
  });
});
