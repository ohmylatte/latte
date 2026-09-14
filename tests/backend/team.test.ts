import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { RoleCatalog } from '../../electron/agents/roles';
import { openDriver } from '../../electron/storage/openDriver';
import { LatteRepository } from '../../electron/storage/repository';
import { loadInstructionPack, parseRole } from '../../electron/workspace/packs';
import { fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

const PACKS_DIR = path.resolve(__dirname, '..', '..', 'packs');
const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');
const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Roles: pack loading and catalog', () => {
  it('ships the five marketing roles with the neutral assistant first', () => {
    const pack = loadInstructionPack(PACKS_DIR, 'marketing-core');
    expect(pack?.roles.map((r) => r.id)).toEqual(['strategist', 'researcher', 'analyst', 'paid-media', 'sales-copywriter', 'reviewer']);
    const catalog = new RoleCatalog(pack);
    expect(catalog.list().map((r) => r.id)).toEqual(['assistant', 'strategist', 'researcher', 'analyst', 'paid-media', 'sales-copywriter', 'reviewer']);
    expect(catalog.list()[0]).toMatchObject({ builtin: true, name: 'Asistente' });
    expect(catalog.list()[1]).toMatchObject({ builtin: false, name: 'Strategist', initial: 'S' });
    // Every conversation carries the marketing behaviour, the neutral assistant included.
    expect(catalog.promptFor('assistant')).toContain('You are working on marketing, not on software.');
    expect(catalog.promptFor('assistant')).not.toContain('acting as:');
    expect(catalog.promptFor('strategist')).toContain('acting as: Strategist');
    // A role adds to the base, it does not replace it.
    expect(catalog.promptFor('strategist')).toContain('You are working on marketing, not on software.');
    expect(catalog.promptFor('strategist')).toContain('# Role: Strategist');
    expect(catalog.get('nope')).toBeNull();
  });

  it('parses role files defensively', () => {
    // A role that declares no `tier:` opens at the default effort.
    expect(parseRole('x', '---\nname: Copy\ninitial: c\nsummary: Escribe\n---\nDo copy.')).toEqual({ id: 'x', name: 'Copy', initial: 'C', summary: 'Escribe', tier: 'balanced', instructions: 'Do copy.' });
    expect(parseRole('x', 'no front matter')).toBeNull();
    expect(parseRole('x', '---\nsummary: s\n---\nbody')).toBeNull();
    expect(parseRole('x', '---\nname: Empty\n---\n   ')).toBeNull();
    const catalog = new RoleCatalog(null);
    expect(catalog.list().map((r) => r.id)).toEqual(['assistant']);
    expect(RoleCatalog.isValidId('strategist')).toBe(true);
    expect(RoleCatalog.isValidId('../x')).toBe(false);
  });
});

