import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireBrandDnaIdeas } from '../../electron/branding/dna';
import {
  fakeCoordinationHub,
  fakeExecutablePath,
  fakePtyLoader,
  fakeRunner,
  makeBackend,
  makeTempDir,
  MINIMAL_PNG,
  removeDir,
  settle,
  type FakeTeamMember,
  type TestBackend,
} from './helpers';

/**
 * K1: EL CLIC DE LA PERSONA ES LA APROBACIÓN.
 *
 * "Armar mi marca", "Actualizar ideas" y "Extraer identidad" son pedidos que
 * la persona hace desde UNA pantalla de Latte. El motor los despachaba con
 * `requestPersonTask(...)`, que sin un run activo NO despacha: crea una
 * propuesta que se aprueba en el chat del coordinador — y esa propuesta vive
 * en el espacio interno de la marca, que la persona no abre nunca. El build se
 * quedaba quieto para siempre con la ficha "Pendiente".
 *
 * Acá se prueba la salida: con consentimiento explícito, el MISMO llamado deja
 * la tarea DESPACHADA (nunca `proposed`), con el agente del rol creado en el
 * espacio interno, ningún gate esperando, y el reporte cerrando el job.
 * Todas las pruebas usan fakes: ni un agente real.
 */

const ADN_REL = 'borradores/adn/ADN.json';
const IDEAS_REL = 'borradores/adn/IDEAS.json';
const IDENTITY_REL = 'borradores/identidad/IDENTIDAD.md';

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
  ],
};

interface Envelope { ok: boolean; data: unknown }

