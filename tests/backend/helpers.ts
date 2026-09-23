import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { EMPTY_USAGE, type AgentEvent, type ChatSession, type TeamMember, type TeamMemberStatus } from '../../shared/contracts';
import { createBackend, type Backend, type BackendOptions } from '../../electron/bootstrap';
import { avatarFromSeed, serializeAvatar } from '../../shared/avatar';
import type { CommandResult, CommandRunner } from '../../electron/runtime/commandRunner';
import type { PtyLoadResult, PtyProcessLike, PtySpawnOptions } from '../../electron/runtime/ptyLoader';

/** 1×1 PNG. Raster assets must match magic bytes after the review fix. */
export const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** Distinct 1×1 PNG so identity vs signature logos can share an asset id. */
export const MINIMAL_PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function makeTempDir(prefix = 'latte-test-'): string {
  // The real path, because the backend reports real paths back: macOS hands out /var/folders/...
  // and /var is a symlink to /private/var, and TEMP may point at a junction on Windows. Without
  // this, every expectation built from the temp dir compares an unresolved path to a resolved one.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  // Snapshots are read-only; clear the attribute before removing.
  const walk = (p: string): void => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      // Links are left alone: chmod follows them, so clearing the attribute here would change the
      // permissions of whatever the link points at - including a directory this walk still has to read.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else {
        try { fs.chmodSync(full, 0o666); } catch { /* ignore */ }
      }
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  // Child processes (fake CLIs) may still hold the directory for a moment on Windows.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// --- Fake command runner ----------------------------------------------------

export type FakeCommand = (file: string, args: string[]) => Partial<CommandResult> | Promise<Partial<CommandResult>>;

export function fakeRunner(handler: FakeCommand): CommandRunner & { calls: Array<{ file: string; args: string[]; timeoutMs: number }> } {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const runner = (async (file: string, args: string[], options: { timeoutMs: number }) => {
    calls.push({ file, args: [...args], timeoutMs: options.timeoutMs });
    const partial = await handler(file, args);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial } satisfies CommandResult;
  }) as CommandRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

export const notFoundRunner = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'not found' }));

/**
 * La ruta de un ejecutable "instalado" que un fake de `where.exe`/`which`
 * puede devolver, absoluta PARA LA PLATAFORMA QUE EL BACKEND CREE HABITAR.
 *
 * `RuntimeDetector.locate` y el `locateExecutable` de `bootstrap.ts` filtran
 * la salida con `path.win32.isAbsolute` o `path.posix.isAbsolute` según esa
 * plataforma. Un fake que devolvía `C:\fake\claude.exe` a secas resolvía en
 * Windows y NO resolvía en Linux: el binario quedaba "no instalado" y la fila
 * salía con `canPropose:false` / `memoryInjected:false` sin que el test
 * hubiera pedido eso. La plataforma es un parámetro explícito para que el
 * fake y el backend hablen del mismo sistema operativo, nunca el del runner.
 */
export function fakeExecutablePath(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `C:\\fake\\${name}.exe` : `/fake/bin/${name}`;
}

// --- Fake pty ---------------------------------------------------------------

export class FakePty implements PtyProcessLike {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  constructor(readonly file: string, readonly args: string[], readonly options: PtySpawnOptions) {}

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener); } };
  }

  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }

  emitData(data: string): void { for (const l of [...this.dataListeners]) l(data); }
  emitExit(exitCode: number, signal?: number): void { for (const l of [...this.exitListeners]) l({ exitCode, signal }); }
}

export function fakePtyLoader(): { load: () => PtyLoadResult; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const load = (): PtyLoadResult => ({
    ok: true,
    module: {
      spawn(file, args, options) {
        const pty = new FakePty(file, args, options);
        spawned.push(pty);
        return pty;
      },
    },
  });
  return { load, spawned };
}

export const brokenPtyLoader = (): PtyLoadResult => ({ ok: false, error: 'node-pty: The specified module could not be found (fake)' });

// --- Backend factory ----------------------------------------------------------

export interface TestBackend extends Backend {
  dir: string;
  events: AgentEvent[];
  cleanup: () => void;
}