describe('Team members persistence', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('migrates v2 chat_sessions into assistant members and stays idempotent', async () => {
    const file = path.join(dir, 'latte.db');
    const { driver } = await openDriver(file, 'sql.js');
    driver.exec("CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE works (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)");
    driver.exec("CREATE TABLE chat_sessions (work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, runtime TEXT NOT NULL DEFAULT 'opencode', session_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (work_id, runtime))");
    driver.run('INSERT INTO brands VALUES (?, ?, ?, ?)', ['brd_1', 'Casa', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO works VALUES (?, ?, ?, ?, ?)', ['wrk_1', 'brd_1', 'Uno', '', '2026-01-01T00:00:00.000Z']);
    driver.run('INSERT INTO chat_sessions VALUES (?, ?, ?, ?)', ['wrk_1', 'claude', 'sess-old', '2026-01-02T00:00:00.000Z']);
    driver.run('INSERT INTO chat_sessions VALUES (?, ?, ?, ?)', ['wrk_1', 'opencode', 'ses_oc', '2026-01-03T00:00:00.000Z']);
    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.migrate();
    const members = repo.listMembers('wrk_1');
    expect(members.map((m) => [m.roleId, m.runtime, m.sessionId])).toEqual([['assistant', 'claude', 'sess-old'], ['assistant', 'opencode', 'ses_oc']]);
    expect(members[0].id).toMatch(/^mem_[a-f0-9]{20}$/);
    expect(driver.all("SELECT name FROM sqlite_master WHERE name = 'chat_sessions'")).toEqual([]);
    expect(repo.getMeta('schema_version')).toBe('8');
    repo.close();
  });

  it('stores, updates and deletes members per work', async () => {
    const { driver } = await openDriver(path.join(dir, 'latte.db'), 'sql.js');
    const repo = new LatteRepository(driver);
    repo.migrate();
    repo.insertBrand({ id: 'brd_1', name: 'Casa', context: '', createdAt: '2026-01-01T00:00:00.000Z' });
    repo.insertWork({ id: 'wrk_1', brandId: 'brd_1', title: 'Uno', brief: '', folder: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    const base = { workId: 'wrk_1', roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex' as const, model: null, accountId: SYSTEM_ACCOUNT_ID, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    repo.insertMember({ ...base, id: 'mem_a' });
    repo.insertMember({ ...base, id: 'mem_b', roleId: 'researcher', roleName: 'Researcher', initial: 'R', createdAt: '2026-01-02T00:00:00.000Z' });
    repo.setMemberSession('mem_a', 'thr_1', '2026-01-05T00:00:00.000Z');
    repo.setMemberDone('mem_b', true, '2026-01-06T00:00:00.000Z');
    expect(repo.listMembers('wrk_1').map((m) => [m.id, m.sessionId, m.done])).toEqual([['mem_a', 'thr_1', false], ['mem_b', '', true]]);
    expect(repo.getMember('mem_a')).toMatchObject({ runtime: 'codex', accountId: SYSTEM_ACCOUNT_ID, updatedAt: '2026-01-05T00:00:00.000Z' });
    repo.deleteMember('mem_a');
    expect(repo.findMember('mem_a')).toBeNull();
    expect(() => repo.getMember('mem_a')).toThrow(/Team member/);
    repo.close();
  });
});

describe('Role personality reaches every runtime', () => {
  let events: ChatEvent[];
  let dir: string;
  beforeEach(() => { events = []; dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('Claude Code: appended system prompt from a Latte-owned file, chat id reused', async () => {
    const spawned: string[][] = [];
    const adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.263' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      promptDir: path.join(dir, 'prompts'),
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => { spawned.push(args); return spawn(file, [FAKE_CLAUDE, ...args], options); }) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
    const { session } = await adapter.start({ workId: 'wrk_1', chatId: 'mem_strategist', roleId: 'strategist', roleName: 'Strategist', instructions: 'Be the strategist.\nSecond line.', directory: dir, title: 't', label: 'Claude Code · mi sesión', accountId: null });
    expect(session).toMatchObject({ id: 'mem_strategist', roleId: 'strategist', roleName: 'Strategist', provider: 'claude' });
    const flag = spawned[0].indexOf('--append-system-prompt-file');
    expect(flag).toBeGreaterThan(-1);
    const promptFile = spawned[0][flag + 1];
    expect(promptFile).toBe(path.join(dir, 'prompts', 'mem_strategist.md'));
    expect(fs.readFileSync(promptFile, 'utf8')).toBe('Be the strategist.\nSecond line.\n');
    await expect(adapter.start({ workId: 'wrk_1', chatId: 'mem_strategist', directory: dir, title: 't', label: 'x' })).rejects.toThrow(/already open/);
    adapter.shutdown();

    // Without a prompt dir the text goes inline; without instructions nothing is added.
    const inline = new ClaudeChatAdapter({ resolveExecutable: async () => ({ executable: process.execPath, version: null }), emit: () => {}, accountEnv: () => ({}), spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => { spawned.push(args); return spawn(file, [FAKE_CLAUDE, ...args], options); }) as typeof spawn, platform: 'linux', env: {} });
    await inline.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'x', instructions: 'Inline.' });
    expect(spawned[1]).toContain('--append-system-prompt');
    expect(spawned[1]).toContain('Inline.');
    await inline.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'x' });
    expect(spawned[2].some((a) => a.startsWith('--append-system-prompt'))).toBe(false);
    inline.shutdown();
  });

  it('Codex: developer instructions on thread start and resume', async () => {
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: (e) => events.push(e),
      accountEnv: (): Record<string, string> => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CODEX, ...args], options)) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    const first = await adapter.start({ workId: 'wrk_1', chatId: 'mem_analyst', roleId: 'analyst', roleName: 'Analyst', instructions: 'Be the analyst.', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID });
    expect(first.session).toMatchObject({ id: 'mem_analyst', roleId: 'analyst' });
    await adapter.send('mem_analyst', 'what instructions?');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(adapter.listMessages('mem_analyst')[1].parts[0]).toMatchObject({ text: 'Echo: what instructions? [dev: Be the analyst.]' });
    // The fake keeps threads in memory, so resume on the same server (a real Codex persists them on disk).
    const resumed = await adapter.start({ workId: 'wrk_1', chatId: 'mem_analyst_2', roleId: 'analyst', roleName: 'Analyst', instructions: 'Be the analyst.', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID, previousSessionId: first.runtimeSessionId });
    expect(resumed.session.resumed).toBe(true);
    events.length = 0;
    await adapter.send('mem_analyst_2', 'again');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(adapter.listMessages('mem_analyst_2').at(-1)?.parts[0]).toMatchObject({ text: 'Echo: again [dev: Be the analyst.]' });
    adapter.shutdown();
  });
});

