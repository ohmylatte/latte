import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { MCP_TOOL_DEFINITIONS } from '../../electron/coordination/mcpServer';
import { deliverableKey, publishDeliverable } from '../../electron/workspace/publishDeliverable';
import { fakeCoordinationHub, makeBackend, makeTempDir, removeDir, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * E2: LA FRONTERA ES `entregables/`, Y NADIE ESCRIBE AHÍ DIRECTO.
 *
 * El caso real (2026-09-25): diez PDFs de la misma propuesta en una mañana
 * (v1..v8, Final, corta), todos en `entregables/`, y el que llegó a la clienta
 * era el documento analítico. Ahora:
 *
 *  - una tarea `client` que reporta dispara SOLA una revisión del `reviewer`
 *    (convocado del plantel, o dado de alta si la marca no tiene uno), con la
 *    línea "el cliente lo lee para decidir: {título}";
 *  - con `pass`, Latte copia el archivo a `entregables/` como ÚNICO vigente y
 *    pliega las versiones anteriores en `entregables/.versiones/`;
 *  - con `fail`, la tarea vuelve a la cola con los motivos en el spec y se
 *    re-despacha una vez; la segunda `fail` se le pregunta a la persona.
 *
 * Todo por la capa real: JSON-RPC sobre el servidor MCP del backend, archivos
 * de verdad en la carpeta del trabajo, el hub falso para ver quién recibe qué.
 */

const COORDINATOR = 'mem_coordinator';
const WRITER = 'mem_writer';

interface Envelope { ok: boolean; data: unknown; error?: { code: string; message: string } }

describe('E2: una tarea para el cliente pasa por la revisión antes de publicarse', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let brandId: string;
  let runId: string;
  let workDir: string;

  const call = async (name: string, args: unknown, memberId = COORDINATOR): Promise<Envelope> => {
    const token = b.coordinationTokens.mint(workId, memberId);
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };
  const write = (relative: string, content: string) => {
    const file = path.join(workDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const deliverables = () => fs.readdirSync(path.join(workDir, 'entregables')).filter((name) => name !== '.versiones').sort();
  const versions = () => {
    const dir = path.join(workDir, 'entregables', '.versiones');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };
  const reviewer = () => members.find((m) => m.roleId === 'reviewer');
  const reviewTasks = () => b.repo.listCoordinationTasks(runId).filter((t) => t.roleId === 'reviewer');
  const promptsTo = (memberId: string) => send.mock.calls.filter((c) => c[0] === memberId).map((c) => String(c[1]));

  /** El coordinador crea la tarea para el cliente, la despacha y el redactor la reporta con su archivo. */
  const deliverClientTask = async (file = 'borradores/propuesta.pdf') => {
    const created = await call('latte_task_create', { roleId: 'writer', title: 'Propuesta para Vane', spec: 'Escribí la propuesta mayorista.', audience: 'client' });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { taskId: string }).taskId;
    expect((await call('latte_dispatch', { taskId })).ok).toBe(true);
    write(file, 'PDF de la propuesta');
    const reported = await call('latte_report', { taskId, outcome: 'succeeded', summary: 'Propuesta lista.', files: [file] }, WRITER);
    expect(reported.ok).toBe(true);
    await settle();
    return taskId;
  };

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    workDir = b.files.workDir(brandId, workId);
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

  it('el reporte de la tarea para el cliente despacha la revisión y todavía no publica nada', async () => {
    await deliverClientTask();
    const [review] = reviewTasks();
    expect(review).toBeDefined();
    expect(review!.audience).toBe('internal');
    expect(review!.spec).toContain('El cliente lo lee para decidir: Propuesta para Vane');
    expect(review!.spec).toContain('borradores/propuesta.pdf');
    // Sin reviewer en el trabajo ni en la marca: alta automática del rol.
    expect(reviewer()).toBeDefined();
    expect(promptsTo(reviewer()!.id).some((p) => p.includes('Propuesta para Vane'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'entregables', 'propuesta.pdf'))).toBe(false);
    // Y el coordinador sabe que no le toca publicar.
    expect(promptsTo(COORDINATOR).join('\n')).toMatch(/review/i);
  });

  it('el reviewer tiene que decir pass o fail: sin veredicto el reporte no entra', async () => {
    await deliverClientTask();
    const [review] = reviewTasks();
    const missing = await call('latte_report', { taskId: review!.id, outcome: 'succeeded', summary: 'Bien.' }, reviewer()!.id);
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toMatch(/verdict/);
    expect(b.repo.getCoordinationTask(review!.id).status).not.toBe('done');
  });

  it('con pass: el archivo queda como único vigente y las versiones anteriores se pliegan', async () => {
    write('entregables/propuesta-v1.pdf', 'v1');
    write('entregables/Propuesta Final.pdf', 'final');
    write('entregables/propuesta corta.pdf', 'corta');
    write('entregables/anuncios.xlsx', 'otra cosa');
    await deliverClientTask();
    const [review] = reviewTasks();
    const passed = await call('latte_report', { taskId: review!.id, outcome: 'succeeded', verdict: 'pass', summary: 'Lista para la clienta.' }, reviewer()!.id);
    expect(passed.ok).toBe(true);
    await settle();
    expect(deliverables()).toEqual(['anuncios.xlsx', 'propuesta.pdf']);
    expect(fs.readFileSync(path.join(workDir, 'entregables', 'propuesta.pdf'), 'utf8')).toBe('PDF de la propuesta');
    expect(versions()).toHaveLength(3);
    expect(versions().every((name) => name.endsWith('.pdf'))).toBe(true);
    expect(promptsTo(COORDINATOR).join('\n')).toContain('entregables/propuesta.pdf');
  });

  it('con fail: vuelve a la cola con los motivos, se re-despacha una vez, y la segunda fail se le pregunta a la persona', async () => {
    const taskId = await deliverClientTask();
    const [firstReview] = reviewTasks();
    const reasons = 'Tiene rótulos internos (Hecho/Hipótesis) y una nota para la agencia.';
    expect((await call('latte_report', { taskId: firstReview!.id, outcome: 'succeeded', verdict: 'fail', summary: reasons }, reviewer()!.id)).ok).toBe(true);
    await settle();
    const retried = b.repo.getCoordinationTask(taskId);
    expect(retried.spec).toContain(reasons);
    expect(['dispatched', 'running']).toContain(retried.status);
    expect(promptsTo(WRITER).at(-1)).toContain(reasons);
    expect(fs.existsSync(path.join(workDir, 'entregables', 'propuesta.pdf'))).toBe(false);

    // Segunda vuelta: el redactor corrige, la revisión vuelve a fallar.
    const reported = await call('latte_report', { taskId, outcome: 'succeeded', summary: 'Corregida.', files: ['borradores/propuesta.pdf'] }, WRITER);
    expect(reported.ok).toBe(true);
    await settle();
    const second = reviewTasks().find((t) => t.id !== firstReview!.id)!;
    expect(second).toBeDefined();
    members.find((m) => m.id === reviewer()!.id)!.status = 'idle';
    const sendsBefore = promptsTo(WRITER).length;
    expect((await call('latte_report', { taskId: second.id, outcome: 'succeeded', verdict: 'fail', summary: 'Sigue con la tabla partida.' }, reviewer()!.id)).ok).toBe(true);
    await settle();
    const asks = await b.service.listOpenCoordinationAsks(runId);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.taskId).toBe(taskId);
    expect(asks[0]!.question).toContain('Sigue con la tabla partida.');
    expect(promptsTo(WRITER)).toHaveLength(sendsBefore);
    expect(fs.existsSync(path.join(workDir, 'entregables', 'propuesta.pdf'))).toBe(false);
  });

  it('una tarea interna no se revisa ni se publica', async () => {
    const created = await call('latte_task_create', { roleId: 'writer', spec: 'Análisis de canales.' });
    const taskId = (created.data as { taskId: string }).taskId;
    expect((await call('latte_dispatch', { taskId })).ok).toBe(true);
    write('borradores/analisis.md', '# Análisis');
    expect((await call('latte_report', { taskId, outcome: 'succeeded', summary: 'Listo.', files: ['borradores/analisis.md'] }, WRITER)).ok).toBe(true);
    await settle();
    expect(reviewTasks()).toHaveLength(0);
    expect(fs.existsSync(path.join(workDir, 'entregables', 'analisis.md'))).toBe(false);
  });

  it('con la revisión apagada, Latte publica al reportar, sin revisor', async () => {
    expect(await b.service.getCoordinationReview(workId)).toBe(true);
    expect(await b.service.setCoordinationReview(workId, false)).toBe(false);
    await deliverClientTask();
    expect(reviewTasks()).toHaveLength(0);
    expect(deliverables()).toContain('propuesta.pdf');
  });
});

