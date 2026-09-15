import path from 'node:path';
import type { AgentEvent, ChatEvent, DecisionProposalInput } from '../shared/contracts';
import { extractFencedBlocks } from './core/fenced';
import { brandContextProtocolBlocks } from './workspace/brandContextProtocol';
import { AccountStore } from './agents/accounts';
import { ClaudeChatAdapter } from './agents/claude/claudeAdapter';
import { CodexChatAdapter } from './agents/codex/codexAdapter';
import { AgentHub } from './agents/hub';
import { McpCatalog } from './agents/mcp';
import { ProfileStore } from './agents/profiles';
import { RoleCatalog } from './agents/roles';
import { TranscriptStore } from './agents/transcripts';
import { LattePaths } from './core/paths';
import { EngramClient } from './memory/engram';
import { ChatManager } from './opencode/chatManager';
import type { OpenCodeEndpoint } from './opencode/server';
import { execFileRunner, type CommandRunner } from './runtime/commandRunner';
import { RuntimeDetector } from './runtime/detect';
import { loadPty, type PtyLoadResult } from './runtime/ptyLoader';
import { TerminalManager } from './runtime/terminalManager';
import { LatteService } from './services/latteService';
import { seedDemoIfEmpty } from './services/seed';
import { prepareForMigration } from './storage/backup';
import { openDriver, type DriverPreference } from './storage/openDriver';
import { LearningRepository } from './storage/learningRepository';
import { LatteRepository } from './storage/repository';
import { SCHEMA_VERSION } from './storage/schema';
import { loadInstructionPack } from './workspace/packs';
import type { BrandContextPort } from '../shared/generationContracts';
import { WorkspaceFiles } from './workspace/workspace';

export interface BackendOptions {
  dataDir: string;
  emit: (event: AgentEvent) => void;
  /** Structured chat events; optional so older harnesses keep working. */
  emitChat?: (event: ChatEvent) => void;
  chooseExportPath: (suggestedFileName: string) => Promise<string | null>;
  /** Opens a native folder picker (desktop only). */
  chooseFolder?: (title: string) => Promise<string | null>;
  /** Opens a multi-select file dialog; returns the chosen absolute paths. */
  chooseFiles?: (title: string) => Promise<string[]>;
  /** Shows a folder in the system file manager. */
  revealPath?: (target: string) => Promise<void>;
  revealFile?: (target: string) => Promise<void>;
  confirmHtml?: (fileName: string) => Promise<boolean>;
  seedDemo?: boolean;
  driver?: DriverPreference;
  runner?: CommandRunner;
  loadPty?: () => PtyLoadResult;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Directory holding instruction packs (default: <repo>/packs). */
  packsDir?: string;
  /** Tests: reuse a running (fake) OpenCode endpoint instead of spawning the CLI. */
  chatEndpoint?: OpenCodeEndpoint;
  /** Opens an http(s) URL in the system browser (OAuth logins). */
  openExternal?: (url: string) => Promise<void>;
  log?: (line: string) => void;
  /** The running app's version, from `app.getVersion()`; tests pass a fixed string. */
  version: string;
  /** Tests inject a fake brand port so prepareGeneration never touches BrandingService. */
  brandContext?: BrandContextPort;
}

export interface Backend {
  service: LatteService;
  repo: LatteRepository;
  learning: LearningRepository;
  files: WorkspaceFiles;
  terminal: TerminalManager;
  detector: RuntimeDetector;
  chat: ChatManager;
  hub: AgentHub;
  accounts: AccountStore;
  info: { dataDir: string; dbFile: string; engine: string; engineReason: string; seeded: boolean; pack: string | null };
}

