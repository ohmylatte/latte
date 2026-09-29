import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_OFF, FEATURE_ON } from '../../electron/core/features';
import type { BrandDnaBuildJob, BrandDnaView } from '../../shared/contracts';
import {
  fakeCoordinationHub,
  fakeExecutablePath,
  fakePtyLoader,
  fakeRunner,
  makeBackend,
  MINIMAL_PNG,
  settle,
  type FakeTeamMember,
  type TestBackend,
} from './helpers';

/**
 * 1B: EL BUILD DEL ADN ES UN TRABAJO DEL EQUIPO CON PASOS REALES.
 *
 * Latte junta las fuentes que le tocan en cada modo, le entrega la tarea a un
 * agente (una por marca a la vez), y sólo guarda lo que el agente escribe si
 * `ADN.json` valida con la forma exacta del contrato. Sin IA el trabajo falla
 * con el código del motor, no con una frase inventada.
 */

const ADN_REL = 'borradores/adn/ADN.json';
const PASOS_REL = 'borradores/adn/pasos.json';

const ADN_FIELDS = {
  tone: { value: { adjectives: ['cercano', 'directo'], example: 'Escribís como hablás.' }, sources: [{ kind: 'web', label: 'web · home' }], assumption: false },
  audience: { value: 'Mayoristas que compran por volumen.', sources: [{ kind: 'web', label: 'web · quiénes somos' }], assumption: false },
  valueProp: null,
  wordsYes: { value: ['mayorista', 'tramo'], sources: [{ kind: 'correction', label: 'Corrección de la persona' }], assumption: false },
  wordsNo: { value: ['oferta'], sources: [{ kind: 'file', label: 'manual.pdf p.2' }], assumption: true },
  claims: null,
  colors: { value: [{ hex: '#a77b38', name: 'dorado' }], sources: [{ kind: 'file', label: 'manual.pdf p.4' }], assumption: false },
  fonts: null,
};

const PASOS = {
  web: { state: 'done', detail: 'Leí la home y la página de quiénes somos.' },
  instagram: { state: 'failed', detail: 'El perfil pide login: no se pudo leer lo público.' },
};

interface Envelope { ok: boolean; data: unknown }

