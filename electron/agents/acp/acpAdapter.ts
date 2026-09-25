import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type ChatEvent, type ChatMessage, type ChatPart, type ChatQuestionItem, type ChatUsage, type EffortTier, type PermissionReply } from '../../../shared/contracts';
import { NotFoundError, UnavailableError, ValidationError } from '../../core/errors';
import { newId } from '../../core/ids';
import { killProcessTree, spawnInOwnProcessGroup } from '../../core/processTree';
import { addUsage, tokenCount } from '../../core/usage';
import { spawnSpecFor } from '../../runtime/commandRunner';
import { scrubEnv } from '../../runtime/terminalManager';
import type { TranscriptStore } from '../transcripts';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult, type RuntimeAdapter } from '../types';
import { AcpConnection, AcpRpcError, REQUEST_CANCELLED } from './connection';
import { toAcpMcpServers, type AcpEnvContext, type AcpProfile, type AcpUsageReading } from './profiles';
import { ACP_PROTOCOL_VERSION, isRecord, type AcpMcpServer, type AcpPermissionOption, type AcpSessionUpdate } from './types';

/**
 * EL TOPE DE PROCESOS ACP DE LA APP (brief 2026-09-25, 3.3: `MAX_ACP_AGENT_PROCESSES_TOTAL = 8`).
 *
 * Estructural, como `MAX_OPENCODE_SERVERS_TOTAL`: no acota lo que la persona
 * gasta, acota cuántos procesos de agente tiene Latte vivos a la vez. Uno por
 * miembro, y cada adaptador (Grok, Hermes) lleva su propia cuenta.
 *
 * TODO(limits): vive acá y no en `electron/coordination/limits.ts` porque ese
 * archivo tiene cambios abiertos de la tanda de OpenCode. Cuando esa tanda
 * mergee, mover esta constante a `limits.ts` junto a los otros techos de
 * procesos y leerla desde ahí.
 */
export const MAX_ACP_AGENT_PROCESSES_TOTAL = 8;

export interface AcpAdapterDeps {
  profile: AcpProfile;
  resolveExecutable: () => Promise<{ executable: string; version: string | null } | null>;
  emit: (event: ChatEvent) => void;
  /**
   * El directorio de la cuenta gestionada, o `null` cuando la cuenta no es una
   * gestionada por Latte. Grok y Hermes NO corren con el perfil del sistema: su
   * perfil arrastra hooks, reglas, MCP y aprobaciones globales (decisión 1 del
   * dueño, 2026-09-25), así que sin cuenta propia no arrancan.
   */
  accountHome: (accountId: string | null) => string | null;
  /** El modelo que Ajustes eligió para un nivel de esfuerzo en este runtime. */
  tierModel?: (tier: EffortTier) => string | null;
  /** El runtime reportó qué servidores MCP levantó (corrige el reclamo, como el `system/init` de Claude). */
  onMcpServers?: (chatId: string, connected: string[]) => void;
  /** Lo que el pane mostró: al retomar, la conversación vuelve de acá y no del replay del agente. */
  transcripts?: TranscriptStore;
  /** Un directorio de Latte para los archivos de soporte que algún perfil necesita. */
  supportDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
  maxProcesses?: number;
  /** Versión de Latte que se anuncia en `initialize`. */
  clientVersion?: string;
}

interface PendingPermission {
  resolve: (result: unknown) => void;
  options: AcpPermissionOption[];
  timer: NodeJS.Timeout | null;
}

