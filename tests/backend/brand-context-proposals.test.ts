import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeBrandContext } from '../../shared/brandContext';
import { EMPTY_USAGE, type TeamMember } from '../../shared/contracts';
import { LIMITS } from '../../electron/services/validation';
import { brandContextProtocolBlocks, parseBrandContextJson } from '../../electron/workspace/brandContextProtocol';
import { BRAND_CONTEXT_DRAFT_PROMPT_ES } from '../../electron/workspace/brandContextProtocol';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';
import { startFakeOpenCode } from './fakeOpenCode';

const VALID = { text: 'Tono cercano, sin muletillas.', rationale: 'Sale del brief.', mode: 'replace' as const, clientRequestId: 'req_ctx_1' };

function fence(payload: unknown): string {
  return '```latte-brand-context\n' + JSON.stringify(payload) + '\n```';
}

describe('brand context protocol parser', () => {
  it('accepts a valid block inside surrounding text', () => {
    const blocks = brandContextProtocolBlocks(`Hola\n${fence(VALID)}\nchau`);
    expect(blocks).toEqual([VALID]);
  });

  it('rejects invalid JSON, unknown fields, bad mode and oversize text', () => {
    expect(brandContextProtocolBlocks('```latte-brand-context\nnot json\n```')).toEqual([]);
    expect(parseBrandContextJson(JSON.stringify({ ...VALID, extra: true }))).toBeNull();
    expect(parseBrandContextJson(JSON.stringify({ ...VALID, mode: 'merge' }))).toBeNull();
    expect(parseBrandContextJson(JSON.stringify({ ...VALID, text: 'A'.repeat(LIMITS.context + 1) }))).toBeNull();
    expect(parseBrandContextJson(JSON.stringify({ ...VALID, text: 'hola\u0007' }))).toBeNull();
  });

  it('extracts two blocks from one message', () => {
    const second = { ...VALID, text: 'Otra cosa', clientRequestId: 'req_ctx_2' };
    expect(brandContextProtocolBlocks(`${fence(VALID)}\n${fence(second)}`)).toHaveLength(2);
  });
});

