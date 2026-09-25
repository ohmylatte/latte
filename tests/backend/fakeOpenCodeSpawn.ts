import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fakeOpenCodeStore, startFakeOpenCode, type FakeOpenCode, type FakeOpenCodeStore } from './fakeOpenCode';

/**
 * Lo que `OpenCodeServer` lanzaría de verdad, pero sin binario: cada "spawn"
 * levanta un `startFakeOpenCode` con la contraseña que el servidor real leería
 * de SU entorno (`OPENCODE_SERVER_PASSWORD`) y anuncia su URL por stdout, como
 * `opencode serve`. Así el camino entero —spawn, env, anuncio, Basic auth— es
 * el de producción, y cada proceso es un fake distinto con su propio puerto.
 *
 * Todos comparten un `store`: los procesos reales de OpenCode comparten el
 * directorio de datos del usuario, y eso es lo que permite reanudar una sesión
 * en otro proceso (verificado con opencode 1.18.32).
 */
export interface FakeLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  child: ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  fake: Promise<FakeOpenCode>;
  killed: boolean;
  /** Simula que el proceso se muere solo (crash): emite `exit` como el hijo real. */
  crash(code?: number): void;
}

export interface FakeOpenCodeSpawner {
  spawnImpl: typeof spawn;
  killProcess: (child: ChildProcess) => void;
  launches: FakeLaunch[];
  store: FakeOpenCodeStore;
  live(): FakeLaunch[];
  closeAll(): Promise<void>;
}

export function fakeOpenCodeSpawner(options: { scriptedReply?: boolean; mcpStatus?: (env: Record<string, string>) => Record<string, unknown> | undefined } = {}): FakeOpenCodeSpawner {
  const store = fakeOpenCodeStore();
  const launches: FakeLaunch[] = [];
  const spawnImpl = ((file: string, args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
    const env = Object.fromEntries(Object.entries(spawnOptions.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const child = new EventEmitter() as FakeLaunch['child'];
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    Object.assign(child, { exitCode: null, signalCode: null, pid: undefined, kill: () => true });
    const fake = startFakeOpenCode({ password: env.OPENCODE_SERVER_PASSWORD, store, scriptedReply: options.scriptedReply, mcpStatus: options.mcpStatus?.(env) });
    const launch: FakeLaunch = {
      file,
      args: [...args],
      env,
      child,
      fake,
      killed: false,
      crash: (code = 1) => {
        Object.assign(child, { exitCode: code });
        child.emit('exit', code, null);
      },
    };
    launches.push(launch);
    void fake.then((server) => child.stdout.write(`opencode server listening on ${server.endpoint.baseUrl}\n`));
    return child;
  }) as unknown as typeof spawn;
  const killProcess = (child: ChildProcess) => {
    const launch = launches.find((l) => l.child === child);
    if (!launch || launch.killed) return;
    launch.killed = true;
    Object.assign(child, { exitCode: 0 });
    void launch.fake.then((server) => server.close()).then(() => child.emit('exit', 0, null));
  };
  return {
    spawnImpl,
    killProcess,
    launches,
    store,
    live: () => launches.filter((l) => !l.killed && (l.child as ChildProcess).exitCode === null),
    closeAll: async () => {
      await Promise.all(launches.map(async (l) => (await l.fake).close().catch(() => undefined)));
    },
  };
}
