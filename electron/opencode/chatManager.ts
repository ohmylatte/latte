import type { ChildProcess, spawn } from 'node:child_process';
import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type ChatEvent, type ChatMessage, type ChatPart, type ChatRuntimeStatus, type ChatSession, type ChatUsage, type PermissionReply, type ProviderAuthMethod, type ProviderInfo, type ProviderOAuthStart } from '../../shared/contracts';
import { forgetServerPid, recordServerPid } from '../agents/codex/staleServers';
import { opencodeVariantFor } from '../agents/tiers';
import { MAX_OPENCODE_SERVERS_TOTAL } from '../coordination/limits';
import { sessionFrom, type AdapterMcpServer, type AdapterStartInput, type AdapterStartResult, type RuntimeAdapter } from '../agents/types';
import { NotFoundError, UnavailableError, ValidationError } from '../core/errors';
import { newId } from '../core/ids';
import { addUsage, tokenCount } from '../core/usage';
import { OpenCodeClient, OpenCodeHttpError } from './client';
import { opencodeMcpEnv } from './mcpConfig';
import { OpenCodeServer, type OpenCodeEndpoint } from './server';
import { describeMessageError, translateMessage, translatePart, translatePermission, translateQuestion, translateStatus } from './translate';
import {
  isRecord,
  str,
  type OcAuthMethod,
  type OcGlobalEvent,
  type OcMessage,
  type OcOAuthAuthorization,
  type OcPart,
  type OcPermissionRequest,
  type OcProvidersResponse,
  type OcQuestionRequest,
  type OcSessionStatus,
} from './wire';

export interface ChatManagerDeps {
  /** Resolves the opencode executable, or null when not installed. */
  resolveExecutable: () => Promise<{ executable: string; version: string | null } | null>;
  /** Neutral working directory for the server process (the Latte data root). */
  serverCwd: string;
  emit: (event: ChatEvent) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  clientTimeoutMs?: number;
  startupTimeoutMs?: number;
  log?: (line: string) => void;
  /** Injectable process launcher for bounded tests. */
  spawnImpl?: typeof spawn;
  /** Tests: kills a server's process tree instead of `killProcessTree`. */
  killProcess?: (child: ChildProcess) => void;
  /**
   * Tests: talk to an already running (fake) server instead of spawning one.
   * Every chat then shares that single endpoint, so nothing per member (env,
   * MCP config) can reach it: this mode exists for protocol tests only.
   */
  endpoint?: OpenCodeEndpoint;
  /** Open chats = member processes. Defaults to `MAX_OPENCODE_SERVERS_TOTAL`. */
  maxChats?: number;
}

export type StartChatInput = Omit<AdapterStartInput, 'label'> & { label?: string };
export type StartChatResult = AdapterStartResult;

interface LiveChat {
  session: ChatSession;
  /** Which server process this chat lives on (`memberKey(chatId)`, or the shared test endpoint). */
  runtimeKey: string;
  ocSessionId: string;
  directory: string;
  model: { providerID: string; modelID: string } | null;
  /** Role personality sent as the system prompt of every turn (OpenCode has no per-session prompt). */
  system: string | null;
  busy: boolean;
  messages: Map<string, ChatMessage>;
  order: string[];
  /** Permission / question request ids currently waiting on this chat. */
  pendingPermissions: Set<string>;
  pendingQuestions: Set<string>;
  /** Reasoning effort sent with every prompt; null when the tier maps to nothing the server takes. */
  variant: string | null;
  /** What this chat has consumed since it opened; the lifetime total is the hub's job. */
  usage: ChatUsage;
  /** Assistant messages already counted. `message.updated` repeats, a turn does not. */
  usageSeen: Set<string>;
}

/** One `opencode serve` process (or the shared test endpoint) and its event stream. */
interface ServerRuntime {
  key: string;
  /** `null` only for `deps.endpoint`, which Latte did not start and must not stop. */
  server: OpenCodeServer | null;
  client: OpenCodeClient;
  stream: { abort: AbortController; task: Promise<void> } | null;
}

const MESSAGE_LIMIT = 400;
/** The provider-management process: no MCP, no member env, never counted as a member. */
const CONTROL_KEY = 'control';
/** `deps.endpoint`: the one server every chat shares in protocol tests. */
const SHARED_KEY = 'shared';

function memberKey(chatId: string): string {
  return `member:${chatId}`;
}

/** The pid-file key in Latte's stray-process directory (reaped at startup). */
function strayKey(runtimeKey: string): string {
  return `opencode|${runtimeKey}`;
}

