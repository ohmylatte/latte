import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { ChatManager, summariseProviders } from '../../electron/opencode/chatManager';
import { parseSseData } from '../../electron/opencode/client';
import { resolveOpenCodeBinary } from '../../electron/opencode/server';
import { describeMessageError, translatePart } from '../../electron/opencode/translate';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('OpenCode protocol helpers', () => {
  it('parses SSE frames and ignores comments', () => {
    expect(parseSseData(': connected')).toBeNull();
    expect(parseSseData('event: x\ndata: {"a":1}')).toBe('{"a":1}');
    expect(parseSseData('data: line1\ndata: line2')).toBe('line1\nline2');
  });

  it('translates parts and skips internal ones', () => {
    expect(translatePart({ id: 'p1', sessionID: 's', messageID: 'm', type: 'step-start' })).toBeNull();
    expect(translatePart({ id: 'p2', sessionID: 's', messageID: 'm', type: 'text', text: 'hi' })).toEqual({ type: 'text', id: 'p2', text: 'hi' });
    expect(translatePart({ id: 'p3', sessionID: 's', messageID: 'm', type: 'tool', callID: 'c', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', title: 'ls' } })).toEqual({
      type: 'tool', id: 'p3', tool: 'bash', status: 'completed', title: 'ls', input: '{\n  "command": "ls"\n}', output: 'a\nb', error: '',
    });
  });

  it('launches the real binary instead of the npm cmd shim on Windows when present', () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd';
    const real = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe';
    expect(resolveOpenCodeBinary(shim, 'win32', (p) => p === real)).toBe(real);
    expect(resolveOpenCodeBinary(shim, 'win32', () => false)).toBe(shim);
    expect(resolveOpenCodeBinary('/usr/local/bin/opencode', 'linux', () => true)).toBe('/usr/local/bin/opencode');
    expect(resolveOpenCodeBinary('C:\\bin\\opencode.exe', 'win32', () => true)).toBe('C:\\bin\\opencode.exe');
  });

  it('describes provider errors actionably and summarises providers', () => {
    expect(describeMessageError({ name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'no key' } })).toMatch(/authentication failed \(anthropic\): no key/);
    expect(describeMessageError({ name: 'MessageAbortedError', data: {} })).toBe('Response aborted');
    expect(summariseProviders({ providers: [{ id: 'a', name: 'A', source: 'api', models: { m1: { id: 'm1' }, m2: { id: 'm2' } } }], default: { a: 'm2' } })).toEqual({ models: ['a/m1', 'a/m2'], defaultModel: 'a/m2' });
    expect(summariseProviders({ providers: [], default: {} })).toEqual({ models: [], defaultModel: null });
  });
});

describe('ChatManager runtime detection', () => {
  it('reports an installed runtime without starting it or loading providers', async () => {
    let spawnCount = 0;
    const manager = new ChatManager({
      resolveExecutable: async () => ({ executable: '/definitely-not-opencode', version: '1.18.26' }),
      serverCwd: '/latte-data',
      emit: () => {},
      platform: 'linux',
      spawnImpl: (() => {
        spawnCount += 1;
        throw new Error('status must not spawn OpenCode');
      }) as typeof spawn,
    });

    await expect(manager.status()).resolves.toEqual({
      available: true,
      detail: 'OpenCode 1.18.26 detected. It will start when a chat or provider action is used.',
      version: '1.18.26',
      models: [],
      defaultModel: null,
    });
    expect(spawnCount).toBe(0);
    manager.shutdown();
  });

  it('still reports OpenCode as unavailable when no executable is installed', async () => {
    const manager = new ChatManager({
      resolveExecutable: async () => null,
      serverCwd: '/latte-data',
      emit: () => {},
    });

    await expect(manager.status()).resolves.toEqual({
      available: false,
      detail: 'OpenCode is not installed or not on PATH. Install it to use the native chat.',
      version: null,
      models: [],
      defaultModel: null,
    });
    manager.shutdown();
  });

  it('starts the OpenCode server path when a chat is explicitly started', async () => {
    let spawnCount = 0;
    const manager = new ChatManager({
      resolveExecutable: async () => ({ executable: '/definitely-not-opencode', version: '1.18.26' }),
      serverCwd: '/latte-data',
      emit: () => {},
      platform: 'linux',
      spawnImpl: (() => {
        spawnCount += 1;
        throw new Error('spawn requested');
      }) as typeof spawn,
    });

    await expect(manager.start({ workId: 'wrk_1', directory: '/work', title: 't' })).rejects.toThrow(/spawn requested/);
    expect(spawnCount).toBe(1);
    manager.shutdown();
  });
});

