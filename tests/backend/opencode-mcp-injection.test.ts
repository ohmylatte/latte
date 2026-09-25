import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { CoordinationInjectionPlanner, type MemberInjectionInput } from '../../electron/coordination/injection';
import {
  MAX_BOOTSTRAP_OPENCODE_MEMBERS_PER_WORK,
  MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN,
  MAX_COORDINATED_OPENCODE_PROCESSES,
} from '../../electron/coordination/limits';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import type { CoordinationRunRecord } from '../../electron/storage/repository';
import { ChatManager } from '../../electron/opencode/chatManager';
import { startFakeOpenCode } from './fakeOpenCode';
import { fakeOpenCodeSpawner, type FakeOpenCodeSpawner } from './fakeOpenCodeSpawn';

/**
 * S2 (paridad de OpenCode): INYECCIÓN MCP POR MIEMBRO.
 *
 * Con un proceso por miembro (S1), `OPENCODE_CONFIG_CONTENT` deja de ser del
 * servidor de todos y pasa a ser del miembro: coordinación, memoria y
 * conexiones, cada una con su bearer por variable de entorno. Y OpenCode SÍ
 * puede decir qué levantó: `GET /mcp` devuelve el estado de cada servidor
 * (verificado contra opencode 1.18.32: `{"latte_probe":{"status":"connected"}}`
 * y `{"x":{"status":"failed","error":"..."}}`).
 */

