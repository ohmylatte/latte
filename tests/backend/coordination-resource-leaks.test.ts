import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult } from '../../electron/agents/types';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { CoordinationInjectionPlanner, type CoordinationInjectionDeps } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { strayServerDir } from '../../electron/agents/codex/staleServers';
import {
  approveCoordinationRoles, deferred, fakeCoordinationHub, makeBackend, makeTempDir, removeDir, settle,
  type FakeTeamMember, type TestBackend,
} from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

/**
 * Ronda final, jueces adversariales — los recursos que se filtran sin que nadie
 * lo note.
 *
 * D5. Cerrar a propósito no es morirse: no cobra intento.
 * D6. Un doble cierre de la misma reserva no cobra dos veces.
 * D8. `stop()` durante un `open()` en vuelo tiene que compensar.
 * D9. `maxChats` cuenta también lo que se está levantando.
 * D10. Contratar también se reserva: dos despachos, UNA contratación.
 * D14. El `listModels` efímero de Codex registra y olvida su pid.
 * D15. El token acuñado antes del primer await se revoca si ese await falla.
 */

// --- D5 / D6 / D10: el motor -------------------------------------------------

describe('el motor y sus reservas', () => {
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
    members = [];
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function startRun(): Promise<void> {
    engine = makeEngine();
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  }

  it('D5: un `closed` con `reason:"stopped"` devuelve la tarea a la cola SIN cobrarle el intento', async () => {
    fakeCoordinationHub(b, members);
    await startRun();
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' }); // para que esto no cierre el run
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(1);

    // Pausar, terminar, reiniciar, quitar o cambiarle el modelo a un miembro:
    // todos terminan acá, con `reason:'stopped'`. Es una decisión de la persona.
    b.emitChat({ chatId: 'mem_a1', type: 'closed', reason: 'stopped' });

    expect(b.repo.getCoordinationDispatch(outcome.dispatchId).status).toBe('cancelled');
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
    expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
  });

  it('D5: `pauseTeamMember` por IPC tampoco le cobra el intento a la tarea en vuelo', async () => {
    // El hub real, con un adaptador de Claude falso: pausar tiene que llegar de
    // verdad a `adapter.stop` -> `closed stopped` -> liquidación.
    const open = new Set<string>();
    vi.spyOn(b.claude, 'owns').mockImplementation((chatId: string) => open.has(chatId));
    vi.spyOn(b.claude, 'stop').mockImplementation((chatId: string) => {
      open.delete(chatId);
      b.emitChat({ chatId, type: 'closed', reason: 'stopped' });
    });
    vi.spyOn(b.claude, 'start').mockImplementation(async (input: AdapterStartInput): Promise<AdapterStartResult> => {
      open.add(input.chatId ?? '');
      return { session: sessionFrom(input, 'claude', null, null, input.label, false), runtimeSessionId: 'sess_fake' };
    });
    vi.spyOn(b.hub, 'send').mockResolvedValue(undefined);
    b.hub.setPrimary({ runtime: 'claude', model: null, accountId: null }); // el miembro que contrate el motor tiene que ser de ESTE adaptador
    await startRun();
    approveCoordinationRoles(b, runId, 'strategist');
    const task = engine.taskCreate(runId, { roleId: 'strategist', spec: 'a' });
    engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });
    const memberId = b.repo.getCoordinationDispatch(outcome.dispatchId).memberId;
    expect(memberId).not.toBe('');

    await b.service.pauseTeamMember(memberId);

    expect(b.repo.getCoordinationTask(task.id)).toMatchObject({ status: 'ready', attempts: 0 });
    expect(b.repo.countOpenCoordinationCostReservations(runId)).toBe(0);
  });

  it('D6: liquidar la MISMA reserva dos veces escribe UN solo asiento', async () => {
    fakeCoordinationHub(b, members);
    await startRun();
    members.push({ id: 'mem_a1', workId, roleId: 'role_a', status: 'idle' });
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    engine.taskCreate(runId, { roleId: 'role_b', spec: 'b' });
    const outcome = await engine.startDispatch({ grant: coordinator(), taskId: task.id });

    engine.settleUncertain(outcome.dispatchId, { incrementAttempts: false });
    engine.settleUncertain(outcome.dispatchId, { incrementAttempts: false });

    const spends = b.repo.listCoordinationCostLedger(runId).filter((row) => row.kind === 'spend');
    expect(spends).toHaveLength(1);
    expect(engine.budgetBlockForEnvelope(runId).dispatchesUsed).toBe(1);
  });

  it('D10: dos despachos concurrentes de un rol SIN miembro contratan una sola vez', async () => {
    const hold = deferred();
    const { send } = fakeCoordinationHub(b, members, { hold: () => hold.promise });
    await startRun();
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const second = engine.taskCreate(runId, { roleId: 'role_a', spec: 'b' });
    const addMember = vi.spyOn(b.hub, 'addMember');

    const both = Promise.allSettled([
      engine.startDispatch({ grant: coordinator(), taskId: first.id }),
      engine.startDispatch({ grant: coordinator(), taskId: second.id }),
    ]);
    await settle();
    hold.resolve();
    const results = await both;

    // UNA contratación: el segundo despacho ve la reserva del primero.
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(members).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(send.mock.calls).toHaveLength(1);
    // Y la tarea que no salió queda `ready`, lista para reintentarse.
    const statuses = [b.repo.getCoordinationTask(first.id).status, b.repo.getCoordinationTask(second.id).status].sort();
    expect(statuses).toEqual(['dispatched', 'ready']);
  });
});

