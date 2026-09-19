import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { strayServerDir } from '../../electron/agents/codex/staleServers';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

/**
 * F9 y F10: dos cosas que los adaptadores afirmaban sin fundamento.
 *
 * F9. El `codex app-server` efímero de `listModels` anotaba su pid bajo una
 *     clave COMPARTIDA (`<cuenta>|ephemeral-models`). Dos `listModels`
 *     concurrentes —la pantalla de Ajustes con dos cuentas, un reintento
 *     encima del anterior— escriben el mismo archivo: el segundo pisa el pid
 *     del primero y, al cerrar, el primero en terminar BORRA la anotación del
 *     que sigue vivo. El barrido de arranque no se entera nunca de ese
 *     proceso: un `codex app-server` huérfano para siempre.
 * F10. `reportInjected` devolvía `[]` cuando no se pidió ningún servidor, sin
 *     preguntarle nada al runtime, e `injection.confirmInjection` lee
 *     cualquier array como "el runtime HABLÓ" y prende `runtimeConfirmed`. La
 *     pantalla afirmaba que el runtime confirmó algo que nadie le preguntó.
 *     `undefined` es "no sé", y es la verdad.
 */
describe('F9: el pid del `listModels` efímero es único por invocación', () => {
  let dir: string;

  function pidFiles(): string[] {
    try { return fs.readdirSync(strayServerDir(dir)).filter((f) => f.endsWith('.pid')); } catch { return []; }
  }

  function makeAdapter(onSpawn?: () => void): CodexChatAdapter {
    return new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        const child = spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
        // La anotación la escribe el `onSpawn` del propio `CodexAppServer`,
        // después de este retorno: se mira un tick más tarde, con los dos
        // procesos ya vivos (el mismo truco que el test D14 de al lado).
        setTimeout(() => onSpawn?.(), 5);
        return child;
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
  }

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { removeDir(dir); });

  it('dos `listModels` a la vez anotan DOS pids, y los olvidan los dos', async () => {
    let peak = 0;
    const adapter = makeAdapter(() => { peak = Math.max(peak, pidFiles().length); });

    await Promise.all([adapter.listModels(SYSTEM_ACCOUNT_ID), adapter.listModels(SYSTEM_ACCOUNT_ID)]);

    // Los dos procesos vivos a la vez estuvieron anotados a la vez: con la
    // clave compartida el segundo pisaba al primero y el pico era 1.
    expect(peak).toBe(2);
    // Y no quedó ninguna anotación fantasma: el barrido de arranque mataría un
    // pid que el sistema ya reasignó.
    expect(pidFiles()).toEqual([]);
    adapter.shutdown();
  });
});

describe('F10: `runtimeConfirmed` sólo lo enciende el runtime', () => {
  function makePlanner() {
    const tokens = new CoordinationTokenRegistry();
    const server = { ensureStarted: vi.fn(async () => {}), stopIfIdle: vi.fn(), boundPort: 55555 };
    return new CoordinationInjectionPlanner({
      repo: { findActiveCoordinationRun: () => ({}) },
      tokens,
      server,
      resolveClaudeVersion: async () => '2.1.263',
      resolveEngramBinary: async () => '/usr/bin/engram',
    } as unknown as ConstructorParameters<typeof CoordinationInjectionPlanner>[0]);
  }

  function codexAdapter(dir: string): CodexChatAdapter {
    return new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: (() => { throw new Error('no se spawnea nada acá'); }) as unknown as typeof spawn,
      requestTimeoutMs: 5_000,
    });
  }

  it('Codex sin servidores pedidos devuelve `undefined`, no `[]`', async () => {
    const dir = makeTempDir();
    const adapter = codexAdapter(dir);
    const reportInjected = (adapter as unknown as {
      reportInjected: (server: unknown, mcpServers: unknown) => Promise<string[] | undefined>;
    }).reportInjected.bind(adapter);
    // Si preguntara algo, esto explotaría: el punto es que NO pregunta y por lo
    // tanto no puede afirmar nada sobre lo que el runtime conectó.
    const fakeServer = { request: () => { throw new Error('no se pregunta'); } };

    await expect(reportInjected(fakeServer, [])).resolves.toBeUndefined();
    await expect(reportInjected(fakeServer, undefined)).resolves.toBeUndefined();

    removeDir(dir);
  });

  it('y por eso el miembro no queda "confirmado por el runtime"', async () => {
    const dir = makeTempDir();
    const adapter = codexAdapter(dir);
    const reportInjected = (adapter as unknown as {
      reportInjected: (server: unknown, mcpServers: unknown) => Promise<string[] | undefined>;
    }).reportInjected.bind(adapter);
    const planner = makePlanner();
    const input = { memberId: 'mem_n', workId: 'wrk_1', brandId: 'brd_1', runtime: 'codex' as const, accountId: 'sys' };
    await planner.assign(input);

    // Exactamente lo que hace el hub: lo que el adaptador reportó, tal cual.
    planner.confirmInjection('mem_n', await reportInjected({ request: () => { throw new Error('no se pregunta'); } }, []));

    const status = await planner.preview(input);
    expect(status.runtimeConfirmed).toBe(false);
    removeDir(dir);
  });
});
