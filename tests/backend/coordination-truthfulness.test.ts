import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine, type CoordinationGrant, type CoordinationProposal } from '../../electron/coordination/engine';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Ronda 2 del juicio adversarial: cada test de acá abajo reproduce una
 * CAPACIDAD QUE LATTE DICE TENER Y NO TIENE, o un estado del que la persona
 * no puede salir. `AGENTS.md` prohíbe exactamente eso.
 */

const REPO_ROOT = join(__dirname, '..', '..');

describe('el separador de la clave de token es imprimible (juicio #13)', () => {
  it('tokens.ts no contiene ningún byte NUL: un archivo fuente tiene que ser diffeable', () => {
    const bytes = readFileSync(join(REPO_ROOT, 'electron', 'coordination', 'tokens.ts'));
    expect(bytes.includes(0)).toBe(false);
  });

  it('dos pares distintos nunca colisionan aunque una herramienta limpie caracteres de control', () => {
    const registry = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
    const a = registry.mint('work_ab', 'mem_c');
    const b = registry.mint('work_a', 'bmem_c');
    expect(registry.verify(a)).toMatchObject({ workId: 'work_ab', memberId: 'mem_c' });
    expect(registry.verify(b)).toMatchObject({ workId: 'work_a', memberId: 'bmem_c' });
    registry.revokeMember('work_ab', 'mem_c');
    expect(registry.verify(a)).toBeNull();
    expect(registry.verify(b)).not.toBeNull();
  });
});

describe('latte_check dice la verdad sobre lo que hace (juicio #6)', () => {
  const check = () => MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_check')!;

  it('no publica un parámetro `wait` que la implementación ignora', () => {
    const properties = (check().inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).not.toContain('wait');
  });

  // Ronda 4, juicio 13b: `/empty|vac/` también matchea "vacuum" y "vacation".
  // Una descripción que dijera cualquier otra cosa con esas letras pasaba el
  // guard sin decir NADA sobre el buzón. Se afirma la frase de verdad.
  it('la descripción dice que hoy no hay productor de mensajes, en vez de prometer un buzón', () => {
    expect(check().description).toContain('Latte has no producer of coordination messages yet');
    expect(check().description).toContain('always returns an empty list');
    expect(check().description).toContain('never blocks and never waits');
  });

  it('MAX_CHECK_WAIT_SECONDS ya no se importa en engine.ts: era un import muerto', () => {
    const source = readFileSync(join(REPO_ROOT, 'electron', 'coordination', 'engine.ts'), 'utf8');
    expect(source).not.toContain('MAX_CHECK_WAIT_SECONDS');
  });
});

