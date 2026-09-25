/**
 * Hub wiring's assembly logic (tasks 6.28-6.32, design-v2-conversational D3):
 * decides which `AdapterMcpServer[]` a member's runtime receives on every
 * open, under TWO INDEPENDENT policies --
 *
 *   `latte_memory` (stdio, engram): every member of every Work, on every
 *   runtime (Claude, Codex and -- since each OpenCode member got its own
 *   process -- OpenCode).
 *   NOT gated by a run, NOT gated by any coordination flag, NOT subject to
 *   any coordination ceiling -- only `MAX_CODEX_APP_SERVERS_TOTAL` (a member
 *   may share an existing brand+account process with other engram-only
 *   members, or need a fresh one).
 *
 *   `latte_coordination` (http): only members eligible under the
 *   coordination ceilings (Claude always, once above its version floor;
 *   Codex only with an active run under `MAX_COORDINATED_CODEX_MEMBERS_PER_RUN`,
 *   or the Work's one bootstrap slot, and only while the app-wide
 *   `MAX_COORDINATED_CODEX_PROCESSES` has room; OpenCode under the twin
 *   `MAX_COORDINATED_OPENCODE_*` caps, counted in its own ledger).
 *
 * A member may therefore carry engram and no coordination server (the
 * ordinary case) -- NEVER the reverse.
 *
 * Token MINTING (task 6.28) is unconditional: `assign()` mints a token for
 * EVERY member of EVERY Work on every open, regardless of runtime or
 * eligibility -- the chicken-and-egg design-v2-conversational kills (a token
 * minted before any run exists, or for a runtime that never even receives
 * it, is harmless bookkeeping). Only DELIVERY (building the `http` entry
 * with that token) is ceiling-gated.
 *
 * `preview()` is the read-only twin `coordinationRuntimeSupport` (task
 * 6.33) calls: for an already-open member it reports the ACTUAL committed
 * decision (never a fresh, possibly-stale recompute); for a closed one it
 * answers "what would happen if opened right now" without minting a token,
 * touching the ledger, or starting the MCP server.
 */
import { claudeSupportsMcpInjection } from '../agents/tiers';
import type { AdapterMcpServer } from '../agents/types';
import type { ChatRuntime } from '../../shared/contracts';
import { memoryMcpServerFor } from '../memory/engram';
import {
  MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK,
  MAX_BOOTSTRAP_OPENCODE_MEMBERS_PER_WORK,
  MAX_CODEX_APP_SERVERS_TOTAL,
  MAX_COORDINATED_CODEX_MEMBERS_PER_RUN,
  MAX_COORDINATED_CODEX_PROCESSES,
  MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN,
  MAX_COORDINATED_OPENCODE_PROCESSES,
} from './limits';
import type { CoordinationTokenRegistry } from './tokens';

export type CoordinationDegradedReason =
  | 'claude_below_floor'
  | 'codex_run_cap'
  | 'codex_global_cap'
  | 'codex_process_ceiling'
  /** Los gemelos de `codex_run_cap`/`codex_global_cap` para OpenCode (ver `MAX_COORDINATED_OPENCODE_*`). */
  | 'opencode_run_cap'
  | 'opencode_global_cap'
  | 'engram_not_installed'
  /** El adaptador entregó menos de lo que este planificador reclamó (ver `confirmInjection`). */
  | 'runtime_refused_injection'
  /** El cupo estaba reservado y el servidor MCP local no pudo arrancar: la reserva se soltó y este miembro queda sin coordinación, pero con su memoria. */
  | 'coordination_server_unavailable';

export interface MemberInjectionStatus {
  runtime: ChatRuntime;
  coordinationInjected: boolean;
  memoryInjected: boolean;
  /** Whether this member currently has a working path to `latte_request_coordination`. */
  canPropose: boolean;
  /** The primary reason a policy is degraded; `null` when both are as expected. */
  reason: CoordinationDegradedReason | null;
  /**
   * Si el RUNTIME ya dijo qué levantó (crítico 7). `false` es "Latte escribió
   * la inyección y nadie la desmintió todavía" — que NO es lo mismo que
   * "anda". Una previsión hipotética (un miembro cerrado) tampoco está
   * confirmada: no hay proceso que pueda confirmar nada.
   */
  runtimeConfirmed: boolean;
}

