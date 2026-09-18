import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';

describe('coordinator grant (single per-Work capability, not a role)', () => {
  let b: TestBackend;
  let workId: string;
  let memberA: string;
  let memberB: string;
  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Brand');
    const work = await b.service.createWork(brand.id, 'Work');
    workId = work.id;
    const at = new Date().toISOString();
    memberA = 'ses_grant_a';
    memberB = 'ses_grant_b';
    b.repo.insertMember({ id: memberA, workId, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at });
    b.repo.insertMember({ id: memberB, workId, roleId: 'copywriter', roleName: 'Copywriter', initial: 'C', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at });
  });
  afterEach(() => b.cleanup());

  it('defaults to no coordinator', async () => {
    expect(await b.service.getCoordinatorGrant(workId)).toBeNull();
  });

  it('grants to a member and round-trips', async () => {
    expect(await b.service.setCoordinatorGrant(workId, memberA)).toBe(memberA);
    expect(await b.service.getCoordinatorGrant(workId)).toBe(memberA);
  });

  it('granting to B revokes A — the two are never both holders', async () => {
    await b.service.setCoordinatorGrant(workId, memberA);
    expect(await b.service.getCoordinatorGrant(workId)).toBe(memberA);
    await b.service.setCoordinatorGrant(workId, memberB);
    expect(await b.service.getCoordinatorGrant(workId)).toBe(memberB);
    expect(await b.service.getCoordinatorGrant(workId)).not.toBe(memberA);
  });

  it('is a capability, not identity: granting it to a non-strategist role leaves the role unchanged', async () => {
    await b.service.setCoordinatorGrant(workId, memberB);
    const member = b.repo.findMember(memberB);
    expect(member?.roleId).toBe('copywriter');
    expect(member?.roleName).toBe('Copywriter');
  });

  it('revokes with null', async () => {
    await b.service.setCoordinatorGrant(workId, memberA);
    expect(await b.service.setCoordinatorGrant(workId, null)).toBeNull();
    expect(await b.service.getCoordinatorGrant(workId)).toBeNull();
  });

  it('rejects a member that does not belong to this Work, without mutating the current grant', async () => {
    const brand2 = await b.service.createBrand('Brand 2');
    const otherWork = await b.service.createWork(brand2.id, 'Other');
    const at = new Date().toISOString();
    const outsider = 'ses_grant_outsider';
    b.repo.insertMember({ id: outsider, workId: otherWork.id, roleId: 'strategist', roleName: 'Strategist', initial: 'S', runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: at, updatedAt: at });
    await b.service.setCoordinatorGrant(workId, memberA);
    await expect(b.service.setCoordinatorGrant(workId, outsider)).rejects.toThrow();
    expect(await b.service.getCoordinatorGrant(workId)).toBe(memberA);
  });

  it('rejects an unknown member id, without mutating the current grant', async () => {
    await b.service.setCoordinatorGrant(workId, memberA);
    await expect(b.service.setCoordinatorGrant(workId, 'ses_does_not_exist')).rejects.toThrow();
    expect(await b.service.getCoordinatorGrant(workId)).toBe(memberA);
  });
});
