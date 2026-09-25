import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OpenCodeEndpoint } from '../../electron/opencode/server';

/**
 * A tiny stand-in for `opencode serve`: Basic auth, sessions, prompt_async,
 * permissions, questions and the global SSE stream. No model is involved;
 * it scripts a deterministic reply so the protocol handling can be tested.
 */
export interface FakeOpenCode {
  endpoint: OpenCodeEndpoint;
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }>;
  emit(directory: string, type: string, properties: Record<string, unknown>): void;
  close(): Promise<void>;
  sessions: Map<string, { id: string; directory: string; title: string }>;
  credentials: Map<string, Record<string, unknown>>;
  subscribers: number;
}

/**
 * What real OpenCode keeps on disk (its data dir), shared by every server
 * process of the same user: a session created by one process can be resumed
 * by another. Verified against opencode 1.18.32: `GET /session/:id` on a
 * second `opencode serve` returns a session the first one created.
 */
export interface FakeOpenCodeStore {
  sessions: Map<string, { id: string; directory: string; title: string }>;
  messages: Map<string, Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>;
}

let sessionCounter = 0;

export function fakeOpenCodeStore(): FakeOpenCodeStore {
  return { sessions: new Map(), messages: new Map() };
}

export async function startFakeOpenCode(options: { username?: string; password?: string; scriptedReply?: boolean; store?: FakeOpenCodeStore; mcpStatus?: Record<string, unknown> } = {}): Promise<FakeOpenCode> {
  const username = options.username ?? 'latte';
  const password = options.password ?? 'secret-test-password';
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const store = options.store ?? fakeOpenCodeStore();
  const sessions = store.sessions;
  const messages = store.messages;
  const streams = new Set<http.ServerResponse>();
  const credentials = new Map<string, Record<string, unknown>>();
  const requests: FakeOpenCode['requests'] = [];
  let counter = 0;

  const emit = (directory: string, type: string, properties: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify({ directory, payload: { id: `evt_${++counter}`, type, properties } })}\n\n`;
    for (const res of streams) res.write(frame);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body });
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      };
      const directory = url.searchParams.get('directory') ?? '';
      const parts = url.pathname.split('/').filter(Boolean);

      if (url.pathname === '/global/health') return json(200, { healthy: true, version: 'fake' });
      if (url.pathname === '/global/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        streams.add(res);
        // In modern Node the request emits 'close' as soon as its body is consumed;
        // the response 'close' is the one that tracks the connection.
        res.on('close', () => streams.delete(res));
        return;
      }
      if (url.pathname === '/config/providers') {
        return json(200, {
          providers: [{ id: 'fake-provider', name: 'Fake', source: 'api', env: [], options: {}, models: { 'fake-model': { id: 'fake-model', providerID: 'fake-provider', name: 'Fake Model' } } }],
          default: { 'fake-provider': 'fake-model' },
        });
      }
      if (url.pathname === '/permission') return json(200, []);
      // `GET /mcp`: what THIS process connected. Only answered when a test scripts it,
      // so a fake without it behaves like a server that cannot say (404).
      if (url.pathname === '/mcp' && req.method === 'GET' && options.mcpStatus) return json(200, options.mcpStatus);
      // Provider catalog + credential store (in memory, never touches disk).
      if (url.pathname === '/provider' && req.method === 'GET') {
        return json(200, {
          all: [
            { id: 'fake-provider', name: 'Fake', source: 'api', env: [], options: {}, models: { 'fake-model': { id: 'fake-model' } } },
            { id: 'deepseek', name: 'DeepSeek', source: 'api', env: ['DEEPSEEK_API_KEY'], options: {}, models: { 'deepseek-chat': { id: 'deepseek-chat' }, 'deepseek-reasoner': { id: 'deepseek-reasoner' } } },
            { id: 'openai', name: 'OpenAI', source: 'api', env: [], options: {}, models: { 'gpt-5': { id: 'gpt-5' } } },
          ],
          connected: ['fake-provider', ...credentials.keys()],
          default: { 'fake-provider': 'fake-model' },
        });
      }
      if (url.pathname === '/provider/auth' && req.method === 'GET') {
        return json(200, {
          openai: [
            { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', prompts: [] },
            { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', prompts: [] },
            { type: 'api', label: 'Manually enter API Key', prompts: [{ type: 'text', key: 'key', message: 'API key' }] },
          ],
        });
      }
      if (parts[0] === 'auth' && parts[1]) {
        if (req.method === 'PUT') { credentials.set(parts[1], body as Record<string, unknown>); return json(200, true); }
        if (req.method === 'DELETE') { credentials.delete(parts[1]); return json(200, true); }
      }
      if (parts[0] === 'provider' && parts[2] === 'oauth' && parts[3] === 'authorize') {
        const method = Number((body as { method?: number })?.method);
        return json(200, { url: `https://login.example.test/${parts[1]}?m=${method}`, method: method === 1 ? 'code' : 'auto', instructions: method === 1 ? 'Paste the code shown by the browser.' : 'Complete the login in your browser.' });
      }
      if (parts[0] === 'provider' && parts[2] === 'oauth' && parts[3] === 'callback') {
        const code = (body as { code?: string })?.code;
        if (Number((body as { method?: number })?.method) === 1 && code !== 'good-code') return json(400, { name: 'OAuthError', data: { message: 'invalid code' } });
        credentials.set(parts[1], { type: 'oauth' });
        return json(200, true);
      }
      if (url.pathname === '/session' && req.method === 'POST') {
        const id = `ses_fake${++sessionCounter}`;
        sessions.set(id, { id, directory, title: String((body as { title?: string })?.title ?? '') });
        messages.set(id, []);
        return json(200, { id, title: sessions.get(id)!.title, directory, time: { created: Date.now(), updated: Date.now() } });
      }
      if (parts[0] === 'session' && parts[1]) {
        const session = sessions.get(parts[1]);
        if (!session) return json(404, { name: 'NotFoundError', data: { message: 'Session not found' } });
        if (parts.length === 2 && req.method === 'GET') return json(200, { id: session.id, title: session.title, directory: session.directory });
        if (parts.length === 2 && req.method === 'DELETE') { sessions.delete(session.id); return json(200, true); }
        if (parts[2] === 'message' && req.method === 'GET') return json(200, messages.get(session.id) ?? []);
        if (parts[2] === 'abort') { emit(directory, 'session.idle', { sessionID: session.id }); return json(200, true); }
        if (parts[2] === 'prompt_async') {
          const text = String((body as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? '');
          const userId = `msg_u${++counter}`;
          const assistantId = `msg_a${++counter}`;
          const history = messages.get(session.id)!;
          history.push({ info: { id: userId, sessionID: session.id, role: 'user', time: { created: Date.now() } }, parts: [{ id: `prt_${++counter}`, sessionID: session.id, messageID: userId, type: 'text', text }] });
          json(200, { info: { id: userId }, parts: [] });
          if (options.scriptedReply === false) return;
          setTimeout(() => {
            emit(directory, 'session.status', { sessionID: session.id, status: { type: 'busy' } });
            emit(directory, 'message.updated', { sessionID: session.id, info: history[history.length - 1].info });
            emit(directory, 'message.part.updated', { sessionID: session.id, part: history[history.length - 1].parts[0], time: Date.now() });
            emit(directory, 'message.updated', { sessionID: session.id, info: { id: assistantId, sessionID: session.id, role: 'assistant', time: { created: Date.now() }, modelID: 'fake-model', providerID: 'fake-provider' } });
            emit(directory, 'message.part.updated', { sessionID: session.id, part: { id: 'prt_step', sessionID: session.id, messageID: assistantId, type: 'step-start' }, time: Date.now() });
            emit(directory, 'message.part.updated', { sessionID: session.id, part: { id: 'prt_text', sessionID: session.id, messageID: assistantId, type: 'text', text: 'Hel' }, time: Date.now() });
            emit(directory, 'message.part.delta', { sessionID: session.id, messageID: assistantId, partID: 'prt_text', field: 'text', delta: 'lo' });
            emit(directory, 'message.part.updated', { sessionID: session.id, part: { id: 'prt_tool', sessionID: session.id, messageID: assistantId, type: 'tool', callID: 'call1', tool: 'edit', state: { status: 'running', input: { filePath: 'brief.md' }, time: { start: Date.now() } } }, time: Date.now() });
            emit(directory, 'permission.asked', { id: 'per_1', sessionID: session.id, permission: 'edit', patterns: ['brief.md'], always: ['*'], metadata: { title: 'Edit brief.md' }, tool: { messageID: assistantId, callID: 'call1' } });
          }, 5);
          return;
        }
      }
      if (parts[0] === 'permission' && parts[2] === 'reply') {
        const session = [...sessions.values()][0];
        const reply = String((body as { reply?: string })?.reply);
        emit(directory, 'permission.replied', { sessionID: session?.id, requestID: parts[1], reply });
        if (session) {
          const assistantId = 'msg_after_permission';
          emit(directory, 'message.part.updated', { sessionID: session.id, part: { id: 'prt_tool', sessionID: session.id, messageID: assistantId, type: 'tool', callID: 'call1', tool: 'edit', state: reply === 'reject' ? { status: 'error', input: {}, error: 'rejected by user', time: { start: 1, end: 2 } } : { status: 'completed', input: { filePath: 'brief.md' }, output: 'ok', title: 'Edited brief.md', metadata: {}, time: { start: 1, end: 2 } } }, time: Date.now() });
          emit(directory, 'session.idle', { sessionID: session.id });
        }
        return json(200, true);
      }
      if (parts[0] === 'question' && (parts[2] === 'reply' || parts[2] === 'reject')) {
        const session = [...sessions.values()][0];
        emit(directory, parts[2] === 'reply' ? 'question.replied' : 'question.rejected', { sessionID: session?.id, requestID: parts[1], answers: (body as { answers?: unknown })?.answers });
        return json(200, true);
      }
      json(404, { message: `unhandled ${req.method} ${url.pathname}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: { baseUrl: `http://127.0.0.1:${port}`, authorization: expectedAuth },
    requests,
    emit,
    sessions,
    credentials,
    get subscribers() { return streams.size; },
    close: () => new Promise<void>((resolve) => {
      for (const res of streams) res.end();
      streams.clear();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
