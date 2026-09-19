import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { CodexAppServer } from '../../electron/agents/codex/appServer';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { MAX_COORDINATED_CODEX_PROCESSES } from '../../electron/coordination/limits';
import { strayServerDir } from '../../electron/agents/codex/staleServers';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function coordServer(token: string): AdapterMcpServer[] {
  return [{ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:59999/mcp', token }];
}

function pidFiles(dir: string): string[] {
  try {
    return fs.readdirSync(strayServerDir(dir)).filter((f) => f.endsWith('.pid'));
  } catch {
    return [];
  }
}

/**
 * Crítico 9: cuando `ensure()` o `thread/start` fallaban, el proceso YA estaba
 * spawneado y nadie lo apagaba. Y como el `serverKey` lleva un token aleatorio
 * adentro, nadie podía recomputar esa clave nunca: el proceso quedaba vivo,
 * inalcanzable, contando contra el cupo y —porque el pid se grababa DESPUÉS de
 * `ensure()`— sin archivo de pid que permitiera barrerlo al próximo arranque.
 */
describe('CodexAppServer: el pid se anota antes de `initialize`, no después', () => {
  it('`onSpawn` corre aunque el arranque falle enseguida', async () => {
    const seen: number[] = [];
    const server = new CodexAppServer({
      executable: process.execPath,
      env: { PATH: process.env.PATH ?? '', FAKE_CODEX_FAIL_INITIALIZE: '1' },
      cwd: process.cwd(),
      platform: 'linux',
      requestTimeoutMs: 5_000,
      onSpawn: (pid) => seen.push(pid),
      spawnImpl: ((file: string, args: string[], options: unknown) => spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
    });

    await expect(server.ensure()).rejects.toThrow(/initialize refused/);

    // El pid tiene que haberse conocido ANTES del fallo: es lo único que
    // permite barrer ese proceso si Latte se cae acá mismo.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
    server.stop();
  });
});

describe('CodexChatAdapter: mata lo que no pudo arrancar (crítico 9)', () => {
  let events: ChatEvent[];
  let adapter: CodexChatAdapter;
  let dir: string;
  let children: ChildProcess[];
  let spawnedArgs: string[][];
  /** Se lee en CADA spawn, así un mismo adaptador puede fallar primero y andar después. */
  let failure: Record<string, string>;

  function makeAdapter() {
    return new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.154.0' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({ ...failure }),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        spawnedArgs.push(args);
        const child = spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
        children.push(child);
        return child;
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
  }

  beforeEach(() => {
    events = [];
    children = [];
    spawnedArgs = [];
    failure = {};
    dir = makeTempDir();
  });
  afterEach(() => {
    adapter?.shutdown();
    for (const child of children) { try { child.kill(); } catch { /* ya muerto */ } }
    removeDir(dir);
  });

  it('un `initialize` que falla deja el proceso muerto, sin pid file y sin cupo comido', async () => {
    failure = { FAKE_CODEX_FAIL_INITIALIZE: '1' };
    adapter = makeAdapter();

    await expect(adapter.start({
      workId: 'wrk_1', chatId: 'mem_a', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_a'),
    })).rejects.toThrow();

    expect(children).toHaveLength(1);
    // El hijo ya spawneado se mata: antes quedaba vivo e inalcanzable.
    await waitFor(() => children[0].exitCode !== null || children[0].signalCode !== null || children[0].killed);
    // El pid se anotó y se olvidó: no queda nada que el barrido de arranque
    // tenga que reapear, y nada que apunte a un pid que el SO puede reasignar.
    expect(pidFiles(dir)).toHaveLength(0);
    expect(adapter.owns('mem_a')).toBe(false);
  });

  it('un `thread/start` que falla apaga el server que se quedó sin ningún chat', async () => {
    failure = { FAKE_CODEX_FAIL_THREAD_START: '1' };
    adapter = makeAdapter();

    await expect(adapter.start({
      workId: 'wrk_1', chatId: 'mem_a', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_a'),
    })).rejects.toThrow(/Could not start a Codex thread/);

    expect(children).toHaveLength(1);
    await waitFor(() => children[0].exitCode !== null || children[0].signalCode !== null || children[0].killed);
    expect(pidFiles(dir)).toHaveLength(0);
    expect(adapter.owns('mem_a')).toBe(false);
  });

  it('el cupo de coordinación se libera: seis arranques fallidos no dejan al séptimo sin inyección', async () => {
    adapter = makeAdapter();
    failure = { FAKE_CODEX_FAIL_THREAD_START: '1' };
    for (let i = 0; i < MAX_COORDINATED_CODEX_PROCESSES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(adapter.start({
        workId: 'wrk_1', chatId: `mem_f${i}`, roleId: 'strategist', roleName: 'Strategist',
        directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
        mcpServers: coordServer(`tok_f${i}`),
      })).rejects.toThrow();
    }
    expect(spawnedArgs).toHaveLength(MAX_COORDINATED_CODEX_PROCESSES);

    // EL MISMO adaptador, ahora sin fallar. Sin la compensación, los seis
    // `serverKey` quedaban adentro de `coordinatedServerKeys` y este miembro
    // perdía su inyección — y esas claves llevan un token aleatorio adentro,
    // así que nadie podía recuperar esos cupos nunca.
    failure = {};
    await adapter.start({
      workId: 'wrk_1', chatId: 'mem_ok', roleId: 'strategist', roleName: 'Strategist',
      directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID,
      mcpServers: coordServer('tok_ok'),
    });
    expect(adapter.owns('mem_ok')).toBe(true);
    expect(spawnedArgs.at(-1)).toContain('-c');
  });
});
