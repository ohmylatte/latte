import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { avatarFromSeed, serializeAvatar } from '../../shared/avatar';
import { BRAND_MEMBER_IDLE_DAYS } from '../../electron/agents/roster';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

/**
 * EL EQUIPO ES DE LA MARCA (brief `docs/briefs/2026-09-23-equipo-de-marca.md`,
 * bloques 3 y 5). El plantel es la identidad —rol, cara, runtime, cuenta,
 * esfuerzo— y vive en la marca; el trabajo CONVOCA a quién participa, y esa
 * convocatoria es la fila de `team_members` de siempre, con su hilo propio.
 *
 * Decisiones del dueño que estos candados fijan: estar en el plantel no corre
 * nada; un miembro que nadie convoca se retira solo y vuelve al ser convocado;
 * nunca se convoca a alguien de otra marca.
 */
describe('El plantel de la marca', () => {
  let fake: FakeOpenCode;
  let b: TestBackend;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
        if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) };
        return { code: 0, stdout: '1.0.0\n' };
      }),
      emitChat: () => {},
    });
  });

  afterEach(async () => {
    b.cleanup();
    await fake.close();
  });

  it('sumar un rol a un trabajo lo suma al plantel; en otro trabajo de la misma marca convoca a la MISMA persona', async () => {
    const brand = await b.service.createBrand('Casa');
    const uno = await b.service.createWork(brand.id, 'Uno');
    const dos = await b.service.createWork(brand.id, 'Dos');
    expect(await b.service.listBrandTeam(brand.id)).toEqual([]);

    const first = await b.service.addTeamMember(uno.id, 'strategist');
    const [inUno] = await b.service.listTeam(uno.id);
    expect(inUno.brandMemberId).toMatch(/^bm_/);
    let roster = await b.service.listBrandTeam(brand.id);
    expect(roster).toMatchObject([{ id: inUno.brandMemberId, brandId: brand.id, roleId: 'strategist', runtime: 'opencode', retiredAt: null, workIds: [uno.id] }]);

    const second = await b.service.addTeamMember(dos.id, 'strategist');
    // Otro hilo —su propia sesión, su propio uso— de la misma persona.
    expect(second.id).not.toBe(first.id);
    const [inDos] = await b.service.listTeam(dos.id);
    expect(inDos.brandMemberId).toBe(inUno.brandMemberId);
    roster = await b.service.listBrandTeam(brand.id);
    expect(roster).toHaveLength(1);
    expect(roster[0].workIds).toEqual([uno.id, dos.id]);
    // La misma cara en los dos trabajos: la cara es de la persona, no del hilo.
    expect(inDos.avatar).toBe(inUno.avatar);
  });

  it('dos del mismo rol en el mismo trabajo son dos personas, y otra marca nunca comparte plantel', async () => {
    const brand = await b.service.createBrand('Casa');
    const other = await b.service.createBrand('Otra');
    const work = await b.service.createWork(brand.id, 'Uno');
    const foreign = await b.service.createWork(other.id, 'Ajeno');

    await b.service.addTeamMember(work.id, 'reviewer');
    await b.service.addTeamMember(work.id, 'reviewer');
    const team = await b.service.listTeam(work.id);
    expect(new Set(team.map((m) => m.brandMemberId)).size).toBe(2);
    // Ninguna cara repetida: la primera del rol lleva la del rol; la segunda la suya.
    const roster = await b.service.listBrandTeam(brand.id);
    const reviewerRole = (await b.service.listRoles()).find((r) => r.id === 'reviewer')!;
    expect(roster[0].avatar).toBe(reviewerRole.avatar);
    expect(roster[1].avatar).toBe(serializeAvatar(avatarFromSeed(roster[1].id)));
    expect(team.map((m) => m.avatar)).toEqual(roster.map((m) => m.avatar));

    await b.service.addTeamMember(foreign.id, 'reviewer');
    expect(await b.service.listBrandTeam(other.id)).toHaveLength(1);
    expect(await b.service.listBrandTeam(brand.id)).toHaveLength(2);
  });

  it('el plantel se arma sin arrancar a nadie, y convocar abre el hilo en ese trabajo una sola vez', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const roster = await b.service.addBrandMember(brand.id, 'analyst', null);
    expect(roster).toMatchObject([{ roleId: 'analyst', workIds: [], retiredAt: null }]);
    // Estar en el plantel no corre nada.
    expect(b.hub.liveCount()).toBe(0);
    expect(await b.service.listTeam(work.id)).toEqual([]);

    const session = await b.service.callUpMember(work.id, roster[0].id);
    const team = await b.service.listTeam(work.id);
    expect(team).toMatchObject([{ id: session.id, roleId: 'analyst', brandMemberId: roster[0].id, status: 'idle' }]);
    // Convocar de nuevo no duplica: reabre la misma convocatoria.
    await b.service.pauseTeamMember(session.id);
    const again = await b.service.callUpMember(work.id, roster[0].id);
    expect(again.id).toBe(session.id);
    expect(await b.service.listTeam(work.id)).toHaveLength(1);
    expect((await b.service.listBrandTeam(brand.id))[0].workIds).toEqual([work.id]);
  });

  it('nunca se convoca a alguien de otra marca', async () => {
    const brand = await b.service.createBrand('Casa');
    const other = await b.service.createBrand('Otra');
    const work = await b.service.createWork(brand.id, 'Uno');
    const [stranger] = await b.service.addBrandMember(other.id, 'analyst', null);
    await expect(b.service.callUpMember(work.id, stranger.id)).rejects.toThrow(/otra marca/);
    expect(await b.service.listTeam(work.id)).toEqual([]);
  });

  it('"nuevo en la marca" suma a otra persona aunque el rol ya esté en el plantel', async () => {
    const brand = await b.service.createBrand('Casa');
    const uno = await b.service.createWork(brand.id, 'Uno');
    const dos = await b.service.createWork(brand.id, 'Dos');
    await b.service.addTeamMember(uno.id, 'strategist');
    await b.service.addTeamMember(dos.id, 'strategist', { newInBrand: true });
    expect(await b.service.listBrandTeam(brand.id)).toHaveLength(2);
  });

  it('desconvocar saca a la persona del trabajo y la deja en el plantel', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const session = await b.service.addTeamMember(work.id, 'strategist');
    await b.service.removeTeamMember(session.id);
    expect(await b.service.listTeam(work.id)).toEqual([]);
    expect(await b.service.listBrandTeam(brand.id)).toMatchObject([{ roleId: 'strategist', workIds: [], retiredAt: null }]);
  });

  it(`quien nadie convoca en ${BRAND_MEMBER_IDLE_DAYS} días se retira solo, y convocarlo lo devuelve`, async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const [idle] = await b.service.addBrandMember(brand.id, 'analyst', null);
    await b.service.addTeamMember(work.id, 'strategist');
    const busyId = (await b.service.listTeam(work.id))[0].brandMemberId!;

    const soon = new Date(Date.now() + (BRAND_MEMBER_IDLE_DAYS - 1) * 86_400_000).toISOString();
    expect(b.service.retireIdleBrandMembers(soon)).toBe(0);
    const later = new Date(Date.now() + (BRAND_MEMBER_IDLE_DAYS + 1) * 86_400_000).toISOString();
    // La estratega también quedó quieta desde su convocatoria: las dos se retiran.
    expect(b.service.retireIdleBrandMembers(later)).toBe(2);
    let roster = await b.service.listBrandTeam(brand.id);
    expect(roster.find((m) => m.id === idle.id)!.retiredAt).toBe(later);
    expect(roster.find((m) => m.id === busyId)!.retiredAt).toBe(later);
    // Retirarse no le borra el hilo a nadie: la convocatoria sigue en su trabajo.
    expect(await b.service.listTeam(work.id)).toHaveLength(1);

    // Vuelve al ser convocado. Y el alta por rol elige al retirado antes que inventar a otro.
    await b.service.callUpMember(work.id, idle.id);
    const other = await b.service.createWork(brand.id, 'Dos');
    await b.service.addTeamMember(other.id, 'strategist');
    roster = await b.service.listBrandTeam(brand.id);
    expect(roster).toHaveLength(2);
    expect(roster.every((m) => m.retiredAt === null)).toBe(true);
  });

  it('quitar del plantel borra a quien nunca trabajó y retira a quien tiene historia', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const [never] = await b.service.addBrandMember(brand.id, 'analyst', null);
    await b.service.addTeamMember(work.id, 'strategist');
    const worked = (await b.service.listBrandTeam(brand.id)).find((m) => m.roleId === 'strategist')!;

    let roster = await b.service.retireBrandMember(never.id);
    expect(roster.map((m) => m.id)).toEqual([worked.id]);
    roster = await b.service.retireBrandMember(worked.id);
    expect(roster).toMatchObject([{ id: worked.id, retiredAt: expect.any(String) }]);
    // Sus runs viejos lo siguen nombrando: la convocatoria no se toca.
    expect(await b.service.listTeam(work.id)).toMatchObject([{ brandMemberId: worked.id }]);
  });

  it('la conversación por defecto sigue siendo del agente principal: no convoca a un Asistente de otro runtime', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    const now = new Date().toISOString();
    b.repo.insertBrandMember({
      id: 'bm_codex_assistant', brandId: brand.id, roleId: 'assistant', roleName: 'Asistente', initial: 'A', avatar: null,
      runtime: 'codex', model: null, accountId: 'system', tier: 'balanced', coordinator: false,
      lastCalledAt: now, retiredAt: null, createdAt: now, updatedAt: now,
    });
    const session = await b.service.startChat(work.id);
    const [member] = await b.service.listTeam(work.id);
    expect(member).toMatchObject({ id: session.id, roleId: 'assistant', runtime: 'opencode' });
    expect(member.brandMemberId).not.toBe('bm_codex_assistant');
    // Y la segunda vez en otro trabajo, la MISMA persona del agente principal.
    const other = await b.service.createWork(brand.id, 'Dos');
    await b.service.startChat(other.id);
    expect((await b.service.listTeam(other.id))[0].brandMemberId).toBe(member.brandMemberId);
  });

  it('la cara del rol elegida en Ajustes sigue mandando sobre la del plantel', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Uno');
    await b.service.addTeamMember(work.id, 'strategist');
    await b.service.setRoleAvatar('strategist', 'bob.2.4.phones');
    expect((await b.service.listBrandTeam(brand.id))[0].avatar).toBe('bob.2.4.phones');
    expect((await b.service.listTeam(work.id))[0].avatar).toBe('bob.2.4.phones');
  });
});
