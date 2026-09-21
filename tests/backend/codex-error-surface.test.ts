import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { CodexChatAdapter, rawTurnLine, turnErrorText } from '../../electron/agents/codex/codexAdapter';
import { makeTempDir, removeDir } from './helpers';

const FAKE_CODEX = path.resolve(__dirname, 'fakeCodex.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * B2.5: EL MISMO HUECO QUE TENIA CLAUDE, EN CODEX.
 *
 * El commit 796b6be arreglo en Claude que un turno roto llegara a la pantalla
 * como "Claude Code reported an error", sin una sola linea en ningun archivo.
 * Codex tenia el mismo hueco y uno peor: `turn/completed` con
 * `status: 'failed'` y sin `turn.error` no emitia NADA -- ni mensaje, ni
 * evento de error, ni log. La persona veia el turno terminar en silencio,
 * como si hubiera salido bien.
 *
 * Mismo tratamiento: el mensaje se arma con lo que el protocolo manda de
 * verdad (el `code` y el `message` del error del turno), acotado a 300
 * caracteres; la linea cruda va al `log`, que ya termina en
 * `data/logs/agents.log`. Nada de campos inventados.
 */
describe('los constructores del texto de error, sin montar nada', () => {
  it('junta el codigo y el mensaje cuando el turno trae los dos', () => {
    expect(turnErrorText({ error: { code: 'usage_limit_reached', message: 'weekly limit reached' } }))
      .toBe('usage_limit_reached: weekly limit reached');
  });

  it('con solo el mensaje, dice el mensaje', () => {
    expect(turnErrorText({ error: { message: 'Simulated failure' } })).toBe('Simulated failure');
  });

  it('con solo el codigo, dice el codigo: distingue un fallo de otro', () => {
    expect(turnErrorText({ error: { code: -32000 } })).toBe('-32000');
  });

  it('con una forma que este repo no conoce, la serializa entera antes que perderla', () => {
    expect(turnErrorText({ error: { reason: 'sandbox_denied' } })).toContain('sandbox_denied');
  });

  it('sin error ninguno, cae en el generico y nunca en una cadena vacia', () => {
    expect(turnErrorText(null)).toBe('Codex turn failed');
    expect(turnErrorText({})).toBe('Codex turn failed');
    expect(turnErrorText({ error: null }, 'Codex error')).toBe('Codex error');
  });

  it('acota el texto a 300 caracteres: un error largo no puede tapar la pantalla', () => {
    const text = turnErrorText({ error: { message: 'x'.repeat(900) } });
    expect(text.length).toBe(300);
    expect(text.endsWith('…')).toBe(true);
  });

  it('la linea cruda deja afuera los items del turno, que son la conversacion entera', () => {
    const line = rawTurnLine({ id: 'turn_1', status: 'failed', items: [{ type: 'agentMessage', text: 'secreto' }], error: { message: 'boom' } });
    expect(line).toContain('"status":"failed"');
    expect(line).toContain('boom');
    expect(line).not.toContain('secreto');
  });

  it('y se acota a 2000 caracteres', () => {
    const line = rawTurnLine({ status: 'failed', error: { message: 'y'.repeat(5_000) } });
    expect(line.length).toBe(2_000);
  });
});

describe('la superficie de error del adaptador de Codex', () => {
  let events: ChatEvent[];
  let logs: string[];
  let adapter: CodexChatAdapter;
  let dir: string;

  beforeEach(() => {
    events = [];
    logs = [];
    dir = makeTempDir();
    adapter = new CodexChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '0.153.4' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      serverCwd: dir,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: ((file: string, args: string[], options: { env?: Record<string, string> }) =>
        spawn(file, [FAKE_CODEX, ...args], options as Parameters<typeof spawn>[2])) as typeof spawn,
      requestTimeoutMs: 5_000,
      openExternal: async () => {},
      log: (line) => logs.push(line),
    });
  });

  afterEach(async () => {
    adapter.shutdown();
    removeDir(dir);
  });

  const start = () => adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Codex', accountId: null });
  const of = (chatId: string, type: ChatEvent['type']) => events.filter((e) => e.chatId === chatId && e.type === type);

  it('un turno que falla sin `error` deja de terminar en silencio: dice algo y lo loguea', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'fail-bare');
    await waitFor(() => of(session.id, 'error').length > 0);

    expect(of(session.id, 'error')[0]).toMatchObject({ message: 'Codex turn failed' });
    expect(adapter.listMessages(session.id).at(-1)?.error).toBe('Codex turn failed');
    const raw = logs.find((l) => l.includes('turn error:'));
    expect(raw, logs.join('\n')).toBeDefined();
    expect(raw).toContain(`[codex ${session.id}] turn error:`);
    expect(raw).toContain('"status":"failed"');
  });

  it('un turno que falla con codigo y mensaje los muestra los dos', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'fail-detail');
    await waitFor(() => of(session.id, 'error').length > 0);

    expect(of(session.id, 'error')[0]).toMatchObject({ message: 'usage_limit_reached: weekly limit reached' });
    expect(adapter.listMessages(session.id).at(-1)?.error).toBe('usage_limit_reached: weekly limit reached');
    expect(logs.find((l) => l.includes('turn error:'))).toContain('usage_limit_reached');
  });

  it('la notificacion `error` del hilo tambien lleva su detalle y su linea de log', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'notify-error');
    await waitFor(() => of(session.id, 'error').length > 0);

    expect(of(session.id, 'error')[0]).toMatchObject({ message: '-32000: upstream refused the request' });
    const raw = logs.find((l) => l.includes('thread error:'));
    expect(raw, logs.join('\n')).toBeDefined();
    expect(raw).toContain('upstream refused the request');
  });

  it('el turno fallido del fake sigue diciendo lo mismo que antes: nada se perdio', async () => {
    const { session } = await start();
    await adapter.send(session.id, 'please fail');
    await waitFor(() => of(session.id, 'error').length > 0);
    expect(of(session.id, 'error')[0]).toMatchObject({ message: 'Simulated failure' });
  });
});
