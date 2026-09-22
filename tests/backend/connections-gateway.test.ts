/**
 * El gateway MCP local (G3 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * Todo de punta a punta y hermético: el gateway real escuchando en loopback, el
 * MCP upstream de juguete del otro lado, y un cliente que habla JSON-RPC por
 * http como lo hace cualquiera de los tres runtimes. Lo que se prueba es lo que
 * el documento llama "el trabajo real": que el proxy sea FIEL (sesión,
 * notificaciones, SSE), que el alcance viva en el bearer, y que un 401 a mitad
 * de run se resuelva adentro.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionGateway, connectionRouteFor, type GatewayConnectionsPort } from '../../electron/connections/gateway';
import { createGatewayListen } from '../../electron/connections/gatewayTransport';
import { GatewayTokenRegistry } from '../../electron/connections/gatewayTokens';
import type { ConnectionRecord, ConnectionTokens } from '../../electron/storage/connectionsRepository';
import { startToyMcp, type ToyMcpServer } from '../fakes/toyMcp';
import { startToyOAuth, type ToyOAuthServer } from '../fakes/toyOAuth';
import { createPkce, discoverAuthServer, exchangeCode, registerClient } from '../../electron/connections/oauth';

const upstreams: Array<{ close: () => Promise<void> }> = [];
const gateways: ConnectionGateway[] = [];

afterEach(async () => {
  while (gateways.length > 0) gateways.pop()!.stop();
  while (upstreams.length > 0) await upstreams.pop()!.close();
});

const connectionRecord = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'con_agentcy',
  name: 'theagentcy',
  label: 'The Agentcy',
  url: 'http://127.0.0.1:1/mcp',
  transport: 'http',
  authKind: 'oauth',
  clientId: null,
  identity: null,
  scope: 'global',
  brandId: null,
  state: 'connected',
  stateDetail: '',
  memberOverride: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
  ...over,
});

const tokensFor = (accessToken: string, over: Partial<ConnectionTokens> = {}): ConnectionTokens => ({
  accessToken,
  refreshToken: null,
  expiresAt: null,
  tokenType: 'Bearer',
  scope: 'mcp',
  clientId: 'cli',
  issuer: null,
  tokenEndpoint: null,
  revocationEndpoint: null,
  resource: null,
  ...over,
});

/** Un almacén en memoria con la misma forma angosta que el gateway necesita. */
function memoryConnections(records: ConnectionRecord[], tokens: Record<string, ConnectionTokens>) {
  const byId = new Map(records.map((r) => [r.id, { ...r }]));
  const secrets = new Map(Object.entries(tokens));
  const port: GatewayConnectionsPort = {
    get: (id) => byId.get(id) ?? null,
    readTokens: (id) => secrets.get(id) ?? null,
    saveTokens: (id, value) => { secrets.set(id, value); },
    setState: (id, state, detail) => {
      const record = byId.get(id);
      if (record) { record.state = state; record.stateDetail = detail; }
    },
  };
  return { port, byId, secrets };
}

interface Harness {
  gateway: ConnectionGateway;
  tokens: GatewayTokenRegistry;
  store: ReturnType<typeof memoryConnections>;
  expired: Array<{ id: string; detail: string }>;
  url: (connectionId: string) => string;
}

async function harness(records: ConnectionRecord[], secrets: Record<string, ConnectionTokens>): Promise<Harness> {
  const store = memoryConnections(records, secrets);
  const tokens = new GatewayTokenRegistry();
  const expired: Array<{ id: string; detail: string }> = [];
  const gateway = new ConnectionGateway({
    connections: store.port,
    tokens,
    listen: createGatewayListen(),
    onExpired: (connection, detail) => expired.push({ id: connection.id, detail }),
  });
  gateways.push(gateway);
  await gateway.ensureStarted();
  return { gateway, tokens, store, expired, url: (id) => gateway.urlFor(id) };
}

