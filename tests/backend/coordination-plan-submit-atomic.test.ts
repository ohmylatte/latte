import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { MAX_TASKS_PER_RUN } from '../../electron/coordination/limits';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Q6: UN PLAN ENTRA ENTERO O NO ENTRA.
 *
 * `planSubmit` escribía sus tareas de a una, en un `for` suelto. Con 201 tareas
 * el tope (`MAX_TASKS_PER_RUN`) saltaba recién en la fila 201, con las 200
 * anteriores YA ESCRITAS y `ready`: el coordinador recibía un error que le
 * decía que su plan no había entrado, y el run quedaba con doscientas tareas
 * listas para despacharse que nadie había aprobado como conjunto. El error y el
 * estado decían cosas distintas.
 *
 * Dos arreglos:
 *  - el cuerpo entero adentro de `repo.transaction(...)`: si algo falla, no
 *    queda una sola fila;
 *  - y el tope PUBLICADO en el esquema (`maxItems`), para que el agente lo sepa
 *    antes de mandar y el rechazo llegue como un argumento inválido, no como un
 *    tope descubierto a mitad de camino.
 */
describe('Q6: `latte_plan_submit` es transaccional', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${coordinatorToken}`, '127.0.0.1');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 500 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
    members = [];
    fakeCoordinationHub(b, members);
    members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    approveCoordinationRoles(b, runId, 'role_a');
    coordinatorToken = b.coordinationTokens.mint(workId, 'mem_coordinator');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ roleId: 'role_a', spec: `tarea ${i}` }));

  it(`JSON-RPC: ${MAX_TASKS_PER_RUN + 1} tareas se rechazan y no escriben una sola fila`, async () => {
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0); // la premisa

    const result = envelope(await call('latte_plan_submit', { tasks: tasks(MAX_TASKS_PER_RUN + 1) }));

    expect(result.ok).toBe(false);
    // Cero tareas: el plan no entró a medias.
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0);
    // Y el plan guardado sigue siendo el que estaba.
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
  });

  it('un plan que entra sí escribe todas sus tareas', async () => {
    const result = envelope(await call('latte_plan_submit', { tasks: tasks(5) }));

    expect(result.ok).toBe(true);
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(5);
  });

  it('un rol sin aprobar tampoco deja media planificación escrita', async () => {
    const mixed = [...tasks(3), { roleId: 'role_nadie', spec: 'la que no se puede' }];

    const result = envelope(await call('latte_plan_submit', { tasks: mixed }));

    expect(result.ok).toBe(false);
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(0);
  });

  /**
   * O7: EL TEST QUE ENTRA A LA TRANSACCIÓN.
   *
   * Los dos casos de arriba se cortan ANTES: el de 201 tareas lo frena el
   * `maxItems` del esquema y el del rol sin aprobar, el bucle de
   * `assertRoleCreatable` — ninguno llega a abrir la transacción, que es
   * justamente lo que este archivo existe para proteger. Un `dependsOn` fuera
   * de rango a mitad de lista sí entra: falla adentro, con filas ya escritas
   * en esa transacción, y lo que se comprueba es que no quede ninguna.
   */
  it('un `dependsOn` fuera de rango a mitad de lista revierte lo ya escrito y deja el plan guardado intacto', async () => {
    // Un plan que SÍ entra, para tener algo que se pueda pisar.
    expect(envelope(await call('latte_plan_submit', { tasks: tasks(2) })).ok).toBe(true);
    const before = b.repo.listCoordinationTasks(runId).map((t) => t.id);
    const planBefore = b.repo.getCoordinationRun(runId).planJson;
    expect(before).toHaveLength(2);
    expect(planBefore).toBe(JSON.stringify(before));

    // Tres tareas: la primera y la segunda son legales, la tercera depende de
    // un índice que no existe en su propia lista.
    const result = envelope(await call('latte_plan_submit', {
      tasks: [
        { roleId: 'role_a', spec: 'la primera' },
        { roleId: 'role_a', spec: 'la segunda', dependsOn: [0] },
        { roleId: 'role_a', spec: 'la tercera', dependsOn: [9] },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('VALIDATION');
    // Cero filas nuevas: las dos que la transacción alcanzó a escribir se
    // revirtieron con ella.
    expect(b.repo.listCoordinationTasks(runId).map((t) => t.id)).toEqual(before);
    // Y `plan_json` sigue nombrando al plan anterior, no a uno a medio escribir.
    expect(b.repo.getCoordinationRun(runId).planJson).toBe(planBefore);
  });

  it('el tope se publica en el esquema, así el agente lo sabe antes de mandar', () => {
    const submit = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_plan_submit');
    expect(submit).toBeDefined();
    const tasksSchema = (submit!.inputSchema as { properties: { tasks: { maxItems?: number } } }).properties.tasks;
    expect(tasksSchema.maxItems).toBe(MAX_TASKS_PER_RUN);

    const request = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_request_coordination');
    expect(request).toBeDefined();
    const planSchema = (request!.inputSchema as { properties: { plan: { maxItems?: number } } }).properties.plan;
    expect(planSchema.maxItems).toBe(MAX_TASKS_PER_RUN);
  });

  it('y el validador lo hace cumplir: el rechazo nombra el campo', async () => {
    const result = envelope(await call('latte_plan_submit', { tasks: tasks(MAX_TASKS_PER_RUN + 1) }));

    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('INVALID_ARGUMENT');
    expect(result.error!.message).toContain('tasks');
    expect(result.error!.message).toContain(String(MAX_TASKS_PER_RUN));
  });
});