describe('el interruptor de coordinación falla cerrado en el cableado real (juicio #4)', () => {
  // `isCoordinationEnabled` es opcional y por default ENCIENDE, para no romper
  // las ~150 pruebas pre-8.1 que construyen el motor y el planificador a mano.
  // Ese default es aceptable SÓLO mientras todo cableado de producción pase la
  // bandera real: este guard lo sostiene, archivo por archivo.
  //
  // Ronda 4, juicio 13a: el guard era `let from = source.indexOf(ctor); while
  // (from !== -1) {...}`. Si el literal FALTABA — un rename, una factory, un
  // salto de línea después del identificador — el cuerpo no corría nunca:
  // CERO aserciones y el test verde. `latteService.ts` no construye ningún
  // planificador, así que esa mitad ya pasaba al vacío. Ahora se declara
  // cuántas construcciones tiene que haber en cada archivo, se cuentan las que
  // hay de verdad, y una cuenta que no da tira.
  const CTORS = ['CoordinationEngine', 'CoordinationInjectionPlanner'] as const;
  const productionWiring: Array<{ file: string; expected: Record<(typeof CTORS)[number], number> }> = [
    { file: 'electron/bootstrap.ts', expected: { CoordinationEngine: 1, CoordinationInjectionPlanner: 1 } },
    { file: 'electron/services/latteService.ts', expected: { CoordinationEngine: 1, CoordinationInjectionPlanner: 0 } },
  ];

  /** `new  Ctor\n(` incluido: el guard no puede depender de cómo esté formateada la línea. */
  const constructionsOf = (source: string, ctor: string): string[] => {
    const blocks: string[] = [];
    const re = new RegExp(`new\\s+${ctor}\\s*\\(`, 'g');
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const end = source.indexOf(');', m.index);
      blocks.push(source.slice(m.index, end === -1 ? source.length : end));
    }
    return blocks;
  };

  for (const { file, expected } of productionWiring) {
    it(`${file} pasa la bandera real en cada construcción de coordinación`, () => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const ctor of CTORS) {
        const blocks = constructionsOf(source, ctor);
        // La cuenta PRIMERO: sin esto, un literal que desaparece deja el test
        // verde sin haber afirmado nada.
        expect({ ctor, count: blocks.length }).toEqual({ ctor, count: expected[ctor] });
        for (const block of blocks) expect(block).toContain('isCoordinationEnabled');
      }
    });
  }

  it('la lista de archivos de cableado no quedó vieja: nadie más construye coordinación en electron/', () => {
    const listed = new Set(productionWiring.map((w) => w.file.replace(/\//g, sep)));
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        if (CTORS.some((ctor) => constructionsOf(source, ctor).length > 0)) {
          found.add(full.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(join(REPO_ROOT, 'electron'));
    expect([...found].sort()).toEqual([...listed].sort());
  });
});

describe('el planificador de inyección: los topes de Codex cuentan procesos de Codex (juicio #3)', () => {
  const makePlanner = (opts: { hasRun?: boolean } = {}) => new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: () => (opts.hasRun ? ({} as unknown) : null) },
    tokens: new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z'),
    server: { ensureStarted: async () => undefined, stopIfIdle: () => undefined, boundPort: 7777 },
    resolveClaudeVersion: async () => '2.1.300',
    resolveEngramBinary: async () => '/usr/bin/engram',
  });

  it('tres miembros Claude coordinados NO consumen el cupo de procesos codex del Trabajo', async () => {
    const planner = makePlanner({ hasRun: true });
    for (const id of ['mem_c1', 'mem_c2', 'mem_c3']) {
      const { status } = await planner.assign({ memberId: id, workId: 'work_1', brandId: 'brd_1', runtime: 'claude', accountId: null });
      expect(status.coordinationInjected).toBe(true);
    }
    const codex = await planner.assign({ memberId: 'mem_x1', workId: 'work_1', brandId: 'brd_1', runtime: 'codex', accountId: null });
    expect(codex.status.reason).toBeNull();
    expect(codex.status.coordinationInjected).toBe(true);
  });

  it('seis miembros Claude app-wide no dejan a Codex sin engram', async () => {
    const planner = makePlanner({ hasRun: true });
    for (let i = 0; i < 6; i += 1) {
      await planner.assign({ memberId: `mem_c${i}`, workId: `work_${i}`, brandId: 'brd_1', runtime: 'claude', accountId: null });
    }
    const codex = await planner.assign({ memberId: 'mem_x1', workId: 'work_9', brandId: 'brd_1', runtime: 'codex', accountId: null });
    expect(codex.status.memoryInjected).toBe(true);
  });

  it('el adaptador que rechaza la inyección corrige el reclamo del planificador (juicio #5)', async () => {
    const planner = makePlanner({ hasRun: true });
    const { status } = await planner.assign({ memberId: 'mem_c1', workId: 'work_1', brandId: 'brd_1', runtime: 'claude', accountId: null });
    expect(status.coordinationInjected).toBe(true);
    // El adaptador arrancó SIN ningún servidor (promptDir ausente, por ejemplo).
    planner.confirmInjection('mem_c1', []);
    const after = await planner.preview({ memberId: 'mem_c1', workId: 'work_1', brandId: 'brd_1', runtime: 'claude', accountId: null });
    expect(after.coordinationInjected).toBe(false);
    expect(after.canPropose).toBe(false);
    expect(after.memoryInjected).toBe(false);
    expect(after.reason).toBe('runtime_refused_injection');
  });

  it('el reclamo confirmado parcialmente reporta memoria sí, coordinación no', async () => {
    const planner = makePlanner({ hasRun: true });
    await planner.assign({ memberId: 'mem_c2', workId: 'work_1', brandId: 'brd_1', runtime: 'codex', accountId: null });
    planner.confirmInjection('mem_c2', ['latte_memory']);
    const after = await planner.preview({ memberId: 'mem_c2', workId: 'work_1', brandId: 'brd_1', runtime: 'codex', accountId: null });
    expect(after.memoryInjected).toBe(true);
    expect(after.coordinationInjected).toBe(false);
    expect(after.reason).toBe('runtime_refused_injection');
  });

  it('memoryToolsInjectedForWork refleja lo que los miembros vivos llevan de verdad (juicio #1)', async () => {
    const planner = makePlanner();
    expect(planner.memoryToolsInjectedForWork('work_1')).toBe(false);
    await planner.assign({ memberId: 'mem_c1', workId: 'work_1', brandId: 'brd_1', runtime: 'claude', accountId: null });
    expect(planner.memoryToolsInjectedForWork('work_1')).toBe(true);
    planner.confirmInjection('mem_c1', []);
    expect(planner.memoryToolsInjectedForWork('work_1')).toBe(false);
  });
});

