import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type ChatEvent, type ChatMessage, type ChatPart, type ChatUsage, type PermissionReply } from '../../../shared/contracts';
import { writeFileAtomic } from '../../core/atomicFile';
import { NotFoundError, UnavailableError, ValidationError } from '../../core/errors';
import { newId } from '../../core/ids';
import { killProcessTree, spawnInOwnProcessGroup } from '../../core/processTree';
import { addUsage, tokenCount } from '../../core/usage';
import { spawnSpecFor } from '../../runtime/commandRunner';
import { scrubEnv } from '../../runtime/terminalManager';
import { claudeArgsForTier, claudeSupportsMcpInjection } from '../tiers';
import type { TranscriptStore } from '../transcripts';
import { sessionFrom, type AdapterMcpServer, type AdapterStartInput, type AdapterStartResult, type RuntimeAdapter } from '../types';

export interface ClaudeAdapterDeps {
  resolveExecutable: () => Promise<{ executable: string; version: string | null } | null>;
  emit: (event: ChatEvent) => void;
  /** Environment overlay for the chosen account (CLAUDE_CONFIG_DIR for managed profiles). */
  accountEnv: (accountId: string | null) => Record<string, string>;
  /** Called once the CLI reveals its session id, so the hub can persist it for resume. */
  onSessionId?: (chatId: string, sessionId: string) => void;
  /**
   * Where role prompts are written for `--append-system-prompt-file` (one file
   * per chat, Latte-owned). Without it the prompt goes inline on the command line.
   */
  promptDir?: string;
  /**
   * Local record of what the pane showed. Claude Code resumes the model's
   * context but replays no earlier turn, so without this a resumed member
   * comes back with an empty transcript.
   */
  transcripts?: TranscriptStore;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  log?: (line: string) => void;
  maxChats?: number;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  suggestions: unknown[] | null;
}

interface LiveChat {
  chatId: string;
  workId: string;
  child: ChildProcess;
  messages: Map<string, ChatMessage>;
  order: string[];
  currentMessageId: string | null;
  blockTypes: Map<string, 'text' | 'reasoning' | 'tool'>;
  toolInputJson: Map<string, string>;
  pending: Map<string, PendingPermission>;
  sessionId: string | null;
  busy: boolean;
  closed: boolean;
  buffer: string;
  /** Ids already written to the transcript, to append each turn once. */
  recorded: Set<string>;
  /** Messages restored from the transcript; they are shown but never re-recorded. */
  restored: number;
  restoredIds: Set<string>;
  /**
   * Per-open prefix for recorded ids. The CLI restarts its own message ids on
   * every process, so without this a new turn would silently overwrite a
   * restored one that happens to share the id.
   */
  epoch: string;
  mcpServers: Array<{ name: string; status: string }>;
  /** The coordination mcp-config file written for this chat, if any. Deleted when the chat ends. */
  mcpConfigFile: string | null;
  /** What this process has consumed since it started. The lifetime total is the hub's job. */
  usage: ChatUsage;
  /**
   * Last `total_cost_usd` this process reported. The CLI prices the whole
   * process on every result, so a turn costs the difference; without this the
   * second turn would be charged for the first one again.
   */
  costSoFar: number | null;
}

const MESSAGE_LIMIT = 400;
const TOOL_TEXT_LIMIT = 12_000;

export const CLAUDE_HEADLESS_ARGS = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode', 'manual',
  '--permission-prompt-tool', 'stdio',
];

/**
 * What "read and write in this folder" grants, when the human asked for it.
 *
 * The patterns are relative to the process cwd, which is the work directory.
 * Measured against a real `claude`, not assumed: with them a write inside the
 * folder stops prompting, and a read or write one level up still prompts, as
 * does every tool absent from this list (Bash, WebFetch, MCP).
 */
export const FOLDER_TOOLS = ['Read(./**)', 'Write(./**)', 'Edit(./**)'];

