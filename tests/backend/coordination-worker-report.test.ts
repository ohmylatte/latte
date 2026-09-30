import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { fakeCoordinationHub, makeBackend, makeTempDir, removeDir, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * E6: EL WORKER CIERRA SU TAREA SIN TENER QUE ADIVINAR EL ID.
 *
 * La prueba local del dueño: el revisor despachado por "Extraer identidad con
 * el equipo" escribió `IDENTIDAD.md` y no pudo reportar. `latte_report` pedía
 * un `taskId` que nadie le había dado; probó con uno inventado y con uno vacío
 * (`CoordinationTask not found`) y `latte_task_list` le devolvió FORBIDDEN.
 * Latte nunca se enteró de que el archivo estaba listo.
 *
 * Ahora: el prompt de TODO despacho lleva el id y cómo cerrar; `taskId` es
 * opcional (el bearer dice quién llama, y un miembro tiene su despacho); y
 * `latte_task_list` le muestra a un worker sus propias tareas en vez de negarle
 * la lista. Todo por el servidor MCP real.
 */

const COORDINATOR = 'mem_coordinator';
const WRITER = 'mem_writer';
interface Envelope { ok: boolean; data: unknown; error?: { code: string; message: string } }

describe('E6: reportar sin taskId, por MCP', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;

  const call = async (name: string, args: unknown, memberId = COORDINATOR): Promise<Envelope> => {
    const token = b.coordinationTokens.mint(workId, memberId);
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };
  const lastPromptTo = (memberId: string) => String(send.mock.calls.filter((c) => c[0] === memberId).at(-1)?.[1] ?? '');
  const createAndDispatch = async (spec: string, extra: Record<string, unknown> = {}) => {
    const created = await call('latte_task_create', { roleId: 'writer', spec, ...extra });
    const taskId = (created.data as { taskId: string }).taskId;
    expect((await call('latte_dispatch', { taskId })).ok).toBe(true);
    return taskId;
  };

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    const work = await b.service.createWork(brand.id, 'Propuesta');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 30, maxConcurrent: 3 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    b.repo.setMeta('coordination_coordinator:' + workId, COORDINATOR);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    members.push({ id: WRITER, workId, roleId: 'writer', status: 'idle' });
    await b.service.startCoordinationRun(workId);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    b.repo.setMeta('coordination_approved_roles:' + runId, JSON.stringify(['writer']));
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('el esquema publica taskId como opcional', () => {
    const report = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_report')!;
    expect((report.inputSchema as { required: string[] }).required).not.toContain('taskId');
  });

  it('el prompt del despacho dice el id y cómo cerrar', async () => {
    const taskId = await createAndDispatch('Escribí la propuesta.');
    const prompt = lastPromptTo(WRITER);
    expect(prompt).toContain(`Task \`${taskId}\``);
    expect(prompt).toContain('latte_report');
    expect(prompt).toMatch(/omit it: Latte knows your task/);
  });

  it('con un solo despacho en vuelo, reporta sin taskId y la tarea cierra', async () => {
    const taskId = await createAndDispatch('Escribí la propuesta.');
    const reported = await call('latte_report', { outcome: 'succeeded', summary: 'Lista.' }, WRITER);
    expect(reported.ok).toBe(true);
    expect(b.repo.getCoordinationTask(taskId).status).toBe('done');
  });

  it('con dos despachos en vuelo, el error lista los dos con id y título', async () => {
    const first = await createAndDispatch('Uno.', { title: 'Propuesta mayorista' });
    // Un segundo despacho del mismo miembro: el estado de la base, sin pasar por la reserva.
    const second = await call('latte_task_create', { roleId: 'writer', title: 'Calendario', spec: 'Dos.' });
    const secondId = (second.data as { taskId: string }).taskId;
    const dispatch = b.repo.listCoordinationDispatches(runId).find((d) => d.taskId === first)!;
    b.repo.insertCoordinationDispatch({ ...dispatch, id: 'cdp_second', taskId: secondId, reservationId: null });
    b.repo.updateCoordinationTask(secondId, { status: 'dispatched', assignedMemberId: WRITER }, new Date().toISOString());
    const reported = await call('latte_report', { outcome: 'succeeded', summary: 'Lista.' }, WRITER);
    expect(reported.ok).toBe(false);
    expect(reported.error?.message).toContain(first);
    expect(reported.error?.message).toContain(secondId);
    expect(reported.error?.message).toContain('Propuesta mayorista');
    expect(reported.error?.message).toContain('Calendario');
  });

  it('sin despacho en vuelo, el error de siempre', async () => {
    const reported = await call('latte_report', { outcome: 'succeeded', summary: 'Lista.' }, WRITER);
    expect(reported.ok).toBe(false);
    expect(reported.error?.code).toBe('FORBIDDEN');
  });

  it('latte_task_list de un worker devuelve sólo sus tareas, sin FORBIDDEN', async () => {
    const mine = await createAndDispatch('Escribí la propuesta.', { title: 'Propuesta' });
    await call('latte_task_create', { roleId: 'writer', title: 'Otra, sin despachar', spec: 'Otra.' });
    const listed = await call('latte_task_list', {}, WRITER);
    expect(listed.ok).toBe(true);
    const rows = listed.data as Array<{ id: string; title: string; status: string; spec: string }>;
    expect(rows.map((r) => r.id)).toEqual([mine]);
    expect(rows[0]!.title).toBe('Propuesta');
    // El coordinador sigue viendo todo.
    expect(((await call('latte_task_list', {})).data as unknown[]).length).toBe(2);
  });

  it('el prompt de la revisión (E2) también lleva su id y cómo cerrar', async () => {
    const dir = b.files.workDir(b.repo.getWork(workId).brandId, workId);
    fs.mkdirSync(path.join(dir, 'borradores'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'borradores', 'p.pdf'), '%PDF');
    await createAndDispatch('La propuesta.', { audience: 'client' });
    expect((await call('latte_report', { outcome: 'succeeded', summary: 'Lista.', files: ['borradores/p.pdf'] }, WRITER)).ok).toBe(true);
    await settle();
    const review = b.repo.listCoordinationTasks(runId).find((t) => t.roleId === 'reviewer')!;
    const reviewer = members.find((m) => m.roleId === 'reviewer')!;
    const prompt = lastPromptTo(reviewer.id);
    expect(prompt).toContain(`Task \`${review.id}\``);
    expect(prompt).toMatch(/omit it: Latte knows your task/);
    // Y cierra sin taskId, con su veredicto.
    expect((await call('latte_report', { outcome: 'succeeded', verdict: 'pass', summary: 'Ok.' }, reviewer.id)).ok).toBe(true);
    expect(b.repo.getCoordinationTask(review.id).status).toBe('done');
  });
});

