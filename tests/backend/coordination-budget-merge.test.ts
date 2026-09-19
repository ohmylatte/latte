import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * F2: subir el tope de despachos no puede apagar los otros topes.
 *
 * `setCoordinationBudget` normalizaba a `null` todo campo AUSENTE
 * (`requireCoordinationBudget` lo hace por diseño) y escribía el JSON entero,
 * en el meta del Trabajo Y en el run en vuelo. El editor de la pantalla de
 * Decisiones manda sólo `{maxDispatches}`, así que cada vez que la persona
 * subía el tope apagaba `maxConcurrent` —el ÚNICO limitador en vuelo que
 * existe—, `maxTokens`, `maxCostMicros` y `maxWallMinutes` de un equipo que ya
 * estaba andando. Un campo ausente conserva lo que había; un `null` explícito
 * sí lo apaga.
 */
describe('F2: el presupuesto se funde, no se reemplaza', () => {
  let b: TestBackend;
  let engine: CoordinationEngine;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let runId: string;

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationAuthority(workId, 'auto');
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

  it('subir `maxDispatches` por IPC conserva el `maxConcurrent` del run en vuelo', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 2 });
    const run = await engine.startRun(workId, null);
    runId = run.id;
    approveCoordinationRoles(b, runId, 'role_a');

    // Exactamente lo que manda el editor de la pantalla: sólo el tope.
    await b.service.setCoordinationBudget(workId, { maxDispatches: 30 });

    const stored = await b.service.getCoordinationBudget(workId);
    expect(stored).toMatchObject({ state: 'set' });
    expect(stored.state === 'set' && stored.budget.maxConcurrent).toBe(2);
    expect(stored.state === 'set' && stored.budget.maxDispatches).toBe(30);
    // Y el run VIVO, que es contra lo que se decide cada despacho.
    expect(JSON.parse(b.repo.getCoordinationRun(runId).budgetJson)).toMatchObject({ maxDispatches: 30, maxConcurrent: 2 });
    // Y el sobre que ve el agente en cada llamada MCP.
    expect(engine.budgetBlockForEnvelope(runId)).toMatchObject({ maxDispatches: 30, maxConcurrent: 2 });
  });

  it('un `null` explícito sí apaga el tope que nombra', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 2, maxTokens: 1_000 });

    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: null });

    const stored = await b.service.getCoordinationBudget(workId);
    expect(stored.state === 'set' && stored.budget.maxConcurrent).toBeNull();
    // Y lo que no se nombró sigue donde estaba.
    expect(stored.state === 'set' && stored.budget.maxTokens).toBe(1_000);
  });
});
