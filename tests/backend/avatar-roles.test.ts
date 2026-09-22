import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileStore } from '../../electron/agents/profiles';
import { RoleCatalog } from '../../electron/agents/roles';
import { loadInstructionPack } from '../../electron/workspace/packs';
import { avatarFromSeed, parseAvatar, serializeAvatar } from '../../shared/avatar';
import { fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from './helpers';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

/**
 * D3: EL AVATAR VIVE EN EL ROL.
 *
 * Las tres promesas, probadas por la capa real y no por un doble:
 *  1. un rol propio con avatar guardado lo conserva al volver del disco,
 *  2. un rol sin avatar —los que ya existen— NO se queda sin cara: la deriva
 *     de su propio id, que es por lo que este cambio no migra nada,
 *  3. dos miembros del mismo rol en un equipo no tienen la misma cara.
 */

const PACKS = path.resolve(__dirname, '..', '..', 'packs');
const ROLES = path.join(PACKS, 'marketing-core', 'roles');

describe('el pack elige la cara de sus roles', () => {
  const pack = loadInstructionPack(PACKS);

  it('cada rol del pack trae el avatar del tablero, y se puede leer', () => {
    const expected: Record<string, string> = {
      strategist: 'bun.2.1.glasses-thick',
      researcher: 'curly.1.3.glasses-round',
      analyst: 'short.4.1.glasses',
      reviewer: 'long.2.2.earring',
      'paid-media': 'beanie.3.1.none',
      'sales-copywriter': 'curly.4.1.beret',
    };
    expect(pack).not.toBeNull();
    for (const [id, avatar] of Object.entries(expected)) {
      const role = pack!.roles.find((r) => r.id === id);
      expect(role, id).toBeDefined();
      expect(role!.avatar, id).toBe(avatar);
      expect(parseAvatar(role!.avatar), id).not.toBeNull();
    }
  });

  it('el asistente, que no sale del pack, también tiene la suya', () => {
    const catalog = new RoleCatalog(pack);
    expect(catalog.list().find((r) => r.id === 'assistant')?.avatar).toBe('short.2.2.lanyard');
  });

  /**
   * El frontmatter NO entra en el prompt: `parseRole` se queda con el cuerpo
   * que sigue al segundo `---`. Pero el archivo entero se corta en
   * ROLE_BODY_LIMIT ANTES de parsearse, así que cada línea de frontmatter le
   * come lugar al cuerpo. `sales-copywriter.md` es el más largo y queda a
   * menos de treinta caracteres del tope: este candado avisa antes de que una
   * línea de más le corte el final de las instrucciones a alguien.
   */
  it('ninguna línea de frontmatter empuja un rol contra el tope de 8.000', () => {
    for (const entry of fs.readdirSync(ROLES)) {
      const size = fs.readFileSync(path.join(ROLES, entry), 'utf8').length;
      expect(size, entry).toBeLessThan(8_000);
    }
  });

  it('el avatar no viaja en el prompt de ningún rol', () => {
    const catalog = new RoleCatalog(pack);
    for (const role of catalog.list()) {
      const prompt = catalog.promptFor(role.id);
      expect(prompt, role.id).not.toContain('avatar:');
      expect(prompt, role.id).not.toContain(role.avatar ?? '\u0000');
    }
  });

  it('un avatar ilegible en el frontmatter no deja al rol sin cara ni tira el pack', () => {
    const dir = makeTempDir();
    try {
      const packDir = path.join(dir, 'roto');
      fs.mkdirSync(path.join(packDir, 'roles'), { recursive: true });
      fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({ id: 'roto', roles: ['torcido'] }));
      fs.writeFileSync(path.join(packDir, 'instructions.md'), 'pack');
      fs.writeFileSync(path.join(packDir, 'base.md'), 'base');
      fs.writeFileSync(path.join(packDir, 'roles', 'torcido.md'), '---\nname: Torcido\ninitial: T\navatar: no-es-un-avatar\n---\nInstrucciones.\n');
      const broken = loadInstructionPack(dir, 'roto');
      expect(broken?.roles[0]?.avatar).toBeNull();
      // Y el catálogo le da igual una: nadie se queda sin cara.
      expect(new RoleCatalog(broken).list().find((r) => r.id === 'torcido')?.avatar).toBe(serializeAvatar(avatarFromSeed('torcido')));
    } finally { removeDir(dir); }
  });
});

