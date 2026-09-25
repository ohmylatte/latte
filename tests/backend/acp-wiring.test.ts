import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { AccountStore } from '../../electron/agents/accounts';
import { resolveHermesExecutable } from '../../electron/agents/acp/executables';
import { acpTierModelDefaults, readAcpTierModels, tierModelReader, writeAcpTierModel } from '../../electron/agents/acp/tierModels';
import { HERMES_DEFAULT_TIER_MODELS } from '../../electron/agents/tiers';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { fakePtyLoader, fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { FAKE_ACP, waitFor } from './acpHelpers';

describe('accounts for Grok and Hermes', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir('latte-acp-accounts-'); });
  afterEach(() => removeDir(dir));

  it('has no "my session": only accounts managed by Latte, each with an empty ~ of its own', async () => {
    const store = new AccountStore({ root: path.join(dir, 'accounts'), runner: fakeRunner(() => ({ stdout: 'You are not authenticated.\n' })), resolveExecutable: async () => 'C:\\bin\\grok.exe' });
    expect(await store.describe('grok')).toEqual([]);
    const account = store.create('grok', 'Agencia');
    const home = path.join(dir, 'accounts', 'grok', account.id);
    expect(store.envFor('grok', account.id)).toEqual({ GROK_HOME: home, USERPROFILE: path.join(home, 'home'), HOME: path.join(home, 'home') });
    expect(store.envFor('hermes', 'system')).toEqual({});
    expect(store.managedHome('grok', account.id)).toBe(home);
    expect(store.managedHome('grok', 'system')).toBeNull();
    expect(store.managedHome('grok', 'acc_ffffffffffffffff')).toBeNull();
    expect(await store.describe('grok')).toEqual([expect.objectContaining({ id: account.id, system: false, loggedIn: false, detail: 'Sin sesión iniciada' })]);
  });

  it('reads Grok login state from `grok models`, and suggests the models its cache knows', async () => {
    const runner = fakeRunner((_file, args) => (args[0] === 'models' ? { stdout: 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n' } : { code: 1 }));
    const store = new AccountStore({ root: path.join(dir, 'accounts'), runner, resolveExecutable: async () => 'C:\\bin\\grok.exe' });
    const account = store.create('grok', 'Agencia');
    fs.writeFileSync(path.join(dir, 'accounts', 'grok', account.id, 'models_cache.json'), JSON.stringify({ models: { 'grok-4.7': { info: {} }, 'bad id;rm': {} } }));
    const [described] = await store.describe('grok');
    expect(described).toMatchObject({ loggedIn: true, detail: 'Sesión iniciada con grok.com · modelo grok-4.7', models: ['grok-4.7'] });
    expect(runner.calls[0].args).toEqual(['models']);
  });

  it('counts a Hermes account as ready only with a credential AND a chosen model', async () => {
    let listing = 'openai-codex (1 credentials):\n  #1  device_code          oauth   device_code ←\n\ndeepseek (0 credentials):\n';
    const store = new AccountStore({ root: path.join(dir, 'accounts'), runner: fakeRunner(() => ({ stdout: listing })), resolveExecutable: async () => 'C:\\hermes.exe' });
    const account = store.create('hermes', 'Codex');
    const home = path.join(dir, 'accounts', 'hermes', account.id);
    expect((await store.describe('hermes'))[0]).toMatchObject({ loggedIn: false, detail: expect.stringContaining('sin modelo elegido') });
    fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: gpt-5.6-sol\n  provider: openai-codex\napprovals:\n  mode: manual\n');
    const [ready] = await store.describe('hermes');
    expect(ready).toMatchObject({ loggedIn: true, detail: 'openai-codex · modelo openai-codex:gpt-5.6-sol' });
    expect(ready.models).toEqual(['openai-codex:gpt-5.6-sol', HERMES_DEFAULT_TIER_MODELS.light, HERMES_DEFAULT_TIER_MODELS.balanced]);
    listing = 'No credentials.\n';
    expect((await store.describe('hermes'))[0]).toMatchObject({ loggedIn: false, detail: 'Sin sesión iniciada' });
  });
});

describe('Hermes executable', () => {
  it('launches the venv hermes.exe, never the .cmd wrapper', () => {
    const exists = (file: string) => file === 'C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';
    expect(resolveHermesExecutable('C:\\Users\\me\\AppData\\Local\\hermes\\bin\\hermes.cmd', exists)).toBe('C:\\Users\\me\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe');
    expect(resolveHermesExecutable('C:\\x\\hermes.exe', () => false)).toBe('C:\\x\\hermes.exe');
    expect(resolveHermesExecutable('C:\\elsewhere\\bin\\hermes.cmd', () => false)).toBeNull();
  });
});

describe('model per effort level (Settings)', () => {
  it('stores one model per runtime and level, and null goes back to the default', () => {
    const meta = new Map<string, string>();
    const get = (key: string) => meta.get(key) ?? null;
    const set = (key: string, value: string) => { meta.set(key, value); };
    expect(readAcpTierModels(get).hermes.deep).toBeNull();
    writeAcpTierModel(get, set, 'hermes', 'deep', ' deepseek:deepseek-v4-pro ');
    expect(tierModelReader(get, 'hermes')('deep')).toBe('deepseek:deepseek-v4-pro');
    expect(tierModelReader(get, 'grok')('deep')).toBeNull();
    writeAcpTierModel(get, set, 'hermes', 'deep', null);
    expect(readAcpTierModels(get).hermes.deep).toBeNull();
    expect(() => writeAcpTierModel(get, set, 'claude', 'deep', 'x')).toThrow(/Unknown ACP runtime/);
    expect(() => writeAcpTierModel(get, set, 'hermes', 'huge', 'x')).toThrow(/Unknown effort tier/);
    expect(() => writeAcpTierModel(get, set, 'hermes', 'light', 'con espacio')).toThrow(/Invalid model id/);
    meta.set('acp_tier_models', '{not json');
    expect(readAcpTierModels(get).hermes.light).toBeNull();
    expect(acpTierModelDefaults().hermes).toEqual(HERMES_DEFAULT_TIER_MODELS);
  });
});

describe('coordination eligibility for ACP runtimes', () => {
  it('gives Grok and Hermes coordination and memory like Claude, outside the codex app-server ledger', async () => {
    const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 50123 };
    const planner = new CoordinationInjectionPlanner({
      repo: { findActiveCoordinationRun: () => null },
      tokens: new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z'),
      server,
      resolveClaudeVersion: async () => null,
      resolveEngramBinary: async () => '/usr/bin/engram',
    });
    // Primero Codex llena su techo en este trabajo: el que sigue ya no recibe coordinación.
    await planner.assign({ memberId: 'mem_c1', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex', accountId: 'system' });
    const refused = await planner.assign({ memberId: 'mem_c2', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex', accountId: 'system' });
    expect(refused.status.coordinationInjected).toBe(false);
    // Grok y Hermes no viven en ese ledger: más miembros que cualquier techo de Codex, y todos coordinan.
    for (let i = 0; i < 8; i += 1) {
      const { servers, status } = await planner.assign({ memberId: `mem_g${i}`, workId: 'wrk_1', brandId: 'brd_1', runtime: i % 2 ? 'grok' : 'hermes', accountId: 'acc_0123456789abcdef' });
      expect(servers?.map((s) => s.name)).toEqual(['latte_coordination', 'latte_memory']);
      expect(status).toMatchObject({ coordinationInjected: true, memoryInjected: true, reason: null });
    }
  });
});

describe('Grok and Hermes through the service', () => {
  let b: TestBackend;
  let chat: ChatEvent[];
  let envDir: string;
  const pty = fakePtyLoader();

  beforeEach(async () => {
    chat = [];
    const dir = makeTempDir('latte-acp-env-');
    envDir = dir;
    b = await makeBackend({
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return args[0] === 'grok' || args[0] === 'hermes' ? { stdout: `${process.execPath}\n` } : { code: 1 };
        if (args[0] === 'models') return { stdout: 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n' };
        if (args[0] === 'auth' && args[1] === 'list') return { stdout: 'openai-codex (1 credentials):\n' };
        return { stdout: '1.0.41\n' };
      }),
      loadPty: pty.load,
      emitChat: (event) => chat.push(event),
      acpSpawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_ACP, ...args], options)) as typeof spawn,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', NODE_NO_WARNINGS: '1', FAKE_ACP_STATE: path.join(dir, 'state'), FAKE_ACP_FLAVOR: 'grok' },
    });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  });
  afterEach(async () => {
    b.cleanup();
    await new Promise((r) => setTimeout(r, 50));
    removeDir(envDir);
  });

  it('lists both runtimes, creates accounts and logs in through their own CLI in a terminal', async () => {
    const runtimes = await b.service.listAgentRuntimes();
    expect(runtimes.map((r) => r.runtime)).toEqual(['claude', 'codex', 'grok', 'hermes']);
    const grokAccount = await b.service.addAgentAccount('grok', 'Agencia');
    const hermesAccount = await b.service.addAgentAccount('hermes', 'Codex');
    const start = await b.service.startAccountLogin('grok', grokAccount.id);
    expect(start.mode).toBe('terminal');
    const spawned = pty.spawned[pty.spawned.length - 1];
    expect(spawned.args).toEqual(['login']);
    expect(spawned.options.env).toMatchObject({ GROK_HOME: path.join(b.dir, 'accounts', 'grok', grokAccount.id) });
    await b.service.startAccountLogin('hermes', hermesAccount.id);
    expect(pty.spawned[pty.spawned.length - 1].args).toEqual(['model']);
    await expect(b.service.startAccountLogin('grok', 'system')).rejects.toThrow(/account managed by Latte/);
    await expect(b.service.logoutAccount('hermes', hermesAccount.id)).rejects.toThrow(/remove this account/);
  });

  it('refuses a Grok primary agent on the system profile', async () => {
    await expect(b.service.setPrimaryAgent({ runtime: 'grok', model: null, accountId: 'system' })).rejects.toThrow(/account managed by Latte/);
    const account = await b.service.addAgentAccount('grok', 'Agencia');
    expect(await b.service.setPrimaryAgent({ runtime: 'grok', model: null, accountId: account.id })).toMatchObject({ runtime: 'grok', label: 'Grok · Agencia' });
  });

  it('a Grok member talks, persists as Grok and comes back from its transcript and session/load', async () => {
    const account = await b.service.addAgentAccount('grok', 'Agencia');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const session = await b.service.addTeamMember(work.id, 'strategist', { runtime: 'grok', accountId: account.id });
    expect(session).toMatchObject({ provider: 'grok', accountId: account.id });
    expect(b.repo.getMember(session.id).runtime).toBe('grok');
    await b.service.sendChat(session.id, 'hola');
    await waitFor(() => chat.some((e) => e.chatId === session.id && e.type === 'status' && e.status === 'idle'));
    const reply = (await b.service.listChatMessages(session.id)).filter((m) => m.role === 'assistant').pop();
    expect(reply?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Hola desde el fake' });
    // El uso llega al miembro, con el costo que Grok reportó.
    expect(b.repo.getMember(session.id).usage?.costUsd).toBeCloseTo(0.084152, 6);
    const sessionId = b.repo.getMember(session.id).sessionId;
    expect(sessionId).toMatch(/^fake-/);

    await b.service.pauseTeamMember(session.id);
    await waitFor(() => !b.hub.liveMemberIds(work.id).has(session.id));
    const paused = await b.service.listChatMessages(session.id);
    expect(paused.map((m) => m.role)).toEqual(['user', 'assistant']);

    const reopened = await b.service.openTeamMember(session.id);
    expect(reopened).toMatchObject({ resumed: true, historyRecovered: true });
    expect(b.repo.getMember(session.id).sessionId).toBe(sessionId);
  });

  it('without a managed account a Grok member does not open, and says why', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await expect(b.service.addTeamMember(work.id, 'strategist', { runtime: 'grok' })).rejects.toThrow(/account managed by Latte/);
    expect(b.repo.listMembers(work.id)).toEqual([]);
  });

  it('Settings chooses the Hermes model of a level, and the next conversation uses it', async () => {
    const account = await b.service.addAgentAccount('hermes', 'Codex');
    await b.service.setAcpTierModel('hermes', 'balanced', 'openai-codex:gpt-5.5');
    expect((await b.service.getAcpTierModels()).configured.hermes.balanced).toBe('openai-codex:gpt-5.5');
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    const session = await b.service.addTeamMember(work.id, 'strategist', { runtime: 'hermes', accountId: account.id, tier: 'balanced' });
    expect(session.model).toBe('openai-codex:gpt-5.5');
    const hermesHome = path.join(b.dir, 'accounts', 'hermes', account.id);
    expect(fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8')).toContain('mode: manual');
  });
});