const coordination = (token: string): AdapterMcpServer => ({ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:4100/mcp', token });
const connection = (token: string): AdapterMcpServer => ({ kind: 'http', name: 'latte_conn_theagentcy', url: 'http://127.0.0.1:4200/c/con_1', token });
const memory: AdapterMcpServer = { kind: 'stdio', name: 'latte_memory', command: '/usr/bin/engram', args: ['mcp', '--tools=agent'], env: { ENGRAM_PROJECT: 'latte-brand-a' } };

describe('ChatManager: la inyección MCP de OpenCode es por miembro', () => {
  let spawner: FakeOpenCodeSpawner;
  let manager: ChatManager;

  beforeEach(() => {
    spawner = fakeOpenCodeSpawner({
      // Cada proceso contesta `GET /mcp` con lo que ESTE proceso recibió: el
      // de coordinación conectado, la memoria caída.
      mcpStatus: (env) => {
        const content = env.OPENCODE_CONFIG_CONTENT;
        if (!content) return undefined;
        const names = Object.keys((JSON.parse(content) as { mcp: Record<string, unknown> }).mcp);
        return Object.fromEntries(names.map((name) => [name, name === 'latte_memory' ? { status: 'failed', error: 'MCP error -32000: Connection closed' } : { status: 'connected' }]));
      },
    });
    manager = new ChatManager({
      resolveExecutable: async () => ({ executable: '/fake/opencode', version: '1.18.32' }),
      serverCwd: '/latte-data',
      emit: () => {},
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      spawnImpl: spawner.spawnImpl,
      killProcess: spawner.killProcess,
      clientTimeoutMs: 3_000,
      startupTimeoutMs: 3_000,
    });
  });

  afterEach(async () => {
    manager.shutdown();
    await spawner.closeAll();
  });

  it('declara inyección por miembro, y que puede confirmarla', () => {
    expect(manager.mcpInjection).toBe('per-member');
    expect(manager.confirmsMcpInjection).toBe(true);
  });

  it('el config de cada miembro tiene SUS servidores y no los del otro; el bearer nunca en el JSON ni en argv', async () => {
    await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', mcpServers: [coordination('tok-coord-a'), memory, connection('tok-conn-a')] });
    await manager.start({ workId: 'wrk_1', chatId: 'mem_b', directory: '/w/one', title: 'B', mcpServers: [coordination('tok-coord-b')] });

    const [a, b] = spawner.launches;
    const configA = JSON.parse(a.env.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> };
    const configB = JSON.parse(b.env.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> };
    expect(Object.keys(configA.mcp).sort()).toEqual(['latte_conn_theagentcy', 'latte_coordination', 'latte_memory']);
    expect(Object.keys(configB.mcp)).toEqual(['latte_coordination']);

    for (const [launch, secrets] of [[a, ['tok-coord-a', 'tok-conn-a']], [b, ['tok-coord-b']]] as const) {
      for (const secret of secrets) {
        expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain(secret);
        expect(launch.args.join(' ')).not.toContain(secret);
        expect(Object.values(launch.env)).toContain(secret);
      }
    }
    // Y ningún secreto del otro miembro llega a este proceso.
    expect(Object.values(b.env)).not.toContain('tok-coord-a');
    expect(Object.values(b.env)).not.toContain('tok-conn-a');
    expect(Object.values(a.env)).not.toContain('tok-coord-b');
  });

  it('reporta lo que el proceso CONECTÓ (GET /mcp), no lo que Latte le pidió', async () => {
    const result = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', mcpServers: [coordination('tok-a'), memory] });
    expect(result.injectedMcpServers).toEqual(['latte_coordination']);
    const fake = await spawner.launches[0].fake;
    expect(fake.requests.find((r) => r.path === '/mcp')?.query.get('directory')).toBe('/w/one');
  });

  it('sin nada que inyectar no pregunta, y la respuesta es "no sé" (undefined), no "cero servidores"', async () => {
    const result = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A' });
    expect(result.injectedMcpServers).toBeUndefined();
    expect((await spawner.launches[0].fake).requests.some((r) => r.path === '/mcp')).toBe(false);
  });

  it('un OpenCode que no sabe contestar /mcp tampoco confirma nada', async () => {
    const quiet = fakeOpenCodeSpawner();
    const other = new ChatManager({
      resolveExecutable: async () => ({ executable: '/fake/opencode', version: '1.0.0' }),
      serverCwd: '/latte-data', emit: () => {}, platform: 'linux', env: {},
      spawnImpl: quiet.spawnImpl, killProcess: quiet.killProcess, clientTimeoutMs: 3_000, startupTimeoutMs: 3_000,
    });
    try {
      const result = await other.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', mcpServers: [coordination('tok-a')] });
      expect(result.injectedMcpServers).toBeUndefined();
      expect(result.injectionRefusedByLatte).toBeFalsy();
    } finally {
      other.shutdown();
      await quiet.closeAll();
    }
  });

  it('contra un endpoint compartido (modo de prueba) no puede inyectar, y lo dice como negativa de Latte', async () => {
    const fake = await startFakeOpenCode();
    const shared = new ChatManager({ resolveExecutable: async () => null, serverCwd: '/latte-data', emit: () => {}, endpoint: fake.endpoint, clientTimeoutMs: 3_000 });
    try {
      const result = await shared.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', mcpServers: [coordination('tok-a')] });
      expect(result.injectionRefusedByLatte).toBe(true);
      expect(result.injectedMcpServers).toBeUndefined();
    } finally {
      shared.shutdown();
      await fake.close();
    }
  });
});

function activeRun(workId: string): CoordinationRunRecord {
  return {
    id: 'crn_' + workId, workId, status: 'running', coordinatorMemberId: null,
    budgetJson: '{"maxDispatches":10}', planJson: null, planApprovedAt: null, suspendReason: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePlanner(opts: { activeRuns?: Set<string>; engramBinary?: string | null } = {}) {
  const tokens = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
  const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 50999 };
  const planner = new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: (workId: string) => (opts.activeRuns?.has(workId) ? activeRun(workId) : null) },
    tokens,
    server,
    resolveClaudeVersion: async () => '2.1.263',
    resolveEngramBinary: async () => (opts.engramBinary === undefined ? '/usr/bin/engram' : opts.engramBinary),
  });
  return { planner, tokens, server };
}

const opencode = (over: Partial<MemberInjectionInput> = {}): MemberInjectionInput => ({ memberId: 'mem_1', workId: 'wrk_1', brandId: 'brd_1', runtime: 'opencode', accountId: null, ...over });

