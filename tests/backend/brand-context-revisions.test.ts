import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandContextFingerprint } from '../../electron/workspace/brandContextProtocol';
import { makeBackend, type TestBackend } from './helpers';

/**
 * The P2 integrity tier: `brands.context` has a history, and no write is allowed
 * to silently overwrite a change made underneath.
 *
 * The bug it closes: three works of one brand kept asking the same brand
 * questions, a human pasted a context, and a later save (or a clear) could wipe
 * it with nothing to go back to and nothing telling them what happened.
 */

const VALID = { text: 'Tono cercano, sin muletillas.', rationale: 'Del brief.', mode: 'replace' as const, clientRequestId: 'req_rev_1' };

describe('brand context history', () => {
  let b: TestBackend;
  let brandId: string;
  let workId: string;
  const chatId = 'ses_revisions';

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    workId = (await b.service.createWork(brandId, 'Trabajo')).id;
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: chatId, workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
  });
  afterEach(() => b.cleanup());

  it('records a revision with source, origin, timestamp and fingerprint on a manual save', async () => {
    const before = brandContextFingerprint('');
    const result = await b.service.saveBrandContext(brandId, 'Tono cercano', before);

    expect(result.brand.context).toBe('Tono cercano');
    const revisions = await b.service.listBrandContextRevisions(brandId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      brandId,
      source: 'human',
      origin: null,
      content: 'Tono cercano',
      fingerprint: brandContextFingerprint('Tono cercano'),
    });
    expect(revisions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists the history newest first', async () => {
    await b.service.saveBrandContext(brandId, 'Primero', null);
    await b.service.saveBrandContext(brandId, 'Segundo', null);
    await b.service.saveBrandContext(brandId, 'Tercero', null);

    expect((await b.service.listBrandContextRevisions(brandId)).map((r) => r.content)).toEqual(['Tercero', 'Segundo', 'Primero']);
  });

  it('back-fills the previous value on the first change so a wipe is recoverable', async () => {
    // A database from before the history existed: the context was written by
    // the raw primitive, so no revision records it yet.
    b.repo.updateBrandContext(brandId, 'Contexto original');
    expect(await b.service.listBrandContextRevisions(brandId)).toEqual([]);

    await b.service.saveBrandContext(brandId, 'Contexto nuevo', null);

    expect((await b.service.listBrandContextRevisions(brandId)).map((r) => r.content)).toEqual(['Contexto nuevo', 'Contexto original']);
  });

  it('recovers a wiped context from the history', async () => {
    await b.service.saveBrandContext(brandId, 'No perder esto', null);
    await b.service.clearBrandContext(brandId, null);
    expect((await b.service.getBrand(brandId)).context).toBe('');

    const original = (await b.service.listBrandContextRevisions(brandId)).find((r) => r.content === 'No perder esto')!;
    const restored = await b.service.restoreBrandContextRevision(brandId, original.id, null);

    expect(restored.brand.context).toBe('No perder esto');
  });

  it('records a restore as a new revision that points at the one it came from', async () => {
    await b.service.saveBrandContext(brandId, 'Primero', null);
    await b.service.saveBrandContext(brandId, 'Segundo', null);
    const first = (await b.service.listBrandContextRevisions(brandId)).find((r) => r.content === 'Primero')!;

    await b.service.restoreBrandContextRevision(brandId, first.id, null);

    const revisions = await b.service.listBrandContextRevisions(brandId);
    expect(revisions.map((r) => r.content)).toEqual(['Primero', 'Segundo', 'Primero']);
    expect(revisions[0]).toMatchObject({ source: 'restore', origin: first.id });
    // The restore is itself reversible: the value it replaced is still there.
    expect(revisions.some((r) => r.content === 'Segundo')).toBe(true);
  });

  it('records an approval as a proposal revision with the proposal as its origin', async () => {
    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    await b.service.approveBrandContextProposal(pending!.id, null);

    const [revision] = await b.service.listBrandContextRevisions(brandId);
    expect(revision).toMatchObject({ source: 'proposal', origin: pending!.id, content: VALID.text });
  });

  it('records the raw updateBrand write too, so the QA path is not a blind spot', async () => {
    await b.service.updateBrand(brandId, 'Escrito por el primitivo');
    const [revision] = await b.service.listBrandContextRevisions(brandId);
    expect(revision).toMatchObject({ source: 'human', content: 'Escrito por el primitivo' });
  });

  it('refuses a revision of another brand', async () => {
    const other = await b.service.createBrand('Otra');
    await b.service.saveBrandContext(other.id, 'De otra marca', null);
    const foreign = (await b.service.listBrandContextRevisions(other.id))[0];

    await expect(b.service.restoreBrandContextRevision(brandId, foreign.id, null)).rejects.toThrow(/another brand/);
  });

  it('records nothing when the value did not change', async () => {
    await b.service.saveBrandContext(brandId, 'Igual', null);
    await b.service.restoreBrandContextRevision(brandId, (await b.service.listBrandContextRevisions(brandId))[0].id, null);

    expect((await b.service.listBrandContextRevisions(brandId)).map((r) => r.content)).toEqual(['Igual']);
  });
});

