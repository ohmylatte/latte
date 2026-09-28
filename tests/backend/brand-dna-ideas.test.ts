import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_OFF, FEATURE_ON } from '../../electron/core/features';
import { ValidationError } from '../../electron/core/errors';
import { requireBrandDnaIdeas } from '../../electron/branding/dna';
import type { BrandDnaBuildJob, BrandDnaView } from '../../shared/contracts';
import {
  fakeCoordinationHub,
  fakeExecutablePath,
  fakePtyLoader,
  fakeRunner,
  makeBackend,
  settle,
  type FakeTeamMember,
  type TestBackend,
} from './helpers';

/**
 * 3 · LAS IDEAS DEL AGENTE, CON BASE.
 *
 * `IDEAS.json` entra con la misma vara estricta que `ADN.json`: forma exacta,
 * máximo 4, `workTypeId` con forma de id del catálogo y `basedOn` SIN VACÍO —
 * una idea sin base no se guarda. El modo `ideas` es una tarea liviana que
 * sólo compone ideas (un paso), y un build normal también las trae cuando el
 * agente las escribe.
 */

const IDEAS_REL = 'borradores/adn/IDEAS.json';
const ADN_REL = 'borradores/adn/ADN.json';

const IDEAS = {
  ideas: [
    {
      id: 'lanzamiento-otonio',
      title: 'Lanzamiento de la colección de otoño',
      why: 'La colección nueva todavía no tiene campaña.',
      workTypeId: 'campaign-new',
      basedOn: [{ kind: 'document', label: 'brief de primavera' }],
      createdAt: '2026-09-27',
    },
    {
      id: 'tono-posts',
      title: 'Revisá el tono de tus últimos posts',
      why: '3 piezas usan «oferta».',
      workTypeId: 'copy-pieces',
      basedOn: [
        { kind: 'identity', label: 'ADN v1' },
        { kind: 'calendar', label: 'primavera' },
      ],
      createdAt: '2026-09-27',
    },
  ],
};