interface PendingQuestion {
  items: ChatQuestionItem[];
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface LiveChat {
  chatId: string;
  workId: string;
  child: ChildProcess;
  connection: AcpConnection;
  sessionId: string | null;
  messages: Map<string, ChatMessage>;
  order: string[];
  /** El mensaje del asistente del turno en curso y la parte a la que se le están sumando trozos. */
  currentMessageId: string | null;
  streamingPart: { id: string; kind: 'text' | 'reasoning' } | null;
  partCounter: number;
  turnCounter: number;
  permissions: Map<string, PendingPermission>;
  questions: Map<string, PendingQuestion>;
  busy: boolean;
  closed: boolean;
  /** Mientras dura `session/load` el agente reproduce la historia: el pane se arma desde el transcripto, así que el replay se ignora. */
  replaying: boolean;
  recorded: Set<string>;
  restoredIds: Set<string>;
  epoch: string;
  /** Lo que va antes del primer mensaje (Hermes: el rol). Se consume una vez. */
  preamble: string | null;
  usage: ChatUsage;
  /** El último contexto que el agente reportó fuera de la respuesta (`usage_update.used`). */
  lastContext: number | null;
  mcpReady: Set<string>;
  mcpConfirmed: boolean;
}

const MESSAGE_LIMIT = 400;
const TOOL_TEXT_LIMIT = 12_000;
const STDERR_LOG_LIMIT = 300;

/**
 * Un agente ACP (Grok, Hermes) como runtime de chat: un proceso por miembro,
 * JSON-RPC por stdio. El bearer de coordinación es por miembro y el arranque
 * es barato en Grok, así que no se comparte proceso como en Codex (brief,
 * 3.3). Lo que cada agente hace a su manera vive en su `AcpProfile`.
 */
export class AcpChatAdapter implements RuntimeAdapter {
  readonly runtime: AcpProfile['runtime'];
  readonly mcpInjection = 'per-member' as const;
  readonly confirmsMcpInjection: boolean;
  private readonly chats = new Map<string, LiveChat>();
  /** Reservados sincrónicamente: dos `start()` del mismo chatId no pasan los dos el guard (juicio #7). */
  private readonly starting = new Set<string>();
  /** Los procesos que están arrancando, para poder matarlos si `shutdown()` llega en el medio. */
  private readonly startingChildren = new Map<string, ChildProcess>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly maxProcesses: number;

  constructor(private readonly deps: AcpAdapterDeps) {
    this.runtime = deps.profile.runtime;
    this.confirmsMcpInjection = deps.profile.confirmsMcpInjection;
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.maxProcesses = deps.maxProcesses ?? MAX_ACP_AGENT_PROCESSES_TOTAL;
  }

