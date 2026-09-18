import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { EMPTY_USAGE, type AgentEvent, type ChatSession, type TeamMember, type TeamMemberStatus } from '../../shared/contracts';
import { createBackend, type Backend, type BackendOptions } from '../../electron/bootstrap';
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
  id: m.id, workId: m.workId, roleId: m.roleId, roleName: m.roleId, initial: m.roleId[0]?.toUpperCase() ?? 'X',
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

export function fakeCoordinationHub(b: TestBackend, members: FakeTeamMember[]) {
  const send = vi.spyOn(b.hub, 'send').mockResolvedValue(undefined);
  vi.spyOn(b.hub, 'listTeam').mockImplementation((workId: string) => members.filter((m) => m.workId === workId).map(fakeTeamMemberShape));
  vi.spyOn(b.hub, 'openMember').mockImplementation(async (memberId: string) => {
    const member = members.find((m) => m.id === memberId);
    if (!member) throw new Error(`fakeCoordinationHub: unknown member ${memberId}`);
    member.status = 'idle';
    return fakeSessionFor(member);
  });
  vi.spyOn(b.hub, 'addMember').mockImplementation(async (input) => {
    // Realistic: opening a member starts it idle. A turn only makes it
    // 'working' once something is actually sent to it (`hub.send`, mocked
    // above) — a test simulating a busy member sets `status` itself.
    const member: FakeTeamMember = { id: `mem_fake_${members.length + 1}`, workId: input.workId, roleId: input.roleId, status: 'idle' };
    members.push(member);
    return fakeSessionFor(member);
  });
  return { send, members };
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
