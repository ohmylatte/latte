import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage } from '../../shared/contracts';
import { AcpConnection } from '../../electron/agents/acp/connection';
import { AcpChatAdapter } from '../../electron/agents/acp/acpAdapter';
import { toAcpMcpServers } from '../../electron/agents/acp/profiles';
import { TranscriptStore } from '../../electron/agents/transcripts';
import { makeTempDir, removeDir } from './helpers';
import { fakeRequests, makeFakeAcpAdapter, readFakeLog, standardProfile, waitFor, type FakeAcpSetup } from './acpHelpers';

const ACCOUNT = 'acc_0123456789abcdef';

function input(dir: string, extra: Record<string, unknown> = {}) {
  return { workId: 'wrk_1', chatId: 'mem_acp1', directory: dir, title: 'Trabajo', label: 'Fake', accountId: ACCOUNT, ...extra };
}

function lastAssistant(adapter: AcpChatAdapter, chatId = 'mem_acp1'): ChatMessage {
  const messages = adapter.listMessages(chatId).filter((m) => m.role === 'assistant');
  return messages[messages.length - 1];
}

describe('AcpConnection', () => {
  it('ignores responses nobody asked for and answers unknown agent requests with -32601', async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const written: string[] = [];
    toAgent.on('data', (chunk: Buffer) => written.push(...chunk.toString('utf8').split('\n').filter(Boolean)));
    const notifications: string[] = [];
    const connection = new AcpConnection(toAgent, fromAgent, {
      onRequest: (method) => (method === 'known' ? Promise.resolve({ ok: true }) : undefined),
      onNotification: (method) => notifications.push(method),
    });
    const pending = connection.request('initialize', {});
    fromAgent.write('{"jsonrpc":"2.0","id":"skills-reload","result":{}}\n');
    fromAgent.write('{"jsonrpc":"2.0","id":999,"result":{}}\n');
    fromAgent.write('not json at all\n');
    fromAgent.write('{"jsonrpc":"2.0","method":"_x.ai/announcements/update","params":{}}\n');
    fromAgent.write('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}\n');
    fromAgent.write('{"jsonrpc":"2.0","id":8,"method":"known","params":{}}\n');
    fromAgent.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
    await waitFor(() => written.length >= 3);
    const replies = written.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(replies.find((r) => r.id === 7)).toMatchObject({ error: { code: -32601 } });
    expect(replies.find((r) => r.id === 8)).toMatchObject({ result: { ok: true } });
    expect(notifications).toEqual(['_x.ai/announcements/update']);
  });

  it('rejects what is pending when it closes, and times out requests that must be quick', async () => {
    const connection = new AcpConnection(new PassThrough(), new PassThrough(), { onRequest: () => undefined, onNotification: () => {} });
    const slow = connection.request('session/new', {}, 30);
    await expect(slow).rejects.toThrow(/did not answer within/);
    const open = connection.request('session/prompt', {});
    connection.close('stopped');
    await expect(open).rejects.toThrow(/closed: stopped/);
    await expect(connection.request('x', {})).rejects.toThrow(/closed/);
  });

  it('surfaces the detail an agent puts in error.data', async () => {
    const fromAgent = new PassThrough();
    const connection = new AcpConnection(new PassThrough(), fromAgent, { onRequest: () => undefined, onNotification: () => {} });
    const call = connection.request('session/set_model', {});
    fromAgent.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error","data":{"details":"No LLM provider configured."}}}\n');
    await expect(call).rejects.toThrow('No LLM provider configured.');
  });
});

