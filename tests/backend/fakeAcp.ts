/**
 * Un agente ACP de mentira: JSON-RPC 2.0 por stdio, el subconjunto de Agent
 * Client Protocol v1 que Latte usa, y los quirks de Grok y Hermes medidos en
 * el brief 2026-09-25 (se prenden por entorno). Ningún modelo: cada prompt
 * sigue un guion que se elige con una palabra clave en el texto.
 *
 * Se corre como proceso (`node fakeAcp.ts`, Node 24 quita los tipos solo),
 * igual que `fakeClaude.cjs` y `fakeCodex.cjs`.
 *
 * Entorno:
 *   FAKE_ACP_LOG           archivo donde se anota todo lo que entra (JSONL), más el arranque.
 *   FAKE_ACP_STATE         directorio para las sesiones (así `session/load` funciona entre procesos).
 *   FAKE_ACP_FLAVOR        `grok` | `hermes` | `standard` (default): forma del uso, de las
 *                          preguntas, de los permisos y de la confirmación de MCP.
 *   FAKE_ACP_FAIL_INITIALIZE, FAKE_ACP_PROTOCOL, FAKE_ACP_NEW_DELAY_MS, FAKE_ACP_CATALOG
 *
 * Palabras clave del prompt:
 *   PERMISSION  pide permiso para escribir y cuenta qué se eligió.
 *   ASK         hace una pregunta nativa (Grok) y repite la respuesta.
 *   SLOW        no termina hasta que llega `session/cancel`.
 *   TOOLS       una herramienta que termina bien y otra que falla.
 *   OPENTOOL    una herramienta que nunca recibe su cierre (Hermes con las tools MCP).
 *   ECHO        contesta con el texto exacto que recibió.
 *   LISTMCP     contesta con los servidores MCP que tiene registrados ahora.
 *   MCP <server> <tool> <json>  llama esa tool por HTTP con el header que vino en `mcpServers`.
 *   FAIL        el prompt vuelve con un error JSON-RPC.
 *   EXIT        el proceso se muere a mitad de turno.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

type Json = Record<string, unknown>;
interface McpServer { type?: string; name: string; url?: string; headers?: Array<{ name: string; value: string }>; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> }
interface Session { id: string; cwd: string; mcpServers: McpServer[]; history: Array<{ role: 'user' | 'agent'; text: string }>; model: string; mcpLost: boolean; mode: string; config: Record<string, string> }

const flavor = process.env.FAKE_ACP_FLAVOR ?? 'standard';
const logFile = process.env.FAKE_ACP_LOG;
const stateDir = process.env.FAKE_ACP_STATE;
const log = (entry: Json): void => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };

const ENV_KEYS = /^(GROK_|HERMES_|USERPROFILE$|HOME$|PYTHONPATH$|ENGRAM_|LATTE_)/;
log({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_KEYS.test(k))) });

const out = (message: Json): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
const notify = (method: string, params: unknown): void => out({ jsonrpc: '2.0', method, params });
const update = (sessionId: string, body: Json): void => notify('session/update', { sessionId, update: body });

let nextRequestId = 1000;
const waiting = new Map<number, (message: Json) => void>();
/** Un request del agente al cliente (permisos, preguntas). */
function ask(method: string, params: unknown): Promise<Json> {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    out({ jsonrpc: '2.0', id, method, params });
  });
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;
let cancelled: (() => void) | null = null;

function sessionFile(id: string): string | null {
  return stateDir ? path.join(stateDir, `${id.replace(/[^a-z0-9-]/gi, '_')}.json`) : null;
}
function save(session: Session): void {
  const file = sessionFile(session.id);
  if (file) fs.writeFileSync(file, JSON.stringify(session));
}
function loadSession(id: string): Session | null {
  const live = sessions.get(id);
  if (live) return live;
  const file = sessionFile(id);
  if (!file || !fs.existsSync(file)) return null;
  const session = JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
  sessions.set(id, session);
  return session;
}

