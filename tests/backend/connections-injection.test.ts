/**
 * La inyección por miembro en los tres runtimes (G4 del brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 *
 * Dos cosas distintas y las dos hacen falta: QUÉ conexiones le tocan a un
 * miembro (la resolución marca→global convertida en `AdapterMcpServer[]`) y
 * CÓMO las traduce cada adaptador (Claude por `headers`, Codex por
 * `bearer_token_env_var`, OpenCode por `OPENCODE_CONFIG_CONTENT`).
 */
import { describe, expect, it } from 'vitest';
import { ConnectionInjectionPlanner, connectionServerName, type ConnectionInjectionRepoPort } from '../../electron/connections/injection';
import { GatewayTokenRegistry } from '../../electron/connections/gatewayTokens';
import { codexMcpConfigEnv, codexMcpConfigOverrides, codexTokenEnvVar, mcpFingerprint } from '../../electron/agents/codex/mcpFingerprint';
import { opencodeMcpConfigContent, opencodeMcpEnv, opencodeTokenEnvVar } from '../../electron/opencode/mcpConfig';
import type { AdapterMcpServer } from '../../electron/agents/types';
import type { ConnectionRecord } from '../../electron/storage/connectionsRepository';

const record = (over: Partial<ConnectionRecord> & Pick<ConnectionRecord, 'id' | 'name'>): ConnectionRecord => ({
  label: over.name,
  url: 'https://ejemplo.test/mcp',
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

function harness(resolved: ConnectionRecord[], options: { withTokens?: string[]; failGateway?: boolean } = {}) {
  const withTokens = new Set(options.withTokens ?? resolved.map((r) => r.id));
  const repo: ConnectionInjectionRepoPort = {
    resolveForBrand: () => resolved,
    hasTokens: (id) => withTokens.has(id),
  };
  const tokens = new GatewayTokenRegistry();
  const audit: Array<Record<string, string>> = [];
  let started = 0;
  let stopped = 0;
  const planner = new ConnectionInjectionPlanner({
    repo,
    tokens,
    gateway: {
      ensureStarted: async () => {
        if (options.failGateway) throw new Error('no ató puerto');
        started += 1;
      },
      stopIfIdle: () => { stopped += 1; },
      urlFor: (id) => `http://127.0.0.1:4242/c/${id}`,
    },
    audit: (event) => audit.push(event as unknown as Record<string, string>),
  });
  return { planner, tokens, audit, counts: () => ({ started, stopped }) };
}

describe('qué conexiones le tocan a un miembro', () => {
  it('una conexión por servidor, namespaceada y apuntando al gateway', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' })]);
    const servers = await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    expect(servers).toEqual([{
      kind: 'http',
      name: 'latte_conn_theagentcy',
      url: 'http://127.0.0.1:4242/c/con_1',
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);
    // La URL es la del gateway, jamás la del proveedor.
    expect(servers[0]).not.toMatchObject({ url: expect.stringContaining('ejemplo.test') });
  });

  it('sin conexiones no inyecta nada y ni siquiera levanta el gateway', async () => {
    const h = harness([]);
    expect(await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' })).toEqual([]);
    expect(h.counts().started).toBe(0);
  });

  it('una conexión sin credenciales guardadas todavía no se inyecta', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' })], { withTokens: [] });
    expect(await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' })).toEqual([]);
  });

  it('una conexión VENCIDA sí se inyecta: es como el miembro se entera', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy', state: 'expired' })]);
    const servers = await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    expect(servers).toHaveLength(1);
  });

  it('si el gateway no arranca, el miembro va sin estas herramientas en vez de con una URL muerta', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' })], { failGateway: true });
    expect(await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' })).toEqual([]);
  });

  it('cada miembro recibe un bearer distinto para la misma conexión', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' })]);
    const a = await h.planner.assign({ memberId: 'mem_a', brandId: 'brd_1' });
    const b = await h.planner.assign({ memberId: 'mem_b', brandId: 'brd_2' });
    expect((a[0] as { token: string }).token).not.toBe((b[0] as { token: string }).token);
  });

  it('volver a abrir un miembro reemplaza sus bearers: el viejo deja de valer', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' })]);
    const first = (await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' }))[0] as { token: string };
    const second = (await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' }))[0] as { token: string };
    expect(second.token).not.toBe(first.token);
    expect(h.tokens.verify(first.token)).toBeNull();
    expect(h.tokens.verify(second.token)).not.toBeNull();
  });

  it('cerrar el chat revoca TODO lo del miembro y apaga el gateway si no queda nadie', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy' }), record({ id: 'con_2', name: 'gmail' })]);
    const servers = await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    expect(servers).toHaveLength(2);
    h.planner.release('mem_1');
    for (const server of servers) expect(h.tokens.verify((server as { token: string }).token)).toBeNull();
    expect(h.tokens.size).toBe(0);
    expect(h.counts().stopped).toBe(1);
  });

  it('el registro de auditoría lleva id, servidor, alcance y estado, y NINGÚN secreto', async () => {
    const h = harness([record({ id: 'con_1', name: 'theagentcy', scope: 'brand', brandId: 'brd_1' })]);
    const servers = await h.planner.assign({ memberId: 'mem_1', brandId: 'brd_1' });
    expect(h.audit).toEqual([{ connectionId: 'con_1', name: 'theagentcy', scope: 'brand', state: 'connected', memberId: 'mem_1' }]);
    const written = JSON.stringify(h.audit);
    expect(written).not.toContain((servers[0] as { token: string }).token);
  });

  it('el nombre namespaceado es estable y no puede chocar con un servidor del registro del CLI', () => {
    expect(connectionServerName('theagentcy')).toBe('latte_conn_theagentcy');
  });
});

describe('cómo lo traduce cada runtime', () => {
  const coordination: AdapterMcpServer = { kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:1/c', token: 'tok-coord' };
  const connection: AdapterMcpServer = { kind: 'http', name: 'latte_conn_theagentcy', url: 'http://127.0.0.1:2/c/con_1', token: 'tok-conn' };
  const memory: AdapterMcpServer = { kind: 'stdio', name: 'latte_memory', command: '/bin/engram', args: ['mcp'] };

  it('Codex le da a CADA servidor http su propia variable de entorno', () => {
    const overrides = codexMcpConfigOverrides([coordination, connection]);
    expect(overrides).toContain('mcp_servers.latte_coordination.bearer_token_env_var=LATTE_COORD_TOKEN');
    expect(overrides).toContain('mcp_servers.latte_conn_theagentcy.bearer_token_env_var=LATTE_MCP_TOKEN_LATTE_CONN_THEAGENTCY');
    // Y ningún token en los `-c`: eso sería argv, visible para todo proceso de la máquina.
    expect(overrides.join(' ')).not.toContain('tok-coord');
    expect(overrides.join(' ')).not.toContain('tok-conn');
  });

  it('...y los pone TODOS en el env, no sólo el primero', () => {
    expect(codexMcpConfigEnv([coordination, connection, memory])).toEqual({
      LATTE_COORD_TOKEN: 'tok-coord',
      LATTE_MCP_TOKEN_LATTE_CONN_THEAGENTCY: 'tok-conn',
    });
  });

  it('el nombre de la variable de coordinación no cambió', () => {
    expect(codexTokenEnvVar('latte_coordination')).toBe('LATTE_COORD_TOKEN');
  });

  it('dos conexiones distintas nunca comparten variable', () => {
    expect(codexTokenEnvVar('latte_conn_theagentcy')).not.toBe(codexTokenEnvVar('latte_conn_gmail'));
  });

  it('la huella de proceso de Codex separa a dos miembros con la misma conexión', () => {
    const a = mcpFingerprint([{ ...connection, token: 'tok-a' } as AdapterMcpServer]);
    const b = mcpFingerprint([{ ...connection, token: 'tok-b' } as AdapterMcpServer]);
    expect(a).not.toBe(b);
  });

  it('OpenCode arma un `mcp` remoto con el bearer por `{env:VAR}`, nunca en el JSON', () => {
    const content = JSON.parse(opencodeMcpConfigContent([connection])) as { mcp: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(content.mcp.latte_conn_theagentcy).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:2/c/con_1',
      enabled: true,
      headers: { Authorization: `Bearer {env:${opencodeTokenEnvVar('latte_conn_theagentcy')}}` },
    });
    expect(JSON.stringify(content)).not.toContain('tok-conn');
  });

  it('...y el token real viaja en el env del proceso, junto con el config inline', () => {
    const env = opencodeMcpEnv([connection]);
    expect(env.LATTE_MCP_TOKEN_LATTE_CONN_THEAGENTCY).toBe('tok-conn');
    expect(env.OPENCODE_CONFIG_CONTENT).toContain('latte_conn_theagentcy');
    expect(opencodeMcpEnv([])).toEqual({});
  });
});