const ADN_FIELDS = {
  tone: { value: { adjectives: ['cercano'], example: 'Escribís como hablás.' }, sources: [{ kind: 'web', label: 'web · home' }], assumption: false },
  audience: { value: 'Mayoristas que compran por volumen.', sources: [{ kind: 'web', label: 'web · quiénes somos' }], assumption: false },
  valueProp: null,
  wordsYes: null,
  wordsNo: { value: ['oferta'], sources: [{ kind: 'file', label: 'manual.pdf p.2' }], assumption: true },
  claims: null,
  colors: null,
  fonts: null,
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('IDEAS.json · forma estricta', () => {
  it('acepta la forma exacta, con sus fuentes y sin claves de más', () => {
    const ideas = requireBrandDnaIdeas(IDEAS);
    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toMatchObject({ id: 'lanzamiento-otonio', workTypeId: 'campaign-new' });
    expect(ideas[1]!.basedOn.map((source) => source.kind)).toEqual(['identity', 'calendar']);
  });

  const invalid: Array<[string, unknown]> = [
    ['clave de más arriba', { ...IDEAS, extra: 1 }],
    ['no es un objeto', [] ],
    ['ideas no es un array', { ideas: 'lanzamiento' }],
    ['más de 4 ideas', { ideas: Array.from({ length: 5 }, (_, i) => ({ ...IDEAS.ideas[0], id: `idea-${i}` })) }],
    ['sin why', { ideas: [{ ...IDEAS.ideas[0], why: undefined }] }],
    ['clave de más en la idea', { ideas: [{ ...IDEAS.ideas[0], priority: 1 }] }],
    ['workTypeId con forma rara', { ideas: [{ ...IDEAS.ideas[0], workTypeId: 'Campaign New' }] }],
    ['basedOn vacío', { ideas: [{ ...IDEAS.ideas[0], basedOn: [] }] }],
    ['basedOn con kind inventado', { ideas: [{ ...IDEAS.ideas[0], basedOn: [{ kind: 'guess', label: 'x' }] }] }],
    ['basedOn con clave de más', { ideas: [{ ...IDEAS.ideas[0], basedOn: [{ kind: 'web', label: 'x', when: 'hoy' }] }] }],
    ['createdAt sin fecha', { ideas: [{ ...IDEAS.ideas[0], createdAt: 'ayer' }] }],
    ['id repetido', { ideas: [IDEAS.ideas[0], { ...IDEAS.ideas[0], title: 'Otra' }] }],
    ['title con salto de línea', { ideas: [{ ...IDEAS.ideas[0], title: 'Una\ndos' }] }],
    ['why vacío', { ideas: [{ ...IDEAS.ideas[0], why: '  ' }] }],
    ['campo desconocido en el ADN del plan', { ideas: [IDEAS.ideas[0]], language: 'es' }],
  ];
  for (const [name, raw] of invalid) {
    it(`rechaza: ${name}`, () => {
      expect(() => requireBrandDnaIdeas(clone(raw))).toThrow(ValidationError);
    });
  }

  it('cero ideas es válido: si no hay base, no hay idea', () => {
    expect(requireBrandDnaIdeas({ ideas: [] })).toEqual([]);
  });
});

interface Envelope { ok: boolean; data: unknown }

describe('ADN · el build de ideas', () => {
  let b: TestBackend;
  let brandId: string;
  let workId: string;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  const coordinator = 'mem_coordinator';

  const workDir = () => b.files.workDir(brandId, workId);
  const fuentes = () => path.join(workDir(), 'borradores', 'adn', 'fuentes');

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

  const coordinationOn = () => {
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: coordinator, workId, roleId: 'strategist', status: 'idle' });
    b.repo.setMeta('coordination_coordinator:' + workId, coordinator);
  };

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

  const writeIdeas = (raw: unknown) => {
    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'IDEAS.json'), JSON.stringify(raw));
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

  it('una marca sin ideas las tiene vacías y sin fecha', async () => {
    const view = await b.service.readBrandDna(brandId);
    expect(view.ideas).toEqual([]);
    expect(view.ideasUpdatedAt).toBeNull();
  });

  it('sin IA el build de ideas falla con el código del motor y sólo pide componer', async () => {
    const job = await b.service.buildBrandDna(brandId, 'ideas', null);
    expect(job).toMatchObject({ brandId, mode: 'ideas', done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });
    expect(job.steps.map((step) => step.key)).toEqual(['compose']);
    expect(job.steps[0]!.state).toBe('failed');
    expect(job.steps[0]!.detail).toBeTruthy();
  });

  it('la coordinación apagada también falla con su código, después de juntar los insumos', async () => {
    await restartWithAi();
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_OFF);
    const job = await b.service.buildBrandDna(brandId, 'ideas', null);
    expect(job).toMatchObject({ done: true, outcome: 'failed', reason: 'FEATURE_DISABLED' });
    expect(stepOf(job, 'compose').state).toBe('failed');
    // Los insumos sí se juntaron con las manos de Latte.
    expect(fs.readFileSync(path.join(fuentes(), 'fecha.md'), 'utf8')).toContain('Argentina');
    expect(fs.existsSync(path.join(fuentes(), 'trabajos.md'))).toBe(true);
    expect(fs.existsSync(path.join(fuentes(), 'embudo.md'))).toBe(true);
    expect(fs.existsSync(path.join(fuentes(), 'fechas-comerciales.md'))).toBe(true);
    expect(fs.existsSync(path.join(fuentes(), 'adn.md'))).toBe(false);
  });

  it('junta los insumos (ADN, fecha, trabajos, embudo, fechas comerciales) y el agente guarda las ideas', async () => {
    await restartWithAi();
    coordinationOn();
    await b.service.updateBrandDnaField(brandId, 'audience', 'Mayoristas');

    const job = await b.service.buildBrandDna(brandId, 'ideas', null);
    expect(job.done).toBe(false);
    expect(job.steps.map((step) => step.key)).toEqual(['compose']);

    const files = fs.readdirSync(fuentes()).sort();
    expect(files).toEqual(['adn.md', 'embudo.md', 'fecha.md', 'fechas-comerciales.md', 'trabajos.md']);
    expect(fs.readFileSync(path.join(fuentes(), 'adn.md'), 'utf8')).toContain('Mayoristas');
    expect(fs.readFileSync(path.join(fuentes(), 'fecha.md'), 'utf8')).toContain('Estación');
    expect(fs.readFileSync(path.join(fuentes(), 'trabajos.md'), 'utf8')).toContain('Propuesta mayorista');

    const task = await approveAndTask(job.jobId);
    expect(task.audience).toBe('internal');
    expect(task.spec).toContain('IDEAS.json');
    expect(task.spec).toContain('workTypeId');
    // El contenido por defecto es es-AR: las ideas se piden en ese idioma.
    expect(task.spec).toContain('Spanish (Argentina)');
    expect(task.spec).not.toContain('English (United States)');
    expect(send.mock.calls.some((call) => call[0] === worker().id)).toBe(true);

    writeIdeas(IDEAS);
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Ideas listas.', files: [IDEAS_REL] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'updated', reason: null });
    expect(stepOf(after, 'compose').state).toBe('done');

    const view = await b.service.readBrandDna(brandId);
    expect(view.ideas.map((idea) => idea.id)).toEqual(['lanzamiento-otonio', 'tono-posts']);
    expect(view.ideas[0]!.why).toBe('La colección nueva todavía no tiene campaña.');
    expect(view.ideasUpdatedAt).toBeTruthy();
    // El modo ideas NO toca el borrador: sigue sólo con lo que se editó a mano.
    expect(view.draft!.audience!.value).toBe('Mayoristas');
    expect(view.approved).toBeNull();
  });

  it('un reporte sin IDEAS.json cierra el build como fallido, sin ideas', async () => {
    await restartWithAi();
    coordinationOn();
    const job = await b.service.buildBrandDna(brandId, 'ideas', null);
    const task = await approveAndTask(job.jobId);
    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'No pude.', files: ['borradores/adn/notas.md'] }, worker().id)).ok).toBe(true);
    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'failed', reason: 'NO_IDEAS_FILE' });
    expect((await b.service.readBrandDna(brandId)).ideas).toEqual([]);
  });

  it('un IDEAS.json con forma inválida no entra: el build falla y las ideas siguen como estaban', async () => {
    await restartWithAi();
    coordinationOn();
    const job = await b.service.buildBrandDna(brandId, 'ideas', null);
    const task = await approveAndTask(job.jobId);
    writeIdeas({ ideas: [{ ...IDEAS.ideas[0], basedOn: [] }] });
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Listo.', files: [IDEAS_REL] }, worker().id)).ok).toBe(true);
    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'failed', reason: 'INVALID_IDEAS' });
    expect((await b.service.readBrandDna(brandId)).ideas).toEqual([]);
  });

  it('un build normal también trae las ideas cuando el agente las escribió', async () => {
    await restartWithAi();
    coordinationOn();
    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    const task = await approveAndTask(job.jobId);
    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'ADN.json'), JSON.stringify(ADN_FIELDS));
    writeIdeas(IDEAS);
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Listo.', files: [ADN_REL, IDEAS_REL] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'proposed', reason: null });
    const view = await b.service.readBrandDna(brandId);
    expect(view.draft!.audience!.value).toBe('Mayoristas que compran por volumen.');
    expect(view.ideas.map((idea) => idea.id)).toEqual(['lanzamiento-otonio', 'tono-posts']);
    expect(view.ideasUpdatedAt).toBeTruthy();
  });

  it('un build normal sin IDEAS.json deja las ideas como estaban', async () => {
    await restartWithAi();
    coordinationOn();
    const job = await b.service.buildBrandDna(brandId, 'existing', null);
    const task = await approveAndTask(job.jobId);
    fs.mkdirSync(path.join(workDir(), 'borradores', 'adn'), { recursive: true });
    fs.writeFileSync(path.join(workDir(), 'borradores', 'adn', 'ADN.json'), JSON.stringify(ADN_FIELDS));
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Listo.', files: [ADN_REL] }, worker().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'proposed' });
    const view = await b.service.readBrandDna(brandId);
    expect(view.ideas).toEqual([]);
    expect(view.draft).not.toBeNull();
  });

  it('un sólo trabajo por marca: si hay un build en curso, el de ideas devuelve ese mismo', async () => {
    await restartWithAi();
    coordinationOn();
    const build = await b.service.buildBrandDna(brandId, 'existing', null);
    const ideas = await b.service.buildBrandDna(brandId, 'ideas', null);
    expect(ideas.jobId).toBe(build.jobId);
    expect(ideas.mode).toBe('existing');
  });

  it('la marca archivada no arranca un build de ideas', async () => {
    await b.service.archiveBrand(brandId);
    await expect(b.service.buildBrandDna(brandId, 'ideas', null)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
  });
});

function stepOf(job: BrandDnaBuildJob, key: string) {
  return job.steps.find((step) => step.key === key)!;
}
