import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import type { CoordinationRunRecord } from '../../electron/storage/repository';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * The proposal gate (tasks 6.9-6.13, design-v2-conversational D1): ONE
 * approval on a `'planning'` run grants coordinator + budget + authority +
 * hires + tasks, together — the same `resolveCoordinationGate` verb every
 * other gate already uses, never a second route.
 */
describe('the proposal gate', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let workId: string;

  function proposerGrant(memberId = 'mem_proposer'): CoordinationGrant {
    return { workId, runId: null, memberId, role: 'worker' };
  }

  function proposal(overrides: Partial<CoordinationProposal> = {}): CoordinationProposal {
    return { ...baseProposal(), ...overrides };
  }

  function baseProposal(): CoordinationProposal {
    return {
      plan: [{ roleId: 'strategist', spec: 'Draft the monthly content plan' }],
      estimatedDispatches: 8,
      membersToHire: [{ roleId: 'copywriter', why: 'Nobody on the team can write copy yet' }],
      rationale: 'El pedido fue coordinar al equipo y preparar el contenido del mes.',
    };
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    // A real member row: `LatteService.getCoordinatorGrant` only reports a
    // meta-key value back when it actually resolves to a member of this
    // Work (a stale/foreign id reads back as "no coordinator") — a genuine
    // proposer already has a live chat, so this mirrors reality.
    b.repo.insertMember({ id: 'mem_proposer', workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  });
  afterEach(() => b.cleanup());

  async function proposeAndGate(overrides: Partial<CoordinationProposal> = {}) {
    const run = await engine.requestCoordination(proposerGrant(), proposal(overrides));
    const gates = engine.listGates(run.id);
    const gate = gates.find((g) => g.kind === 'proposal')!;
    return { run, gate };
  }

  // --- 6.9: the proposal gate --------------------------------------------------

  describe('the proposal gate itself', () => {
    it.each(['manual', 'plan', 'auto'] as const)('emits exactly one proposal gate for a planning run under %s authority', async (mode) => {
      await b.service.setCoordinationAuthority(workId, mode);
      const { run, gate } = await proposeAndGate();

      expect(gate).toBeDefined();
      const proposalGates = engine.listGates(run.id).filter((g) => g.kind === 'proposal');
      expect(proposalGates).toHaveLength(1);
      expect(gate.proposalJson).toBe(run.planJson);
    });

    it('the pre-existing plan gate (Phase 3, "plan" authority) does not also fire for a planning-status run', async () => {
      await b.service.setCoordinationAuthority(workId, 'plan');
      const { run } = await proposeAndGate();

      const gates = engine.listGates(run.id);
      expect(gates.filter((g) => g.kind === 'plan')).toHaveLength(0);
    });
  });

  // --- 6.10: one approval grants everything ------------------------------------

  describe('one approval grants everything', () => {
    it('atomically grants coordinator + budget + authority, hires, creates tasks, and moves the run to running', async () => {
      const { run, gate } = await proposeAndGate();

      const resolved = await engine.resolveGate(gate.id, 'approve');

      expect((resolved as CoordinationRunRecord).status).toBe('running');
      expect(await b.service.getCoordinatorGrant(workId)).toBe('mem_proposer');
      expect(await b.service.getCoordinationBudget(workId)).toMatchObject({ maxDispatches: 8 });
      expect(JSON.parse(b.repo.getCoordinationRun(run.id).budgetJson)).toMatchObject({ maxDispatches: 8 });
      expect(await b.service.getCoordinationAuthority(workId)).toBe('plan');
      expect(members.some((m) => m.roleId === 'copywriter')).toBe(true);
      const tasks = b.repo.listCoordinationTasks(run.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ roleId: 'strategist', inPlan: true });
      expect(b.repo.getCoordinationRun(run.id).planApprovedAt).not.toBeNull();
    });

    it('a failing hub.addMember leaves NO grant, NO budget, NO tasks — the effects are atomic', async () => {
      const { run, gate } = await proposeAndGate();
      vi.spyOn(b.hub, 'addMember').mockRejectedValueOnce(new Error('boom: no seats left'));

      await expect(engine.resolveGate(gate.id, 'approve')).rejects.toThrow('boom');

      expect(await b.service.getCoordinatorGrant(workId)).toBeNull();
      expect(await b.service.getCoordinationBudget(workId)).toBeNull();
      expect(await b.service.getCoordinationAuthority(workId)).toBe('manual');
      expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
      expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
      expect(b.repo.getCoordinationRun(run.id).planApprovedAt).toBeNull();
    });
  });

  // --- 6.11: editAccept lowers the cap -----------------------------------------

  describe('editAccept lowers the cap', () => {
    it('an edited proposal (reduced estimatedDispatches, one hire removed) stores the edited budget and skips the removed hire', async () => {
      const { run, gate } = await proposeAndGate();
      const edited = proposal({ estimatedDispatches: 3, membersToHire: [] });

      await engine.resolveGate(gate.id, 'approve', JSON.stringify(edited));

      expect(await b.service.getCoordinationBudget(workId)).toMatchObject({ maxDispatches: 3 });
      expect(members.some((m) => m.roleId === 'copywriter')).toBe(false);
      expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(1); // the plan's own task still lands
    });

    it('re-asserts no implicit unlimited: an edited proposal with maxDispatches:null and no unlimitedConfirmedAt is rejected, granting nothing', async () => {
      const { run, gate } = await proposeAndGate();
      const edited = proposal({ estimatedDispatches: null });

      await expect(engine.resolveGate(gate.id, 'approve', JSON.stringify(edited))).rejects.toThrow();

      expect(await b.service.getCoordinatorGrant(workId)).toBeNull();
      expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
      expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
    });
  });

  // --- 6.12: reject grants nothing ---------------------------------------------

  describe('reject grants nothing', () => {
    it('cancels the run and leaves the three meta keys and the team exactly as they were', async () => {
      const { run, gate } = await proposeAndGate();
      const teamBefore = b.hub.listTeam(workId);

      const resolved = await engine.resolveGate(gate.id, 'reject');

      expect((resolved as CoordinationRunRecord).status).toBe('cancelled');
      expect(await b.service.getCoordinatorGrant(workId)).toBeNull();
      expect(await b.service.getCoordinationBudget(workId)).toBeNull();
      expect(await b.service.getCoordinationAuthority(workId)).toBe('manual');
      expect(b.hub.listTeam(workId)).toEqual(teamBefore);
      expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
    });
  });

  // --- 6.13: the aggregate is shown, not hidden --------------------------------

  describe('the aggregate is shown, not hidden', () => {
    it('with two other active runs, one of them explicitly unlimited, the aggregate reports null rather than a fabricated total', async () => {
      const brand2 = await b.service.createBrand('Otra marca');
      const work2 = await b.service.createWork(brand2.id, 'Otro trabajo');
      await b.service.setCoordinationBudget(work2.id, { maxDispatches: 10 });
      await engine.startRun(work2.id, null);

      const brand3 = await b.service.createBrand('Tercera marca');
      const work3 = await b.service.createWork(brand3.id, 'Tercer trabajo');
      await b.service.setCoordinationBudget(work3.id, { maxDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' });
      await engine.startRun(work3.id, null);

      const { gate } = await proposeAndGate(); // estimatedDispatches: 8

      expect(gate.aggregate).toEqual({ otherActiveRuns: 2, otherCommittedDispatches: null, totalIfApproved: null });
    });

    it('sums a finite total when no other active run is unlimited', async () => {
      const brand2 = await b.service.createBrand('Otra marca 2');
      const work2 = await b.service.createWork(brand2.id, 'Otro trabajo 2');
      await b.service.setCoordinationBudget(work2.id, { maxDispatches: 10 });
      await engine.startRun(work2.id, null);

      const { gate } = await proposeAndGate(); // estimatedDispatches: 8

      expect(gate.aggregate).toEqual({ otherActiveRuns: 1, otherCommittedDispatches: 10, totalIfApproved: 18 });
    });

    it('with no other active runs, the aggregate is zeroed rather than absent', async () => {
      const { gate } = await proposeAndGate();

      expect(gate.aggregate).toEqual({ otherActiveRuns: 0, otherCommittedDispatches: 0, totalIfApproved: 8 });
    });
  });
});
