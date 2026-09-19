import path from 'node:path';
import type { AgentEvent, ChatEvent, CoordinationEvent, DecisionProposalInput } from '../shared/contracts';
import { extractFencedBlocks } from './core/fenced';
import { brandContextProtocolBlocks } from './workspace/brandContextProtocol';
import { AccountStore } from './agents/accounts';
import { ClaudeChatAdapter } from './agents/claude/claudeAdapter';
import { CodexChatAdapter } from './agents/codex/codexAdapter';
import { sweepStrayCodexServers } from './agents/codex/staleServers';
import { AgentHub } from './agents/hub';
import { McpCatalog } from './agents/mcp';
import { ProfileStore } from './agents/profiles';
import { RoleCatalog } from './agents/roles';
import { TranscriptStore } from './agents/transcripts';
import { CoordinationInjectionPlanner } from './coordination/injection';
import { CoordinationMcpServer } from './coordination/mcpServer';
import { createHttpListen } from './coordination/mcpTransport';
import { CoordinationTokenRegistry } from './coordination/tokens';
import { featureEnabled } from './core/features';
import { LattePaths } from './core/paths';
import type { TaskkillExecFile } from './core/processTree';
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
  /** sdd/autonomous-coordination, task 6.37: a run/task/dispatch/gate change. Optional so older harnesses (and every test) keep working unchanged. */
  emitCoordination?: (event: CoordinationEvent) => void;
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
  /** Tests inject a fake taskkill for the startup stray-codex-app-server sweep (sdd/autonomous-coordination, task 5.8), so no real OS process is ever touched in a test. */
  taskkillImpl?: TaskkillExecFile;
  /** Q7: los tests inyectan su propio timer del barrido periódico de coordinación y disparan el tick a mano, en vez de esperar treinta segundos reales. */
  sweepTimer?: (tick: () => void, everyMs: number) => () => void;
}

export interface Backend {
  service: LatteService;
  /**
   * El chokepoint por el que pasa TODO evento de chat antes de llegar a la
   * interfaz. Expuesto para que el camino de muerte de proceso (un `closed`
   * de un adaptador -> `hub.stop` -> `injection.release`, juicio #8) se pueda
   * probar sin spawnear un runtime real.
   */
  emitChat: (event: ChatEvent) => void;
  repo: LatteRepository;
  learning: LearningRepository;
  files: WorkspaceFiles;
  terminal: TerminalManager;
  detector: RuntimeDetector;
  chat: ChatManager;
  hub: AgentHub;
  /** Exposed alongside `hub` so tests can spy on `start()` directly instead of spawning a real (or fake-CLI) process. */
  claude: ClaudeChatAdapter;
  codex: CodexChatAdapter | null;
  accounts: AccountStore;
  /**
   * El servidor MCP REAL, el que sirve todo `tools/call` de todo miembro
   * coordinado. Expuesto para que un test pueda entrar por el camino de
   * producción (`handleMcpRequest` sobre ESTE servidor, con ESTE motor) en vez
   * de construirse uno de costado que no comparte el estado en memoria del
   * motor del servicio (R1).
   */
  coordinationMcpServer: CoordinationMcpServer;
  /** El registro de tokens de ESE servidor: sin él no se puede mintear un bearer que `handleMcpRequest` acepte. */
  coordinationTokens: CoordinationTokenRegistry;
  info: { dataDir: string; dbFile: string; engine: string; engineReason: string; seeded: boolean; pack: string | null };
}

