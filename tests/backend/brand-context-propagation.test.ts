import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';

/**
 * A brand-context write is brand-wide: it must reach every work of the brand
 * EXCEPT the ones a live agent session is reading, and it must say what it did.
 * The bug it closes: three works of one brand each kept asking the same brand
 * questions because the context was written but never propagated.
 */

const CONTEXT = 'Tono cercano, sin muletillas.';
const VALID = { text: CONTEXT, rationale: 'Del brief.', mode: 'replace' as const, clientRequestId: 'req_prop_1' };
const FULL_NUDGE = 'Before starting any other work, draft this brand\'s context';
const PENDING_NUDGE = 'A proposal is already waiting for the human to review';
const INHERITED_NUDGE = 'Brand knowledge from previous work is inherited below';
const OWNER_ELSEWHERE_NUDGE = 'Another work of this brand is drafting it';

function agents(b: TestBackend, brandId: string, workId: string): string {
  return fs.readFileSync(path.join(b.files.workDir(brandId, workId), 'AGENTS.md'), 'utf8');
}

describe('refreshBrandWorksInstructions', () => {
  let b: TestBackend;
  let brandId: string;
  let first: string;
  let second: string;
  let live: string;
  const chatId = 'ses_propagation';

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    brandId = brand.id;
    first = (await b.service.createWork(brandId, 'Primero')).id;
    second = (await b.service.createWork(brandId, 'Segundo')).id;
    live = (await b.service.createWork(brandId, 'Tercero')).id;
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: chatId, workId: first, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
  });
  afterEach(() => b.cleanup());

  it('writes the new context to idle works, skips the live one and reports it', async () => {
    vi.spyOn(b.hub, 'liveMemberCount').mockImplementation((id: string) => (id === live ? 1 : 0));
    const liveBefore = agents(b, brandId, live);
    expect(liveBefore).not.toContain(CONTEXT);

    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    const result = await b.service.approveBrandContextProposal(pending!.id, null);

    expect(result.refresh.updated).toEqual(expect.arrayContaining([first, second]));
    expect(result.refresh.live).toEqual([live]);
    expect(result.refresh.unchanged).toEqual([]);
    expect(agents(b, brandId, first)).toContain(CONTEXT);
    expect(agents(b, brandId, second)).toContain(CONTEXT);
    // The live work keeps exactly the file its session started with.
    expect(agents(b, brandId, live)).toBe(liveBefore);
  });

  it('does not write a work whose rendered text would be byte-identical', async () => {
    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    await b.service.approveBrandContextProposal(pending!.id, null);

    const brand = await b.service.getBrand(brandId);
    const again = b.service.refreshBrandWorksInstructions(brand);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toEqual(expect.arrayContaining([first, second, live]));
    expect(again.live).toEqual([]);
  });

  it('reports a work the human took over as user-owned and never overwrites it', async () => {
    const dir = b.files.workDir(brandId, second);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mío\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mío también\n');

    const pending = await b.service.proposeBrandContextFromAgent(chatId, 'msg_1', VALID);
    const result = await b.service.approveBrandContextProposal(pending!.id, null);

    expect(result.refresh.userOwned).toEqual([second]);
    expect(result.refresh.updated).toEqual(expect.arrayContaining([first, live]));
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('# Mío también\n');
  });

  it('flips the empty-context nudge of the owner when a proposal is pending, and back on reject', async () => {
    // One work: it is its own owner, so it carries the full nudge while empty.
    const brand = await b.service.createBrand('Sola');
    const only = await b.service.createWork(brand.id, 'Único');
    const at = new Date().toISOString();
    b.repo.insertMember({
      id: 'ses_sola', workId: only.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at,
    });
    expect(agents(b, brand.id, only.id)).toContain(FULL_NUDGE);

    const pending = await b.service.proposeBrandContextFromAgent('ses_sola', 'msg_1', VALID);
    expect(pending?.status).toBe('pending');
    const withPending = agents(b, brand.id, only.id);
    expect(withPending).toContain(PENDING_NUDGE);
    expect(withPending).not.toContain(FULL_NUDGE);

    await b.service.rejectBrandContextProposal(pending!.id);
    expect(agents(b, brand.id, only.id)).toContain(FULL_NUDGE);
  });
});

/**
 * The nudge is brand-scoped: exactly ONE work of an empty brand drafts it.
 *
 * This goes through the real service, which is the whole point. The pure
 * predicate passes whatever boolean it is handed, so a wiring bug that feeds it
 * "a sibling work EXISTS" instead of "a sibling left KNOWLEDGE" is invisible
 * there: for every brand with two or more works the nudge silently disappears.
 * Only the rendered file can tell the difference.
 */
describe('brand-scoped draft nudge across three works', () => {
  let b: TestBackend;
  let brandId: string;
  let owner: string;
  let siblings: string[];

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Tres');
    brandId = brand.id;
    const ids = [
      (await b.service.createWork(brandId, 'Uno')).id,
      (await b.service.createWork(brandId, 'Dos')).id,
      (await b.service.createWork(brandId, 'Tres')).id,
    ];
    // Creating a work renders its instructions while it is still the only one;
    // a brand-context write re-renders the brand as a whole, which is the state
    // under test.
    owner = [...ids].sort()[0];
    siblings = ids.filter((id) => id !== owner);
    b.service.refreshBrandWorksInstructions(await b.service.getBrand(brandId));
  });
  afterEach(() => b.cleanup());

  it('nudges exactly the elected work and tells the others why', () => {
    expect(agents(b, brandId, owner)).toContain(FULL_NUDGE);
    for (const id of siblings) {
      const text = agents(b, brandId, id);
      expect(text).not.toContain(FULL_NUDGE);
      // "Another work owns it", never "you inherited knowledge": an empty brand
      // with empty siblings has nothing to inherit.
      expect(text).toContain(OWNER_ELSEWHERE_NUDGE);
      expect(text).not.toContain(INHERITED_NUDGE);
    }
  });

  it('suppresses the nudge only once a sibling leaves something to inherit', async () => {
    // The sibling existed all along; what changes is that it now left knowledge.
    b.repo.insertDecision({ id: 'dec_inherited', workId: siblings[0], text: 'Tono cercano.', createdAt: '2026-01-01T00:00:00.000Z' });
    b.service.refreshBrandWorksInstructions(await b.service.getBrand(brandId));

    // Inherited beats "the owner drafts it": there is real brand knowledge now.
    const text = agents(b, brandId, owner);
    expect(text).toContain(INHERITED_NUDGE);
    expect(text).not.toContain(FULL_NUDGE);
    // And it is content, not sibling count: the sibling that left the decision
    // still has nothing of its own to inherit, so it keeps the owner-elsewhere
    // reason, while the third work reads the decision and inherits.
    expect(agents(b, brandId, siblings[0])).toContain(OWNER_ELSEWHERE_NUDGE);
    expect(agents(b, brandId, siblings[1])).toContain(INHERITED_NUDGE);
  });
});