describe('E6: la extracción de identidad es un despacho real que el revisor puede cerrar', () => {
  it('su prompt lleva el id y el reporte sin taskId suma IDENTIDAD.md al kit', async () => {
    const sources = makeTempDir('latte-identity-sources-');
    fs.writeFileSync(path.join(sources, 'Manual.pdf'), '%PDF-1.4 manual');
    const b = await makeBackend({ chooseFiles: async () => [path.join(sources, 'Manual.pdf')] });
    try {
      const brand = await b.service.createBrand('Ayulem');
      const work = await b.service.createWork(brand.id, 'Propuesta');
      // La extracción corre en el ESPACIO INTERNO de la marca: en la app lo
      // crea el primer pedido; acá se siembra para poder prepararle equipo.
      b.repo.setMeta(`brand_workspace_work:${brand.id}`, work.id);
      b.repo.setMeta(`work_internal:${work.id}`, '1');
      b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
      b.repo.setMeta('coordination_coordinator:' + work.id, COORDINATOR);
      const members: FakeTeamMember[] = [];
      const { send } = fakeCoordinationHub(b, members);
      members.push({ id: COORDINATOR, workId: work.id, roleId: 'strategist', status: 'idle' });
      await b.service.addBrandIdentityFiles(brand.id);
      // K1: el clic de la persona ES la aprobación — la tarea sale despachada
      // en el mismo gesto, sin propuesta esperando en un chat.
      expect((await b.service.requestBrandIdentityExtraction(brand.id)).outcome).toBe('dispatched');
      const runId = b.repo.findActiveCoordinationRun(work.id)!.id;
      await settle();
      const [task] = b.repo.listCoordinationTasks(runId);
      expect(task!.status, 'la tarea salió despachada').toBe('dispatched');
      const reviewer = members.find((m) => m.roleId === 'reviewer')!;
      const prompt = String(send.mock.calls.filter((c) => c[0] === reviewer.id).at(-1)![1]);
      expect(prompt).toContain(`Task \`${task!.id}\``);
      expect(prompt).toMatch(/omit it: Latte knows your task/);
      const dir = b.files.workDir(brand.id, work.id);
      fs.writeFileSync(path.join(dir, 'borradores', 'identidad', 'IDENTIDAD.md'), '# Identidad\n');
      const token = b.coordinationTokens.mint(work.id, reviewer.id);
      const result = await b.coordinationMcpServer.handleMcpRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'latte_report', arguments: { outcome: 'succeeded', summary: 'Listo.', files: ['borradores/identidad/IDENTIDAD.md'] },
      } }), `Bearer ${token}`, '127.0.0.1');
      expect((JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent.ok).toBe(true);
      expect((await b.service.readBrandIdentity(brand.id)).hasIdentityDoc).toBe(true);
    } finally {
      vi.restoreAllMocks();
      b.cleanup();
      removeDir(sources);
    }
  });
});