describe('ChatManager against a fake OpenCode server', () => {
  let fake: FakeOpenCode;
  let events: ChatEvent[];
  let manager: ChatManager;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    events = [];
    manager = new ChatManager({
      resolveExecutable: async () => ({ executable: 'C:\\fake\\opencode.exe', version: '1.18.26' }),
      serverCwd: 'C:\\latte-data',
      emit: (e) => events.push(e),
      endpoint: fake.endpoint,
      clientTimeoutMs: 3_000,
    });
  });

  afterEach(async () => {
    manager.shutdown();
    await fake.close();
  });

  it('reports the detected runtime without querying the configured endpoint', async () => {
    const status = await manager.status();
    expect(status).toEqual({
      available: true,
      detail: 'OpenCode 1.18.26 detected. It will start when a chat or provider action is used.',
      version: '1.18.26',
      models: [],
      defaultModel: null,
    });
    expect(fake.requests).toEqual([]);
  });

  it('lets the user pick a configured model and rejects unknown ones', async () => {
    await expect(manager.start({ workId: 'wrk_1', directory: 'C:\\w', title: 't', model: 'nope/none' })).rejects.toThrow(/not configured/);
    const { session } = await manager.start({ workId: 'wrk_1', directory: 'C:\\w', title: 't', model: 'fake-provider/fake-model' });
    expect(session.model).toBe('fake-provider/fake-model');
    await manager.send(session.id, 'hola');
    expect(fake.requests.find((r) => r.path.endsWith('/prompt_async'))?.body).toEqual({
      parts: [{ type: 'text', text: 'hola' }],
      model: { providerID: 'fake-provider', modelID: 'fake-model' },
      // Every prompt states the effort tier; `balanced` is the server's `medium`.
      variant: 'medium',
    });
  });

  it('creates a session scoped to the work directory and streams a full exchange', async () => {
    const { session, runtimeSessionId } = await manager.start({ workId: 'wrk_1', directory: 'C:\\work\\one', title: 'Marca · Uno' });
    expect(session).toMatchObject({ workId: 'wrk_1', provider: 'opencode', model: 'fake-provider/fake-model', resumed: false });
    const create = fake.requests.find((r) => r.path === '/session' && r.method === 'POST');
    expect(create?.query.get('directory')).toBe('C:\\work\\one');
    expect(create?.body).toEqual({ title: 'Marca · Uno' });
    await waitFor(() => fake.subscribers === 1);

    await manager.send(session.id, 'Hola agente');
    const prompt = fake.requests.find((r) => r.path.endsWith('/prompt_async'));
    expect(prompt?.query.get('directory')).toBe('C:\\work\\one');
    expect(prompt?.body).toEqual({ parts: [{ type: 'text', text: 'Hola agente' }], variant: 'medium' });

    await waitFor(() => events.some((e) => e.type === 'permission'));
    const types = events.map((e) => e.type);
    expect(types).toContain('status');
    expect(types.filter((t) => t === 'message').length).toBeGreaterThanOrEqual(2);
    expect(types).toContain('delta');
    // Internal step parts never reach the UI.
    expect(events.some((e) => e.type === 'part' && (e.part as { id: string }).id === 'prt_step')).toBe(false);

    const messages = manager.listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].parts).toEqual([{ type: 'text', id: expect.any(String), text: 'Hola agente' }]);
    const textPart = messages[1].parts.find((p) => p.type === 'text');
    expect(textPart).toMatchObject({ text: 'Hello' });
    const toolPart = messages[1].parts.find((p) => p.type === 'tool');
    expect(toolPart).toMatchObject({ tool: 'edit', status: 'running' });

    const permission = events.find((e) => e.type === 'permission');
    expect(permission).toMatchObject({ type: 'permission', request: { id: 'per_1', permission: 'edit', patterns: ['brief.md'], title: 'Edit brief.md' } });

    // A request id must belong to this chat: unknown or foreign ids are refused before any network call.
    await expect(manager.replyPermission(session.id, 'per_other', 'once')).rejects.toThrow(/Permission request not found/);
    await expect(manager.replyQuestion(session.id, 'que_other', null)).rejects.toThrow(/Question not found/);
    await manager.replyPermission(session.id, 'per_1', 'once');
    const reply = fake.requests.find((r) => r.path === '/permission/per_1/reply');
    expect(reply?.body).toEqual({ reply: 'once' });
    await waitFor(() => events.some((e) => e.type === 'permission-resolved') && events.some((e) => e.type === 'status' && e.status === 'idle'));

    expect(runtimeSessionId).toMatch(/^ses_fake/);
  });

  it('resumes a persisted session, loads history and rejects unknown ids gracefully', async () => {
    const first = await manager.start({ workId: 'wrk_1', directory: 'C:\\work\\one', title: 'Uno' });
    await manager.send(first.session.id, 'Primer mensaje');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    manager.stop(first.session.id);
    expect(events.at(-1)).toEqual({ chatId: first.session.id, type: 'closed', reason: 'stopped' });

    const resumed = await manager.start({ workId: 'wrk_1', directory: 'C:\\work\\one', title: 'Uno', previousSessionId: first.runtimeSessionId });
    expect(resumed.session.resumed).toBe(true);
    expect(resumed.runtimeSessionId).toBe(first.runtimeSessionId);
    const history = manager.listMessages(resumed.session.id);
    expect(history[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Primer mensaje' }] });

    const fresh = await manager.start({ workId: 'wrk_2', directory: 'C:\\work\\two', title: 'Dos', previousSessionId: 'ses_gone' });
    expect(fresh.session.resumed).toBe(false);
  });

  it('aborts, answers questions and surfaces server errors without crashing', async () => {
    const { session, runtimeSessionId } = await manager.start({ workId: 'wrk_1', directory: 'C:\\work\\one', title: 'Uno' });
    await waitFor(() => fake.subscribers === 1);
    await manager.abort(session.id);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));

    fake.emit('C:\\work\\one', 'question.asked', { id: 'que_1', sessionID: runtimeSessionId, questions: [{ header: 'Tono', question: '¿Qué tono?', options: [{ label: 'Cálido', description: 'Cercano' }], multiple: false, custom: true }] });
    await waitFor(() => events.some((e) => e.type === 'question'));
    expect(events.find((e) => e.type === 'question')).toMatchObject({ request: { id: 'que_1', questions: [{ header: 'Tono', options: [{ label: 'Cálido' }], custom: true }] } });
    await manager.replyQuestion(session.id, 'que_1', [['Cálido']]);
    expect(fake.requests.find((r) => r.path === '/question/que_1/reply')?.body).toEqual({ answers: [['Cálido']] });
    await waitFor(() => events.some((e) => e.type === 'question-resolved'));

    fake.emit('C:\\work\\one', 'session.error', { sessionID: runtimeSessionId, error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'expired' } } });
    await waitFor(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('authentication failed (openai)') });

    // Events for sessions we do not own are ignored.
    fake.emit('C:\\other', 'session.idle', { sessionID: 'ses_unknown' });
    expect(() => manager.listMessages('ses_missing')).toThrow(/Chat not found/);
  });

  it('refuses to talk to a server with the wrong credentials', async () => {
    const wrong = new ChatManager({
      resolveExecutable: async () => ({ executable: 'x', version: null }),
      serverCwd: 'C:\\latte-data',
      emit: () => {},
      endpoint: { baseUrl: fake.endpoint.baseUrl, authorization: 'Basic d3Jvbmc6d3Jvbmc=' },
      clientTimeoutMs: 2_000,
    });
    await expect(wrong.start({ workId: 'wrk_1', directory: 'C:\\w', title: 't' })).rejects.toThrow(/401/);
    wrong.shutdown();
  });
});