describe('un rol propio guarda y recupera su avatar', () => {
  const input = { id: 'growth-strategist', name: 'Growth', initial: 'G', summary: 'Crece.', soul: 'SOUL', skills: '' };

  it('lo que se elige es lo que vuelve del disco, y queda al lado de la inicial', () => {
    const dir = makeTempDir();
    try {
      const store = new ProfileStore(path.join(dir, 'agents'));
      const catalog = new RoleCatalog(null, store);
      const saved = catalog.saveProfile({ ...input, avatar: 'bob.2.4.phones' }, null);
      expect(saved.avatar).toBe('bob.2.4.phones');

      const metadata = JSON.parse(fs.readFileSync(path.join(saved.directory!, 'profile.json'), 'utf8'));
      expect(metadata.avatar).toBe('bob.2.4.phones');
      expect(metadata.initial).toBe('G');

      // Otra lectura, otro proceso: la misma cara.
      const reread = new RoleCatalog(null, new ProfileStore(path.join(dir, 'agents')));
      expect(reread.listProfiles().find((p) => p.id === input.id)?.avatar).toBe('bob.2.4.phones');
      expect(reread.list().find((r) => r.id === input.id)?.avatar).toBe('bob.2.4.phones');
      expect(reread.get(input.id)?.avatar).toBe('bob.2.4.phones');
    } finally { removeDir(dir); }
  });

  it('un perfil sin avatar —o con uno ilegible— deriva el suyo del id, sin migrar nada', () => {
    const dir = makeTempDir();
    try {
      const store = new ProfileStore(path.join(dir, 'agents'));
      const catalog = new RoleCatalog(null, store);
      const derived = serializeAvatar(avatarFromSeed(input.id));

      // Tal cual lo guardaba la versión anterior: sin el campo.
      const saved = catalog.saveProfile(input, null);
      expect(saved.avatar).toBe(derived);
      fs.writeFileSync(path.join(saved.directory!, 'profile.json'), JSON.stringify({ id: input.id, name: input.name, initial: 'G', summary: input.summary }, null, 2) + '\n');
      expect(new RoleCatalog(null, new ProfileStore(path.join(dir, 'agents'))).list().find((r) => r.id === input.id)?.avatar).toBe(derived);

      // Y alguien que edito el JSON a mano tampoco rompe el perfil entero.
      fs.writeFileSync(path.join(saved.directory!, 'profile.json'), JSON.stringify({ id: input.id, name: input.name, initial: 'G', summary: input.summary, avatar: { torcido: true } }, null, 2) + '\n');
      const catalog2 = new RoleCatalog(null, new ProfileStore(path.join(dir, 'agents')));
      expect(catalog2.listProfiles().find((p) => p.id === input.id)?.error).toBeUndefined();
      expect(catalog2.list().find((r) => r.id === input.id)?.avatar).toBe(derived);
    } finally { removeDir(dir); }
  });
});

describe('ninguna cara repetida en un equipo', () => {
  let b: TestBackend;
  let fake: FakeOpenCode;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0.0\n' })),
    });
  });

  afterEach(async () => { b.cleanup(); await fake.close(); });

  it('el primero de un rol lleva la cara del rol; el segundo, la suya', async () => {
    const brand = await b.service.createBrand('Casa Oliva');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');

    const first = await b.service.addTeamMember(work.id, 'reviewer');
    const second = await b.service.addTeamMember(work.id, 'reviewer');
    const other = await b.service.addTeamMember(work.id, 'strategist');

    const team = await b.service.listTeam(work.id);
    const avatarOf = (id: string) => team.find((m) => m.id === id)?.avatar;

    expect(avatarOf(first.id)).toBe('long.2.2.earring');
    expect(avatarOf(second.id)).toBe(serializeAvatar(avatarFromSeed(second.id)));
    expect(avatarOf(second.id)).not.toBe(avatarOf(first.id));
    expect(avatarOf(other.id)).toBe('bun.2.1.glasses-thick');
    // Ninguna cara repetida, punto.
    expect(new Set(team.map((m) => m.avatar)).size).toBe(team.length);
    // El color sigue siendo el del rol: los dos Reviewers son Reviewers.
    expect(team.find((m) => m.id === second.id)?.roleId).toBe('reviewer');

    // Y `getMember`, que no ve al equipo entero, dice exactamente lo mismo.
    expect(b.hub.getMember(second.id).avatar).toBe(avatarOf(second.id));
    expect(b.hub.getMember(first.id).avatar).toBe(avatarOf(first.id));
  });
});