describe('CoordinationInjectionPlanner: OpenCode es elegible para coordinar', () => {
  it('un miembro de OpenCode con run activo recibe coordinación y memoria, sin motivo de degradación', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    const { servers, status } = await planner.assign(opencode());
    expect(servers?.map((s) => s.name)).toEqual(['latte_coordination', 'latte_memory']);
    expect(status).toMatchObject({ coordinationInjected: true, memoryInjected: true, canPropose: true, reason: null });
  });

  it('sin engram igual coordina, y el motivo nombra la memoria que falta', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']), engramBinary: null });
    const { servers, status } = await planner.assign(opencode());
    expect(servers?.map((s) => s.name)).toEqual(['latte_coordination']);
    expect(status.reason).toBe('engram_not_installed');
  });

  it(`sin run, sólo ${MAX_BOOTSTRAP_OPENCODE_MEMBERS_PER_WORK} miembro por Trabajo coordina (el que propone); el resto conserva la memoria`, async () => {
    const { planner } = makePlanner();
    const first = await planner.assign(opencode({ memberId: 'mem_1' }));
    const second = await planner.assign(opencode({ memberId: 'mem_2' }));
    expect(first.status.coordinationInjected).toBe(true);
    expect(second.status).toMatchObject({ coordinationInjected: false, memoryInjected: true, reason: 'opencode_run_cap' });
    expect(second.servers?.map((s) => s.name)).toEqual(['latte_memory']);
  });

  it(`con run, ${MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN} por run; el siguiente degrada con opencode_run_cap`, async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    for (let i = 0; i < MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN; i += 1) {
      expect((await planner.assign(opencode({ memberId: `mem_${i}` }))).status.coordinationInjected).toBe(true);
    }
    const extra = await planner.assign(opencode({ memberId: 'mem_extra' }));
    expect(extra.status).toMatchObject({ coordinationInjected: false, reason: 'opencode_run_cap' });
    // Soltar a uno libera su lugar.
    planner.release('mem_0');
    expect((await planner.assign(opencode({ memberId: 'mem_extra' }))).status.coordinationInjected).toBe(true);
  });

  it(`${MAX_COORDINATED_OPENCODE_PROCESSES} coordinados en toda la app; el siguiente degrada con opencode_global_cap`, async () => {
    const works = Array.from({ length: Math.ceil((MAX_COORDINATED_OPENCODE_PROCESSES + 1) / MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN) + 1 }, (_, i) => `wrk_${i}`);
    const { planner } = makePlanner({ activeRuns: new Set(works) });
    let granted = 0;
    for (const workId of works) {
      for (let i = 0; i < MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN && granted < MAX_COORDINATED_OPENCODE_PROCESSES; i += 1) {
        const { status } = await planner.assign(opencode({ memberId: `mem_${workId}_${i}`, workId }));
        expect(status.coordinationInjected).toBe(true);
        granted += 1;
      }
    }
    const extra = await planner.assign(opencode({ memberId: 'mem_extra', workId: works.at(-1)! }));
    expect(extra.status).toMatchObject({ coordinationInjected: false, memoryInjected: true, reason: 'opencode_global_cap' });
  });

  it('los topes de OpenCode y los de Codex no se comen entre sí', async () => {
    const { planner } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    for (let i = 0; i < MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN; i += 1) await planner.assign(opencode({ memberId: `mem_oc${i}` }));
    const codex = await planner.assign({ memberId: 'mem_cx', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex', accountId: 'sys' });
    expect(codex.status.coordinationInjected).toBe(true);
  });

  it('si el proceso no levantó la coordinación, el reclamo baja, el lugar se suelta y el token se revoca', async () => {
    const { planner, tokens } = makePlanner({ activeRuns: new Set(['wrk_1']) });
    const tokensByMember = new Map<string, string>();
    for (let i = 0; i < MAX_COORDINATED_OPENCODE_MEMBERS_PER_RUN; i += 1) {
      const { servers } = await planner.assign(opencode({ memberId: `mem_${i}` }));
      const http = servers?.find((s) => s.kind === 'http');
      if (http?.kind === 'http') tokensByMember.set(`mem_${i}`, http.token);
    }
    expect(tokens.verify(tokensByMember.get('mem_0')!)).not.toBeNull();
    planner.confirmInjection('mem_0', ['latte_memory']);
    expect(await planner.preview(opencode({ memberId: 'mem_0' }))).toMatchObject({ coordinationInjected: false, reason: 'runtime_refused_injection', runtimeConfirmed: true });
    expect(tokens.verify(tokensByMember.get('mem_0')!)).toBeNull();
    expect((await planner.assign(opencode({ memberId: 'mem_new' }))).status.coordinationInjected).toBe(true);
  });
});