describe('Team through the service', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
        if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) };
        return { code: 0, stdout: '1.0.0\n' };
      }),
      emitChat: () => {},
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('keeps every grant off until asked, per work, and reads what older versions wrote', async () => {
    const brand = await b.service.createBrand('Casa');
    const uno = await b.service.createWork(brand.id, 'Uno');
    const dos = await b.service.createWork(brand.id, 'Dos');

    expect(await b.service.getWorkPermissions(uno.id)).toBe('ask');
    expect(await b.service.setWorkPermissions(uno.id, 'folder')).toBe('folder');
    expect(await b.service.getWorkPermissions(uno.id)).toBe('folder');
    // A grant is about one folder. The next work starts closed, as it should.
    expect(await b.service.getWorkPermissions(dos.id)).toBe('ask');

    expect(await b.service.setWorkPermissions(uno.id, 'auto')).toBe('auto');
    expect(b.service.autoApprovesChat('mem_nope')).toBe(false);

    expect(await b.service.setWorkPermissions(uno.id, 'ask')).toBe('ask');
    expect(await b.service.getWorkPermissions(uno.id)).toBe('ask');
    await expect(b.service.getWorkPermissions('wrk_nope')).rejects.toThrow();
    await expect(b.service.setWorkPermissions(uno.id, 'todo' as never)).rejects.toThrow();

    // A database written before the mode existed said `1` for the folder grant.
    b.repo.setMeta('trust-folder:' + dos.id, '1');
    expect(await b.service.getWorkPermissions(dos.id)).toBe('folder');
  });

  it('changes the model of one conversation, resuming it, and leaves a paused one for later', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const member = await b.service.addTeamMember(work.id, 'strategist');
    expect((await b.service.listTeam(work.id))[0].model).toBeNull();

    // Live conversation: the runtime restarts and the same conversation comes back.
    const changed = await b.service.setTeamMemberModel(member.id, 'fake-provider/fake-model');
    expect(changed.member).toMatchObject({ id: member.id, model: 'fake-provider/fake-model' });
    expect(changed.session).not.toBeNull();
    expect(changed.resumed).toBe(true);
    expect((await b.service.listTeam(work.id))[0]).toMatchObject({ model: 'fake-provider/fake-model', status: 'idle' });

    // Same value twice is not a restart.
    const again = await b.service.setTeamMemberModel(member.id, 'fake-provider/fake-model');
    expect(again.member.model).toBe('fake-provider/fake-model');

    // A model the runtime refuses leaves neither a broken setting nor a closed
    // conversation: the previous model is put back and the chat reopened.
    await expect(b.service.setTeamMemberModel(member.id, 'modelo-inexistente')).rejects.toThrow(/not configured/i);
    expect((await b.service.listTeam(work.id))[0]).toMatchObject({ model: 'fake-provider/fake-model', status: 'idle' });

    // Paused: the change is recorded, nothing is woken up to apply it.
    await b.service.pauseTeamMember(member.id);
    const paused = await b.service.setTeamMemberModel(member.id, null);
    expect(paused.session).toBeNull();
    expect(paused.resumed).toBe(false);
    expect((await b.service.listTeam(work.id))[0]).toMatchObject({ model: null, status: 'paused' });
    // Reopening keeps the setting: null means "whatever the runtime uses by
    // default", which the session then reports as the effective model.
    await b.service.openTeamMember(member.id);
    expect((await b.service.listTeam(work.id))[0].model).toBeNull();

    await expect(b.service.setTeamMemberModel(member.id, 'con espacio')).rejects.toThrow();
    await expect(b.service.setTeamMemberModel('mem_nope', 'x')).rejects.toThrow();
  });

  it('lists roles, adds members with the primary agent, sends the role as system prompt and tracks status', async () => {
    const roles = await b.service.listRoles();
    expect(roles.map((r) => r.id)).toEqual(['assistant', 'strategist', 'researcher', 'analyst', 'paid-media', 'sales-copywriter', 'reviewer']);
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    expect(await b.service.listTeam(work.id)).toEqual([]);

    const strategist = await b.service.addTeamMember(work.id, 'strategist');
    expect(strategist).toMatchObject({ workId: work.id, provider: 'opencode', roleId: 'strategist', roleName: 'Strategist', resumed: false });
    expect(strategist.id).toMatch(/^mem_/);
    let team = await b.service.listTeam(work.id);
    expect(team).toMatchObject([{ id: strategist.id, roleName: 'Strategist', initial: 'S', runtime: 'opencode', status: 'idle', label: 'OpenCode · modelo por defecto' }]);

    await b.service.sendChat(strategist.id, 'Hola');
    const prompt = fake.requests.find((r) => r.path.endsWith('/prompt_async'));
    expect((prompt?.body as { system?: string }).system).toContain('acting as: Strategist');
    expect((prompt?.body as { system?: string }).system).toContain('# Role: Strategist');

    // The neutral assistant carries the marketing behaviour but no role.
    const assistant = await b.service.addTeamMember(work.id, 'assistant', null);
    await b.service.sendChat(assistant.id, 'Hola');
    const plain = fake.requests.filter((r) => r.path.endsWith('/prompt_async')).at(-1);
    const plainSystem = (plain?.body as { system?: string }).system ?? '';
    expect(plainSystem).toContain('Funnel stage');
    expect(plainSystem).not.toContain('Strategist');
    expect((plain?.body as { parts?: unknown }).parts).toEqual([{ type: 'text', text: 'Hola' }]);

    // Same member again: idempotent while open.
    const again = await b.service.openTeamMember(strategist.id);
    expect(again.id).toBe(strategist.id);

    await b.service.pauseTeamMember(strategist.id);
    team = await b.service.listTeam(work.id);
    expect(team.find((m) => m.id === strategist.id)?.status).toBe('paused');
    const reopened = await b.service.openTeamMember(strategist.id);
    expect(reopened).toMatchObject({ id: strategist.id, resumed: true, roleId: 'strategist' });

    await b.service.finishTeamMember(strategist.id);
    expect((await b.service.listTeam(work.id)).find((m) => m.id === strategist.id)?.status).toBe('ended');
    const reopenedAfterFinish = await b.service.openTeamMember(strategist.id);
    expect(reopenedAfterFinish.resumed).toBe(true);
    expect((await b.service.listTeam(work.id)).find((m) => m.id === strategist.id)?.status).toBe('idle');

    await b.service.removeTeamMember(strategist.id);
    expect((await b.service.listTeam(work.id)).map((m) => m.id)).toEqual([assistant.id]);
    await expect(b.service.openTeamMember(strategist.id)).rejects.toThrow(/Team member/);
  });

  it('validates input and honours runtime overrides; "Iniciar chat" resumes the assistant', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await expect(b.service.addTeamMember(work.id, '../x')).rejects.toThrow(/Invalid role id/);
    await expect(b.service.addTeamMember(work.id, 'ghost')).rejects.toThrow(/Role/);
    await expect(b.service.addTeamMember(work.id, 'analyst', { runtime: 'bash' as never })).rejects.toThrow(/Unknown runtime/);
    await expect(b.service.addTeamMember(work.id, 'analyst', { model: 'not a model' })).rejects.toThrow(/Invalid model id/);
    await expect(b.service.addTeamMember(work.id, 'analyst', { accountId: 'bad' })).rejects.toThrow(/Invalid account id/);
    await expect(b.service.addTeamMember(work.id, 'analyst', { model: 'nope/none' })).rejects.toThrow(/not configured/);
    // A failed open leaves no orphan member behind.
    expect(await b.service.listTeam(work.id)).toEqual([]);

    const first = await b.service.startChat(work.id);
    expect(first.roleId).toBe('assistant');
    await b.service.stopChat(first.id);
    const second = await b.service.startChat(work.id);
    expect(second).toMatchObject({ id: first.id, resumed: true });
    expect((await b.service.listTeam(work.id)).length).toBe(1);

    const pinned = await b.service.addTeamMember(work.id, 'reviewer', { model: 'fake-provider/fake-model' });
    expect(pinned).toMatchObject({ model: 'fake-provider/fake-model', label: 'OpenCode · fake-provider/fake-model' });
    expect((await b.service.listTeam(work.id)).map((m) => m.roleId)).toEqual(['assistant', 'reviewer']);
    await expect(b.service.listTeam('wrk_missing')).rejects.toThrow(/Work/);
  });
});