describe('CoordinationEngine — capacidades que decía tener', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;
  let enabled = true;

  function coordinator(): CoordinationGrant {
    return { workId, runId, memberId: 'mem_coordinator', role: 'coordinator' };
  }
  function worker(memberId: string): CoordinationGrant {
    return { workId, runId, memberId, role: 'worker' };
  }

  beforeEach(async () => {
    enabled = true;
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 10 });
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
      isCoordinationEnabled: () => enabled,
    });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    // Ronda 4, juicio #3: el alta automatica quedo acotada a lo que la
    // persona aprobo. Este run nace de `startRun`, sin propuesta, asi que
    // declara aca los roles que su persona hubiera aprobado -- lo que se
    // esta probando es otra cosa.
    approveCoordinationRoles(b, runId, 'role_a', 'role_b');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- #4: el interruptor apaga de verdad -----------------------------------

  it('apagar la bandera a mitad de run frena el próximo despacho (juicio #4)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const task = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    enabled = false;
    await expect(engine.startDispatch({ grant: coordinator(), taskId: task.id })).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  // --- #8: una dependencia bloqueada no deja huérfanos ----------------------

  it('una tarea cuya dependencia fracasa definitivamente pasa a blocked, no se queda pending para siempre (juicio #8)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const first = engine.taskCreate(runId, { roleId: 'role_a', spec: 'a' });
    const second = engine.taskCreate(runId, { roleId: 'role_b', spec: 'b', dependsOn: [first.id] });
    // Tres fracasos: la primera tarea llega al tope de intentos y queda
    // `failed` (terminal, definitivo); la que dependía de ella queda `blocked`.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await engine.startDispatch({ grant: coordinator(), taskId: first.id });
      const dispatch = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === first.id && d.status === 'dispatched')!;
      await engine.report(worker(dispatch.memberId), first.id, 'failed', 'no salió');
    }
    expect(b.repo.getCoordinationTask(first.id).status).toBe('failed');
    expect(b.repo.getCoordinationTask(second.id).status).toBe('blocked');
  });

  it('una dependencia de OTRO run se rechaza al crear la tarea (juicio #8)', async () => {
    const otherWork = await b.service.createWork(brandId, 'Otro trabajo');
    await b.service.setCoordinationBudget(otherWork.id, { maxDispatches: 3 });
    const otherRun = await engine.startRun(otherWork.id, null);
    const foreign = engine.taskCreate(otherRun.id, { roleId: 'role_z', spec: 'z' });
    expect(() => engine.taskCreate(runId, { roleId: 'role_a', spec: 'a', dependsOn: [foreign.id] })).toThrow(/depend/i);
  });

  it('listOpenAsks expone las preguntas abiertas para que la persona pueda desbloquear (juicio #7)', () => {
    const ask = engine.ask(worker('mem_w1'), '¿Seguimos con el naming largo?');
    const open = engine.listOpenAsks(runId);
    expect(open.map((a) => a.id)).toContain(ask.id);
    engine.answerAsk(ask.id, 'Sí');
    expect(engine.listOpenAsks(runId).map((a) => a.id)).not.toContain(ask.id);
  });
});

