/**
 * The coordination state machine. The ONLY writer of `coordination_dispatch`:
 * every path that could ever start a member working — a coordinator's
 * `latte_dispatch` tool call (`tools.ts`, later relayed over MCP), a human
 * approving a gate over IPC, or the handoff bridge — re-enters `startDispatch`
 * below. There is no second way to reach `hub.send()` for coordination.
 *
 * No new runtime machinery: dispatch drives a member exactly the way
 * `LatteService.requestBrandContextDraft` already does (reuse an idle member
 * for the role, or open one, then `hub.send(memberId, prompt)`).
 *
 * `maxConcurrent` is enforced here, not in the pure `budget.ts`: counting
 * in-flight dispatches is a DB read. The coordinator is excluded from that
 * count for free — it never has a `coordination_dispatch` row of its own (it
 * dispatches to others, it is never dispatched to).
 */
import type { AgentHub, MemberContext } from '../agents/hub';
import type { CoordinationAuthorityMode, CoordinationBudget } from '../../shared/contracts';
import { LatteError, NotFoundError, ValidationError } from '../core/errors';
import { FeatureDisabledError } from '../core/features';
import { newId } from '../core/ids';
import type {
  CoordinationAskRecord,
  CoordinationDispatchRecord,
  CoordinationMessageRecord,
  CoordinationRunRecord,
  CoordinationTaskRecord,
  LatteRepository,
} from '../storage/repository';
import { canAddTask, computeReadyTasks, computeTaskDepth, type DagEdge, type DagTask } from './dag';
import { assertBudgetConfigured, BudgetUnsetError, requireCoordinationBudget, reserveDispatch, type BudgetUsage } from './budget';
import { ASK_TTL_DEFAULT_MINUTES, ASK_TTL_MAX_MINUTES, MAX_ACTIVE_COORDINATION_RUNS, MAX_ATTEMPTS_PER_TASK, MAX_CHECK_WAIT_SECONDS } from './limits';

export type CoordinationRole = 'coordinator' | 'worker';

/**
 * Stands in for a minted MCP token's resolved identity. Phase 3 passed this
 * directly — "a fake token" per the design's own testing strategy. Phase 6
 * (`tokens.ts`) mints a token bound only to `{workId, memberId}`; THIS grant
 * — `runId` and `role` included — is resolved fresh per request by
 * `resolveGrant`, below, never frozen at mint (design-v2-conversational
 * overrules design v1). `runId` is `null` whenever the Work has no active
 * run: a token minted before any run exists is valid, and it is exactly how
 * `latte_request_coordination` (task 6.5) gets called at all.
 */
export interface CoordinationGrant {
  workId: string;
  runId: string | null;
  memberId: string;
  role: CoordinationRole;
}

export interface CoordinationBudgetBlock {
  dispatchesUsed: number;
  maxDispatches: number | null;
  inFlight: number;
  maxConcurrent: number | null;
}

export type CoordinationGateKind = 'plan' | 'dispatch' | 'budget' | 'proposal';

export interface CoordinationGate {
  id: string;
  kind: CoordinationGateKind;
  runId: string;
  taskId?: string;
  dispatchId?: string;
  prompt?: string;
  /** Only present on a `proposal` gate: the whole `CoordinationProposal`, JSON-encoded. */
  proposalJson?: string | null;
  /** Only present on a `proposal` gate: the aggregate across every OTHER active run, shown never hidden. */
  aggregate?: CoordinationGateAggregate;
  createdAt: string;
}

/**
 * The whole of a `latte_request_coordination` call — the sentence becomes a
 * gate (design-v2-conversational D1). Stored verbatim as `coordination_run
 * .plan_json` while `status:'planning'`; the human either approves it as-is
 * or edits it (`decision.editAdd`) before approving, per `resolveGate`'s
 * `'proposal'` branch.
 */
export interface CoordinationProposalTask {
  roleId: string;
  spec: string;
  dependsOn?: number[];
}

export interface CoordinationProposalHire {
  roleId: string;
  why: string;
}

export interface CoordinationProposal {
  plan: CoordinationProposalTask[];
  /** `null` only ever means "unlimited", and only alongside `unlimitedConfirmedAt` — "no implicit unlimited" applies to a proposal exactly as it does to a Work's own budget default. */
  estimatedDispatches: number | null;
  unlimitedConfirmedAt?: string | null;
  membersToHire?: CoordinationProposalHire[];
  rationale: string;
}

export interface CoordinationGateAggregate {
  otherActiveRuns: number;
  /** `null` when another live run is itself explicitly unlimited — never a fabricated number. */
  otherCommittedDispatches: number | null;
  totalIfApproved: number | null;
}

export interface CoordinationLogEntry {
  id: string;
  taskId: string;
  memberId: string;
  status: CoordinationDispatchRecord['status'];
  createdAt: string;
  startedAt: string | null;
  settledAt: string | null;
}

export interface CoordinationEngineDeps {
  repo: LatteRepository;
  hub: AgentHub;
  clock: () => string;
  memberContext: (workId: string) => MemberContext;
  /**
   * Task 6.37: called after a run/task/dispatch/gate change actually lands,
   * so the renderer's `latte:coordination-event` subscription can route an
   * event from a Brand the person is not currently looking at. Optional --
   * every pre-6.37 test constructs an engine without it, and this stays a
   * pure no-op for them.
   */
  emit?: (event: { brandId: string; workId: string; runId: string | null }) => void;
  /**
   * Task 8.1 (rollout gate): `featureFlags('coordination')`. Optional and
   * defaults to ENABLED when absent -- every pre-8.1 test (direct engine
   * construction, ~150 of them) never wires this and must keep behaving
   * exactly as before. Real production wiring (`latteService.ts`,
   * `bootstrap.ts`'s `mcpEngine`) passes the REAL flag, off by default like
   * every other feature. Gates only the two entry points that can create a
   * run (`startRun`, `requestCoordination`) -- everything downstream already
   * requires an active run (task 6.3's `NO_ACTIVE_RUN` guard), so gating
   * creation alone is sufficient: no run, no gate, no coordination server
   * ever gets used. Engram injection (task 6.29) is a SEPARATE policy and is
   * deliberately NOT read here.
   */
  isCoordinationEnabled?: () => boolean;
}

