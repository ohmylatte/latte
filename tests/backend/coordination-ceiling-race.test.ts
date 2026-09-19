import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { MAX_COORDINATED_CODEX_MEMBERS_PER_RUN, MAX_COORDINATED_CODEX_PROCESSES } from '../../electron/coordination/limits';
import { deferred, makeTempDir, removeDir, settle } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

/**
 * Los cupos de procesos de Codex, que eran check-then-act entre miembros
 * DISTINTOS (crítico 10): se leía el contador, se esperaba algo lento, y recién
 * después se marcaba. Los locks que existen son por miembro, así que dos
 * miembros distintos abriendo a la vez leían los dos la misma foto de "hay
 * lugar" y entraban los dos.
 *
 * Los dos contadores —el del planificador y el del adaptador— tienen su propio
 * test, porque son dos implementaciones del mismo techo.
 */

// --- S3: el contador del planificador ---------------------------------------

function makePlanner(opts: { hold?: () => Promise<void> | null; ensureStarted?: () => Promise<void> }) {
  return new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: () => ({}) },
    tokens: new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z'),
    server: {
      ensureStarted: opts.ensureStarted ?? (async () => undefined),
      stopIfIdle: () => undefined,
      boundPort: 7777,
    },
    resolveClaudeVersion: async () => '2.1.300',
    resolveEngramBinary: async () => {
      // La espera lenta que NO depende de cupos. Es el await que partía en dos
      // la lectura y la marca.
      const pending = opts.hold?.();
      if (pending) await pending;
      return '/usr/bin/engram';
    },
  });
}

describe('CoordinationInjectionPlanner: el cupo se lee y se marca en el mismo tick (crítico 10)', () => {
  it('dos miembros DISTINTOS abriendo a la vez con un solo cupo libre: coordina exactamente uno', async () => {
    let hold: Promise<void> | null = null;
    const planner = makePlanner({ hold: () => hold });

    // Se llenan todos los cupos menos uno. Van repartidos entre Trabajos porque
    // el cupo por run (3) es más chico que el de la app (6).
    let seeded = 0;
    for (let work = 1; seeded < MAX_COORDINATED_CODEX_PROCESSES - 1; work += 1) {
      for (let i = 0; i < MAX_COORDINATED_CODEX_MEMBERS_PER_RUN && seeded < MAX_COORDINATED_CODEX_PROCESSES - 1; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const seedResult = await planner.assign({ memberId: `mem_seed_${seeded}`, workId: `wrk_seed_${work}`, brandId: 'brd', runtime: 'codex', accountId: null });
        expect(seedResult.status.coordinationInjected).toBe(true);
        seeded += 1;
      }
    }
    expect(seeded).toBe(MAX_COORDINATED_CODEX_PROCESSES - 1);

    // Los dos miembros nuevos entran a la vez y se quedan esperando adentro.
    const gate = deferred();
    hold = gate.promise;
    const a = planner.assign({ memberId: 'mem_a', workId: 'wrk_a', brandId: 'brd', runtime: 'codex', accountId: null });
    const b = planner.assign({ memberId: 'mem_b', workId: 'wrk_b', brandId: 'brd', runtime: 'codex', accountId: null });
    await settle();
    gate.resolve();
    const [resultA, resultB] = await Promise.all([a, b]);

    // Antes entraban LOS DOS: siete procesos coordinados con un techo de seis.
    const coordinated = [resultA, resultB].filter((r) => r.status.coordinationInjected);
    expect(coordinated).toHaveLength(1);
    const degraded = [resultA, resultB].find((r) => !r.status.coordinationInjected);
    expect(degraded?.status.reason).toBe('codex_global_cap');
    // Degradar la coordinación nunca se lleva puesta a la memoria (task 6.39).
    expect(degraded?.status.memoryInjected).toBe(true);
  });

  it('si el servidor MCP no arranca, el cupo reservado se COMPENSA y la memoria sobrevive', async () => {
    let fails = true;
    const planner = makePlanner({
      ensureStarted: async () => { if (fails) throw new Error('EADDRINUSE'); },
    });

    const refused = await planner.assign({ memberId: 'mem_a', workId: 'wrk_a', brandId: 'brd', runtime: 'codex', accountId: null });
    expect(refused.status.coordinationInjected).toBe(false);
    expect(refused.status.reason).toBe('coordination_server_unavailable');
    expect(refused.status.memoryInjected).toBe(true);
    expect(refused.servers?.map((s) => s.name)).toEqual(['latte_memory']);

    // Y el cupo no quedó comido: los seis siguen disponibles. Sin compensación,
    // el sexto de abajo se caía por `codex_global_cap`.
    fails = false;
    let granted = 0;
    for (let work = 1; granted < MAX_COORDINATED_CODEX_PROCESSES; work += 1) {
      for (let i = 0; i < MAX_COORDINATED_CODEX_MEMBERS_PER_RUN && granted < MAX_COORDINATED_CODEX_PROCESSES; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const result = await planner.assign({ memberId: `mem_ok_${granted}`, workId: `wrk_ok_${work}`, brandId: 'brd', runtime: 'codex', accountId: null });
        expect(result.status.coordinationInjected).toBe(true);
        granted += 1;
      }
    }
    expect(granted).toBe(MAX_COORDINATED_CODEX_PROCESSES);
  });
});