/** Wires every backend piece together. Used by main.ts and by the tests. */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  const paths = new LattePaths(options.dataDir);
  // sdd/autonomous-coordination, task 5.8: reap any codex app-server this
  // data directory spawned in a previous run that never cleaned up (a
  // crash, a force-quit) before anything new might reuse the same pid-file
  // bookkeeping. Independent of the DB, so it runs before the migration.
  sweepStrayCodexServers(paths.root, { platform: options.platform ?? process.platform, taskkillImpl: options.taskkillImpl, log: options.log });
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
    // Juicio #8, ronda 4: este era el UNICO camino por el que la muerte de un
    // proceso podia llegar al hub, y solo manejaba `usage` y `message`. Un
    // `{type:'closed'}` de `ClaudeChatAdapter.finish` o de
    // `CodexAppServer.onExit` no llegaba nunca a `hub.stop`, y por lo tanto
    // tampoco a `injection.release`: el miembro caido se quedaba con su
    // reclamo, su bearer token (que no vence), su cupo de techo y su cupo de
    // memoria. Despues de seis muertes asi, `totalCoordinated()` alcanzaba
    // MAX_COORDINATED_CODEX_PROCESSES PARA SIEMPRE y ningun miembro volvia a
    // recibir coordinacion; y `tokens` nunca llegaba a cero, asi que
    // `stopIfIdle` tampoco podia cerrar el listener de loopback.
    // `hub.stop` es idempotente: el adaptador ya se borro a si mismo, asi que
    // el loop no encuentra duenio y esto no reentra.
    // Y crítico 5: soltar el reclamo de inyección no alcanzaba. El despacho que
    // ese miembro tenía en vuelo se quedaba `dispatched` con su reserva abierta
    // por el resto de la sesión — sin reintento, con el cupo de presupuesto
    // quemado y el run sin poder terminar nunca. `settleUncertain` documentaba
    // un modo `incrementAttempts:true` "para la muerte de un proceso" y no tenía
    // un solo llamador; éste es. Va DESPUÉS de `hub.stop` a propósito: primero
    // se suelta lo del proceso, después se cierran las cuentas.
    if (event.type === 'closed') {
      // R8: CADA LLAMADA EN SU PROPIO TRY, Y EL AVISO SIEMPRE. Las tres cosas
      // que pasan acá antes de reenviar el evento escriben en la base, y
      // ninguna estaba protegida: si cualquiera tiraba —la base trabada, una
      // fila que ya no está, un constraint— el `forward(event)` de abajo no
      // corría, y el renderer no se enteraba NUNCA de que el miembro se había
      // muerto. La persona se quedaba mirando un agente "trabajando" que ya no
      // existe. Contabilidad y aviso son independientes: que las cuentas no
      // cierren no puede ser razón para ocultarle a la persona que su agente se
      // cayó, y cada paso tampoco puede quedar rehén del anterior.
      const guard = (what: string, fn: () => void): void => {
        try { fn(); } catch (error) { options.log?.(`[latte] closed handling (${what}) failed: ${error instanceof Error ? error.message : String(error)}`); }
      };
      guard('hub.stop', () => hub.stop(event.chatId));
      // D5: cerrar A PROPÓSITO no es morirse. Pausar, terminar, reiniciar,
      // quitar o cambiarle el modelo/esfuerzo a un miembro pasan todos por
      // `hub.stop` -> `adapter.stop` -> `closed` con `reason:'stopped'`, y
      // cobrarle un intento a la tarea por eso la acercaba al tope de
      // reintentos por una decisión de la PERSONA. La tarea vuelve a `ready`
      // igual, sin cargo. Una muerte real (cualquier otro motivo) sigue
      // contando como el fracaso que es.
      guard('settleCoordinationDispatchesForMember', () => service.settleCoordinationDispatchesForMember(event.chatId, { incrementAttempts: event.reason !== 'stopped' }));
      // F1: un turno también termina MURIÉNDOSE. El cierre que `finishRunIfComplete`
      // dejó aparcado esperando al coordinador (D17) se destrababa SÓLO con un
      // `status:'idle'`, y un proceso que se cae —o que la persona pausa— no
      // emite `idle` nunca: emite esto, y esta rama hacía `return` antes de
      // avisar. El run quedaba `running` para siempre con todo su trabajo hecho,
      // ocupando un cupo app-wide. Va después de liquidar, por lo mismo que
      // `hub.stop` va primero: se cierran las cuentas y recién ahí se evalúa el
      // final.
      guard('noteCoordinationTurnEnded', () => service.noteCoordinationTurnEnded(event.chatId));
      forward(event);
      return;
    }
    // El fin de un turno: si el coordinador tenía el cierre del run esperando
    // por él (D17), acá es donde se destraba.
    if (event.type === 'status' && event.status === 'idle') service.noteCoordinationTurnEnded(event.chatId);
    if (event.type === 'message' && event.message.role === 'assistant' && event.message.completed) {
      const assistantText = event.message.parts.filter(p=>p.type==='text').map(p=>(p as {text:string}).text).join('\n');
      for (const proposal of decisionProtocolBlocks(assistantText)) {
        void service.proposeDecisionFromAgent(event.chatId,event.message.id,proposal).catch(error=>options.log?.(`[latte] decision proposal failed: ${error instanceof Error?error.message:String(error)}`));
      }
      for (const proposal of brandContextProtocolBlocks(assistantText)) {
        void service.proposeBrandContextFromAgent(event.chatId,event.message.id,proposal).catch(error=>{
          const message = error instanceof Error ? error.message : String(error);
          options.log?.(`[latte] brand context proposal failed: ${message}`);
          forward({ chatId: event.chatId, type: 'error', message });
        });
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
    // El `system/init` del CLI trae el estado REAL de cada servidor MCP: la
    // unica evidencia de que el proceso los levanto (juicio #1, ronda 4).
    onMcpServers: (chatId, connected) => hub.confirmRuntimeMcpServers(chatId, connected),
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

  // sdd/autonomous-coordination: one closure, reused by the memory client
  // AND the injection planner (task 6.29's `latte_memory`), so both agree on
  // whether/where the `engram` binary lives without probing PATH twice.
  const locateEngram = () => locateExecutable(runner, 'engram', platform, env);
  const engram = new EngramClient({ runner, locate: locateEngram });

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
    emitCoordination: options.emitCoordination,
    sweepTimer: options.sweepTimer,
  });

  // sdd/autonomous-coordination, tasks 6.28-6.32/6.37: the coordination MCP
  // server and the injection planner, wired in AFTER `hub`/`service` exist
  // to break the construction cycle (`CoordinationMcpServer` needs a
  // `CoordinationEngine`, which needs `hub`; `hub` needs the planner, which
  // needs the server) -- see `AgentHub.attachCoordinationInjection`'s own
  // comment for the full reasoning.
  //
  // R1: el servidor MCP usa EL MOTOR DEL SERVICIO, no uno propio. Acá vivía un
  // `mcpEngine` aparte, justificado con "los dos son proxies sin estado sobre
  // el mismo repo, así que son intercambiables". Eso era cierto cuando se
  // escribió y dejó de serlo: el motor tiene ESTADO EN MEMORIA — `assigning`
  // (el miembro que un despacho ya eligió y todavía está levantando) y
  // `pendingClose` (el cierre aparcado esperando a que el coordinador termine
  // su turno) — y ese estado no se comparte entre instancias. El último
  // `latte_report` por MCP aparcaba el cierre en un motor y el fin de turno
  // llegaba al otro: el run quedaba `running` para siempre. Un despacho por
  // MCP y una aprobación por IPC elegían al mismo miembro ocioso. El motor es
  // único por proceso porque tiene estado, y punto.
  //
  // Task 8.1: the real feature-flag reader, off by default like every other
  // feature. Shared by both the coordination engine (gates run creation) and
  // the injection planner (gates `latte_coordination` delivery) -- `latte_memory`
  // never reads this, per task 6.29's independent policy.
  const isCoordinationEnabled = () => featureEnabled((key) => repo.getMeta(key), 'coordination');
  const coordinationTokens = new CoordinationTokenRegistry();
  const coordinationMcpServer = new CoordinationMcpServer({
    repo,
    engine: service.coordinationEngine,
    tokens: coordinationTokens,
    listen: createHttpListen(),
    log: options.log,
  });
  const injectionPlanner = new CoordinationInjectionPlanner({
    repo,
    tokens: coordinationTokens,
    server: coordinationMcpServer,
    resolveClaudeVersion: async () => (await detector.resolve('claude'))?.version ?? null,
    resolveEngramBinary: locateEngram,
    isCoordinationEnabled,
  });
  // El segundo argumento es el juicio #2: con el reclamo ya corregido por el
  // runtime, el archivo de instrucciones del Trabajo se vuelve a escribir.
  hub.attachCoordinationInjection(injectionPlanner, (workId) => service.refreshInstructionsAfterInjection(workId));
  service.attachCoordinationInjection(injectionPlanner);

  const seeded = options.seedDemo === false ? false : seedDemoIfEmpty(repo, files, pack);

  // El hermano de `sweepStrayCodexServers`, pero del lado de la base: los
  // despachos que la corrida anterior dejo en vuelo (una caida, un force-quit)
  // se reconcilian ANTES de que la interfaz muestre nada. Sin esto, cada uno
  // quedaba `dispatched` con su reserva abierta para siempre, quemando de
  // forma irrecuperable un despacho del Trabajo y del tope app-wide, y su run
  // no podia terminar nunca. Un fallo aca no puede impedir que la app abra.
  try {
    const swept = service.sweepUncertainCoordinationDispatches();
    if (swept > 0) options.log?.(`[latte] coordination: ${swept} in-flight dispatch(es) settled as uncertain after an unclean exit`);
  } catch (error) {
    options.log?.(`[latte] coordination sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    service,
    // El unico punto por el que pasa TODO evento de chat antes de llegar a la
    // interfaz: se expone para que el camino de muerte de proceso (juicio #8)
    // se pueda probar sin spawnear nada.
    emitChat,
    repo,
    learning,
    files,
    terminal,
    detector,
    chat,
    hub,
    claude,
    codex,
    accounts,
    coordinationMcpServer,
    coordinationTokens,
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
