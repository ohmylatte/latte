import { DEFAULT_EFFORT_TIER, EMPTY_USAGE, type AgentProfile, type ProfileInput } from '../../shared/contracts';
import type {
  AccountLoginStart,
  AgentAccount,
  AgentModel,
  AgentModelList,
  AgentRole,
  AgentRuntimeInfo,
  ChatEvent,
  ChatMessage,
  ChatRuntime,
  ChatRuntimeStatus,
  ChatSession,
  EffortTier,
  PermissionReply,
  PrimaryAgent,
  TeamMember,
  TeamMemberStatus,
} from '../../shared/contracts';
import { rmSync as fsRmSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { CoordinationInjectionPlanner } from '../coordination/injection';
import { NotFoundError, UnavailableError, ValidationError } from '../core/errors';
import { newId } from '../core/ids';
import type { ChatManager } from '../opencode/chatManager';
import type { CommandRunner } from '../runtime/commandRunner';
import type { RuntimeDetector } from '../runtime/detect';
import type { TerminalManager } from '../runtime/terminalManager';
import type { LatteRepository, TeamMemberRecord } from '../storage/repository';
import { AccountStore, SYSTEM_ACCOUNT_ID, type AccountRuntime } from './accounts';
import { ASSISTANT_ROLE_ID, RoleCatalog } from './roles';
import { avatarFromSeed, serializeAvatar } from '../../shared/avatar';
import type { TranscriptStore } from './transcripts';
import type { AdapterStartInput, RuntimeAdapter } from './types';

export interface AgentHubDeps {
  opencode: ChatManager;
  claude: RuntimeAdapter;
  codex: RuntimeAdapter | null;
  accounts: AccountStore;
  repo: LatteRepository;
  detector: RuntimeDetector;
  terminal: TerminalManager;
  runner: CommandRunner;
  roles: RoleCatalog;
  /** Local message record (Claude Code members); removed with the member. */
  transcripts?: TranscriptStore;
  /** Where per-member role prompts are written, so they can be cleaned up too. */
  promptDir?: string;
  /**
   * Working directory for the login terminals. A packaged app inherits its cwd
   * from whatever launched it (a shortcut, the shell, Explorer), so the data
   * directory is used instead: it always exists and belongs to Latte.
   */
  loginCwd?: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => string;
}

/** Where a member's conversation runs: the work directory and the context every runtime needs. */
export interface MemberContext {
  workId: string;
  brandId: string;
  directory: string;
  title: string;
  extraEnv: Record<string, string>;
  /** The human allowed reading and writing inside this work folder without asking each time. */
  trustedFolder?: boolean;
  /**
   * The work's expected output for this member's own prompt, set only when
   * the shared context files are frozen by a live conversation and do not
   * say it. Fixed for the life of the conversation. Null or absent: the
   * files already carry what there is to know.
   */
  outcomeContext?: string | null;
}

export interface AddMemberInput extends MemberContext {
  roleId: string;
  /** Advanced overrides; the UI leaves them empty and the primary agent decides. */
  runtime?: ChatRuntime | null;
  model?: string | null;
  accountId?: string | null;
  /** Member of the same work this one continues; validated by the service. */
  continuedFrom?: string | null;
  /** Effort override; absent or null means the role's own default. */
  tier?: EffortTier | null;
}

const PRIMARY_KEY = 'primary_agent';
const RUNTIME_LABEL: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex' };

export function isChatRuntime(value: unknown): value is ChatRuntime {
  return value === 'opencode' || value === 'claude' || value === 'codex';
}

export function isAccountRuntime(value: unknown): value is AccountRuntime {
  return value === 'claude' || value === 'codex';
}

/**
 * Routes chats to runtimes, owns the "primary agent" choice and the team of
 * each work. A team member is a role (preset personality) with its own
 * conversation; its id doubles as the chat id, so pausing and resuming keeps
 * the same identity on screen and in the runtime's own history.
 */
/** Asking Codex for its catalog spawns a process; a few minutes of memory is enough. */
const MODEL_CACHE_MS = 5 * 60_000;

export class AgentHub {
  /** Live sessions by chat id (= member id). Pruned whenever the adapter no longer owns the chat. */
  private readonly sessions = new Map<string, ChatSession>();
  /** The outcome each live conversation opened with. A model change restarts the runtime, not the conversation, so it keeps this. */
  private readonly openedOutcome = new Map<string, string | null>();
  private readonly modelCache = new Map<string, { at: number; value: AgentModelList }>();
  /**
   * Una apertura en vuelo por miembro (juicio #7, ronda 4). Todo guard de "ya
   * está abierto" se chequeaba ANTES de un `await` y el registro ocurría
   * DESPUES: `openMember` mira `liveSession` y recien despues hace `await
   * this.open(...)`. Y `resolveTargetMember` puede elegir al MISMO miembro
   * ocioso para dos tareas listas distintas del mismo rol -- el
   * compare-and-set de la ronda 2 protege una fila de tarea, no esto. Las dos
   * llamadas llegaban a `hub.openMember(X)` y arrancaban DOS procesos bajo un
   * mismo chatId, el segundo pisando al primero. Compartir la promesa cierra
   * la ventana entera.
   */
  private readonly opening = new Map<string, Promise<ChatSession>>();
  /**
   * Los miembros a los que alguien pidió cerrar MIENTRAS su apertura seguía en
   * vuelo (D8).
   *
   * `stop()` hacía `injection.release` —un no-op, porque el reclamo todavía no
   * existía— y después buscaba un adaptador que lo `owns` —tampoco, porque el
   * proceso todavía no había arrancado—, así que se iba sin hacer nada. Un
   * segundo después la apertura commiteaba: marcaba el cupo de techo, entregaba
   * el token y spawneaba un proceso de un miembro que la persona YA cerró. El
   * cupo quedaba comido, el bearer vivo (no vence) y el servidor de loopback sin
   * poder apagarse nunca. La apertura consulta este conjunto al asentar y
   * COMPENSA: suelta el reclamo y cierra el proceso que acaba de nacer.
   */
  private readonly closedWhileOpening = new Set<string>();
  private readonly clock: () => string;
  /**
   * sdd/autonomous-coordination, task 6.28: attached AFTER construction, not
   * a constructor dep. `CoordinationMcpServer` needs a `CoordinationEngine`,
   * which needs this very hub -- breaking that cycle means the planner is
   * built once the rest of the coordination stack exists and handed to an
   * already-running hub via `attachCoordinationInjection`, well before any
   * member is ever opened. `null` (the default, and every existing test's
   * reality) means coordination injection simply does not happen: `open()`
   * builds no `mcpServers` array at all, byte-identical to pre-Phase-6
   * behaviour.
   */
  private injection: CoordinationInjectionPlanner | null = null;
  /**
   * Juicio #2, ronda 4: `renderAndWriteInstructions` lee
   * `memoryToolsInjectedForWork`, y esa respuesta puede CAMBIAR despues del
   * spawn -- `confirmInjection` baja el reclamo cuando el runtime se nego.
   * Sin este aviso, el archivo del Trabajo se quedaba afirmando herramientas
   * que el proceso no tiene.
   */
  private onInjectionConfirmed: ((workId: string) => void) | null = null;

  constructor(private readonly deps: AgentHubDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  /** Wires the coordination injection planner in after construction (see the field's own comment for why). */
  attachCoordinationInjection(planner: CoordinationInjectionPlanner, onInjectionConfirmed?: (workId: string) => void): void {
    this.injection = planner;
    this.onInjectionConfirmed = onInjectionConfirmed ?? null;
  }

  /**
   * Lo que el RUNTIME reporto sobre sus propios servidores MCP, ya arrancado
   * (juicio #1, ronda 4). Claude lo publica en su `system/init`, que llega
   * DESPUES de que `start()` volvio: esta es la correccion tardia del reclamo
   * que `assign()` dejo escrito antes del spawn. Un chatId que no es un
   * miembro (un chat suelto) no tiene reclamo ninguno y se ignora.
   */
  confirmRuntimeMcpServers(chatId: string, connected: string[]): void {
    const member = this.deps.repo.findMember(chatId);
    if (!member) return;
    this.injection?.confirmInjection(chatId, connected);
    this.onInjectionConfirmed?.(member.workId);
  }

  // Primary agent -----------------------------------------------------------

  getPrimary(): PrimaryAgent | null {
    const raw = this.deps.repo.getMeta(PRIMARY_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PrimaryAgent>;
      if (!isChatRuntime(parsed.runtime)) return null;
      const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : null;
      const accountId = typeof parsed.accountId === 'string' && parsed.accountId.length > 0 ? parsed.accountId : null;
      return { runtime: parsed.runtime, model, accountId, label: this.labelFor(parsed.runtime, model, accountId) };
    } catch {
      return null;
    }
  }

  setPrimary(choice: { runtime: ChatRuntime; model: string | null; accountId: string | null }): PrimaryAgent {
    if (!isChatRuntime(choice.runtime)) throw new ValidationError('Unknown runtime');
    if (choice.runtime === 'opencode' && choice.accountId) throw new ValidationError('OpenCode has no accounts');
    if (choice.runtime !== 'opencode' && choice.accountId && !AccountStore.isValidId(choice.accountId)) throw new ValidationError('Invalid account id');
    if (choice.runtime === 'codex' && !this.deps.codex) throw new UnavailableError('Codex support is not available in this build');
    const primary: PrimaryAgent = {
      runtime: choice.runtime,
      model: choice.model,
      accountId: choice.runtime === 'opencode' ? null : (choice.accountId ?? SYSTEM_ACCOUNT_ID),
      label: this.labelFor(choice.runtime, choice.model, choice.runtime === 'opencode' ? null : (choice.accountId ?? SYSTEM_ACCOUNT_ID)),
    };
    this.deps.repo.setMeta(PRIMARY_KEY, JSON.stringify({ runtime: primary.runtime, model: primary.model, accountId: primary.accountId }));
    return primary;
  }

  /** Falls back to OpenCode's runtime default when nothing was chosen yet. */
  resolvePrimary(): PrimaryAgent {
    return this.getPrimary() ?? { runtime: 'opencode', model: null, accountId: null, label: this.labelFor('opencode', null, null) };
  }

  private labelFor(runtime: ChatRuntime, model: string | null, accountId: string | null): string {
    const parts: string[] = [RUNTIME_LABEL[runtime]];
    if (runtime !== 'opencode' && accountId) {
      const account = accountId === SYSTEM_ACCOUNT_ID ? null : this.deps.accounts.list(runtime).find((a) => a.id === accountId);
      parts.push(accountId === SYSTEM_ACCOUNT_ID ? 'mi sesión' : account?.label ?? accountId);
    }
    if (model) parts.push(model);
    else if (runtime === 'opencode') parts.push('modelo por defecto');
    return parts.join(' · ');
  }

  // Runtimes and accounts -----------------------------------------------------

  async status(): Promise<ChatRuntimeStatus> {
    return this.deps.opencode.status();
  }

  async listAgentRuntimes(): Promise<AgentRuntimeInfo[]> {
    const out: AgentRuntimeInfo[] = [];
    for (const runtime of ['claude', 'codex'] as const) {
      const found = await this.deps.detector.resolve(runtime);
      const accounts = await this.deps.accounts.describe(runtime);
      let detail: string;
      if (!found) detail = `${RUNTIME_LABEL[runtime]} no está instalado o no está en el PATH.`;
      else if (runtime === 'codex' && !this.deps.codex) detail = 'Codex detectado, pero este build no incluye su adaptador de chat.';
      else detail = `${RUNTIME_LABEL[runtime]}${found.version ? ` ${found.version}` : ''} · ${found.executable}`;
      out.push({ runtime, installed: Boolean(found), version: found?.version ?? null, detail, accounts });
    }
    return out;
  }

  addAccount(runtime: AccountRuntime, label: string): Promise<AgentAccount> {
    const record = this.deps.accounts.create(runtime, label);
    return Promise.resolve({ runtime, id: record.id, label: record.label, system: false, loggedIn: false, detail: 'Sin sesión iniciada', models: this.deps.accounts.suggestedModels(runtime, record.id) });
  }

  removeAccount(runtime: AccountRuntime, accountId: string): void {
    if (accountId === SYSTEM_ACCOUNT_ID) throw new ValidationError('The system profile cannot be removed from Latte');
    this.deps.accounts.remove(runtime, accountId);
    const primary = this.getPrimary();
    if (primary && primary.runtime === runtime && primary.accountId === accountId) this.deps.repo.setMeta(PRIMARY_KEY, '');
  }

  /**
   * The CLI owns its OAuth. Claude Code's login is interactive, so it runs in
   * an embedded terminal the user can see; the browser opens by itself.
   */
  async startLogin(runtime: AccountRuntime, accountId: string): Promise<AccountLoginStart> {
    if (!AccountStore.isValidId(accountId)) throw new ValidationError('Invalid account id');
    const found = await this.deps.detector.resolve(runtime);
    if (!found) throw new UnavailableError(`${RUNTIME_LABEL[runtime]} is not installed or not on PATH`);
    const extraEnv = this.deps.accounts.envFor(runtime, accountId);
    if (runtime === 'codex' && this.deps.codex && 'startLogin' in this.deps.codex) {
      return (this.deps.codex as RuntimeAdapter & { startLogin(accountId: string): Promise<AccountLoginStart> }).startLogin(accountId);
    }
    const session = this.deps.terminal.start({
      workId: 'login',
      brandId: 'login',
      provider: runtime,
      executable: found.executable,
      args: runtime === 'claude' ? ['auth', 'login'] : ['login'],
      cwd: this.deps.loginCwd ?? process.cwd(),
      extraEnv,
    });
    return {
      mode: 'terminal',
      sessionId: session.id,
      instructions: runtime === 'claude'
        ? 'Claude Code abre el navegador para iniciar sesión. Si te pide un código, pegalo en esta terminal. Al terminar, la terminal se cierra sola.'
        : 'Codex abre el navegador para iniciar sesión con tu cuenta de ChatGPT. Al terminar, la terminal se cierra sola.',
    };
  }

  async logout(runtime: AccountRuntime, accountId: string): Promise<void> {
    if (!AccountStore.isValidId(accountId)) throw new ValidationError('Invalid account id');
    const found = await this.deps.detector.resolve(runtime);
    if (!found) throw new UnavailableError(`${RUNTIME_LABEL[runtime]} is not installed or not on PATH`);
    const env = { ...scrub(this.deps.env ?? process.env), ...this.deps.accounts.envFor(runtime, accountId) };
    const result = await this.deps.runner(found.executable, runtime === 'claude' ? ['auth', 'logout'] : ['logout'], { timeoutMs: 15_000, env });
    if (result.error || result.timedOut) throw new UnavailableError(`Could not log out: ${result.error ?? 'timed out'}`);
  }

  // Team ----------------------------------------------------------------------

  listProfiles(): AgentProfile[] { return this.deps.roles.listProfiles(); }
  saveProfile(input: ProfileInput, expectedFingerprint: string | null): AgentProfile { return this.deps.roles.saveProfile(input, expectedFingerprint); }

  listRoles(): AgentRole[] {
    return this.deps.roles.list();
  }

  /**
   * QUIÉN ESTÁ ADENTRO AHORA MISMO. La única señal de vida honesta: un miembro
   * está vivo si algún adaptador lo POSEE, o sea si hay un proceso corriendo
   * para él.
   *
   * Ronda 8 (M1): no se responde con `listTeam`/`describe()`. La tabla de
   * miembros sobrevive a la muerte del proceso —esa fila sigue ahí con
   * `status:'paused'`, que es exactamente lo que `describe()` devuelve cuando
   * no hay adaptador— así que "está en la tabla y no terminó" es verdad para
   * un miembro muerto, para uno pausado por la persona y para uno que nunca
   * arrancó. Quien coordina necesita saber si HAY ALGUIEN, no si la fila
   * existe. Y `describe()` además tiene efecto colateral (borra la sesión
   * publicada), así que preguntarle "¿está vivo?" escribe.
   *
   * `working` e `idle` ⇒ vivo. `paused` y `ended` ⇒ no. Una sola pasada por
   * los adaptadores: el llamador cachea el conjunto por evaluación en vez de
   * preguntar de a uno.
   */
  liveMemberIds(workId: string): Set<string> {
    const adapters = this.adapters();
    return new Set(this.deps.repo.listMembers(workId).filter((m) => adapters.some((a) => a.owns(m.id))).map((m) => m.id));
  }

  /** Members of this work whose runtime process is alive right now. */
  liveMemberCount(workId: string): number {
    return this.liveMemberIds(workId).size;
  }

  /**
   * Si este miembro tiene un turno EN CURSO ahora mismo. Lo pregunta al
   * adaptador, que es el único que lo sabe (`isBusy`); un miembro pausado, o de
   * un runtime que este build no trae, no está en ningún turno. Lo lee el cierre
   * del run (`finishRunIfComplete`): terminar el run mientras el coordinador
   * está pensando le come el `latte_task_create` que estaba por hacer.
   */
  isMemberBusy(memberId: string): boolean {
    return this.adapters().some((a) => a.owns(memberId) && a.isBusy(memberId));
  }

  listTeam(workId: string): TeamMember[] {
    // Una sola lectura de los miembros para todo el equipo: `describe` sola
    // tendria que ir a buscar los hermanos de cada uno para saber si su cara
    // se repite, y eso serian N consultas para dibujar una lista.
    const members = this.deps.repo.listMembers(workId);
    return members.map((record) => this.describe(record, members));
  }

  getMember(memberId: string): TeamMember {
    return this.describe(this.deps.repo.getMember(memberId));
  }

  /** Creates the member (primary agent unless overridden) and opens its conversation. */
  async addMember(input: AddMemberInput): Promise<ChatSession> {
    const role = this.deps.roles.get(input.roleId);
    if (!role) throw new NotFoundError('Role', input.roleId);
    const { runtime, model, accountId } = this.resolveChoice(input);
    this.adapterFor(runtime); // fail early when the runtime is not in this build
    const now = this.clock();
    const record: TeamMemberRecord = {
      id: newId('mem'),
      workId: input.workId,
      roleId: role.id,
      roleName: role.name,
      initial: role.initial,
      runtime,
      model,
      accountId,
      sessionId: '',
      done: false,
      continuedFrom: input.continuedFrom ?? null,
      // The role knows what its work usually needs; the human can override it
      // when adding the member, and change it later from the conversation.
      tier: input.tier ?? role.tier,
      usage: EMPTY_USAGE,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.insertMember(record);
    try {
      return await this.open(record, input);
    } catch (error) {
      // Nothing to resume yet: do not leave a member that never opened --
      // including whatever coordination token/ledger slot `open()` already claimed.
      this.injection?.release(record.id);
      this.deps.repo.deleteMember(record.id);
      throw error;
    }
  }

  /** Opens (or resumes) an existing member. Returns the live session when it is already open. */
  async openMember(memberId: string, context: MemberContext): Promise<ChatSession> {
    const record = this.deps.repo.getMember(memberId);
    const live = this.liveSession(memberId);
    if (live) return live;
    if (record.done) this.deps.repo.setMemberDone(record.id, false, this.clock());
    try {
      return await this.open({ ...record, done: false }, context);
    } catch (error) {
      // Same reasoning as addMember's catch: a failed open must not leave a
      // claimed coordination token/ledger slot behind for a member that
      // never actually started.
      this.injection?.release(record.id);
      throw error;
    }
  }

  /** Closes the conversation; the member stays and can be resumed. */
  pauseMember(memberId: string): void {
    this.deps.repo.getMember(memberId);
    this.stop(memberId);
  }

  finishMember(memberId: string): void {
    this.deps.repo.getMember(memberId);
    this.stop(memberId);
    this.deps.repo.setMemberDone(memberId, true, this.clock());
  }

  /**
   * Starts the member's conversation over without losing the member.
   *
   * Adding a second member with the same role to get a clean slate was the
   * only way before, and it made no sense: the role is who works here, not one
   * particular thread. This drops the transcript and the runtime session id, so
   * the next message opens a new conversation instead of resuming the old one.
   * Role, runtime and account stay exactly as they were.
   */
  restartMember(memberId: string): TeamMember {
    const record = this.deps.repo.getMember(memberId);
    this.stop(memberId);
    this.deps.repo.setMemberSession(memberId, '', this.clock());
    if (record.done) this.deps.repo.setMemberDone(memberId, false, this.clock());
    this.deps.transcripts?.forget(memberId);
    if (this.deps.promptDir && /^[a-z][a-z0-9_-]{2,63}$/.test(memberId)) {
      try { fsRmSync(pathJoin(this.deps.promptDir, memberId + '.md'), { force: true }); } catch { /* best effort */ }
    }
    return this.describe(this.deps.repo.getMember(memberId));
  }

  /**
   * Changes the model of a member's conversation without throwing away what
   * was said.
   *
   * Neither runtime swaps a model in place: Claude Code takes it as a process
   * argument and Codex as a thread option — its protocol has no `setModel` at
   * all. So the runtime is stopped and started again, resuming the same
   * conversation by its own id. `resumed` says whether that actually worked;
   * a restart that quietly dropped the thread would be worse than the terminal
   * this replaced.
   */
  async setMemberModel(memberId: string, model: string | null, context: MemberContext): Promise<{ member: TeamMember; session: ChatSession | null; resumed: boolean }> {
    const record = this.deps.repo.getMember(memberId);
    const next = model && model.trim() ? model.trim() : null;
    const live = Boolean(this.liveSession(memberId));
    if (next === (record.model ?? null)) return { member: this.describe(record), session: this.liveSession(memberId), resumed: live };
    // Same conversation, so the same outcome it opened with, whatever the work says now.
    const reopen: MemberContext = live ? { ...context, outcomeContext: this.openedOutcome.get(memberId) ?? null } : context;
    if (live) this.stop(memberId);
    this.deps.repo.setMemberModel(memberId, next, this.clock());
    const updated = this.deps.repo.getMember(memberId);
    // A paused conversation is not woken up to change a setting: the next time
    // it opens it will already be on the new model.
    if (!live) return { member: this.describe(updated), session: null, resumed: false };
    try {
      const session = await this.open(updated, reopen);
      return { member: this.describe(this.deps.repo.getMember(memberId)), session, resumed: session.resumed };
    } catch (error) {
      // The runtime refused the model (OpenCode checks its own catalog, a CLI
      // may just fail to start). Leaving the member on a model that does not
      // work, with its conversation closed, would be the worst of both: the
      // previous model is put back and the conversation reopened.
      this.deps.repo.setMemberModel(memberId, record.model ?? null, this.clock());
      // Juicio #9: `open()` ya reclamo un token y un cupo de techo antes de
      // fallar. Sin soltarlo, este reintento minta un SEGUNDO reclamo, y si
      // tambien falla nadie suelta ninguno de los dos: el token vivo impide
      // para siempre que `stopIfIdle` cierre el servidor compartido y el cupo
      // queda comido para toda otra Marca. `addMember`/`openMember` ya
      // compensan asi; este camino se lo habia salteado.
      this.injection?.release(memberId);
      try { await this.open(this.deps.repo.getMember(memberId), reopen); } catch {
        this.injection?.release(memberId);
      }
      throw error;
    }
  }

  /**
   * Changes how hard a member works, with the same mechanics as changing its
   * model: no runtime takes this in place either — Claude Code reads `--effort`
   * as a process argument and Codex takes it when a turn starts — so the
   * runtime is stopped and started again on the same conversation, and
   * `resumed` says whether that actually worked.
   */
  async setMemberTier(memberId: string, tier: EffortTier, context: MemberContext): Promise<{ member: TeamMember; session: ChatSession | null; resumed: boolean }> {
    const record = this.deps.repo.getMember(memberId);
    const previous = record.tier ?? DEFAULT_EFFORT_TIER;
    const live = Boolean(this.liveSession(memberId));
    if (tier === previous) return { member: this.describe(record), session: this.liveSession(memberId), resumed: live };
    // Same conversation, so the same outcome it opened with, whatever the work says now.
    const reopen: MemberContext = live ? { ...context, outcomeContext: this.openedOutcome.get(memberId) ?? null } : context;
    if (live) this.stop(memberId);
    this.deps.repo.setMemberTier(memberId, tier, this.clock());
    const updated = this.deps.repo.getMember(memberId);
    // A paused conversation is not woken up to change a setting: the next time
    // it opens it will already be working at the new effort.
    if (!live) return { member: this.describe(updated), session: null, resumed: false };
    try {
      const session = await this.open(updated, reopen);
      return { member: this.describe(this.deps.repo.getMember(memberId)), session, resumed: session.resumed };
    } catch (error) {
      // The runtime refused the effort (an old CLI, a model without it). The
      // previous tier is put back and the conversation reopened, because a
      // member left closed on a setting that does not work is the worst of both.
      this.deps.repo.setMemberTier(memberId, previous, this.clock());
      // Misma compensacion que en `setMemberModel` (juicio #9): soltar el
      // reclamo del intento fallido antes de reabrir, y otra vez si el
      // reintento tampoco arranca.
      this.injection?.release(memberId);
      try { await this.open(this.deps.repo.getMember(memberId), reopen); } catch {
        this.injection?.release(memberId);
      }
      throw error;
    }
  }

  /**
   * A turn's consumption, as the runtime measured it, added to what this
   * member has spent in its whole life.
   *
   * An adapter can only count the process it is running, and a member outlives
   * many of those: pausing, changing model, restarting the app. So the number
   * the interface shows comes from the database, and the adapter's own running
   * total is replaced here before the event leaves for the renderer. A usage
   * event for something that is not a member (a chat the hub does not own)
   * passes through untouched rather than inventing a row.
   */
  recordUsage(event: Extract<ChatEvent, { type: 'usage' }>): ChatEvent {
    if (!this.deps.repo.findMember(event.chatId)) return event;
    return { ...event, total: this.deps.repo.addMemberUsage(event.chatId, event.turn, this.clock()) };
  }

  removeMember(memberId: string): void {
    this.deps.repo.getMember(memberId);
    this.stop(memberId);
    this.deps.repo.deleteMember(memberId);
    // Nothing of the member is left behind on disk.
    this.deps.transcripts?.forget(memberId);
    if (this.deps.promptDir && /^[a-z][a-z0-9_-]{2,63}$/.test(memberId)) {
      try { fsRmSync(pathJoin(this.deps.promptDir, memberId + '.md'), { force: true }); } catch { /* best effort */ }
    }
  }

  private open(record: TeamMemberRecord, context: MemberContext): Promise<ChatSession> {
    const inFlight = this.opening.get(record.id);
    if (inFlight) return inFlight;
    this.closedWhileOpening.delete(record.id); // una apertura nueva empieza sin deudas
    const started = this.openNow(record, context);
    this.opening.set(record.id, started);
    const clear = () => {
      if (this.opening.get(record.id) === started) this.opening.delete(record.id);
      this.closedWhileOpening.delete(record.id);
    };
    started.then(clear, clear);
    return started;
  }

  /**
   * La compensación de D8: alguien cerró a este miembro mientras se abría.
   * Se llama en los DOS puntos donde la apertura puede notarlo — justo después
   * de reclamar el cupo (antes de spawnear, y ahí alcanza con abortar) y justo
   * después del spawn (y ahí hay que cerrar el proceso que nació).
   */
  private compensateClosedWhileOpening(memberId: string): void {
    this.sessions.delete(memberId);
    this.openedOutcome.delete(memberId);
    this.injection?.release(memberId);
    for (const adapter of this.adapters()) {
      if (adapter.owns(memberId)) {
        adapter.stop(memberId);
        return;
      }
    }
  }

  private async openNow(record: TeamMemberRecord, context: MemberContext): Promise<ChatSession> {
    const adapter = this.adapterFor(record.runtime);
    const label = this.labelFor(record.runtime, record.model, record.accountId);
    const outcome = context.outcomeContext?.trim() || null;
    // sdd/autonomous-coordination, tasks 6.28-6.29: assembled BEFORE the
    // adapter ever sees this input, so `mcpServers` is either populated
    // correctly on the first spawn or genuinely absent -- never patched in
    // after the fact. `undefined` (no planner attached, the pre-Phase-6
    // default) means this call is byte-identical to before this slice.
    const mcpServers = this.injection ? (await this.injection.assign({
      memberId: record.id,
      workId: context.workId,
      brandId: context.brandId,
      runtime: record.runtime,
      accountId: record.accountId,
    })).servers : undefined;
    // PRIMER punto de control (D8): el reclamo ya está tomado pero todavía no
    // se pagó ningún spawn. Si la persona cerró en el medio, se suelta acá y no
    // se levanta un proceso de un miembro que ya no está.
    if (this.closedWhileOpening.has(record.id)) {
      this.closedWhileOpening.delete(record.id);
      this.compensateClosedWhileOpening(record.id);
      throw new UnavailableError('This conversation was closed while it was starting');
    }
    const adapterInput: AdapterStartInput = {
      workId: context.workId,
      chatId: record.id,
      directory: context.directory,
      title: context.title,
      roleId: record.roleId,
      roleName: record.roleName,
      // Every runtime takes this once, at start: the outcome is fixed for this conversation.
      instructions: [this.deps.roles.promptFor(record.roleId), outcome].filter(Boolean).join('\n\n---\n\n'),
      previousSessionId: record.sessionId || null,
      model: record.model,
      tier: record.tier ?? DEFAULT_EFFORT_TIER,
      accountId: record.accountId,
      label,
      extraEnv: context.extraEnv,
      trustedFolder: context.trustedFolder === true,
      mcpServers,
    };
    const result = await adapter.start(adapterInput);
    // Lo que el adaptador entregó DE VERDAD corrige el reclamo que `assign()`
    // dejó escrito antes del spawn: sin esto, `coordinationRuntimeSupport`
    // afirmaba capacidades que el proceso no tenía (juicio #5).
    // La negativa de LATTE viaja por su propio campo (D7c): degrada el reclamo
    // sin afirmar que el runtime confirmó nada.
    if (result.injectionRefusedByLatte) this.injection?.noteLatteRefusedInjection(record.id);
    this.injection?.confirmInjection(record.id, result.injectedMcpServers);
    // El archivo de instrucciones del Trabajo se vuelve a escribir con el
    // reclamo YA corregido (juicio #2): una negativa del runtime tiene que
    // llegar al texto que el agente lee, no quedarse solo en la UI.
    this.onInjectionConfirmed?.(context.workId);
    if (result.runtimeSessionId && result.runtimeSessionId !== record.sessionId) this.deps.repo.setMemberSession(record.id, result.runtimeSessionId, this.clock());
    this.sessions.set(result.session.id, result.session);
    this.openedOutcome.set(record.id, outcome);
    // SEGUNDO punto de control (D8): el cierre llegó mientras el proceso
    // arrancaba. Ahora sí hay algo que apagar, y se apaga en el acto — la
    // sesión nunca llega a quedar publicada como viva.
    if (this.closedWhileOpening.has(record.id)) {
      this.closedWhileOpening.delete(record.id);
      this.compensateClosedWhileOpening(record.id);
      throw new UnavailableError('This conversation was closed while it was starting');
    }
    return result.session;
  }

  private liveSession(chatId: string): ChatSession | null {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    if (this.adapters().some((a) => a.owns(chatId))) return session;
    this.sessions.delete(chatId);
    return null;
  }

  /**
   * La cara de un miembro: la de su rol, salvo que el equipo ya tenga otro
   * miembro del mismo rol.
   *
   * El segundo Reviewer y los que sigan derivan la suya de su propio id y se
   * quedan con el COLOR del rol: siguen siendo Reviewers de un vistazo, pero
   * no son la misma persona dos veces. Ninguna cara repetida en un equipo.
   *
   * Se calcula al leer y no se guarda: la tabla de miembros no tiene columna
   * para esto y no hay ninguna migracion detras de este cambio. El orden lo
   * fija `createdAt` y, si dos entraron en el mismo milisegundo, el id: el
   * primero conserva la cara del rol y no se la roba nadie despues.
   */
  private avatarOf(record: TeamMemberRecord, siblings?: TeamMemberRecord[]): string | null {
    let roleAvatar: string | null = null;
    // Un rol borrado del disco no deja al miembro sin cara: la deriva de su id.
    try { roleAvatar = this.deps.roles.get(record.roleId)?.avatar ?? null; } catch { roleAvatar = null; }
    if (!roleAvatar) roleAvatar = serializeAvatar(avatarFromSeed(record.roleId));
    const peers = (siblings ?? this.deps.repo.listMembers(record.workId))
      .filter((m) => m.roleId === record.roleId)
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
    const index = peers.findIndex((m) => m.id === record.id);
    return index <= 0 ? roleAvatar : serializeAvatar(avatarFromSeed(record.id));
  }

  private describe(record: TeamMemberRecord, siblings?: TeamMemberRecord[]): TeamMember {
    let status: TeamMemberStatus;
    const adapter = this.adapters().find((a) => a.owns(record.id));
    if (adapter) status = adapter.isBusy(record.id) ? 'working' : 'idle';
    else status = record.done ? 'ended' : 'paused';
    if (!adapter) this.sessions.delete(record.id);
    return {
      id: record.id,
      workId: record.workId,
      roleId: record.roleId,
      roleName: record.roleName,
      initial: record.initial,
      avatar: this.avatarOf(record, siblings),
      runtime: record.runtime,
      model: record.model,
      accountId: record.accountId,
      label: this.labelFor(record.runtime, record.model, record.accountId),
      status,
      tier: record.tier ?? DEFAULT_EFFORT_TIER,
      usage: record.usage ?? EMPTY_USAGE,
      continuedFrom: record.continuedFrom ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * What a member's conversation already said, without opening it.
   *
   * A live runtime answers from memory, and a paused Claude Code member has
   * Latte's own transcript. OpenCode and Codex keep a paused conversation's
   * history inside the runtime: reading it would mean starting that runtime,
   * so the honest answer there is `exposed: false`, not a side effect.
   */
  recentMessages(memberId: string): { messages: ChatMessage[]; exposed: boolean } {
    const record = this.deps.repo.getMember(memberId);
    const adapter = this.adapters().find((a) => a.owns(memberId));
    if (adapter) return { messages: adapter.listMessages(memberId), exposed: true };
    if (record.runtime === 'claude' && this.deps.transcripts) return { messages: this.deps.transcripts.load(memberId), exposed: true };
    return { messages: [], exposed: false };
  }

  // Chats ---------------------------------------------------------------------

  /**
   * Compatibility path ("Iniciar chat"): the neutral assistant with the
   * primary agent. Reopens the existing assistant member for that agent when
   * there is one, so a plain chat resumes instead of multiplying members.
   */
  async start(input: MemberContext & { runtime?: ChatRuntime | null; model?: string | null; accountId?: string | null }): Promise<ChatSession> {
    const resolved = this.resolveChoice(input);
    const existing = this.deps.repo.listMembers(input.workId).find((m) => m.roleId === ASSISTANT_ROLE_ID && m.runtime === resolved.runtime && m.accountId === resolved.accountId && m.model === resolved.model);
    if (existing) return this.openMember(existing.id, input);
    return this.addMember({ ...input, roleId: ASSISTANT_ROLE_ID });
  }

  private resolveChoice(input: { runtime?: ChatRuntime | null; model?: string | null; accountId?: string | null }): { runtime: ChatRuntime; model: string | null; accountId: string | null } {
    const primary = this.resolvePrimary();
    const runtime = input.runtime ?? primary.runtime;
    const model = input.runtime ? (input.model ?? null) : (input.model ?? primary.model);
    const accountId = runtime === 'opencode' ? null : (input.accountId ?? (input.runtime ? SYSTEM_ACCOUNT_ID : primary.accountId ?? SYSTEM_ACCOUNT_ID));
    return { runtime, model, accountId };
  }

  listMessages(chatId: string): ChatMessage[] {
    return this.route(chatId).listMessages(chatId);
  }

  send(chatId: string, text: string): Promise<void> {
    return this.route(chatId).send(chatId, text);
  }

  abort(chatId: string): Promise<void> {
    return this.route(chatId).abort(chatId);
  }

  replyPermission(chatId: string, requestId: string, reply: PermissionReply): Promise<void> {
    return this.route(chatId).replyPermission(chatId, requestId, reply);
  }

  replyQuestion(chatId: string, requestId: string, answers: string[][] | null): Promise<void> {
    return this.route(chatId).replyQuestion(chatId, requestId, answers);
  }

  stop(chatId: string): void {
    // D8: si la apertura sigue en vuelo, ni el reclamo ni el proceso existen
    // todavía y las dos líneas de abajo no encuentran nada que soltar. Se anota
    // la intención y la apertura la respeta cuando asienta.
    if (this.opening.has(chatId)) this.closedWhileOpening.add(chatId);
    this.sessions.delete(chatId);
    this.openedOutcome.delete(chatId);
    // Task 6.28: the single chokepoint `pauseMember`/`finishMember`/
    // `removeMember` (which calls this first) and the model/tier restart
    // path all funnel through -- one release site covers all of them.
    this.injection?.release(chatId);
    for (const adapter of this.adapters()) {
      if (adapter.owns(chatId)) {
        adapter.stop(chatId);
        return;
      }
    }
  }

  shutdown(): void {
    this.sessions.clear();
    this.openedOutcome.clear();
    this.injection?.releaseAll();
    for (const adapter of this.adapters()) adapter.shutdown();
  }

  /**
   * The models an account can use, asked to the runtime that owns them.
   *
   * Codex answers `model/list` with its real catalog; Claude Code has no such
   * command, so the honest answer there is the aliases its own `--model` help
   * documents. The caller is told which of the two it got, because "the
   * runtime said so" and "Latte knows this much" are not the same claim.
   * Cached briefly: asking Codex costs a process.
   */
  async listAccountModels(runtime: AccountRuntime, accountId: string): Promise<AgentModelList> {
    const suggested = (detail: string): AgentModelList => ({
      source: 'suggested',
      models: this.deps.accounts.suggestedModels(runtime, accountId).map((id) => ({ id, label: id, description: '', isDefault: false })),
      detail,
    });
    if (runtime === 'claude') return suggested('Claude Code no publica un catálogo: estos son los alias que documenta su propio --model.');
    const key = `${runtime}:${accountId}`;
    const cached = this.modelCache.get(key);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.value;
    if (!this.deps.codex) return suggested('Codex no está disponible en esta instalación.');
    try {
      const models = await (this.deps.codex as RuntimeAdapter & { listModels(accountId: string): Promise<AgentModel[]> }).listModels(accountId);
      if (models.length === 0) return suggested('Codex no devolvió ningún modelo.');
      const value: AgentModelList = { source: 'catalog', models, detail: 'Catálogo que devolvió Codex para esta cuenta.' };
      this.modelCache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      // A closed session or a Codex that will not start is not a reason to show
      // nothing: what Latte knows on its own still helps.
      return suggested(`No se pudo consultar el catálogo de Codex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Conversations a restart would interrupt. Used to warn before an update installs. */
  liveCount(): number {
    return this.sessions.size;
  }

  /** Persist a runtime session id learned after start (Claude reveals it with its first reply). */
  rememberSession(chatId: string, sessionId: string): void {
    if (this.deps.repo.findMember(chatId)) this.deps.repo.setMemberSession(chatId, sessionId, this.clock());
  }

  /**
   * Si el runtime de este miembro puede confirmar alguna vez lo que levantó.
   * Lo pregunta al adaptador, que es quien lo sabe: sin esto la UI tendría que
   * llevar su propia lista de runtimes, y una lista paralela es una lista que
   * se desactualiza. Un runtime que este build no trae se lee como "no
   * informa" — que es exactamente la verdad: no hay nadie que informe.
   */
  confirmsMcpInjection(runtime: ChatRuntime): boolean {
    try {
      return this.adapterFor(runtime).confirmsMcpInjection;
    } catch {
      return false;
    }
  }

  private adapters(): RuntimeAdapter[] {
    return [this.deps.opencode, this.deps.claude, ...(this.deps.codex ? [this.deps.codex] : [])];
  }

  private adapterFor(runtime: ChatRuntime): RuntimeAdapter {
    if (runtime === 'opencode') return this.deps.opencode;
    if (runtime === 'claude') return this.deps.claude;
    if (this.deps.codex) return this.deps.codex;
    throw new UnavailableError('Codex support is not available in this build');
  }

  private route(chatId: string): RuntimeAdapter {
    for (const adapter of this.adapters()) if (adapter.owns(chatId)) return adapter;
    throw new NotFoundError('Chat', chatId);
  }
}

function scrub(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !/^(ORCA_|CLAUDE_CODE_)/i.test(k) && k.toUpperCase() !== 'CLAUDECODE') out[k] = v;
  return out;
}