/**
 * Native chat on top of the OpenCode server protocol.
 *
 * ONE SERVER PROCESS PER MEMBER. `OPENCODE_CONFIG_CONTENT` (the inline config
 * that carries the MCP servers) is read from the PROCESS environment, and the
 * bearer of each MCP server is per member: a shared process would hand one
 * member's scope to every other. So each chat gets its own `opencode serve`
 * with its own ephemeral port, Basic credentials, env and SSE stream; closing
 * the chat kills it, reopening starts another and resumes the OpenCode session
 * from the runtime's own store on disk (shared by every process of the user).
 * Provider management (keys, OAuth) runs on a separate lazy process, because
 * an OAuth login must start and finish on the same one.
 *
 * PARIDAD CON CLAUDE CODE Y CODEX (verificada con `tests/backend/opencode-parity.test.ts`
 * y, donde dice, contra opencode 1.18.32 real):
 *  - Inyección MCP por miembro y confirmación por `GET /mcp`: a la par.
 *  - Preguntas (`question.asked` → la misma QuestionCard), pausa/reanudar
 *    (proceso nuevo, sesión reanudada del store de OpenCode con su historia),
 *    consumo por mensaje y un run de coordinación completo: a la par.
 *  - Permisos: NO a la par con Claude, sí parecido a Codex. El agente `build`
 *    de OpenCode trae `{"permission":"*","action":"allow"}` y sólo pregunta por
 *    `external_directory` y `doom_loop` (medido en `GET /agent`): editar o
 *    correr comandos DENTRO de la carpeta del trabajo no pide permiso, y
 *    `trustedFolder` no cambia nada acá. Lo que sí pide llega como tarjeta de
 *    permiso igual que en los otros runtimes. Latte no escribe `permission` en
 *    el config inline a propósito: cambiar lo que OpenCode deja hacer por
 *    defecto es una decisión de producto, no de paridad.
 *  - Historial de un miembro PAUSADO: vive en el runtime, así que
 *    `recentMessages` responde `exposed:false` sin levantar un proceso (Claude
 *    tiene transcripto propio de Latte; Codex tampoco lo tiene).
 *  - Proveedores: una clave conectada mientras hay miembros abiertos se guarda
 *    en el store de OpenCode por el proceso de proveedores; que un proceso de
 *    miembro YA abierto la vea sin reabrirse no está verificado.
 *  - Esfuerzo: el tier viaja como `variant` por prompt; el modelo no sale del
 *    tier (ver `agents/tiers.ts`).
 */
export class ChatManager implements RuntimeAdapter {
  readonly runtime = 'opencode' as const;
  // Un proceso por miembro: el config inline (`OPENCODE_CONFIG_CONTENT`) y los
  // bearers viajan en el entorno de SU proceso y de ningún otro.
  readonly mcpInjection = 'per-member' as const;
  // `GET /mcp` devuelve el estado de cada servidor MCP de ESE proceso
  // (verificado contra opencode 1.18.32), así que el runtime sí puede decir
  // qué levantó. Ver `reportInjected`.
  readonly confirmsMcpInjection = true;
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** Runtime key -> launch in flight, so two callers never spawn two processes for one key. */
  private readonly launching = new Map<string, Promise<ServerRuntime>>();
  private readonly chats = new Map<string, LiveChat>();
  private readonly byOcSession = new Map<string, string>();
  /** Chats still opening: they count against the cap before their process exists. */
  private readonly starting = new Set<string>();
  private closed = false;
  private readonly maxChats: number;

  constructor(private readonly deps: ChatManagerDeps) {
    this.maxChats = deps.maxChats ?? MAX_OPENCODE_SERVERS_TOTAL;
  }

