/**
 * Hub wiring's assembly logic (tasks 6.28-6.32, design-v2-conversational D3):
 * decides which `AdapterMcpServer[]` a member's runtime receives on every
 * open, under TWO INDEPENDENT policies --
 *
 *   `latte_memory` (stdio, engram): every member of every Work, wherever the
 *   runtime supports per-member injection (Claude, Codex -- never OpenCode).
 *   NOT gated by a run, NOT gated by any coordination flag, NOT subject to
 *   any coordination ceiling -- only `MAX_CODEX_APP_SERVERS_TOTAL` (a member
 *   may share an existing brand+account process with other engram-only
 *   members, or need a fresh one).
 *
 *   `latte_coordination` (http): only members eligible under the
 *   coordination ceilings (Claude always, once above its version floor;
 *   Codex only with an active run under `MAX_COORDINATED_CODEX_MEMBERS_PER_RUN`,
 *   or the Work's one bootstrap slot, and only while the app-wide
 *   `MAX_COORDINATED_CODEX_PROCESSES` has room).
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
  MAX_CODEX_APP_SERVERS_TOTAL,
  MAX_COORDINATED_CODEX_MEMBERS_PER_RUN,
  MAX_COORDINATED_CODEX_PROCESSES,
} from './limits';
import type { CoordinationTokenRegistry } from './tokens';

export type CoordinationDegradedReason =
  | 'claude_below_floor'
  | 'codex_run_cap'
  | 'codex_global_cap'
  | 'codex_process_ceiling'
  | 'opencode_shared_server'
  | 'engram_not_installed';

export interface MemberInjectionStatus {
  runtime: ChatRuntime;
  coordinationInjected: boolean;
  memoryInjected: boolean;
  /** Whether this member currently has a working path to `latte_request_coordination`. */
  canPropose: boolean;
  /** The primary reason a policy is degraded; `null` when both are as expected. */
  reason: CoordinationDegradedReason | null;
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
}

interface Decision {
  coordinationEligible: boolean;
  memoryServer: AdapterMcpServer | null;
  reason: CoordinationDegradedReason | null;
}

interface Claim {
  workId: string;
  coordinated: boolean;
  /** Set only for a genuinely memory-ONLY member (a coordinated member's memory rides its own process, no separate slot). */
  memorySlotKey: string | null;
  status: MemberInjectionStatus;
}

function memorySlotKeyFor(accountId: string | null, brandId: string): string {
  return `${accountId ?? 'system'}|${brandId}`;
}

export class CoordinationInjectionPlanner {
  /** workId -> memberIds currently carrying `latte_coordination` (Codex only; Claude has no ceiling to count against). */
  private readonly coordinatedByWork = new Map<string, Set<string>>();
  /** `accountId|brandId` -> memberIds currently sharing that memory-only Codex process. */
  private readonly memorySlots = new Map<string, Set<string>>();
  private readonly claims = new Map<string, Claim>();

  constructor(private readonly deps: CoordinationInjectionDeps) {}

  /** Real assembly: mints a token unconditionally, decides delivery, commits the ledger, returns the servers to hand the adapter. */
  async assign(input: MemberInjectionInput): Promise<{ servers: AdapterMcpServer[] | undefined; status: MemberInjectionStatus }> {
    // Task 6.28: unconditional, every member, every runtime -- delivery is a separate question.
    const token = this.deps.tokens.mint(input.workId, input.memberId);
    const decision = await this.evaluate(input);

    const servers: AdapterMcpServer[] = [];
    let coordinated = false;
    let memorySlotKey: string | null = null;

    if (decision.coordinationEligible) {
      await this.deps.server.ensureStarted();
      const port = this.deps.server.boundPort;
      servers.push({ kind: 'http', name: 'latte_coordination', url: `http://127.0.0.1:${port}/mcp`, token });
      this.markCoordinated(input.workId, input.memberId);
      coordinated = true;
    }
    if (decision.memoryServer) {
      servers.push(decision.memoryServer);
      // A coordinated member's memory rides the SAME process (the shared
      // http token already forces its own fingerprint) -- only a genuinely
      // memory-only member needs its own brand+account slot.
      if (input.runtime === 'codex' && !coordinated) {
        memorySlotKey = memorySlotKeyFor(input.accountId, input.brandId);
        this.markMemorySlot(memorySlotKey, input.memberId);
      }
    }

    const status: MemberInjectionStatus = {
      runtime: input.runtime,
      coordinationInjected: decision.coordinationEligible,
      memoryInjected: decision.memoryServer != null,
      canPropose: decision.coordinationEligible,
      reason: decision.reason,
    };
    this.claims.set(input.memberId, { workId: input.workId, coordinated, memorySlotKey, status });
    return { servers: servers.length > 0 ? servers : undefined, status };
  }