/** Wires every backend piece together. Used by main.ts and by the tests. */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  const paths = new LattePaths(options.dataDir);
  const { driver, reason } = await openDriver(paths.dbFile, options.driver ?? 'auto');
  const repo = new LatteRepository(driver);
  const learning = new LearningRepository(driver);
  // Updating the app can mean updating the schema. A copy is taken before the
  // first ALTER TABLE, and a database written by a newer Latte stops the start
  // here instead of being migrated backwards. A refused start closes its own
  // handle: leaving the file open would block the retry that follows.
  try {
    prepareForMigration(paths.dbFile, repo.storedSchemaVersion(), SCHEMA_VERSION, { log: options.log });
    repo.migrate();
  } catch (error) {
    try { driver.close(); } catch { /* nothing useful to do while failing */ }
    throw error;
  }

  const files = new WorkspaceFiles(paths);
  // Works linked to a user folder resolve there from the first read on.
  for (const linked of repo.linkedWorks()) files.linkWork(linked.id, linked.dir);
  const runner = options.runner ?? execFileRunner;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  const terminal = new TerminalManager({ loadPty: options.loadPty ?? loadPty, emit: options.emit, env, platform });
  const detector = new RuntimeDetector({ runner, terminalAvailability: () => terminal.availability(), platform, env });

  /**
   * Automatic mode: Latte answers the permission request instead of the human.
   *
   * The reply is always "once", never "always". A runtime that is told
   * "always" writes the grant down — Claude Code puts it in `.claude/` and
   * keeps it forever — so turning the mode off would leave permissions granted
   * behind the user's back. Answering once means every request keeps coming
   * here, and the moment the work goes back to `ask` the next one reaches the
   * human again.
   *
   * The request is not forwarded to the interface: a card that asks nothing is
   * noise. What the agent actually ran is already in the conversation, tool by
   * tool, and the banner says the mode is on.
   */
  const emitChat = (event: ChatEvent): void => {
    const forward = options.emitChat ?? (() => {});
    // An adapter counts only the process it runs; the member's lifetime total
    // is persisted, so the hub replaces it before the interface sees it.
    if (event.type === 'usage') { forward(hub.recordUsage(event)); return; }
    if (event.type === 'message' && event.message.role === 'assistant' && event.message.completed) {
      const assistantText = event.message.parts.filter(p=>p.type==='text').map(p=>(p as {text:string}).text).join('\n');
      for (const proposal of decisionProtocolBlocks(assistantText)) {
        void service.proposeDecisionFromAgent(event.chatId,event.message.id,proposal).catch(error=>options.log?.(`[latte] decision proposal failed: ${error instanceof Error?error.message:String(error)}`));
      }
      for (const proposal of brandContextProtocolBlocks(assistantText)) {
        void service.proposeBrandContextFromAgent(event.chatId,event.message.id,proposal).catch(error=>options.log?.(`[latte] brand context proposal failed: ${error instanceof Error?error.message:String(error)}`));
      }
    }
    // MCP URL elicitations are consent/login, not tool grants: auto mode must still show the card.
    if (event.type !== 'permission' || event.request.url || !service.autoApprovesChat(event.chatId)) { forward(event); return; }
    void hub.replyPermission(event.chatId, event.request.id, 'once').catch((error: unknown) => {
      // The conversation may have ended between the request and the answer.
      options.log?.(`[latte] auto-approval failed: ${error instanceof Error ? error.message : String(error)}`);
      forward(event);
    });
  };

  const chat = new ChatManager({
    resolveExecutable: async () => {
      const found = await detector.resolve('opencode');
      return found ? { executable: found.executable, version: found.version } : null;
    },
    serverCwd: paths.root,
    emit: (event) => emitChat(event),
    env,
    platform,
    endpoint: options.chatEndpoint,
    log: options.log,
  });

  const accounts = new AccountStore({
    root: path.join(paths.root, 'accounts'),
    runner,
    resolveExecutable: async (runtime) => (await detector.resolve(runtime))?.executable ?? null,
    env,
  });
  const transcripts = new TranscriptStore(path.join(paths.root, 'transcripts'));
  const claude = new ClaudeChatAdapter({
    resolveExecutable: async () => {
      const found = await detector.resolve('claude');
      return found ? { executable: found.executable, version: found.version } : null;
    },
    emit: (event) => emitChat(event),
    accountEnv: (accountId) => accounts.envFor('claude', accountId),
    onSessionId: (chatId, sessionId) => hub.rememberSession(chatId, sessionId),
    promptDir: path.join(paths.root, 'prompts'),
    transcripts,
    env,
    platform,
    log: options.log,
  });
  const codex = new CodexChatAdapter({
    resolveExecutable: async () => {
      const found = await detector.resolve('codex');
      return found ? { executable: found.executable, version: found.version } : null;
    },
    emit: (event) => emitChat(event),
    accountEnv: (accountId) => accounts.envFor('codex', accountId),
    serverCwd: paths.root,
    env,
    platform,
    log: options.log,
    openExternal: options.openExternal,
  });
  const packsDir = options.packsDir ?? path.resolve(__dirname, '..', 'packs');
  const pack = loadInstructionPack(packsDir, 'marketing-core');
  const roles = new RoleCatalog(pack, new ProfileStore(path.join(paths.root, 'agents')));
  const hub: AgentHub = new AgentHub({ opencode: chat, claude, codex, accounts, repo, detector, terminal, runner, roles, transcripts, promptDir: path.join(paths.root, 'prompts'), loginCwd: paths.root, env });

  const mcp = new McpCatalog({
    runner,
    detector,
    accountEnv: (runtime, accountId) => accounts.envFor(runtime, accountId),
    env,
    codex: {
      listMcpStatus: (accountId) => codex.listMcpStatus(accountId),
      startMcpLogin: (accountId, name) => codex.startMcpOauthLogin(accountId, name),
    },
    claudeMcpFromInit: () => claude.mcpServersFromInit(),
    startTerminal: (input) => terminal.start(input),
  });

  const engram = new EngramClient({
    runner,
    locate: () => locateExecutable(runner, 'engram', platform, env),
  });

  const service = new LatteService({
    repo,
    learning,
    files,
    detector,
    terminal,
    chat,
    hub,
    engram,
    mcp,
    pack,
    engineReason: reason,
    version: options.version,
    chooseExportPath: options.chooseExportPath,
    chooseFolder: options.chooseFolder,
    chooseFiles: options.chooseFiles,
    revealPath: options.revealPath,
    revealFile: options.revealFile,
    confirmHtml: options.confirmHtml,
    openExternal: options.openExternal,
    brandContext: options.brandContext,
  });

  const seeded = options.seedDemo === false ? false : seedDemoIfEmpty(repo, files, pack);

  return {
    service,
    repo,
    learning,
    files,
    terminal,
    detector,
    chat,
    hub,
    accounts,
    info: { dataDir: paths.root, dbFile: paths.dbFile, engine: driver.kind, engineReason: reason, seeded, pack: pack ? `${pack.id}@${pack.version}` : null },
  };
}

