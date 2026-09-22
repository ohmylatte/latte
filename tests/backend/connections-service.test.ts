/**
 * El servicio de Conexiones y su cara por IPC (G5 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * Contra un backend de verdad, con el AS de juguete detrás del login: **ningún
 * test abre una ventana ni toca una cuenta real**. `connectionLogin` entra por
 * la opción de `createBackend`, que existe justamente para eso.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeBackend, type TestBackend } from './helpers';
import { memorySecretBox, unavailableSecretBox } from '../../electron/storage/secretBox';
import { runConnectionLogin, type LoginWindowOpener } from '../../electron/connections/login';
import { startToyOAuth, type ToyOAuthServer } from '../fakes/toyOAuth';

let backend: TestBackend | undefined;
const servers: ToyOAuthServer[] = [];

afterEach(async () => {
  backend?.cleanup();
  backend = undefined;
  while (servers.length > 0) await servers.pop()!.close();
});

/** Sigue el 302 hasta el loopback, que es todo lo que hace un navegador acá: el juguete no pide contraseña de nadie. */
const followingWindow: LoginWindowOpener = async (url) => {
  void fetch(url, { redirect: 'follow' }).catch(() => {});
  return { close: () => {} };
};

async function withToy(options: Parameters<typeof startToyOAuth>[0] = {}) {
  const toy = await startToyOAuth(options);
  servers.push(toy);
  backend = await makeBackend({
    secretBox: memorySecretBox(),
    connectionLogin: (request) => runConnectionLogin(request, { openLoginWindow: followingWindow }),
  });
  const brand = await backend.service.createBrand('Ámbar');
  return { toy, backend: backend!, brand };
}

describe('conectar', () => {
  it('crea la fila, entra, y la deja conectada sin devolver un solo secreto', async () => {
    const { toy, backend: b } = await withToy();
    const connection = await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' });
    expect(connection).toMatchObject({ name: 'theagentcy', scope: 'global', brandId: null, state: 'connected', inherited: false });
    // Lo que cruza el IPC no tiene dónde llevar un token.
    expect(JSON.stringify(connection)).not.toContain('at_');
    expect(Object.keys(connection)).not.toContain('tokens');
    // Y el `client_id` del registro dinámico quedó guardado, para no registrar
    // un cliente nuevo en cada login.
    expect(connection.clientId).toBe(toy.registered[0].clientId);
  });

  it('una conexión de marca la ve esa marca y ninguna otra', async () => {
    const { toy, backend: b, brand } = await withToy();
    const otra = await b.service.createBrand('Latte');
    await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'brand', brandId: brand.id });
    expect((await b.service.listConnections(brand.id)).map((c) => c.name)).toEqual(['theagentcy']);
    expect(await b.service.listConnections(otra.id)).toEqual([]);
    // Y no aparece en Ajustes, que es la pantalla de las globales.
    expect(await b.service.listConnections(null)).toEqual([]);
  });

  it('una global se ve desde cualquier marca, marcada como heredada', async () => {
    const { toy, backend: b, brand } = await withToy();
    await b.service.connectConnection({ name: 'meta', url: toy.resourceUrl, scope: 'global' });
    const fromBrand = await b.service.listConnections(brand.id);
    expect(fromBrand).toHaveLength(1);
    expect(fromBrand[0].inherited).toBe(true);
    expect((await b.service.listConnections(null))[0].inherited).toBe(false);
  });

  it('si el login falla NO queda una fila a medias', async () => {
    // Sin registro dinámico y sin `clientId`: el login se corta antes de abrir nada.
    const { toy, backend: b } = await withToy({ refuseRegistration: true });
    await expect(b.service.connectConnection({ name: 'meta', url: toy.resourceUrl, scope: 'global' }))
      .rejects.toMatchObject({ code: 'CONNECTION_CLIENT_ID_REQUIRED' });
    expect(await b.service.listConnections(null)).toEqual([]);
  });

  it('una URL que no es http no llega ni a crear la fila', async () => {
    const { backend: b } = await withToy();
    await expect(b.service.connectConnection({ name: 'x', url: 'ftp://nope', scope: 'global' })).rejects.toThrow();
    expect(await b.service.listConnections(null)).toEqual([]);
  });

  it('dos conexiones con el mismo nombre y el mismo alcance no conviven', async () => {
    const { toy, backend: b } = await withToy();
    await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' });
    await expect(b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' })).rejects.toThrow();
  });
});

describe('volver a entrar, desconectar y borrar', () => {
  it('volver a entrar deja credenciales nuevas y la conexión conectada', async () => {
    const { toy, backend: b } = await withToy();
    const first = await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' });
    await b.service.disconnectConnection(first.id);
    expect((await b.service.listConnections(null))[0].state).toBe('disconnected');
    const again = await b.service.reconnectConnection(first.id);
    expect(again.state).toBe('connected');
  });

  it('desconectar se lleva las credenciales y deja la fila', async () => {
    const { toy, backend: b } = await withToy({ revocation: true });
    const connection = await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' });
    await b.service.disconnectConnection(connection.id);
    expect(b.repo.connections.hasTokens(connection.id)).toBe(false);
    expect((await b.service.listConnections(null)).map((c) => c.id)).toEqual([connection.id]);
    // Y se lo dijo al proveedor, porque publica cómo.
    expect(toy.hits).toContain('POST /revoke');
  });

  it('borrar se lleva la fila entera', async () => {
    const { toy, backend: b } = await withToy();
    const connection = await b.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' });
    await b.service.deleteConnection(connection.id);
    expect(await b.service.listConnections(null)).toEqual([]);
  });

  it('borrar algo que no existe es un NOT_FOUND, no un silencio', async () => {
    const { backend: b } = await withToy();
    await expect(b.service.deleteConnection('con_inexistente0000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('sin dónde cifrar', () => {
  it('no se guarda nada y lo explica', async () => {
    const toy = await startToyOAuth();
    servers.push(toy);
    backend = await makeBackend({
      secretBox: unavailableSecretBox('El sistema no ofrece un almacén de secretos.'),
      connectionLogin: (request) => runConnectionLogin(request, { openLoginWindow: followingWindow }),
    });
    await expect(backend.service.connectConnection({ name: 'theagentcy', url: toy.resourceUrl, scope: 'global' }))
      .rejects.toThrow(/almacén de secretos/i);
    expect(await backend.service.listConnections(null)).toEqual([]);
    // Y ni siquiera se molestó al servidor: se decide antes de escribir nada.
    expect(toy.hits).toEqual([]);
  });
});

describe('el registro del CLI quedó de sólo lectura', () => {
  it('ya no existe manera de agregar un servidor ni de autenticarlo con una terminal', async () => {
    const { backend: b } = await withToy();
    const surface = b.service as unknown as Record<string, unknown>;
    expect(surface.addMcpServer).toBeUndefined();
    expect(surface.loginMcpServer).toBeUndefined();
    expect(surface.authenticateClaudeMcp).toBeUndefined();
    // Lo que sí queda: leerlo, y quitar lo que ya se importó.
    expect(typeof surface.listMcpServers).toBe('function');
    expect(typeof surface.removeMcpServer).toBe('function');
  });
});
