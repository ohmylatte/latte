import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatUsage } from '../../shared/contracts';
import { EMPTY_USAGE } from '../../shared/contracts';
import { ClaudeChatAdapter } from '../../electron/agents/claude/claudeAdapter';
import { addUsage } from '../../electron/core/usage';
import { makeTempDir, removeDir } from './helpers';

/**
 * N3: "ESTA CONVERSACIÓN YA PESA MUCHO" APARECÍA SIEMPRE, Y MUY RÁPIDO.
 *
 * El `result` de Claude Code trae el `usage` SUMADO de todas las llamadas a
 * la API del turno: un turno con veinte herramientas sobre 90 mil de contexto
 * reporta 1,8 M de "contexto". El peso es el tamaño de lo que se relee en la
 * PRÓXIMA llamada: el de la última llamada, nunca una suma.
 */

const FAKE_CLAUDE = path.resolve(__dirname, 'fakeClaude.cjs');

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const usageEvents = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage');

describe('addUsage: el contexto nunca se suma entre turnos', () => {
  it('tres turnos de 90 mil de contexto: 90 mil, no 270 mil', () => {
    const turn: ChatUsage = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 89_000, cacheWriteTokens: 0, turns: 1, costUsd: null, contextTokens: 90_000 };
    const total = [turn, turn, turn].reduce(addUsage, EMPTY_USAGE);
    expect(total.contextTokens).toBe(90_000);
    expect(total.turns).toBe(3);
  });
});

describe('Claude Code: el contexto es el de la ÚLTIMA llamada del turno', () => {
  let events: ChatEvent[];
  let dir: string;
  let adapter: ClaudeChatAdapter;

  beforeEach(() => {
    events = [];
    dir = makeTempDir();
    adapter = new ClaudeChatAdapter({
      resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.269 (Claude Code)' }),
      emit: (e) => events.push(e),
      accountEnv: () => ({}),
      spawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_CLAUDE, ...args], options)) as typeof spawn,
      platform: 'linux',
      env: { PATH: process.env.PATH ?? '' },
    });
  });
  afterEach(() => { adapter.shutdown(); removeDir(dir); });

  it('un turno de tres llamadas de 90 mil: contexto 90 mil, lo gastado sigue siendo la suma', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null, tier: 'light' });
    await adapter.send(session.id, 'tres-llamadas');
    await waitFor(() => usageEvents(events).length === 1);
    const [first] = usageEvents(events);
    expect(first!.turn.contextTokens).toBe(90_000);
    // Lo que se gastó no se toca: las tres lecturas de caché existieron.
    expect(first!.turn.cacheReadTokens).toBe(267_000);

    await adapter.send(session.id, 'tres-llamadas');
    await waitFor(() => usageEvents(events).length === 2);
    expect(usageEvents(events)[1]!.total.contextTokens).toBe(90_000);
  });

  it('un turno de una sola llamada, sin usage por llamada: cae en el del resultado', async () => {
    const { session } = await adapter.start({ workId: 'wrk_1', directory: dir, title: 't', label: 'Claude', accountId: null, tier: 'light' });
    await adapter.send(session.id, 'Hola');
    await waitFor(() => usageEvents(events).length === 1);
    expect(usageEvents(events)[0]!.turn.contextTokens).toBe(1050);
  });
});