export interface MemberInjectionInput {
  memberId: string;
  workId: string;
  brandId: string;
  runtime: ChatRuntime;
  accountId: string | null;
}

/** The slice of `LatteRepository` this planner reads -- kept narrow for testability. */
export interface CoordinationInjectionRepoPort {
  findActiveCoordinationRun(workId: string): unknown | null;
}

/** The slice of `CoordinationMcpServer` this planner needs -- lifecycle only, never `handleMcpRequest`. */
export interface CoordinationInjectionServerPort {
  ensureStarted(): Promise<void>;
  stopIfIdle(): void;
  readonly boundPort: number | null;
}

export interface CoordinationInjectionDeps {
  repo: CoordinationInjectionRepoPort;
  tokens: CoordinationTokenRegistry;
  server: CoordinationInjectionServerPort;
  /** The installed Claude Code CLI version, or `null` if not installed. Mirrors `RuntimeDetector.resolve('claude')`. */
  resolveClaudeVersion: () => Promise<string | null>;
  /** The resolved `engram` executable path, or `null` if not on PATH. Mirrors `EngramClient`'s own `locate()`. */
  resolveEngramBinary: () => Promise<string | null>;
  /**
   * Task 8.1 (rollout gate): `featureFlags('coordination')`. Optional,
   * defaults to ENABLED when absent -- every pre-8.1 test (`coordination-hub-wiring.test.ts`'s
   * 18 planner-level scenarios included) constructs this planner without it
   * and must keep behaving exactly as before. Real wiring (`bootstrap.ts`)
   * passes the REAL flag, off by default. When disabled, `latte_coordination`
   * is never delivered and the MCP server never starts (`ensureStarted` is
   * never called) -- `latte_memory` is computed and delivered exactly as
   * always (task 6.29's policy stays independent of this one).
   */
  isCoordinationEnabled?: () => boolean;
}

interface Decision {
  coordinationEligible: boolean;
  memoryServer: AdapterMcpServer | null;
  reason: CoordinationDegradedReason | null;
}

/** Lo que hay que esperar ANTES de mirar un solo cupo (ver `resolveSlowInputs`). */
interface SlowInputs {
  claudeVersion: string | null;
  memoryServer: AdapterMcpServer | null;
}

interface Claim {
  workId: string;
  /** Lo que `confirmInjection` necesita para tomar un slot de memoria igual que `assign()` lo toma. */
  brandId: string;
  accountId: string | null;
  runtime: ChatRuntime;
  coordinated: boolean;
  /** Set only for a genuinely memory-ONLY member (a coordinated member's memory rides its own process, no separate slot). */
  memorySlotKey: string | null;
  status: MemberInjectionStatus;
}

function memorySlotKeyFor(accountId: string | null, brandId: string): string {
  return `${accountId ?? 'system'}|${brandId}`;
}

/** The runtimes whose coordinated members are counted against a ceiling. Claude spawns nothing extra and has none. */
type CountedRuntime = 'codex' | 'opencode';

export class CoordinationInjectionPlanner {
  /**
   * runtime -> workId -> memberIds currently carrying `latte_coordination`.
   * One ledger per runtime, so an OpenCode team never eats a Codex slot or
   * the other way around: each ceiling measures its own processes.
   */
  private readonly coordinatedByRuntime: Record<CountedRuntime, Map<string, Set<string>>> = { codex: new Map(), opencode: new Map() };
  /** `accountId|brandId` -> memberIds currently sharing that memory-only Codex process. */
  private readonly memorySlots = new Map<string, Set<string>>();
  private readonly claims = new Map<string, Claim>();

  constructor(private readonly deps: CoordinationInjectionDeps) {}

