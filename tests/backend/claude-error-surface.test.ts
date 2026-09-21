import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { SYSTEM_ACCOUNT_ID } from '../../electron/agents/accounts';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { createFileLog } from '../../electron/core/fileLog';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * EL ERROR REAL DE CLAUDE CODE SE VE Y SE LOGUEA.
 *
 * Un miembro fallo dos turnos seguidos y la persona leyo "Claude Code reported
 * an error", sin una linea en consola ni en disco: el adaptador construia el
 * mensaje con `msg.result` y tiraba TODO lo demas. El `result` de un turno
 * roto no trae `result`: trae `subtype` y un array `errors`.
 */
describe('la superficie de error del adaptador de Claude', () => {
  let events: ChatEvent[];
  let logs: string[];
  let adapter: ClaudeChatAdapter;
  let dir: string;

  const make = () => new ClaudeChatAdapter({
    resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.278' }),
    emit: (e) => events.push(e),
    accountEnv: (accountId): Record<string, string> => (accountId && accountId !== SYSTEM_ACCOUNT_ID ? { CLAUDE_CONFIG_DIR: `C:\\managed\\${accountId}` } : {}),
    spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CLAUDE, ...args], options)) as typeof spawn,
    platform: 'linux',
    env: { PATH: process.env.PATH ?? '' },
    log: (line) => logs.push(line),
  });

  beforeEach(() => {
    events = [];
    logs = [];
    dir = makeTempDir();
    adapter = make();
  });

  afterEach(() => {
    adapter.shutdown();
    removeDir(dir);
  });

  const start = () => adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null });
  /**
   * Los eventos de ESTE chat. El proceso falso del test anterior puede seguir
   * escupiendo una linea mientras este ya arranco, y su `idle` daba por
   * terminado un turno que todavia no habia empezado.
   */
  const of = (chatId: string, type: ChatEvent['type']) => events.filter((e) => e.chatId === chatId && e.type === type);

  it('un `result` sin `result` pero con `errors` dice el subtype y el detalle, y deja la linea cruda en el log', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'sin-result');
    await waitFor(() => of(session.id, 'error').length > 0);

    expect(of(session.id, 'error')[0]).toMatchObject({ message: 'error_during_execution: boom' });
    const message = adapter.listMessages(session.id).at(-1);
    expect(message?.error).toBe('error_during_execution: boom');
    expect(message?.completed).toBe(true);

    // La linea cruda: sin `session_id` ni `usage`, que son ruido para quien
    // diagnostica y son lo unico identificable del usuario que hay ahi.
    const raw = logs.find((l) => l.includes('result error:'));
    expect(raw, logs.join('\n')).toBeDefined();
    expect(raw).toContain(`[claude ${session.id}] result error:`);
    expect(raw).toContain('error_during_execution');
    expect(raw).toContain('boom');
    expect(raw).not.toContain('sess-fake-0001');
    expect(raw).not.toContain('input_tokens');
  });

  it('un `result` con texto propio lo sigue mostrando, prefijado por su subtype', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'please fail');
    await waitFor(() => of(session.id, 'error').length > 0);
    expect(of(session.id, 'error')[0]).toMatchObject({ message: 'error_during_execution: Simulated failure' });
  });

  it('un turno que sale bien no ensucia el log ni emite un error', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'hola');
    await waitFor(() => of(session.id, 'usage').length > 0);
    expect(of(session.id, 'error')).toEqual([]);
    expect(logs.filter((l) => l.includes('result error:'))).toEqual([]);
  });

  it('un `rate_limit_event` rechazado avisa con la hora de reinicio y queda logueado', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'limite-rechazado');
    await waitFor(() => of(session.id, 'error').length > 0);

    const when = new Date(1758400000 * 1000).toLocaleString();
    const error = of(session.id, 'error')[0];
    expect(error).toMatchObject({ chatId: session.id });
    expect((error as { message: string }).message).toContain(when);
    expect((error as { message: string }).message).toContain('five_hour');
    expect(logs.some((l) => l.includes(`[claude ${session.id}] rate limit:`) && l.includes('rejected'))).toBe(true);
  });

  it('un `rate_limit_event` permitido no avisa a nadie, pero se loguea cuando el uso ya raspa el techo', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'limite-permitido');
    await waitFor(() => logs.some((l) => l.includes(`[claude ${session.id}] rate limit:`)));
    await waitFor(() => of(session.id, 'usage').length > 0);
    expect(of(session.id, 'error')).toEqual([]);
    expect(logs.some((l) => l.includes(`[claude ${session.id}] rate limit:`) && l.includes('allowed') && l.includes('0.97'))).toBe(true);
  });

  it('un `system` con un subtype que Latte no maneja deja su texto en el log', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'informativo');
    await waitFor(() => logs.some((l) => l.includes(`[claude ${session.id}] system/informational:`)));
    expect(logs.some((l) => l.includes(`[claude ${session.id}] system/informational:`) && l.includes('el modelo cambio a sonnet'))).toBe(true);
  });
});

/**
 * La consola del proceso principal no existe en la app empaquetada, asi que un
 * log que solo va a `console.log` es un log que nadie va a leer nunca.
 */
describe('el sink de archivo del log', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => removeDir(dir));

  it('escribe cada linea en `logs/agents.log`, creando la carpeta', () => {
    const file = path.join(dir, 'logs', 'agents.log');
    const log = createFileLog(file);
    log('[claude chat_1] result error: boom');
    log('[claude chat_1] rate limit: rejected');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('result error: boom');
    expect(text).toContain('rate limit: rejected');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('rota a `.1` cuando pasa el tope, y empieza de nuevo', () => {
    const file = path.join(dir, 'logs', 'agents.log');
    // Cada linea pesa ~74 bytes con su marca de tiempo, asi que la cuarta es
    // la que encuentra el archivo pasado de tope y lo rota.
    const log = createFileLog(file, { maxBytes: 200 });
    for (let i = 0; i < 4; i += 1) log(`linea ${i} con relleno suficiente para pasar el tope`);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    const rotated = fs.readFileSync(`${file}.1`, 'utf8');
    expect(rotated).toContain('linea 0');
    expect(rotated).toContain('linea 2');
    // Y el archivo vivo arranca de cero: la generacion vieja no se duplica.
    const current = fs.readFileSync(file, 'utf8');
    expect(current).toContain('linea 3');
    expect(current).not.toContain('linea 0');
  });

  it('un log que no puede escribir no tira la app', () => {
    const log = createFileLog(path.join(dir, 'logs', 'agents.log'), {
      appendFileSyncImpl: () => { throw new Error('EACCES'); },
    });
    expect(() => log('cualquier cosa')).not.toThrow();
  });
});
