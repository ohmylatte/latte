import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeExecutablePath,
  fakePtyLoader,
  fakeRunner,
  makeBackend,
  makeTempDir,
  MINIMAL_PNG,
  removeDir,
  type TestBackend,
} from './helpers';

/**
 * EL ESPACIO INTERNO DE LA MARCA.
 *
 * El ADN es lo GENERAL de la marca: no puede depender de que exista un trabajo.
 * Cuando una tarea de marca (build del ADN, ideas, extracción de identidad)
 * necesita un trabajo, Latte usa el espacio interno de la marca — UNO por
 * marca, creado en el momento y reutilizado — en vez de colgarse del trabajo
 * de campaña más reciente.
 *
 * Ese trabajo es un trabajador más para el equipo (carpeta propia, equipo,
 * coordinación) pero NO es un trabajo de la persona: no entra en ninguna lista
 * que ella mira. Este archivo prueba las dos mitades: que la tarea arranca sin
 * trabajos, y que el interno no se le filtra.
 */
describe('espacio interno de la marca', () => {
  let b: TestBackend;
  let brandId: string;

  const internalId = () => b.repo.getMeta(`brand_workspace_work:${brandId}`);
  /** Lo que "Armar mi marca" manda desde el recorrido inicial. */
  const sources = { url: 'https://ayulem.com.ar', channels: [], useIdentityFiles: false };

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Ayulem')).id;
  });
  afterEach(() => { b.cleanup(); });

  /**
   * El mismo truco del test del build: IA disponible (terminal que carga y CLI
   * en el PATH), para que el build llegue a juntar sus insumos antes de que el
   * despacho se caiga por la coordinación apagada.
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
    brandId = (await b.service.createBrand('Ayulem')).id;
  };

  it('una marca sin trabajos puede arrancar "Armar mi marca"', async () => {
    expect(await b.service.listWorks(brandId)).toEqual([]);

    const job = await b.service.buildBrandDna(brandId, 'sources', sources);

    // Sin IA en el test el MOTOR falla con su código; lo que no puede pasar es
    // que la falta de un trabajo tire el build antes de arrancar.
    expect(job).toMatchObject({ brandId, mode: 'sources', done: true, outcome: 'failed', reason: 'NOT_INSTALLED' });
    expect(job.steps.map((step) => step.key)).toContain('web');
  });

  it('el build crea UN espacio interno, lo marca y lo reutiliza', async () => {
    await b.service.buildBrandDna(brandId, 'sources', sources);
    const first = internalId();
    expect(first, 'el espacio interno quedó anotado en la marca').toBeTruthy();

    // Con otros trabajos de campaña encima, el de marca sigue siendo EL MISMO:
    // así el ADN no se compone "adentro" de un trabajo de campaña cualquiera.
    const campaign = await b.service.createWork(brandId, 'Campaña de invierno');
    await b.service.buildBrandDna(brandId, 'sources', sources);
    expect(internalId()).toBe(first);
    expect(first).not.toBe(campaign.id);
  });

  it('sobrevive un reinicio: la marca reutiliza el mismo espacio interno', async () => {
    await b.service.buildBrandDna(brandId, 'sources', sources);
    const first = internalId();
    const dir = b.dir;

    b.service.shutdown();
    const restarted = await makeBackend({ dataDir: dir });
    const works = await restarted.service.listWorks(brandId);
    expect(works.map((work) => work.id), 'ni siquiera aparece en la lista de la persona').not.toContain(first);
    expect(restarted.repo.getMeta(`brand_workspace_work:${brandId}`)).toBe(first);

    await restarted.service.buildBrandDna(brandId, 'sources', sources);
    expect(restarted.repo.getMeta(`brand_workspace_work:${brandId}`)).toBe(first);

    restarted.cleanup();
    removeDir(dir);
  });

  it('la extracción de identidad también arranca sin trabajos', async () => {
    const folder = makeTempDir('latte-identity-sources-');
    const png = path.join(folder, 'logo.png');
    fs.writeFileSync(png, MINIMAL_PNG);
    b.cleanup();
    b = await makeBackend({ chooseFiles: async () => [png] });
    brandId = (await b.service.createBrand('Ayulem')).id;
    await b.service.addBrandIdentityFiles(brandId);

    const error = await b.service.requestBrandIdentityExtraction(brandId).catch((e: unknown) => e);

    // Puede fallar por la coordinación apagada (no hay equipo en el test); lo
    // que no puede pasar es que pida crear un trabajo antes de despachar.
    expect(String(error)).not.toContain('adentro de un trabajo');
    expect(internalId(), 'el espacio interno se creó para la tarea').toBeTruthy();
    removeDir(folder);
  });

  it('el trabajo interno no aparece en ninguna lista que la persona mira', async () => {
    await b.service.buildBrandDna(brandId, 'sources', sources);
    const hidden = internalId()!;
    const campaign = await b.service.createWork(brandId, 'Campaña de invierno');

    // Barra lateral, contador TRABAJOS, "continuar donde lo dejaste",
    // Primeros pasos y el catálogo de Inicio: todos leen esta lista.
    expect((await b.service.listWorks(brandId)).map((work) => work.id)).toEqual([campaign.id]);

    // Inicio lee este estado para el contador, lo que está vivo y el dueño del
    // contexto de marca.
    const status = await b.service.brandContextStatus(brandId);
    expect(status.works.map((work) => work.id)).toEqual([campaign.id]);
    expect(status.ownerWorkId).toBe(campaign.id);

    // La tira de equipos activos y "desde tu última visita" leen ésta.
    b.repo.insertCoordinationRun({
      id: 'run_interna',
      workId: hidden,
      status: 'running',
      coordinatorMemberId: null,
      budgetJson: '{}',
      planJson: null,
      planApprovedAt: null,
      suspendReason: null,
      createdAt: b.repo.getBrand(brandId).createdAt,
      updatedAt: b.repo.getBrand(brandId).createdAt,
    });
    expect((await b.service.listActiveCoordinationRuns()).map((run) => run.workId)).not.toContain(hidden);

    // Sí es un trabajo de verdad para el equipo: carpeta propia y equipo.
    expect(fs.existsSync(b.files.workDir(brandId, hidden))).toBe(true);
    expect(await b.service.listWorks(brandId)).toHaveLength(1);
  });

  it('con sólo el espacio interno, Inicio sigue diciendo que no hay trabajos', async () => {
    await b.service.buildBrandDna(brandId, 'sources', sources);
    expect(await b.service.listWorks(brandId)).toEqual([]);
    const status = await b.service.brandContextStatus(brandId);
    expect(status.works).toEqual([]);
    expect(status.ownerWorkId).toBeNull();
  });

  it('los "trabajos recientes" que Latte junta para las ideas dejan afuera el interno', async () => {
    await restartWithAi();
    const campaign = await b.service.createWork(brandId, 'Campaña de invierno');
    // `existing` junta los insumos de las ideas ANTES de despachar: si el
    // despacho se cae, los archivos ya están escritos.
    await b.service.buildBrandDna(brandId, 'existing', null);
    const hidden = internalId()!;
    expect(hidden, 'el build de marca creó su espacio interno').toBeTruthy();

    const file = path.join(b.files.workDir(brandId, hidden), 'borradores', 'adn', 'fuentes', 'trabajos.md');
    expect(fs.existsSync(file), 'el build juntó sus insumos').toBe(true);
    const md = fs.readFileSync(file, 'utf8');
    expect(md).toContain(campaign.title);
    expect(md, 'el espacio interno no es un trabajo de la marca').not.toContain(b.repo.getWork(hidden).title);
  });
});