  /**
   * Real assembly: mints a token unconditionally, decides delivery, commits the
   * ledger, returns the servers to hand the adapter.
   *
   * El ORDEN es el arreglo (crítico 10). Antes, `evaluate()` leía los cupos
   * DESPUÉS de esperar a `resolveClaudeVersion`/`memoryServerFor`, y la marca
   * (`markCoordinated`) se escribía DESPUÉS de esperar también a
   * `ensureStarted()`. Los locks que existen son por miembro, así que dos
   * miembros DISTINTOS abriendo a la vez leían los dos la misma foto de "hay
   * lugar" y entraban los dos, pasándose del techo. Ahora:
   *
   *   1. primero lo lento que NO depende de cupos;
   *   2. después, en UN SOLO TICK sin un `await` en el medio: leer los cupos,
   *      decidir y MARCAR — nadie puede meterse entre la lectura y la marca;
   *   3. después lo lento que sí depende de la decisión (`ensureStarted`);
   *   4. y si eso falla, COMPENSAR: soltar el cupo reservado y degradar sólo la
   *      entrada de coordinación — la memoria sobrevive (task 6.39).
   */
  async assign(input: MemberInjectionInput): Promise<{ servers: AdapterMcpServer[] | undefined; status: MemberInjectionStatus }> {
    // Task 6.28: unconditional, every member, every runtime -- delivery is a separate question.
    const token = this.deps.tokens.mint(input.workId, input.memberId);
    // (1) Lo lento que no mira ningún cupo.
    let resolved: SlowInputs;
    try {
      resolved = await this.resolveSlowInputs(input);
    } catch (error) {
      // D15: el token se acuña ANTES del primer await, a propósito. Pero si ese
      // await rechaza —el detector de Claude que se cae, `engram --version` que
      // no vuelve—, `assign()` se iba por excepción y el token quedaba vivo:
      // una credencial válida y sin vencimiento para un miembro que nunca
      // abrió, y `stopIfIdle` cuenta tokens, así que el listener de loopback
      // tampoco podía cerrarse. Lo que se acuña antes del await se revoca en su
      // catch.
      this.deps.tokens.revokeMember(input.workId, input.memberId);
      throw error;
    }

    // (2) UN SOLO TICK: de acá hasta el final del bloque no hay un solo `await`.
    const decision = this.decide(input, resolved);
    let coordinated = decision.coordinationEligible;
    let memorySlotKey: string | null = null;
    // El techo que estos contadores acotan es de PROCESOS `codex app-server`
    // (ver los docstrings de MAX_COORDINATED_CODEX_*). Claude no spawnea
    // ninguno: contarlo acá le comía el cupo a Codex sin gastar nada, y con
    // seis miembros Claude app-wide `totalSlots()` llegaba a frenar hasta la
    // rama de sólo-memoria. Sólo Codex entra al ledger.
    if (coordinated) this.markCoordinated(input.runtime, input.workId, input.memberId);
    // A coordinated member's memory rides the SAME process (the shared
    // http token already forces its own fingerprint) -- only a genuinely
    // memory-only member needs its own brand+account slot.
    if (decision.memoryServer && input.runtime === 'codex' && !coordinated) {
      memorySlotKey = memorySlotKeyFor(input.accountId, input.brandId);
      this.markMemorySlot(memorySlotKey, input.memberId);
    }
    // -- fin del tick --

    const servers: AdapterMcpServer[] = [];
    let reason = decision.reason;
    if (coordinated) {
      // (3) Lo lento, ya con el cupo reservado.
      try {
        await this.deps.server.ensureStarted();
        const port = this.deps.server.boundPort;
        servers.push({ kind: 'http', name: 'latte_coordination', url: `http://127.0.0.1:${port}/mcp`, token });
        // ENTREGADO, no solo acuniado (juicio #10, ronda 4): `mint()` corre para
        // todo miembro de todo Trabajo de toda Marca, asi que `tokens.size` nunca
        // llegaba a cero y `stopIfIdle` no podia cerrar el listener jamas. Esta
        // linea -- y solo esta -- es donde un token llega de verdad a un runtime.
        this.deps.tokens.markDelivered(input.workId, input.memberId);
      } catch {
        // (4) COMPENSACIÓN. El cupo reservado se suelta enseguida: dejarlo
        // marcado por un servidor que no arrancó se lo come a otra Marca para
        // siempre. Se degrada SÓLO la coordinación; la memoria sigue viajando.
        this.ledgerFor(input.runtime)?.get(input.workId)?.delete(input.memberId);
        coordinated = false;
        reason = 'coordination_server_unavailable';
        if (decision.memoryServer && input.runtime === 'codex') {
          memorySlotKey = memorySlotKeyFor(input.accountId, input.brandId);
          this.markMemorySlot(memorySlotKey, input.memberId);
        }
      }
    }
    if (decision.memoryServer) servers.push(decision.memoryServer);

    const status: MemberInjectionStatus = {
      runtime: input.runtime,
      coordinationInjected: coordinated,
      memoryInjected: decision.memoryServer != null,
      canPropose: coordinated,
      reason,
      // Todavía nadie del otro lado habló: `confirmInjection` es el único que
      // puede prender esto.
      runtimeConfirmed: false,
    };
    this.claims.set(input.memberId, {
      workId: input.workId, brandId: input.brandId, accountId: input.accountId, runtime: input.runtime,
      coordinated, memorySlotKey, status,
    });
    return { servers: servers.length > 0 ? servers : undefined, status };
  }