/**
 * D9: LA CARA DE UN ROL INCLUIDO SE PUEDE ELEGIR, SIN TOCAR EL PACK.
 *
 * Los roles del pack son archivos del programa: no se editan desde la app. Pero
 * la cara no es comportamiento, es identidad, y esa la elige quien usa Latte.
 * El override vive en `meta` —clave/valor, sin migracion, por eso el esquema no
 * sube— y GANA sobre el frontmatter, asi que actualizar Latte no lo pisa.
 */
describe('el avatar de un rol incluido se puede sobreescribir', () => {
  let b: TestBackend;
  let fake: FakeOpenCode;

  beforeEach(async () => {
    fake = await startFakeOpenCode();
    b = await makeBackend({
      chatEndpoint: fake.endpoint,
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0.0\n' })),
    });
  });

  afterEach(async () => { b.cleanup(); await fake.close(); });

  const avatarOfRole = async (roleId: string) => (await b.service.listRoles()).find((r) => r.id === roleId)?.avatar;

  it('el override gana sobre el frontmatter del pack, y vuelve al borrarlo', async () => {
    expect(await avatarOfRole('strategist')).toBe('bun.2.1.glasses-thick');

    const roles = await b.service.setRoleAvatar('strategist', 'curly.3.2.beret');
    // Devuelve los roles ya actualizados: quien llama no tiene que volver a pedirlos.
    expect(roles.find((r) => r.id === 'strategist')?.avatar).toBe('curly.3.2.beret');
    expect(await avatarOfRole('strategist')).toBe('curly.3.2.beret');
    // Y tambien en la lista de perfiles, que es donde se elige.
    expect((await b.service.listProfiles()).find((p) => p.id === 'strategist')?.avatar).toBe('curly.3.2.beret');

    // null no guarda un vacio: BORRA. "Nunca elegi" y "me arrepenti" terminan
    // en el mismo lugar, que es la cara que trae el pack.
    await b.service.setRoleAvatar('strategist', null);
    expect(await avatarOfRole('strategist')).toBe('bun.2.1.glasses-thick');
  });

  it('el asistente, que no sale del pack, tambien se puede cambiar', async () => {
    expect(await avatarOfRole('assistant')).toBe('short.2.2.lanyard');
    await b.service.setRoleAvatar('assistant', 'long.1.4.headband');
    expect(await avatarOfRole('assistant')).toBe('long.1.4.headband');
  });

  it('se guarda normalizado: una sola forma de cada cara en disco', async () => {
    await b.service.setRoleAvatar('reviewer', '  CURLY.3.2.Beret ');
    expect(await avatarOfRole('reviewer')).toBe('curly.3.2.beret');
  });

  it('un miembro hereda el override, no el frontmatter', async () => {
    const brand = await b.service.createBrand('Casa Oliva');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');

    await b.service.setRoleAvatar('reviewer', 'bob.1.4.scarf');
    const first = await b.service.addTeamMember(work.id, 'reviewer');
    expect((await b.service.listTeam(work.id)).find((m) => m.id === first.id)?.avatar).toBe('bob.1.4.scarf');

    // Y la regla de "ninguna cara repetida" sigue valiendo sobre el override.
    const second = await b.service.addTeamMember(work.id, 'reviewer');
    const team = await b.service.listTeam(work.id);
    expect(team.find((m) => m.id === second.id)?.avatar).not.toBe('bob.1.4.scarf');
    expect(new Set(team.map((m) => m.avatar)).size).toBe(team.length);
  });

  it('rechaza un rol que no existe y una cara ilegible, sin dejar nada escrito', async () => {
    await expect(b.service.setRoleAvatar('no-existe', 'bob.2.4.phones')).rejects.toThrow();
    await expect(b.service.setRoleAvatar('../escape', 'bob.2.4.phones')).rejects.toThrow();
    await expect(b.service.setRoleAvatar('strategist', 'no-es-una-cara')).rejects.toThrow();
    // Nada de eso movio la cara del pack.
    expect(await avatarOfRole('strategist')).toBe('bun.2.1.glasses-thick');
  });

  /** El override es del disco, no de la sesion: sobrevive a reabrir la app. */
  it('sobrevive a una lectura nueva del catalogo', async () => {
    await b.service.setRoleAvatar('analyst', 'bun.4.1.cap');
    expect(b.repo.getMeta('role-avatar:analyst')).toBe('bun.4.1.cap');
    expect(new RoleCatalog(loadInstructionPack(PACKS), undefined, (id) => b.repo.getMeta(`role-avatar:${id}`))
      .list().find((r) => r.id === 'analyst')?.avatar).toBe('bun.4.1.cap');
  });
});
