/**
 * El aviso en el chat y los candados de secretos (G6 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * Dos cosas que el documento pone juntas porque comparten el mismo hecho: el
 * gateway es el único que sabe la verdad de una sesión, y es el único que
 * toca el token del proveedor. De ahí salen el aviso (porque nadie más se
 * entera) y los candados (porque nadie más tiene por qué verlo).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionGateway, type GatewayConnectionsPort } from '../../electron/connections/gateway';
import { createGatewayListen } from '../../electron/connections/gatewayTransport';
import { GatewayTokenRegistry } from '../../electron/connections/gatewayTokens';
import { ConnectionInjectionPlanner } from '../../electron/connections/injection';
import { codexMcpConfigOverrides } from '../../electron/agents/codex/mcpFingerprint';
import { opencodeMcpConfigContent } from '../../electron/opencode/mcpConfig';
import type { ConnectionRecord, ConnectionTokens } from '../../electron/storage/connectionsRepository';
import type { AdapterMcpServer } from '../../electron/agents/types';
import type { ChatEvent } from '../../shared/contracts';
import fs from 'node:fs';
import path from 'node:path';
import { startToyMcp, type ToyMcpServer } from '../fakes/toyMcp';
import { clearNeedsAuthEntries, NEEDS_AUTH_CACHE_FILE, withoutNeedsAuthEntries } from '../../electron/agents/needsAuthCache';
import { makeTempDir, removeDir } from './helpers';

const upstreams: ToyMcpServer[] = [];
const gateways: ConnectionGateway[] = [];
afterEach(async () => {
  while (gateways.length > 0) gateways.pop()!.stop();
  while (upstreams.length > 0) await upstreams.pop()!.close();
});

const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'con_agentcy', name: 'theagentcy', label: 'The Agentcy', url: 'http://127.0.0.1:1/mcp',
  transport: 'http', authKind: 'oauth', clientId: null, identity: null, scope: 'brand', brandId: 'brd_1',
  state: 'connected', stateDetail: '', memberOverride: null,
  createdAt: '2026-09-23T10:00:00.000Z', updatedAt: '2026-09-23T10:00:00.000Z', ...over,
});

const tokens = (accessToken: string): ConnectionTokens => ({
  accessToken, refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null,
  clientId: null, issuer: null, tokenEndpoint: null, revocationEndpoint: null, resource: null,
});

/**
 * El mismo cableado que arma `bootstrap.ts`: gateway + planificador, con el
 * `onExpired` que escribe en `agents.log` y le avisa a cada miembro que de
 * verdad lleva esa conexión.
 */
async function wire(connection: ConnectionRecord, secrets: Record<string, ConnectionTokens>) {
  const byId = new Map([[connection.id, { ...connection }]]);
  const store = new Map(Object.entries(secrets));
  const port: GatewayConnectionsPort = {
    get: (id) => byId.get(id) ?? null,
    readTokens: (id) => store.get(id) ?? null,
    saveTokens: (id, value) => { store.set(id, value); },
    setState: (id, state, detail) => { const r = byId.get(id); if (r) { r.state = state; r.stateDetail = detail; } },
  };
  const registry = new GatewayTokenRegistry();
  const log: string[] = [];
  const events: ChatEvent[] = [];
  let planner!: ConnectionInjectionPlanner;
  const gateway = new ConnectionGateway({
    connections: port,
    tokens: registry,
    listen: createGatewayListen(),
    log: (line) => log.push(line),
    onExpired: (expired, detail) => {
      log.push(`[conexiones] vencida: ${expired.id} ${expired.name} alcance=${expired.scope}${expired.brandId ? `:${expired.brandId}` : ''} estado=expired motivo=${detail}`);
      for (const memberId of planner.membersUsing(expired.id)) {
        events.push({ chatId: memberId, type: 'connection-expired', connectionId: expired.id, label: expired.label, detail });
      }
    },
  });
  gateways.push(gateway);
  planner = new ConnectionInjectionPlanner({
    repo: { resolveForBrand: () => [byId.get(connection.id)!], hasTokens: (id) => store.has(id) },
    tokens: registry,
    gateway,
    log: (line) => log.push(line),
    audit: (event) => log.push(`[conexiones] inyectada: ${event.connectionId} ${event.name} alcance=${event.scope} estado=${event.state} miembro=${event.memberId}`),
  });
  return { gateway, registry, planner, log, events, byId, store };
}