describe('brand context proposals', () => {
  let b: TestBackend;
  let workId: string;
  let brandId: string;
  const chatId = 'ses_brand_ctx';

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    brandId = brand.id;
    workId = work.id;
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: chatId, workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
  });
  afterEach(() => b.cleanup());

  it('stores a pending proposal under suggest', async () => {
    const proposal = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    expect(proposal?.status).toBe('pending');
    expect((await b.service.listBrandContextProposals(brandId)).filter((p) => p.status === 'pending')).toHaveLength(1);
    expect((await b.service.listBrands())[0].context).toBe('');
  });

  it('approves replace, append, edited text and reject', async () => {
    const first = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    const approved = await b.service.approveBrandContextProposal(first!.id, null);
    expect(approved.status).toBe('approved');
    expect((await b.service.listBrands())[0].context).toBe(VALID.text);

    const append = await b.service.proposeBrandContextFromAgent(chatId, 'msg_2', {
      text: 'Audiencia: 25-40.', rationale: 'Del research.', mode: 'append', clientRequestId: 'req_ctx_append',
    });
    await b.service.approveBrandContextProposal(append!.id, null);
    const appended = composeBrandContext(VALID.text, 'Audiencia: 25-40.', 'append');
    expect((await b.service.listBrands())[0].context).toBe(appended);
    expect(appended).toBe(`${VALID.text}\n\nAudiencia: 25-40.`);

    const edited = await b.service.proposeBrandContextFromAgent(chatId, 'msg_3', {
      text: 'Descartable', rationale: 'x', mode: 'replace', clientRequestId: 'req_ctx_edit',
    });
    await b.service.approveBrandContextProposal(edited!.id, 'Texto editado por el humano.');
    expect((await b.service.listBrands())[0].context).toBe('Texto editado por el humano.');

    const rejected = await b.service.proposeBrandContextFromAgent(chatId, 'msg_4', {
      text: 'No', rationale: 'y', mode: 'replace', clientRequestId: 'req_ctx_rej',
    });
    expect((await b.service.rejectBrandContextProposal(rejected!.id)).status).toBe('rejected');
    expect((await b.service.listBrands())[0].context).toBe('Texto editado por el humano.');
  });

  it('dedupes by clientRequestId and fingerprint, and keeps one pending per brand', async () => {
    const first = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    const retry = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1b', VALID);
    expect(retry?.id).toBe(first?.id);
    const sameText = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1c', { ...VALID, clientRequestId: 'req_other' });
    expect(sameText?.id).toBe(first?.id);
    const replacement = await b.service.proposeBrandContextFromAgent(chatId, 'msg_2', {
      text: 'Otro contexto', rationale: 'Nuevo', mode: 'replace', clientRequestId: 'req_ctx_new',
    });
    expect(replacement?.id).not.toBe(first?.id);
    expect(replacement?.status).toBe('pending');
    const pending = (await b.service.listBrandContextProposals(brandId)).filter((p) => p.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(replacement!.id);
    expect((await b.service.listBrandContextProposals(brandId)).find((p) => p.id === first!.id)?.status).toBe('rejected');
  });

  it('honours decision authority off, suggest and auto-record', async () => {
    await b.service.setDecisionAuthority(workId, 'off');
    expect(await b.service.proposeBrandContextFromAgent(chatId, 'msg_off', { ...VALID, clientRequestId: 'req_off' })).toBeNull();

    await b.service.setDecisionAuthority(workId, 'suggest');
    const suggested = await b.service.proposeBrandContextFromAgent(chatId, 'msg_sug', { ...VALID, clientRequestId: 'req_sug' });
    expect(suggested?.status).toBe('pending');

    await b.service.setDecisionAuthority(workId, 'auto-record');
    const recorded = await b.service.proposeBrandContextFromAgent(chatId, 'msg_auto', {
      text: 'Contexto automático', rationale: 'ok', mode: 'replace', clientRequestId: 'req_auto',
    });
    expect(recorded?.status).toBe('approved');
    expect((await b.service.listBrands())[0].context).toBe('Contexto automático');
  });

  it('refuses archived brands', async () => {
    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    await b.service.archiveBrand(brandId);
    await expect(b.service.approveBrandContextProposal(pending!.id, null)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.rejectBrandContextProposal(pending!.id)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.proposeBrandContextFromAgent(chatId, 'msg_2', { ...VALID, clientRequestId: 'req_arch' })).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
    await expect(b.service.requestBrandContextDraft(workId)).rejects.toMatchObject({ code: 'BRAND_ARCHIVED' });
  });

  it('refreshes instructions only for works of the brand without live members', async () => {
    const other = await b.service.createWork(brandId, 'Otro');
    const write = vi.spyOn(b.files, 'writeInstructions');
    vi.spyOn(b.hub, 'liveMemberCount').mockImplementation((id) => (id === workId ? 1 : 0));
    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    write.mockClear();
    await b.service.approveBrandContextProposal(pending!.id, null);
    const refreshedWorks = write.mock.calls.map((call) => call[1]);
    expect(refreshedWorks).toContain(other.id);
    expect(refreshedWorks).not.toContain(workId);
  });

  it('rejects unknown fields at the service boundary', async () => {
    await expect(b.service.proposeBrandContextFromAgent(chatId, 'msg_x', { ...VALID, extra: 'no' })).rejects.toThrow(/Unknown/);
  });

  it('applies an append proposal only on pending → approved', async () => {
    await b.service.updateBrand(brandId, 'Base.');
    const append = await b.service.proposeBrandContextFromAgent(chatId, 'msg_dup', {
      text: 'Extra.', rationale: 'x', mode: 'append', clientRequestId: 'req_dup',
    });
    await b.service.approveBrandContextProposal(append!.id, null);
    const once = (await b.service.listBrands())[0].context;
    expect(once).toBe(composeBrandContext('Base.', 'Extra.', 'append'));
    const again = await b.service.approveBrandContextProposal(append!.id, null);
    expect(again.status).toBe('approved');
    expect((await b.service.listBrands())[0].context).toBe(once);
  });

  it('stores the proposing member role on the proposal source', async () => {
    const proposal = await b.service.proposeBrandContextFromAgent(chatId, 'msg_src', VALID);
    expect(proposal?.source).toMatchObject({ chatId, messageId: 'msg_src', memberId: chatId, roleId: 'strategist', runtime: 'codex' });
  });

  it('persists the same text the preview compose would show', async () => {
    await b.service.updateBrand(brandId, 'Actual.');
    const replace = await b.service.proposeBrandContextFromAgent(chatId, 'msg_prev_r', {
      text: 'Nuevo.', rationale: 'r', mode: 'replace', clientRequestId: 'req_prev_r',
    });
    await b.service.approveBrandContextProposal(replace!.id, null);
    expect((await b.service.listBrands())[0].context).toBe(composeBrandContext('Actual.', 'Nuevo.', 'replace'));

    const append = await b.service.proposeBrandContextFromAgent(chatId, 'msg_prev_a', {
      text: 'Más.', rationale: 'a', mode: 'append', clientRequestId: 'req_prev_a',
    });
    const current = (await b.service.listBrands())[0].context;
    await b.service.approveBrandContextProposal(append!.id, null);
    expect((await b.service.listBrands())[0].context).toBe(composeBrandContext(current, 'Más.', 'append'));
  });
});

describe('requestBrandContextDraft', () => {
  it('opens the strategist and sends the fixed prompt as the first message', async () => {
    const fake = await startFakeOpenCode();
    const b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0.0\n' })),
    });
    const send = vi.spyOn(b.hub, 'send');
    try {
      const brand = await b.service.createBrand('Marca');
      const work = await b.service.createWork(brand.id, 'Trabajo');
      const session = await b.service.requestBrandContextDraft(work.id);
      expect(session.roleId).toBe('strategist');
      expect(send).toHaveBeenCalledWith(session.id, BRAND_CONTEXT_DRAFT_PROMPT_ES);
    } finally {
      b.cleanup();
      await fake.close();
    }
  });

  it('throws MEMBER_BUSY and does not send when the only strategist is working', async () => {
    const b = await makeBackend();
    const send = vi.spyOn(b.hub, 'send');
    const open = vi.spyOn(b.hub, 'openMember');
    try {
      const brand = await b.service.createBrand('Marca');
      const work = await b.service.createWork(brand.id, 'Trabajo');
      const at = new Date().toISOString();
      const busy: TeamMember = {
        id: 'mem_busy', workId: work.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
        runtime: 'opencode', model: null, accountId: null, label: 'OpenCode', status: 'working',
        tier: 'balanced', usage: EMPTY_USAGE, continuedFrom: null, createdAt: at, updatedAt: at,
      };
      vi.spyOn(b.hub, 'listTeam').mockReturnValue([busy]);
      await expect(b.service.requestBrandContextDraft(work.id)).rejects.toMatchObject({ code: 'MEMBER_BUSY' });
      expect(send).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      b.cleanup();
    }
  });
});