  /** Live member processes (the provider process is not a member and is not counted). */
  processCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.key !== CONTROL_KEY && runtime.server?.running) count += 1;
    }
    return count;
  }

  // Status ------------------------------------------------------------------

  /** Detects OpenCode without starting its server or loading providers. */
  async status(): Promise<ChatRuntimeStatus> {
    const runtime = await this.deps.resolveExecutable();
    if (!runtime && !this.deps.endpoint) {
      return { available: false, detail: 'OpenCode is not installed or not on PATH. Install it to use the native chat.', version: null, models: [], defaultModel: null };
    }
    const version = runtime?.version ?? null;
    return { available: true, detail: `OpenCode${version ? ` ${version}` : ''} detected. It will start when a chat or provider action is used.`, version, models: [], defaultModel: null };
  }

  // Providers ---------------------------------------------------------------
  // Latte is the UI for the runtime's credential store: keys and tokens go
  // straight to OpenCode over loopback and are never written by Latte.

  async listProviders(): Promise<ProviderInfo[]> {
    const client = await this.ensureClient();
    const [catalog, methods] = await Promise.all([
      client.providerCatalog(this.deps.serverCwd),
      client.providerAuthMethods(this.deps.serverCwd).catch(() => ({} as Record<string, OcAuthMethod[]>)),
    ]);
    const connected = new Set(Array.isArray(catalog?.connected) ? catalog.connected.filter((id) => typeof id === 'string') : []);
    const all = Array.isArray(catalog?.all) ? catalog.all : [];
    const providers: ProviderInfo[] = all
      .filter((p) => isRecord(p) && typeof p.id === 'string')
      .map((p) => ({
        id: p.id,
        name: str(p.name, p.id),
        connected: connected.has(p.id),
        models: isRecord(p.models) ? Object.keys(p.models).sort() : [],
        methods: translateAuthMethods(methods[p.id]),
      }));
    providers.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
    return providers;
  }

  async connectApiKey(providerId: string, key: string): Promise<void> {
    const client = await this.ensureClient();
    try {
      await client.setApiKey(providerId, this.deps.serverCwd, key);
    } catch (error) {
      throw new UnavailableError(`Could not store the API key for ${providerId}: ${describe(error)}`);
    }
  }

  async disconnectProvider(providerId: string): Promise<void> {
    const client = await this.ensureClient();
    try {
      await client.removeAuth(providerId, this.deps.serverCwd);
    } catch (error) {
      throw new UnavailableError(`Could not disconnect ${providerId}: ${describe(error)}`);
    }
  }

  async startOAuth(providerId: string, methodIndex: number, inputs: Record<string, string>): Promise<ProviderOAuthStart> {
    const client = await this.ensureClient();
    let result: OcOAuthAuthorization;
    try {
      result = await client.oauthAuthorize(providerId, this.deps.serverCwd, methodIndex, inputs);
    } catch (error) {
      throw new UnavailableError(`Could not start the login for ${providerId}: ${describe(error)}`);
    }
    if (!isRecord(result) || typeof result.url !== 'string') throw new UnavailableError(`${providerId} returned no login URL`);
    return { url: result.url, method: result.method === 'code' ? 'code' : 'auto', instructions: str(result.instructions) };
  }

  async completeOAuth(providerId: string, methodIndex: number, code: string | null): Promise<void> {
    const client = await this.ensureClient();
    try {
      await client.oauthCallback(providerId, this.deps.serverCwd, methodIndex, code);
    } catch (error) {
      throw new UnavailableError(`Could not complete the login for ${providerId}: ${describe(error)}`);
    }
  }

  // Lifecycle ---------------------------------------------------------------

  async start(input: StartChatInput): Promise<StartChatResult> {
    if (this.closed) throw new UnavailableError('Chat manager is shut down');
    // The chats still opening count too: N simultaneous opens would otherwise
    // all read the same size and all pass, one process each.
    if (this.chats.size + this.starting.size >= this.maxChats) throw new ValidationError(`Too many open chats (max ${this.maxChats})`);
    const chatId = input.chatId ?? newId('ses');
    if (this.chats.has(chatId) || this.starting.has(chatId)) throw new ValidationError('This chat is already open');
    this.starting.add(chatId);
    const key = this.deps.endpoint ? SHARED_KEY : memberKey(chatId);
    try {
      // The member's own env and its MCP servers ride on ITS process only.
      const env = { ...(input.extraEnv ?? {}), ...opencodeMcpEnv(input.mcpServers ?? []) };
      const runtime = await this.ensureRuntime(key, env);
      return await this.startOn(runtime, chatId, input);
    } catch (error) {
      if (!this.chats.has(chatId)) this.releaseRuntimeIfUnused(key);
      throw error;
    } finally {
      this.starting.delete(chatId);
    }
  }

  private async startOn(runtime: ServerRuntime, chatId: string, input: StartChatInput): Promise<StartChatResult> {
    const client = runtime.client;
    let ocSessionId: string | null = null;
    let resumed = false;
    if (input.previousSessionId) {
      try {
        const existing = await client.getSession(input.previousSessionId, input.directory);
        if (existing && typeof existing.id === 'string') {
          ocSessionId = existing.id;
          resumed = true;
        }
      } catch (error) {
        if (!(error instanceof OpenCodeHttpError) || (error.status !== 404 && error.status !== 400)) {
          throw new UnavailableError(`OpenCode session lookup failed: ${describe(error)}`);
        }
      }
    }
    if (!ocSessionId) {
      try {
        const created = await client.createSession(input.directory, input.title);
        if (!created || typeof created.id !== 'string') throw new Error('server returned no session id');
        ocSessionId = created.id;
      } catch (error) {
        throw new UnavailableError(`Could not create an OpenCode session: ${describe(error)}`);
      }
    }

    let summary: { models: string[]; defaultModel: string | null } = { models: [], defaultModel: null };
    let providers: OcProvidersResponse | null = null;
    try {
      providers = await client.providers(input.directory);
      summary = summariseProviders(providers);
    } catch {
      summary = { models: [], defaultModel: null };
    }
    let model: { providerID: string; modelID: string } | null = null;
    if (input.model) {
      if (summary.models.length > 0 && !summary.models.includes(input.model)) {
        throw new ValidationError(`Model ${input.model} is not configured in OpenCode`);
      }
      const slash = input.model.indexOf('/');
      if (slash <= 0 || slash === input.model.length - 1) throw new ValidationError('Model must look like providerID/modelID');
      model = { providerID: input.model.slice(0, slash), modelID: input.model.slice(slash + 1) };
    }

    const chosenModel = input.model ?? summary.defaultModel;
    const label = input.label ?? `OpenCode · ${chosenModel ?? 'modelo por defecto'}`;
    const session: ChatSession = { ...sessionFrom({ ...input, label }, 'opencode', chosenModel, null, label, resumed), id: chatId };
    const instructions = input.instructions?.trim() ?? '';
    const live: LiveChat = { session, runtimeKey: runtime.key, ocSessionId, directory: input.directory, model, system: instructions || null, busy: false, messages: new Map(), order: [], pendingPermissions: new Set(), pendingQuestions: new Set(), variant: opencodeVariantFor(input.tier ?? DEFAULT_EFFORT_TIER, modelVariants(providers, chosenModel)), usage: EMPTY_USAGE, usageSeen: new Set() };
    this.chats.set(session.id, live);
    this.byOcSession.set(ocSessionId, session.id);

    if (resumed) {
      try {
        const history = await client.messages(ocSessionId, input.directory);
        for (const entry of history) {
          if (!entry || !isRecord(entry.info) || typeof entry.info.id !== 'string') continue;
          this.upsertMessage(live, translateMessage(session.id, entry.info as OcMessage, Array.isArray(entry.parts) ? entry.parts : []));
        }
      } catch (error) {
        this.deps.log?.(`[chat] history load failed: ${describe(error)}`);
      }
      // Surface anything still waiting for an answer.
      try {
        for (const request of await client.pendingPermissions(input.directory)) {
          if (request.sessionID !== ocSessionId) continue;
          live.pendingPermissions.add(request.id);
          this.deps.emit({ chatId: session.id, type: 'permission', request: translatePermission(request) });
        }
      } catch { /* optional */ }
    }

    this.ensureStream(runtime);
    const requested = input.mcpServers ?? [];
    // El endpoint compartido de las pruebas no es un proceso de este miembro:
    // su config no la escribió Latte y no puede llevar la de nadie. Es una
    // negativa de LATTE (D7c), no algo que el runtime haya dicho.
    if (runtime.server === null && requested.length > 0) {
      this.deps.log?.(`[chat ${chatId}] MCP not injected: this OpenCode endpoint is shared, not the member's own process`);
      return { session, runtimeSessionId: ocSessionId, injectionRefusedByLatte: true };
    }
    return { session, runtimeSessionId: ocSessionId, injectedMcpServers: await this.reportInjected(client, input.directory, requested) };
  }

  /**
   * Lo que este proceso CONECTÓ, según él (`GET /mcp`), nunca lo que Latte le
   * pidió. Las mismas dos reglas que Codex:
   *
   * 1. Sin nada pedido, o si no se puede preguntar (un OpenCode sin ese
   *    endpoint, un timeout), la respuesta es `undefined`: NO SÉ. Un array
   *    —aunque sea vacío— es "el runtime habló" y prende `runtimeConfirmed`.
   * 2. Estar en la lista no es estar conectado: sólo cuenta `connected`
   *    (allowlist). `failed`, `needs_auth`, `disabled` o un estado que
   *    OpenCode agregue mañana caen del lado seguro.
   *
   * Un OpenCode viejo que ignore el config inline no lista nuestros servidores:
   * eso degrada el reclamo con `runtime_refused_injection`, que es la verdad,
   * sin tener que adivinar un piso de versión.
   */
  private async reportInjected(client: OpenCodeClient, directory: string, requested: AdapterMcpServer[]): Promise<string[] | undefined> {
    if (requested.length === 0) return undefined;
    let status: Record<string, unknown>;
    try {
      status = await client.mcpStatus(directory);
    } catch (error) {
      this.deps.log?.(`[chat] could not read OpenCode MCP status: ${describe(error)}`);
      return undefined;
    }
    if (!isRecord(status)) return undefined;
    return requested
      .map((server) => server.name)
      .filter((name) => {
        const entry = status[name];
        return isRecord(entry) && entry.status === 'connected';
      });
  }

  owns(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  isBusy(chatId: string): boolean {
    return this.chats.get(chatId)?.busy ?? false;
  }

  listMessages(chatId: string): ChatMessage[] {
    const live = this.require(chatId);
    return live.order.map((id) => live.messages.get(id)).filter((m): m is ChatMessage => m !== undefined);
  }

  async send(chatId: string, text: string): Promise<void> {
    const live = this.require(chatId);
    const client = this.clientFor(live);
    try {
      await client.promptAsync(live.ocSessionId, live.directory, text, live.model, live.system, live.variant);
      live.busy = true;
    } catch (error) {
      throw new UnavailableError(`Could not send the message: ${describe(error)}`);
    }
  }

  async abort(chatId: string): Promise<void> {
    const live = this.require(chatId);
    try {
      await this.clientFor(live).abort(live.ocSessionId, live.directory);
    } catch (error) {
      throw new UnavailableError(`Could not abort: ${describe(error)}`);
    }
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const live = this.require(chatId);
    if (!live.pendingPermissions.has(requestId)) throw new NotFoundError('Permission request', requestId);
    try {
      await this.clientFor(live).replyPermission(requestId, live.directory, reply);
      live.pendingPermissions.delete(requestId);
    } catch (error) {
      throw new UnavailableError(`Could not answer the permission request: ${describe(error)}`);
    }
  }

  async replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    const live = this.require(chatId);
    if (!live.pendingQuestions.has(requestId)) throw new NotFoundError('Question', requestId);
    try {
      if (answers === null) await this.clientFor(live).rejectQuestion(requestId, live.directory);
      else await this.clientFor(live).replyQuestion(requestId, live.directory, answers);
      live.pendingQuestions.delete(requestId);
    } catch (error) {
      throw new UnavailableError(`Could not answer the question: ${describe(error)}`);
    }
  }

  /**
   * Closes the chat and kills ITS server process; no other member's process is
   * touched. The OpenCode session stays in the runtime's store on disk, so a
   * later `start` with `previousSessionId` resumes it on a fresh process.
   */
  stop(chatId: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.chats.delete(chatId);
    if (this.byOcSession.get(live.ocSessionId) === chatId) this.byOcSession.delete(live.ocSessionId);
    this.deps.emit({ chatId, type: 'closed', reason: 'stopped' });
    this.releaseRuntimeIfUnused(live.runtimeKey);
  }

  list(): ChatSession[] {
    return [...this.chats.values()].map((c) => c.session);
  }

  shutdown(): void {
    this.closed = true;
    for (const id of [...this.chats.keys()]) this.stop(id);
    for (const key of [...this.runtimes.keys()]) this.stopRuntime(key);
  }

  // Internals ---------------------------------------------------------------

  /** Provider management runs on its own process (see `CONTROL_KEY`). */
  private async ensureClient(): Promise<OpenCodeClient> {
    return (await this.ensureRuntime(this.deps.endpoint ? SHARED_KEY : CONTROL_KEY, {})).client;
  }

  private async ensureRuntime(key: string, env: Record<string, string>): Promise<ServerRuntime> {
    const existing = this.runtimes.get(key);
    if (existing && (existing.server === null || existing.server.running)) return existing;
    const inFlight = this.launching.get(key);
    if (inFlight) return inFlight;
    const launch = this.launchRuntime(key, env).finally(() => {
      if (this.launching.get(key) === launch) this.launching.delete(key);
    });
    this.launching.set(key, launch);
    return launch;
  }

  private async launchRuntime(key: string, env: Record<string, string>): Promise<ServerRuntime> {
    if (this.deps.endpoint) {
      const runtime: ServerRuntime = { key, server: null, client: this.newClient(this.deps.endpoint), stream: null };
      this.runtimes.set(key, runtime);
      return runtime;
    }
    const found = await this.deps.resolveExecutable();
    if (!found) throw new UnavailableError('OpenCode is not installed or not on PATH');
    // The pid is recorded in Latte's stray-process directory (the one the
    // startup sweep reaps, shared with Codex): N processes instead of one make
    // an orphan after a crash N times likelier.
    const pidKey = strayKey(key);
    const server = new OpenCodeServer({
      executable: found.executable,
      cwd: this.deps.serverCwd,
      env: this.deps.env,
      extraEnv: env,
      platform: this.deps.platform,
      startupTimeoutMs: this.deps.startupTimeoutMs,
      log: this.deps.log,
      spawnImpl: this.deps.spawnImpl,
      killProcess: this.deps.killProcess,
      onSpawn: (pid) => recordServerPid(this.deps.serverCwd, pidKey, pid),
    });
    let endpoint: OpenCodeEndpoint;
    try {
      endpoint = await server.ensure();
    } catch (error) {
      server.stop();
      forgetServerPid(this.deps.serverCwd, pidKey);
      throw new UnavailableError(describe(error));
    }
    if (this.closed) {
      server.stop();
      forgetServerPid(this.deps.serverCwd, pidKey);
      throw new UnavailableError('Chat manager is shut down');
    }
    const runtime: ServerRuntime = { key, server, client: this.newClient(endpoint), stream: null };
    server.onExit = (reason) => this.onServerExit(runtime, reason);
    this.runtimes.set(key, runtime);
    return runtime;
  }

  private newClient(endpoint: OpenCodeEndpoint): OpenCodeClient {
    return new OpenCodeClient(endpoint, { timeoutMs: this.deps.clientTimeoutMs, fetchImpl: this.deps.fetchImpl });
  }

  /** A process died on its own: the chats that lived on it close with the reason, nobody else's. */
  private onServerExit(runtime: ServerRuntime, reason: string): void {
    if (this.runtimes.get(runtime.key) !== runtime) return;
    this.runtimes.delete(runtime.key);
    runtime.stream?.abort.abort();
    runtime.stream = null;
    forgetServerPid(this.deps.serverCwd, strayKey(runtime.key));
    for (const live of [...this.chats.values()].filter((c) => c.runtimeKey === runtime.key)) {
      if (live.busy) this.deps.emit({ chatId: live.session.id, type: 'error', message: reason });
      this.chats.delete(live.session.id);
      if (this.byOcSession.get(live.ocSessionId) === live.session.id) this.byOcSession.delete(live.ocSessionId);
      this.deps.emit({ chatId: live.session.id, type: 'closed', reason });
    }
  }

  /** Kills a member's process once no chat lives on it; the shared test endpoint only loses its stream. */
  private releaseRuntimeIfUnused(key: string): void {
    if (key === CONTROL_KEY || this.hasChatsOn(key)) return;
    if (key === SHARED_KEY) {
      const runtime = this.runtimes.get(key);
      if (runtime?.stream) {
        runtime.stream.abort.abort();
        runtime.stream = null;
      }
      return;
    }
    this.stopRuntime(key);
  }

  private stopRuntime(key: string): void {
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    this.runtimes.delete(key);
    runtime.stream?.abort.abort();
    runtime.stream = null;
    if (runtime.server) {
      runtime.server.onExit = null;
      runtime.server.stop();
      forgetServerPid(this.deps.serverCwd, strayKey(key));
    }
  }

  private clientFor(live: LiveChat): OpenCodeClient {
    const runtime = this.runtimes.get(live.runtimeKey);
    if (!runtime) throw new UnavailableError('OpenCode runtime is not running');
    return runtime.client;
  }

  private require(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new NotFoundError('Chat', chatId);
    return live;
  }

  private hasChatsOn(key: string): boolean {
    for (const chat of this.chats.values()) if (chat.runtimeKey === key) return true;
    return false;
  }

  private ensureStream(runtime: ServerRuntime): void {
    if (runtime.stream || this.closed) return;
    const abort = new AbortController();
    const stream = { abort, task: Promise.resolve() };
    stream.task = this.runStream(runtime, abort.signal).finally(() => {
      if (runtime.stream === stream) runtime.stream = null;
    });
    runtime.stream = stream;
  }

  private async runStream(runtime: ServerRuntime, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !this.closed) {
      try {
        await runtime.client.globalEvents((event) => this.handleEvent(runtime.key, event), signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log?.(`[chat] event stream dropped: ${describe(error)}`);
      }
      if (signal.aborted || !this.hasChatsOn(runtime.key)) return;
      attempt += 1;
      if (attempt > 20) {
        for (const chat of this.chats.values()) {
          if (chat.runtimeKey !== runtime.key) continue;
          this.deps.emit({ chatId: chat.session.id, type: 'error', message: 'Lost the connection to the OpenCode runtime.' });
        }
        return;
      }
      await sleep(Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)), signal);
    }
  }

  private handleEvent(runtimeKey: string, event: OcGlobalEvent): void {
    const payload = event.payload;
    const props = isRecord(payload.properties) ? payload.properties : {};
    const ocSessionId = str(props.sessionID) || (isRecord(props.info) ? str(props.info.sessionID) : '') || (isRecord(props.part) ? str(props.part.sessionID) : '');
    const chatId = ocSessionId ? this.byOcSession.get(ocSessionId) : undefined;
    if (!chatId) return;
    const live = this.chats.get(chatId);
    // Only the process a chat lives on speaks for it.
    if (!live || live.runtimeKey !== runtimeKey) return;

    switch (payload.type) {
      case 'message.updated': {
        if (!isRecord(props.info) || typeof props.info.id !== 'string') return;
        const existing = live.messages.get(props.info.id);
        const translated = translateMessage(chatId, props.info as unknown as OcMessage, []);
        if (existing) translated.parts = existing.parts;
        this.upsertMessage(live, translated);
        this.deps.emit({ chatId, type: 'message', message: translated });
        this.reportUsage(live, props.info);
        return;
      }
      case 'message.part.updated': {
        if (!isRecord(props.part)) return;
        const part = translatePart(props.part as unknown as OcPart);
        if (!part) return;
        const messageId = str(props.part.messageID);
        this.upsertPart(live, messageId, part);
        this.deps.emit({ chatId, type: 'part', messageId, part });
        return;
      }
      case 'message.part.delta': {
        if (str(props.field) !== 'text') return;
        const messageId = str(props.messageID);
        const partId = str(props.partID);
        const delta = str(props.delta);
        if (!messageId || !partId || delta.length === 0) return;
        this.applyDelta(live, messageId, partId, delta);
        this.deps.emit({ chatId, type: 'delta', messageId, partId, delta });
        return;
      }
      case 'session.status': {
        const { status, detail } = translateStatus(props.status as OcSessionStatus | undefined);
        live.busy = status !== 'idle';
        this.deps.emit({ chatId, type: 'status', status, detail });
        return;
      }
      case 'session.idle':
        live.busy = false;
        this.deps.emit({ chatId, type: 'status', status: 'idle', detail: '' });
        return;
      case 'session.error':
        live.busy = false;
        this.deps.emit({ chatId, type: 'error', message: describeMessageError(props.error) });
        return;
      case 'permission.asked': {
        const request = translatePermission(props as unknown as OcPermissionRequest);
        live.pendingPermissions.add(request.id);
        this.deps.emit({ chatId, type: 'permission', request });
        return;
      }
      case 'permission.replied':
        live.pendingPermissions.delete(str(props.requestID));
        this.deps.emit({ chatId, type: 'permission-resolved', requestId: str(props.requestID) });
        return;
      case 'question.asked': {
        const request = translateQuestion(props as unknown as OcQuestionRequest);
        live.pendingQuestions.add(request.id);
        this.deps.emit({ chatId, type: 'question', request });
        return;
      }
      case 'question.replied':
      case 'question.rejected':
        live.pendingQuestions.delete(str(props.requestID));
        this.deps.emit({ chatId, type: 'question-resolved', requestId: str(props.requestID) });
        return;
      default:
        return;
    }
  }

  /**
   * What an assistant message consumed, as the server counted it.
   *
   * The numbers only settle when the message is finished, and
   * `message.updated` fires several times per message, so the count is taken
   * once, on the first finished copy.
   *
   * One assistant message is ONE model call (measured on 1.18.32: a turn with
   * a tool is two messages), so `contextTokens` from each message is already
   * "the last call" (N3), never a sum across the turn.
   *
   * `reasoning` is NOT inside `output`: the server's own `total` is
   * input + output + reasoning + cache.read + cache.write (measured:
   * 21318 = 19103 + 108 + 179 + 1928). What the model generated is output plus
   * reasoning; counting `output` alone hid most of a thinking model's work.
   */
  private reportUsage(live: LiveChat, info: Record<string, unknown>): void {
    const id = typeof info.id === 'string' ? info.id : '';
    if (!id || info.role !== 'assistant' || live.usageSeen.has(id)) return;
    const time = isRecord(info.time) ? info.time : null;
    if (!time || typeof time.completed !== 'number') return;
    const tokens = isRecord(info.tokens) ? info.tokens : null;
    if (!tokens) return;
    live.usageSeen.add(id);
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const inputTokens = tokenCount(tokens.input);
    const cacheReadTokens = tokenCount(cache.read);
    const cacheWriteTokens = tokenCount(cache.write);
    const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost > 0 ? info.cost : null;
    const turn: ChatUsage = {
      inputTokens,
      outputTokens: tokenCount(tokens.output) + tokenCount(tokens.reasoning),
      cacheReadTokens,
      cacheWriteTokens,
      turns: 1,
      costUsd: cost,
      contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    };
    live.usage = addUsage(live.usage, turn);
    this.deps.emit({ chatId: live.session.id, type: 'usage', turn, total: live.usage });
  }

  private upsertMessage(live: LiveChat, message: ChatMessage): void {
    if (!live.messages.has(message.id)) {
      live.order.push(message.id);
      if (live.order.length > MESSAGE_LIMIT) {
        const dropped = live.order.shift();
        if (dropped) live.messages.delete(dropped);
      }
    }
    live.messages.set(message.id, message);
  }

  private upsertPart(live: LiveChat, messageId: string, part: ChatPart): void {
    let message = live.messages.get(messageId);
    if (!message) {
      message = { id: messageId, chatId: live.session.id, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null };
      this.upsertMessage(live, message);
    }
    const index = message.parts.findIndex((p) => p.id === part.id);
    if (index === -1) message.parts.push(part);
    else message.parts[index] = part;
  }

  private applyDelta(live: LiveChat, messageId: string, partId: string, delta: string): void {
    let message = live.messages.get(messageId);
    if (!message) {
      message = { id: messageId, chatId: live.session.id, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null };
      this.upsertMessage(live, message);
    }
    const part = message.parts.find((p) => p.id === partId);
    if (part && (part.type === 'text' || part.type === 'reasoning')) part.text += delta;
    else if (!part) message.parts.push({ type: 'text', id: partId, text: delta });
  }
}

