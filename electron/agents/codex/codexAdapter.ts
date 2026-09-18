import type { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type AccountLoginStart, type AgentModel, type ChatEvent, type ChatMessage, type ChatPart, type ChatUsage, type EffortTier, type PermissionReply } from '../../../shared/contracts';
import { NotFoundError, UnavailableError, ValidationError } from '../../core/errors';
import { newId } from '../../core/ids';
import { addUsage, tokenCount } from '../../core/usage';
import { scrubEnv } from '../../runtime/terminalManager';
import { SYSTEM_ACCOUNT_ID } from '../accounts';
import { codexEffortForTier } from '../tiers';
import { sessionFrom, type AdapterStartInput, type AdapterStartResult, type RuntimeAdapter } from '../types';
import { CodexAppServer, isRecord } from './appServer';
import { contentFromAnswers, errorMessage, isHttpUrl, mapElicitationForm, mcpToolOutput, type ElicitationFormField } from './elicitation';

export interface CodexAdapterDeps {
  resolveExecutable: () => Promise<{ executable: string; version: string | null } | null>;
  emit: (event: ChatEvent) => void;
  /** CODEX_HOME overlay for managed accounts; {} for the system profile. */
  accountEnv: (accountId: string | null) => Record<string, string>;
  /** Neutral cwd for the server process (the Latte data root). */
  serverCwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
  maxChats?: number;
  /** Opens http(s) URLs in the system browser. Never called from the renderer. */
  openExternal?: (url: string) => Promise<void>;
}

interface PendingRequest {
  kind: 'command' | 'fileChange' | 'permissions' | 'question' | 'elicitation-url' | 'elicitation-form' | 'elicitation-empty-form';
  respond: (result: unknown) => void;
  fail: (message: string) => void;
  params: Record<string, unknown>;
  fields?: ElicitationFormField[];
}

interface LiveChat {
  chatId: string;
  workId: string;
  accountId: string;
  threadId: string;
  directory: string;
  turnId: string | null;
  assistantId: string | null;
  messages: Map<string, ChatMessage>;
  order: string[];
  pending: Map<string, PendingRequest>;
  busy: boolean;
  /** Effort this member works at; sent on every turn because the server is shared. */
  tier: EffortTier;
  /** What this chat has consumed since it opened; the lifetime total is the hub's job. */
  usage: ChatUsage;
  /**
   * The thread total the last notification reported. Codex reports running
   * totals per thread, so a turn is the difference; without this every
   * notification would charge the whole thread again.
   */
  usageSoFar: { input: number; cachedInput: number; cacheWrite: number; output: number } | null;
  /** Turn the token counter was last attributed to, so one turn counts once. */
  usageTurnId: string | null;
}

const MESSAGE_LIMIT = 400;
const TOOL_TEXT_LIMIT = 12_000;

/**
 * Codex as a chat runtime through `codex app-server` (JSON-RPC over stdio).
 * One server per account (CODEX_HOME), one thread per Latte work. Approvals
 * and questions arrive as server requests and are answered from the UI.
 * ChatGPT login is started through the same protocol and finished in the browser.
 */
export class CodexChatAdapter implements RuntimeAdapter {
  readonly runtime = 'codex' as const;
  // Per-thread MCP config is broken in the installed app-server (thread/start
  // override hangs, see spike sdd/autonomous-coordination/spike-mcp-injection);
  // per-process re-keying is Phase 5, not yet implemented.
  readonly mcpInjection = 'none' as const;
  private readonly servers = new Map<string, CodexAppServer>();
  private readonly chats = new Map<string, LiveChat>();
  private readonly byThread = new Map<string, string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly maxChats: number;

  constructor(private readonly deps: CodexAdapterDeps) {
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.maxChats = deps.maxChats ?? 8;
  }

  owns(chatId: string): boolean {
    return this.chats.has(chatId);
  }

  isBusy(chatId: string): boolean {
    return this.chats.get(chatId)?.busy ?? false;
  }

  // Login ------------------------------------------------------------------------