describe('toAcpMcpServers', () => {
  it('puts the bearer in a header and the stdio env as name/value pairs', () => {
    expect(toAcpMcpServers([
      { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:1/mcp', token: 'tok-secret' },
      { kind: 'stdio', name: 'latte_memory', command: 'engram', args: ['mcp'], env: { ENGRAM_PROJECT: 'marca' } },
    ])).toEqual([
      { type: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-secret' }] },
      { name: 'latte_memory', command: 'engram', args: ['mcp'], env: [{ name: 'ENGRAM_PROJECT', value: 'marca' }] },
    ]);
    expect(toAcpMcpServers(undefined)).toEqual([]);
  });
});

describe('AcpChatAdapter', () => {
  let dir: string;
  let setup: FakeAcpSetup;
  let adapter: AcpChatAdapter | null = null;
  let events: ChatEvent[];

  beforeEach(() => {
    dir = makeTempDir('latte-acp-');
    setup = { dir, log: path.join(dir, 'fake.log'), state: path.join(dir, 'state') };
    events = [];
  });
  afterEach(async () => {
    adapter?.shutdown();
    adapter = null;
    await new Promise((r) => setTimeout(r, 50));
    removeDir(dir);
  });

  it('refuses to run without an account managed by Latte', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await expect(adapter.start(input(dir, { accountId: 'system' }))).rejects.toThrow(/account managed by Latte/);
    expect(readFakeLog(setup.log)).toEqual([]);
  });

  it('opens a session per member: isolation env, cwd, and MCP servers with the bearer off argv', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    const result = await adapter.start(input(dir, { mcpServers: [{ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:9/mcp', token: 'tok-member' }] }));
    expect(result.runtimeSessionId).toMatch(/^fake-/);
    expect(result.session).toMatchObject({ id: 'mem_acp1', provider: 'grok', resumed: false, accountId: ACCOUNT });
    // Lo que Latte mandó no es lo que el agente levantó: sin confirmación, no se afirma nada.
    expect(result.injectedMcpServers).toBeUndefined();
    expect(adapter.owns('mem_acp1')).toBe(true);
    const start = readFakeLog(setup.log).find((e) => e.kind === 'start') as { argv: string[]; cwd: string };
    expect(start.argv).toEqual(['acp']);
    expect(JSON.stringify(start.argv)).not.toContain('tok-member');
    expect(fs.realpathSync(start.cwd)).toBe(fs.realpathSync(dir));
    const init = fakeRequests(setup.log, 'initialize')[0];
    expect(init).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const created = fakeRequests(setup.log, 'session/new')[0];
    expect(created.mcpServers).toEqual([{ type: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-member' }] }]);
  });

  it('streams a turn into one assistant message and reports the last call as the context (N3)', async () => {
    const transcripts = new TranscriptStore(path.join(dir, 'transcripts'));
    adapter = makeFakeAcpAdapter(events, setup, { transcripts });
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'hola');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    const message = lastAssistant(adapter);
    expect(message.completed).toBe(true);
    expect(message.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    expect(message.parts[1]).toMatchObject({ type: 'text', text: 'Hola desde el fake' });
    const statuses = events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(['busy', 'idle']);
    const usage = events.find((e) => e.type === 'usage') as Extract<ChatEvent, { type: 'usage' }>;
    // 53804 de entrada INCLUYEN los 42496 de caché: lo fresco es la resta.
    expect(usage.turn).toMatchObject({ inputTokens: 53804 - 42496, cacheReadTokens: 42496, outputTokens: 303, turns: 1, costUsd: null, contextTokens: 11437 });
    // El transcripto guarda el turno una vez, con la pregunta y la respuesta.
    const saved = transcripts.load('mem_acp1');
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('maps tool calls: name, title, input, output and failures', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'TOOLS');
    await waitFor(() => lastAssistant(adapter!)?.completed === true);
    const tools = lastAssistant(adapter).parts.filter((p) => p.type === 'tool');
    expect(tools).toEqual([
      expect.objectContaining({ id: 'tc-ok', tool: 'read_file', status: 'completed', title: 'read_file: notes.md', output: 'contenido' }),
      expect.objectContaining({ id: 'tc-bad', tool: 'write', status: 'error', error: 'disk full' }),
    ]);
    expect(tools[0].type === 'tool' && tools[0].input).toContain('notes.md');
  });

  it('closes a tool the agent never closed when the turn ends well', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'OPENTOOL');
    await waitFor(() => lastAssistant(adapter!)?.completed === true);
    expect(lastAssistant(adapter).parts.find((p) => p.type === 'tool')).toMatchObject({ id: 'tc-open', status: 'completed' });
  });

  it.each([
    ['once', 'allow-once'],
    ['always', 'allow-edits-session'],
    ['reject', 'reject-once'],
  ] as const)('answers a permission "%s" with the option whose kind matches (%s)', async (reply, optionId) => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'PERMISSION');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const asked = events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    expect(asked.request).toMatchObject({ permission: 'edit', patterns: ['perm.txt'], always: ['session'], title: 'Write `perm.txt`' });
    await adapter.replyPermission('mem_acp1', asked.request.id, reply);
    await waitFor(() => lastAssistant(adapter!)?.completed === true);
    expect(events).toContainEqual({ chatId: 'mem_acp1', type: 'permission-resolved', requestId: asked.request.id });
    expect(lastAssistant(adapter).parts.find((p) => p.type === 'text')).toMatchObject({ text: `permission=${optionId}` });
    await expect(adapter.replyPermission('mem_acp1', asked.request.id, 'once')).rejects.toThrow(/not found/i);
  });

  it('cancels a turn with session/cancel and answers the pending permission as cancelled', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'PERMISSION');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const asked = events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    await adapter.abort('mem_acp1');
    expect(events).toContainEqual({ chatId: 'mem_acp1', type: 'permission-resolved', requestId: asked.request.id });
    await waitFor(() => lastAssistant(adapter!)?.completed === true);
    expect(lastAssistant(adapter).parts.find((p) => p.type === 'text')).toMatchObject({ text: 'permission=cancelled' });
    expect(fakeRequests(setup.log, 'session/cancel')).toHaveLength(1);
  });

  it('a cancelled turn ends without an error and leaves the chat ready', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'SLOW');
    await waitFor(() => lastAssistant(adapter!)?.parts.length > 0);
    expect(adapter.isBusy('mem_acp1')).toBe(true);
    await adapter.abort('mem_acp1');
    await waitFor(() => !adapter!.isBusy('mem_acp1'));
    expect(lastAssistant(adapter)).toMatchObject({ completed: true, error: null });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    await adapter.send('mem_acp1', 'hola otra vez');
    await waitFor(() => events.filter((e) => e.type === 'status' && e.status === 'idle').length === 2);
  });

  it('resumes with session/load: the replay is ignored and the pane comes back from the transcript', async () => {
    const transcripts = new TranscriptStore(path.join(dir, 'transcripts'));
    adapter = makeFakeAcpAdapter(events, setup, { transcripts });
    const first = await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'hola');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    adapter.stop('mem_acp1');
    expect(events).toContainEqual({ chatId: 'mem_acp1', type: 'closed', reason: 'stopped' });
    const resumed = await adapter.start(input(dir, { previousSessionId: first.runtimeSessionId }));
    expect(resumed.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(resumed.session).toMatchObject({ resumed: true, historyRecovered: true });
    expect(fakeRequests(setup.log, 'session/load')[0]).toMatchObject({ sessionId: first.runtimeSessionId });
    // Dos mensajes del transcripto, ninguno repetido por el replay del agente.
    expect(adapter.listMessages('mem_acp1').map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('starts a new session when the one to resume is gone', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    const result = await adapter.start(input(dir, { previousSessionId: 'fake-gone-1' }));
    expect(result.runtimeSessionId).not.toBe('fake-gone-1');
    expect(result.session.resumed).toBe(false);
  });

  it('reports a process that dies mid-turn and lets go of the chat', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'EXIT');
    await waitFor(() => events.some((e) => e.type === 'closed'));
    expect(events.some((e) => e.type === 'error' && /exited/.test(e.message))).toBe(true);
    expect(adapter.owns('mem_acp1')).toBe(false);
  });

  it('a prompt the agent rejects is an error on screen, and the chat stays usable', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'FAIL');
    await waitFor(() => events.some((e) => e.type === 'status' && e.status === 'idle'));
    expect(events.some((e) => e.type === 'error' && e.message === 'the fake model failed')).toBe(true);
    expect(lastAssistant(adapter)).toMatchObject({ completed: true, error: 'the fake model failed' });
    expect(adapter.isBusy('mem_acp1')).toBe(false);
  });

  it('a failed initialize never leaves a chat or a process behind', async () => {
    setup.extraEnv = { FAKE_ACP_FAIL_INITIALIZE: '1' };
    adapter = makeFakeAcpAdapter(events, setup);
    await expect(adapter.start(input(dir))).rejects.toThrow(/Could not start Fake: initialize refused/);
    expect(adapter.owns('mem_acp1')).toBe(false);
    expect(adapter.processCount()).toBe(0);
  });

  it('refuses an agent that speaks another protocol version', async () => {
    setup.extraEnv = { FAKE_ACP_PROTOCOL: '2' };
    adapter = makeFakeAcpAdapter(events, setup);
    await expect(adapter.start(input(dir))).rejects.toThrow(/protocol 2/);
  });

  it('keeps its own process ceiling, counting the ones still starting', async () => {
    setup.extraEnv = { FAKE_ACP_NEW_DELAY_MS: '300' };
    adapter = makeFakeAcpAdapter(events, setup, { maxProcesses: 1 });
    const first = adapter.start(input(dir));
    await expect(adapter.start(input(dir, { chatId: 'mem_acp2' }))).rejects.toThrow(/max 1/);
    await first;
    await expect(adapter.start(input(dir, { chatId: 'mem_acp3' }))).rejects.toThrow(/max 1/);
  });

  it('two opens of the same chat never spawn two processes', async () => {
    setup.extraEnv = { FAKE_ACP_NEW_DELAY_MS: '200' };
    adapter = makeFakeAcpAdapter(events, setup);
    const first = adapter.start(input(dir));
    await expect(adapter.start(input(dir))).rejects.toThrow(/already open/);
    await first;
    expect(readFakeLog(setup.log).filter((e) => e.kind === 'start')).toHaveLength(1);
  });

  it('confirms the MCP servers the agent says it brought up', async () => {
    const confirmed: Array<{ chatId: string; names: string[] }> = [];
    setup.flavor = 'grok';
    adapter = makeFakeAcpAdapter(events, setup, {
      profile: standardProfile({
        confirmsMcpInjection: true,
        mcpSignal: (method, params) => {
          const p = params as { name?: string; status?: string };
          if (method === '_x.ai/mcp/server_status' && p.name) return { kind: 'status', name: p.name, ready: p.status === 'ready' };
          if (method === '_x.ai/mcp_initialized') return { kind: 'initialized' };
          return null;
        },
      }),
      onMcpServers: (chatId, names) => confirmed.push({ chatId, names }),
    });
    await adapter.start(input(dir, { mcpServers: [
      { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:9/mcp', token: 't' },
      { kind: 'http', name: 'latte_conn_broken', url: 'http://127.0.0.1:9/x', token: 't' },
    ] }));
    await waitFor(() => confirmed.length > 0);
    expect(confirmed[0]).toEqual({ chatId: 'mem_acp1', names: ['latte_coordination'] });
    expect(adapter.confirmsMcpInjection).toBe(true);
  });

  it('bridges native questions through the profile and resolves them on cancel', async () => {
    setup.flavor = 'grok';
    adapter = makeFakeAcpAdapter(events, setup, {
      profile: standardProfile({
        questions: {
          method: '_x.ai/ask_user_question',
          parse: (params) => ((params as { questions: Array<{ question: string }> }).questions.map((q) => ({ header: '', question: q.question, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiple: false, custom: true }))),
          answer: (items, answers) => ({ outcome: 'accepted', answers: { [items[0].question]: answers[0].join(', ') }, annotations: {} }),
          dismissed: () => new Error('dismissed') as never,
        },
      }),
    });
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'ASK');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const asked = events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>;
    expect(asked.request.questions[0].question).toBe('Which color?');
    await adapter.replyQuestion('mem_acp1', asked.request.id, [['Blue']]);
    await waitFor(() => lastAssistant(adapter!)?.completed === true);
    expect(lastAssistant(adapter).parts.find((p) => p.type === 'text')).toMatchObject({ text: 'answer={"outcome":"accepted","answers":{"Which color?":"Blue"},"annotations":{}}' });
    expect(events).toContainEqual({ chatId: 'mem_acp1', type: 'question-resolved', requestId: asked.request.id });
  });

  it('a runtime without native questions says so', async () => {
    adapter = makeFakeAcpAdapter(events, setup);
    await adapter.start(input(dir));
    await expect(adapter.replyQuestion('mem_acp1', 'ask-x', [['a']])).rejects.toThrow(/not found/i);
  });

  it('closes the permission card when the agent gives up waiting', async () => {
    setup.flavor = 'hermes';
    adapter = makeFakeAcpAdapter(events, setup, { profile: standardProfile({ label: 'Hermes', permissionTimeoutMs: 150 }) });
    await adapter.start(input(dir));
    await adapter.send('mem_acp1', 'PERMISSION');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const asked = events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    expect(asked.request.always).toEqual([]);
    await waitFor(() => events.some((e) => e.type === 'permission-resolved'));
    expect(events.some((e) => e.type === 'error' && /nobody answered within/.test(e.message))).toBe(true);
    await expect(adapter.replyPermission('mem_acp1', asked.request.id, 'once')).rejects.toThrow(/not found/i);
  });
});