  /** Read-only: a live member's ACTUAL committed status; a closed member's hypothetical one. Never mints, never touches the ledger or the server. */
  async preview(input: MemberInjectionInput): Promise<MemberInjectionStatus> {
    const existing = this.claims.get(input.memberId);
    if (existing) return existing.status;
    const decision = this.decide(input, await this.resolveSlowInputs(input));
    return {
      runtime: input.runtime,
      coordinationInjected: decision.coordinationEligible,
      memoryInjected: decision.memoryServer != null,
      canPropose: decision.coordinationEligible,
      reason: decision.reason,
      // Una hipótesis ("qué pasaría si se abriera ahora") no la confirmó
      // ningún proceso, porque no hay proceso.
      runtimeConfirmed: false,
    };
  }

  /**
   * Lo que el ADAPTADOR entregó de verdad, después de arrancar el proceso.
   * `assign()` decide antes del spawn y deja el reclamo escrito; los
   * adaptadores se niegan después por su cuenta (Claude sin `promptDir` o con
   * `writeMcpConfigFile` fallando; Codex con su propio contador lleno), y sin
   * esto `preview()` — la fuente de `coordinationRuntimeSupport` — seguía
   * devolviendo el reclamo viejo y la UI afirmaba "Sin restricciones para
   * coordinar" sobre un proceso sin ningún servidor. `undefined` (un adaptador
   * que no pudo preguntar, o sin nada que preguntar) deja el reclamo intacto.
   */
  confirmInjection(memberId: string, injectedServerNames: string[] | undefined): void {
    if (!injectedServerNames) return;
    const claim = this.claims.get(memberId);
    if (!claim) return;
    // El runtime HABLÓ. Aunque lo que diga coincida punto por punto con el
    // reclamo, esto es lo que separa "anda" de "Latte lo escribió y nadie lo
    // desmintió todavía" (crítico 7c). Va antes del `return` de abajo: una
    // confirmación que confirma el reclamo tal cual también es evidencia.
    claim.status = { ...claim.status, runtimeConfirmed: true };
    const coordination = injectedServerNames.includes('latte_coordination');
    const memory = injectedServerNames.includes('latte_memory');
    const refused = (claim.status.coordinationInjected && !coordination) || (claim.status.memoryInjected && !memory);
    if (!refused) return;
    if (claim.coordinated && !coordination) {
      this.ledgerFor(claim.runtime)?.get(claim.workId)?.delete(memberId);
      claim.coordinated = false;
      // Y el cupo de MEMORIA se toma, exactamente como lo toma `assign()` al
      // degradar (ver su rama de compensación). Un miembro de Codex que pierde
      // la coordinación pero conserva `latte_memory` sigue teniendo un
      // `app-server` VIVO: sin este slot, ese proceso deja de contar en
      // `totalSlots()` y `MAX_CODEX_APP_SERVERS_TOTAL` empieza a autorizar
      // procesos que ya existen — el techo de procesos deja de medir procesos.
      if (claim.memorySlotKey == null && claim.status.memoryInjected && claim.runtime === 'codex') {
        claim.memorySlotKey = memorySlotKeyFor(claim.accountId, claim.brandId);
        this.markMemorySlot(claim.memorySlotKey, memberId);
      }
      // Y el token se REVOCA (crítico 11). Antes esto soltaba el cupo y dejaba
      // la credencial viva: el miembro rechazado seguía teniendo un bearer que
      // funcionaba —un token no vence— mientras otro se quedaba con su cupo, y
      // como `stopIfIdle` cuenta tokens ENTREGADOS, el servidor de loopback no
      // se podía apagar nunca. Va ANTES de `stopIfIdle` a propósito: si no,
      // `deliveredSize` todavía cuenta a este miembro y la puerta queda abierta.
      this.deps.tokens.revokeMember(claim.workId, memberId);
      this.deps.server.stopIfIdle();
    }
    if (claim.memorySlotKey && !memory) {
      this.memorySlots.get(claim.memorySlotKey)?.delete(memberId);
      claim.memorySlotKey = null;
    }
    claim.status = {
      ...claim.status,
      coordinationInjected: coordination,
      memoryInjected: memory,
      canPropose: coordination,
      reason: 'runtime_refused_injection',
    };
  }