  /** Read-only: a live member's ACTUAL committed status; a closed member's hypothetical one. Never mints, never touches the ledger or the server. */
  async preview(input: MemberInjectionInput): Promise<MemberInjectionStatus> {
    const existing = this.claims.get(input.memberId);
    if (existing) return existing.status;
    const decision = await this.evaluate(input);
    return {
      runtime: input.runtime,
      coordinationInjected: decision.coordinationEligible,
      memoryInjected: decision.memoryServer != null,
      canPropose: decision.coordinationEligible,
      reason: decision.reason,
    };
  }

  /** Frees whatever this member held: revokes its token, releases any ceiling slot, and lets the MCP server stop if it is now idle. */
  release(memberId: string): void {
    const claim = this.claims.get(memberId);
    if (!claim) return;
    this.claims.delete(memberId);
    this.deps.tokens.revokeMember(claim.workId, memberId);
    if (claim.coordinated) {
      this.coordinatedByWork.get(claim.workId)?.delete(memberId);
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

  private async evaluate(input: MemberInjectionInput): Promise<Decision> {
    if (input.runtime === 'opencode') {
      return { coordinationEligible: false, memoryServer: null, reason: 'opencode_shared_server' };
    }

    if (input.runtime === 'claude') {
      const version = await this.deps.resolveClaudeVersion();
      if (!claudeSupportsMcpInjection(version)) {
        return { coordinationEligible: false, memoryServer: null, reason: 'claude_below_floor' };
      }
      const memoryServer = await this.memoryServerFor(input);
      return { coordinationEligible: true, memoryServer, reason: memoryServer ? null : 'engram_not_installed' };
    }

    // Codex: memory and coordination are evaluated independently, then
    // combined -- coordination, when granted, always carries memory too
    // (same process); memory alone needs its own ceiling check.
    const memoryServer = await this.memoryServerFor(input);
    const coordination = this.evaluateCodexCoordination(input);
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
    const coordinatedHere = this.coordinatedByWork.get(input.workId)?.size ?? 0;
    if (coordinatedHere >= perWorkCap) return { eligible: false, reason: 'codex_run_cap' };
    if (this.totalCoordinated() >= MAX_COORDINATED_CODEX_PROCESSES) return { eligible: false, reason: 'codex_global_cap' };
    if (this.totalSlots() >= MAX_CODEX_APP_SERVERS_TOTAL) return { eligible: false, reason: 'codex_process_ceiling' };
    return { eligible: true, reason: null };
  }

  // -- Ledger bookkeeping -----------------------------------------------------

  private markCoordinated(workId: string, memberId: string): void {
    const set = this.coordinatedByWork.get(workId) ?? new Set<string>();
    set.add(memberId);
    this.coordinatedByWork.set(workId, set);
  }

  private markMemorySlot(key: string, memberId: string): void {
    const set = this.memorySlots.get(key) ?? new Set<string>();
    set.add(memberId);
    this.memorySlots.set(key, set);
  }

  private totalCoordinated(): number {
    let total = 0;
    for (const set of this.coordinatedByWork.values()) total += set.size;
    return total;
  }

  /** Distinct live `codex app-server` process slots app-wide, of EITHER kind -- what `MAX_CODEX_APP_SERVERS_TOTAL` bounds. */
  private totalSlots(): number {
    let memorySlotCount = 0;
    for (const set of this.memorySlots.values()) if (set.size > 0) memorySlotCount += 1;
    return this.totalCoordinated() + memorySlotCount;
  }
}