describe('E2: `latte_report.files` es una lista de rutas relativas', () => {
  it('el esquema publica una lista (y sigue aceptando el texto de antes)', () => {
    const report = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'latte_report')!;
    const files = (report.inputSchema as { properties: Record<string, { type: unknown; items?: unknown }> }).properties.files!;
    expect(files.type).toEqual(expect.arrayContaining(['array', 'string', 'null']));
    expect(files.items).toMatchObject({ type: 'string' });
    const verdict = (report.inputSchema as { properties: Record<string, unknown> }).properties.verdict;
    expect(verdict).toMatchObject({ enum: ['pass', 'fail'] });
  });

  it('la bitácora devuelve los archivos del reporte cuando vinieron como lista', async () => {
    const b = await makeBackend();
    try {
      const brand = await b.service.createBrand('Marca');
      const work = await b.service.createWork(brand.id, 'Trabajo');
      await b.service.setCoordinationBudget(work.id, { maxDispatches: 10 });
      await b.service.setCoordinationAuthority(work.id, 'auto');
      b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
      b.repo.setMeta('coordination_coordinator:' + work.id, COORDINATOR);
      const members: FakeTeamMember[] = [];
      fakeCoordinationHub(b, members);
      members.push({ id: COORDINATOR, workId: work.id, roleId: 'strategist', status: 'idle' });
      members.push({ id: WRITER, workId: work.id, roleId: 'writer', status: 'idle' });
      await b.service.startCoordinationRun(work.id);
      const run = b.repo.findActiveCoordinationRun(work.id)!;
      b.repo.setMeta('coordination_approved_roles:' + run.id, JSON.stringify(['writer']));
      const call = async (name: string, args: unknown, memberId = COORDINATOR) => {
        const token = b.coordinationTokens.mint(work.id, memberId);
        const result = await b.coordinationMcpServer.handleMcpRequest(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
        return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
      };
      // Las tres tareas antes de reportar la primera: con la última reportada el run se cierra.
      const one = (await call('latte_task_create', { roleId: 'writer', spec: 'Uno.' })).data as { taskId: string };
      const two = (await call('latte_task_create', { roleId: 'writer', spec: 'Dos.' })).data as { taskId: string };
      const three = (await call('latte_task_create', { roleId: 'writer', spec: 'Tres.' })).data as { taskId: string };
      const idle = () => { members.find((m) => m.id === WRITER)!.status = 'idle'; };
      await call('latte_dispatch', { taskId: one.taskId });
      expect((await call('latte_report', { taskId: one.taskId, outcome: 'succeeded', summary: 'Hecho.', files: ['borradores/uno.md', 'dos.md'] }, WRITER)).ok).toBe(true);
      idle();
      await call('latte_dispatch', { taskId: two.taskId });
      expect((await call('latte_report', { taskId: two.taskId, outcome: 'succeeded', summary: 'Hecho.', files: 'viejo.md' }, WRITER)).ok).toBe(true);
      const log = await b.service.listCoordinationLog(run.id);
      const byTask = (taskId: string) => log.find((entry) => 'taskId' in entry && entry.taskId === taskId) as { files?: string[] };
      expect(byTask(one.taskId).files).toEqual(['borradores/uno.md', 'dos.md']);
      expect(byTask(two.taskId).files).toBeUndefined();
      // Una ruta que se sale del trabajo no es un archivo producido: se rechaza.
      idle();
      await call('latte_dispatch', { taskId: three.taskId });
      const escaped = await call('latte_report', { taskId: three.taskId, outcome: 'succeeded', summary: 'Hecho.', files: ['../otro-trabajo/x.pdf'] }, WRITER);
      expect(escaped.ok).toBe(false);
    } finally {
      vi.restoreAllMocks();
      b.cleanup();
    }
  });
});

