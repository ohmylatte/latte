import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { assertCoordinationProposal } from '../../electron/services/validation';
import { approveCoordinationRoles, fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Los cuatro de la ronda 5 que no necesitan su propio archivo, cada uno por la
 * capa real:
 *
 *  - P9: compensar un despacho que no salió NO puede re-anotar como contratado
 *        a alguien que acaba de ser despedido de verdad.
 *  - P10: `dependsOn` apunta hacia atrás, o la propuesta no entra.
 *  - P11: con `feature:coordination` apagada, el tick cierra y vence, pero
 *         nunca pasa un run a `running`.
 *  - P12: `listGates` lee el run una sola vez.
 */
describe('Ronda 5: los cuatro chicos', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let workId: string;

  function rpc(name: string, args: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  }

  function envelope(result: { body: string }): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
    const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    return (parsed.result as { structuredContent: ReturnType<typeof envelope> }).structuredContent;
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20 });
    await b.service.setCoordinationAuthority(workId, 'auto');
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- P9 ---------------------------------------------------------------------

  describe('P9: compensar una contratación no la re-anota si el despido salió bien', () => {
    /**
     * `compensateHire` tenía el despido y el borrado del alta en el MISMO try.
     * Con `hub.removeMember` exitoso y `forgetHire` fallando, el `catch` llamaba
     * a `recordHire`: la bitácora decía que ese miembro seguía contratado
     * cuando el motor acababa de despedirlo de verdad.
     */
    async function runWithATask(): Promise<{ runId: string; taskId: string; token: string }> {
      b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
      members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
      await b.service.startCoordinationRun(workId);
      const runId = b.repo.findActiveCoordinationRun(workId)!.id;
      approveCoordinationRoles(b, runId, 'role_a');
      const token = b.coordinationTokens.mint(workId, 'mem_coordinator');
      const created = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_task_create', { roleId: 'role_a', spec: 'escribir' }), `Bearer ${token}`, '127.0.0.1',
      ));
      return { runId, taskId: (created.data as { taskId: string }).taskId, token };
    }

    /**
     * NOTA HONESTA sobre este ítem. El defecto señalado es real como forma —el
     * despido y el borrado del alta compartían un `try`, y un fallo del segundo
     * caía en el `catch` del primero y llamaba a `recordHire`— pero su efecto
     * NO es alcanzable por la superficie pública: `forgetHire` sólo escribe
     * cuando el alta ESTÁ en la lista, y `recordHire` es idempotente, así que
     * en todos los caminos donde `forgetHire` puede tirar el alta ya figura y
     * el `recordHire` del `catch` se iba por su early-return sin escribir nada.
     * Los dos comportamientos son indistinguibles desde afuera.
     *
     * El arreglo se aplicó igual —un `catch` que anota altas no puede colgar de
     * un `try` que borra altas, aunque hoy no se note— y lo que estos dos tests
     * fijan es el INVARIANTE que sí se puede observar y que el arreglo protege:
     * compensar nunca deja anotado como contratado a alguien que el motor
     * despidió, y siempre lo deja anotado si no lo pudo despedir.
     */
    it('el despido sale bien: el miembro se va y el alta se va con él', async () => {
      const { runId, taskId, token } = await runWithATask();
      // El envío falla: es la salida que compensa con la transacción ya commiteada.
      vi.spyOn(b.hub, 'send').mockRejectedValue(new Error('el proceso se murió'));
      // El fake del hub no implementa `removeMember`, y el real no conoce a un
      // miembro que sólo existe en la lista del fake: acá se despide de verdad.
      const removed = vi.spyOn(b.hub, 'removeMember').mockImplementation((memberId: string) => {
        const member = members.find((m) => m.id === memberId);
        if (member) member.status = 'ended';
      });

      const result = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_dispatch', { taskId }), `Bearer ${token}`, '127.0.0.1',
      ));

      expect(result.ok).toBe(false);
      // El contratado para ESTE despacho fue despedido de verdad...
      expect(removed).toHaveBeenCalledTimes(1);
      // ...y la bitácora no lo sigue nombrando como alta.
      expect(b.service.coordinationEngine.listHires(runId)).toHaveLength(0);
    });

    it('si el despido FALLA, el alta sí se anota: el miembro sigue vivo y la bitácora lo dice', async () => {
      const { runId, taskId, token } = await runWithATask();
      vi.spyOn(b.hub, 'send').mockRejectedValue(new Error('el proceso se murió'));
      vi.spyOn(b.hub, 'removeMember').mockImplementation(() => { throw new Error('no se pudo despedir'); });

      const result = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_dispatch', { taskId }), `Bearer ${token}`, '127.0.0.1',
      ));

      expect(result.ok).toBe(false);
      // El miembro que se contrató para este despacho sigue vivo, y está anotado.
      expect(b.service.coordinationEngine.listHires(runId).length).toBeGreaterThan(0);
    });
  });

  // --- P10 --------------------------------------------------------------------

  describe('P10: `dependsOn` apunta hacia atrás', () => {
    function proposal(dependsOn: number[]) {
      return {
        plan: [
          { roleId: 'role_a', spec: 'la primera', dependsOn },
          { roleId: 'role_a', spec: 'la segunda' },
        ],
        membersToHire: [{ roleId: 'role_a', why: 'no hay nadie' }],
        estimatedDispatches: 4,
        rationale: 'porque sí',
      };
    }

    it('JSON-RPC: una dependencia hacia adelante se rechaza, y no queda ningún run', async () => {
      const at = '2026-01-01T00:00:00.000Z';
      b.repo.insertMember({
        id: 'mem_p', workId, roleId: 'role_a', roleName: 'Rol A', initial: 'A',
        runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
      });
      members.push({ id: 'mem_p', workId, roleId: 'role_a', status: 'idle' });
      const token = b.coordinationTokens.mint(workId, 'mem_p');

      const result = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_request_coordination', proposal([1])), `Bearer ${token}`, '127.0.0.1',
      ));

      expect(result.ok).toBe(false);
      expect(result.error!.message).toMatch(/dependsOn/);
      expect(b.repo.findActiveCoordinationRun(workId)).toBeNull();
      // Y cero contrataciones: el rechazo es antes de levantar nada.
      expect(members.filter((m) => m.id !== 'mem_p')).toHaveLength(0);
    });

    it('IPC: una dependencia a sí misma no pasa al aprobar una propuesta editada', async () => {
      // Una propuesta sana guardada, y la EDICIÓN que la persona aprueba con la
      // dependencia inválida: entra por `resolveCoordinationGate`, que es el
      // método que el botón "Editar y aprobar" llama por IPC.
      const run = await b.service.coordinationEngine.requestCoordination(
        { workId, runId: null, memberId: 'mem_p', role: 'worker' },
        {
          plan: [{ roleId: 'role_a', spec: 'la primera' }, { roleId: 'role_a', spec: 'la segunda' }],
          membersToHire: [{ roleId: 'role_a', why: 'no hay nadie' }],
          estimatedDispatches: 4,
          rationale: 'porque sí',
        },
      );

      await expect(b.service.resolveCoordinationGate('proposal:' + run.id, 'approve', JSON.stringify(proposal([0]))))
        .rejects.toThrow(/dependsOn/);

      // Cero efectos: ni tareas, ni contrataciones, y el run sigue esperando.
      expect(b.repo.listCoordinationTasks(run.id)).toHaveLength(0);
      expect(members).toHaveLength(0);
      expect(b.repo.getCoordinationRun(run.id).status).toBe('planning');
    });

    it('y hacia atrás sigue entrando como siempre', () => {
      expect(() => assertCoordinationProposal({
        plan: [
          { roleId: 'role_a', spec: 'la primera' },
          { roleId: 'role_a', spec: 'la segunda', dependsOn: [0] },
        ],
        membersToHire: [{ roleId: 'role_a', why: 'no hay nadie' }],
        estimatedDispatches: 4,
        rationale: 'porque sí',
      })).not.toThrow();
    });
  });

  // --- P11 --------------------------------------------------------------------

  describe('P11: con la bandera baja, el tick no enciende nada', () => {
    /** Un run suspendido por una pregunta que ya venció: el tick lo reactivaba. */
    async function suspendedRunWithAnExpiredAsk(): Promise<string> {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
      b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
      members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
      await b.service.startCoordinationRun(workId);
      const runId = b.repo.findActiveCoordinationRun(workId)!.id;
      approveCoordinationRoles(b, runId, 'role_a');
      const token = b.coordinationTokens.mint(workId, 'mem_coordinator');
      const created = envelope(await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_task_create', { roleId: 'role_a', spec: 'escribir' }), `Bearer ${token}`, '127.0.0.1',
      ));
      const taskId = (created.data as { taskId: string }).taskId;
      await b.coordinationMcpServer.handleMcpRequest(
        rpc('latte_ask', { question: '¿tono?', taskId, ttlMinutes: 30 }), `Bearer ${token}`, '127.0.0.1',
      );
      expect(b.repo.getCoordinationRun(runId).status).toBe('suspended');
      vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z')); // la pregunta venció
      return runId;
    }

    afterEach(() => vi.useRealTimers());

    it('la bandera baja: la pregunta se vence pero el run NO vuelve a `running`', async () => {
      const runId = await suspendedRunWithAnExpiredAsk();
      b.repo.setMeta(FEATURE_KEYS.coordination, 'off');

      b.service.sweepCoordination();

      // Venció (el tick cierra), pero no encendió.
      expect(b.repo.listOpenCoordinationAsks(runId)).toHaveLength(0);
      // O11: `not.toBe('running')` pasaba igual con el run `done` o
      // `cancelled` — dos finales que NO son lo que este test dice proteger.
      // Se nombra el estado exacto, y su motivo: el run sigue exactamente
      // donde estaba, suspendido por la pregunta que acaba de vencer.
      const run = b.repo.getCoordinationRun(runId);
      expect(run.status).toBe('suspended');
      expect(run.suspendReason).toBe('all_blocked_on_ask');
    });

    it('con la bandera arriba, el mismo tick sí lo reactiva', async () => {
      const runId = await suspendedRunWithAnExpiredAsk();

      b.service.sweepCoordination();

      expect(b.repo.listOpenCoordinationAsks(runId)).toHaveLength(0);
      expect(b.repo.getCoordinationRun(runId).status).toBe('running');
    });
  });

  // --- P12 --------------------------------------------------------------------

  describe('P12: `listGates` lee el run una sola vez', () => {
    it('una llamada, una lectura de la fila del run', async () => {
      b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
      members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
      const run = await b.service.startCoordinationRun(workId);
      const spy = vi.spyOn(b.repo, 'getCoordinationRun');

      await b.service.listCoordinationGates(run.id);

      const forThisRun = spy.mock.calls.filter(([id]) => id === run.id);
      expect(forThisRun).toHaveLength(1);
    });

    it('y un run terminado sigue sin ofrecer ninguna decisión', async () => {
      b.repo.setMeta('coordination_coordinator:' + workId, 'mem_coordinator');
      members.push({ id: 'mem_coordinator', workId, roleId: 'strategist', status: 'idle' });
      const run = await b.service.startCoordinationRun(workId);
      await b.service.cancelCoordinationRun(run.id);

      expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
    });
  });
});