  /**
   * LATTE se negó a inyectar después de que el reclamo ya estaba escrito (D7c).
   * Degrada exactamente como una negativa del runtime —suelta el cupo, revoca
   * el token, deja que el servidor se apague— pero NO toca `runtimeConfirmed`:
   * el proceso todavía no dijo una palabra, y decir que sí lo hizo es la
   * mentira que este campo existe para no contar.
   */
  noteLatteRefusedInjection(memberId: string): void {
    const claim = this.claims.get(memberId);
    if (!claim) return;
    if (claim.coordinated) {
      this.ledgerFor(claim.runtime)?.get(claim.workId)?.delete(memberId);
      claim.coordinated = false;
      this.deps.tokens.revokeMember(claim.workId, memberId);
      this.deps.server.stopIfIdle();
    }
    if (claim.memorySlotKey) {
      this.memorySlots.get(claim.memorySlotKey)?.delete(memberId);
      claim.memorySlotKey = null;
    }
    claim.status = {
      ...claim.status,
      coordinationInjected: false,
      memoryInjected: false,
      canPropose: false,
      reason: 'runtime_refused_injection',
    };
  }

  /**
   * Si los miembros de ESTE Trabajo llevan de verdad las herramientas de
   * engram AHORA MISMO. Lo lee `renderAndWriteInstructions`, que es sincrónico
   * y escribe UN archivo compartido por todo el Trabajo: por eso exige que
   * TODOS los reclamos vivos la tengan, nunca "alguno".
   *
   * Ronda 4, juicio #2: sin ningún reclamo vivo esto caía a
   * `lastEngramBinaryFound`, UNA bandera global de proceso que prendía
   * cualquier miembro de cualquier Marca. Y `renderAndWriteInstructions` se
   * dispara desde `memberContext()` justo cuando `liveMemberCount(work.id) ===
   * 0`, así que en la práctica ese fallback era SIEMPRE el que decidía: con la
   * Marca A ya resuelta, el primer miembro de un Trabajo de la Marca B — un
   * Codex pasado el `codex_process_ceiling`, o (entonces) un OpenCode, que no
   * recibían `latte_memory` — leía "ya tenés las herramientas de Engram,
   * scopeadas a esta marca… guardá y buscá sin pasar `project`". Con su propio
   * engram configurado globalmente, eso escribe la estrategia de la Marca B en
   * un proyecto autodetectado: una escritura cruzada entre Marcas. El
   * docstring argumentaba que la redacción conservadora es la honesta cuando
   * no se sabe, y después codeaba el default contrario. Ahora no se sabe =
   * `false`, y el flag global no participa.
   */
  memoryToolsInjectedForWork(workId: string): boolean {
    let live = 0;
    for (const claim of this.claims.values()) {
      if (claim.workId !== workId) continue;
      if (!claim.status.memoryInjected) return false;
      live += 1;
    }
    return live > 0;
  }

