import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { sessionFrom, type AdapterMcpServer, type AdapterStartInput, type AdapterStartResult } from '../../electron/agents/types';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, makeTempDir, removeDir, type FakeTeamMember, type TestBackend } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');
const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

/**
 * Ronda 4 del juicio adversarial. Un solo tema: TODO LO QUE LATTE DICE DE SÍ
 * MISMO TIENE QUE SER VERDAD. Cada test de acá abajo reproduce o un reclamo
 * que el sistema hace sin ninguna evidencia detrás, o un recurso cuya muerte
 * no nota nadie.
 */

const REPO_ROOT = join(__dirname, '..', '..');

// --- Juicio 6: el prompt del strategist ------------------------------------

describe('strategist.md no le pide al agente que mienta sobre una herramienta ausente (juicio #6)', () => {
  const prompt = () => readFileSync(join(REPO_ROOT, 'packs', 'marketing-core', 'roles', 'strategist.md'), 'utf8');

  it('no prohíbe de plano reportar que le falta la herramienta', () => {
    // `latte_request_coordination` vive detrás de `requireCoordinationEnabled()`
    // Y detrás de la inyección MCP: con la bandera apagada (el default) la
    // herramienta NO EXISTE. Una prohibición sin matices empuja al agente a
    // decir que propuso un plan cuando no pasó nada.
    expect(prompt()).not.toContain('Never answer that you lack permissions');
  });

  it('dice explícitamente qué reportar cuando la herramienta falla o no está', () => {
    expect(prompt()).toContain('latte_request_coordination');
    expect(prompt()).toContain('If that tool errors or is not available');
  });

  it('sigue prohibiendo mandar a la persona a configurar algo de antemano', () => {
    expect(prompt()).toContain('never ask the human to configure anything preemptively');
  });
});

// --- Juicio 2 y 1: los reclamos del planificador de inyección ---------------

function makePlanner(opts: { engram?: string | null } = {}) {
  return new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: () => null },
    tokens: new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z'),
    server: { ensureStarted: async () => undefined, stopIfIdle: () => undefined, boundPort: 7777 },
    resolveClaudeVersion: async () => '2.1.300',
    resolveEngramBinary: async () => (opts.engram === undefined ? '/usr/bin/engram' : opts.engram),
  });
}

describe('memoryToolsInjectedForWork sólo afirma lo que este Trabajo lleva de verdad (juicio #2)', () => {
  it('un Trabajo SIN ningún reclamo vivo es `false`, aunque otra Marca ya haya resuelto engram', async () => {
    const planner = makePlanner();
    // La Marca A abrió un miembro: `lastEngramBinaryFound` queda en true.
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(planner.memoryToolsInjectedForWork('wrk_a')).toBe(true);
    // El Trabajo de la Marca B no tiene NINGÚN miembro vivo: el archivo de
    // instrucciones no puede afirmar "ya tenés engram, scopeado a esta marca".
    expect(planner.memoryToolsInjectedForWork('wrk_b')).toBe(false);
  });

  it('soltar el último miembro de un Trabajo vuelve a `false`, no al flag global', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    planner.release('mem_a1');
    expect(planner.memoryToolsInjectedForWork('wrk_a')).toBe(false);
  });

  it('un miembro SIN memoria (el runtime no la levantó) hace `false` al Trabajo entero', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    await planner.assign({ memberId: 'mem_a2', workId: 'wrk_a', brandId: 'brd_a', runtime: 'opencode', accountId: null });
    planner.confirmInjection('mem_a2', ['latte_coordination']);
    expect(planner.memoryToolsInjectedForWork('wrk_a')).toBe(false);
  });

  it('un miembro de OpenCode ahora lleva memoria como los demás (un proceso por miembro)', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    await planner.assign({ memberId: 'mem_a2', workId: 'wrk_a', brandId: 'brd_a', runtime: 'opencode', accountId: null });
    expect(planner.memoryToolsInjectedForWork('wrk_a')).toBe(true);
  });
});

