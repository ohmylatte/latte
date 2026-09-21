import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { SUPPORTED_SCHEMA_KEYWORDS } from '../../electron/coordination/schemaGuard';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { LIMITS } from '../../electron/services/validation';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * R6: LO QUE ENTRA POR MCP SE VALIDA CONTRA LO QUE SE PUBLICA.
 *
 * `tools/list` publica un `inputSchema` por herramienta y `tools/call` no lo
 * hacía cumplir: los argumentos llegaban crudos hasta `tools.ts`. El caso
 * medido y más caro: `latte_report` con `outcome:"success"` —que el esquema
 * prohíbe— caía en el `else` de `report()` y contaba como FRACASO, con un
 * intento cobrado. Un error de tipeo del agente hacía fracasar trabajo hecho.
 *
 * Todo entra por el servidor MCP que construye `createBackend`, o sea por
 * JSON-RPC de verdad.
 */
describe('R6: los argumentos de las tools MCP se validan contra su inputSchema', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined(); // una violación de esquema NO es un error de protocolo
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  function call(name: string, args: unknown, token = coordinatorToken) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
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

  // --- el caso caro: un `outcome` fuera del enum ------------------------------

  it('`latte_report` con `outcome:"success"` se rechaza y NO cobra un intento', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'a' }));
    const taskId = (created.data as { taskId: string }).taskId;
    await call('latte_dispatch', { taskId });
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.memberId;
    const workerToken = b.coordinationTokens.mint(workId, memberId);
    const attemptsBefore = b.repo.getCoordinationTask(taskId).attempts;

    const result = envelope(await call('latte_report', { taskId, outcome: 'success', summary: 'listo' }, workerToken));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(result.error?.message).toContain('outcome');
    // Nada se escribió: ni intento, ni estado de tarea, ni liquidación.
    expect(b.repo.getCoordinationTask(taskId).attempts).toBe(attemptsBefore);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');
    expect(b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.status).toBe('dispatched');
  });

  // --- una violación por herramienta publicada -------------------------------

  /** Un argumento que el esquema de cada herramienta prohíbe. Las que no publican ninguna propiedad se prueban con un `arguments` que ni siquiera es un objeto. */
  const OFFENDERS: Record<string, unknown> = {
    latte_plan_submit: { tasks: 'no es un array' },
    latte_task_create: { roleId: 7, spec: 'a' },
    latte_dispatch: { taskId: { nested: true } },
    latte_team_list: 'ni siquiera es un objeto',
    latte_task_list: { unArgumento: 'que el esquema no publica' },
    latte_report: { taskId: 'ctk_x', outcome: 'success', summary: 'listo' },
    latte_check: 42,
    latte_message: { to: 'coordinator', text: 'x'.repeat(5_000) },
    latte_ask: { question: ['no', 'es', 'texto'] },
    latte_ask_status: { askId: 99 },
    latte_request_coordination: { plan: [{ roleId: 'role_a', spec: 'a' }], estimatedDispatches: 0, rationale: 'porque sí' },
  };

  it('la tabla de violaciones cubre TODA herramienta publicada', () => {
    expect(Object.keys(OFFENDERS).sort()).toEqual(MCP_TOOL_DEFINITIONS.map((d) => d.name).sort());
  });

  it.each(MCP_TOOL_DEFINITIONS.map((d) => d.name))('%s rechaza un argumento que su esquema prohíbe, sin escribir nada', async (name) => {
    const tasksBefore = b.repo.listCoordinationTasks(runId).length;
    const dispatchesBefore = b.repo.listCoordinationDispatches(runId).length;
    const asksBefore = b.repo.listOpenCoordinationAsks(runId).length;

    const result = envelope(await call(name, OFFENDERS[name]));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(b.repo.listCoordinationTasks(runId)).toHaveLength(tasksBefore);
    expect(b.repo.listCoordinationDispatches(runId)).toHaveLength(dispatchesBefore);
    expect(b.repo.listOpenCoordinationAsks(runId)).toHaveLength(asksBefore);
  });

  // --- el largo, publicado y hecho cumplir ------------------------------------

  /**
   * Q2: TODO TEXTO PUBLICADO TIENE TOPE, sin una lista a mano que pueda quedar
   * vieja.
   *
   * `maxLength` estaba a medias: lo publicaban `question`, `why` y `rationale`,
   * y no lo publicaban `summary`, `files`, los tres `spec` ni ningún `roleId`.
   * No era cosmético: `report()` y `createTaskRow` escriben sin pasar por
   * `requireText` —a diferencia de la puerta IPC—, así que el esquema era lo
   * único que podía acotar esos campos, y un `spec` sin tope es el prompt que
   * va derecho a `hub.send`. El recorrido es recursivo y cuenta lo que revisó:
   * una propiedad nueva sin tope no puede colarse, y un esquema que se vacíe no
   * puede dejar este test verde por no haber mirado nada.
   */
  it('toda propiedad de texto publicada declara su `maxLength`', () => {
    const offenders: string[] = [];
    let stringProps = 0;
    const walk = (schema: unknown, where: string): void => {
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return;
      const node = schema as Record<string, unknown>;
      const types = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type : [];
      if (types.includes('string')) {
        stringProps += 1;
        if (typeof node.maxLength !== 'number') offenders.push(where);
      }
      if (node.items !== undefined) walk(node.items, `${where}[]`);
      if (typeof node.properties === 'object' && node.properties !== null) {
        for (const [name, sub] of Object.entries(node.properties as Record<string, unknown>)) walk(sub, `${where}.${name}`);
      }
    };
    expect(MCP_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    for (const def of MCP_TOOL_DEFINITIONS) walk(def.inputSchema, def.name);

    expect(offenders).toEqual([]);
    // El recorrido tiene que haber ENCONTRADO los campos de texto: sin esta
    // cota, borrar `properties` de todos los esquemas dejaría `offenders` vacío
    // y el test verde sin haber revisado un solo campo.
    expect(stringProps).toBeGreaterThanOrEqual(17);
  });

  it('`rationale` y `membersToHire[].why` publican su tope y lo hacen cumplir', () => {
    const proposal = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_request_coordination')!;
    const properties = proposal.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.rationale.maxLength).toBe(LIMITS.decision);
    const hireItems = properties.membersToHire.items as { properties: Record<string, Record<string, unknown>> };
    expect(hireItems.properties.why.maxLength).toBe(LIMITS.decision);
  });

  it('Q2: los topes nuevos se HACEN CUMPLIR, no sólo se declaran', async () => {
    const created = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'a' }));
    const taskId = (created.data as { taskId: string }).taskId;
    await call('latte_dispatch', { taskId });
    const memberId = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === taskId)!.memberId;
    const workerToken = b.coordinationTokens.mint(workId, memberId);

    const tooLongSummary = envelope(await call('latte_report', { taskId, outcome: 'succeeded', summary: 'x'.repeat(LIMITS.decision + 1) }, workerToken));
    expect(tooLongSummary.ok).toBe(false);
    expect(tooLongSummary.error?.code).toBe('INVALID_ARGUMENT');
    expect(tooLongSummary.error?.message).toContain('summary');
    // Y nada se escribió: la tarea sigue en vuelo.
    expect(b.repo.getCoordinationTask(taskId).status).toBe('dispatched');

    const tooLongSpec = envelope(await call('latte_task_create', { roleId: 'role_a', spec: 'x'.repeat(LIMITS.chatMessage + 1) }));
    expect(tooLongSpec.ok).toBe(false);
    expect(tooLongSpec.error?.message).toContain('spec');

    const tooLongRole = envelope(await call('latte_task_create', { roleId: 'r'.repeat(LIMITS.name + 1), spec: 'a' }));
    expect(tooLongRole.ok).toBe(false);
    expect(tooLongRole.error?.message).toContain('roleId');
  });

  it('una `rationale` más larga que lo publicado se rechaza nombrando el campo', async () => {
    const result = envelope(await call('latte_request_coordination', {
      plan: [{ roleId: 'role_a', spec: 'a' }],
      estimatedDispatches: 2,
      rationale: 'x'.repeat(LIMITS.decision + 1),
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(result.error?.message).toContain('rationale');
  });

  // --- el guard estructural ---------------------------------------------------

  /**
   * El validador cubre los esquemas publicados POR CONSTRUCCIÓN: no hay una
   * lista de campos a mano que pueda quedar vieja. Lo que sí puede quedar
   * viejo es el validador, si alguien publica una palabra clave que no
   * implementa (un `pattern`, un `minItems`, un `oneOf`). Este recorrido va
   * esquema por esquema, a cualquier profundidad, y falla en cuanto aparezca
   * una — con el nombre de la palabra y el de la herramienta.
   */
  it('ningún esquema publicado usa una palabra clave que el validador no implemente', () => {
    const supported = new Set<string>(SUPPORTED_SCHEMA_KEYWORDS);
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${where}[${i}]`)); return; }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (!supported.has(key)) offenders.push(`${where}.${key}`);
        if (key === 'properties') {
          for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) walk(sub, `${where}.${prop}`);
        } else if (key === 'items') {
          walk(value, `${where}[]`);
        }
      }
    };
    expect(MCP_TOOL_DEFINITIONS.length).toBeGreaterThan(0); // el recorrido tiene que recorrer algo
    for (const def of MCP_TOOL_DEFINITIONS) walk(def.inputSchema, def.name);

    expect(offenders).toEqual([]);
  });

  /**
   * Y el otro lado: que cada `required` de cada esquema se haga cumplir de
   * verdad. Se omite campo por campo, contra el servidor real, y cada omisión
   * tiene que volver como `INVALID_ARGUMENT` nombrando ese campo. Es la prueba
   * de que el validador genérico cubre todo lo declarado, sin una lista aparte.
   */
  it('cada `required` de cada esquema publicado se hace cumplir, campo por campo', async () => {
    /** Un payload que CUMPLE el esquema de cada herramienta: la base de la que se quita un campo por vez. */
    const VALID: Record<string, Record<string, unknown>> = {
      latte_plan_submit: { tasks: [{ roleId: 'role_a', spec: 'a' }] },
      latte_task_create: { roleId: 'role_a', spec: 'a' },
      latte_dispatch: { taskId: 'ctk_inexistente' },
      latte_report: { taskId: 'ctk_inexistente', outcome: 'succeeded', summary: 'listo' },
      latte_message: { to: 'coordinator', text: 'Necesito el tono' },
      latte_ask: { question: '¿Seguimos?' },
      latte_ask_status: { askId: 'cak_inexistente' },
      latte_request_coordination: { plan: [{ roleId: 'role_a', spec: 'a' }], estimatedDispatches: 2, rationale: 'porque sí' },
    };
    let checked = 0;
    for (const def of MCP_TOOL_DEFINITIONS) {
      const required = (def.inputSchema.required ?? []) as string[];
      if (required.length === 0) continue;
      expect(VALID[def.name], `falta un payload válido para ${def.name}`).toBeDefined();
      for (const field of required) {
        const args = { ...VALID[def.name] };
        delete args[field];
        const result = envelope(await call(def.name, args));
        expect(result.ok, `${def.name} sin ${field}`).toBe(false);
        expect(result.error?.code, `${def.name} sin ${field}`).toBe('INVALID_ARGUMENT');
        expect(result.error?.message, `${def.name} sin ${field}`).toContain(field);
        checked += 1;
      }
    }
    // Sin esto, un `required` que desaparece de todos los esquemas dejaría el
    // loop en cero vueltas y el test verde sin haber afirmado nada.
    expect(checked).toBeGreaterThanOrEqual(MCP_TOOL_DEFINITIONS.filter((d) => ((d.inputSchema.required ?? []) as string[]).length > 0).length);
  });
});
