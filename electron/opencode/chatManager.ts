import type { spawn } from 'node:child_process';
import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type ChatEvent, type ChatMessage, type ChatPart, type ChatRuntimeStatus, type ChatSession, type ChatUsage, type PermissionReply, type ProviderAuthMethod, type ProviderInfo, type ProviderOAuthStart } from '../../shared/contracts';
import { opencodeVariantForTier } from '../agents/tiers';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult, type RuntimeAdapter } from '../agents/types';
import { NotFoundError, UnavailableError, ValidationError } from '../core/errors';
import { newId } from '../core/ids';
import { addUsage, tokenCount } from '../core/usage';
import { OpenCodeClient, OpenCodeHttpError } from './client';
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
  /** Tests: talk to an already running (fake) server instead of spawning one. */
  endpoint?: OpenCodeEndpoint;
  maxChats?: number;
}

export type StartChatInput = Omit<AdapterStartInput, 'label'> & { label?: string };
export type StartChatResult = AdapterStartResult;

interface LiveChat {
  session: ChatSession;
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

const MESSAGE_LIMIT = 400;

/**
 * Native chat on top of the OpenCode server protocol. One server process,
 * one global SSE subscription, one OpenCode session per Latte work.
 */
export class ChatManager implements RuntimeAdapter {
  readonly runtime = 'opencode' as const;
  private server: OpenCodeServer | null = null;
  private client: OpenCodeClient | null = null;
  private endpoint: OpenCodeEndpoint | null = null;
  private readonly chats = new Map<string, LiveChat>();
  private readonly byOcSession = new Map<string, string>();
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private closed = false;
  private readonly maxChats: number;

  constructor(private readonly deps: ChatManagerDeps) {
    this.maxChats = deps.maxChats ?? 16;
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
    if (this.chats.size >= this.maxChats) throw new ValidationError(`Too many open chats (max ${this.maxChats})`);
    const chatId = input.chatId ?? newId('ses');
    if (this.chats.has(chatId)) throw new ValidationError('This chat is already open');
    const client = await this.ensureClient();

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
    try {
      summary = summariseProviders(await client.providers(input.directory));
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
    const live: LiveChat = { session, ocSessionId, directory: input.directory, model, system: instructions || null, busy: false, messages: new Map(), order: [], pendingPermissions: new Set(), pendingQuestions: new Set(), variant: opencodeVariantForTier(input.tier ?? DEFAULT_EFFORT_TIER), usage: EMPTY_USAGE, usageSeen: new Set() };
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

    this.ensureStream();
    return { session, runtimeSessionId: ocSessionId };
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
    const client = this.requireClient();
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
      await this.requireClient().abort(live.ocSessionId, live.directory);
    } catch (error) {
      throw new UnavailableError(`Could not abort: ${describe(error)}`);
    }
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const live = this.require(chatId);
    if (!live.pendingPermissions.has(requestId)) throw new NotFoundError('Permission request', requestId);
    try {
      await this.requireClient().replyPermission(requestId, live.directory, reply);
      live.pendingPermissions.delete(requestId);
    } catch (error) {
      throw new UnavailableError(`Could not answer the permission request: ${describe(error)}`);
    }
  }

  async replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    const live = this.require(chatId);
    if (!live.pendingQuestions.has(requestId)) throw new NotFoundError('Question', requestId);
    try {
      if (answers === null) await this.requireClient().rejectQuestion(requestId, live.directory);
      else await this.requireClient().replyQuestion(requestId, live.directory, answers);
      live.pendingQuestions.delete(requestId);
    } catch (error) {
      throw new UnavailableError(`Could not answer the question: ${describe(error)}`);
    }
  }

  /** Detaches the chat. The OpenCode session stays on disk so it can be resumed later. */
  stop(chatId: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.chats.delete(chatId);
    this.byOcSession.delete(live.ocSessionId);
    this.deps.emit({ chatId, type: 'closed', reason: 'stopped' });
    if (this.chats.size === 0) this.stopStream();
  }

  list(): ChatSession[] {
    return [...this.chats.values()].map((c) => c.session);
  }

  shutdown(): void {
    this.closed = true;
    for (const id of [...this.chats.keys()]) this.stop(id);
    this.stopStream();
    this.server?.stop();
    this.server = null;
    this.client = null;
    this.endpoint = null;
  }

  // Internals ---------------------------------------------------------------

  private async ensureClient(): Promise<OpenCodeClient> {
    if (this.client && this.endpoint && (this.deps.endpoint || this.server?.running)) return this.client;
    let endpoint: OpenCodeEndpoint;
    if (this.deps.endpoint) {
      endpoint = this.deps.endpoint;
    } else {
      const runtime = await this.deps.resolveExecutable();
      if (!runtime) throw new UnavailableError('OpenCode is not installed or not on PATH');
      this.server ??= new OpenCodeServer({
        executable: runtime.executable,
        cwd: this.deps.serverCwd,
        env: this.deps.env,
        platform: this.deps.platform,
        startupTimeoutMs: this.deps.startupTimeoutMs,
        log: this.deps.log,
        spawnImpl: this.deps.spawnImpl,
      });
      try {
        endpoint = await this.server.ensure();
      } catch (error) {
        throw new UnavailableError(describe(error));
      }
    }
    this.endpoint = endpoint;
    this.client = new OpenCodeClient(endpoint, { timeoutMs: this.deps.clientTimeoutMs, fetchImpl: this.deps.fetchImpl });
    return this.client;
  }

  private requireClient(): OpenCodeClient {
    if (!this.client) throw new UnavailableError('OpenCode runtime is not running');
    return this.client;
  }

  private require(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new NotFoundError('Chat', chatId);
    return live;
  }

  private ensureStream(): void {
    if (this.streamTask || this.closed) return;
    const controller = new AbortController();
    this.streamAbort = controller;
    this.streamTask = this.runStream(controller.signal).finally(() => {
      if (this.streamAbort === controller) {
        this.streamAbort = null;
        this.streamTask = null;
      }
    });
  }

  private stopStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.streamTask = null;
  }

  private async runStream(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !this.closed) {
      const client = this.client;
      if (!client) return;
      try {
        await client.globalEvents((event) => this.handleEvent(event), signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log?.(`[chat] event stream dropped: ${describe(error)}`);
      }
      if (signal.aborted || this.chats.size === 0) return;
      attempt += 1;
      if (attempt > 20) {
        for (const chat of this.chats.values()) {
          this.deps.emit({ chatId: chat.session.id, type: 'error', message: 'Lost the connection to the OpenCode runtime.' });
        }
        return;
      }
      await sleep(Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)), signal);
    }
  }

  private handleEvent(event: OcGlobalEvent): void {
    const payload = event.payload;
    const props = isRecord(payload.properties) ? payload.properties : {};
    const ocSessionId = str(props.sessionID) || (isRecord(props.info) ? str(props.info.sessionID) : '') || (isRecord(props.part) ? str(props.part.sessionID) : '');
    const chatId = ocSessionId ? this.byOcSession.get(ocSessionId) : undefined;
    if (!chatId) return;
    const live = this.chats.get(chatId);
    if (!live) return;

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
   * once, on the first finished copy. `reasoning` is a breakdown of `output`
   * in the SDK the server uses, so adding it would charge those tokens twice.
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
      outputTokens: tokenCount(tokens.output),
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