export function translateAuthMethods(methods: OcAuthMethod[] | undefined): ProviderAuthMethod[] {
  if (!Array.isArray(methods)) return [];
  return methods
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => isRecord(m) && (m.type === 'oauth' || m.type === 'api'))
    .map(({ m, index }) => ({
      index,
      type: m.type,
      label: str(m.label, m.type === 'oauth' ? 'Sign in' : 'API key'),
      prompts: (Array.isArray(m.prompts) ? m.prompts : []).filter(isRecord).map((p) => ({
        key: str(p.key),
        type: p.type === 'select' ? 'select' as const : 'text' as const,
        message: str(p.message),
        placeholder: str(p.placeholder),
        options: (Array.isArray(p.options) ? p.options : []).filter(isRecord).map((o) => ({ label: str(o.label), value: str(o.value), hint: str(o.hint) })),
      })),
    }));
}

/**
 * The effort variants a model offers (`models[id].variants`), or `null` when
 * the catalog could not say: no catalog, an unknown model, or a server that
 * does not publish variants at all. `[]` is a real answer ("no knob").
 */
export function modelVariants(response: OcProvidersResponse | null | undefined, model: string | null): string[] | null {
  if (!response || !model || !Array.isArray(response.providers)) return null;
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  const provider = response.providers.find((p) => isRecord(p) && p.id === model.slice(0, slash));
  if (!provider || !isRecord(provider.models)) return null;
  const entry = provider.models[model.slice(slash + 1)];
  if (!isRecord(entry) || !isRecord(entry.variants)) return null;
  return Object.keys(entry.variants);
}

export function summariseProviders(response: OcProvidersResponse | null | undefined): { models: string[]; defaultModel: string | null } {
  if (!response || !Array.isArray(response.providers)) return { models: [], defaultModel: null };
  const models: string[] = [];
  for (const provider of response.providers) {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !isRecord(provider.models)) continue;
    for (const modelId of Object.keys(provider.models)) models.push(`${provider.id}/${modelId}`);
  }
  let defaultModel: string | null = null;
  if (isRecord(response.default)) {
    const first = Object.entries(response.default).find(([providerId, modelId]) => typeof modelId === 'string' && models.includes(`${providerId}/${modelId}`));
    if (first) defaultModel = `${first[0]}/${first[1]}`;
  }
  if (!defaultModel && models.length > 0) defaultModel = models[0];
  return { models, defaultModel };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