/** Lo que el agente dice sobre los MCP que levantó (Grok 1.0.41; Hermes no lo dice por ACP). */
function announceMcp(session: Session): void {
  if (flavor !== 'grok') return;
  for (const server of session.mcpServers) notify('_x.ai/mcp/server_status', { sessionId: session.id, name: server.name, source: 'local', status: server.name.includes('broken') ? 'failed' : 'ready' });
  notify('_x.ai/mcp_initialized', { sessionId: session.id, mcpToolCount: session.mcpServers.length });
}

const catalog = (process.env.FAKE_ACP_CATALOG ?? '').split(',').filter(Boolean);

async function handle(message: Json): Promise<void> {
  const { id, method } = message as { id?: number | string; method?: string };
  const params = (message.params ?? {}) as Json;
  if (method === undefined) {
    // Una respuesta del cliente a un request nuestro.
    const resolve = typeof id === 'number' ? waiting.get(id) : undefined;
    if (resolve && typeof id === 'number') { waiting.delete(id); resolve(message); }
    return;
  }
  const reply = (result: unknown): void => out({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string, data?: unknown): void => out({ jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } });
  switch (method) {
    case 'initialize': {
      if (process.env.FAKE_ACP_FAIL_INITIALIZE) return fail(-32000, 'initialize refused by the fake');
      // Ruido que Grok manda sin que nadie lo pida: una notificación propia y una respuesta a un id ajeno.
      notify('_x.ai/announcements/update', { items: [] });
      out({ jsonrpc: '2.0', id: 'skills-reload', result: {} });
      out({ jsonrpc: '2.0', id: 987654, result: { stray: true } });
      return reply({
        protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL ?? 1),
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true }, mcpCapabilities: { http: true, sse: false } },
        authMethods: [],
        agentInfo: { name: `fake-${flavor}`, version: '0.0.1' },
      });
    }
    case 'session/new': {
      const delay = Number(process.env.FAKE_ACP_NEW_DELAY_MS ?? 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      sessionCounter += 1;
      const session: Session = { id: `fake-${process.pid}-${sessionCounter}`, cwd: String(params.cwd ?? ''), mcpServers: (params.mcpServers as McpServer[]) ?? [], history: [], model: process.env.FAKE_ACP_DEFAULT_MODEL ?? 'fake-default', mcpLost: false, mode: 'default', config: { reasoning_effort: 'high' } };
      sessions.set(session.id, session);
      save(session);
      announceMcp(session);
      return reply({ sessionId: session.id, models: { currentModelId: session.model }, ...(flavor === 'hermes' ? { modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept_edits' }, { id: 'dont_ask' }] } } : {}) });
    }
    case 'session/load': {
      const session = loadSession(String(params.sessionId ?? ''));
      if (!session) return fail(-32002, `Session not found: ${String(params.sessionId)}`);
      session.mcpServers = (params.mcpServers as McpServer[]) ?? session.mcpServers;
      session.mcpLost = false;
      session.cwd = String(params.cwd ?? session.cwd);
      // Replay antes de responder, como pide ACP y como hacen los dos.
      for (const entry of session.history) update(session.id, { sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: entry.text } });
      save(session);
      announceMcp(session);
      return reply({ models: { currentModelId: session.model } });
    }
    case 'session/set_model': {
      const session = sessions.get(String(params.sessionId ?? ''));
      if (!session) return fail(-32002, 'Session not found');
      const raw = String(params.modelId ?? '');
      const [provider, model] = raw.includes(':') ? raw.split(/:(.*)/s) : [session.model.split(':')[0], raw];
      const sameProvider = provider === session.model.split(':')[0];
      // El bug de Hermes (brief 7.1, punto 10): mismo proveedor y fuera del catálogo estático → falla.
      if (flavor === 'hermes' && sameProvider && catalog.length > 0 && !catalog.includes(model)) {
        return fail(-32603, 'Internal error', { details: 'No LLM provider configured. Run `hermes model` to select a provider.' });
      }
      session.model = `${provider}:${model}`;
      // El otro bug de Hermes: reconstruir el agente pierde los MCP inyectados por ACP.
      if (flavor === 'hermes') session.mcpLost = true;
      save(session);
      return reply({});
    }
    case 'session/set_config_option': {
      const session = sessions.get(String(params.sessionId ?? ''));
      if (!session) return fail(-32002, 'Session not found');
      if (typeof params.value !== 'string') return fail(-32602, 'Invalid params', 'data did not match any variant of untagged enum SessionConfigOptionValue');
      session.config[String(params.configId)] = params.value;
      return reply({ configOptions: [{ id: String(params.configId), currentValue: params.value }] });
    }
    case 'session/set_mode': {
      const session = sessions.get(String(params.sessionId ?? ''));
      if (session) session.mode = String(params.modeId ?? '');
      return reply({});
    }
    case 'session/cancel': {
      const stop = cancelled;
      cancelled = null;
      stop?.();
      return;
    }
    case 'session/prompt':
      return prompt(params, reply, fail);
    default:
      if (id !== undefined) return fail(-32601, `Method not found: ${method}`);
  }
}

function promptText(params: Json): string {
  const blocks = Array.isArray(params.prompt) ? params.prompt as Json[] : [];
  return blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
}

function usageFor(sessionId: string): Json {
  if (flavor === 'grok') {
    return { stopReason: 'end_turn', _meta: { sessionId, inputTokens: 19024, outputTokens: 294, cachedReadTokens: 1792, usage: { inputTokens: 56200, outputTokens: 764, cachedReadTokens: 21888, cacheCreationTokens: 0, reasoningTokens: 606, modelCalls: 3, costUsdTicks: 841520000 } } };
  }
  update(sessionId, { sessionUpdate: 'usage_update', size: 272000, used: 7178 });
  update(sessionId, { sessionUpdate: 'usage_update', size: 272000, used: 11437 });
  return { stopReason: 'end_turn', usage: { inputTokens: 53804, outputTokens: 303, cachedReadTokens: 42496, thoughtTokens: 0, totalTokens: 54107 } };
}

async function prompt(params: Json, reply: (result: unknown) => void, fail: (code: number, text: string) => void): Promise<void> {
  const session = sessions.get(String(params.sessionId ?? ''));
  if (!session) return fail(-32002, 'Session not found');
  const text = promptText(params);
  session.history.push({ role: 'user', text });
  const sid = session.id;
  const say = (chunk: string): void => { update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }); };
  const finish = (answer: string): void => {
    session.history.push({ role: 'agent', text: answer });
    save(session);
    reply(usageFor(sid));
  };

  if (text.includes('FAIL')) return fail(-32603, 'the fake model failed');
  if (text.includes('EXIT')) { say('about to die'); setTimeout(() => process.exit(3), 20); return; }
  if (text.includes('SLOW')) {
    say('working');
    await new Promise<void>((resolve) => { cancelled = resolve; });
    return reply({ stopReason: 'cancelled' });
  }
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pensando' } });
  if (text.includes('ECHO')) { say(text); return finish(text); }
  if (text.includes('LISTMCP')) {
    const names = session.mcpLost ? '' : session.mcpServers.map((s) => s.name).join(',');
    say(`mcp=[${names}] model=${session.model} mode=${session.mode} effort=${session.config.reasoning_effort ?? ''}`);
    return finish(names);
  }
  if (text.includes('TOOLS')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-ok', title: 'read_file: notes.md', kind: 'read', status: 'pending', rawInput: { path: 'notes.md' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-ok', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'contenido' } }] });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-bad', title: 'Write `x.md`', kind: 'edit', status: 'in_progress', rawInput: { file_path: 'x.md' }, _meta: { 'x.ai/tool': { name: 'write' } } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-bad', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'disk full' } }] });
    say('listo');
    return finish('listo');
  }
  if (text.includes('OPENTOOL')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-open', title: 'mcp__latte__ping', kind: 'other' });
    say('pong');
    return finish('pong');
  }
  if (text.includes('PERMISSION')) {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-write', title: 'Write `perm.txt`', kind: 'edit', status: 'pending', rawInput: { file_path: 'perm.txt', content: 'ok' } });
    const options = flavor === 'hermes'
      ? [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow edit' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }]
      : [{ optionId: 'allow-edits-session', kind: 'allow_always', name: 'Yes, allow all edits during this session' }, { optionId: 'allow-once', kind: 'allow_once', name: 'Yes' }, { optionId: 'reject-once', kind: 'reject_once', name: 'No' }];
    const answer = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'tc-write', title: 'Write `perm.txt`', kind: 'edit', rawInput: { file_path: 'perm.txt', content: 'ok' } }, options });
    const result = (answer.result ?? {}) as { outcome?: { outcome?: string; optionId?: string } };
    const chosen = result.outcome?.outcome === 'selected' ? String(result.outcome.optionId) : String(result.outcome?.outcome ?? 'none');
    const allowed = chosen.startsWith('allow');
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-write', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'written' : 'denied' } }] });
    say(`permission=${chosen}`);
    return finish(`permission=${chosen}`);
  }
  if (text.includes('ASK')) {
    const answer = await ask('_x.ai/ask_user_question', { sessionId: sid, toolCallId: 'tc-ask', questions: [{ question: 'Which color?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cold' }], multiSelect: null }], mode: 'default' });
    const said = answer.error ? `error=${String((answer.error as Json).message)}` : `answer=${JSON.stringify(answer.result)}`;
    say(said);
    return finish(said);
  }
  const mcp = /MCP (\S+) (\S+) (\{.*\})/s.exec(text);
  if (mcp) {
    const result = await callMcp(session, mcp[1], mcp[2], JSON.parse(mcp[3]) as Json);
    update(sid, { sessionUpdate: 'tool_call', toolCallId: `tc-mcp-${Date.now()}`, title: `${mcp[1]}__${mcp[2]}`, kind: 'other', status: 'completed', rawOutput: result });
    say(`mcp=${JSON.stringify(result)}`);
    return finish(`mcp=${JSON.stringify(result)}`);
  }
  say('Hola');
  say(' desde el fake');
  return finish('Hola desde el fake');
}

