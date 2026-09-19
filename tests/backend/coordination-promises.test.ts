import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinationEngine } from '../../electron/coordination/engine';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { LIMITS } from '../../electron/services/validation';
import { fakeCoordinationHub, makeBackend, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * Crítico 12 (backend): cosas que se prometían y no existían.
 *
 *  1. `touch()` hacía I/O de disco —podía REESCRIBIR el CLAUDE.md/AGENTS.md
 *     del Trabajo— en cada cambio de estado, sólo para leer un `brandId`.
 *  2. `latte_dispatch` publicaba un `approvedGateId` que su handler descarta.
 *  3. `editedPrompt` llegaba sin validar hasta un agente levantado.
 */
describe('lo que se publica existe y lo que entra se valida (crítico 12)', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let brandId: string;
  let workId: string;
  let workDir: string;

  const proposal = () => ({
    plan: [{ roleId: 'copywriter', spec: 'Escribir los posteos del mes' }],
    membersToHire: [{ roleId: 'copywriter', why: 'nadie escribe copy todavía' }],
    estimatedDispatches: 4,
    rationale: 'El pedido fue coordinar al equipo.',
  });

  function engineForTests(): CoordinationEngine {
    return new CoordinationEngine({
      repo: b.repo,
      hub: b.hub,
      clock: () => new Date().toISOString(),
      memberContext: (id) => b.service.memberContext(id),
    });
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    workDir = b.files.workDir(brandId, workId);
    members = [];
    fakeCoordinationHub(b, members);
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  // --- 1: un cambio de estado no toca el disco -------------------------------

  describe('un cambio de estado de coordinación no reescribe los archivos de instrucciones', () => {
    function instructionFiles(): Array<{ file: string; content: string; mtimeMs: number }> {
      return ['CLAUDE.md', 'AGENTS.md']
        .map((name) => path.join(workDir, name))
        .filter((file) => fs.existsSync(file))
        .map((file) => ({ file, content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs }));
    }

    it('ni el contenido ni el mtime del CLAUDE.md/AGENTS.md cambian, y el renderizador nunca se llama', async () => {
      await b.service.setCoordinationBudget(workId, { maxDispatches: 3 });
      const before = instructionFiles();
      // Si no hay archivo que mirar, este test no prueba nada: que falle.
      expect(before.length).toBeGreaterThan(0);

      const render = vi.spyOn(b.service as unknown as { renderAndWriteInstructions: (...args: never[]) => unknown }, 'renderAndWriteInstructions');
      const memberContext = vi.spyOn(b.service, 'memberContext');

      // Cuatro cambios de estado seguidos, cada uno disparando `touch()`.
      const run = await b.service.startCoordinationRun(workId);
      await b.service.pauseCoordinationRun(run.id);
      await b.service.resumeCoordinationRun(run.id);
      await b.service.cancelCoordinationRun(run.id);

      expect(render).not.toHaveBeenCalled();
      expect(memberContext).not.toHaveBeenCalled();
      const after = instructionFiles();
      expect(after.map((f) => f.file)).toEqual(before.map((f) => f.file));
      for (const [i, file] of after.entries()) {
        expect(file.content).toBe(before[i].content);
        expect(file.mtimeMs).toBe(before[i].mtimeMs);
      }
    });

    it('el evento de coordinación sigue llevando el brandId correcto, leído del repo en vez del disco', async () => {
      const seen: Array<{ brandId: string; workId: string; runId: string | null }> = [];
      const engine = new CoordinationEngine({
        repo: b.repo,
        hub: b.hub,
        clock: () => new Date().toISOString(),
        memberContext: () => { throw new Error('memberContext no debe tocarse para emitir un evento'); },
        emit: (event) => seen.push(event),
      });
      await b.service.setCoordinationBudget(workId, { maxDispatches: 3 });

      const run = await engine.startRun(workId, null);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ brandId, workId, runId: run.id });
    });
  });

  // --- 2: lo que se publica, existe ------------------------------------------

  describe('el esquema publicado no ofrece parámetros que el handler descarta', () => {
    it('latte_dispatch ya no publica `approvedGateId`', () => {
      const tool = MCP_TOOL_DEFINITIONS.find((d) => d.name === 'latte_dispatch');
      expect(tool).toBeDefined();
      const properties = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).toEqual(['taskId']);
      expect(properties.approvedGateId).toBeUndefined();
    });

    it('ningún esquema publicado menciona approvedGateId en ninguna parte', () => {
      expect(JSON.stringify(MCP_TOOL_DEFINITIONS)).not.toContain('approvedGateId');
    });
  });

  // --- 3: lo que entra, se valida --------------------------------------------

  describe('editedPrompt se valida en la frontera IPC', () => {
    async function pendingDispatch(): Promise<{ runId: string; dispatchId: string }> {
      await b.service.setCoordinationAuthority(workId, 'manual'); // cada despacho pasa por un gate
      const engine = engineForTests();
      const run = await engine.requestCoordination({ workId, runId: null, memberId: 'mem_proposer', role: 'worker' }, proposal());
      await b.service.resolveCoordinationGate(`proposal:${run.id}`, 'approve');
      const task = b.repo.listCoordinationTasks(run.id)[0];
      expect(task).toBeDefined();
      const outcome = await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_proposer', role: 'coordinator' }, taskId: task.id });
      expect(outcome.status).toBe('pending_approval');
      (b.hub.send as unknown as ReturnType<typeof vi.fn>).mockClear();
      return { runId: run.id, dispatchId: outcome.dispatchId };
    }

    it('un prompt de 1 MB se rechaza con un error de validación, sin llegar a ningún agente', async () => {
      const { dispatchId } = await pendingDispatch();
      const enorme = 'a'.repeat(1_000_000);

      await expect(b.service.resolveCoordinationGate(dispatchId, 'approve', enorme))
        .rejects.toMatchObject({ code: 'VALIDATION' });

      expect(b.hub.send).not.toHaveBeenCalled();
      expect(b.repo.getCoordinationDispatch(dispatchId).status).toBe('pending_approval');
    });

    it('justo por encima del tope se rechaza, y justo en el tope entra', async () => {
      const { dispatchId } = await pendingDispatch();
      await expect(b.service.resolveCoordinationGate(dispatchId, 'approve', 'a'.repeat(LIMITS.chatMessage + 1)))
        .rejects.toMatchObject({ code: 'VALIDATION' });

      const justo = 'a'.repeat(LIMITS.chatMessage);
      await b.service.resolveCoordinationGate(dispatchId, 'approve', justo);
      expect(b.hub.send).toHaveBeenCalledWith(expect.any(String), justo);
    });

    it('una cadena vacía (o sólo espacios) se rechaza: un prompt vacío no es una edición', async () => {
      const { dispatchId } = await pendingDispatch();
      await expect(b.service.resolveCoordinationGate(dispatchId, 'approve', '')).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(b.service.resolveCoordinationGate(dispatchId, 'approve', '   ')).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(b.hub.send).not.toHaveBeenCalled();
    });

    it('un prompt normal llega al agente EXACTAMENTE como lo editó la persona', async () => {
      const { dispatchId } = await pendingDispatch();
      const editado = 'Escribí los posteos, pero arrancá por el de LinkedIn.';

      await b.service.resolveCoordinationGate(dispatchId, 'approve', editado);

      expect(b.hub.send).toHaveBeenCalledTimes(1);
      expect(b.hub.send).toHaveBeenCalledWith(expect.any(String), editado);
      expect(b.repo.getCoordinationDispatch(dispatchId).prompt).toBe(editado);
    });

    it('el motor se defiende solo: `resolveGate` rechaza un prompt inválido aunque no venga por IPC', async () => {
      const { dispatchId } = await pendingDispatch();
      await expect(engineForTests().resolveGate(dispatchId, 'approve', 'a'.repeat(1_000_000)))
        .rejects.toMatchObject({ code: 'VALIDATION' });
      expect(b.hub.send).not.toHaveBeenCalled();
    });
  });

  // --- 4: el pack dice lo que el motor hace -----------------------------------

  describe('el prompt del strategist documenta el filo del cierre automático', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../packs/marketing-core/roles/strategist.md'), 'utf8');

    it('dice que todas las tareas del plan se crean antes del primer despacho', () => {
      expect(source).toMatch(/before dispatching the first/i);
    });

    it('dice que la coordinación se cierra sola cuando reporta la última tarea, y que para seguir hay que pedir coordinar de nuevo', () => {
      expect(source).toMatch(/closes itself|closes on its own/i);
      expect(source).toMatch(/latte_request_coordination/);
    });
  });
});