const rpc = async (url: string, bearer: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

const toy = async (options: Parameters<typeof startToyMcp>[0] = {}): Promise<ToyMcpServer> => {
  const server = await startToyMcp(options);
  upstreams.push(server);
  return server;
};

describe('autorización', () => {
  it('sin bearer es 401 y el upstream ni se entera', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const response = await fetch(h.url('con_agentcy'), { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it('un bearer contra la ruta de OTRA conexión es 403, no 401', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness(
      [connectionRecord({ url: upstream.url }), connectionRecord({ id: 'con_otra', name: 'otra', url: upstream.url })],
      { con_agentcy: tokensFor('at_bueno'), con_otra: tokensFor('at_bueno') },
    );
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_otra'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });

  it('un bearer revocado deja de servir en el acto', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    expect((await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    h.tokens.revokeMember('mem_1');
    expect((await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(401);
  });

  it('dos miembros de marcas distintas sobre la MISMA conexión global reciben bearers distintos en la misma ruta', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const ambar = h.tokens.mint('con_agentcy', 'mem_ambar', 'brd_ambar');
    const latte = h.tokens.mint('con_agentcy', 'mem_latte', 'brd_latte');
    expect(ambar).not.toBe(latte);
    expect(h.url('con_agentcy')).toContain(connectionRouteFor('con_agentcy'));
    expect((await rpc(h.url('con_agentcy'), ambar, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    // Y se revocan por separado: cerrar el chat de una marca no toca a la otra.
    h.tokens.revokeMember('mem_ambar');
    expect((await rpc(h.url('con_agentcy'), ambar, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(401);
    expect((await rpc(h.url('con_agentcy'), latte, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(200);
  });

  it('una ruta que no existe es 404', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_fantasma', 'mem_1', null);
    const response = await rpc(`http://127.0.0.1:${h.gateway.boundPort}/c/con_fantasma`, bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(404);
  });
});

describe('el proxy es fiel', () => {
  it('el token del proveedor NUNCA sale del main: el upstream ve el suyo, jamás el bearer del miembro', async () => {
    const upstream = await toy({ validTokens: new Set(['at_del_proveedor']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_del_proveedor') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(upstream.calls[0].bearer).toBe('at_del_proveedor');
    expect(upstream.calls[0].bearer).not.toBe(bearer);
  });

  it('reenvía initialize, tools/list y tools/call, y devuelve la respuesta tal cual', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const url = h.url('con_agentcy');

    const init = await rpc(url, bearer, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.status).toBe(200);
    expect((await init.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('toy-upstream');

    const list = await rpc(url, bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await list.json() as { result: { tools: Array<{ name: string }> } }).result.tools[0].name).toBe('eco');

    const call = await rpc(url, bearer, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'eco', arguments: { texto: 'hola' } } });
    expect((await call.json() as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe('eco: hola');
  });

  it('el `Mcp-Session-Id` sobrevive el hop, en los dos sentidos', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']), requireSession: true });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const url = h.url('con_agentcy');

    const init = await rpc(url, bearer, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(upstream.sessions.has(sessionId!)).toBe(true);

    // Sin la sesión, el upstream contesta 404: es la prueba de que el requisito es real.
    expect((await rpc(url, bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(404);
    // Con ella, pasa.
    const list = await rpc(url, bearer, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'Mcp-Session-Id': sessionId! });
    expect(list.status).toBe(200);
    expect(upstream.calls.at(-1)!.sessionId).toBe(sessionId);
  });

  it('una notificación (sin `id`) pasa y vuelve 202 sin cuerpo', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(response.status).toBe(202);
    expect(upstream.calls.at(-1)!.rpcMethod).toBe('notifications/initialized');
  });

  it('un cuerpo SSE se reenvía como stream, con el progreso ANTES del resultado', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']), sse: true });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eco' } });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // Sin `Content-Length`: si estuviera, el cuerpo se habría juntado entero.
    expect(response.headers.get('content-length')).toBeNull();
    const text = await response.text();
    expect(text.indexOf('notifications/progress')).toBeLessThan(text.indexOf('eco: hola'));
  });

  it('el canal GET del servidor al cliente también pasa', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const controller = new AbortController();
    const response = await fetch(h.url('con_agentcy'), { method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' }, signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('notifications/message');
    controller.abort();
    expect(upstream.calls.at(-1)!.method).toBe('GET');
  });
});

describe('el 401 a mitad de run se resuelve adentro', () => {
  /**
   * Emite un par access/refresh REAL del AS de juguete, sin pasar por ninguna
   * ventana ni por ninguna cuenta de nadie: se recorre el mismo camino del
   * codigo de autorizacion que recorreria un navegador.
   */
  const seedTokens = async (auth: ToyOAuthServer): Promise<ConnectionTokens> => {
    const discovery = await discoverAuthServer(auth.resourceUrl);
    const registered = await registerClient(discovery, 'http://127.0.0.1:1/callback');
    const pair = createPkce();
    const authorize = new URL(discovery.authorizationEndpoint);
    authorize.searchParams.set('client_id', registered!.clientId);
    authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:1/callback');
    authorize.searchParams.set('code_challenge', pair.challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const redirect = await fetch(authorize, { redirect: 'manual' });
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    return exchangeCode({ discovery, clientId: registered!.clientId, code, verifier: pair.verifier, redirectUri: 'http://127.0.0.1:1/callback' });
  };

  it('refresca, reintenta UNA vez, y el miembro nunca ve el 401', async () => {
    const auth = await startToyOAuth();
    upstreams.push(auth);
    // El upstream y el AS comparten un solo universo de tokens: lo que el AS
    // renueva es exactamente lo que el upstream acepta. Sin eso, "refresco" y
    // "sirvio" serian dos afirmaciones distintas y solo se probaria la primera.
    const upstream = await toy({ isValid: (token) => auth.isLive(token) });
    const tokens = await seedTokens(auth);
    const h = await harness([connectionRecord({ url: upstream.url, state: 'connected' })], { con_agentcy: tokens });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);

    // El token vence a mitad de run: el upstream empieza a contestar 401.
    auth.expire(tokens.accessToken);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(response.status).toBe(200);
    expect((await response.json() as { result: { tools: Array<{ name: string }> } }).result.tools[0].name).toBe('eco');
    // El upstream vio DOS pedidos: el que dio 401 y el reintento ya renovado.
    expect(upstream.calls.filter((c) => c.rpcMethod === 'tools/list')).toHaveLength(2);
    expect(upstream.calls.at(-1)!.bearer).not.toBe(tokens.accessToken);
    // Y lo renovado se guardo, asi que la proxima llamada no vuelve a pagar el 401.
    expect(h.store.secrets.get('con_agentcy')!.accessToken).not.toBe(tokens.accessToken);
    // Nadie se entero de nada: la conexion sigue conectada y no hubo aviso.
    expect(h.store.byId.get('con_agentcy')!.state).toBe('connected');
    expect(h.expired).toEqual([]);
  });

  it('un vencimiento CONOCIDO se renueva antes de salir, sin gastar un 401', async () => {
    const auth = await startToyOAuth();
    upstreams.push(auth);
    const upstream = await toy({ isValid: (token) => auth.isLive(token) });
    const tokens = await seedTokens(auth);
    // Ya vencido segun su propio `expiresAt`, aunque el upstream todavia lo aceptaria.
    const h = await harness(
      [connectionRecord({ url: upstream.url })],
      { con_agentcy: { ...tokens, expiresAt: '2000-01-01T00:00:00.000Z' } },
    );
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(200);
    // Un solo viaje al upstream: no hubo 401 que pagar.
    expect(upstream.calls.filter((c) => c.rpcMethod === 'tools/list')).toHaveLength(1);
    expect(upstream.calls[0].bearer).not.toBe(tokens.accessToken);
  });

  it('diez llamadas que chocan el mismo 401 refrescan UNA sola vez', async () => {
    const auth = await startToyOAuth();
    upstreams.push(auth);
    const upstream = await toy({ isValid: (token) => auth.isLive(token) });
    const tokens = await seedTokens(auth);
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokens });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    auth.expire(tokens.accessToken);
    const before = auth.hits.filter((hit) => hit === 'POST /token').length;
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: i, method: 'tools/list' })));
    for (const response of all) expect(response.status).toBe(200);
    // Un solo `POST /token`: sin la memo, cada llamada gastaria el mismo refresh
    // token y un AS que los rota invalidaria el de las otras nueve.
    expect(auth.hits.filter((hit) => hit === 'POST /token').length - before).toBe(1);
  });

  it('sin refresh posible, la conexion pasa a VENCIDA y el miembro recibe un error legible, no un 500', async () => {
    const upstream = await toy({ validTokens: new Set<string>() });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_muerto') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'eco' } });

    expect(response.status).toBe(200);
    const body = await response.json() as { id: number; result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.id).toBe(7);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('The Agentcy');
    expect(body.result.content[0].text).toContain('volver a entrar');
    // Y no filtra el token en el texto que lee el modelo.
    expect(body.result.content[0].text).not.toContain('at_muerto');

    expect(h.store.byId.get('con_agentcy')!.state).toBe('expired');
    expect(h.expired).toEqual([{ id: 'con_agentcy', detail: expect.stringContaining('renovar') }]);
  });

  it('el aviso de vencida se emite UNA sola vez, aunque choquen varias llamadas', async () => {
    const upstream = await toy({ validTokens: new Set<string>() });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_muerto') });
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(h.expired).toHaveLength(1);
  });

  it('sin credenciales guardadas tampoco explota: lo dice y listo', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], {});
    const bearer = h.tokens.mint('con_agentcy', 'mem_1', null);
    const response = await rpc(h.url('con_agentcy'), bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('ciclo de vida', () => {
  it('no se para mientras quede un bearer vivo, y se para cuando no queda ninguno', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const h = await harness([connectionRecord({ url: upstream.url })], { con_agentcy: tokensFor('at_bueno') });
    h.tokens.mint('con_agentcy', 'mem_1', null);
    h.gateway.stopIfIdle();
    expect(h.gateway.listening).toBe(true);
    h.tokens.revokeMember('mem_1');
    h.gateway.stopIfIdle();
    expect(h.gateway.listening).toBe(false);
  });

  it('dos `ensureStarted` a la vez atan UN solo puerto', async () => {
    const upstream = await toy({ validTokens: new Set(['at_bueno']) });
    const store = memoryConnections([connectionRecord({ url: upstream.url })], {});
    const ports: number[] = [];
    const gateway = new ConnectionGateway({
      connections: store.port,
      tokens: new GatewayTokenRegistry(),
      listen: async (handler) => {
        const handle = await createGatewayListen()(handler);
        ports.push(handle.port);
        return handle;
      },
    });
    gateways.push(gateway);
    await Promise.all([gateway.ensureStarted(), gateway.ensureStarted()]);
    expect(ports).toHaveLength(1);
  });

  it('`revokeConnection` se lleva puestos todos los bearers de esa conexión y ninguno más', () => {
    const registry = new GatewayTokenRegistry();
    const a = registry.mint('con_1', 'mem_1', null);
    const b = registry.mint('con_1', 'mem_2', null);
    const c = registry.mint('con_2', 'mem_1', null);
    expect(registry.revokeConnection('con_1')).toBe(2);
    expect(registry.verify(a)).toBeNull();
    expect(registry.verify(b)).toBeNull();
    expect(registry.verify(c)).not.toBeNull();
  });
});
