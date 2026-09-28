import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ARITY, API_METHODS } from '../../electron/ipc/channels';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { brandDnaProtocolBlocks, parseBrandDnaJson, type BrandDnaProposalInput } from '../../electron/workspace/dnaProtocol';
import type { BrandDnaField, BrandDnaValue, BrandDnaFields, BrandDnaProposal, BrandDnaView } from '../../shared/contracts';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * 1B: EL ADN ES UN MOTOR CON PROCEDENCIA, NO UN FORMULARIO.
 *
 * Cada dato dice de dónde salió: quien edita a mano deja fuente `human` y
 * `assumption: false`, el agente sólo propone (bloque `latte-dna`) y la
 * persona acepta o rechaza, y aprobar publica una versión que viaja a cada
 * trabajo en `identidad/ADN.md`. Nunca se inventa un dato: lo inferido sin
 * fuente firme queda marcado como supuesto.
 */

type DnaJson = Record<string, unknown>;

const VALID: BrandDnaProposalInput = {
  field: 'wordsNo',
  next: ['oferta', 'barato'],
  reason: 'La persona aclaró que la marca nunca dice esas palabras.',
  source: { kind: 'correction', label: 'Corrección en el chat' },
  clientRequestId: 'req_dna_1',
};

/** La misma propuesta, como objeto flojo para parchearla en los casos inválidos. */
const jsonOf = (value: BrandDnaProposalInput): DnaJson => JSON.parse(JSON.stringify(value)) as DnaJson;

function fence(payload: unknown, language = 'latte-dna'): string {
  return '```' + language + '\n' + JSON.stringify(payload) + '\n```';
}

describe('ADN de marca · protocolo latte-dna', () => {
  it('acepta un bloque válido dentro de texto común', () => {
    expect(brandDnaProtocolBlocks(`Hola\n${fence(VALID)}\nchau`)).toEqual([VALID]);
  });

  it('JSON roto, campo desconocido o forma inválida es inerte', () => {
    expect(brandDnaProtocolBlocks('```latte-dna\nnot json\n```')).toEqual([]);
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), field: 'tono' }))).toBeNull();
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), extra: true }))).toBeNull();
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), source: { kind: 'guess', label: 'x' } }))).toBeNull();
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), next: 'oferta' }))).toBeNull();
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), reason: 'x'.repeat(10_000) }))).toBeNull();
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), clientRequestId: 'mal id!' }))).toBeNull();
  });

  it('recorta reason y saca los bloques de una continuación', () => {
    expect(parseBrandDnaJson(JSON.stringify({ ...jsonOf(VALID), reason: '  Porque sí  \n' }))).toMatchObject({ reason: 'Porque sí' });
    const second = { ...jsonOf(VALID), field: 'audience', next: 'Pymes', clientRequestId: 'req_dna_2' };
    expect(brandDnaProtocolBlocks(`${fence(VALID)}\n${fence(second)}`)).toHaveLength(2);
  });
});