describe('confirmInjection acepta el reporte del runtime, no sólo el de Latte (juicio #1)', () => {
  it('`undefined` sigue dejando el reclamo intacto (un adaptador que no reporta)', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    planner.confirmInjection('mem_a1', undefined);
    const after = await planner.preview({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(after.coordinationInjected).toBe(true);
  });

  it('un servidor que el runtime reporta CAÍDO baja el reclamo aunque Latte lo haya escrito', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    // El runtime arrancó, parseó el archivo, y `latte_memory` no levantó.
    planner.confirmInjection('mem_a1', ['latte_coordination']);
    const after = await planner.preview({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(after.coordinationInjected).toBe(true);
    expect(after.memoryInjected).toBe(false);
    expect(after.reason).toBe('runtime_refused_injection');
    expect(planner.memoryToolsInjectedForWork('wrk_a')).toBe(false);
  });
});

// --- Juicio 1: el reporte viene del runtime, no del pedido de Latte --------

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const COORD_SERVER: AdapterMcpServer = { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:54823/mcp', token: 'tok_abc' };
const MEMORY_SERVER: AdapterMcpServer = { kind: 'stdio', name: 'latte_memory', command: '/opt/engram', args: ['mcp'], env: {} };

describe('los adaptadores reportan lo que el RUNTIME dijo, no lo que Latte pidió (juicio #1)', () => {
  it('Claude no afirma nada hasta que `system/init` habla, y después reporta sólo los conectados', async () => {
    const dir = makeTempDir();
    const reported: Array<{ chatId: string; names: string[] }> = [];
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: () => {},
      accountEnv: () => ({}),
      promptDir: path.join(dir, 'prompts'),
      onMcpServers: (chatId, names) => { reported.push({ chatId, names }); },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CLAUDE, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', directory: dir, title: 't', label: 'Claude',
      mcpServers: [COORD_SERVER, MEMORY_SERVER],
      // engram se movió de lugar: el proceso arranca y `latte_memory` no levanta.
      extraEnv: { FAKE_CLAUDE_MCP_STATUS: JSON.stringify({ latte_coordination: 'connected', latte_memory: 'failed' }) },
    });
    // Latte escribió el archivo, pero NADIE le dijo todavía qué levantó de
    // verdad: `undefined` es "no sé", no "los dos andan".
    expect(result.injectedMcpServers).toBeUndefined();

    await adapter.send('mem_coord', 'hola');
    await waitFor(() => reported.length > 0);
    expect(reported[0]).toEqual({ chatId: 'mem_coord', names: ['latte_coordination'] });
    adapter.shutdown();
    removeDir(dir);
  });

  /**
   * D7b: `pending` es "todavia esta levantando", no "no esta". Contarlo como
   * una negativa degradaba el reclamo por una foto sacada medio segundo antes
   * de tiempo — y el reclamo degradado no vuelve a subir solo, asi que el
   * miembro quedaba marcado "el runtime se nego" con el servidor andando.
   */
  it('un estado transitorio del runtime NO reporta nada: "no se" no es una negativa', async () => {
    const dir = makeTempDir();
    const reported: Array<{ chatId: string; names: string[] }> = [];
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: () => {},
      accountEnv: () => ({}),
      promptDir: path.join(dir, 'prompts'),
      onMcpServers: (chatId, names) => { reported.push({ chatId, names }); },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CLAUDE, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_pending', directory: dir, title: 't', label: 'Claude',
      mcpServers: [COORD_SERVER, MEMORY_SERVER],
      extraEnv: { FAKE_CLAUDE_MCP_STATUS: JSON.stringify({ latte_coordination: 'connected', latte_memory: 'pending' }) },
    });

    await adapter.send('mem_pending', 'hola');
    // El `system/init` TIENE que haber llegado: sin esto el test pasaria
    // igual con el evento nunca emitido, que es lo contrario de lo que afirma.
    await waitFor(() => adapter.mcpServersFromInit().some((s) => s.status === 'pending'));

    expect(reported).toEqual([]);
    adapter.shutdown();
    removeDir(dir);
  });

  /**
   * D7c: esto asertaba `[]` — o sea, "el runtime reportó cero servidores" —
   * para un caso en el que el runtime no dijo NADA: el que se negó fue Latte,
   * porque no tiene dónde escribir el config. `confirmInjection` tomaba ese
   * `[]` por una confirmación y encendía `runtimeConfirmed`, así que la UI
   * afirmaba que el proceso había hablado. La negativa es real y se reporta,
   * pero por su propio campo.
   */
  it('Claude reporta la negativa de LATTE por su campo, sin fingir que el runtime habló (sin promptDir)', async () => {
    const dir = makeTempDir();
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: () => {},
      accountEnv: () => ({}),
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CLAUDE, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_coord', directory: dir, title: 't', label: 'Claude', mcpServers: [COORD_SERVER],
    });
    expect(result.injectedMcpServers).toBeUndefined();
    expect(result.injectionRefusedByLatte).toBe(true);
    adapter.shutdown();
    removeDir(dir);
  });

  it('Codex reporta la intersección con `mcpServerStatus/list`, no la lista que le pasaron', async () => {
    const dir = makeTempDir();
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      // El runtime conoce SÓLO la coordinación: `latte_memory` no arrancó.
      env: { PATH: process.env.PATH ?? '', FAKE_CODEX_MCP_STATUS: JSON.stringify(['latte_coordination']) },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_x1', directory: dir, title: 't', label: 'Codex',
      accountId: SYSTEM_ACCOUNT_ID, mcpServers: [COORD_SERVER, MEMORY_SERVER],
    });
    expect(result.injectedMcpServers).toEqual(['latte_coordination']);
    adapter.shutdown();
    removeDir(dir);
  });

  it('Codex NO cuenta una entrada que el runtime lista pero no pudo conectar (crítico 7)', async () => {
    const dir = makeTempDir();
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      // El runtime CONOCE las dos, pero `latte_coordination` quedó sin login:
      // estar en el catálogo no es estar conectado. `notLoggedIn` es el único
      // estado que el código de producción (`applyCodexAuth`) ya trata como
      // "requiere iniciar sesión".
      env: {
        PATH: process.env.PATH ?? '',
        FAKE_CODEX_MCP_STATUS: JSON.stringify(['latte_coordination', 'latte_memory']),
        FAKE_CODEX_MCP_NOT_LOGGED_IN: JSON.stringify(['latte_coordination']),
      },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_x1', directory: dir, title: 't', label: 'Codex',
      accountId: SYSTEM_ACCOUNT_ID, mcpServers: [COORD_SERVER, MEMORY_SERVER],
    });
    expect(result.injectedMcpServers).toEqual(['latte_memory']);
    adapter.shutdown();
    removeDir(dir);
  });

  it('un Codex viejo sin `mcpServerStatus/list` no sabe, y `no sé` es `undefined`, nunca el pedido de Latte', async () => {
    const dir = makeTempDir();
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '', FAKE_CODEX_NO_MCP_STATUS: '1' },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_x1', directory: dir, title: 't', label: 'Codex',
      accountId: SYSTEM_ACCOUNT_ID, mcpServers: [COORD_SERVER, MEMORY_SERVER],
    });
    // Antes esto devolvía `['latte_coordination', 'latte_memory']` — la lista
    // que Latte PIDIÓ, presentada como la que el runtime CONECTÓ. Que no se
    // pueda preguntar no es evidencia de nada: `undefined` deja el reclamo de
    // Latte intacto Y sin confirmar, que es lo que de verdad pasó.
    expect(result.injectedMcpServers).toBeUndefined();
    adapter.shutdown();
    removeDir(dir);
  });
});