// --- D8 / D15: el hub y el planificador --------------------------------------

function fakeResult(input: AdapterStartInput): AdapterStartResult {
  return { session: sessionFrom(input, 'claude', null, null, input.label, false), runtimeSessionId: 'sess_fake' };
}

async function withWiredHub(opts: { claudeVersion?: () => Promise<string | null> } = {}) {
  const b = await makeBackend();
  const tokens = new CoordinationTokenRegistry();
  const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 55555 };
  const deps: CoordinationInjectionDeps = {
    repo: { findActiveCoordinationRun: (workId: string) => b.repo.findActiveCoordinationRun(workId) },
    tokens,
    server,
    resolveClaudeVersion: opts.claudeVersion ?? (async () => '2.1.263'),
    resolveEngramBinary: async () => '/usr/bin/engram',
  };
  const planner = new CoordinationInjectionPlanner(deps);
  b.hub.attachCoordinationInjection(planner);
  b.repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
  b.repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
  return { b, tokens, server, planner };
}

const CONTEXT = { workId: 'wrk_1', brandId: 'brd_1', directory: '/tmp', title: 't', extraEnv: {} };

describe('AgentHub — `stop()` mientras el `open()` sigue en vuelo (D8)', () => {
  it('pausar en el medio de la apertura deja cero cupos, cero tokens entregados y cero procesos vivos', async () => {
    const hold = deferred<string | null>();
    const { b, tokens, server, planner } = await withWiredHub({ claudeVersion: () => hold.promise });
    const open = new Set<string>();
    vi.spyOn(b.claude, 'owns').mockImplementation((chatId: string) => open.has(chatId));
    vi.spyOn(b.claude, 'stop').mockImplementation((chatId: string) => { open.delete(chatId); });
    vi.spyOn(b.claude, 'start').mockImplementation(async (input: AdapterStartInput) => {
      open.add(input.chatId ?? '');
      return fakeResult(input);
    });
    b.repo.insertMember({
      id: 'mem_slow', workId: 'wrk_1', roleId: 'strategist', roleName: 'S', initial: 'S', runtime: 'claude',
      model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const opening = b.hub.openMember('mem_slow', CONTEXT);
    await settle();
    // La persona pausa JUSTO acá: el reclamo todavía no existe, `adapter.owns`
    // todavía dice que no, y `hub.stop` se iba sin hacer nada.
    b.hub.stop('mem_slow');
    hold.resolve('2.1.263');
    await opening.catch(() => undefined);
    await settle();

    expect(open.size).toBe(0); // ningún proceso vivo de un miembro ya cerrado
    expect(tokens.deliveredSize).toBe(0); // el token no quedó entregado
    expect(planner.memoryToolsInjectedForWork('wrk_1')).toBe(false); // ningún cupo reclamado
    expect(server.stopIfIdle).toHaveBeenCalled(); // el servidor compartido puede apagarse
    b.cleanup();
  });
});

describe('CoordinationInjectionPlanner — el token acuñado antes del primer await (D15)', () => {
  it('si `resolveSlowInputs` rechaza, el token se revoca en vez de quedar vivo para siempre', async () => {
    const tokens = new CoordinationTokenRegistry();
    const planner = new CoordinationInjectionPlanner({
      repo: { findActiveCoordinationRun: () => null },
      tokens,
      server: { ensureStarted: async () => {}, stopIfIdle: () => {}, boundPort: 1 },
      resolveClaudeVersion: async () => { throw new Error('el detector se cayó'); },
      resolveEngramBinary: async () => '/usr/bin/engram',
    });

    await expect(planner.assign({ memberId: 'mem_1', workId: 'wrk_1', brandId: 'brd_1', runtime: 'claude', accountId: null }))
      .rejects.toThrow();

    expect(tokens.size).toBe(0);
  });
});

// --- D9: `maxChats` cuenta lo que se está levantando -------------------------

describe('los adaptadores cuentan lo que ya están levantando (D9)', () => {
  it('Codex: N aperturas concurrentes con `maxChats = N-1` dejan pasar exactamente N-1', async () => {
    const dir = makeTempDir();
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => { await new Promise((r) => setTimeout(r, 15)); return { executable: process.execPath, version: '0.153.4' }; },
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      requestTimeoutMs: 5_000,
      maxChats: 2,
    });
    const base = { workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID };

    const results = await Promise.allSettled([
      adapter.start({ ...base, chatId: 'mem_c1' }),
      adapter.start({ ...base, chatId: 'mem_c2' }),
      adapter.start({ ...base, chatId: 'mem_c3' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected' && /Too many open Codex chats/i.test(String((r as PromiseRejectedResult).reason)))).toHaveLength(1);
    adapter.shutdown();
    removeDir(dir);
  });

  it('Claude: N aperturas concurrentes con `maxChats = N-1` dejan pasar exactamente N-1', async () => {
    const dir = makeTempDir();
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => { await new Promise((r) => setTimeout(r, 15)); return { executable: process.execPath, version: '2.1.263' }; },
      emit: () => {},
      accountEnv: () => ({}),
      spawnImpl: (() => { throw new Error('no spawn en test'); }) as never,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      maxChats: 2,
    });
    const base = { workId: 'wrk_1', directory: dir, title: 't', label: 'Claude' };

    const results = await Promise.allSettled([
      adapter.start({ ...base, chatId: 'mem_l1' }),
      adapter.start({ ...base, chatId: 'mem_l2' }),
      adapter.start({ ...base, chatId: 'mem_l3' }),
    ]);

    // Ninguno arranca de verdad (el spawn tira), pero uno solo tiene que ser
    // rechazado POR EL TOPE, y eso sólo pasa si `starting` cuenta.
    const byCap = results.filter((r) => r.status === 'rejected' && /Too many open Claude chats/i.test(String((r as PromiseRejectedResult).reason)));
    expect(byCap).toHaveLength(1);
    adapter.shutdown();
    removeDir(dir);
  });
});

// --- D14: el `listModels` efímero de Codex -----------------------------------

describe('el `codex app-server` efímero de `listModels` (D14)', () => {
  /** Los pid-files que el barrido de arranque va a leer la próxima vez. */
  function pidFiles(dir: string): string[] {
    try { return fs.readdirSync(strayServerDir(dir)); } catch { return []; }
  }

  it('registra su pid como el camino administrado, y lo olvida al cerrar', async () => {
    const dir = makeTempDir();
    const seen: number[] = [];
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        const child = spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
        // Mientras el efímero vive, su pid tiene que estar anotado.
        setTimeout(() => { seen.push(pidFiles(dir).length); }, 5);
        return child;
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
    });

    await adapter.listModels(SYSTEM_ACCOUNT_ID);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((count) => count > 0)).toBe(true);
    // Y al cerrarlo, la anotación se va: un pid fantasma hace que el barrido de
    // arranque mate un proceso que no existe, o peor, uno que sí.
    expect(pidFiles(dir)).toHaveLength(0);
    adapter.shutdown();
    removeDir(dir);
  });
});