  /** Frees whatever this member held: revokes its token, releases any ceiling slot, and lets the MCP server stop if it is now idle. */
  release(memberId: string): void {
    const claim = this.claims.get(memberId);
    if (!claim) return;
    this.claims.delete(memberId);
    this.deps.tokens.revokeMember(claim.workId, memberId);
    if (claim.coordinated) {
      this.ledgerFor(claim.runtime)?.get(claim.workId)?.delete(memberId);
      this.deps.server.stopIfIdle();
    }
    if (claim.memorySlotKey) {
      this.memorySlots.get(claim.memorySlotKey)?.delete(memberId);
    }
  }

  /** `shutdown()`: releases every live claim. */
  releaseAll(): void {
    for (const memberId of [...this.claims.keys()]) this.release(memberId);
  }

  // -- Decision logic (pure given the current ledger) -----------------------

  /**
   * TODO lo lento que la decisión necesita y que NO depende de ningún cupo:
   * la versión de Claude instalada y el binario de engram. Separado a
   * propósito, para que `decide()` pueda ser sincrónico — es lo único que hace
   * que leer los cupos y marcarlos no puedan quedar a ambos lados de un await.
   */
  private async resolveSlowInputs(input: MemberInjectionInput): Promise<SlowInputs> {
    if (input.runtime === 'claude') {
      const claudeVersion = await this.deps.resolveClaudeVersion();
      // Por debajo del piso no hay inyección de ninguna clase, ni siquiera
      // memoria: no se pregunta por engram al pedo.
      if (!claudeSupportsMcpInjection(claudeVersion)) return { claudeVersion, memoryServer: null };
      return { claudeVersion, memoryServer: await this.memoryServerFor(input) };
    }
    return { claudeVersion: null, memoryServer: await this.memoryServerFor(input) };
  }

  /** La decisión entera, SINCRÓNICA: lee los cupos y devuelve el veredicto en el mismo tick en que el llamador lo marca. */
  private decide(input: MemberInjectionInput, resolved: SlowInputs): Decision {
    // Task 8.1: coordination lives behind `featureFlags('coordination')`.
    // Memory does not -- this is the ONLY read of the flag in this method,
    // and it only ever narrows `coordinationEligible`, never `memoryServer`.
    const coordinationFeatureOn = this.deps.isCoordinationEnabled ? this.deps.isCoordinationEnabled() : true;

    if (input.runtime === 'opencode') {
      // Un proceso por miembro: la memoria viaja siempre (no hay procesos
      // compartidos que acotar), la coordinación bajo sus topes gemelos.
      const memoryServer = resolved.memoryServer;
      const coordination = coordinationFeatureOn
        ? this.evaluateOpenCodeCoordination(input)
        : { eligible: false, reason: null as CoordinationDegradedReason | null };
      if (coordination.eligible) {
        return { coordinationEligible: true, memoryServer, reason: memoryServer ? null : 'engram_not_installed' };
      }
      return { coordinationEligible: false, memoryServer, reason: coordination.reason ?? (memoryServer ? null : 'engram_not_installed') };
    }

    if (input.runtime === 'claude') {
      if (!claudeSupportsMcpInjection(resolved.claudeVersion)) {
        return { coordinationEligible: false, memoryServer: null, reason: 'claude_below_floor' };
      }
      return {
        coordinationEligible: coordinationFeatureOn,
        memoryServer: resolved.memoryServer,
        reason: resolved.memoryServer ? null : 'engram_not_installed',
      };
    }

    // Codex: memory and coordination are evaluated independently, then
    // combined -- coordination, when granted, always carries memory too
    // (same process); memory alone needs its own ceiling check.
    const memoryServer = resolved.memoryServer;
    const coordination = coordinationFeatureOn
      ? this.evaluateCodexCoordination(input)
      : { eligible: false, reason: null as CoordinationDegradedReason | null };
    if (coordination.eligible) {
      return { coordinationEligible: true, memoryServer, reason: memoryServer ? null : 'engram_not_installed' };
    }
    if (!memoryServer) {
      // Coordination's own reason still explains the degraded state; an
      // absent engram binary is a distinct, secondary fact only surfaced
      // when coordination itself was not the blocker (see the `claude`
      // branch above for that case).
      return { coordinationEligible: false, memoryServer: null, reason: coordination.reason };
    }
    const key = memorySlotKeyFor(input.accountId, input.brandId);
    const slotAlreadyLive = (this.memorySlots.get(key)?.size ?? 0) > 0;
    if (slotAlreadyLive || this.totalSlots() < MAX_CODEX_APP_SERVERS_TOTAL) {
      return { coordinationEligible: false, memoryServer, reason: coordination.reason };
    }
    // No room even for memory alone: the total ceiling is the operative fact now.
    return { coordinationEligible: false, memoryServer: null, reason: 'codex_process_ceiling' };
  }

