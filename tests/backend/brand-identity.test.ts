import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { API_ARITY, API_METHODS, channelFor, type IpcEnvelope } from '../../electron/ipc/channels';
import { registerIpc } from '../../electron/ipc/register';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import type { BrandIdentityExtractionResult, BrandIdentityView } from '../../shared/contracts';
import { fakeCoordinationHub, makeBackend, makeTempDir, removeDir, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * E4: LA IDENTIDAD ES UN RECURSO CON REGLAS Y EVIDENCIA, NO UNA PLANTILLA.
 *
 * El caso real: `brand_kit_heads` vacía —ningún kit cargado, de ninguna
 * marca—, los manuales de Ayulem como PDFs sueltos en un trabajo, y un kit en
 * The Agentcy con un acento (#a33434) que no es el dorado de los manuales
 * (#a77b38). Latte no renderiza ni impone plantilla: guarda los archivos en el
 * kit de la marca, el equipo extrae `IDENTIDAD.md` (y pregunta cuando dos
 * fuentes chocan), la persona aprueba, cada trabajo recibe la identidad en
 * `identidad/`, y el revisor que dice `pass` deja evidencia con el hash del kit.
 *
 * Todo por la capa real: los canales IPC registrados sobre el servicio, el
 * servidor MCP para los reportes y archivos de verdad en disco.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const COORDINATOR = 'mem_coordinator';
interface Envelope { ok: boolean; data: unknown; error?: { code: string; message: string } }

describe('E4: Marca → Identidad, por IPC', () => {
  let b: TestBackend;
  let sources: string;
  let chosen: string[];
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let brandId: string;
  let workId: string;

  /** Los canales de verdad, registrados sobre el servicio de verdad. */
  let call: <T>(method: (typeof API_METHODS)[number], ...args: unknown[]) => Promise<IpcEnvelope<T>>;
  const ok = async <T>(method: (typeof API_METHODS)[number], ...args: unknown[]): Promise<T> => {
    const envelope = await call<T>(method, ...args);
    if (!envelope.ok) throw new Error(`${method}: ${JSON.stringify(envelope)}`);
    return envelope.value;
  };
  const mcp = async (name: string, args: unknown, memberId: string): Promise<Envelope> => {
    const token = b.coordinationTokens.mint(workId, memberId);
    const result = await b.coordinationMcpServer.handleMcpRequest(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
    return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
  };
  const workDir = (id = workId) => b.files.workDir(brandId, id);
  const claudeMd = (id = workId) => fs.readFileSync(path.join(workDir(id), 'CLAUDE.md'), 'utf8');

  beforeEach(async () => {
    sources = makeTempDir('latte-identity-sources-');
    fs.writeFileSync(path.join(sources, 'Manual_Logo_AYULEM-V1.pdf'), '%PDF-1.4 manual del logo');
    fs.writeFileSync(path.join(sources, 'Ayulem mayoristas (1).pdf'), '%PDF-1.4 manual mayorista');
    fs.writeFileSync(path.join(sources, 'logo ayulem.png'), PNG);
    chosen = [];
    b = await makeBackend({ chooseFiles: async () => chosen });
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcEnvelope<unknown>>>();
    registerIpc({
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as never); }, removeHandler: () => undefined },
      api: b.service,
      isTrustedSender: () => true,
      log: () => undefined,
    });
    const event = { sender: { id: 1 } as WebContents } as IpcMainInvokeEvent;
    call = (method, ...args) => handlers.get(channelFor(method))!(event, ...args) as never;
    const brand = await b.service.createBrand('Ayulem');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    b.repo.setMeta('coordination_coordinator:' + workId, COORDINATOR);
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); removeDir(sources); });

  it('los seis métodos existen en la superficie IPC con su aridad', () => {
    for (const [method, arity] of [
      ['readBrandIdentity', 1], ['addBrandIdentityFiles', 1], ['removeBrandIdentityFile', 2],
      ['approveBrandIdentity', 1], ['revokeBrandIdentity', 1], ['requestBrandIdentityExtraction', 1],
    ] as const) {
      expect(API_METHODS).toContain(method);
      expect(API_ARITY[method]).toBe(arity);
    }
  });

  it('una marca sin nada: vacía, y las instrucciones dicen explicit-neutral', async () => {
    const view = await ok<BrandIdentityView>('readBrandIdentity', brandId);
    expect(view.state).toBe('empty');
    expect(view.files).toEqual([]);
    expect(claudeMd()).toContain('No approved brand identity: explicit-neutral');
    expect(claudeMd()).not.toContain('./identidad/IDENTIDAD.md');
  });

  it('importar archivos los deja en el borrador, con su nombre y sin rutas', async () => {
    chosen = fs.readdirSync(sources).map((name) => path.join(sources, name));
    const view = await ok<BrandIdentityView>('addBrandIdentityFiles', brandId);
    expect(view.state).toBe('draft');
    expect(view.files.map((f) => f.name).sort()).toEqual(['Ayulem mayoristas (1).pdf', 'Manual_Logo_AYULEM-V1.pdf', 'logo ayulem.png']);
    expect(view.files.find((f) => f.name === 'logo ayulem.png')!.kind).toBe('logo');
    expect(view.files.every((f) => f.usable)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(sources);
    expect(JSON.stringify(view)).not.toMatch(/[\\/]assets[\\/]/);
    // Nada aprobado todavía: la marca sigue neutral.
    expect(b.repo.branding.headForBrand(brandId)).toBeUndefined();
    // Y se puede sacar uno.
    const pdf = view.files.find((f) => f.name === 'Ayulem mayoristas (1).pdf')!;
    const after = await ok<BrandIdentityView>('removeBrandIdentityFile', brandId, pdf.id);
    expect(after.files.map((f) => f.name)).not.toContain('Ayulem mayoristas (1).pdf');
  });

  it('"Extraer identidad con el equipo" despacha una tarea interna que produce IDENTIDAD.md, y el reporte lo suma al kit', async () => {
    chosen = fs.readdirSync(sources).map((name) => path.join(sources, name));
    await ok('addBrandIdentityFiles', brandId);
    const result = await ok<BrandIdentityExtractionResult>('requestBrandIdentityExtraction', brandId);
    // Sin equipo corriendo: nace una propuesta de una tarea, que la persona aprueba en el chat.
    expect(result.outcome).toBe('proposed');
    expect(result.workId).toBe(workId);
    // Las fuentes quedan adentro del trabajo, donde el agente puede leerlas.
    expect(fs.readdirSync(path.join(workDir(), 'borradores', 'identidad', 'fuentes')).sort())
      .toEqual(['Ayulem mayoristas (1).pdf', 'Manual_Logo_AYULEM-V1.pdf', 'logo ayulem.png']);
    const runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    const [task] = b.repo.listCoordinationTasks(runId);
    expect(task!.audience).toBe('internal');
    expect(task!.spec).toContain('borradores/identidad/IDENTIDAD.md');
    expect(task!.spec).toMatch(/hex/);
    expect(task!.spec).toMatch(/latte_ask/);
    const worker = members.find((m) => m.id !== COORDINATOR)!;
    expect(send.mock.calls.some((c) => c[0] === worker.id)).toBe(true);
    // El agente escribe el documento y reporta con su ruta.
    fs.writeFileSync(path.join(workDir(), 'borradores', 'identidad', 'IDENTIDAD.md'), '# Identidad de Ayulem\n\n- Dorado #a77b38 (Manual_Logo_AYULEM-V1.pdf, p. 4)\n');
    expect((await mcp('latte_report', { taskId: task!.id, outcome: 'succeeded', summary: 'IDENTIDAD.md listo.', files: ['borradores/identidad/IDENTIDAD.md'] }, worker.id)).ok).toBe(true);
    const view = await ok<BrandIdentityView>('readBrandIdentity', brandId);
    expect(view.hasIdentityDoc).toBe(true);
    expect(view.files.find((f) => f.identityDoc)!.name).toBe('IDENTIDAD.md');
    expect(view.state).toBe('draft');
  });

  it('aprobar publica el kit, lo proyecta a cada trabajo en identidad/ y cambia las instrucciones; un trabajo nuevo lo recibe solo', async () => {
    // Sin nadie adentro: las instrucciones de un trabajo con una conversación
    // viva no se reescriben debajo de ella (la carpeta identidad/ sí llega).
    members.length = 0;
    chosen = [path.join(sources, 'logo ayulem.png')];
    await ok('addBrandIdentityFiles', brandId);
    fs.writeFileSync(path.join(sources, 'IDENTIDAD.md'), '# Identidad\n');
    chosen = [path.join(sources, 'IDENTIDAD.md')];
    await ok('addBrandIdentityFiles', brandId);
    const approved = await ok<BrandIdentityView>('approveBrandIdentity', brandId);
    expect(approved.state).toBe('approved');
    expect(approved.approved!.version).toBe(1);
    expect(approved.changedSinceApproval).toBe(false);
    expect(b.repo.branding.headForBrand(brandId)).toBeDefined();
    expect(fs.readdirSync(path.join(workDir(), 'identidad')).filter((n) => !n.startsWith('.')).sort()).toEqual(['IDENTIDAD.md', 'logo-ayulem.png']);
    const text = claudeMd();
    expect(text).toContain('./identidad/IDENTIDAD.md');
    expect(text).toContain('Client deliverables apply it');
    expect(text).not.toContain('No approved brand identity');
    const second = await b.service.createWork(brandId, 'Otro trabajo');
    expect(fs.existsSync(path.join(workDir(second.id), 'identidad', 'IDENTIDAD.md'))).toBe(true);
    expect(claudeMd(second.id)).toContain('./identidad/IDENTIDAD.md');
  });

  it('revocar vuelve a neutral y saca la identidad de los trabajos; re-aprobar publica una versión nueva', async () => {
    members.length = 0;
    chosen = [path.join(sources, 'logo ayulem.png')];
    await ok('addBrandIdentityFiles', brandId);
    await ok('approveBrandIdentity', brandId);
    const revoked = await ok<BrandIdentityView>('revokeBrandIdentity', brandId);
    expect(revoked.state).toBe('revoked');
    expect(fs.existsSync(path.join(workDir(), 'identidad'))).toBe(false);
    expect(claudeMd()).toContain('No approved brand identity: explicit-neutral');
    const again = await ok<BrandIdentityView>('approveBrandIdentity', brandId);
    expect(again.state).toBe('approved');
    expect(again.approved!.version).toBe(2);
  });

  it('aprobar sin archivos no se puede', async () => {
    const refused = await call('approveBrandIdentity', brandId);
    expect(refused.ok).toBe(false);
  });
});

describe('E4: el pass del revisor deja evidencia con el hash del kit', () => {
  it('delivery_evidence: el archivo publicado y el kit que tenía el trabajo', async () => {
    const sources = makeTempDir('latte-identity-sources-');
    fs.writeFileSync(path.join(sources, 'logo.png'), PNG);
    const b = await makeBackend({ chooseFiles: async () => [path.join(sources, 'logo.png')] });
    try {
      const brand = await b.service.createBrand('Ayulem');
      const work = await b.service.createWork(brand.id, 'Propuesta');
      await b.service.addBrandIdentityFiles(brand.id);
      await b.service.approveBrandIdentity(brand.id);
      const kitHash = b.repo.branding.approvedKitForBrand(brand.id)!.ref.hash;
      await b.service.setCoordinationBudget(work.id, { maxDispatches: 20, maxConcurrent: 3 });
      await b.service.setCoordinationAuthority(work.id, 'auto');
      b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
      b.repo.setMeta('coordination_coordinator:' + work.id, COORDINATOR);
      const members: FakeTeamMember[] = [];
      fakeCoordinationHub(b, members);
      members.push({ id: COORDINATOR, workId: work.id, roleId: 'strategist', status: 'idle' });
      members.push({ id: 'mem_writer', workId: work.id, roleId: 'writer', status: 'idle' });
      await b.service.startCoordinationRun(work.id);
      const run = b.repo.findActiveCoordinationRun(work.id)!;
      b.repo.setMeta('coordination_approved_roles:' + run.id, JSON.stringify(['writer']));
      const mcp = async (name: string, args: unknown, memberId: string): Promise<Envelope> => {
        const token = b.coordinationTokens.mint(work.id, memberId);
        const result = await b.coordinationMcpServer.handleMcpRequest(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
        return (JSON.parse(result.body) as { result: { structuredContent: Envelope } }).result.structuredContent;
      };
      const created = await mcp('latte_task_create', { roleId: 'writer', title: 'Propuesta', spec: 'La propuesta.', audience: 'client' }, COORDINATOR);
      const taskId = (created.data as { taskId: string }).taskId;
      await mcp('latte_dispatch', { taskId }, COORDINATOR);
      const dir = b.files.workDir(brand.id, work.id);
      fs.mkdirSync(path.join(dir, 'borradores'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'borradores', 'propuesta.pdf'), '%PDF-1.4');
      await mcp('latte_report', { taskId, outcome: 'succeeded', summary: 'Lista.', files: ['borradores/propuesta.pdf'] }, 'mem_writer');
      await settle();
      const review = b.repo.listCoordinationTasks(run.id).find((t) => t.roleId === 'reviewer')!;
      const reviewer = members.find((m) => m.roleId === 'reviewer')!;
      expect((await mcp('latte_report', { taskId: review.id, outcome: 'succeeded', verdict: 'pass', summary: 'Lista.' }, reviewer.id)).ok).toBe(true);
      const receipts = b.repo.listGenerationsForWork(work.id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.context.brandContext!.hash).toBe(kitHash);
      const evidence = b.repo.listDeliveryEvidence(receipts[0]!.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.filesWritten).toEqual(['entregables/propuesta.pdf']);
      expect(evidence[0]!.chatId).toBe(reviewer.id);
    } finally {
      vi.restoreAllMocks();
      b.cleanup();
      removeDir(sources);
    }
  });
});