  async startLogin(accountId: string): Promise<AccountLoginStart> {
    const server = await this.serverFor(accountId);
    const result = await server.request('account/login/start', { type: 'chatgpt' });
    if (!isRecord(result) || typeof result.authUrl !== 'string') throw new UnavailableError('Codex returned no login URL');
    return { mode: 'browser', url: result.authUrl, instructions: 'Iniciá sesión con tu cuenta de ChatGPT en el navegador. Cuando termine, volvé y tocá «Ya inicié sesión».' };
  }

  /**
   * `mcpServer/oauth/login` returns `authorizationUrl`. An older Codex that
   * does not know the method fails with a clear error instead of hanging.
   */
  async startMcpOauthLogin(accountId: string, name: string): Promise<{ url: string }> {
    const server = await this.serverFor(accountId);
    let result: unknown;
    try {
      result = await server.request('mcpServer/oauth/login', { name });
    } catch (error) {
      throw new UnavailableError(`Este Codex no pudo iniciar sesión en el servidor MCP «${name}»: ${describe(error)}`);
    }
    if (!isRecord(result) || typeof result.authorizationUrl !== 'string') throw new UnavailableError('Codex no devolvió una URL de login MCP');
    if (!isHttpUrl(result.authorizationUrl)) throw new ValidationError('Codex devolvió una URL de login MCP que no es http(s)');
    return { url: result.authorizationUrl };
  }