/** Una tool MCP por streamable HTTP, con los headers que el cliente mandó en `mcpServers`. */
async function callMcp(session: Session, serverName: string, tool: string, args: Json): Promise<unknown> {
  if (session.mcpLost) return { error: 'tool not registered' };
  const server = session.mcpServers.find((s) => s.name === serverName);
  if (!server?.url) return { error: `no server ${serverName}` };
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const h of server.headers ?? []) headers[h.name] = h.value;
  const rpc = async (body: Json): Promise<Json> => {
    const res = await fetch(server.url as string, { method: 'POST', headers, body: JSON.stringify(body) });
    const sessionHeader = res.headers.get('mcp-session-id');
    if (sessionHeader) headers['mcp-session-id'] = sessionHeader;
    const raw = await res.text();
    if (!raw) return { status: res.status };
    const data = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    return { status: res.status, ...(JSON.parse(data) as Json) };
  };
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '0' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const called = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  log({ kind: 'mcp-call', server: serverName, tool, status: called.status });
  return called.result ?? called.error ?? { status: called.status };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message: Json;
  try { message = JSON.parse(line) as Json; } catch { return; }
  log({ kind: 'in', message });
  handle(message).catch((error: unknown) => log({ kind: 'error', error: String(error) }));
});
rl.on('close', () => process.exit(0));
