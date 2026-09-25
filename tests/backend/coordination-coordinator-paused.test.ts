import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * O2: UN COORDINADOR EN PAUSA CON EL RUN ACTIVO NO ES SILENCIO.
 *
 * Lo que vio el dueño (2026-09-24): Paid Media reportó y le escribió al
 * Asistente con `latte_message`; el Asistente estaba en pausa. El aviso se
 * encolaba en memoria, la cola sólo se vacía en un fin de turno que un
 * proceso apagado no tiene, y el run se quedó `running` sin que pasara nada ni
 * nadie lo dijera.
 *
 * La decisión (UNA): NO se lo despierta solo. Pausar es algo que hizo la
 * persona, y despertar al coordinador por detrás le quitaría el sentido. Lo que
 * cambia es que la pausa ahora SE VE: el run pasa a `suspended` con motivo
 * `coordinator_paused`, y reanudar al coordinador le entrega la cola y
 * devuelve el run a `running`.
 *
 * Por la capa real: el `latte_message` entra por el servidor MCP, y reanudar
 * es `service.openTeamMember`, el mismo camino de la tarjeta de pausa.
 */

const COORDINATOR = 'mem_coordinator';

function rpc(name: string, args: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('O2: el coordinador en pausa suspende el run en vez de callar', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;
  let workerId: string;

  const call = (name: string, args: unknown, token: string) =>
    b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');

  const sentTo = (memberId: string) => send.mock.calls.filter((c) => c[0] === memberId).map((c) => c[1] as string);

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 3 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    const coordinatorToken = b.coordinationTokens.mint(workId, COORDINATOR);
    await call('latte_request_coordination', {
      plan: [{ roleId: 'paid-media', spec: 'Auditar las cuentas' }],
      estimatedDispatches: 3,
      membersToHire: [{ roleId: 'paid-media', why: 'Nadie audita' }],
      rationale: 'Plan de medios.',
    }, coordinatorToken);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    workerId = members.find((m) => m.roleId === 'paid-media')!.id;
    // El reanudar real empieza por `hub.getMember`, que lee la fila; los
    // miembros de estos tests no tienen fila propia.
    vi.spyOn(b.hub, 'getMember').mockImplementation((id: string) => {
      const m = members.find((x) => x.id === id);
      if (!m) throw new Error('unknown ' + id);
      return b.hub.listTeam(m.workId).find((x) => x.id === id)!;
    });
    send.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('coordinador pausado + `latte_message` del worker ⇒ run `suspended:coordinator_paused`, sin entregar', async () => {
    await b.service.pauseTeamMember(COORDINATOR);
    expect(members.find((m) => m.id === COORDINATOR)!.status).toBe('paused');

    await call('latte_message', { to: 'coordinator', text: '¿Conector de Meta o exports?' }, b.coordinationTokens.mint(workId, workerId));
    await settle();

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('suspended');
    expect(run.suspendReason).toBe('coordinator_paused');
    // No se le mandó nada a un proceso que no existe: quedó en la cola.
    expect(sentTo(COORDINATOR)).toEqual([]);
    // Y la pausa del coordinador NO es una decisión de presupuesto.
    expect((await b.service.listCoordinationGates(runId)).map((g) => g.kind)).not.toContain('budget');
  });

  it('reanudar al coordinador le entrega la cola y devuelve el run a `running`', async () => {
    await b.service.pauseTeamMember(COORDINATOR);
    await call('latte_message', { to: 'coordinator', text: '¿Conector de Meta o exports?' }, b.coordinationTokens.mint(workId, workerId));
    await settle();

    await b.service.openTeamMember(COORDINATOR);
    await settle();

    const run = b.repo.getCoordinationRun(runId);
    expect(run.status).toBe('running');
    expect(run.suspendReason).toBeNull();
    expect(sentTo(COORDINATOR).join('\n')).toContain('¿Conector de Meta o exports?');
  });

  it('con el coordinador vivo nada cambia: se entrega y el run sigue `running`', async () => {
    await call('latte_message', { to: 'coordinator', text: 'Listo el reporte' }, b.coordinationTokens.mint(workId, workerId));
    await settle();
    expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    expect(sentTo(COORDINATOR).join('\n')).toContain('Listo el reporte');
  });

  it('una pausa del EQUIPO hecha por la persona no se pisa con el motivo del coordinador', async () => {
    await b.service.pauseCoordinationRun(runId);
    await b.service.pauseTeamMember(COORDINATOR);
    await call('latte_message', { to: 'coordinator', text: 'Hola' }, b.coordinationTokens.mint(workId, workerId));
    await settle();
    expect(b.repo.getCoordinationRun(runId).suspendReason).toBe('paused_by_human');
  });
});