describe('brand context conflict checks', () => {
  let b: TestBackend;
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Marca')).id;
  });
  afterEach(() => b.cleanup());

  it('refuses a save whose fingerprint is stale and keeps the persisted value', async () => {
    await b.service.saveBrandContext(brandId, 'Lo que hay', null);
    const loaded = brandContextFingerprint('Lo que hay');
    // Something else changed the context underneath the editor.
    await b.service.saveBrandContext(brandId, 'Cambiado por otro', null);

    await expect(b.service.saveBrandContext(brandId, 'Mi borrador', loaded)).rejects.toThrow(/changed since it was loaded/);
    expect((await b.service.getBrand(brandId)).context).toBe('Cambiado por otro');
  });

  it('accepts a save whose fingerprint still matches, and a null fingerprint', async () => {
    await b.service.saveBrandContext(brandId, 'Base', null);
    const loaded = brandContextFingerprint('Base');

    expect((await b.service.saveBrandContext(brandId, 'Mismo carril', loaded)).brand.context).toBe('Mismo carril');
    // Null means the editor had nothing to compare against yet.
    expect((await b.service.saveBrandContext(brandId, 'Sin base', null)).brand.context).toBe('Sin base');
  });

  it('refuses an empty save with CONTEXT_EMPTY and never wipes the context', async () => {
    await b.service.saveBrandContext(brandId, 'No se toca', null);

    await expect(b.service.saveBrandContext(brandId, '   ', null)).rejects.toMatchObject({ code: 'CONTEXT_EMPTY' });
    expect((await b.service.getBrand(brandId)).context).toBe('No se toca');
    expect(await b.service.listBrandContextRevisions(brandId)).toHaveLength(1);
  });

  it('clears only on purpose, records it, and refuses a stale fingerprint', async () => {
    await b.service.saveBrandContext(brandId, 'A vaciar', null);
    const stale = brandContextFingerprint('Otro valor');
    await expect(b.service.clearBrandContext(brandId, stale)).rejects.toMatchObject({ code: 'CONTEXT_STALE' });

    const cleared = await b.service.clearBrandContext(brandId, brandContextFingerprint('A vaciar'));
    expect(cleared.brand.context).toBe('');
    expect((await b.service.listBrandContextRevisions(brandId))[0]).toMatchObject({ source: 'clear', content: '' });
  });

  it('refuses a restore whose fingerprint is stale', async () => {
    await b.service.saveBrandContext(brandId, 'Viejo', null);
    const target = (await b.service.listBrandContextRevisions(brandId))[0];
    await b.service.saveBrandContext(brandId, 'Actual', null);

    await expect(b.service.restoreBrandContextRevision(brandId, target.id, brandContextFingerprint('Viejo'))).rejects.toMatchObject({ code: 'CONTEXT_STALE' });
    expect((await b.service.getBrand(brandId)).context).toBe('Actual');
  });
});

describe('brandContextStatus', () => {
  let b: TestBackend;
  let brandId: string;

  beforeEach(async () => {
    b = await makeBackend();
    brandId = (await b.service.createBrand('Marca')).id;
  });
  afterEach(() => b.cleanup());

  it('reports the fingerprint, the works, the owner, the proposals and the history in one read', async () => {
    const first = await b.service.createWork(brandId, 'Primero');
    const second = await b.service.createWork(brandId, 'Segundo');
    await b.service.saveBrandContext(brandId, 'Tono', null);

    const status = await b.service.brandContextStatus(brandId);
    expect(status.fingerprint).toBe(brandContextFingerprint('Tono'));
    expect(status.works.map((w) => w.id).sort()).toEqual([first.id, second.id].sort());
    expect(status.works.every((w) => w.live === false)).toBe(true);
    expect(status.ownerWorkId).toBe([first.id, second.id].sort()[0]);
    expect(status.pending).toBeNull();
    expect(status.revisions.map((r) => r.content)).toEqual(['Tono']);
  });

  it('marks a work with a running session as live', async () => {
    const work = await b.service.createWork(brandId, 'En marcha');
    // A live session is one an adapter currently owns; the harness has no real
    // runtime, so the ownership is stated the same way the propagation tests do.
    vi.spyOn(b.hub, 'liveMemberCount').mockImplementation((id: string) => (id === work.id ? 1 : 0));

    const status = await b.service.brandContextStatus(brandId);
    expect(status.works.find((w) => w.id === work.id)?.live).toBe(true);
  });
});