/**
 * Claude Code as a chat runtime: one headless `claude` process per chat,
 * speaking the stream-json protocol over stdio. The user's own subscription
 * login is used (system profile or a Latte-managed CLAUDE_CONFIG_DIR); Latte
 * never sees tokens. Permission prompts arrive as control requests and are
 * answered from the UI.
 */
export class ClaudeChatAdapter implements RuntimeAdapter {
  readonly runtime = 'claude' as const;
  // Task 4.1's baseline was 'none'; the translation (tasks 4.2-4.4) was real
  // and tested but flipping this flag was deliberately left for Phase 6
  // (task 6.23), since nothing read it yet. It flips now: engram ships BY
  // DEFAULT to every Claude member (design-v2-conversational D3), and
  // nothing about that decision is gated on coordination, so this adapter
  // must always be able to receive an mcpServers array, run or no run,
  // coordination flag on or off. Nothing calls coordinationRuntimeSupport's
  // eligibility rules from here — that stays hub wiring's job (6f/6.29+);
  // this field only says the adapter CAN translate whatever it is given.
  readonly mcpInjection = 'per-member' as const;
  private readonly chats = new Map<string, LiveChat>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly maxChats: number;

  constructor(private readonly deps: ClaudeAdapterDeps) {
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

  /** Last `mcp_servers` array from each live `system/init`, later chats win on name. */
  mcpServersFromInit(): Array<{ name: string; status: string }> {
    const byName = new Map<string, string>();
    for (const live of this.chats.values()) {
      for (const server of live.mcpServers) byName.set(server.name, server.status);
    }
    return [...byName.entries()].map(([name, status]) => ({ name, status }));
  }

  async start(input: AdapterStartInput): Promise<AdapterStartResult> {
    if (this.chats.size >= this.maxChats) throw new ValidationError(`Too many open Claude chats (max ${this.maxChats})`);
    const chatId = input.chatId ?? newId('ses');
    if (this.chats.has(chatId)) throw new ValidationError('This chat is already open');
    const runtime = await this.deps.resolveExecutable();
    if (!runtime) throw new UnavailableError('Claude Code is not installed or not on PATH');

    const args = [...CLAUDE_HEADLESS_ARGS];
    if (input.trustedFolder) args.push('--allowedTools', ...FOLDER_TOOLS);
    if (input.previousSessionId) args.push('--resume', input.previousSessionId);
    // The tier decides the model when the human did not, and the effort always.
    args.push(...claudeArgsForTier(input.tier ?? DEFAULT_EFFORT_TIER, input.model ?? null, runtime.version));
    const instructions = input.instructions?.trim() ?? '';
    if (instructions) {
      // The role personality is appended to Claude's own system prompt. A file
      // keeps multi-line text off the command line (and out of process lists).
      const promptFile = this.deps.promptDir ? this.writePromptFile(chatId, instructions) : null;
      if (promptFile) args.push('--append-system-prompt-file', promptFile);
      else args.push('--append-system-prompt', instructions);
    }
    // MCP injection (sdd/autonomous-coordination, Phase 4; the http|stdio
    // union and engram-by-default, Phase 6 task 6.21-6.23). Only
    // `--mcp-config` is pushed, NEVER `--strict-mcp-config`: strict mode would
    // also strip the human's own MCP servers from this member for the whole
    // session, a capability removal AGENTS.md forbids. Isolation of Latte's
    // own coordination tool comes from the per-member bearer token inside the
    // file, not from strict mode (design decision, sdd/autonomous-coordination/design).
    // The token itself never touches argv: it is off in the config file, and
    // the version floor guards against a headless process hanging forever on
    // an approval prompt no human can answer. `latte_memory` (engram) carries
    // no token at all and rides the SAME file/flag — see writeMcpConfigFile.
    let mcpConfigFile: string | null = null;
    if (input.mcpServers && input.mcpServers.length > 0) {
      if (!claudeSupportsMcpInjection(runtime.version)) {
        this.deps.log?.(`[claude ${chatId}] CLI ${runtime.version ?? 'unknown'} predates 2.1.246, MCP servers not injected this session`);
      } else if (!this.deps.promptDir) {
        this.deps.log?.(`[claude ${chatId}] no promptDir configured, MCP servers not injected this session`);
      } else {
        mcpConfigFile = this.writeMcpConfigFile(chatId, input.mcpServers);
      }
    }
    if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
    const spec = spawnSpecFor(runtime.executable, args, this.platform, this.env);
    const env = { ...scrubEnv(this.env), ...this.deps.accountEnv(input.accountId ?? null), ...(input.extraEnv ?? {}) };

    let child: ChildProcess;
    try {
      child = spawnInOwnProcessGroup(this.deps.spawnImpl ?? spawn, spec.file, spec.args, { cwd: input.directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, this.platform);
    } catch (error) {
      throw new UnavailableError(`Could not start Claude Code: ${describe(error)}`);
    }

    const live: LiveChat = {
      chatId,
      workId: input.workId,
      child,
      messages: new Map(),
      order: [],
      currentMessageId: null,
      blockTypes: new Map(),
      toolInputJson: new Map(),
      pending: new Map(),
      sessionId: input.previousSessionId ?? null,
      busy: false,
      closed: false,
      buffer: '',
      recorded: new Set(),
      restored: 0,
      restoredIds: new Set(),
      epoch: randomUUID().slice(0, 8),
      mcpServers: [],
      mcpConfigFile,
      usage: EMPTY_USAGE,
      costSoFar: null,
    };
    // Resuming: put the earlier turns back on screen before the first new one.
    if (input.previousSessionId && this.deps.transcripts) {
      for (const message of this.deps.transcripts.load(chatId)) {
        const restored = { ...message, chatId };
        live.messages.set(restored.id, restored);
        live.order.push(restored.id);
        live.restoredIds.add(restored.id);
      }
      live.restored = live.order.length;
    }
    this.chats.set(chatId, live);

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(live, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.deps.log?.(`[claude ${chatId}] ${chunk.toString('utf8').trim().slice(0, 300)}`));
    child.on('error', (error) => {
      this.deps.emit({ chatId, type: 'error', message: `Claude Code process error: ${error.message}` });
      this.finish(live, `process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (live.closed) return;
      const reason = `Claude Code exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`;
      if (live.busy) this.deps.emit({ chatId, type: 'error', message: reason });
      this.finish(live, reason);
    });

    const session = {
      ...sessionFrom(input, 'claude', input.model ?? null, input.accountId ?? null, input.label, Boolean(input.previousSessionId)),
      id: chatId,
      // Honest about legacy sessions: resumed in the runtime, but with no local record to show.
      historyRecovered: live.restored > 0,
    };
    return { session, runtimeSessionId: input.previousSessionId ?? '' };
  }

  listMessages(chatId: string): ChatMessage[] {
    const live = this.require(chatId);
    return live.order.map((id) => live.messages.get(id)).filter((m): m is ChatMessage => m !== undefined);
  }

  async send(chatId: string, text: string): Promise<void> {
    const live = this.require(chatId);
    if (live.closed) throw new UnavailableError('This Claude chat has ended. Start it again to continue.');
    if (live.busy) throw new ValidationError('Claude is still working on the previous message');
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
    this.write(live, { type: 'user', message: { role: 'user', content: text } });
  }

  async abort(chatId: string): Promise<void> {
    const live = this.require(chatId);
    if (live.closed) return;
    this.write(live, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  async replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const live = this.require(chatId);
    const pending = live.pending.get(requestId);
    if (!pending) throw new NotFoundError('Permission request', requestId);
    const response = reply === 'reject'
      ? { behavior: 'deny', message: 'The user declined this action in Latte.' }
      : { behavior: 'allow', updatedInput: pending.input, ...(reply === 'always' && pending.suggestions ? { updatedPermissions: pending.suggestions } : {}) };
    this.write(live, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    live.pending.delete(requestId);
    this.deps.emit({ chatId, type: 'permission-resolved', requestId });
  }

  async replyQuestion(chatId: string, requestId: string, _answers: string[][] | null): Promise<void> {
    this.require(chatId);
    throw new NotFoundError('Question', requestId);
  }

  stop(chatId: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.finish(live, 'stopped');
  }

  shutdown(): void {
    for (const id of [...this.chats.keys()]) this.stop(id);
  }

  // Internals ---------------------------------------------------------------

  private require(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new NotFoundError('Chat', chatId);
    return live;
  }

  /**
   * One line per turn, under an id that is unique across opens. Restored
   * messages are never re-recorded, so a transcript never grows duplicates.
   */
  private record(live: LiveChat, message: ChatMessage): void {
    if (!this.deps.transcripts) return;
    if (live.restoredIds.has(message.id)) return;
    const id = `${live.epoch}-${message.id}`;
    if (message.role === 'user' && live.recorded.has(id)) return;
    live.recorded.add(id);
    this.deps.transcripts.append(live.chatId, { ...message, id });
  }

  private writePromptFile(chatId: string, instructions: string): string | null {
    try {
      const dir = this.deps.promptDir as string;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${chatId}.md`);
      writeFileAtomic(file, `${instructions}
`);
      return file;
    } catch (error) {
      this.deps.log?.(`[claude ${chatId}] prompt file failed, using inline prompt: ${describe(error)}`);
      return null;
    }
  }

  /**
   * The MCP server(s) for this chat alone, in the shape Claude Code's
   * `--mcp-config` expects. Both kinds ride in the SAME file (task 6.22):
   * Claude's `--mcp-config` format already supports an `http` entry and a
   * `stdio` entry side by side, so `latte_coordination` and `latte_memory`
   * cost no second seam. Written next to the prompt file so it dies with
   * the session; mode 0600 because the file can hold a live bearer token
   * and, unlike the prompt text, is not meant for anything but this process
   * to read. No inline-JSON fallback: the token would then sit in argv,
   * exactly what this whole design keeps off the command line.
   */
  private writeMcpConfigFile(chatId: string, servers: AdapterMcpServer[]): string | null {
    try {
      const dir = this.deps.promptDir as string;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${chatId}.mcp.json`);
      const mcpServers: Record<string, unknown> = {};
      for (const server of servers) {
        mcpServers[server.name] = server.kind === 'http'
          ? { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } }
          : { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) };
      }
      writeFileAtomic(file, JSON.stringify({ mcpServers }));
      try { fs.chmodSync(file, 0o600); } catch { /* best-effort; some filesystems ignore it */ }
      return file;
    } catch (error) {
      this.deps.log?.(`[claude ${chatId}] mcp config file failed, MCP servers not injected this session: ${describe(error)}`);
      return null;
    }
  }

  private write(live: LiveChat, payload: unknown): void {
    try {
      live.child.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.deps.emit({ chatId: live.chatId, type: 'error', message: `Could not write to Claude Code: ${describe(error)}` });
    }
  }

  private finish(live: LiveChat, reason: string): void {
    if (live.closed) return;
    live.closed = true;
    live.busy = false;
    this.chats.delete(live.chatId);
    try { live.child.stdin?.end(); } catch { /* ignore */ }
    killProcessTree(live.child, this.platform);
    // The bearer token lives only in this file. It must not outlive the chat.
    if (live.mcpConfigFile) { try { fs.rmSync(live.mcpConfigFile, { force: true }); } catch { /* ignore */ } }
    this.deps.emit({ chatId: live.chatId, type: 'closed', reason });
  }

  private onStdout(live: LiveChat, chunk: Buffer): void {
    live.buffer += chunk.toString('utf8');
    let nl = live.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = live.buffer.slice(0, nl).trim();
      live.buffer = live.buffer.slice(nl + 1);
      nl = live.buffer.indexOf('\n');
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.deps.log?.(`[claude ${live.chatId}] non-json: ${line.slice(0, 120)}`);
        continue;
      }
      try {
        this.handle(live, msg);
      } catch (error) {
        this.deps.log?.(`[claude ${live.chatId}] handler failed: ${describe(error)}`);
      }
    }
  }

  private handle(live: LiveChat, msg: Record<string, unknown>): void {
    const chatId = live.chatId;
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
          if (live.sessionId !== msg.session_id) {
            live.sessionId = msg.session_id;
            this.deps.onSessionId?.(live.chatId, msg.session_id);
          }
          live.mcpServers = parseInitMcpServers(msg.mcp_servers);
        } else if (msg.subtype === 'permission_denied') {
          const toolUseId = str(msg.tool_use_id);
          const message = str(msg.message, 'Permission denied');
          this.updateTool(live, toolUseId, (part) => ({ ...part, status: 'error', error: message }));
        } else if (msg.subtype === 'status' && msg.status === 'requesting' && !live.busy) {
          live.busy = true;
          this.deps.emit({ chatId, type: 'status', status: 'busy', detail: '' });
        }
        return;
      }
      case 'stream_event': {
        const event = isRecord(msg.event) ? msg.event : null;
        if (!event) return;
        this.handleStreamEvent(live, event);
        return;
      }
      case 'assistant': {
        const message = isRecord(msg.message) ? msg.message : null;
        if (!message || typeof message.id !== 'string') return;
        this.ensureAssistant(live, message.id);
        const content = Array.isArray(message.content) ? message.content : [];
        content.forEach((block, index) => {
          if (!isRecord(block)) return;
          const part = this.partFromBlock(message.id as string, index, block);
          if (part) this.settlePart(live, message.id as string, part);
        });
        return;
      }
      case 'user': {
        const message = isRecord(msg.message) ? msg.message : null;
        const content = message && Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue;
          const toolUseId = str(block.tool_use_id);
          const output = clip(flattenContent(block.content));
          const isError = block.is_error === true;
          this.updateTool(live, toolUseId, (part) => ({ ...part, status: isError ? 'error' : 'completed', output: isError ? part.output : output, error: isError ? output : part.error }));
        }
        return;
      }
      case 'control_request': {
        const request = isRecord(msg.request) ? msg.request : null;
        const requestId = str(msg.request_id);
        if (!request || !requestId) return;
        if (request.subtype === 'can_use_tool') {
          const toolName = str(request.tool_name, 'tool');
          const input = request.input;
          live.pending.set(requestId, { requestId, toolName, input, suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : null });
          this.deps.emit({
            chatId,
            type: 'permission',
            request: {
              id: requestId,
              permission: toolName,
              patterns: patternsFromInput(input),
              always: Array.isArray(request.permission_suggestions) && request.permission_suggestions.length > 0 ? ['session'] : [],
              title: str(request.description) || str(request.display_name) || toolName,
            },
          });
        } else {
          // Anything we do not implement must still be answered or the CLI blocks.
          this.write(live, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Latte does not handle ${str(request.subtype, 'this request')}` } });
        }
        return;
      }
      case 'result': {
        live.busy = false;
        if (live.currentMessageId) {
          const current = live.messages.get(live.currentMessageId);
          if (current) {
            const completed = { ...current, completed: true, error: msg.is_error === true ? str(msg.result, 'Claude Code reported an error') : current.error };
            live.messages.set(current.id, completed);
            this.record(live, completed);
            this.deps.emit({ chatId, type: 'message', message: completed });
          }
        }
        this.reportUsage(live, msg);
        if (msg.is_error === true) this.deps.emit({ chatId, type: 'error', message: str(msg.result, 'Claude Code reported an error') });
        this.deps.emit({ chatId, type: 'status', status: 'idle', detail: '' });
        return;
      }
      default:
        return;
    }
  }

  /**
   * What the turn that just ended actually consumed, as the CLI counted it.
   *
   * The `result` message carries `usage` with Anthropic's own four numbers
   * plus `total_cost_usd` for the whole process. Latte adds nothing of its
   * own: no estimate from text length, no guess when a field is missing. A
   * result without `usage` (an early abort, an old CLI) reports nothing rather
   * than reporting zeros, which would read as "this turn was free".
   */
  private reportUsage(live: LiveChat, msg: Record<string, unknown>): void {
    const raw = isRecord(msg.usage) ? msg.usage : null;
    if (!raw) return;
    const inputTokens = tokenCount(raw.input_tokens);
    const outputTokens = tokenCount(raw.output_tokens);
    const cacheReadTokens = tokenCount(raw.cache_read_input_tokens);
    const cacheWriteTokens = tokenCount(raw.cache_creation_input_tokens);
    const reported = typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : null;
    // The cost of this turn is what the process total grew by. A total that
    // went backwards (a CLI that restarts its own counter) is not a refund.
    const delta = reported === null ? null : reported - (live.costSoFar ?? 0);
    if (reported !== null) live.costSoFar = reported;
    const turn: ChatUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      turns: 1,
      costUsd: delta !== null && delta > 0 ? delta : null,
      // What the model re-read to answer: fresh input plus everything the
      // cache handed it. This is the number that says why a long conversation
      // gets expensive even when the answers stay short.
      contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    };
    live.usage = addUsage(live.usage, turn);
    this.deps.emit({ chatId: live.chatId, type: 'usage', turn, total: live.usage });
  }

  private handleStreamEvent(live: LiveChat, event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : null;
        if (message && typeof message.id === 'string') this.ensureAssistant(live, message.id);
        return;
      }
      case 'content_block_start': {
        const messageId = live.currentMessageId;
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (!messageId || !block || typeof event.index !== 'number') return;
        const part = this.partFromBlock(messageId, event.index, block);
        if (part) this.upsertPart(live, messageId, part);
        return;
      }
      case 'content_block_delta': {
        const messageId = live.currentMessageId;
        const delta = isRecord(event.delta) ? event.delta : null;
        if (!messageId || !delta || typeof event.index !== 'number') return;
        const partId = blockPartId(messageId, event.index);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.applyDelta(live, messageId, partId, 'text', delta.text);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.applyDelta(live, messageId, partId, 'reasoning', delta.thinking);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          live.toolInputJson.set(partId, (live.toolInputJson.get(partId) ?? '') + delta.partial_json);
        }
        return;
      }
      default:
        return;
    }
  }

  private ensureAssistant(live: LiveChat, messageId: string): void {
    live.currentMessageId = messageId;
    if (live.messages.has(messageId)) return;
    const message: ChatMessage = { id: messageId, chatId: live.chatId, role: 'assistant', parts: [], createdAt: new Date().toISOString(), completed: false, error: null };
    this.upsertMessage(live, message);
    this.deps.emit({ chatId: live.chatId, type: 'message', message });
  }

  private partFromBlock(messageId: string, index: number, block: Record<string, unknown>): ChatPart | null {
    const id = blockPartId(messageId, index);
    switch (block.type) {
      case 'text':
        return { type: 'text', id, text: str(block.text) };
      case 'thinking':
        return { type: 'reasoning', id, text: str(block.thinking) };
      case 'tool_use': {
        const toolId = str(block.id) || id;
        return { type: 'tool', id: toolId, tool: str(block.name, 'tool'), status: 'running', title: titleFromInput(block.input), input: stringify(block.input), output: '', error: '' };
      }
      default:
        return null;
    }
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
    const message = live.messages.get(messageId);
    if (!message) return;
    const parts = message.parts.slice();
    const index = parts.findIndex((p) => p.id === part.id);
    if (index === -1) parts.push(part);
    else if (part.type === 'tool' && parts[index].type === 'tool') {
      const existing = parts[index] as Extract<ChatPart, { type: 'tool' }>;
      parts[index] = { ...part, status: existing.status === 'completed' || existing.status === 'error' ? existing.status : part.status, output: existing.output || part.output, error: existing.error || part.error };
    } else parts[index] = part;
    const updated = { ...message, parts };
    live.messages.set(messageId, updated);
    const emitted = parts[index === -1 ? parts.length - 1 : index];
    this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: emitted });
  }

  /**
   * Settles a block from the final `assistant` message onto what streamed.
   *
   * The two channels number blocks independently: the stream numbers them by
   * their place in the turn, the final message by their place in its own
   * `content` array. A thinking block first is enough to shift them, and then
   * the same answer arrives under a second id and is printed twice. So a text
   * or reasoning block first looks for the streamed part it finishes — same
   * kind, and what streamed is a prefix of what arrived — and completes that
   * one. Tool blocks keep their own tool id and never need this.
   */
  private settlePart(live: LiveChat, messageId: string, part: ChatPart): void {
    const message = live.messages.get(messageId);
    if (message && (part.type === 'text' || part.type === 'reasoning')) {
      const streamed = message.parts.find((p) => p.type === part.type && p.id !== part.id && part.text.startsWith(p.text));
      if (streamed) {
        this.applyDelta(live, messageId, streamed.id, part.type, part.text.slice((streamed as { text: string }).text.length));
        return;
      }
    }
    this.upsertPart(live, messageId, part);
  }

  private applyDelta(live: LiveChat, messageId: string, partId: string, kind: 'text' | 'reasoning', delta: string): void {
    const message = live.messages.get(messageId);
    if (!message) return;
    const parts = message.parts.slice();
    const index = parts.findIndex((p) => p.id === partId);
    if (index === -1) {
      parts.push({ type: kind, id: partId, text: delta });
      live.messages.set(messageId, { ...message, parts });
      this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[parts.length - 1] });
      return;
    }
    const part = parts[index];
    if (part.type !== 'text' && part.type !== 'reasoning') return;
    parts[index] = { ...part, text: part.text + delta };
    live.messages.set(messageId, { ...message, parts });
    this.deps.emit({ chatId: live.chatId, type: 'delta', messageId, partId, delta });
  }

  private updateTool(live: LiveChat, toolUseId: string, update: (part: Extract<ChatPart, { type: 'tool' }>) => Extract<ChatPart, { type: 'tool' }>): void {
    if (!toolUseId) return;
    for (const messageId of live.order) {
      const message = live.messages.get(messageId);
      if (!message) continue;
      const index = message.parts.findIndex((p) => p.type === 'tool' && p.id === toolUseId);
      if (index === -1) continue;
      const parts = message.parts.slice();
      parts[index] = update(parts[index] as Extract<ChatPart, { type: 'tool' }>);
      live.messages.set(messageId, { ...message, parts });
      this.deps.emit({ chatId: live.chatId, type: 'part', messageId, part: parts[index] });
      return;
    }
  }
}

function blockPartId(messageId: string, index: number): string {
  return `${messageId}#${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
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

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function titleFromInput(input: unknown): string {
  if (!isRecord(input)) return '';
  for (const key of ['description', 'file_path', 'path', 'command', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key]) return String(input[key]).slice(0, 160);
  }
  return '';
}

function patternsFromInput(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url']) {
    if (typeof input[key] === 'string' && input[key]) out.push(String(input[key]).slice(0, 200));
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseInitMcpServers(raw: unknown): Array<{ name: string; status: string }> {
  if (!Array.isArray(raw)) return [];
  const servers: Array<{ name: string; status: string }> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue;
    servers.push({ name: entry.name, status: typeof entry.status === 'string' ? entry.status : '' });
  }
  return servers;
}