// --- Crítico 7 (c): un reclamo sin confirmar no se muestra como conectado ---

describe('un reclamo que ningún runtime confirmó se distingue de uno confirmado', () => {
  it('recién asignado, el reclamo NO está confirmado', async () => {
    const planner = makePlanner();
    const status = await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(status.status.coordinationInjected).toBe(true);
    expect(status.status.runtimeConfirmed).toBe(false);
  });

  it('`undefined` (un adaptador que no puede preguntar) NO confirma nada', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    planner.confirmInjection('mem_a1', undefined);
    const after = await planner.preview({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(after.coordinationInjected).toBe(true);
    expect(after.runtimeConfirmed).toBe(false);
  });

  it('una lista concreta confirma, aunque coincida punto por punto con el reclamo', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    planner.confirmInjection('mem_a1', ['latte_coordination', 'latte_memory']);
    const after = await planner.preview({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(after.runtimeConfirmed).toBe(true);
    expect(after.reason).toBeNull();
  });

  it('una negativa del runtime también es una confirmación: se sabe, y se sabe que salió mal', async () => {
    const planner = makePlanner();
    await planner.assign({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    planner.confirmInjection('mem_a1', []);
    const after = await planner.preview({ memberId: 'mem_a1', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(after.runtimeConfirmed).toBe(true);
    expect(after.coordinationInjected).toBe(false);
    expect(after.reason).toBe('runtime_refused_injection');
  });

  it('un miembro CERRADO (la previsión hipotética) nunca sale confirmado', async () => {
    const planner = makePlanner();
    const status = await planner.preview({ memberId: 'mem_nunca_abierto', workId: 'wrk_a', brandId: 'brd_a', runtime: 'claude', accountId: null });
    expect(status.runtimeConfirmed).toBe(false);
  });
});

// --- Juicio 3 y 5: el motor ------------------------------------------------

describe('CoordinationEngine — reclamos que una herramienta del agente podía borrar', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  const coordinator = (): CoordinationGrant => ({ workId, runId, memberId: 'mem_coordinator', role: 'coordinator' });
  const worker = (memberId: string): CoordinationGrant => ({ workId, runId, memberId, role: 'worker' });

  function proposal(patch: Partial<CoordinationProposal> = {}): CoordinationProposal {
    return {
      plan: [{ roleId: 'strategist', spec: 'Definir el foco' }],
      membersToHire: [{ roleId: 'strategist', why: 'no hay ninguno' }],
      estimatedDispatches: 6,
      rationale: 'porque sí',
      ...patch,
    } as CoordinationProposal;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => true,
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function approvedRun() {
    // El run del `beforeEach` es el de `startRun`: se cierra para que la
    // propuesta pueda nacer como el único run activo del Trabajo.
    await engine.cancelRun(runId);
    const run = await engine.requestCoordination({ workId, runId: null, memberId: 'mem_proposer', role: 'worker' }, proposal());
    await engine.resolveGate(`proposal:${run.id}`, 'approve');
    return b.repo.findActiveCoordinationRun(workId)!;
  }

  // --- Juicio 3: `latte_plan_submit` no puede ampliar lo aprobado ----------

  it('`planSubmit` no borra los roles que la persona aprobó (juicio #3)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const approved = await approvedRun();
    // Exactamente lo que hace `latte_plan_submit`, una herramienta que el
    // coordinador TIENE: pisa `plan_json` con una lista pelada de ids.
    engine.planSubmit(approved.id, [{ roleId: 'strategist', spec: 'otra cosa' }]);
    const before = members.length;
    const tasksBefore = b.repo.listCoordinationTasks(approved.id).length;
    // Desde U10 el rol sin aprobar ni llega a ser tarea: la foto de la
    // aprobación manda EN LA CREACIÓN, no recién en el despacho. La propiedad
    // que este test protege —que una herramienta del agente no pueda ampliar
    // lo que la persona aprobó— se cumple ahora un paso antes.
    expect(() => engine.taskCreate(approved.id, { roleId: 'designer', spec: 'un rol que nadie aprobó' }))
      .toThrowError(expect.objectContaining({ code: 'ROLE_NOT_APPROVED' }));
    expect(b.repo.listCoordinationTasks(approved.id)).toHaveLength(tasksBefore);
    expect(members.length).toBe(before);
  });

  it('un run nacido de `startRun` no contrata roles que no estén ya en el Trabajo (juicio #3)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const before = members.length;
    // Un run de `startRun` tiene la foto VACÍA: sin propuesta aprobada, lo
    // único que autoriza es el equipo que ya está. U10 lo dice en la creación.
    expect(() => engine.taskCreate(runId, { roleId: 'designer', spec: 'sin propuesta ninguna' }))
      .toThrowError(expect.objectContaining({ code: 'ROLE_NOT_APPROVED' }));
    expect(members.length).toBe(before);
  });

  it('un rol YA presente en el Trabajo se reutiliza aunque el run no venga de una propuesta', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    // En el repo Y en el equipo falso: `workHasMemberForRole` —el lookup vivo
    // que comparten la creación y el despacho— lee las filas de miembros.
    b.repo.insertMember({
      id: 'mem_existing', workId, roleId: 'designer', roleName: 'Designer', initial: 'D', runtime: 'codex',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    members.push({ id: 'mem_existing', workId, roleId: 'designer', status: 'idle' });
    const before = members.length;
    const task = engine.taskCreate(runId, { roleId: 'designer', spec: 'reusar al que ya está' });
    await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).resolves.toBeTruthy();
    expect(members.length).toBe(before);
  });

  // --- Juicio 5: el atajo de idempotencia autoriza por `attempt` -----------

  it('el reporte repetido de una tarea `done` autoriza por intento, no por posición en la lista (juicio #5)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    approveCoordinationRoles(b, runId, 'role_a'); // U10: el rol se aprueba antes de que la tarea exista
    members.push({ id: 'mem_w1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });

    // Intento 1: lo toma mem_w1 y fracasa.
    await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const first = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === task.id && d.status === 'dispatched')!;
    await engine.report(worker(first.memberId), task.id, 'failed', 'no salió');

    // Intento 2: lo toma OTRO miembro y sí termina.
    members.find((m) => m.id === first.memberId)!.status = 'working';
    members.push({ id: 'mem_w2', workId, roleId: 'role_a', status: 'idle' });
    await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const second = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === task.id && d.status === 'dispatched')!;
    expect(second.memberId).not.toBe(first.memberId);
    await engine.report(worker(second.memberId), task.id, 'succeeded', 'listo');
    expect(b.repo.getCoordinationTask(task.id).status).toBe('done');

    // El orden de las filas empata en `created_at` y los ids son
    // `randomBytes(10)`, NO monotónicos: el desempate por id puede dejar al
    // intento 1 último. La autorización no puede depender de eso.
    const real = b.repo.listCoordinationDispatches.bind(b.repo);
    vi.spyOn(b.repo, 'listCoordinationDispatches').mockImplementation((id: string) => [...real(id)].reverse());

    await expect(engine.report(worker(second.memberId), task.id, 'succeeded', 'listo de nuevo')).resolves.toBeTruthy();
    await expect(engine.report(worker(first.memberId), task.id, 'succeeded', 'me cuelo'))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// --- Juicio 7, 8 y 9: recursos cuya muerte no nota nadie --------------------

function fakeResult(input: AdapterStartInput, provider: 'claude' | 'codex'): AdapterStartResult {
  return { session: sessionFrom(input, provider, input.model ?? null, input.accountId ?? null, input.label, false), runtimeSessionId: 'sess_fake' };
}

async function withWiredHub() {
  const b = await makeBackend();
  const tokens = new CoordinationTokenRegistry();
  const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 55555 };
  const planner = new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: (workId: string) => b.repo.findActiveCoordinationRun(workId) },
    tokens,
    server,
    resolveClaudeVersion: async () => '2.1.263',
    resolveEngramBinary: async () => '/usr/bin/engram',
  });
  b.hub.attachCoordinationInjection(planner);
  b.repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  b.repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  return { b, tokens, server, planner };
}

/**
 * Un runtime de Claude falso PERO con estado: `owns()` tiene que decir la
 * verdad, porque `liveSession()` la consulta y todo el camino de
 * `setMemberModel`/`setMemberTier` depende de si la conversación está viva.
 * `delayMs` abre a propósito la ventana del `await` que el juicio #7 señala.
 */
function fakeClaudeRuntime(b: TestBackend, opts: { delayMs?: number } = {}) {
  const open = new Set<string>();
  const state = { starts: 0, fail: null as Error | null };
  vi.spyOn(b.claude, 'owns').mockImplementation((chatId: string) => open.has(chatId));
  vi.spyOn(b.claude, 'stop').mockImplementation((chatId: string) => { open.delete(chatId); });
  vi.spyOn(b.claude, 'start').mockImplementation(async (input: AdapterStartInput) => {
    state.starts += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (state.fail) throw state.fail;
    open.add(input.chatId ?? '');
    return fakeResult(input, 'claude');
  });
  return state;
}

const CONTEXT = { workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {} };

describe('AgentHub — un solo proceso por miembro (juicio #7)', () => {
  it('dos `openMember` concurrentes del MISMO miembro arrancan UN solo proceso', async () => {
    const { b } = await withWiredHub();
    // El guard de "ya está abierto" se chequea ANTES del `await` y el registro
    // ocurre DESPUÉS: dos llamadas concurrentes pasaban las dos y spawneaban
    // dos procesos bajo un mismo chatId (juicio #7).
    const state = fakeClaudeRuntime(b, { delayMs: 15 });
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    b.hub.pauseMember(session.id);
    state.starts = 0;
    const [a, c] = await Promise.all([
      b.hub.openMember(session.id, CONTEXT),
      b.hub.openMember(session.id, CONTEXT),
    ]);
    expect(state.starts).toBe(1);
    expect(a.id).toBe(c.id);
    b.cleanup();
  });

  it('un solo reclamo de coordinación por miembro, aunque se lo abra dos veces a la vez', async () => {
    const { b, tokens } = await withWiredHub();
    const state = fakeClaudeRuntime(b, { delayMs: 15 });
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    b.hub.pauseMember(session.id);
    state.starts = 0;
    await Promise.all([b.hub.openMember(session.id, CONTEXT), b.hub.openMember(session.id, CONTEXT)]);
    expect(tokens.size).toBe(1);
    b.hub.pauseMember(session.id);
    expect(tokens.size).toBe(0);
    b.cleanup();
  });
});

describe('ClaudeChatAdapter y CodexChatAdapter — el guard de "ya abierto" cubre el await (juicio #7)', () => {
  it('dos `start()` concurrentes con el mismo chatId no spawnean dos procesos', async () => {
    const { b } = await withWiredHub();
    // El adaptador real, con su `resolveExecutable` lento: el chequeo de
    // `this.chats.has(chatId)` vive antes de ese await y el `set` después.
    const spawned: string[] = [];
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => { await new Promise((r) => setTimeout(r, 20)); return { executable: process.execPath, version: '2.1.263' }; },
      emit: () => {},
      accountEnv: () => ({}),
      spawnImpl: ((file: string, args: string[]) => { spawned.push(file); throw new Error('no spawn en test'); }) as never,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    const input = { workId: 'wrk_1', chatId: 'mem_dup', directory: '/tmp', title: 't', label: 'Claude' };
    const results = await Promise.allSettled([adapter.start(input), adapter.start(input)]);
    // Ninguno llega a spawnear de verdad, pero uno solo puede haberlo INTENTADO.
    expect(spawned.length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.status === 'rejected' && /already open/i.test(String((r as PromiseRejectedResult).reason))).length).toBe(1);
    adapter.shutdown();
    b.cleanup();
  });

  it('dos chats concurrentes de la misma cuenta de Codex comparten UN solo app-server', async () => {
    // `serverFor` falla el `get` en el mapa y hace el `set` despues de un
    // `await`: dos aperturas concurrentes spawneaban dos procesos y el segundo
    // pisaba al primero en `this.servers`, con las notificaciones del hilo
    // huerfano resolviendo contra el chat activo (juicio #7).
    const dir = makeTempDir();
    const spawned: string[][] = [];
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => { await new Promise((r) => setTimeout(r, 15)); return { executable: process.execPath, version: '0.153.4' }; },
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        spawned.push(args);
        return spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    const base = { workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID };
    await Promise.all([
      adapter.start({ ...base, chatId: 'mem_x1' }),
      adapter.start({ ...base, chatId: 'mem_x2' }),
    ]);
    expect(spawned.length).toBe(1);
    adapter.shutdown();
    removeDir(dir);
  });
});

describe('las instrucciones se reescriben con el reclamo ya corregido (juicio #2)', () => {
  it('abrir un miembro y confirmar el reporte del runtime avisan al servicio', async () => {
    const b = await makeBackend();
    const tokens = new CoordinationTokenRegistry();
    const planner = new CoordinationInjectionPlanner({
      repo: { findActiveCoordinationRun: (workId: string) => b.repo.findActiveCoordinationRun(workId) },
      tokens,
      server: { ensureStarted: async () => {}, stopIfIdle: () => {}, boundPort: 55555 },
      resolveClaudeVersion: async () => '2.1.263',
      resolveEngramBinary: async () => '/usr/bin/engram',
    });
    const rerendered: string[] = [];
    b.hub.attachCoordinationInjection(planner, (workId) => rerendered.push(workId));
    b.repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    b.repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    fakeClaudeRuntime(b);
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    expect(rerendered).toEqual(['wrk_1']);
    // El `system/init` llega DESPUÉS: la corrección tardía también reescribe.
    b.hub.confirmRuntimeMcpServers(session.id, []);
    expect(rerendered).toEqual(['wrk_1', 'wrk_1']);
    expect(planner.memoryToolsInjectedForWork('wrk_1')).toBe(false);
    b.cleanup();
  });
});

describe('la muerte de un proceso llega hasta `injection.release` (juicio #8)', () => {
  it('un `closed` de un adaptador suelta el reclamo, el token y el cupo', async () => {
    const { b, tokens } = await withWiredHub();
    fakeClaudeRuntime(b);
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    expect(tokens.size).toBe(1);
    // El proceso se murió solo: nadie llamó a `pauseMember` ni a `stop`.
    b.emitChat({ chatId: session.id, type: 'closed', reason: 'Claude Code exited (code 1)' });
    expect(tokens.size).toBe(0);
    b.cleanup();
  });

  it('seis muertes seguidas no dejan la coordinación clausurada para siempre', async () => {
    const { b, tokens, planner } = await withWiredHub();
    fakeClaudeRuntime(b);
    for (let i = 0; i < 6; i += 1) {
      const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
      b.emitChat({ chatId: session.id, type: 'closed', reason: 'crash' });
    }
    expect(tokens.size).toBe(0);
    const fresh = await planner.preview({ memberId: 'mem_nuevo', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex', accountId: null });
    expect(fresh.coordinationInjected).toBe(true);
    b.cleanup();
  });
});

describe('AgentHub — cambiar modelo o esfuerzo no filtra reclamos (juicio #9)', () => {
  it('un `setMemberModel` que falla dos veces no deja ningún reclamo vivo', async () => {
    const { b, tokens } = await withWiredHub();
    const state = fakeClaudeRuntime(b);
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    expect(tokens.size).toBe(1);
    // El runtime rechaza el modelo nuevo Y tampoco puede volver al viejo.
    state.fail = new Error('el runtime no arranca');
    await expect(b.hub.setMemberModel(session.id, 'modelo-inexistente', CONTEXT)).rejects.toThrow(/no arranca/);
    expect(tokens.size).toBe(0);
    b.cleanup();
  });

  it('un `setMemberTier` que falla dos veces no deja ningún reclamo vivo', async () => {
    const { b, tokens } = await withWiredHub();
    const state = fakeClaudeRuntime(b);
    const session = await b.hub.addMember({ ...CONTEXT, roleId: 'strategist', runtime: 'claude' });
    expect(tokens.size).toBe(1);
    state.fail = new Error('esfuerzo no soportado');
    await expect(b.hub.setMemberTier(session.id, 'light', CONTEXT)).rejects.toThrow(/no soportado/);
    expect(tokens.size).toBe(0);
    b.cleanup();
  });
});

// --- Juicio 4: el aviso del handoff puenteado ------------------------------

describe('el aviso del handoff puenteado dice lo que de verdad paso (juicio #4)', () => {
  const app = () => readFileSync(join(REPO_ROOT, 'src', 'App.tsx'), 'utf8');
  const i18n = () => readFileSync(join(REPO_ROOT, 'src', 'i18n.tsx'), 'utf8');

  it('la rama `bridged` no reusa la copia de la OTRA rama, y tiene una frase por cada final del motor', () => {
    const source = app();
    const start = source.indexOf('const acceptHandoffAsTask');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('const acceptHandoff = ', start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // `ui.auto.343` es "{p0} abierto con el pedido cargado. Revisalo antes de
    // enviarlo": con `bridged` no se abrio NADA y la plata ya se gasto.
    expect(body).not.toContain('ui.auto.343');
    // Q1: ESTA aserción, sola, era la que fijaba la copia mentirosa. Decía que
    // la rama `bridged` usa `handoff.bridged.dispatched` y se daba por
    // satisfecha, así que pasaba igual cuando esa frase —"despachada al
    // equipo"— se usaba sobre una tarea que el motor había dejado en
    // `pending_approval`. El motor tiene TRES finales y la pantalla necesita
    // tres frases; se exigen las tres.
    expect(body).toContain("t('handoff.bridged.dispatched'");
    expect(body).toContain("t('handoff.bridged.pendingApproval'");
    expect(body).toContain("t('handoff.bridged.queued'");
    expect(body).toContain("result.outcome === 'pending_approval'");
  });

  it('las claves son semanticas y existen en los DOS idiomas', () => {
    const source = i18n();
    expect(source).toContain("'handoff.bridged.dispatched': 'Tarea creada para {role} y despachada al equipo.");
    expect(source).toContain("'handoff.bridged.dispatched': 'Task created for {role} and dispatched to the team.");
    // Q1: y la del gate pendiente, que es la que faltaba. Sin ella la pantalla
    // no tenía con qué decir la verdad del caso por defecto.
    expect(source).toContain("'handoff.bridged.pendingApproval': 'Tarea creada para {role}. Esperando tu aprobación en Decisiones.'");
    expect(source).toContain("'handoff.bridged.pendingApproval': 'Task created for {role}. Waiting for your approval in Decisions.'");
    // Semantica nueva = clave semantica: el balde mecanico `ui.auto.NNN` no
    // crecio para esto.
    expect(i18n()).not.toContain('ui.auto.');
  });
});