// --- S4: el segundo contador, el del adaptador -------------------------------

function coordServer(token: string): AdapterMcpServer[] {
  return [{ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:59999/mcp', token }];
}

describe('CodexChatAdapter: su propio contador también reserva antes de esperar (crítico 10)', () => {
  let events: ChatEvent[];
  let adapter: CodexChatAdapter;
  let dir: string;
  let hold: Promise<void> | null;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
    hold = null;
  });
  afterEach(() => { adapter?.shutdown(); removeDir(dir); });

  it('dos miembros abriendo a la vez con un solo cupo libre: un solo proceso coordinado nuevo', async () => {
    const spawned: Array<{ args: string[] }> = [];
    adapter = new CodexChatAdapter({
      resolveExecutable: async () => {
        // `resolveExecutable` es el await que estaba ENTRE el conteo y la marca.
        if (hold) await hold;
        return { executable: process.execPath, version: '0.154.0' };
      },
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        spawned.push({ args });
        return spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
      maxChats: MAX_COORDINATED_CODEX_PROCESSES + 4,
    });

    for (let i = 0; i < MAX_COORDINATED_CODEX_PROCESSES - 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await adapter.start({
        workId: 'wrk_1', chatId: `mem_seed_${i}`, roleId: 'copywriter', roleName: 'Copywriter',
        directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
        mcpServers: coordServer(`tok_seed_${i}`),
      });
    }
    expect(spawned).toHaveLength(MAX_COORDINATED_CODEX_PROCESSES - 1);

    const gate = deferred();
    hold = gate.promise;
    const a = adapter.start({
      workId: 'wrk_1', chatId: 'mem_a', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID, mcpServers: coordServer('tok_a'),
    });
    const b = adapter.start({
      workId: 'wrk_1', chatId: 'mem_b', roleId: 'copywriter', roleName: 'Copywriter',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID, mcpServers: coordServer('tok_b'),
    });
    await settle();
    gate.resolve();
    await Promise.all([a, b]);

    // Los dos chats arrancan igual (degradar nunca es un fallo duro), pero sólo
    // uno de los dos procesos nuevos lleva los `-c` de coordinación: antes los
    // dos leían el mismo contador viejo y entraban los dos, séptimo incluido.
    const fresh = spawned.slice(MAX_COORDINATED_CODEX_PROCESSES - 1);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.filter((s) => s.args.includes('-c'))).toHaveLength(1);
  });
});