it('starts a member conversation over without touching the member or its role', async () => {
  const b = await makeBackend();
  try {
    const brand = await b.service.createBrand('Bruma');
    const work = await b.service.createWork(brand.id, 'Suscripcion');
    // Inserted directly: restarting must not need a runtime to be installed.
    const now = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({ id: 'mem_restart', workId: work.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: SYSTEM_ACCOUNT_ID, sessionId: 'thr_previous', done: true, createdAt: now, updatedAt: now });
    expect(b.repo.getMember('mem_restart')).toMatchObject({ sessionId: 'thr_previous', done: true });

    const after = await b.service.restartTeamMember('mem_restart');
    expect([after.id, after.roleId, after.runtime, after.accountId]).toEqual(['mem_restart', 'strategist', 'codex', SYSTEM_ACCOUNT_ID]);
    // No resume id left, so the next message opens a new conversation instead of continuing the old one.
    expect(b.repo.getMember('mem_restart')).toMatchObject({ sessionId: '', done: false });
    // One seat, not two: the whole point is not needing a second member with the same role.
    expect((await b.service.listTeam(work.id)).filter(m => m.roleId === 'strategist')).toHaveLength(1);
    // The conversation is what restarts; the work keeps its documents.
    expect((await b.service.listDocuments(work.id)).length).toBeGreaterThan(0);
  } finally { b.cleanup(); }
});