describe('ADN de marca · borrador, versión y propuestas', () => {
  let b: TestBackend;
  let brandId: string;
  let workId: string;
  const chatId = 'ses_dna';

  const workDir = (id = workId) => b.files.workDir(brandId, id);
  const claudeMd = (id = workId) => fs.readFileSync(path.join(workDir(id), 'CLAUDE.md'), 'utf8');
  const adnMd = (id = workId) => fs.readFileSync(path.join(workDir(id), 'identidad', 'ADN.md'), 'utf8');
  /** `value` es el valor CRUDO (`BrandDnaValue`); los tests mandan formas inválidas a propósito, por eso `unknown`. */
  const update = (field: BrandDnaField, value: unknown): Promise<BrandDnaView> =>
    b.service.updateBrandDnaField(brandId, field, value as BrandDnaValue | null);

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Ayulem');
    brandId = brand.id;
    const work = await b.service.createWork(brand.id, 'Propuesta mayorista');
    workId = work.id;
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: chatId, workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('los siete métodos existen en la superficie IPC con su aridad', () => {
    for (const [method, arity] of [
      ['readBrandDna', 1], ['updateBrandDnaField', 3], ['approveBrandDna', 1],
      ['buildBrandDna', 3], ['readBrandDnaBuildJob', 1], ['cancelBrandDnaBuild', 1],
      ['resolveBrandDnaProposal', 3],
    ] as const) {
      expect(API_METHODS).toContain(method);
      expect(API_ARITY[method]).toBe(arity);
    }
  });

  it('una marca nueva no tiene ADN, y una marca inexistente no existe', async () => {
    const view = await b.service.readBrandDna(brandId);
    expect(view).toEqual({ brandId, draft: null, approved: null, changedSinceApproval: false, proposals: [] });
    await expect(b.service.readBrandDna('brd_missing_brand_xx')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Sin ADN aprobado las instrucciones lo dicen y no apuntan al archivo.
    expect(claudeMd()).toContain('No approved Brand DNA');
    expect(claudeMd()).not.toContain('./identidad/ADN.md');
    expect(fs.existsSync(path.join(workDir(), 'identidad', 'ADN.md'))).toBe(false);
  });

  it('editar un campo deja fuente humana, sin supuesto, y persiste en el borrador', async () => {
    const view = await update('audience', 'Mayoristas que compran por volumen.');
    expect(view.draft!.audience!.value).toBe('Mayoristas que compran por volumen.');
    expect(view.draft!.audience!.assumption).toBe(false);
    expect(view.draft!.audience!.sources).toHaveLength(1);
    expect(view.draft!.audience!.sources[0]!.kind).toBe('human');
    expect(view.draft!.tone).toBeNull();
    expect(view.changedSinceApproval).toBe(true);
    expect(view.approved).toBeNull();
    expect(view.proposals).toEqual([]);

    await update('colors', [{ hex: '#a77b38', name: 'dorado' }]);
    const again = await b.service.readBrandDna(brandId);
    expect(again.draft!.colors!.value).toEqual([{ hex: '#a77b38', name: 'dorado' }]);
    expect(b.repo.getDnaDraft(brandId)!.audience!.value).toBe('Mayoristas que compran por volumen.');
  });

  it('la forma de cada campo se valida sin pitos ni flautas', async () => {
    const bad: Array<[string, unknown]> = [
      ['tono', 'cercano'],
      ['audience', 42],
      ['audience', ''],
      ['wordsNo', 'oferta'],
      ['wordsNo', ['']],
      ['colors', [{ hex: 'rojo', name: null }]],
      ['colors', [{ hex: '#a77b38', name: 3 }]],
      ['tone', { adjectives: ['cercano'] }],
      ['tone', { adjectives: 'cercano', example: null }],
      ['claims', [{ claim: 'x' }]],
    ];
    for (const [field, value] of bad) {
      await expect(b.service.updateBrandDnaField(brandId, field as never, value as never),
        `${field} → ${JSON.stringify(value)}`).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(b.service.updateBrandDnaField(brandId, 'noExiste' as never, 'x' as never)).rejects.toMatchObject({ code: 'VALIDATION' });
    const view = await b.service.readBrandDna(brandId);
    expect(view.draft).toBeNull();
  });

  it('aprobar publica la versión 1, la proyecta a cada trabajo y actualiza al cambiar de versión', async () => {
    await update('valueProp', 'Volumen sin intermediarios.');
    const first = await b.service.approveBrandDna(brandId);
    expect(first.approved!.version).toBe(1);
    expect(first.approved!.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.changedSinceApproval).toBe(false);
    expect(first.draft).not.toBeNull();

    const md = adnMd();
    expect(md).toContain('version 1');
    expect(md).toContain('Volumen sin intermediarios.');
    expect(md).toContain('assumption');
    expect(claudeMd()).toContain('./identidad/ADN.md');
    expect(claudeMd()).toContain('Brand DNA');

    const second = await b.service.createWork(brandId, 'Otro trabajo');
    expect(fs.existsSync(path.join(workDir(second.id), 'identidad', 'ADN.md'))).toBe(true);
    expect(claudeMd(second.id)).toContain('./identidad/ADN.md');

    await update('wordsYes', ['mayorista']);
    expect((await b.service.readBrandDna(brandId)).changedSinceApproval).toBe(true);
    const next = await b.service.approveBrandDna(brandId);
    expect(next.approved!.version).toBe(2);
    expect(next.changedSinceApproval).toBe(false);
    expect(adnMd()).toContain('version 2');
    expect(adnMd()).not.toContain('version 1');
  });

  it('aprobar sin borrador no se puede', async () => {
    await expect(b.service.approveBrandDna(brandId)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(b.service.approveBrandDna('brd_missing_brand_xx')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('una marca archivada se lee pero no se edita', async () => {
    await update('audience', 'Pymes');
    await b.service.archiveBrand(brandId);
    expect((await b.service.readBrandDna(brandId)).draft).not.toBeNull();
    await expect(update('audience', 'Otros')).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.approveBrandDna(brandId)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.resolveBrandDnaProposal(brandId, 'bdp_missing_xx', true)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
  });

  it('una propuesta de agente queda pendiente; aceptar la pone en el borrador con su fuente', async () => {
    const proposal = (await b.service.proposeBrandDnaFromAgent(chatId, 'msg_1', VALID)) as BrandDnaProposal;
    expect(proposal.field).toBe('wordsNo');
    expect(proposal.source).toEqual({ kind: 'correction', label: 'Corrección en el chat' });
    const pending = await b.service.readBrandDna(brandId);
    expect(pending.proposals.map((p) => p.id)).toEqual([proposal.id]);
    expect(pending.draft).toBeNull();

    const accepted = await b.service.resolveBrandDnaProposal(brandId, proposal.id, true);
    expect(accepted.proposals).toEqual([]);
    expect(accepted.draft!.wordsNo).toEqual({
      value: ['oferta', 'barato'],
      sources: [{ kind: 'correction', label: 'Corrección en el chat' }],
      assumption: false,
    });
    expect(accepted.changedSinceApproval).toBe(true);
    expect(b.repo.getDnaDraft(brandId)!.wordsNo!.value).toEqual(['oferta', 'barato']);

    await expect(b.service.resolveBrandDnaProposal(brandId, proposal.id, true)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(b.service.resolveBrandDnaProposal(brandId, 'bdp_missing_xx', false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rechazar no toca el borrador y una propuesta del mismo campo reemplaza a la anterior', async () => {
    const first = await b.service.proposeBrandDnaFromAgent(chatId, 'msg_1', VALID);
    const second = await b.service.proposeBrandDnaFromAgent(chatId, 'msg_2', {
      ...VALID, next: ['rebaja'], reason: 'Otra corrección del mismo campo.', clientRequestId: 'req_dna_2',
    });
    const view = await b.service.readBrandDna(brandId);
    expect(view.proposals.map((p) => p.id)).toEqual([second!.id]);

    const rejected = await b.service.resolveBrandDnaProposal(brandId, second!.id, false);
    expect(rejected.proposals).toEqual([]);
    expect(rejected.draft).toBeNull();
    // La primera quedó supersedeada: ya no es pendiente, no se puede resolver.
    await expect(b.service.resolveBrandDnaProposal(brandId, first!.id, true)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await b.service.readBrandDna(brandId)).proposals).toEqual([]);
  });

  it('la misma propuesta repetida (mismo clientRequestId) no se duplica', async () => {
    const first = await b.service.proposeBrandDnaFromAgent(chatId, 'msg_1', VALID);
    const again = await b.service.proposeBrandDnaFromAgent(chatId, 'msg_2', VALID);
    expect(again!.id).toBe(first!.id);
    expect((await b.service.readBrandDna(brandId)).proposals).toHaveLength(1);
  });

  it('la forma de la propuesta se valida estrictamente', async () => {
    const bad: DnaJson[] = [
      { ...jsonOf(VALID), field: 'noExiste' },
      { ...jsonOf(VALID), extra: 1 },
      { ...jsonOf(VALID), next: 'oferta' },
      { ...jsonOf(VALID), next: [''] },
      { ...jsonOf(VALID), source: { kind: 'memory', label: 'memoria' } },
      { ...jsonOf(VALID), source: { kind: 'correction', label: '' } },
      { ...jsonOf(VALID), reason: '' },
      { ...jsonOf(VALID), clientRequestId: 'mal id' },
    ];
    for (const input of bad) {
      await expect(b.service.proposeBrandDnaFromAgent(chatId, 'msg_x', input as never),
        JSON.stringify(input)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect((await b.service.readBrandDna(brandId)).proposals).toEqual([]);
    await expect(b.service.proposeBrandDnaFromAgent('ses_que_no_existe', 'msg_1', VALID)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('el ADN aprobado viaja a cada trabajo en identidad/ADN.md con la versión y la procedencia', async () => {
    await update('wordsNo', ['oferta']);
    await update('tone', { adjectives: ['cercano', 'directo'], example: 'Escribís como hablás.' });
    await b.service.approveBrandDna(brandId);
    const md = adnMd();
    expect(md).toContain('# Brand DNA');
    expect(md).toContain('Ayulem');
    expect(md).toContain('version 1');
    expect(md).toContain('oferta');
    expect(md).toContain('cercano');
    expect(md).toContain('edición manual');
    expect(md).toContain('assumption: no');
    expect(md).not.toContain(workDir());
  });
});

describe('ADN de marca · la evidencia de una entrega registra la versión vigente', () => {
  it('delivery_evidence guarda la versión del ADN aprobado junto al recibo', async () => {
    const b = await makeBackend();
    try {
      const brand = await b.service.createBrand('Ayulem');
      const work = await b.service.createWork(brand.id, 'Propuesta');
      await b.service.updateBrandDnaField(brand.id, 'audience', 'Mayoristas' as never);
      await b.service.approveBrandDna(brand.id);
      await b.service.setCoordinationBudget(work.id, { maxDispatches: 20, maxConcurrent: 3 });
      await b.service.setCoordinationAuthority(work.id, 'auto');
      b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
      b.repo.setMeta('coordination_coordinator:' + work.id, 'mem_coordinator');
      const members: FakeTeamMember[] = [];
      fakeCoordinationHub(b, members);
      members.push({ id: 'mem_coordinator', workId: work.id, roleId: 'strategist', status: 'idle' });
      members.push({ id: 'mem_writer', workId: work.id, roleId: 'writer', status: 'idle' });
      await b.service.startCoordinationRun(work.id);
      const run = b.repo.findActiveCoordinationRun(work.id)!;
      b.repo.setMeta('coordination_approved_roles:' + run.id, JSON.stringify(['writer']));
      const mcp = async (name: string, args: unknown, memberId: string): Promise<{ ok: boolean; data: unknown }> => {
        const token = b.coordinationTokens.mint(work.id, memberId);
        const result = await b.coordinationMcpServer.handleMcpRequest(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), `Bearer ${token}`, '127.0.0.1');
        return (JSON.parse(result.body) as { result: { structuredContent: { ok: boolean; data: unknown } } }).result.structuredContent;
      };
      const created = await mcp('latte_task_create', { roleId: 'writer', title: 'Propuesta', spec: 'La propuesta.', audience: 'client' }, 'mem_coordinator');
      const taskId = (created.data as { taskId: string }).taskId;
      await mcp('latte_dispatch', { taskId }, 'mem_coordinator');
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
      const evidence = b.repo.listDeliveryEvidence(receipts[0]!.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.dnaVersion).toBe(1);
    } finally {
      vi.restoreAllMocks();
      b.cleanup();
    }
  });
});