  owns(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  isBusy(chatId: string): boolean {
    return this.chats.get(chatId)?.busy ?? false;
  }

  /** Procesos vivos más los que están arrancando: lo que cuenta contra el tope. */
  processCount(): number {
    return this.chats.size + this.starting.size;
  }

  async start(input: AdapterStartInput): Promise<AdapterStartResult> {
    if (this.processCount() >= this.maxProcesses) throw new ValidationError(`Too many open ${this.deps.profile.label} chats (max ${this.maxProcesses})`);
    const chatId = input.chatId ?? newId('ses');
    if (this.chats.has(chatId) || this.starting.has(chatId)) throw new ValidationError('This chat is already open');
    this.starting.add(chatId);
    try {
      return await this.startChat(chatId, input);
    } finally {
      this.starting.delete(chatId);
      this.startingChildren.delete(chatId);
    }
  }

  private async startChat(chatId: string, input: AdapterStartInput): Promise<AdapterStartResult> {
    const profile = this.deps.profile;
    const accountHome = this.deps.accountHome(input.accountId ?? null);
    if (!accountHome) throw new ValidationError(`${profile.label} runs only with an account managed by Latte`);
    const runtime = await this.deps.resolveExecutable();
    if (!runtime) throw new UnavailableError(`${profile.label} is not installed or not on PATH`);

    const envContext: AcpEnvContext = { accountHome, supportDir: this.deps.supportDir ?? null, platform: this.platform };
    try {
      profile.prepareHome?.(envContext);
    } catch (error) {
      this.deps.log?.(`[${profile.runtime} ${chatId}] preparing the account home failed: ${describe(error)}`);
    }
    const env = { ...scrubEnv(this.env), ...profile.env(envContext), ...(input.extraEnv ?? {}) };
    const spec = spawnSpecFor(runtime.executable, profile.args, this.platform, this.env);
    let child: ChildProcess;
    try {
      child = spawnInOwnProcessGroup(this.deps.spawnImpl ?? spawn, spec.file, spec.args, { cwd: input.directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, this.platform);
    } catch (error) {
      throw new UnavailableError(`Could not start ${profile.label}: ${describe(error)}`);
    }
    this.startingChildren.set(chatId, child);

    // `live` existe desde antes del protocolo: las notificaciones de
    // `session/new` (los MCP que Grok confirma) ya tienen a quién llegar.
    const live = this.newLive(chatId, input.workId, child);
    child.stderr?.on('data', (chunk: Buffer) => this.deps.log?.(`[${profile.runtime} ${chatId}] ${chunk.toString('utf8').trim().slice(0, STDERR_LOG_LIMIT)}`));
    let startupFailure: ((error: Error) => void) | null = null;
    const died = new Promise<never>((_, reject) => { startupFailure = reject; });
    died.catch(() => { /* sólo importa mientras arranca */ });
    child.on('error', (error) => {
      if (startupFailure) { startupFailure(error); return; }
      this.deps.emit({ chatId, type: 'error', message: `${profile.label} process error: ${error.message}` });
      this.finish(live, `process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      const reason = `${profile.label} exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
      if (startupFailure) { startupFailure(new Error(reason)); return; }
      if (live.closed) return;
      if (live.busy) this.deps.emit({ chatId, type: 'error', message: reason });
      this.finish(live, reason);
    });

    const mcpServers = toAcpMcpServers(input.mcpServers);
    let sessionId: string;
    let resumed = false;
    let model = input.model ?? null;
    try {
      const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, died]);
      const init = await race(live.connection.request<Record<string, unknown>>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'latte', version: this.deps.clientVersion ?? '0.0.0' },
      }, profile.startupTimeoutMs));
      if (!isRecord(init) || init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`speaks ACP protocol ${isRecord(init) ? String(init.protocolVersion) : '?'}, Latte speaks ${ACP_PROTOCOL_VERSION}`);
      }
      const meta = profile.sessionMeta?.(input);
      const base = { cwd: input.directory, mcpServers, ...(meta ? { _meta: meta } : {}) };
      let opened: Record<string, unknown> | null = null;
      if (input.previousSessionId) {
        live.replaying = true;
        try {
          const loaded = await race(live.connection.request<unknown>('session/load', { ...base, sessionId: input.previousSessionId }, profile.startupTimeoutMs));
          opened = isRecord(loaded) ? loaded : {};
          sessionId = input.previousSessionId;
          resumed = true;
        } catch (error) {
          if (live.connection.closed) throw error;
          // La sesión ya no está (el agente la borró, cambió de home). Una
          // conversación nueva es mejor que ninguna, y el pane no muestra un
          // historial que el agente no tiene.
          this.deps.log?.(`[${profile.runtime} ${chatId}] session/load failed, starting a new session: ${describe(error)}`);
        } finally {
          live.replaying = false;
        }
      }
      if (!resumed) {
        const created = await race(live.connection.request<unknown>('session/new', base, profile.startupTimeoutMs));
        if (!isRecord(created) || typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('session/new returned no sessionId');
        opened = created;
        sessionId = created.sessionId;
      }
      live.sessionId = sessionId!;
      if (profile.setupSession) {
        const setup = await race(profile.setupSession({
          connection: live.connection,
          sessionId: sessionId!,
          input,
          cwd: input.directory,
          opened: opened ?? {},
          mcpServers,
          tierModel: this.deps.tierModel?.(input.tier ?? DEFAULT_EFFORT_TIER) ?? null,
          tier: input.tier ?? DEFAULT_EFFORT_TIER,
          timeoutMs: profile.startupTimeoutMs,
          log: (line) => this.deps.log?.(`[${profile.runtime} ${chatId}] ${line}`),
        }));
        model = setup.model ?? model;
        if (setup.notice) this.deps.emit({ chatId, type: 'error', message: setup.notice });
      }
    } catch (error) {
      startupFailure = null;
      live.closed = true;
      live.connection.close('startup failed');
      killProcessTree(child, this.platform);
      throw new UnavailableError(`Could not start ${profile.label}: ${describe(error)}`);
    }
    startupFailure = null;
    if (!resumed) live.preamble = profile.firstPromptPreamble?.(input) ?? null;
    if (resumed && this.deps.transcripts) {
      for (const message of this.deps.transcripts.load(chatId)) {
        const restored = { ...message, chatId };
        live.messages.set(restored.id, restored);
        live.order.push(restored.id);
        live.restoredIds.add(restored.id);
      }
    }
    this.chats.set(chatId, live);
    const session = {
      ...sessionFrom(input, this.runtime, model, input.accountId ?? null, input.label, resumed),
      id: chatId,
      historyRecovered: live.restoredIds.size > 0,
    };
    // `undefined` a propósito: lo que Latte MANDÓ no es lo que el agente
    // levantó (juicio #1, ronda 4). Grok lo confirma después por `mcpSignal`;
    // Hermes no lo dice nunca por ACP, y ahí el reclamo queda como está.
    return { session, runtimeSessionId: sessionId!, injectedMcpServers: undefined, injectionRefusedByLatte: false };
  }

  listMessages(chatId: string): ChatMessage[] {
    const live = this.require(chatId);
    return live.order.map((id) => live.messages.get(id)).filter((m): m is ChatMessage => m !== undefined);
  }

  async send(chatId: string, text: string): Promise<void> {
    const live = this.require(chatId);
    if (live.closed) throw new UnavailableError(`This ${this.deps.profile.label} chat has ended. Start it again to continue.`);
    if (live.busy) throw new ValidationError(`${this.deps.profile.label} is still working on the previous message`);
    const userMessage: ChatMessage = {
      id: `user-${randomUUID()}`,
      chatId,
      role: 'user',
      parts: [{ type: 'text', id: `user-${randomUUID()}`, text }],
      createdAt: new Date().toISOString(),
      completed: true,
      error: null,
    };
    this.upsertMessage(live, userMessage);
    this.record(live, userMessage);
    this.deps.emit({ chatId, type: 'message', message: userMessage });
    live.busy = true;
    this.deps.emit({ chatId, type: 'status', status: 'busy', detail: '' });
    this.startAssistant(live);
    // El preámbulo viaja por el cable y nunca por la pantalla: la persona ve lo que escribió.
    const wire = live.preamble ? `${live.preamble}\n\n---\n\n${text}` : text;
    live.preamble = null;
    live.connection.request<unknown>('session/prompt', { sessionId: live.sessionId, prompt: [{ type: 'text', text: wire }] }).then(
      (result) => this.onPromptDone(live, isRecord(result) ? result : {}),
      (error: unknown) => this.onPromptFailed(live, error),
    );
  }

  /**
   * `session/cancel` es una notificación: el turno termina cuando el prompt
   * vuelve con `stopReason: cancelled`. ACP pide que el cliente conteste los
   * permisos pendientes con `cancelled`; lo mismo con las preguntas.
   */
  async abort(chatId: string): Promise<void> {
    const live = this.require(chatId);
    if (live.closed || !live.busy) return;
    live.connection.notify('session/cancel', { sessionId: live.sessionId });
    this.cancelPending(live);
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const live = this.require(chatId);
    const pending = live.permissions.get(requestId);
    if (!pending) throw new NotFoundError('Permission request', requestId);
    const option = pickOption(pending.options, reply);
    live.permissions.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
    this.deps.emit({ chatId, type: 'permission-resolved', requestId });
  }

  async replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    const live = this.require(chatId);
    const pending = live.questions.get(requestId);
    const bridge = this.deps.profile.questions;
    if (!pending || !bridge) throw new NotFoundError('Question', requestId);
    live.questions.delete(requestId);
    if (answers === null) pending.reject(bridge.dismissed());
    else pending.resolve(bridge.answer(pending.items, answers));
    this.deps.emit({ chatId, type: 'question-resolved', requestId });
  }

  stop(chatId: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.finish(live, 'stopped');
  }

  shutdown(): void {
    for (const id of [...this.chats.keys()]) this.stop(id);
    for (const child of this.startingChildren.values()) killProcessTree(child, this.platform);
  }

  // Internals ---------------------------------------------------------------

  private newLive(chatId: string, workId: string, child: ChildProcess): LiveChat {
    const live = {
      chatId,
      workId,
      child,
      sessionId: null,
      messages: new Map(),
      order: [],
      currentMessageId: null,
      streamingPart: null,
      partCounter: 0,
      turnCounter: 0,
      permissions: new Map(),
      questions: new Map(),
      busy: false,
      closed: false,
      replaying: false,
      recorded: new Set(),
      restoredIds: new Set(),
      epoch: randomUUID().slice(0, 8),
      preamble: null,
      usage: EMPTY_USAGE,
      lastContext: null,
      mcpReady: new Set(),
      mcpConfirmed: false,
    } as unknown as LiveChat;
    live.connection = new AcpConnection(child.stdin as NonNullable<ChildProcess['stdin']>, child.stdout as NonNullable<ChildProcess['stdout']>, {
      onRequest: (method, params) => this.onAgentRequest(live, method, params),
      onNotification: (method, params) => this.onAgentNotification(live, method, params),
      log: (line) => this.deps.log?.(`[${this.runtime} ${chatId}] ${line}`),
    });
    return live;
  }

  private require(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new NotFoundError('Chat', chatId);
    return live;
  }

  private finish(live: LiveChat, reason: string): void {
    if (live.closed) return;
    live.closed = true;
    live.busy = false;
    if (this.chats.get(live.chatId) === live) this.chats.delete(live.chatId);
    this.cancelPending(live);
    live.connection.close(reason);
    try { live.child.stdin?.end(); } catch { /* ignore */ }
    killProcessTree(live.child, this.platform);
    this.deps.emit({ chatId: live.chatId, type: 'closed', reason });
  }

  /** Contesta todo lo que el agente dejó esperando y le avisa a la pantalla que ya no hay nada que responder. */
  private cancelPending(live: LiveChat): void {
    for (const [requestId, pending] of live.permissions) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.deps.emit({ chatId: live.chatId, type: 'permission-resolved', requestId });
    }
    live.permissions.clear();
    for (const [requestId, pending] of live.questions) {
      pending.reject(new AcpRpcError(REQUEST_CANCELLED, 'The turn was cancelled in Latte.'));
      this.deps.emit({ chatId: live.chatId, type: 'question-resolved', requestId });
    }
    live.questions.clear();
  }

  private record(live: LiveChat, message: ChatMessage): void {
    if (!this.deps.transcripts) return;
    if (live.restoredIds.has(message.id)) return;
    const id = `${live.epoch}-${message.id}`;
    if (message.role === 'user' && live.recorded.has(id)) return;
    live.recorded.add(id);
    this.deps.transcripts.append(live.chatId, { ...message, id });
  }

  // Requests and notifications from the agent ------------------------------

  private onAgentRequest(live: LiveChat, method: string, params: unknown): Promise<unknown> | undefined {
    if (method === 'session/request_permission') return this.onPermissionRequest(live, params);
    const bridge = this.deps.profile.questions;
    if (bridge && method === bridge.method) return this.onQuestionRequest(live, params);
    // `fs/*` y `terminal/*`: Latte anuncia `fs:false, terminal:false`, así que
    // el agente escribe por su cuenta. Lo que llegue igual se contesta -32601.
    return undefined;
  }

  private onPermissionRequest(live: LiveChat, params: unknown): Promise<unknown> {
    const request = isRecord(params) ? params : {};
    const options = Array.isArray(request.options)
      ? request.options.filter((o): o is AcpPermissionOption => isRecord(o) && typeof o.optionId === 'string' && typeof o.kind === 'string')
      : [];
    const toolCall = (isRecord(request.toolCall) ? request.toolCall : {}) as unknown as AcpSessionUpdate;
    const requestId = `perm-${randomUUID()}`;
    return new Promise((resolve) => {
      const timeoutMs = this.deps.profile.permissionTimeoutMs;
      // El agente niega solo pasado su plazo (Hermes: 60 s). La tarjeta no
      // puede quedar ofreciendo algo que ya no existe.
      const timer = timeoutMs
        ? setTimeout(() => {
          if (!live.permissions.delete(requestId)) return;
          resolve({ outcome: { outcome: 'cancelled' } });
          this.deps.emit({ chatId: live.chatId, type: 'permission-resolved', requestId });
          this.deps.emit({ chatId: live.chatId, type: 'error', message: `${this.deps.profile.label} denied "${toolTitle(toolCall) || 'the action'}" on its own: nobody answered within ${Math.round(timeoutMs / 1000)} s.` });
        }, timeoutMs)
        : null;
      timer?.unref?.();
      live.permissions.set(requestId, { resolve, options, timer });
      this.deps.emit({
        chatId: live.chatId,
        type: 'permission',
        request: {
          id: requestId,
          permission: toolName(toolCall),
          patterns: patternsFrom(toolCall),
          always: options.some((o) => o.kind === 'allow_always') ? ['session'] : [],
          title: toolTitle(toolCall) || toolName(toolCall),
        },
      });
    });
  }

  private onQuestionRequest(live: LiveChat, params: unknown): Promise<unknown> {
    const bridge = this.deps.profile.questions!;
    const items = bridge.parse(params);
    if (!items) return Promise.reject(new AcpRpcError(-32602, 'Latte could not read these questions'));
    const requestId = `ask-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      live.questions.set(requestId, { items, resolve, reject });
      this.deps.emit({ chatId: live.chatId, type: 'question', request: { id: requestId, questions: items } });
    });
  }

  private onAgentNotification(live: LiveChat, method: string, params: unknown): void {
    if (method === 'session/update') {
      if (live.replaying || live.closed) return;
      const body = isRecord(params) ? params : {};
      if (live.sessionId && typeof body.sessionId === 'string' && body.sessionId !== live.sessionId) return;
      if (isRecord(body.update) && typeof body.update.sessionUpdate === 'string') this.onUpdate(live, body.update as unknown as AcpSessionUpdate);
      return;
    }
    const signal = this.deps.profile.mcpSignal?.(method, params);
    if (!signal) return;
    if (signal.kind === 'status') {
      if (signal.ready) live.mcpReady.add(signal.name);
      else live.mcpReady.delete(signal.name);
      // Un servidor que cambia de estado DESPUÉS de la confirmación también es noticia.
      if (live.mcpConfirmed) this.deps.onMcpServers?.(live.chatId, [...live.mcpReady]);
      return;
    }
    live.mcpConfirmed = true;
    this.deps.onMcpServers?.(live.chatId, [...live.mcpReady]);
  }

  private onUpdate(live: LiveChat, update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendChunk(live, 'text', chunkText(update.content));
        return;
      case 'agent_thought_chunk':
        this.appendChunk(live, 'reasoning', chunkText(update.content));
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.onToolCall(live, update);
        return;
      case 'usage_update': {
        const used = tokenCount(update.used);
        if (used > 0) live.lastContext = used;
        return;
      }
      default:
        // `user_message_chunk` (sólo en replays), `session_info_update`,
        // `available_commands_update`, `config_option_update`, `plan`: nada
        // que la pantalla necesite.
        return;
    }
  }

  // Messages -----------------------------------------------------------------

  private startAssistant(live: LiveChat): void {
    live.turnCounter += 1;
    const id = `acp-${live.epoch}-${live.turnCounter}`;
    live.currentMessageId = id;
    live.streamingPart = null;
    const message: ChatMessage = { id, chatId: live.chatId, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null };
    this.upsertMessage(live, message);
    this.deps.emit({ chatId: live.chatId, type: 'message', message });
  }

  /** El mensaje donde van las partes que llegan: el del turno, o uno nuevo si el agente habla fuera de un turno. */
  private currentMessage(live: LiveChat): ChatMessage {
    const current = live.currentMessageId ? live.messages.get(live.currentMessageId) : undefined;
    if (current) return current;
    this.startAssistant(live);
    return live.messages.get(live.currentMessageId as string) as ChatMessage;
  }

  private appendChunk(live: LiveChat, kind: 'text' | 'reasoning', text: string): void {
    if (!text) return;
    const message = this.currentMessage(live);
    if (live.streamingPart && live.streamingPart.kind === kind) {
      const parts = message.parts.slice();
      const index = parts.findIndex((p) => p.id === live.streamingPart?.id);
      if (index !== -1) {
        const part = parts[index] as Extract<ChatPart, { type: 'text' | 'reasoning' }>;
        parts[index] = { ...part, text: part.text + text };
        live.messages.set(message.id, { ...message, parts });
        this.deps.emit({ chatId: live.chatId, type: 'delta', messageId: message.id, partId: part.id, delta: text });
        return;
      }
    }
    live.partCounter += 1;
    const part: ChatPart = { type: kind, id: `${message.id}#${live.partCounter}`, text };
    live.streamingPart = { id: part.id, kind };
    live.messages.set(message.id, { ...message, parts: [...message.parts, part] });
    this.deps.emit({ chatId: live.chatId, type: 'part', messageId: message.id, part });
  }

  private onToolCall(live: LiveChat, update: AcpSessionUpdate): void {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!toolCallId) return;
    // Una herramienta corta el trozo de texto que venía: lo que siga es otro párrafo.
    live.streamingPart = null;
    for (const messageId of [...live.order].reverse()) {
      const message = live.messages.get(messageId);
      const index = message ? message.parts.findIndex((p) => p.type === 'tool' && p.id === toolCallId) : -1;
      if (!message || index === -1) continue;
      const parts = message.parts.slice();
      parts[index] = mergeTool(parts[index] as ToolPart, update);
      live.messages.set(messageId, { ...message, parts });
      this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[index] });
      return;
    }
    const message = this.currentMessage(live);
    const part = mergeTool({ type: 'tool', id: toolCallId, tool: toolName(update), status: 'running', title: '', input: '', output: '', error: '' }, update);
    live.messages.set(message.id, { ...message, parts: [...message.parts, part] });
    this.deps.emit({ chatId: live.chatId, type: 'part', messageId: message.id, part });
  }

  private onPromptDone(live: LiveChat, result: Record<string, unknown>): void {
    if (live.closed) return;
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'end_turn';
    const cancelled = stopReason === 'cancelled';
    const error = stopReason === 'refusal' ? `${this.deps.profile.label} refused to continue` : null;
    this.settleTurn(live, cancelled, error);
    this.reportUsage(live, result);
    if (error) this.deps.emit({ chatId: live.chatId, type: 'error', message: error });
    live.busy = false;
    this.deps.emit({ chatId: live.chatId, type: 'status', status: 'idle', detail: '' });
  }

  private onPromptFailed(live: LiveChat, error: unknown): void {
    if (live.closed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.settleTurn(live, false, message);
    this.deps.emit({ chatId: live.chatId, type: 'error', message });
    live.busy = false;
    this.deps.emit({ chatId: live.chatId, type: 'status', status: 'idle', detail: '' });
  }

  /**
   * Cierra el mensaje del turno. Una herramienta que el agente nunca cerró
   * (Hermes no manda el `tool_call_update` final de las tools MCP) no se
   * queda girando para siempre: si el turno terminó bien, terminó; si se
   * canceló, quedó cortada.
   */
  private settleTurn(live: LiveChat, cancelled: boolean, error: string | null): void {
    const id = live.currentMessageId;
    live.currentMessageId = null;
    live.streamingPart = null;
    const message = id ? live.messages.get(id) : undefined;
    if (!message) return;
    const parts = message.parts.map((part) => part.type === 'tool' && (part.status === 'running' || part.status === 'pending')
      ? { ...part, status: cancelled || error ? 'error' as const : 'completed' as const, error: cancelled ? 'Cancelled' : error ?? part.error }
      : part);
    const completed: ChatMessage = { ...message, parts, completed: true, error };
    live.messages.set(message.id, completed);
    this.record(live, completed);
    this.deps.emit({ chatId: live.chatId, type: 'message', message: completed });
  }

  /**
   * Lo que el turno consumió, como lo contó el agente (regla N3 de
   * `claudeAdapter.ts`): `contextTokens` es la ÚLTIMA llamada, nunca la suma
   * del turno. Un turno sin números no reporta nada: cero sería "gratis".
   */
  private reportUsage(live: LiveChat, result: Record<string, unknown>): void {
    const reading = this.deps.profile.readUsage ? this.deps.profile.readUsage(result) : standardUsage(result);
    if (!reading) return;
    const turn: ChatUsage = {
      inputTokens: Math.max(0, reading.inputTokens - reading.cachedReadTokens),
      outputTokens: reading.outputTokens,
      cacheReadTokens: reading.cachedReadTokens,
      cacheWriteTokens: reading.cacheWriteTokens,
      turns: 1,
      costUsd: reading.costUsd !== null && reading.costUsd > 0 ? reading.costUsd : null,
      contextTokens: reading.lastCallContext ?? live.lastContext,
    };
    live.usage = addUsage(live.usage, turn);
    this.deps.emit({ chatId: live.chatId, type: 'usage', turn, total: live.usage });
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
}

type ToolPart = Extract<ChatPart, { type: 'tool' }>;

/** El `usage` estándar de ACP en el `PromptResponse` (Hermes lo usa tal cual). */
export function standardUsage(result: Record<string, unknown>): AcpUsageReading | null {
  const usage = isRecord(result.usage) ? result.usage : null;
  if (!usage) return null;
  return {
    inputTokens: tokenCount(usage.inputTokens),
    cachedReadTokens: tokenCount(usage.cachedReadTokens),
    cacheWriteTokens: tokenCount(usage.cachedWriteTokens) || tokenCount(usage.cacheCreationTokens),
    outputTokens: tokenCount(usage.outputTokens),
    costUsd: null,
    lastCallContext: null,
  };
}

/** `once` → `allow_once`; `always` → `allow_always` (o `once` si el agente no lo ofrece); `reject` → `reject_once`. */
function pickOption(options: AcpPermissionOption[], reply: PermissionReply): AcpPermissionOption | null {
  const byKind = (kind: string) => options.find((o) => o.kind === kind) ?? null;
  if (reply === 'reject') return byKind('reject_once') ?? byKind('reject_always');
  if (reply === 'always') return byKind('allow_always') ?? byKind('allow_once');
  return byKind('allow_once');
}

function mergeTool(part: ToolPart, update: AcpSessionUpdate): ToolPart {
  const status = mapStatus(update.status) ?? part.status;
  const output = contentText(update.content) || (update.rawOutput !== undefined ? stringify(update.rawOutput) : '');
  const title = toolTitle(update);
  return {
    ...part,
    tool: part.tool === 'tool' || !part.tool ? toolName(update) : part.tool,
    status,
    title: title || part.title,
    input: update.rawInput !== undefined ? stringify(update.rawInput) : part.input,
    output: status === 'error' ? part.output : (output || part.output),
    error: status === 'error' ? (output || part.error || 'Failed') : part.error,
  };
}

function mapStatus(status: unknown): ToolPart['status'] | null {
  switch (status) {
    case 'pending': return 'pending';
    case 'in_progress': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'error';
    default: return null;
  }
}

/** El nombre de la herramienta: el que el agente declara (`_meta['x.ai/tool'].name`), o el principio del título (`write: C:/…` en Hermes). */
function toolName(update: AcpSessionUpdate): string {
  const meta = isRecord(update._meta) ? update._meta['x.ai/tool'] : undefined;
  if (isRecord(meta) && typeof meta.name === 'string' && meta.name) return meta.name;
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  const match = /^([A-Za-z0-9_.-]+)(?::\s|$)/.exec(title);
  if (match) return match[1];
  return typeof update.kind === 'string' && update.kind ? update.kind : 'tool';
}

function toolTitle(update: AcpSessionUpdate): string {
  return typeof update.title === 'string' ? update.title.slice(0, 200) : '';
}

function patternsFrom(update: AcpSessionUpdate): string[] {
  const input = isRecord(update.rawInput) ? update.rawInput : {};
  const nested = isRecord(input.arguments) ? input.arguments : {};
  const out: string[] = [];
  for (const source of [input, nested]) {
    for (const key of ['file_path', 'path', 'command', 'pattern', 'url']) {
      if (typeof source[key] === 'string' && source[key]) out.push(String(source[key]).slice(0, 200));
    }
  }
  return out;
}

function chunkText(content: unknown): string {
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return '';
}

/** El texto de un `content` de herramienta: bloques de texto tal cual, diffs como "ruta". */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === 'content' && isRecord(item.content) && typeof item.content.text === 'string') out.push(item.content.text);
    else if (item.type === 'diff' && typeof item.path === 'string') out.push(`diff: ${item.path}`);
  }
  return clip(out.join('\n'));
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clip(value);
  try {
    return clip(JSON.stringify(value, null, 2));
  } catch {
    return '';
  }
}

function clip(value: string): string {
  return value.length > TOOL_TEXT_LIMIT ? `${value.slice(0, TOOL_TEXT_LIMIT)}\n… [truncated]` : value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AcpMcpServer };