// --- D7: lo que el runtime dijo, y lo que Latte dijo por el --------------------

describe('la verdad de la inyeccion (D7)', () => {
  function makePlanner(opts: { engramBinary?: string | null } = {}) {
    const tokens = new CoordinationTokenRegistry();
    const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 55555 };
    const planner = new CoordinationInjectionPlanner({
      repo: { findActiveCoordinationRun: () => ({}) },
      tokens,
      server,
      resolveClaudeVersion: async () => '2.1.263',
      resolveEngramBinary: async () => (opts.engramBinary === undefined ? '/usr/bin/engram' : opts.engramBinary),
    });
    return { planner, tokens, server };
  }

  it('D7a: al degradar coordinacion en Codex se toma el slot de memoria, igual que `assign()`', async () => {
    const { planner } = makePlanner();
    const input = { memberId: 'mem_c', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex' as const, accountId: 'sys' };
    const assigned = await planner.assign(input);
    expect(assigned.status.coordinationInjected).toBe(true);
    expect(assigned.status.memoryInjected).toBe(true);

    // El runtime levanto la memoria pero NO la coordinacion.
    planner.confirmInjection('mem_c', ['latte_memory']);

    // El `app-server` sigue vivo con su memoria: tiene que seguir contando.
    // Si el slot no se tomo, un segundo miembro de la MISMA marca+cuenta ve el
    // slot libre y `totalSlots()` cuenta uno menos del que hay.
    expect(planner.memoryToolsInjectedForWork('wrk_1')).toBe(true);
    const second = await planner.assign({ ...input, memberId: 'mem_c2' });
    expect(second.status.memoryInjected).toBe(true);
    // El miembro degradado conserva su memoria y pierde solo la coordinacion.
    const support = await planner.preview(input);
    expect(support).toMatchObject({ coordinationInjected: false, memoryInjected: true, runtimeConfirmed: true });
  });

  it('D7c: la negativa de LATTE degrada el reclamo pero NO enciende `runtimeConfirmed`', async () => {
    const { planner, tokens } = makePlanner();
    const input = { memberId: 'mem_l', workId: 'wrk_1', brandId: 'brd_1', runtime: 'claude' as const, accountId: null };
    await planner.assign(input);

    planner.noteLatteRefusedInjection('mem_l');

    const status = await planner.preview(input);
    expect(status.coordinationInjected).toBe(false);
    // El runtime no dijo una palabra: afirmar que confirmo algo es la mentira.
    expect(status.runtimeConfirmed).toBe(false);
    expect(tokens.deliveredSize).toBe(0);
  });

  it('D7c: Claude sin `promptDir` reporta la negativa por su campo, no como un reporte del runtime', async () => {
    const dir = makeTempDir();
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: () => {},
      accountEnv: () => ({}),
      // sin promptDir: Latte no tiene donde escribir el config
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [path.resolve(__dirname, 'fakeClaude.cjs'), ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });

    const result = await adapter.start({
      workId: 'wrk_1', chatId: 'mem_np', directory: dir, title: 't', label: 'Claude',
      mcpServers: [{ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:1/mcp', token: 'tok' }],
    });

    expect(result.injectionRefusedByLatte).toBe(true);
    // `[]` decia "el runtime reporto cero servidores". No reporto nada.
    expect(result.injectedMcpServers).toBeUndefined();
    adapter.shutdown();
    removeDir(dir);
  });
});
