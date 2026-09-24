import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { fakeRunner, makeBackend, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

/**
 * EL COORDINADOR HABITUAL DE LA MARCA (brief `2026-09-23-equipo-de-marca.md`, 2.3).
 *
 * Una persona del plantel puede ser quien coordina, por costumbre, los trabajos
 * de la marca: `brand_members.coordinator`, que desde el esquema 14 existía y
 * nadie escribía. Es exclusivo —una sola por marca— y es un DEFAULT: un trabajo
 * con permiso propio manda sobre él, y sólo cuenta si esa persona está
 * convocada al trabajo.
 */
describe('el coordinador habitual de la marca', () => {
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

  async function brandWithTwo() {
    const brand = await b.service.createBrand('Casa');
    await b.service.addBrandMember(brand.id, 'strategist', null);
    const roster = await b.service.addBrandMember(brand.id, 'reviewer', null);
    const strategist = roster.find((m) => m.roleId === 'strategist')!;
    const reviewer = roster.find((m) => m.roleId === 'reviewer')!;
    return { brand, strategist, reviewer };
  }

  it('nadie coordina por defecto; elegir a una persona la marca, y elegir a otra le saca la marca a la primera', async () => {
    const { brand, strategist, reviewer } = await brandWithTwo();
    expect((await b.service.listBrandTeam(brand.id)).map((m) => m.coordinator)).toEqual([false, false]);

    let roster = await b.service.setBrandCoordinator(brand.id, strategist.id);
    expect(roster.find((m) => m.id === strategist.id)!.coordinator).toBe(true);
    expect(roster.find((m) => m.id === reviewer.id)!.coordinator).toBe(false);

    roster = await b.service.setBrandCoordinator(brand.id, reviewer.id);
    expect(roster.filter((m) => m.coordinator).map((m) => m.id)).toEqual([reviewer.id]);

    roster = await b.service.setBrandCoordinator(brand.id, null);
    expect(roster.some((m) => m.coordinator)).toBe(false);
  });

  it('nunca a alguien de otra marca, y la marca de al lado no se entera', async () => {
    const { brand, strategist } = await brandWithTwo();
    const other = await b.service.createBrand('Otra');
    const [foreign] = await b.service.addBrandMember(other.id, 'analyst', null);
    await b.service.setBrandCoordinator(other.id, foreign.id);
    await expect(b.service.setBrandCoordinator(brand.id, foreign.id)).rejects.toThrow();
    await b.service.setBrandCoordinator(brand.id, strategist.id);
    expect((await b.service.listBrandTeam(other.id))[0].coordinator).toBe(true);
  });

  it('en un trabajo sin permiso propio, coordina el habitual SI está convocado; con permiso propio, manda el permiso', async () => {
    const { brand, strategist, reviewer } = await brandWithTwo();
    await b.service.setBrandCoordinator(brand.id, strategist.id);
    const work = await b.service.createWork(brand.id, 'Uno');

    // Sin él convocado, nadie coordina por ser habitual.
    await b.service.callUpMember(work.id, reviewer.id);
    expect((await b.service.listTeam(work.id)).map((m) => m.coordinatesBrand)).toEqual([false]);

    const session = await b.service.callUpMember(work.id, strategist.id);
    const team = await b.service.listTeam(work.id);
    expect(team.filter((m) => m.coordinatesBrand).map((m) => m.id)).toEqual([session.id]);
    // El permiso del TRABAJO sigue vacío: el habitual es un default, no un permiso escrito.
    expect(await b.service.getCoordinatorGrant(work.id)).toBeNull();

    // Y un run que arranca sin permiso propio lo toma a él.
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    const run = await b.service.startCoordinationRun(work.id);
    expect(run.coordinatorMemberId).toBe(session.id);
  });

  it('un permiso propio del trabajo gana sobre el habitual al arrancar un run', async () => {
    const { brand, strategist, reviewer } = await brandWithTwo();
    await b.service.setBrandCoordinator(brand.id, strategist.id);
    const work = await b.service.createWork(brand.id, 'Uno');
    await b.service.callUpMember(work.id, strategist.id);
    const chosen = await b.service.callUpMember(work.id, reviewer.id);
    await b.service.setCoordinatorGrant(work.id, chosen.id);
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    const run = await b.service.startCoordinationRun(work.id);
    expect(run.coordinatorMemberId).toBe(chosen.id);
  });
});