function isDagStatus(status: CoordinationTaskRecord['status']): DagTask['status'] {
  return status;
}

export class CoordinationEngine {
  constructor(private readonly deps: CoordinationEngineDeps) {}

  /** Task 6.37's own trigger. `brandId` comes from `memberContext` -- the same source every other Work->Brand lookup in this file uses. Never throws: a broken `emit` dep must not break coordination itself. */
  private touch(workId: string, runId: string | null): void {
    if (!this.deps.emit) return;
    try {
      this.deps.emit({ brandId: this.deps.memberContext(workId).brandId, workId, runId });
    } catch { /* an event listener's own failure is never this engine's problem */ }
  }

  /** Task 8.1: the single choke point for the rollout gate. Called first, before any read/write, by both `startRun` and `requestCoordination` -- the only two ways a run row can ever be created. */
  private requireCoordinationEnabled(): void {
    const enabled = this.deps.isCoordinationEnabled ? this.deps.isCoordinationEnabled() : true;
    if (!enabled) throw new FeatureDisabledError('coordination');
  }

  // -- Run lifecycle (IPC-facing) --------------------------------------------

  /** Requires a configured budget (`BUDGET_UNSET` otherwise) — no implicit unlimited run ever starts. */
  async startRun(workId: string, coordinatorMemberId: string | null): Promise<CoordinationRunRecord> {
    this.requireCoordinationEnabled();
    const existing = this.deps.repo.findActiveCoordinationRun(workId);
    if (existing) throw new LatteError('RUN_ALREADY_ACTIVE', 'This Work already has an active coordination run');
    this.assertRunCeiling();
    const budget = this.readBudget(workId);
    assertBudgetConfigured(budget);
    const now = this.deps.clock();
    const run = this.deps.repo.insertCoordinationRun({
      id: newId('crn'),
      workId,
      status: 'running',
      coordinatorMemberId,
      budgetJson: JSON.stringify(budget),
      planJson: null,
      planApprovedAt: null,
      suspendReason: null,
      createdAt: now,
      updatedAt: now,
    });
    this.touch(workId, run.id);
    return run;
  }

  getRun(runId: string): CoordinationRunRecord {
    return this.deps.repo.getCoordinationRun(runId);
  }

  /**
   * Resolves a member's grant PER REQUEST — the lazy-resolution rule
   * (task 6.2, overruling design v1's "freeze at mint"): `runId` is whatever
   * run is active for the Work right now (`null` if none), `role` is
   * whichever member currently holds the `coordination_coordinator:<W>` meta
   * key. The same `{workId, memberId}` pair, never re-minted and with no
   * process restart, moves from `runId:null`/`'worker'` to a live run and to
   * `'coordinator'` as the Work's state changes underneath it — and flips
   * back the moment the grant moves elsewhere, with no revocation step.
   */
  resolveGrant(workId: string, memberId: string): CoordinationGrant {
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    const coordinatorMemberId = this.deps.repo.getMeta('coordination_coordinator:' + workId);
    return { workId, memberId, runId: run?.id ?? null, role: coordinatorMemberId === memberId ? 'coordinator' : 'worker' };
  }

  listTasks(runId: string): CoordinationTaskRecord[] {
    return this.deps.repo.listCoordinationTasks(runId);
  }