describe('CoordinationEngine — la propuesta aprobada es el equipo que se contrata', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;

  const proposal = (patch: Partial<CoordinationProposal> = {}): CoordinationProposal => ({
    plan: [{ roleId: 'strategist', spec: 'Definir el foco' }],
    membersToHire: [{ roleId: 'strategist', why: 'nadie define el foco' }],
    estimatedDispatches: 5,
    rationale: 'Un equipo chico alcanza',
    ...patch,
  });

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    engine = new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => ({ workId: id, brandId, directory: b.dir, title: 'x', extraEnv: {} }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  async function approvedRun(patch: Partial<CoordinationProposal> = {}) {
    const run = await engine.requestCoordination({ workId, runId: null, memberId: 'mem_proposer', role: 'worker' }, proposal(patch));
    await engine.resolveGate(`proposal:${run.id}`, 'approve');
    return b.repo.findActiveCoordinationRun(workId)!;
  }

  // --- #10: el agente no puede firmarse un presupuesto ilimitado ------------

  it('un `unlimitedConfirmedAt` escrito por el agente se ignora al guardar la propuesta (juicio #10)', async () => {
    const run = await engine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proposer', role: 'worker' },
      proposal({ estimatedDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const stored = JSON.parse(run.budgetJson) as { unlimitedConfirmedAt: string | null };
    expect(stored.unlimitedConfirmedAt).toBeNull();
    const storedProposal = JSON.parse(run.planJson!) as CoordinationProposal;
    expect(storedProposal.unlimitedConfirmedAt ?? null).toBeNull();
  });

  it('aprobar tal cual una propuesta ilimitada sin confirmación humana no concede nada (juicio #10)', async () => {
    const run = await engine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proposer', role: 'worker' },
      proposal({ estimatedDispatches: null, unlimitedConfirmedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await expect(engine.resolveGate(`proposal:${run.id}`, 'approve')).rejects.toThrow();
    expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
  });

  it('la confirmación explícita de la persona, en el payload editado, sí concede ilimitado (juicio #10)', async () => {
    const run = await engine.requestCoordination(
      { workId, runId: null, memberId: 'mem_proposer', role: 'worker' },
      proposal({ estimatedDispatches: null }),
    );
    const human = JSON.stringify({ ...proposal({ estimatedDispatches: null }), unlimitedConfirmedAt: '2026-09-18T12:00:00.000Z' });
    await engine.resolveGate(`proposal:${run.id}`, 'approve', human);
    const approved = b.repo.getCoordinationRun(run.id);
    expect(JSON.parse(approved.budgetJson).unlimitedConfirmedAt).toBe('2026-09-18T12:00:00.000Z');
  });

  // --- #11: aprobar no afloja lo que la persona ya había elegido ------------

  it('aprobar NO baja una autoridad `manual` elegida a propósito (juicio #11)', async () => {
    await b.service.setCoordinationAuthority(workId, 'manual');
    await b.service.setCoordinationBudget(workId, { maxDispatches: 4, maxConcurrent: 1 });
    await approvedRun();
    expect(await b.service.getCoordinationAuthority(workId)).toBe('manual');
  });

  it('aprobar sube `auto` a `plan`: más estricto sí, más flojo no (juicio #11)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    await approvedRun();
    expect(await b.service.getCoordinationAuthority(workId)).toBe('plan');
  });

  it('aprobar conserva `maxConcurrent`, el único limitador en vuelo (juicio #11)', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 4, maxConcurrent: 1 });
    await approvedRun();
    const budget = await b.service.getCoordinationBudget(workId);
    expect(budget?.maxConcurrent).toBe(1);
    expect(budget?.maxDispatches).toBe(5);
  });

  // --- #9: sólo se contrata lo aprobado ------------------------------------

  it('despachar un rol que nunca estuvo en la propuesta aprobada no contrata a nadie (juicio #9)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await approvedRun(); // aprobar sube la autoridad a `plan`
    const task = engine.taskCreate(run.id, { roleId: 'copywriter', spec: 'Escribir el copy' });
    const before = members.length;

    // Una tarea fuera del plan aprobado gatea PRIMERO: desde que el gate se
    // evalua antes de resolver el miembro, el rechazo por rol no aprobado
    // llega recien al aprobar. Lo que la propiedad protege — que nadie se
    // contrate sin aprobacion — se cumple en los dos momentos.
    const gate = await engine.startDispatch({
      grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' },
      taskId: task.id,
    });
    expect(gate.status).toBe('pending_approval');
    expect(members.length).toBe(before);

    await expect(engine.resolveGate(gate.dispatchId, 'approve')).rejects.toMatchObject({ code: 'ROLE_NOT_APPROVED' });
    expect(members.length).toBe(before);
  });

  it('un rol que SÍ estaba en la propuesta se contrata sin fricción (juicio #9)', async () => {
    await b.service.setCoordinationAuthority(workId, 'auto');
    const run = await approvedRun();
    const task = engine.taskCreate(run.id, { roleId: 'strategist', spec: 'Otro foco' });
    // Reusa al `strategist` que la aprobación ya contrató: ni rechazo ni alta nueva.
    const before = members.length;
    await expect(engine.startDispatch({
      grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' },
      taskId: task.id,
    })).resolves.toBeTruthy();
    expect(members.length).toBe(before);
  });
});