// --- Fake coordination team --------------------------------------------------
// Coordination dispatches a member exactly the way `requestBrandContextDraft`
// does (`hub.listTeam` / `openMember` / `addMember` / `send`), so coordination
// tests control the team the same way `brand-context-proposals.test.ts`'s
// MEMBER_BUSY test does: mock the hub surface instead of spawning a real
// runtime (this worktree's default fakes report every runtime as absent).

export interface FakeTeamMember { id: string; workId: string; roleId: string; status: TeamMemberStatus }

const fakeTeamMemberShape = (m: FakeTeamMember): TeamMember => ({
  id: m.id, workId: m.workId, roleId: m.roleId, roleName: m.roleId, initial: m.roleId[0]?.toUpperCase() ?? 'X', avatar: serializeAvatar(avatarFromSeed(m.roleId)),
  runtime: 'codex', model: null, accountId: null, label: 'Codex', status: m.status, tier: 'balanced',
  usage: EMPTY_USAGE,
  continuedFrom: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const fakeSessionFor = (m: FakeTeamMember): ChatSession => ({
  id: m.id, workId: m.workId, provider: 'codex', model: null, accountId: null, label: 'Codex',
  resumed: false, roleId: m.roleId, roleName: m.roleId, historyRecovered: false,
});

/**
 * Replaces `hub.listTeam`/`openMember`/`addMember`/`send` with in-memory fakes
 * driven by `members` (mutated in place, so a test can flip `status` between
 * calls). `addMember` appends a fresh working member and returns it, mirroring
 * the real hub's "adding opens it" contract.
 */
/**
 * Los roles que la persona aprobo para ESTE run, escritos donde el motor los
 * lee (`coordination_approved_roles:<runId>`).
 *
 * Ronda 4, juicio #3: el alta automatica dejo de derivarse de `plan_json` --
 * un campo que `latte_plan_submit` reescribe -- y pasa por esta foto, que
 * solo escribe la aprobacion humana. Un run de `startRun` directo no tiene
 * ninguna, asi que no contrata a nadie nuevo. Los escenarios que no estan
 * probando la contratacion declaran aca lo que su persona hubiera aprobado.
 */
export function approveCoordinationRoles(b: TestBackend, runId: string, ...roleIds: string[]): void {
  b.repo.setMeta('coordination_approved_roles:' + runId, JSON.stringify(roleIds));
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Una espera que el test decide cuándo termina. Es la única forma de reproducir
 * la carrera que este motor tiene que sobrevivir: levantar un proceso de agente
 * tarda SEGUNDOS, y el mundo cambia adentro de esa ventana. Sin poder parar el
 * await en el medio, el test corre las dos mitades pegadas y no prueba nada.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Cede el control hasta que todo lo que ya estaba encolado corrió: deja a un `startDispatch` en vuelo parado en su await. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface FakeCoordinationHubOptions {
  /**
   * La espera del spawn, bajo control del test: `openMember`/`addMember` la
   * esperan antes de devolver la sesión, igual que el hub real espera a que el
   * proceso arranque. Sin esto el fake resuelve en el mismo tick y ninguna
   * carrera del camino de despacho es reproducible.
   */
  hold?: () => Promise<void> | void;
}

/**
 * Ronda 8 (M1): el fake modela la vida COMO EL HUB REAL.
 *
 * En el hub, `status` sale de si un adaptador posee al miembro:
 * `working`/`idle` ⇒ hay proceso, `paused` ⇒ la fila sigue en la tabla pero no
 * hay nadie adentro (un proceso muerto sin `closed`, o pausado por la persona),
 * `ended` ⇒ terminó. Por eso un test que quiere modelar una muerte de proceso
 * pone `status: 'paused'` y NO borra la fila: borrarla es un estado que el hub
 * real no produce nunca.
 */
export const fakeMemberIsLive = (m: FakeTeamMember): boolean => m.status === 'working' || m.status === 'idle';

export function fakeCoordinationHub(b: TestBackend, members: FakeTeamMember[], options: FakeCoordinationHubOptions = {}) {
  const send = vi.spyOn(b.hub, 'send').mockResolvedValue(undefined);
  vi.spyOn(b.hub, 'listTeam').mockImplementation((workId: string) => members.filter((m) => m.workId === workId).map(fakeTeamMemberShape));
  vi.spyOn(b.hub, 'liveMemberIds').mockImplementation((workId: string) =>
    new Set(members.filter((m) => m.workId === workId && fakeMemberIsLive(m)).map((m) => m.id)));
  // `isBusy` lo publica el adaptador, y sólo para un miembro que posee: un
  // `paused` o un `ended` nunca están en un turno.
  vi.spyOn(b.hub, 'isMemberBusy').mockImplementation((memberId: string) =>
    members.some((m) => m.id === memberId && m.status === 'working'));
  // El apagado del cierre pasa por acá. El hub real empieza por
  // `repo.getMember`, y los miembros de estos tests no tienen fila propia: sin
  // el doble, pausar a un id inventado tiraría `NotFound` y el fake dejaría de
  // modelar lo único que importa acá — que el proceso se apaga y la fila queda
  // (`paused`, nunca `ended`), reanudable.
  const pauseMember = vi.spyOn(b.hub, 'pauseMember').mockImplementation((memberId: string) => {
    const member = members.find((m) => m.id === memberId);
    if (member) member.status = 'paused';
  });
  vi.spyOn(b.hub, 'openMember').mockImplementation(async (memberId: string) => {
    const member = members.find((m) => m.id === memberId);
    if (!member) throw new Error(`fakeCoordinationHub: unknown member ${memberId}`);
    await options.hold?.();
    member.status = 'idle';
    return fakeSessionFor(member);
  });
  vi.spyOn(b.hub, 'addMember').mockImplementation(async (input) => {
    // El alta entra en la LISTA antes de la espera, igual que el hub real:
    // `insertMember` es sincrónico y el proceso se levanta después. Por eso
    // `reserveTargetMember` ya lo ve en `listTeam` (y por eso existe la
    // reserva por rol que impide que un segundo despacho se lo lleve).
    //
    // L11 (ronda 9): PERO TODAVÍA NO ESTÁ VIVO. El fake lo declaraba `idle`
    // desde el `push`, o sea ANTES del `hold`, y `fakeMemberIsLive` lee `idle`
    // como "hay un adaptador adentro". El hub real no dice eso a mitad de
    // spawn: no hay adaptador hasta que `start()` termina, y `describe()`
    // publica `paused` —la fila existe, el proceso no—. Con la versión vieja,
    // un miembro en pleno spawn contaba como trabajo vivo en `allBlockedOnAsks`
    // y como vivo en el caso 2 del barrido: dos decisiones tomadas sobre una
    // vida que el hub real no había publicado.
    //
    // Al resolverse el `hold` pasa a `idle`: abrir un miembro lo deja ocioso,
    // y sólo se pone `working` cuando algo le manda un turno (`hub.send`, que
    // está mockeado arriba) — un test que simula a alguien ocupado fija el
    // `status` él mismo.
    const member: FakeTeamMember = { id: `mem_fake_${members.length + 1}`, workId: input.workId, roleId: input.roleId, status: 'paused' };
    members.push(member);
    await options.hold?.();
    member.status = 'idle';
    return fakeSessionFor(member);
  });
  return { send, pauseMember, members };
}

export async function makeBackend(overrides: Partial<BackendOptions> = {}): Promise<TestBackend> {
  const dir = makeTempDir();
  const events: AgentEvent[] = [];
  const backend = await createBackend({
    dataDir: dir,
    // Fixed and distinct from any real release, so a test can assert on it exactly.
    version: '0.0.0-test',
    emit: (e) => events.push(e),
    chooseExportPath: async () => null,
    seedDemo: false,
    runner: notFoundRunner,
    loadPty: brokenPtyLoader,
    ...overrides,
  });
  return {
    ...backend,
    dir,
    events,
    cleanup: () => {
      try { backend.service.shutdown(); } catch { /* already closed */ }
      removeDir(dir);
    },
  };
}
