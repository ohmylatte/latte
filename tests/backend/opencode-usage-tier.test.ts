import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent, EffortTier } from '../../shared/contracts';
import { opencodeVariantFor } from '../../electron/agents/tiers';
import { ChatManager } from '../../electron/opencode/chatManager';
import { startFakeOpenCode, type FakeOpenCode } from './fakeOpenCode';

/**
 * S4 (paridad de OpenCode): CONSUMO Y MODELO.
 *
 * Los números de abajo son los de un turno REAL de opencode 1.18.32 (un turno
 * con una herramienta = dos mensajes de asistente, uno por llamada):
 *
 *   msg 1  tokens {total:21318, input:19103, output:108, reasoning:179, cache:{read:1928, write:0}}
 *   msg 2  tokens {total:21452, input:113,   output:2,   reasoning:21,  cache:{read:21316, write:0}}
 *
 * `total` = input + output + reasoning + cache.read (21318 = 19103+108+179+1928):
 * el razonamiento NO está adentro de `output`. Lo generado es output + reasoning.
 */

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('OpenCode: el consumo tal como lo cuenta el runtime', () => {
  let fake: FakeOpenCode;
  let manager: ChatManager;
  afterEach(async () => {
    manager?.shutdown();
    await fake?.close();
  });

  // La línea que ve la persona con ESTE total ("Contexto: 21,4 mil · 19,5 mil
  // generados") la fija `src/usage-format.test.ts`: el renderer no compila acá.
  it('el razonamiento cuenta como generado y el contexto es el de la última llamada', async () => {
    fake = await startFakeOpenCode();
    const events: ChatEvent[] = [];
    manager = new ChatManager({ resolveExecutable: async () => null, serverCwd: '/latte-data', emit: (e) => events.push(e), endpoint: fake.endpoint, clientTimeoutMs: 3_000 });
    const { session, runtimeSessionId: sessionID } = await manager.start({ workId: 'wrk_1', directory: '/w', title: 't' });
    await waitFor(() => fake.subscribers === 1);

    const call = (id: string, tokens: Record<string, unknown>) => fake.emit('/w', 'message.updated', { sessionID, info: { id, sessionID, role: 'assistant', time: { created: 1, completed: 2 }, tokens, cost: 0 } });
    call('msg_1', { total: 21_318, input: 19_103, output: 108, reasoning: 179, cache: { read: 1_928, write: 0 } });
    call('msg_2', { total: 21_452, input: 113, output: 2, reasoning: 21, cache: { read: 21_316, write: 0 } });
    await waitFor(() => events.filter((e) => e.type === 'usage').length === 2);

    const usage = events.filter((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage[0].turn.outputTokens).toBe(108 + 179);
    expect(usage[1].turn.outputTokens).toBe(2 + 21);
    const total = usage[1].total;
    expect(total.contextTokens).toBe(113 + 21_316);
    expect(total.outputTokens).toBe(108 + 179 + 2 + 21);
    // Gratis (cost 0) no es un precio: la línea dice lo generado, no "$0".
    expect(total.costUsd).toBeNull();
    expect(total).toEqual({ inputTokens: 19_216, outputTokens: 310, cacheReadTokens: 23_244, cacheWriteTokens: 0, turns: 2, costUsd: null, contextTokens: 21_429 });
    expect(session.provider).toBe('opencode');
  });
});

describe('OpenCode: el tier se dice en las variantes que el modelo tiene', () => {
  it.each<[EffortTier, string[] | null, string | null]>([
    // Catálogo desconocido: se manda el del tier, como siempre.
    ['light', null, 'low'],
    ['balanced', null, 'medium'],
    ['deep', null, 'high'],
    // El modelo lista las tres (medido: ling-3.0-flash).
    ['deep', ['low', 'medium', 'high'], 'high'],
    // Con más escalones, `deep` sigue siendo `high` (el mismo que Codex).
    ['deep', ['low', 'medium', 'high', 'xhigh', 'max'], 'high'],
    // Un modelo sin perilla de esfuerzo (medido: big-pickle, `variants: {}`): no se manda nada.
    ['balanced', [], null],
    // Faltan escalones: el más cercano que el modelo SÍ tiene.
    ['balanced', ['high', 'max'], 'high'],
    ['light', ['minimal', 'high'], 'minimal'],
    ['deep', ['xhigh', 'max'], 'xhigh'],
    // Nada parecido: mejor no mandar que mandar algo que el modelo no lista.
    ['light', ['turbo'], null],
  ])('%s con %j → %s', (tier, available, expected) => {
    expect(opencodeVariantFor(tier, available)).toBe(expected);
  });

  it('la variante del prompt sale del modelo elegido: sin perilla, el prompt no lleva `variant`', async () => {
    const fake = await startFakeOpenCode({
      providers: {
        providers: [{ id: 'opencode', name: 'OpenCode', source: 'api', env: [], options: {}, models: {
          'big-pickle': { id: 'big-pickle', variants: {} },
          'space-bunny': { id: 'space-bunny', variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
        } }],
        default: { opencode: 'big-pickle' },
      },
    });
    const manager = new ChatManager({ resolveExecutable: async () => null, serverCwd: '/latte-data', emit: () => {}, endpoint: fake.endpoint, clientTimeoutMs: 3_000 });
    try {
      // Sin modelo explícito corre el default de OpenCode (big-pickle), que no tiene variantes.
      const plain = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w', title: 't', tier: 'deep' });
      await manager.send(plain.session.id, 'hola');
      const explicit = await manager.start({ workId: 'wrk_1', chatId: 'mem_b', directory: '/w', title: 't', tier: 'deep', model: 'opencode/space-bunny' });
      await manager.send(explicit.session.id, 'hola');
      const prompts = fake.requests.filter((r) => r.path.endsWith('/prompt_async')).map((r) => r.body as Record<string, unknown>);
      expect(prompts[0]).not.toHaveProperty('variant');
      expect(prompts[1]).toMatchObject({ variant: 'high', model: { providerID: 'opencode', modelID: 'space-bunny' } });
    } finally {
      manager.shutdown();
      await fake.close();
    }
  });
});