  /** "Pausar equipo": takes effect at the next boundary. In-flight dispatches finish and report; nothing new starts. */
  pauseRun(runId: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running') return run;
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', this.deps.clock(), 'paused_by_human');
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /**
   * Unconditional: resuming just lets dispatch attempts proceed again. Whether
   * budget actually allows one is re-checked at the next `startDispatch` call,
   * never here — a resume with a still-exhausted budget simply re-suspends on
   * the next attempt instead of lying about being unblocked.
   */
  resumeRun(runId: string): CoordinationRunRecord {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'suspended') return run;
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'running', this.deps.clock(), null);
    this.touch(updated.workId, updated.id);
    return updated;
  }

  cancelRun(runId: string): CoordinationRunRecord {
    const updated = this.deps.repo.updateCoordinationRunStatus(runId, 'cancelled', this.deps.clock(), null);
    this.touch(updated.workId, updated.id);
    return updated;
  }

  /** The gate kinds a human resolves with approve/reject: proposal, plan, dispatch, budget-exhausted. Open `latte_ask`s are a separate surface (`answerAsk`). */
  listGates(runId: string): CoordinationGate[] {
    const run = this.deps.repo.getCoordinationRun(runId);
    const gates: CoordinationGate[] = [];
    // The proposal gate (task 6.9): a 'planning' run holds an unapproved
    // `latte_request_coordination` proposal. Unlike the 'plan' gate below,
    // it appears in EVERY authority mode — the proposal decides the
    // authority, so there is no authority yet to gate it by.
    if (run.status === 'planning') {
      const proposal = run.planJson ? (JSON.parse(run.planJson) as CoordinationProposal) : null;
      gates.push({
        id: `proposal:${run.id}`,
        kind: 'proposal',
        runId: run.id,
        proposalJson: run.planJson,
        aggregate: proposal ? this.computeAggregate(run, proposal) : undefined,
        createdAt: run.createdAt,
      });
    }
    // The plan snapshot only gates dispatch under 'plan' authority — under
    // 'manual' every dispatch already gates individually, and under 'auto'
    // nothing gates, so a plan gate would be a decision nobody needs to make.
    // Guarded against 'planning': that status is the PROPOSAL gate's own
    // territory above, even though `plan_json` is set on both (a different
    // shape — the whole proposal here, a task-id snapshot for the Phase 3
    // 'plan' gate) — the two must never both fire for the same run.
    if (run.status !== 'planning' && this.readAuthority(run.workId) === 'plan' && run.planJson && !run.planApprovedAt) {
      gates.push({ id: `plan:${run.id}`, kind: 'plan', runId: run.id, createdAt: run.createdAt });
    }
    for (const dispatch of this.deps.repo.listCoordinationDispatches(runId)) {
      if (dispatch.status === 'pending_approval') {
        gates.push({ id: dispatch.id, kind: 'dispatch', runId: run.id, taskId: dispatch.taskId, dispatchId: dispatch.id, prompt: dispatch.prompt, createdAt: dispatch.createdAt });
      }
    }
    if (run.status === 'suspended' && run.suspendReason && run.suspendReason !== 'paused_by_human' && run.suspendReason !== 'all_blocked_on_ask') {
      gates.push({ id: `budget:${run.id}`, kind: 'budget', runId: run.id, createdAt: run.updatedAt });
    }
    return gates;
  }

  /** Approves or rejects a proposal/plan/dispatch/budget gate. The dispatch branch re-enters `startDispatch` — the same choke point `latte_dispatch` uses. Task 6.37: fires the coordination event once, after the fact, for every branch. */
  async resolveGate(gateId: string, decision: 'approve' | 'reject', editedPrompt?: string | null): Promise<CoordinationGate | CoordinationDispatchRecord | CoordinationRunRecord> {
    const result = await this.resolveGateInternal(gateId, decision, editedPrompt);
    const workId = 'workId' in result ? result.workId : this.deps.repo.getCoordinationRun(result.runId).workId;
    const runId = 'runId' in result ? result.runId : result.id;
    this.touch(workId, runId);
    return result;
  }

  private async resolveGateInternal(gateId: string, decision: 'approve' | 'reject', editedPrompt?: string | null): Promise<CoordinationGate | CoordinationDispatchRecord | CoordinationRunRecord> {
    if (gateId.startsWith('proposal:')) {
      return this.resolveProposalGate(gateId.slice('proposal:'.length), decision, editedPrompt ?? undefined);
    }
    if (gateId.startsWith('plan:')) {
      const runId = gateId.slice('plan:'.length);
      const run = this.deps.repo.getCoordinationRun(runId);
      if (decision === 'reject') return this.cancelRun(runId);
      const snapshot: string[] = run.planJson ? JSON.parse(run.planJson) : [];
      const now = this.deps.clock();
      for (const taskId of snapshot) this.deps.repo.updateCoordinationTask(taskId, { inPlan: true }, now);
      return this.deps.repo.approveCoordinationPlan(runId, now);
    }
    if (gateId.startsWith('budget:')) {
      const runId = gateId.slice('budget:'.length);
      if (decision === 'reject') return this.cancelRun(runId);
      return this.resumeRun(runId);
    }
    // A dispatch gate: the id is the pending_approval dispatch row's own id.
    const dispatch = this.deps.repo.getCoordinationDispatch(gateId);
    if (decision === 'reject') {
      const now = this.deps.clock();
      this.deps.repo.updateCoordinationTask(dispatch.taskId, { status: 'ready', assignedMemberId: null }, now);
      return this.deps.repo.updateCoordinationDispatch(dispatch.id, { status: 'rejected', settledAt: now });
    }
    const outcome = await this.startDispatch({
      grant: { workId: this.deps.repo.getCoordinationRun(dispatch.runId).workId, runId: dispatch.runId, memberId: '', role: 'coordinator' },
      taskId: dispatch.taskId,
      approvedGateId: dispatch.id,
      editedPrompt: editedPrompt ?? undefined,
    });
    return this.deps.repo.getCoordinationDispatch(outcome.dispatchId);
  }

  /**
   * The proposal gate's own resolution (task 6.10, design-v2-conversational
   * D1). `reject` is trivial: `cancelRun` only ever touches `run.status`, so
   * "reject grants nothing" (task 6.12) holds for free — no meta key, no
   * hire, no task is ever written.
   *
   * `approve` performs SIX effects that must land together or not at all —
   * a failing `hub.addMember` must leave NO grant, NO budget, NO tasks
   * (task 6.10). `hub.addMember` is async and SQLite's own transaction is
   * synchronous, so the two cannot literally share one `BEGIN`/`COMMIT`;
   * atomicity is achieved by ORDERING instead: every hire is attempted
   * FIRST, before any database write, so a failure there throws with
   * nothing yet written. Once every hire has succeeded, the five remaining
   * effects (grant, budget meta key, budget on the run row, authority,
   * tasks + plan-approval + run status) land inside one real
   * `repo.transaction()`, so a failure among THEM (e.g. the task/depth cap)
   * cannot leave a partial result either.
   */
  private async resolveProposalGate(runId: string, decision: 'approve' | 'reject', editedProposalJson?: string): Promise<CoordinationRunRecord> {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (decision === 'reject') return this.cancelRun(runId);

    const proposal: CoordinationProposal = editedProposalJson ? JSON.parse(editedProposalJson) : JSON.parse(run.planJson!);
    // "No implicit unlimited" re-asserted for an EDITED proposal too (task
    // 6.11): the same validator `setCoordinationBudget` already uses.
    const budget = requireCoordinationBudget({ maxDispatches: proposal.estimatedDispatches, unlimitedConfirmedAt: proposal.unlimitedConfirmedAt ?? null });

    for (const hire of proposal.membersToHire ?? []) {
      await this.deps.hub.addMember({ ...this.deps.memberContext(run.workId), roleId: hire.roleId });
    }

    const now = this.deps.clock();
    return this.deps.repo.transaction(() => {
      this.deps.repo.setMeta('coordination_coordinator:' + run.workId, run.coordinatorMemberId ?? '');
      const budgetJson = JSON.stringify(budget);
      this.deps.repo.setMeta('coordination_budget:' + run.workId, budgetJson);
      this.deps.repo.updateActiveCoordinationRunBudget(run.workId, budgetJson, now); // the run is still 'planning' here — included in the active set
      this.deps.repo.setMeta('coordination_authority:' + run.workId, 'plan');
      this.deps.repo.setCoordinationPlan(run.id, JSON.stringify(proposal), now); // the approved (possibly edited) proposal, for the record
      const created: CoordinationTaskRecord[] = []; // index-based dependsOn, exactly like planSubmit's own loop
      for (const item of proposal.plan) {
        const dependsOnIds = (item.dependsOn ?? []).map((idx) => {
          const dep = created[idx];
          if (!dep) throw new ValidationError(`Plan task dependsOn index ${idx} is out of range`);
          return dep.id;
        });
        const task = this.createTaskRow(run.id, item.roleId, item.spec, dependsOnIds);
        this.deps.repo.updateCoordinationTask(task.id, { inPlan: true }, now);
        created.push(task);
      }
      this.deps.repo.approveCoordinationPlan(run.id, now);
      return this.deps.repo.updateCoordinationRunStatus(run.id, 'running', now, null);
    });
  }

  /**
   * The aggregate across every OTHER active run (task 6.13): shown, never
   * hidden. `null` for the sum — and therefore for the total — the moment
   * any other run is itself explicitly unlimited: an honest "can't sum
   * this" beats a fabricated number.
   */
  private computeAggregate(currentRun: CoordinationRunRecord, proposal: CoordinationProposal): CoordinationGateAggregate {
    const others = this.deps.repo.listActiveCoordinationRuns().filter((r) => r.id !== currentRun.id);
    let otherCommittedDispatches: number | null = 0;
    for (const other of others) {
      const budget = JSON.parse(other.budgetJson) as CoordinationBudget;
      if (budget.maxDispatches == null) { otherCommittedDispatches = null; break; }
      otherCommittedDispatches = (otherCommittedDispatches as number) + budget.maxDispatches;
    }
    const mine = proposal.estimatedDispatches;
    const totalIfApproved = mine == null || otherCommittedDispatches == null ? null : mine + otherCommittedDispatches;
    return { otherActiveRuns: others.length, otherCommittedDispatches, totalIfApproved };
  }

  /** The bitácora: derived only from `coordination_dispatch` rows, one entry per lifecycle event. */
  listLog(runId: string): CoordinationLogEntry[] {
    return this.deps.repo.listCoordinationDispatches(runId).map((d) => ({
      id: d.id, taskId: d.taskId, memberId: d.memberId, status: d.status, createdAt: d.createdAt, startedAt: d.startedAt, settledAt: d.settledAt,
    }));
  }

  answerAsk(askId: string, answer: string): CoordinationAskRecord {
    const answered = this.deps.repo.answerCoordinationAsk(askId, answer, this.deps.clock());
    // Answering may un-suspend a run that self-suspended on "all blocked on asks".
    const run = this.deps.repo.getCoordinationRun(answered.runId);
    if (run.status === 'suspended' && run.suspendReason === 'all_blocked_on_ask') {
      this.deps.repo.updateCoordinationRunStatus(run.id, 'running', this.deps.clock(), null);
    }
    this.touch(run.workId, run.id);
    return answered;
  }

  // -- Handoff bridge ---------------------------------------------------------

  /**
   * WHEN a Work has an active run, mints a `coordination_task` for the
   * accepted handoff instead of only opening a chat draft, then immediately
   * attempts to dispatch it through the exact same choke point `latte_dispatch`
   * uses. This is the human-driven path that needs no coordinator agent and no
   * MCP: the human's own UI action both creates the task and requests its
   * dispatch, and authority gating (manual/plan/auto) applies exactly as it
   * would to a coordinator-originated dispatch.
   */
  async bridgeHandoffToTask(workId: string, roleId: string, spec: string): Promise<{ bridged: false } | { bridged: true; task: CoordinationTaskRecord; dispatch: { status: 'dispatched' | 'pending_approval'; dispatchId: string } }> {
    const run = this.deps.repo.findActiveCoordinationRun(workId);
    if (!run) return { bridged: false };
    const task = this.createTaskRow(run.id, roleId, spec, []);
    const outcome = await this.startDispatch({ grant: { workId, runId: run.id, memberId: '', role: 'coordinator' }, taskId: task.id });
    this.touch(workId, run.id);
    return { bridged: true, task: this.deps.repo.getCoordinationTask(task.id), dispatch: { status: outcome.status, dispatchId: outcome.dispatchId } };
  }

  /**
   * The sentence becomes a gate (task 6.5, design-v2-conversational D1): ANY
   * member — a plain worker grant, no coordinator, no run needed — may
   * propose a plan. Writes exactly ONE `coordination_run` row,
   * `status:'planning'`, holding the whole proposal. Deliberately does
   * NOTHING else: zero tasks, zero dispatches, zero `hub.send` — a proposal
   * cannot spend (task 6.6 enforces this from the other side, at
   * `startDispatch`). "One proposal per Work" (task 6.8) reuses the exact
   * `RUN_ALREADY_ACTIVE` check `startRun` already makes — the partial unique
   * index's own `WHERE status IN (...)` already includes `'planning'`, so no
   * separate case is needed for "another proposal is already pending" vs.
   * "a run is already live": `findActiveCoordinationRun` sees both alike.
   */
  async requestCoordination(grant: CoordinationGrant, proposal: CoordinationProposal): Promise<CoordinationRunRecord> {
    this.requireCoordinationEnabled();
    const existing = this.deps.repo.findActiveCoordinationRun(grant.workId);
    if (existing) throw new LatteError('RUN_ALREADY_ACTIVE', `This Work already has an active coordination run (${existing.id}, ${existing.status})`);
    this.assertRunCeiling();
    const now = this.deps.clock();
    const run = this.deps.repo.insertCoordinationRun({
      id: newId('crn'),
      workId: grant.workId,
      status: 'planning',
      coordinatorMemberId: grant.memberId,
      budgetJson: JSON.stringify({ maxDispatches: proposal.estimatedDispatches, unlimitedConfirmedAt: proposal.unlimitedConfirmedAt ?? null }),
      planJson: JSON.stringify(proposal),
      planApprovedAt: null,
      suspendReason: null,
      createdAt: now,
      updatedAt: now,
    });
    this.touch(grant.workId, run.id);
    return run;
  }

  // -- Tool-facing engine methods (wrapped by tools.ts) ------------------------

  planSubmit(runId: string, tasks: Array<{ roleId: string; spec: string; dependsOn?: number[] }>): CoordinationTaskRecord[] {
    const run = this.deps.repo.getCoordinationRun(runId);
    const created: CoordinationTaskRecord[] = [];
    for (const spec of tasks) {
      const dependsOnIds = (spec.dependsOn ?? []).map((idx) => {
        const dep = created[idx];
        if (!dep) throw new ValidationError(`Plan task dependsOn index ${idx} is out of range`);
        return dep.id;
      });
      created.push(this.createTaskRow(run.id, spec.roleId, spec.spec, dependsOnIds));
    }
    const now = this.deps.clock();
    this.deps.repo.setCoordinationPlan(run.id, JSON.stringify(created.map((t) => t.id)), now);
    this.touch(run.workId, run.id);
    return created;
  }

  taskCreate(runId: string, input: { roleId: string; spec: string; dependsOn?: string[] }): CoordinationTaskRecord {
    const task = this.createTaskRow(runId, input.roleId, input.spec, input.dependsOn ?? []);
    this.touch(this.deps.repo.getCoordinationRun(runId).workId, runId);
    return task;
  }

  teamList(workId: string) {
    return this.deps.hub.listTeam(workId);
  }

  /**
   * THE single dispatch choke point. Every path that can ever start a member
   * working re-enters here. Order (non-negotiable, mirrors the design):
   * grant → active run → task ready → target member idle → authority gate
   * (short-circuits to `pending_approval`) → `maxConcurrent` → budget reserve
   * → `hub.send()` → dispatched row.
   */
  async startDispatch(ctx: { grant: CoordinationGrant; taskId: string; approvedGateId?: string; editedPrompt?: string }): Promise<{ status: 'dispatched' | 'pending_approval'; taskId: string; dispatchId: string }> {
    if (ctx.grant.role !== 'coordinator') throw new LatteError('FORBIDDEN', 'Only the coordinator may dispatch');
    if (ctx.grant.runId == null) throw new LatteError('RUN_NOT_ACTIVE', 'No active coordination run for this Work');
    const run = this.deps.repo.getCoordinationRun(ctx.grant.runId);
    // FIRST run-status assertion (task 6.6): a `'planning'` run holds an
    // unapproved proposal — `plan_json`/`budget_json` nobody confirmed yet.
    // Phase 3 left this open (it silently ACCEPTED 'planning', dormant only
    // because nothing ever wrote that status); the proposal gate now writes
    // it for real, so this must reject before anything else, or an
    // unapproved proposal could spend a budget no human confirmed.
    if (run.status === 'planning') throw new LatteError('COORDINATION_NOT_APPROVED', 'This coordination run has not been approved yet');
    if (run.status !== 'running') throw new LatteError('RUN_NOT_ACTIVE', `Run is ${run.status}`);
    const task = this.deps.repo.getCoordinationTask(ctx.taskId);
    if (task.runId !== run.id) throw new NotFoundError('CoordinationTask', ctx.taskId);

    let existingPending: CoordinationDispatchRecord | null = null;
    if (ctx.approvedGateId) {
      existingPending = this.deps.repo.getCoordinationDispatch(ctx.approvedGateId);
      if (existingPending.taskId !== task.id || existingPending.status !== 'pending_approval') {
        throw new LatteError('INVALID_GATE', 'Gate does not match a pending dispatch for this task');
      }
    } else if (task.status !== 'ready') {
      throw new LatteError('TASK_NOT_READY', `Task is ${task.status}, not ready`);
    }

    const session = await this.resolveTargetMember(run.workId, task.roleId);
    const prompt = ctx.editedPrompt ?? existingPending?.prompt ?? task.spec;
    const now = this.deps.clock();
    const authority = this.readAuthority(run.workId);
    const gated = !ctx.approvedGateId && this.isGated(authority, run, task);

    if (gated) {
      const dispatchId = newId('cdp');
      const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
      const dispatch = this.deps.repo.insertCoordinationDispatch({
        id: dispatchId, runId: run.id, taskId: task.id, memberId: session.id, attempt, status: 'pending_approval',
        gateId: dispatchId, prompt, outcome: null, summary: null, filesJson: null, reservationId: null,
        createdAt: now, startedAt: null, settledAt: null,
      });
      this.deps.repo.updateCoordinationTask(task.id, { status: 'dispatched', assignedMemberId: session.id }, now);
      this.touch(run.workId, run.id);
      return { status: 'pending_approval', taskId: task.id, dispatchId: dispatch.id };
    }

    const usage = this.usageFor(run.id);
    const budget = this.readRunBudget(run);
    const inFlight = this.countInFlightDispatches(run.id);
    if (budget.maxConcurrent != null && inFlight >= budget.maxConcurrent) {
      this.writeLedgerDenied(run.id, 'max_concurrent');
      if (existingPending) {
        this.deps.repo.updateCoordinationTask(task.id, { status: 'ready', assignedMemberId: null }, now);
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'rejected', settledAt: now });
      }
      throw new LatteError('MAX_CONCURRENT', 'Too many dispatches are already in flight');
    }

    const decision = reserveDispatch(budget, usage);
    if (!decision.ok) {
      this.writeLedgerDenied(run.id, decision.reason);
      if (run.status === 'running') this.deps.repo.updateCoordinationRunStatus(run.id, 'suspended', now, decision.reason);
      if (existingPending) {
        this.deps.repo.updateCoordinationTask(task.id, { status: 'ready', assignedMemberId: null }, now);
        this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'rejected', settledAt: now });
      }
      throw new LatteError('BUDGET_EXCEEDED', `Coordination budget denied: ${decision.reason}`);
    }

    const reservationId = newId('crs');
    this.deps.repo.insertCoordinationCostReservation({
      id: reservationId, runId: run.id, dispatchId: existingPending?.id ?? null, memberId: session.id, runtime: session.provider, model: session.model ?? 'default',
      maxInputTokens: 0, maxOutputTokens: 0, maxCostMicros: 0, state: 'reserved', usageJson: null, createdAt: now, settledAt: null,
    });

    let dispatch: CoordinationDispatchRecord;
    if (existingPending) {
      dispatch = this.deps.repo.updateCoordinationDispatch(existingPending.id, { status: 'dispatched', prompt, reservationId, startedAt: now });
    } else {
      const dispatchId = newId('cdp');
      const attempt = this.deps.repo.listCoordinationDispatches(run.id).filter((d) => d.taskId === task.id).length + 1;
      dispatch = this.deps.repo.insertCoordinationDispatch({
        id: dispatchId, runId: run.id, taskId: task.id, memberId: session.id, attempt, status: 'dispatched',
        gateId: null, prompt, outcome: null, summary: null, filesJson: null, reservationId,
        createdAt: now, startedAt: now, settledAt: null,
      });
    }
    this.deps.repo.updateCoordinationTask(task.id, { status: 'dispatched', assignedMemberId: session.id }, now);
    await this.deps.hub.send(session.id, prompt);
    this.touch(run.workId, run.id);
    return { status: 'dispatched', taskId: task.id, dispatchId: dispatch.id };
  }

  /** `outcome:'succeeded'` unblocks dependents; `'failed'` returns the task to `ready`, or `blocked` at the attempt cap. Idempotent on an already-`done` task. */
  async report(grant: CoordinationGrant, taskId: string, outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null = null): Promise<CoordinationTaskRecord> {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    const task = this.deps.repo.getCoordinationTask(taskId);
    // The CURRENT dispatch: there is at most one `dispatched`/`running` row
    // for a task at a time (a new attempt is only ever created after the
    // previous one settled), so this is more robust than "last by
    // createdAt" — two attempts can legitimately share a timestamp.
    const current = this.deps.repo.listCoordinationDispatches(task.runId).find((d) => d.taskId === taskId && (d.status === 'dispatched' || d.status === 'running'));
    if (task.status === 'done') return task; // idempotent: already settled, no duplicate row
    if (!current || current.memberId !== grant.memberId) {
      throw new LatteError('FORBIDDEN', 'Only the member this task is currently dispatched to may report it');
    }
    const now = this.deps.clock();
    if (current.reservationId) {
      this.deps.repo.settleCoordinationCostReservation(current.reservationId, null, now, false);
      this.deps.repo.insertCoordinationCostLedger({ id: newId('cld'), runId: task.runId, reservationId: current.reservationId, kind: 'spend', dispatches: 1, costMicros: 0, detailJson: JSON.stringify({ taskId, outcome }), createdAt: now });
    }
    this.deps.repo.updateCoordinationDispatch(current.id, { status: 'reported', outcome, summary, filesJson, settledAt: now });

    if (outcome === 'succeeded') {
      const updated = this.deps.repo.updateCoordinationTask(taskId, { status: 'done', resultSummary: summary, resultFilesJson: filesJson }, now);
      this.recomputeReadiness(task.runId, now);
      this.touch(grant.workId, task.runId);
      return updated;
    }
    const attempts = task.attempts + 1;
    this.touch(grant.workId, task.runId);
    if (attempts >= MAX_ATTEMPTS_PER_TASK) {
      return this.deps.repo.updateCoordinationTask(taskId, { status: 'blocked', attempts }, now);
    }
    return this.deps.repo.updateCoordinationTask(taskId, { status: 'ready', attempts, assignedMemberId: null }, now);
  }

  /**
   * Manual settlement via IPC, zero MCP (task 3.19 — the "close" half of the
   * safety line): `latte_report` is called by the WORKER, but without MCP no
   * worker has tools, so nothing ever settled a dispatch. Under `manual`
   * authority the human already IS the coordinator, so it/she reads the
   * worker's own chat and records the outcome directly.
   *
   * This is NOT a second route into the engine: it re-enters `report()` —
   * the exact function `latte_report` calls — by resolving the current
   * dispatch's own member id first, so every rule `report()` enforces
   * (idempotency on an already-`done` task, rejection when no dispatch is
   * currently assigned, ledger settlement, the dispatch's settling
   * timestamp) applies completely unchanged.
   */
  async settleDispatch(taskId: string, outcome: 'succeeded' | 'failed', summary: string, filesJson: string | null = null): Promise<CoordinationTaskRecord> {
    const task = this.deps.repo.getCoordinationTask(taskId);
    const run = this.deps.repo.getCoordinationRun(task.runId);
    const current = this.deps.repo.listCoordinationDispatches(task.runId).find((d) => d.taskId === taskId && (d.status === 'dispatched' || d.status === 'running'));
    const grant: CoordinationGrant = { workId: run.workId, runId: run.id, memberId: current?.memberId ?? task.assignedMemberId ?? '', role: 'worker' };
    return this.report(grant, taskId, outcome, summary, filesJson);
  }

  /** FIFO, single delivery, no real waiting: the cap on `wait` bounds a live server's long-poll (Phase 6); Phase 3 has no dispatcher loop, so it is a synchronous read. */
  check(memberId: string, _wait?: number): CoordinationMessageRecord[] {
    void _wait; // acknowledged, never actually slept on — see MAX_CHECK_WAIT_SECONDS note below.
    const run = this.activeRunForMember(memberId);
    if (!run) return [];
    const messages = this.deps.repo.listUndeliveredCoordinationMessages(run.id, memberId);
    const now = this.deps.clock();
    for (const m of messages) this.deps.repo.markCoordinationMessageDelivered(m.id, now);
    return messages;
  }

  ask(grant: CoordinationGrant, question: string, ttlMinutes?: number, taskId?: string): CoordinationAskRecord {
    if (grant.runId == null) throw new LatteError('NO_ACTIVE_RUN', 'This Work has no active coordination run');
    const clampedTtl = Math.min(Math.max(ttlMinutes ?? ASK_TTL_DEFAULT_MINUTES, 1), ASK_TTL_MAX_MINUTES);
    const now = this.deps.clock();
    const deadline = new Date(new Date(now).getTime() + clampedTtl * 60_000).toISOString();
    const ask = this.deps.repo.insertCoordinationAsk({
      id: newId('cak'), runId: grant.runId, taskId: taskId ?? null, memberId: grant.memberId, question, answer: null,
      deadlineAt: deadline, answeredAt: null, createdAt: now,
    });
    this.maybeSelfSuspendOnAsks(grant.runId, now);
    this.touch(grant.workId, grant.runId);
    return ask;
  }

  /** A synchronous poll of one ask: never blocks. Past its deadline and still unanswered, it reports `{answered:false, deadline}` rather than hanging. */
  askStatus(askId: string): { answered: boolean; answer?: string | null; deadline: string } {
    const ask = this.deps.repo.getCoordinationAsk(askId);
    if (ask.answeredAt) return { answered: true, answer: ask.answer, deadline: ask.deadlineAt };
    return { answered: false, deadline: ask.deadlineAt };
  }

  /** Crash/death settlement. `incrementAttempts:false` for an app-restart crash (not the agent's fault); `true` for a member-process death (a real failure). */
  settleUncertain(dispatchId: string, opts: { incrementAttempts: boolean }): CoordinationDispatchRecord {
    const dispatch = this.deps.repo.getCoordinationDispatch(dispatchId);
    const now = this.deps.clock();
    if (dispatch.reservationId) this.deps.repo.settleCoordinationCostReservation(dispatch.reservationId, null, now, true);
    const settled = this.deps.repo.updateCoordinationDispatch(dispatchId, { status: 'cancelled', settledAt: now });
    const task = this.deps.repo.getCoordinationTask(dispatch.taskId);
    const attempts = opts.incrementAttempts ? task.attempts + 1 : task.attempts;
    const status = opts.incrementAttempts && attempts >= MAX_ATTEMPTS_PER_TASK ? 'blocked' : 'ready';
    this.deps.repo.updateCoordinationTask(task.id, { status, attempts, assignedMemberId: null }, now);
    return settled;
  }

  // -- Envelope helpers for tools.ts -------------------------------------------
  // Kept public (only these two) so tools.ts never reaches into the repo or
  // hub directly — every envelope's `authority`/`budget` block is read the
  // same way a dispatch attempt itself would compute it.

  readAuthorityForEnvelope(workId: string): CoordinationAuthorityMode {
    return this.readAuthority(workId);
  }

  /** `null` (no active run for the Work — a lazily-resolved grant's honest state) answers with a zeroed block instead of throwing `NotFound`. */
  budgetBlockForEnvelope(runId: string | null): CoordinationBudgetBlock {
    if (runId == null) return { dispatchesUsed: 0, maxDispatches: null, inFlight: 0, maxConcurrent: null };
    const run = this.deps.repo.getCoordinationRun(runId);
    const budget = this.readRunBudget(run);
    const usage = this.usageFor(runId);
    return {
      dispatchesUsed: usage.dispatchesUsed,
      maxDispatches: budget.maxDispatches,
      inFlight: this.countInFlightDispatches(runId),
      maxConcurrent: budget.maxConcurrent ?? null,
    };
  }

  // -- Internals ---------------------------------------------------------------

  /**
   * The app-wide ceiling on simultaneously active runs (task 6.15): checked
   * AFTER the per-Work `RUN_ALREADY_ACTIVE` check (a Work with its own
   * active run never reaches this — that is a different, older error), so
   * this only ever fires for a genuinely NEW run competing for one of
   * `MAX_ACTIVE_COORDINATION_RUNS` app-wide slots. Never a silent queue: the
   * caller is rejected immediately, and the message names every busy Work so
   * a human knows exactly what to close to make room.
   */
  private assertRunCeiling(): void {
    const active = this.deps.repo.listActiveCoordinationRuns();
    if (active.length < MAX_ACTIVE_COORDINATION_RUNS) return;
    const busyWorkTitles = active.map((run) => {
      try {
        return this.deps.repo.getWork(run.workId).title;
      } catch {
        return run.workId; // a Work looked up mid-deletion race: fall back to its id rather than throwing here.
      }
    });
    throw new LatteError(
      'TOO_MANY_ACTIVE_RUNS',
      `Too many coordination runs are active app-wide (limit ${MAX_ACTIVE_COORDINATION_RUNS}): ${busyWorkTitles.join(', ')}`,
    );
  }

  private createTaskRow(runId: string, roleId: string, spec: string, dependsOnIds: string[]): CoordinationTaskRecord {
    const existing = this.deps.repo.listCoordinationTasks(runId);
    const depths = dependsOnIds.map((id) => this.deps.repo.getCoordinationTask(id).depth);
    const depth = computeTaskDepth(depths);
    const decision = canAddTask({ currentTaskCount: existing.length, proposedDepth: depth });
    if (!decision.ok) throw new LatteError(decision.reason === 'task_cap' ? 'TASK_CAP' : 'DEPTH_CAP', `Cannot add task: ${decision.reason}`);
    const now = this.deps.clock();
    const task = this.deps.repo.insertCoordinationTask({
      id: newId('ctk'), runId, seq: existing.length + 1, roleId, spec,
      status: dependsOnIds.length === 0 ? 'ready' : 'pending', depth, attempts: 0, inPlan: false,
      assignedMemberId: null, resultSummary: null, resultFilesJson: null, createdAt: now, updatedAt: now,
    });
    for (const dep of dependsOnIds) this.deps.repo.insertCoordinationTaskDep(task.id, dep);
    return task;
  }

  private recomputeReadiness(runId: string, now: string): void {
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    const edges: DagEdge[] = this.deps.repo.listCoordinationTaskDeps(runId);
    const dagTasks: DagTask[] = tasks.map((t) => ({ id: t.id, status: isDagStatus(t.status) }));
    const ready = new Set(computeReadyTasks(dagTasks, edges));
    for (const task of tasks) {
      if (task.status === 'pending' && ready.has(task.id)) this.deps.repo.updateCoordinationTask(task.id, { status: 'ready' }, now);
    }
  }

  private maybeSelfSuspendOnAsks(runId: string, now: string): void {
    const run = this.deps.repo.getCoordinationRun(runId);
    if (run.status !== 'running') return;
    const tasks = this.deps.repo.listCoordinationTasks(runId);
    const openAsks = this.deps.repo.listOpenCoordinationAsks(runId);
    if (openAsks.length === 0) return;
    const blockedTaskIds = new Set(openAsks.map((a) => a.taskId).filter((id): id is string => id != null));
    const readyEligible = tasks.filter((t) => t.status === 'ready' || t.status === 'dispatched' || t.status === 'running');
    const allBlocked = readyEligible.length > 0 && readyEligible.every((t) => blockedTaskIds.has(t.id));
    if (allBlocked) this.deps.repo.updateCoordinationRunStatus(runId, 'suspended', now, 'all_blocked_on_ask');
  }

  private isGated(authority: CoordinationAuthorityMode, run: CoordinationRunRecord, task: CoordinationTaskRecord): boolean {
    if (authority === 'auto') return false;
    if (authority === 'manual') return true;
    return !(run.planApprovedAt && task.inPlan);
  }

  private readAuthority(workId: string): CoordinationAuthorityMode {
    const raw = this.deps.repo.getMeta('coordination_authority:' + workId);
    return raw === 'plan' || raw === 'auto' ? raw : 'manual';
  }

  private readBudget(workId: string): CoordinationBudget | null {
    const raw = this.deps.repo.getMeta('coordination_budget:' + workId);
    if (!raw) return null;
    try { return JSON.parse(raw) as CoordinationBudget; } catch { return null; }
  }

  private readRunBudget(run: CoordinationRunRecord): CoordinationBudget {
    return JSON.parse(run.budgetJson) as CoordinationBudget;
  }

  private usageFor(runId: string): BudgetUsage {
    const ledger = this.deps.repo.listCoordinationCostLedger(runId);
    let dispatchesUsed = 0;
    let costMicrosUsed = 0;
    for (const row of ledger) {
      if (row.kind !== 'spend') continue;
      dispatchesUsed += row.dispatches;
      costMicrosUsed += row.costMicros;
    }
    return { dispatchesUsed, costMicrosUsed };
  }

  private countInFlightDispatches(runId: string): number {
    return this.deps.repo.listCoordinationDispatches(runId).filter((d) => d.status === 'dispatched' || d.status === 'running').length;
  }

  private writeLedgerDenied(runId: string, reason: string): void {
    this.deps.repo.insertCoordinationCostLedger({
      id: newId('cld'), runId, reservationId: null, kind: 'denied', dispatches: 0, costMicros: 0,
      detailJson: JSON.stringify({ reason }), createdAt: this.deps.clock(),
    });
  }

  private activeRunForMember(memberId: string): CoordinationRunRecord | null {
    const member = this.deps.repo.findMember(memberId);
    if (!member) return null;
    return this.deps.repo.findActiveCoordinationRun(member.workId);
  }

  /** Reuses an existing idle member for the role, or opens one — the exact `requestBrandContextDraft` precedent, never a new spawn mechanism. */
  private async resolveTargetMember(workId: string, roleId: string) {
    const team = this.deps.hub.listTeam(workId);
    const candidates = team.filter((m) => m.roleId === roleId && m.status !== 'ended');
    const idle = candidates.find((m) => m.status !== 'working');
    if (candidates.length > 0 && !idle) throw new LatteError('MEMBER_BUSY', `Every ${roleId} member is already working`);
    const context = this.deps.memberContext(workId);
    return idle ? this.deps.hub.openMember(idle.id, context) : this.deps.hub.addMember({ ...context, roleId });
  }
}