/** Explicit structured fallback shared by runtimes until their native SDKs can register an in-process Latte tool. */
export function decisionProtocolBlocks(text:string):DecisionProposalInput[] {
  const out:DecisionProposalInput[]=[];
  for (const body of extractFencedBlocks('latte-decision', text)) {
    try {
      const v:unknown=JSON.parse(body); if(!v||typeof v!=='object') continue; const x=v as Record<string,unknown>; if(typeof x.statement!=='string'||typeof x.rationale!=='string'||typeof x.clientRequestId!=='string') continue; out.push({statement:x.statement,rationale:x.rationale,clientRequestId:x.clientRequestId,...(Array.isArray(x.alternativesRejected)?{alternativesRejected:x.alternativesRejected.filter((z):z is string=>typeof z==='string')}:{}),...(Array.isArray(x.evidenceRefs)?{evidenceRefs:x.evidenceRefs.filter((z):z is string=>typeof z==='string')}:{})});
    } catch { /* malformed blocks are inert, never guessed */ }
  }
  return out;
}

async function locateExecutable(runner: CommandRunner, name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runner(platform === 'win32' ? 'where.exe' : 'which', [name], { timeoutMs: 4_000, env });
  if (result.error || result.timedOut || result.code !== 0) return null;
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const candidate = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && isAbsolute(l));
  return candidate ?? null;
}