const rpc = (url: string, bearer: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('el aviso en el chat', () => {
  it('le llega a cada miembro que LLEVA la conexión, y a nadie más', async () => {
    const upstream = await startToyMcp({ validTokens: new Set<string>() });
    upstreams.push(upstream);
    const w = await wire(record({ url: upstream.url }), { con_agentcy: tokens('at_muerto') });

    const servers = await w.planner.assign({ memberId: 'mem_disena', brandId: 'brd_1' });
    await w.planner.assign({ memberId: 'mem_escribe', brandId: 'brd_1' });
    // Un miembro que nunca la recibió: no tiene por qué ver nada.
    expect(w.planner.membersUsing('con_agentcy').sort()).toEqual(['mem_disena', 'mem_escribe']);

    await rpc((servers[0] as { url: string }).url, (servers[0] as { token: string }).token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(w.events.map((e) => e.chatId).sort()).toEqual(['mem_disena', 'mem_escribe']);
    const first = w.events[0];
    expect(first).toMatchObject({ type: 'connection-expired', connectionId: 'con_agentcy', label: 'The Agentcy' });
  });

  it('un miembro que cerró su chat deja de recibirlo', async () => {
    const upstream = await startToyMcp({ validTokens: new Set<string>() });
    upstreams.push(upstream);
    const w = await wire(record({ url: upstream.url }), { con_agentcy: tokens('at_muerto') });
    const servers = await w.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    await w.planner.assign({ memberId: 'mem_2', brandId: 'brd_1' });
    w.planner.release('mem_1');
    expect(w.planner.membersUsing('con_agentcy')).toEqual(['mem_2']);
    await rpc((servers[0] as { url: string }).url, (servers[0] as { token: string }).token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    // El bearer de mem_1 ya no vale, así que esa llamada ni llegó al upstream;
    // lo que importa es que el aviso no se le mande a un chat cerrado.
    expect(w.events.map((e) => e.chatId)).not.toContain('mem_1');
  });

  it('queda escrito en el log con id, servidor, alcance y estado, y sin un solo secreto', async () => {
    const upstream = await startToyMcp({ validTokens: new Set<string>() });
    upstreams.push(upstream);
    const w = await wire(record({ url: upstream.url }), { con_agentcy: tokens('at_muerto') });
    const servers = await w.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    const bearer = (servers[0] as { token: string }).token;
    await rpc((servers[0] as { url: string }).url, bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const written = w.log.join('\n');
    expect(written).toContain('[conexiones] vencida: con_agentcy theagentcy alcance=brand:brd_1 estado=expired');
    // Los dos candados, sobre el mismo texto: ni el token del proveedor ni el
    // bearer que Latte emitió pueden aparecer en un archivo que alguien va a
    // pegar en un issue.
    expect(written).not.toContain('at_muerto');
    expect(written).not.toContain(bearer);
  });
});

describe('candados de secretos', () => {
  const server: AdapterMcpServer = { kind: 'http', name: 'latte_conn_theagentcy', url: 'http://127.0.0.1:2/c/con_1', token: 'bearer-secreto' };

  it('ningún token va en argv: Codex recibe el NOMBRE de la variable, no su valor', () => {
    const argv = codexMcpConfigOverrides([server]).join(' ');
    expect(argv).toContain('bearer_token_env_var=');
    expect(argv).not.toContain('bearer-secreto');
  });

  it('el config inline de OpenCode lleva `{env:VAR}`, no el bearer', () => {
    expect(opencodeMcpConfigContent([server])).not.toContain('bearer-secreto');
    expect(opencodeMcpConfigContent([server])).toContain('{env:LATTE_MCP_TOKEN_LATTE_CONN_THEAGENTCY}');
  });

  it('ningún bearer sobrevive al chat', async () => {
    const upstream = await startToyMcp({ validTokens: new Set(['at_bueno']) });
    upstreams.push(upstream);
    const w = await wire(record({ url: upstream.url }), { con_agentcy: tokens('at_bueno') });
    const servers = await w.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    const bearer = (servers[0] as { token: string }).token;
    expect((await rpc((servers[0] as { url: string }).url, bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

    w.planner.release('mem_1');

    expect(w.registry.verify(bearer)).toBeNull();
    expect(w.registry.size).toBe(0);
    // Y el gateway se apagó solo: sin un bearer vivo no hay a quién servirle.
    expect(w.gateway.listening).toBe(false);
  });

  it('el token del proveedor no cruza jamás hacia el miembro', async () => {
    const upstream = await startToyMcp({ validTokens: new Set(['at_del_proveedor']) });
    upstreams.push(upstream);
    const w = await wire(record({ url: upstream.url }), { con_agentcy: tokens('at_del_proveedor') });
    const servers = await w.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    // Lo que el adaptador va a escribir en el config del miembro: sólo el bearer de Latte.
    expect(JSON.stringify(servers)).not.toContain('at_del_proveedor');
    const response = await rpc((servers[0] as { url: string }).url, (servers[0] as { token: string }).token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(await response.text()).not.toContain('at_del_proveedor');
    expect(upstream.calls[0].bearer).toBe('at_del_proveedor');
  });
});

/**
 * Los dos arreglos chicos que el documento llama "hoy mentirosos" (sección 6,
 * paso 5): la caché de needs-auth indexada por nombre (1.4) y el perfil que se
 * lee al listar el registro del CLI (1.5).
 */
describe('la caché de needs-auth de Claude Code (1.4)', () => {
  it('saca las variantes del mismo nombre: mayúsculas y guiones no son servidores distintos', async () => {
    // Las tres entradas que hay de verdad en la máquina de Gabriel, medidas.
    const cache = { 'the-agentcy': { at: 1 }, Theagentcy: { at: 2 }, 'The-agentcy': { at: 3 }, sentry: { at: 4 } };
    const { next, removed } = withoutNeedsAuthEntries(cache, ['theagentcy']);
    expect(removed.sort()).toEqual(['The-agentcy', 'Theagentcy', 'the-agentcy']);
    expect(Object.keys(next)).toEqual(['sentry']);
  });

  it('un nombre que no está no toca nada', async () => {
    const cache = { sentry: { at: 1 } };
    const { next, removed } = withoutNeedsAuthEntries(cache, ['theagentcy']);
    expect(removed).toEqual([]);
    expect(next).toEqual(cache);
  });

  it('sobre el disco: sin archivo no explota, y con archivo lo reescribe', async () => {
    const dir = makeTempDir('latte-needsauth-');
    try {
      expect(clearNeedsAuthEntries(dir, ['theagentcy'])).toEqual([]);
      fs.writeFileSync(path.join(dir, NEEDS_AUTH_CACHE_FILE), JSON.stringify({ 'The-agentcy': { at: 1 }, sentry: { at: 2 } }));
      expect(clearNeedsAuthEntries(dir, ['theagentcy'])).toEqual(['The-agentcy']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, NEEDS_AUTH_CACHE_FILE), 'utf8'))).toEqual({ sentry: { at: 2 } });
      // Un archivo que no es JSON tampoco puede tirar nada.
      fs.writeFileSync(path.join(dir, NEEDS_AUTH_CACHE_FILE), 'no es json');
      expect(clearNeedsAuthEntries(dir, ['theagentcy'])).toEqual([]);
    } finally {
      removeDir(dir);
    }
  });
});
