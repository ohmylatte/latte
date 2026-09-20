import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexChatAdapter } from '../../electron/agents/codex/codexAdapter';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { makeTempDir, removeDir } from './helpers';

const REPO_ROOT = join(__dirname, '..', '..');
const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

/**
 * Los dos restos del slice de despacho: la misma forma "leo antes de esperar,
 * actúo sobre lo viejo" que la causa raíz del brief, en dos lugares donde
 * todavía sobrevivía.
 */

describe('runTransaction decide sobre el run RELEÍDO, nunca sobre la foto vieja', () => {
  /** El cuerpo de `runTransaction`, desde su declaración hasta el `};` de cierre de la arrow. */
  const runTransactionBody = (): string => {
    const source = readFileSync(join(REPO_ROOT, 'electron', 'coordination', 'engine.ts'), 'utf8');
    const start = source.indexOf('const runTransaction = ()');
    expect(start).not.toBe(-1);
    const end = source.indexOf('outcome = this.deps.repo.transaction(runTransaction)', start);
    expect(end).not.toBe(-1);
    const body = source.slice(start, end);
    // Un test cuyo cuerpo depende de encontrar algo tiene que fallar cuando no
    // lo encuentra: sin esto, un `indexOf` desalineado deja una ventana vacía
    // y la aserción negada pasa por vacío.
    expect(body.split(/\r?\n/).length).toBeGreaterThan(40);
    return body;
  };

  it('relee el run antes de cualquier decisión', () => {
    expect(runTransactionBody()).toContain("if (live.status !== 'running')");
  });

  it('ninguna rama vuelve a preguntar si el run sigue `running`: el early-return ya lo garantizó', () => {
    const body = runTransactionBody();
    // El early-return de arriba tira si `live.status !== 'running'`, y de ahí
    // al final del cuerpo no hay un solo `await`. Las cuatro suspensiones
    // llevaban cada una un `if (live.status === 'running')` adelante: ramas
    // muertas que se leían como si protegieran algo. Se afirma el largo
    // primero (lo hace `runTransactionBody`) para que esta negación no pase
    // por vacío.
    // Sin los comentarios: el guard mira CÓDIGO. La prosa que explica por qué
    // esas ramas no están tiene que poder nombrarlas sin disparar el test.
    const code = body.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
    expect(code.length).toBeGreaterThan(20);
    expect(code.filter((line) => line.includes("live.status === 'running'"))).toEqual([]);
    // Y la comparación que SÍ manda sigue en pie, una sola vez.
    expect(code.filter((line) => line.includes("live.status !== 'running'"))).toHaveLength(1);
  });

  it('ninguna rama de denegación vuelve a mirar el `run` viejo', () => {
    const offenders = runTransactionBody()
      .split(/\r?\n/)
      .filter((line) => line.includes('run.status'));
    expect(offenders).toEqual([]);
  });
});

describe('Codex `send()` no puede resucitar un app-server pelado (crítico 9, la forma)', () => {
  it('un chat cuyo server desapareció falla con un error claro y no spawnea nada', async () => {
    const dir = makeTempDir();
    let spawns = 0;
    const adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: () => {},
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: unknown) => {
        spawns += 1;
        return spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2]);
      }) as typeof spawn,
      requestTimeoutMs: 5_000,
    });
    try {
      await adapter.start({ workId: 'wrk_1', chatId: 'mem_x1', directory: dir, title: 't', label: 'Codex', accountId: SYSTEM_ACCOUNT_ID });
      expect(spawns).toBe(1);
      // El server se murió y su entrada se fue del mapa, pero el chat quedó:
      // hoy `onExit` barre los chats, así que esto es inalcanzable — pero la
      // forma estaba, y `serverFor` habría levantado un proceso PELADO bajo la
      // clave coordinada, perdiendo la inyección en silencio.
      const servers = (adapter as unknown as { servers: Map<string, unknown> }).servers;
      expect(servers.size).toBe(1);
      const saved = [...servers.entries()];
      servers.clear();

      await expect(adapter.send('mem_x1', 'hola')).rejects.toThrow(/app-server|proceso/i);
      expect(spawns).toBe(1);
      // El proceso real sigue vivo: se lo devuelve al mapa para que
      // `shutdown()` lo pueda apagar y el temp dir se pueda borrar.
      for (const [key, value] of saved) servers.set(key, value);
    } finally {
      adapter.shutdown();
      removeDir(dir);
    }
  });
});