describe('LatteService chat integration', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which') && args[0] === 'opencode' ? { code: 0, stdout: 'C:\\npm\\opencode.exe\n' } : { code: 0, stdout: '1.18.26\n' }),
      emitChat: () => {},
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('starts a chat in the work directory with fresh instructions and persists the session for resume', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    await b.service.addDecision(work.id, 'Decisión previa');

    const chat = await b.service.startChat(work.id);
    expect(chat.workId).toBe(work.id);
    const workDir = b.files.workDir(brand.id, work.id);
    const create = fake.requests.find((r) => r.path === '/session' && r.method === 'POST');
    expect(create?.query.get('directory')).toBe(workDir);
    expect(create?.body).toEqual({ title: 'Casa · Trabajo' });
    expect(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8')).toContain('Decisión previa');
    expect(b.repo.listMembers(work.id)).toMatchObject([{ id: chat.id, roleId: 'assistant', runtime: 'opencode', sessionId: expect.stringMatching(/^ses_fake/) }]);

    await b.service.sendChat(chat.id, '  Hola  ');
    const prompt = fake.requests.find((r) => r.path.endsWith('/prompt_async'))?.body as { parts?: unknown; system?: string };
    expect(prompt?.parts).toEqual([{ type: 'text', text: 'Hola' }]);
    // Marketing behaviour reaches a plain chat too, through the runtime's own prompt channel.
    expect(prompt?.system).toContain('marketing');
    await expect(b.service.sendChat(chat.id, '   ')).rejects.toThrow(/cannot be empty/);
    await expect(b.service.replyPermission(chat.id, 'per_1', 'maybe' as never)).rejects.toThrow(/Invalid permission reply/);
    await expect(b.service.replyPermission(chat.id, '../x', 'once')).rejects.toThrow(/Invalid request id/);
    await expect(b.service.replyPermission(chat.id, 'per_never_asked', 'once')).rejects.toThrow(/Permission request not found/);
    // Shared runtime: the Engram project is stated in the instructions, not assumed from env.
    expect(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf8')).toContain(`project \`latte-${brand.id}\``);
    await expect(b.service.startChat(work.id, 'not a model')).rejects.toThrow(/Invalid model id/);

    await b.service.stopChat(chat.id);
    const again = await b.service.startChat(work.id);
    expect(again.resumed).toBe(true);
    const status = await b.service.chatStatus();
    expect(status.available).toBe(true);
  });
});