  private async memoryServerFor(input: MemberInjectionInput): Promise<AdapterMcpServer | null> {
    const binary = await this.deps.resolveEngramBinary();
    return memoryMcpServerFor(binary, input.brandId);
  }

  private evaluateCodexCoordination(input: MemberInjectionInput): { eligible: boolean; reason: CoordinationDegradedReason | null } {
    const hasRun = this.deps.repo.findActiveCoordinationRun(input.workId) != null;
    const perWorkCap = hasRun ? MAX_COORDINATED_CODEX_MEMBERS_PER_RUN : MAX_BOOTSTRAP_CODEX_MEMBERS_PER_WORK;
    const coordinatedHere = this.coordinatedByRuntime.codex.get(input.workId)?.size ?? 0;
    if (coordinatedHere >= perWorkCap) return { eligible: false, reason: 'codex_run_cap' };
    if (this.totalCoordinated('codex') >= MAX_COORDINATED_CODEX_PROCESSES) return { eligible: false, reason: 'codex_global_cap' };
    if (this.totalSlots() >= MAX_CODEX_APP_SERVERS_TOTAL) return { eligible: false, reason: 'codex_process_ceiling' };
    return { eligible: true, reason: null };
  }

  /**
   * Calcado de Codex, sin el techo de procesos totales: ése lo hace cumplir
   * `ChatManager` (`MAX_OPENCODE_SERVERS_TOTAL`), porque en OpenCode el
   * proceso ES el miembro y no hay forma de degradarlo a "sin proceso".
   */
  private evaluateOpenCodeCoordination(input: MemberInjectionInput): { eligible: boolean; reason: CoordinationDegradedReason | null } {
    const hasRun = this.deps.repo.findActiveCoordinationRun(input.workId) != null;
    const perWorkCap = hasRun ? MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN : MAX_BOOTSTRAP_OPENCODE_MEMBERS_PER_WORK;
    const coordinatedHere = this.coordinatedByRuntime.opencode.get(input.workId)?.size ?? 0;
    if (coordinatedHere >= perWorkCap) return { eligible: false, reason: 'opencode_run_cap' };
    if (this.totalCoordinated('opencode') >= MAX_COORDINATED_OPENCODE_PROCESSES) return { eligible: false, reason: 'opencode_global_cap' };
    return { eligible: true, reason: null };
  }

  // -- Ledger bookkeeping -----------------------------------------------------

  private ledgerFor(runtime: ChatRuntime): Map<string, Set<string>> | null {
    return runtime === 'claude' ? null : this.coordinatedByRuntime[runtime];
  }

  private markCoordinated(runtime: ChatRuntime, workId: string, memberId: string): void {
    const ledger = this.ledgerFor(runtime);
    if (!ledger) return;
    const set = ledger.get(workId) ?? new Set<string>();
    set.add(memberId);
    ledger.set(workId, set);
  }

  private markMemorySlot(key: string, memberId: string): void {
    const set = this.memorySlots.get(key) ?? new Set<string>();
    set.add(memberId);
    this.memorySlots.set(key, set);
  }

  private totalCoordinated(runtime: CountedRuntime): number {
    let total = 0;
    for (const set of this.coordinatedByRuntime[runtime].values()) total += set.size;
    return total;
  }

  /** Distinct live `codex app-server` process slots app-wide, of EITHER kind -- what `MAX_CODEX_APP_SERVERS_TOTAL` bounds. */
  private totalSlots(): number {
    let memorySlotCount = 0;
    for (const set of this.memorySlots.values()) if (set.size > 0) memorySlotCount += 1;
    return this.totalCoordinated('codex') + memorySlotCount;
  }
}
