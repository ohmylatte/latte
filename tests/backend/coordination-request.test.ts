import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationEngine, type CoordinationGrant } from '../../electron/coordination/engine';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * `latte_request_coordination`: the sentence becomes a gate
 * (design-v2-conversational D1). A WORKER grant — no coordinator, no run —
 * proposes a concrete plan; the tool writes exactly one `coordination_run`
 * row in `status:'planning'` and nothing else. Spec: "the entry point is a
 * sentence, not a form" (latte/coordination-wow-entrypoint).
 */
describe('latte_request_coordination: the sentence becomes a gate', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let tools: ReturnType<typeof createCoordinationTools>;
  let members: FakeTeamMember[];
  let workId: string;

  function proposerGrant(memberId = 'mem_proposer'): CoordinationGrant {
    return { workId, runId: null, memberId, role: 'worker' };
  }

  function proposal() {
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
    members = [];
    fakeCoordinationHub(b, members);
    // Q6: el proponente ES el estratega, y el plan le da una tarea a su propio
    // rol. Sin esto la propuesta tendría un rol que nadie cubre, y desde Q6
    // `requestCoordination` la rechaza en el origen: no es lo que estos tests
    // miden, y una propuesta así ya no puede existir.
    const at = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({
      id: 'mem_proposer', workId, roleId: 'strategist', roleName: 'Estratega', initial: 'E',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => '2026-01-01T00:00:00.000Z',
      memberContext: (id) => ({ workId: id, brandId: brand.id, directory: b.dir, title: 'x', extraEnv: {} }),
    });
    tools = createCoordinationTools(engine);
  });
  afterEach(() => b.cleanup());

  // --- 6.5: a worker may propose ----------------------------------------------

  describe('a worker may propose', () => {
    it('succeeds with a worker grant, writing exactly one planning run holding the whole proposal, and nothing else', async () => {
      const run = await engine.requestCoordination(proposerGrant(), proposal());

      expect(run.status).toBe('planning');
      expect(run.coordinatorMemberId).toBe('mem_proposer');
      // `unlimitedConfirmedAt` se guarda SIEMPRE en null: un presupuesto
      // ilimitado es una eleccion humana, y el agente no puede firmarsela
      // escribiendo su propio timestamp en la propuesta.
      expect(JSON.parse(run.planJson!)).toEqual({ ...proposal(), unlimitedConfirmedAt: null });
      expect(JSON.parse(run.budgetJson)).toMatchObject({ maxDispatches: 8 });

      expect(b.repo.listCoordinationTasks(run.id)).toEqual([]);
      expect(b.repo.listCoordinationDispatches(run.id)).toEqual([]);
      expect(b.hub.send).not.toHaveBeenCalled();
    });

    it('is reachable through the tool with requireCoordinator:false — a plain worker grant succeeds', async () => {
      const envelope = await tools.latte_request_coordination(proposerGrant(), proposal());
      expect(envelope.ok).toBe(true);
      expect((envelope.data as { status: string }).status).toBe('planning');
    });
  });

  // --- 6.6: a proposal cannot dispatch ----------------------------------------

  describe('a proposal cannot dispatch', () => {
    it('startDispatch rejects a planning run with COORDINATION_NOT_APPROVED, checked BEFORE the task even needs to exist', async () => {
      const run = await engine.requestCoordination(proposerGrant(), proposal());
      const coordinatorGrant: CoordinationGrant = { workId, runId: run.id, memberId: 'mem_proposer', role: 'coordinator' };
      // A made-up taskId proves the run-status assertion is the FIRST thing
      // checked: if task lookup ran first, this would fail NOT_FOUND instead.
      await expect(engine.startDispatch({ grant: coordinatorGrant, taskId: 'ctk_missing' }))
        .rejects.toMatchObject({ code: 'COORDINATION_NOT_APPROVED' });
      expect(b.repo.listCoordinationDispatches(run.id)).toEqual([]);
      expect(b.hub.send).not.toHaveBeenCalled();
    });
  });

  // --- 6.7: the single-choke-point invariant survives the new entry ----------

  describe('the single-choke-point invariant survives the new entry', () => {
    const engineSource = fs.readFileSync(path.resolve(__dirname, '../../electron/coordination/engine.ts'), 'utf8');

    it('hub.send appears exactly once in engine.ts (the real call site, this.deps.hub.send — doc-comment mentions of hub.send() do not count)', () => {
      const matches = engineSource.match(/\bthis\.deps\.hub\.send\(/g) ?? [];
      expect(matches).toHaveLength(1);
    });

    it("requestCoordination's own body calls none of hub.send / insertCoordinationDispatch / startDispatch", () => {
      const startIdx = engineSource.indexOf('async requestCoordination(');
      expect(startIdx).toBeGreaterThan(-1);
      const afterStart = engineSource.slice(startIdx);
      // El cierre de metodo a 2 espacios, sin atarse al fin de linea del
      // archivo: con CRLF el literal no matcheaba NUNCA, el slice se quedaba
      // en -1 y el cuerpo no se inspeccionaba jamas.
      const endMarker = afterStart.search(/\r?\n  \}\r?\n/); // methods close at 2-space indent in this file
      expect(endMarker).toBeGreaterThan(-1);
      const body = afterStart.slice(0, endMarker);
      expect(body).not.toMatch(/hub\.send\(/);
      expect(body).not.toMatch(/insertCoordinationDispatch\(/);
      expect(body).not.toMatch(/\bstartDispatch\(/);
    });
  });

  // --- 6.8: one proposal per Work ---------------------------------------------

  describe('one proposal per Work', () => {
    it('rejects a second proposal while one is still planning, naming the existing run — the same RUN_ALREADY_ACTIVE startRun already uses', async () => {
      const first = await engine.requestCoordination(proposerGrant('mem_a'), proposal());

      await expect(engine.requestCoordination(proposerGrant('mem_b'), proposal()))
        .rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE', message: expect.stringContaining(first.id) });

      expect(b.repo.findActiveCoordinationRun(workId)?.id).toBe(first.id);
      expect(b.repo.findActiveCoordinationRun(workId)?.status).toBe('planning');
    });

    it('rejects a proposal while a run is already running, naming the live run', async () => {
      await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
      const running = await engine.startRun(workId, null);

      await expect(engine.requestCoordination(proposerGrant(), proposal()))
        .rejects.toMatchObject({ code: 'RUN_ALREADY_ACTIVE', message: expect.stringContaining(running.id) });

      expect(b.repo.getCoordinationRun(running.id).status).toBe('running');
    });
  });
});