describe('ADN de marca · build del motor', () => {
  let b: TestBackend;
  let brandId: string;
  let workId: string;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  const coordinator = 'mem_coordinator';

  const workDir = () => b.files.workDir(brandId, workId);
  const fuentes = () => path.join(workDir(), 'borradores', 'adn', 'fuentes');
  const step = (job: BrandDnaBuildJob, key: string) => job.steps.find((s) => s.key === key)!;

  /**
   * Rehace el backend con IA disponible (terminal que carga y CLI en el PATH)
   * y con la marca y el trabajo recién creados sobre ESE backend.
   */
  const restartWithAi = async (overrides: Parameters<typeof makeBackend>[0] = {}) => {
    b.cleanup();
    b = await makeBackend({
      loadPty: fakePtyLoader().load,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which'
        ? { code: 0, stdout: `${fakeExecutablePath(args[0])}\n` }
        : { code: 0, stdout: '1.0.0\n' })),
      ...overrides,
    });
    const brand = await b.service.createBrand('Ayulem');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
  };

  /** La coordinación con un equipo fake, como hace el test de identidad. */
  const coordinationOn = () => {
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: coordinator, workId, roleId: 'strategist', status: 'idle' });
    b.repo.setMeta('coordination_coordinator:' + workId, coordinator);
  };

  /** Aprueba la propuesta de tarea y devuelve la tarea interna del build. */
  const approveAndTask = async (jobId: string) => {
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.spec.includes(jobId));
    expect(task, 'la tarea del build quedó creada').toBeDefined();
    return task!;
  };

  const worker = () => members.find((m) => m.roleId === 'reviewer') ?? members.find((m) => m.id !== coordinator)!;

  const mcp = async (name: string, args: unknown, memberId: string): Promise<Envelope> => {
    const token = b.coordinationTokens.mint(workId, memberId);
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    members = [];
    send = undefined as never;
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('sin IA el build falla con el código del motor y ningún paso se ejecutó', async () => {
    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    expect(job).toMatchObject({ brandId, mode: 'existing', done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });
    expect(job.steps.map((s) => s.key)).toEqual(['web', 'instagram', 'files', 'context', 'documents', 'decisions', 'memory', 'compose']);
    expect(step(job, 'compose').state).toBe('failed');
    expect(step(job, 'compose').detail).toBeTruthy();
    for (const key of ['web', 'instagram', 'files', 'context', 'documents', 'decisions', 'memory']) {
      expect(step(job, key).state, key).toBe('skipped');
    }
    expect(fs.existsSync(path.join(workDir(), 'borradores', 'adn', 'fuentes'))).toBe(false);
    await expect(b.service.readBrandDnaBuildJob('bdj_missing_job_xx')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.service.cancelBrandDnaBuild(job.jobId)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('modo existing junta el material que la marca ya tiene en la carpeta de fuentes', async () => {
    await restartWithAi();
    await b.service.updateBrand(brandId, 'Posicionamiento: mayoristas sin intermediarios.');
    await b.service.addDecision(workId, 'Nunca decimos oferta.');
    const doc = await b.service.createDocument(workId, 'strategy', 'Estrategia');
    await b.service.updateDocument(doc.document.id, { status: 'approved' });

    // La coordinación está apagada: el paso de orquestación falla con SU código,
    // pero lo que Latte junta con sus propias manos ya quedó hecho y registrado.
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_OFF);
    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    expect(job).toMatchObject({ done: true, outcome: 'failed', reason: 'FEATURE_DISABLED' });
    expect(step(job, 'context')).toMatchObject({ state: 'done' });
    expect(step(job, 'decisions')).toMatchObject({ state: 'done' });
    expect(step(job, 'documents')).toMatchObject({ state: 'done' });
    expect(step(job, 'memory').state).toBe('skipped');
    expect(step(job, 'files').state).toBe('skipped');
    expect(step(job, 'web').state).toBe('skipped');
    expect(step(job, 'instagram').state).toBe('skipped');

    expect(fs.readFileSync(path.join(fuentes(), 'contexto.md'), 'utf8')).toContain('mayoristas sin intermediarios');
    expect(fs.readFileSync(path.join(fuentes(), 'decisiones.md'), 'utf8')).toContain('Nunca decimos oferta');
    expect(fs.readdirSync(path.join(fuentes(), 'documentos'))).toHaveLength(1);
    expect(fs.existsSync(path.join(fuentes(), 'memoria.md'))).toBe(false);
  });

  // P9: LAS FUENTES NO SON LECTURA OBLIGATORIA ENTERAS. El agente compone
  // OCHO campos: necesita evidencia representativa, no el archivo completo de
  // cada trabajo de la marca en el contexto. Extracto + puntero, y la copia
  // completa queda en el disco del mismo trabajo, adentro de `fuentes/`.
  it('P9: cada documento fuente entra como extracto con puntero a la copia completa', async () => {
    await restartWithAi();
    coordinationOn();
    const doc = await b.service.createDocument(workId, 'strategy', 'Estrategia larga');
    await b.service.updateDocument(doc.document.id, { status: 'approved' });
    const marker = 'COLA_DEL_DOCUMENTO_ESTA_DESPUES_DEL_EXTRACTO';
    fs.writeFileSync(path.join(workDir(), doc.document.fileName), `${'parrafo de fondo '.repeat(300)}${marker}`);

    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    expect(step(job, 'documents')).toMatchObject({ state: 'done' });

    const names = fs.readdirSync(path.join(fuentes(), 'documentos'));
    expect(names).toHaveLength(1);
    const source = fs.readFileSync(path.join(fuentes(), 'documentos', names[0]!), 'utf8');
    expect(source.length).toBeLessThan(2_600);
    expect(source).toContain('parrafo de fondo');
    expect(source).not.toContain(marker);
    expect(source).toMatch(/The full document is at \.\/borradores\/adn\/fuentes\/completos\//);

    // La copia completa está en el disco, adentro del MISMO trabajo: el agente
    // no tiene que salir del directorio para leerla (esa es la Working rule).
    const full = fs.readFileSync(path.join(fuentes(), 'completos', names[0]!), 'utf8');
    expect(full).toContain(marker);

    // P9: la copia completa NO es lectura obligatoria: el spec lista las
    // fuentes de lectura por defecto y ahí no aparece.
    const task = await approveAndTask(job.jobId);
    expect(task.spec).toContain('fuentes/documentos/');
    expect(task.spec).not.toContain('fuentes/completos/');
  });

  // P9: la memoria del build también se acota (100 decisiones / 100 artefactos)
  // y, cuando se acota, el ÍNDICE con el log completo queda escrito: es a lo
  // que apunta el cuerpo de `memoria.md`, y un puntero que no resuelve es un
  // perdición disfrazada.
  it('P9: la memoria del build entra con tope 100/100 y el índice completo queda escrito', async () => {
    await restartWithAi();
    // El build corre en el trabajo MÁS RECIENTE de la marca, así que el
    // anterior va primero y el del build se crea al final.
    const priorId = workId;
    for (let i = 0; i < 105; i++) {
      b.repo.insertDecision({
        id: `dec_${String(i).padStart(3, '0')}`,
        workId: priorId,
        text: `Decision heredada ${i}`,
        createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
      });
    }
    workId = (await b.service.createWork(brandId, 'Trabajo del build')).id;
    b.repo.touchWork(workId, new Date(Date.now() + 60_000).toISOString());
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_OFF);

    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    expect(step(job, 'memory')).toMatchObject({ state: 'done' });

    const memoria = fs.readFileSync(path.join(fuentes(), 'memoria.md'), 'utf8');
    const lines = memoria.split('\n').filter((l) => l.startsWith('- 2026-'));
    expect(lines, '100 decisiones inline, ni una más').toHaveLength(100);
    expect(memoria).toContain('Decision heredada 104');
    expect(memoria).not.toContain('Decision heredada 0');
    // El puntero al índice está en el cuerpo...
    expect(memoria).toContain('./.latte/context/brand-memory.md');
    // ...y el índice existe, con el log COMPLETO adentro.
    const index = fs.readFileSync(path.join(workDir(), '.latte', 'context', 'brand-memory.md'), 'utf8');
    expect(index).toContain('Decision heredada 0');
    expect(index).toContain('Decision heredada 104');
  });

  it('modo sources deja sólo lo pedido, con la URL y la cuenta en espera del agente', async () => {
    await restartWithAi();
    coordinationOn();
    await b.service.updateBrand(brandId, 'Contexto que NO debería entrar en modo fuentes.');

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: '@ayulem', useIdentityFiles: false });
    expect(job.done).toBe(false);
    expect(job.outcome).toBeNull();
    expect(step(job, 'web').state).toBe('pending');
    expect(step(job, 'instagram').state).toBe('pending');
    for (const key of ['files', 'context', 'documents', 'decisions', 'memory']) {
      expect(step(job, key).state, key).toBe('skipped');
    }
    expect(step(job, 'compose').state).toBe('pending');
    expect(step(job, 'compose').detail).toBeTruthy();
    expect(fs.existsSync(path.join(fuentes(), 'contexto.md'))).toBe(false);

    // Un segundo build con otra moda devuelve EL MISMO trabajo en curso.
    const again = await b.service.buildBrandDna(brandId, 'existing', null);
    expect(again.jobId).toBe(job.jobId);
    expect(again.mode).toBe('sources');
    expect((await b.service.readBrandDnaBuildJob(job.jobId)).done).toBe(false);

    // La propuesta de tarea quedó esperando el sí de la persona.
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    expect(b.repo.getCoordinationRun(runId).status).toBe('planning');
    expect(send).toBeDefined();

    // Aprobada la propuesta, la tarea del build aparece con SU trabajo marcado.
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    const task = b.repo.listCoordinationTasks(runId).find((t) => t.spec.includes(job.jobId));
    expect(task).toBeDefined();
    expect(task!.spec).toContain(ADN_REL);
    expect(task!.spec).toContain('pasos.json');
    expect(task!.audience).toBe('internal');
    // P9: recortar las FUENTES no toca la obligación de citar: el spec sigue
    // exigiendo `sources` por campo y `assumption` sólo con base firme.
    expect(task!.spec).toContain('`sources` says where the value came from');
    expect(task!.spec).toContain('`assumption` is true ONLY when you inferred the value without a firm source');
  });

  it('un build cancelado queda cancelado y sucede otro distinto', async () => {
    await restartWithAi();
    coordinationOn();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: null, useIdentityFiles: false });
    expect(job.done).toBe(false);
    const cancelled = await b.service.cancelBrandDnaBuild(job.jobId);
    expect(cancelled).toMatchObject({ done: true, outcome: 'cancelled', reason: null });
    for (const s of cancelled.steps) expect(['done', 'skipped'], s.key).toContain(s.state);
    expect(step(cancelled, 'compose').state).toBe('skipped');
    expect((await b.service.readBrandDnaBuildJob(job.jobId)).outcome).toBe('cancelled');
    await expect(b.service.cancelBrandDnaBuild(job.jobId)).rejects.toMatchObject({ code: 'VALIDATION' });

    const next = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: null, useIdentityFiles: false });
    expect(next.jobId).not.toBe(job.jobId);
  });

  it('el agente compone ADN.json: el reporte lo valida, lo guarda como borrador y cierra los pasos', async () => {
    await restartWithAi();
    coordinationOn();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: '@ayulem', useIdentityFiles: false });
    expect(job.done).toBe(false);
    const task = await approveAndTask(job.jobId);
    expect(send.mock.calls.some((c) => c[0] === worker().id)).toBe(true);

    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'ADN.json'), JSON.stringify({ ...ADN_FIELDS, jobId: job.jobId }, null, 2));
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'pasos.json'), JSON.stringify({ ...PASOS, jobId: job.jobId }, null, 2));
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'ADN listo.', files: [ADN_REL, PASOS_REL] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'proposed', reason: null });
    expect(step(after, 'compose').state).toBe('done');
    expect(step(after, 'web')).toMatchObject({ state: 'done' });
    expect(step(after, 'instagram')).toMatchObject({ state: 'failed' });
    expect(step(after, 'instagram').detail).toContain('login');

    const view: BrandDnaView = await b.service.readBrandDna(brandId);
    expect(view.draft).not.toBeNull();
    expect(view.draft!.audience!.value).toBe('Mayoristas que compran por volumen.');
    expect(view.draft!.wordsNo!.assumption).toBe(true);
    expect(view.draft!.colors!.value[0]!.hex).toBe('#a77b38');
    expect(view.changedSinceApproval).toBe(true);
    expect(view.approved).toBeNull();
  });

  it('un ADN.json con forma inválida no entra: el build falla y el borrador sigue intacto', async () => {
    await restartWithAi();
    coordinationOn();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: null, useIdentityFiles: false });
    const task = await approveAndTask(job.jobId);

    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'ADN.json'), JSON.stringify({ tone: { adjectives: 'nope' }, extra: true, jobId: job.jobId }));
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'ADN listo.', files: [ADN_REL] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'failed', reason: 'INVALID_ADN' });
    expect((await b.service.readBrandDna(brandId)).draft).toBeNull();
  });

  it('un reporte sin ADN.json no cierra nada en silencio: el build falla diciendo qué faltó', async () => {
    await restartWithAi();
    coordinationOn();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: null, useIdentityFiles: false });
    const task = await approveAndTask(job.jobId);

    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'notas.md'), 'Notas sueltas.');
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Esperen, no terminé.', files: ['borradores/adn/notas.md'] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'failed', reason: 'NO_ADN_FILE' });
    expect((await b.service.readBrandDna(brandId)).draft).toBeNull();
  });

  it('un reporte SIN archivos no dispara el gancho: la lectura del job cierra el build igual', async () => {
    await restartWithAi();
    coordinationOn();

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', instagram: null, useIdentityFiles: false });
    const task = await approveAndTask(job.jobId);
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Algo salió mal y no tengo archivos.' }, worker().id)).ok).toBe(true);
    // Sin archivos no hay gancho: el que consulta es quien mira la tarea.
    expect((await b.service.readBrandDnaBuildJob(job.jobId))).toMatchObject({ done: true, outcome: 'failed', reason: 'NO_ADN_FILE' });
    expect((await b.service.readBrandDna(brandId)).draft).toBeNull();
  });

  it('con los archivos del kit pedidos, el build los copia a las fuentes', async () => {
    await restartWithAi({ chooseFiles: async () => [path.join(b.dir, 'logo.png')] });
    coordinationOn();
    fs.writeFileSync(path.join(b.dir, 'logo.png'), MINIMAL_PNG);
    await b.service.addBrandIdentityFiles(brandId);

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: null, instagram: '@ayulem', useIdentityFiles: true });
    expect(step(job, 'files')).toMatchObject({ state: 'done' });
    expect(fs.readdirSync(fuentes())).toContain('logo.png');
    expect(step(job, 'web').state).toBe('skipped');
    expect(step(job, 'instagram').state).toBe('pending');
  });
});