describe('E2: las instrucciones del trabajo dicen dónde va cada cosa', () => {
  it('entregables/ es sólo lo publicado; los borradores van en la raíz o en borradores/', async () => {
    const b = await makeBackend();
    try {
      const brand = await b.service.createBrand('Ayulem');
      const work = await b.service.createWork(brand.id, 'Propuesta');
      const text = fs.readFileSync(path.join(b.files.workDir(brand.id, work.id), 'CLAUDE.md'), 'utf8');
      expect(text).toContain('./entregables/ holds only what was published for the client');
      expect(text).toContain('never write there yourself');
      expect(text).toContain('./borradores/');
      expect(text).toContain('after the reviewer passes it');
      expect(text).not.toContain('belong in ./entregables/');
    } finally {
      b.cleanup();
    }
  });
});

describe('E2: publicar pliega "la misma pieza" con cualquier sufijo de versión', () => {
  it('v1..v8, Final, corta y (2) son la misma pieza; otra extensión u otro nombre no', async () => {
    const same = ['propuesta.pdf', 'propuesta-v1.pdf', 'Propuesta_v8.pdf', 'Propuesta Final.pdf', 'propuesta corta.pdf', 'propuesta (2).pdf', 'Propuesta v3 final.pdf'];
    expect(new Set(same.map(deliverableKey)).size).toBe(1);
    expect(deliverableKey('propuesta.docx')).not.toBe(deliverableKey('propuesta.pdf'));
    expect(deliverableKey('anuncios.pdf')).not.toBe(deliverableKey('propuesta.pdf'));
  });

  it('no publica lo que está afuera del trabajo ni lo de .latte', () => {
    const dir = makeTempDir();
    try {
      fs.mkdirSync(path.join(dir, '.latte'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.latte', 'x.pdf'), 'x');
      expect(() => publishDeliverable(dir, '../x.pdf', '2026-09-25T12:00:00.000Z')).toThrow();
      expect(() => publishDeliverable(dir, '.latte/x.pdf', '2026-09-25T12:00:00.000Z')).toThrow();
      expect(() => publishDeliverable(dir, 'no-existe.pdf', '2026-09-25T12:00:00.000Z')).toThrow();
      expect(fs.existsSync(path.join(dir, 'entregables'))).toBe(false);
    } finally {
      removeDir(dir);
    }
  });
});