  async listMcpStatus(accountId: string): Promise<Array<{ name: string; authStatus: string }>> {
    const server = await this.serverFor(accountId);
    let result: unknown;
    try {
      result = await server.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' });
    } catch (error) {
      throw new UnavailableError(`Este Codex no soporta mcpServerStatus/list: ${describe(error)}`);
    }
    const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
    const out: Array<{ name: string; authStatus: string }> = [];
    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue;
      out.push({ name: entry.name, authStatus: typeof entry.authStatus === 'string' ? entry.authStatus : 'unknown' });
    }
    return out;
  }

  // Chats --------------------------------------------------------------------------

  async start(input: AdapterStartInput): Promise<AdapterStartResult> {
    if (this.chats.size >= this.maxChats) throw new ValidationError(`Too many open Codex chats (max ${this.maxChats})`);
    const chatId = input.chatId ?? newId('ses');
    if (this.chats.has(chatId)) throw new ValidationError('This chat is already open');
    const accountId = input.accountId ?? SYSTEM_ACCOUNT_ID;
    const server = await this.serverFor(accountId);
    // The role personality rides as developer instructions on the thread (start and resume alike).
    const instructions = input.instructions?.trim() ?? '';
    const threadOptions = { cwd: input.directory, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(input.model ? { model: input.model } : {}), ...(instructions ? { developerInstructions: instructions } : {}) };
    let threadId: string | null = null;
    let resumed = false;
    if (input.previousSessionId) {
      try {
        const result = await server.request('thread/resume', { threadId: input.previousSessionId, ...threadOptions });
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
        if (thread && typeof thread.id === 'string') {
          threadId = thread.id;
          resumed = true;
        }
      } catch (error) {
        this.deps.log?.(`[codex] resume failed, starting fresh: ${describe(error)}`);
      }
    }
    if (!threadId) {
      let result: unknown;
      try {
        result = await server.request('thread/start', threadOptions);
      } catch (error) {
        throw new UnavailableError(`Could not start a Codex thread: ${describe(error)}`);
      }
      const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
      if (!thread || typeof thread.id !== 'string') throw new UnavailableError('Codex returned no thread id');
      threadId = thread.id;
    }
    const live: LiveChat = { chatId, workId: input.workId, accountId, threadId, directory: input.directory, turnId: null, assistantId: null, messages: new Map(), order: [], pending: new Map(), busy: false, tier: input.tier ?? DEFAULT_EFFORT_TIER, usage: EMPTY_USAGE, usageSoFar: null, usageTurnId: null };
    this.chats.set(chatId, live);
    this.byThread.set(threadId, chatId);
    if (resumed) await this.loadHistory(live, server);
    return {
      session: { ...sessionFrom(input, 'codex', input.model ?? null, accountId, input.label, resumed), id: chatId },
      runtimeSessionId: threadId,
    };
  }

  listMessages(chatId: string): ChatMessage[] {
    const live = this.require(chatId);
    return live.order.map((id) => live.messages.get(id)).filter((m): m is ChatMessage => m !== undefined);
  }

  async send(chatId: string, text: string): Promise<void> {
    const live = this.require(chatId);
    if (live.busy) throw new ValidationError('Codex is still working on the previous message');
    const server = await this.serverFor(live.accountId);
    const userMessage: ChatMessage = { id: `user-${randomUUID()}`, chatId, role: 'user', parts: [{ type: 'text', id: `user-${randomUUID()}`, text }], createdAt: new Date().toISOString(), completed: true, error: null };
    this.upsertMessage(live, userMessage);
    this.deps.emit({ chatId, type: 'message', message: userMessage });
    live.busy = true;
    live.assistantId = null;
    this.deps.emit({ chatId, type: 'status', status: 'busy', detail: '' });
    try {
      // `effort` rides on every turn, not on the thread: one app-server serves
      // every member of an account, so a server-wide setting would put one
      // member's tier on all of them.
      const result = await server.request('turn/start', { threadId: live.threadId, input: [{ type: 'text', text }], effort: codexEffortForTier(live.tier) });
      const turn = isRecord(result) && isRecord(result.turn) ? result.turn : null;
      live.turnId = turn && typeof turn.id === 'string' ? turn.id : null;
    } catch (error) {
      live.busy = false;
      this.deps.emit({ chatId, type: 'status', status: 'idle', detail: '' });
      throw new UnavailableError(`Could not send the message to Codex: ${describe(error)}`);
    }
  }

  async abort(chatId: string): Promise<void> {
    const live = this.require(chatId);
    if (!live.turnId) return;
    const server = await this.serverFor(live.accountId);
    try {
      await server.request('turn/interrupt', { threadId: live.threadId, turnId: live.turnId });
    } catch (error) {
      throw new UnavailableError(`Could not interrupt Codex: ${describe(error)}`);
    }
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const live = this.require(chatId);
    const pending = live.pending.get(requestId);
    if (!pending || pending.kind === 'question' || pending.kind === 'elicitation-form') throw new NotFoundError('Permission request', requestId);
    if (pending.kind === 'elicitation-url') {
      if (reply === 'reject') pending.respond({ action: 'decline' });
      else {
        const url = typeof pending.params.url === 'string' ? pending.params.url : '';
        if (isHttpUrl(url) && this.deps.openExternal) await this.deps.openExternal(url);
        pending.respond({ action: 'accept' });
      }
    } else if (pending.kind === 'elicitation-empty-form') {
      pending.respond(reply === 'reject' ? { action: 'decline' } : { action: 'accept', content: {} });
    } else if (pending.kind === 'permissions') {
      if (reply === 'reject') pending.fail('The user declined this permission in Latte.');
      else pending.respond({ permissions: pending.params.permissions ?? {}, scope: reply === 'always' ? 'session' : 'turn' });
    } else {
      pending.respond({ decision: reply === 'reject' ? 'decline' : reply === 'always' ? 'acceptForSession' : 'accept' });
    }
    live.pending.delete(requestId);
    this.deps.emit({ chatId, type: 'permission-resolved', requestId });
  }

  async replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    const live = this.require(chatId);
    const pending = live.pending.get(requestId);
    if (!pending || (pending.kind !== 'question' && pending.kind !== 'elicitation-form')) throw new NotFoundError('Question', requestId);
    if (pending.kind === 'elicitation-form') {
      if (answers === null) pending.respond({ action: 'decline' });
      else {
        const mapped = contentFromAnswers(pending.fields ?? [], answers);
        if (!mapped.ok) throw new ValidationError(mapped.error);
        pending.respond({ action: 'accept', content: mapped.content });
      }
    } else if (answers === null) {
      pending.fail('The user declined to answer in Latte.');
    } else {
      const questions = Array.isArray(pending.params.questions) ? pending.params.questions : [];
      const mapped: Record<string, { answers: string[] }> = {};
      questions.forEach((q, index) => {
        if (isRecord(q) && typeof q.id === 'string') mapped[q.id] = { answers: answers[index] ?? [] };
      });
      pending.respond({ answers: mapped });
    }
    live.pending.delete(requestId);
    this.deps.emit({ chatId, type: 'question-resolved', requestId });
  }

  stop(chatId: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.settlePending(live, 'Chat closed in Latte');
    this.chats.delete(chatId);
    this.byThread.delete(live.threadId);
    this.deps.emit({ chatId, type: 'closed', reason: 'stopped' });
    if (![...this.chats.values()].some((c) => c.accountId === live.accountId)) {
      this.servers.get(live.accountId)?.stop();
      this.servers.delete(live.accountId);
    }
  }

  shutdown(): void {
    for (const id of [...this.chats.keys()]) this.stop(id);
    for (const server of this.servers.values()) server.stop();
    this.servers.clear();
  }

  // Internals ---------------------------------------------------------------------

  private require(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new NotFoundError('Chat', chatId);
    return live;
  }

  /**
   * The catalog Codex itself reports for this account, over the same protocol
   * a conversation uses. `model/list` is the source of truth: Latte does not
   * hardcode a list that would go stale the day a model ships.
   *
   * A conversation already open answers without spawning anything. Otherwise a
   * short-lived server is started and stopped here, which is why this is asked
   * when the Settings screen needs it and never while the app starts.
   */
  async listModels(accountId: string): Promise<AgentModel[]> {
    const live = this.servers.get(accountId);
    if (live) return parseModelList(await live.request('model/list', {}));
    const runtime = await this.deps.resolveExecutable();
    if (!runtime) throw new UnavailableError('Codex is not installed or not on PATH');
    const server = new CodexAppServer({
      executable: runtime.executable,
      env: { ...scrubEnv(this.env), ...this.deps.accountEnv(accountId === SYSTEM_ACCOUNT_ID ? null : accountId) },
      cwd: this.deps.serverCwd,
      platform: this.platform,
      spawnImpl: this.deps.spawnImpl,
      requestTimeoutMs: this.deps.requestTimeoutMs,
      log: this.deps.log,
    });
    try {
      return parseModelList(await server.request('model/list', {}));
    } finally {
      server.stop();
    }
  }

  private async serverFor(accountId: string): Promise<CodexAppServer> {
    let server = this.servers.get(accountId);
    if (!server) {
      const runtime = await this.deps.resolveExecutable();
      if (!runtime) throw new UnavailableError('Codex is not installed or not on PATH');
      server = new CodexAppServer({
        executable: runtime.executable,
        env: { ...scrubEnv(this.env), ...this.deps.accountEnv(accountId === SYSTEM_ACCOUNT_ID ? null : accountId) },
        cwd: this.deps.serverCwd,
        platform: this.platform,
        spawnImpl: this.deps.spawnImpl,
        requestTimeoutMs: this.deps.requestTimeoutMs,
        log: this.deps.log,
      });
      server.notifications.add((method, params) => this.onNotification(method, params));
      server.serverRequests.add((method, params, respond, fail) => this.onServerRequest(method, params, respond, fail));
      server.onExit = (reason) => {
        for (const live of [...this.chats.values()].filter((c) => c.accountId === accountId)) {
          this.settlePending(live, reason);
          if (live.busy) this.deps.emit({ chatId: live.chatId, type: 'error', message: reason });
          this.chats.delete(live.chatId);
          this.byThread.delete(live.threadId);
          this.deps.emit({ chatId: live.chatId, type: 'closed', reason });
        }
        this.servers.delete(accountId);
      };
      this.servers.set(accountId, server);
    }
    try {
      await server.ensure();
    } catch (error) {
      this.servers.delete(accountId);
      throw new UnavailableError(describe(error));
    }
    return server;
  }

  private async loadHistory(live: LiveChat, server: CodexAppServer): Promise<void> {
    try {
      const result = await server.request('thread/read', { threadId: live.threadId, includeTurns: true });
      const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
      const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
      for (const turn of turns) {
        if (!isRecord(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
        for (const item of turn.items) {
          if (!isRecord(item)) continue;
          if (item.type === 'userMessage') {
            const text = Array.isArray(item.content) ? item.content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('') : '';
            this.upsertMessage(live, { id: `user-${String(item.id)}`, chatId: live.chatId, role: 'user', parts: [{ type: 'text', id: `t-${String(item.id)}`, text }], createdAt: new Date().toISOString(), completed: true, error: null });
          } else {
            const part = partFromItem(item);
            if (part) this.upsertPart(live, `turn-${turn.id}`, part, true);
          }
        }
        const assistant = live.messages.get(`turn-${turn.id}`);
        if (assistant) live.messages.set(assistant.id, { ...assistant, completed: true });
      }
    } catch (error) {
      this.deps.log?.(`[codex] history load failed: ${describe(error)}`);
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const chatId = threadId ? this.byThread.get(threadId) : undefined;
    if (!chatId) return;
    const live = this.chats.get(chatId);
    if (!live) return;
    switch (method) {
      case 'turn/started': {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (turn && typeof turn.id === 'string') {
          live.turnId = turn.id;
          this.ensureAssistant(live, `turn-${turn.id}`);
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = isRecord(params.item) ? params.item : null;
        const turnId = typeof params.turnId === 'string' ? params.turnId : live.turnId;
        if (!item || !turnId) return;
        if (item.type === 'userMessage') return;
        const part = partFromItem(item);
        if (part) this.upsertPart(live, `turn-${turnId}`, part, false);
        return;
      }
      case 'item/agentMessage/delta':
        this.applyDelta(live, params, 'text');
        return;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.applyDelta(live, params, 'reasoning');
        return;
      case 'item/commandExecution/outputDelta': {
        const itemId = String(params.itemId ?? '');
        const delta = typeof params.delta === 'string' ? params.delta : '';
        this.updateTool(live, itemId, (part) => ({ ...part, output: clip(part.output + delta) }));
        return;
      }
      case 'thread/tokenUsage/updated': {
        this.reportUsage(live, params);
        return;
      }
      case 'turn/completed': {
        const turn = isRecord(params.turn) ? params.turn : null;
        const status = turn ? String(turn.status) : 'completed';
        const turnError = turn && isRecord(turn.error) ? String(turn.error.message ?? 'Codex turn failed') : null;
        live.busy = false;
        const assistantId = turn && typeof turn.id === 'string' ? `turn-${turn.id}` : live.assistantId;
        if (assistantId) {
          const message = live.messages.get(assistantId) ?? this.ensureAssistant(live, assistantId);
          const completed = { ...message, completed: true, error: status === 'failed' ? turnError : null };
          live.messages.set(assistantId, completed);
          this.deps.emit({ chatId, type: 'message', message: completed });
        }
        if (status === 'failed' && turnError) this.deps.emit({ chatId, type: 'error', message: turnError });
        this.deps.emit({ chatId, type: 'status', status: 'idle', detail: '' });
        return;
      }
      case 'error': {
        const error = isRecord(params.error) ? String(params.error.message ?? 'Codex error') : 'Codex error';
        if (params.willRetry === true) this.deps.emit({ chatId, type: 'status', status: 'retry', detail: error });
        else this.deps.emit({ chatId, type: 'error', message: error });
        return;
      }
      case 'thread/status/changed': {
        const status = isRecord(params.status) ? String(params.status.type) : 'idle';
        if (status === 'active' && !live.busy) {
          live.busy = true;
          this.deps.emit({ chatId, type: 'status', status: 'busy', detail: '' });
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * What Codex reports it consumed, from `thread/tokenUsage/updated`.
   *
   * The notification carries running totals for the thread (`total`) and the
   * last model request (`last`), and it fires once per request — a single turn
   * that calls three tools fires three times. So a turn is the growth of the
   * thread total, and the turn counter only moves the first time a given
   * `turnId` is seen. Anything else would either double-count the tokens or
   * count one conversation turn as several.
   *
   * Codex reports no price: `costUsd` stays null instead of Latte inventing
   * one from a rate card that would be wrong the week it changes.
   */
  private reportUsage(live: LiveChat, params: Record<string, unknown>): void {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    const total = usage && isRecord(usage.total) ? usage.total : null;
    if (!total) return;
    // `inputTokens` counts cached tokens too (Codex derives its own
    // "non-cached input" by subtracting), so the fresh part is the difference.
    const next = {
      input: tokenCount(total.inputTokens),
      cachedInput: tokenCount(total.cachedInputTokens),
      cacheWrite: tokenCount(total.cacheWriteInputTokens),
      output: tokenCount(total.outputTokens),
    };
    const previous = live.usageSoFar ?? { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
    live.usageSoFar = next;
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    const firstOfTurn = turnId !== null && turnId !== live.usageTurnId;
    if (firstOfTurn) live.usageTurnId = turnId;
    const grewInput = Math.max(0, next.input - previous.input);
    const grewCacheRead = Math.max(0, next.cachedInput - previous.cachedInput);
    const last = usage && isRecord(usage.last) ? usage.last : null;
    const turn: ChatUsage = {
      inputTokens: Math.max(0, grewInput - grewCacheRead),
      outputTokens: Math.max(0, next.output - previous.output),
      cacheReadTokens: grewCacheRead,
      cacheWriteTokens: Math.max(0, next.cacheWrite - previous.cacheWrite),
      turns: firstOfTurn ? 1 : 0,
      costUsd: null,
      // The last request's whole input is the context as it stands now.
      contextTokens: last ? tokenCount(last.inputTokens) + tokenCount(last.cacheWriteInputTokens) : null,
    };
    live.usage = addUsage(live.usage, turn);
    this.deps.emit({ chatId: live.chatId, type: 'usage', turn, total: live.usage });
  }

  private onServerRequest(method: string, params: Record<string, unknown>, respond: (result: unknown) => void, fail: (message: string) => void): boolean {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const chatId = threadId ? this.byThread.get(threadId) : undefined;
    const live = chatId ? this.chats.get(chatId) : undefined;
    if (!live) return false; // unclaimed -> the server layer replies with an error
    const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const command = typeof params.command === 'string' ? params.command : '';
        live.pending.set(requestId, { kind: 'command', respond, fail, params });
        this.deps.emit({ chatId: live.chatId, type: 'permission', request: { id: requestId, permission: 'command', patterns: command ? [command.slice(0, 200)] : [], always: ['session'], title: typeof params.reason === 'string' && params.reason ? params.reason : command.slice(0, 160) } });
        return true;
      }
      case 'item/fileChange/requestApproval': {
        const itemId = String(params.itemId ?? '');
        const paths = this.pathsOfFileChange(live, itemId);
        live.pending.set(requestId, { kind: 'fileChange', respond, fail, params });
        this.deps.emit({ chatId: live.chatId, type: 'permission', request: { id: requestId, permission: 'edit', patterns: paths, always: ['session'], title: typeof params.reason === 'string' && params.reason ? params.reason : paths.join(', ') } });
        return true;
      }
      case 'item/permissions/requestApproval': {
        live.pending.set(requestId, { kind: 'permissions', respond, fail, params });
        this.deps.emit({ chatId: live.chatId, type: 'permission', request: { id: requestId, permission: 'permissions', patterns: [], always: ['session'], title: typeof params.reason === 'string' && params.reason ? params.reason : 'Codex pide permisos adicionales' } });
        return true;
      }
      case 'item/tool/requestUserInput': {
        const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
        live.pending.set(requestId, { kind: 'question', respond, fail, params });
        this.deps.emit({
          chatId: live.chatId,
          type: 'question',
          request: {
            id: requestId,
            questions: questions.map((q) => ({
              header: String(q.header ?? ''),
              question: String(q.question ?? ''),
              multiple: false,
              custom: q.isOther === true,
              options: (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
            })),
          },
        });
        return true;
      }
      case 'mcpServer/elicitation/request':
        return this.onElicitation(live, requestId, params, respond, fail);
      default:
        this.deps.emit({ chatId: live.chatId, type: 'error', message: `Codex pidió «${method}» y Latte no lo atiende.` });
        return false;
    }
  }

  private onElicitation(
    live: LiveChat,
    requestId: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    fail: (message: string) => void,
  ): boolean {
    const serverName = typeof params.serverName === 'string' ? params.serverName : 'MCP';
    const message = typeof params.message === 'string' ? params.message : '';
    if (params.mode === 'url') {
      const url = typeof params.url === 'string' ? params.url : '';
      if (!isHttpUrl(url)) {
        this.deps.emit({ chatId: live.chatId, type: 'error', message: `El servidor MCP «${serverName}» pidió abrir una URL que no es http(s).` });
        respond({ action: 'decline' });
        return true;
      }
      live.pending.set(requestId, { kind: 'elicitation-url', respond, fail, params });
      this.deps.emit({
        chatId: live.chatId,
        type: 'permission',
        request: {
          id: requestId,
          permission: 'mcp-elicitation',
          patterns: [url],
          always: [],
          title: message,
          url,
          serverName,
        },
      });
      return true;
    }
    if (params.mode === 'form') {
      const mapped = mapElicitationForm(params.requestedSchema);
      if (!mapped.ok) {
        if (mapped.reason === 'el formulario no tiene campos') {
          live.pending.set(requestId, { kind: 'elicitation-empty-form', respond, fail, params });
          this.deps.emit({
            chatId: live.chatId,
            type: 'permission',
            request: {
              id: requestId,
              permission: 'mcp-elicitation',
              patterns: [],
              always: [],
              title: message || `El servidor MCP «${serverName}» pidió confirmar una acción sin valores.`,
              serverName,
            },
          });
          return true;
        }
        this.deps.emit({
          chatId: live.chatId,
          type: 'error',
          message: `El servidor MCP «${serverName}» pidió un formulario que Latte no puede mostrar (${mapped.reason}). ${message}`.trim(),
        });
        respond({ action: 'decline' });
        return true;
      }
      live.pending.set(requestId, { kind: 'elicitation-form', respond, fail, params, fields: mapped.fields });
      this.deps.emit({ chatId: live.chatId, type: 'question', request: { id: requestId, questions: mapped.questions } });
      return true;
    }
    this.deps.emit({
      chatId: live.chatId,
      type: 'error',
      message: `El servidor MCP «${serverName}» pidió una elicitation (modo ${String(params.mode ?? 'desconocido')}) que Latte no puede mostrar. ${message}`.trim(),
    });
    respond({ action: 'decline' });
    return true;
  }

  private settlePending(live: LiveChat, reason: string): void {
    for (const pending of live.pending.values()) {
      if (pending.kind === 'elicitation-url' || pending.kind === 'elicitation-form' || pending.kind === 'elicitation-empty-form') pending.respond({ action: 'cancel' });
      else pending.fail(reason);
    }
    live.pending.clear();
  }

  private pathsOfFileChange(live: LiveChat, itemId: string): string[] {
    for (const messageId of live.order) {
      const message = live.messages.get(messageId);
      const part = message?.parts.find((p) => p.type === 'tool' && p.id === itemId);
      if (part && part.type === 'tool' && part.title) return part.title.split(', ').slice(0, 10);
    }
    return [];
  }

  private ensureAssistant(live: LiveChat, messageId: string): ChatMessage {
    live.assistantId = messageId;
    const existing = live.messages.get(messageId);
    if (existing) return existing;
    const message: ChatMessage = { id: messageId, chatId: live.chatId, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null };
    this.upsertMessage(live, message);
    this.deps.emit({ chatId: live.chatId, type: 'message', message });
    return message;
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

  private upsertPart(live: LiveChat, messageId: string, part: ChatPart, silent: boolean): void {
    const message = live.messages.get(messageId) ?? this.ensureAssistant(live, messageId);
    const parts = message.parts.slice();
    const index = parts.findIndex((p) => p.id === part.id);
    if (index === -1) parts.push(part);
    else if (part.type === 'tool' && parts[index].type === 'tool') {
      const existing = parts[index] as Extract<ChatPart, { type: 'tool' }>;
      parts[index] = { ...part, output: part.output || existing.output };
    } else parts[index] = part;
    live.messages.set(messageId, { ...message, parts });
    if (!silent) this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[index === -1 ? parts.length - 1 : index] });
  }

  private applyDelta(live: LiveChat, params: Record<string, unknown>, kind: 'text' | 'reasoning'): void {
    const itemId = String(params.itemId ?? '');
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const turnId = typeof params.turnId === 'string' ? params.turnId : live.turnId;
    if (!itemId || !delta || !turnId) return;
    const messageId = `turn-${turnId}`;
    const message = live.messages.get(messageId) ?? this.ensureAssistant(live, messageId);
    const parts = message.parts.slice();
    const index = parts.findIndex((p) => p.id === itemId);
    if (index === -1) {
      parts.push({ type: kind, id: itemId, text: delta });
      live.messages.set(messageId, { ...message, parts });
      this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[parts.length - 1] });
      return;
    }
    const part = parts[index];
    if (part.type !== 'text' && part.type !== 'reasoning') return;
    parts[index] = { ...part, text: part.text + delta };
    live.messages.set(messageId, { ...message, parts });
    this.deps.emit({ chatId: live.chatId, type: 'delta', messageId, partId: itemId, delta });
  }

  private updateTool(live: LiveChat, itemId: string, update: (part: Extract<ChatPart, { type: 'tool' }>) => Extract<ChatPart, { type: 'tool' }>): void {
    for (const messageId of live.order) {
      const message = live.messages.get(messageId);
      if (!message) continue;
      const index = message.parts.findIndex((p) => p.type === 'tool' && p.id === itemId);
      if (index === -1) continue;
      const parts = message.parts.slice();
      parts[index] = update(parts[index] as Extract<ChatPart, { type: 'tool' }>);
      live.messages.set(messageId, { ...message, parts });
      this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[index] });
      return;
    }
  }
}

/** Maps a Codex ThreadItem to a UI part; user messages are handled separately. */
export function partFromItem(item: Record<string, unknown>): ChatPart | null {
  const id = String(item.id ?? '');
  if (!id) return null;
  switch (item.type) {
    case 'agentMessage':
      return { type: 'text', id, text: typeof item.text === 'string' ? item.text : '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === 'string').join('\n') : '';
      const content = Array.isArray(item.content) ? item.content.filter((s) => typeof s === 'string').join('\n') : '';
      return { type: 'reasoning', id, text: summary || content };
    }
    case 'commandExecution': {
      const status = mapStatus(item.status);
      const err = errorMessage(item.error);
      return { type: 'tool', id, tool: 'command', status, title: typeof item.command === 'string' ? item.command.slice(0, 160) : '', input: typeof item.command === 'string' ? item.command : '', output: clip(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''), error: status === 'error' ? (err || `exit code ${String(item.exitCode ?? '?')}`) : '' };
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const paths = changes.map((c) => String(c.path ?? '')).filter(Boolean);
      const diff = changes.map((c) => (typeof c.diff === 'string' ? c.diff : '')).join('\n');
      const status = mapStatus(item.status);
      const err = errorMessage(item.error);
      return { type: 'tool', id, tool: 'edit', status, title: paths.join(', ').slice(0, 200), input: clip(diff), output: '', error: status === 'error' ? (err || 'patch failed') : '' };
    }
    case 'mcpToolCall': {
      const status = mapStatus(item.status);
      return { type: 'tool', id, tool: `${String(item.server ?? 'mcp')}/${String(item.tool ?? 'tool')}`, status, title: '', input: stringify(item.arguments), output: clip(mcpToolOutput(item.result)), error: errorMessage(item.error) };
    }
    case 'webSearch':
      return { type: 'tool', id, tool: 'web_search', status: 'completed', title: typeof item.query === 'string' ? item.query : '', input: '', output: clip(stringify(item.results)), error: '' };
    case 'plan':
      return { type: 'reasoning', id, text: typeof item.text === 'string' ? item.text : '' };
    default:
      return null;
  }
}

function mapStatus(value: unknown): 'pending' | 'running' | 'completed' | 'error' {
  const s = String(value ?? '');
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'declined') return 'error';
  if (s === 'inProgress' || s === 'running') return 'running';
  return 'pending';
}

function clip(value: string): string {
  return value.length > TOOL_TEXT_LIMIT ? `${value.slice(0, TOOL_TEXT_LIMIT)}\n… [truncated]` : value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * `model/list` answers `{ data: [...] }`. Only the fields Latte shows are
 * taken, and a model the runtime marks as hidden is not offered: the list is
 * Codex's, not Latte's opinion of it.
 */
function parseModelList(result: unknown): AgentModel[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  const models: AgentModel[] = [];
  for (const entry of result.data) {
    if (!isRecord(entry) || entry.hidden === true) continue;
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : '';
    if (!id || models.some((m) => m.id === id)) continue;
    models.push({
      id,
      label: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id,
      description: typeof entry.description === 'string' ? entry.description : '',
      isDefault: entry.isDefault === true,
    });
  }
  return models;
}