describe('ADN · el pedido de la persona se despacha solo', () => {
  let b: TestBackend;
  let brandId: string;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];

  /**
   * IA disponible y MARCA NUEVA: sin trabajos, sin equipo y SIN tocar la
   * coordinación — la feature llega prendida por defecto, que es como la
   * encuentra la persona.
   */
  const freshBrandWithAi = async (overrides: Parameters<typeof makeBackend>[0] = {}) => {
    b.cleanup();
    b = await makeBackend({
      loadPty: fakePtyLoader().load,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which'
        ? { code: 0, stdout: `${fakeExecutablePath(args[0])}\n` }
        : { code: 0, stdout: '1.0.0\n' })),
      ...overrides,
    });
    brandId = (await b.service.createBrand('Ayulem')).id;
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
  };

  /** El espacio interno que el build crea, con su carpeta. */
  const brandWorkId = () => b.repo.getMeta(`brand_workspace_work:${brandId}`)!;
  const workDir = () => b.files.workDir(brandId, brandWorkId());
  const reviewer = () => members.find((member) => member.roleId === 'reviewer')!;

  const taskOf = (jobId: string) => {
    const run = b.repo.findActiveCoordinationRun(brandWorkId())!;
    return { run, task: b.repo.listCoordinationTasks(run.id).find((t) => t.spec.includes(jobId))! };
  };

  const mcp = async (name: string, args: unknown, memberId: string): Promise<Envelope> => {
    const token = b.coordinationTokens.mint(brandWorkId(), memberId);
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };

  const writeStamped = (relative: string, jobId: string, raw: unknown): void => {
    const file = path.join(workDir(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...(raw as Record<string, unknown>), jobId }));
  };

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Ayulem')).id;
    members = [];
    send = undefined as never;
  });
  afterEach(() => { b.cleanup(); });

  it('marca nueva, sin trabajos ni equipo: "Armar mi marca" termina con la tarea DESPACHADA', async () => {
    await freshBrandWithAi();
    // Estado por defecto de la coordinación: sin fila que la encienda.
    expect(b.repo.getMeta('feature:coordination')).toBeNull();
    expect(await b.service.listWorks(brandId)).toEqual([]);

    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', channels: [], useIdentityFiles: false });

    // NADA de propuesta pendiente: el run ya existe, aprobado y corriendo.
    expect(job).toMatchObject({ done: false, outcome: null });
    expect(job.steps.map((step) => step.key), 'sólo lo que se pidió: la web y la ficha').toEqual(['web', 'compose']);
    expect(job.steps.find((step) => step.key === 'compose')!.state, 'el paso de la ficha queda en curso').toBe('running');

    const { run, task } = taskOf(job.jobId);
    expect(run.status, 'el run nace corriendo, no esperando una aprobación').toBe('running');
    expect(run.planApprovedAt, 'el plan ya está aprobado').not.toBeNull();
    expect(task, 'la tarea del build quedó creada').toBeDefined();
    expect(task.status, 'la tarea salió DESPACHADA, no propuesta').toBe('dispatched');
    expect(task.audience).toBe('internal');
    expect(await b.service.listCoordinationGates(run.id), 'ninguna aprobación esperando en un chat').toEqual([]);

    // El agente del rol EXISTE en el espacio interno, con el equipo vacío.
    expect(members.filter((member) => member.roleId === 'reviewer'), 'el revisor se contrató solo').toHaveLength(1);
    expect(reviewer().workId).toBe(brandWorkId());
    expect(send.mock.calls.some((call) => call[0] === reviewer().id), 'y le llega el turno').toBe(true);

    // El reporte con ADN.json cierra el job en `proposed`, con el borrador.
    writeStamped(ADN_REL, job.jobId, ADN_FIELDS);
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'ADN listo.', files: [ADN_REL] }, reviewer().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'proposed', reason: null });
    expect((await b.service.readBrandDna(brandId)).draft!.audience!.value).toBe('Mayoristas que compran por volumen.');
  });

  it('mismo caso para ideas: la tarea se despacha y el IDEAS.json cierra el build', async () => {
    await freshBrandWithAi();

    const job = await b.service.buildBrandDna(brandId, 'ideas', null);

    expect(job).toMatchObject({ done: false, outcome: null });
    expect(job.steps.map((step) => step.key)).toEqual(['compose']);
    expect(job.steps[0]!.state).toBe('running');

    const { run, task } = taskOf(job.jobId);
    expect(run.status).toBe('running');
    expect(task.status).toBe('dispatched');
    expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
    expect(members.filter((member) => member.roleId === 'reviewer')).toHaveLength(1);

    writeStamped(IDEAS_REL, job.jobId, IDEAS);
    expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'Ideas listas.', files: [IDEAS_REL] }, reviewer().id)).ok).toBe(true);

    const after = await b.service.readBrandDnaBuildJob(job.jobId);
    expect(after).toMatchObject({ done: true, outcome: 'updated', reason: null });
    const view = await b.service.readBrandDna(brandId);
    expect(view.ideas.map((idea) => idea.id)).toEqual(requireBrandDnaIdeas(IDEAS).map((idea) => idea.id));
    expect(view.draft, 'el modo ideas no toca el borrador').toBeNull();
  });

  it('mismo caso para la extracción de identidad: se despacha sin propuesta', async () => {
    const folder = makeTempDir('latte-consent-identity-');
    const logo = path.join(folder, 'logo.png');
    fs.writeFileSync(logo, MINIMAL_PNG);
    try {
      await freshBrandWithAi({ chooseFiles: async () => [logo] });
      await b.service.addBrandIdentityFiles(brandId);

      const result = await b.service.requestBrandIdentityExtraction(brandId);

      expect(result.outcome, 'sin propuesta esperando en el chat').toBe('dispatched');
      expect(result.reason).toBeNull();
      const run = b.repo.findActiveCoordinationRun(brandWorkId())!;
      expect(run.status).toBe('running');
      expect(await b.service.listCoordinationGates(run.id)).toEqual([]);
      const task = b.repo.listCoordinationTasks(run.id).find((t) => t.roleId === 'reviewer')!;
      expect(task.status).toBe('dispatched');
      expect(task.audience).toBe('internal');
      expect(members.filter((member) => member.roleId === 'reviewer')).toHaveLength(1);
      // Las fuentes quedan adentro del espacio interno, donde el agente las lee.
      expect(fs.readdirSync(path.join(workDir(), 'borradores', 'identidad', 'fuentes'))).toEqual(['logo.png']);

      fs.mkdirSync(path.dirname(path.join(workDir(), IDENTITY_REL)), { recursive: true });
      fs.writeFileSync(path.join(workDir(), IDENTITY_REL), '# Identidad de Ayulem\n');
      expect((await mcp('latte_report', { taskId: task.id, outcome: 'succeeded', summary: 'IDENTIDAD.md listo.', files: [IDENTITY_REL] }, reviewer().id)).ok).toBe(true);
      await settle();
      expect((await b.service.readBrandIdentity(brandId)).hasIdentityDoc).toBe(true);
    } finally {
      removeDir(folder);
    }
  });

  it('sin IA el build falla con el código del motor, como antes: sin propuesta tampoco', async () => {
    // Sin `freshBrandWithAi`: el detector no encuentra ningún runtime.
    const job = await b.service.buildBrandDna(brandId, 'sources', { url: 'https://ayulem.com.ar', channels: [], useIdentityFiles: false });
    expect(job).toMatchObject({ done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });
    expect(b.repo.getMeta(`brand_workspace_work:${brandId}`), 'el espacio interno se creó igual').toBeTruthy();
    expect(await b.service.listActiveCoordinationRuns()).toEqual([]);
  });

  /**
   * LA OTRA MITAD DEL CONTRATO: sin consentimiento, el camino de antes sigue
   * intacto. Un traspaso entre agentes no trae el clic de nadie, así que sigue
   * naciendo una propuesta con SU gate — que es exactamente lo que el build de
   * la marca ya no debe usar.
   */
  it('sin consentimiento el pedido sigue siendo una propuesta con su gate', async () => {
    await freshBrandWithAi();
    const campaign = await b.service.createWork(brandId, 'Propuesta mayorista');

    const result = await b.service.coordinationEngine.requestPersonTask(
      campaign.id,
      { roleId: 'reviewer', title: 'Revisar la propuesta', spec: 'Mirá la propuesta de la marca.' },
      null,
    );

    expect(result.outcome, 'sin el clic de la persona, no se despacha').toBe('proposed');
    const run = b.repo.findActiveCoordinationRun(campaign.id)!;
    expect(run.status).toBe('planning');
    expect(await b.service.listCoordinationGates(run.id), 'y la aprobación vive en su gate').toHaveLength(1);
    expect(b.repo.listCoordinationTasks(run.id), 'una propuesta no crea tareas').toEqual([]);
  });
});
