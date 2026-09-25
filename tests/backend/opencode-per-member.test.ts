import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { MAX_OPENCODE_SERVERS_TOTAL } from '../../electron/coordination/limits';
import { ChatManager } from '../../electron/opencode/chatManager';
import { fakeOpenCodeSpawner, type FakeOpenCodeSpawner } from './fakeOpenCodeSpawn';

/**
 * S1 (paridad de OpenCode): UN SERVIDOR DE OPENCODE POR MIEMBRO.
 *
 * Antes Latte levantaba un solo `opencode serve` para todos los miembros, y
 * `OPENCODE_CONFIG_CONTENT` es del PROCESO: no había forma de darle a cada
 * miembro sus propios servidores MCP ni sus propios bearers. Ahora cada chat
 * tiene su proceso, con su puerto efímero y su entorno, y el ciclo de vida va
 * atado al chat como en Codex.
 */

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const coordination = (token: string): AdapterMcpServer => ({ kind: 'http', name: 'latte_coordination', url: 'http://127.0.0.1:4100/mcp', token });

describe('OpenCode: un proceso por miembro', () => {
  let spawner: FakeOpenCodeSpawner;
  let events: ChatEvent[];
  let manager: ChatManager;

  beforeEach(() => {
    spawner = fakeOpenCodeSpawner();
    events = [];
    manager = new ChatManager({
      resolveExecutable: async () => ({ executable: '/fake/opencode', version: '1.18.32' }),
      serverCwd: '/latte-data',
      emit: (e) => events.push(e),
      platform: 'linux',
      env: { PATH: '/usr/bin', ORCA_TOKEN: 'no-debe-pasar' },
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

  it('dos miembros son dos procesos, cada uno con su propio entorno', async () => {
    const a = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', extraEnv: { ENGRAM_PROJECT: 'latte-brand-a' }, mcpServers: [coordination('tok-a')] });
    const b = await manager.start({ workId: 'wrk_1', chatId: 'mem_b', directory: '/w/one', title: 'B', extraEnv: { ENGRAM_PROJECT: 'latte-brand-b' }, mcpServers: [coordination('tok-b')] });

    expect(spawner.launches).toHaveLength(2);
    const [envA, envB] = spawner.launches.map((l) => l.env);
    expect(envA.ENGRAM_PROJECT).toBe('latte-brand-a');
    expect(envB.ENGRAM_PROJECT).toBe('latte-brand-b');
    expect(envA.OPENCODE_CONFIG_CONTENT).toContain('latte_coordination');
    expect(envA.LATTE_MCP_TOKEN_LATTE_COORDINATION).toBe('tok-a');
    expect(envB.LATTE_MCP_TOKEN_LATTE_COORDINATION).toBe('tok-b');
    // Credenciales distintas por proceso, y nada del orquestador que lanzó a Latte.
    expect(envA.OPENCODE_SERVER_PASSWORD).not.toBe(envB.OPENCODE_SERVER_PASSWORD);
    expect(envA.ORCA_TOKEN).toBeUndefined();
    // Cada uno habla con SU proceso: la sesión de A se creó en el fake de A.
    const [fakeA, fakeB] = await Promise.all(spawner.launches.map((l) => l.fake));
    expect(fakeA.requests.some((r) => r.path === '/session' && r.method === 'POST')).toBe(true);
    expect(fakeB.requests.filter((r) => r.path === '/session' && r.method === 'POST')).toHaveLength(1);
    expect(a.runtimeSessionId).not.toBe(b.runtimeSessionId);
    expect(manager.processCount()).toBe(2);
  });

  it('el entorno de un miembro no puede pisar las credenciales del servidor', async () => {
    await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', extraEnv: { OPENCODE_SERVER_PASSWORD: 'elegida-por-otro' } });
    expect(spawner.launches[0].env.OPENCODE_SERVER_PASSWORD).not.toBe('elegida-por-otro');
  });

  it('cerrar un miembro mata SU proceso y no toca el del otro', async () => {
    await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A' });
    await manager.start({ workId: 'wrk_1', chatId: 'mem_b', directory: '/w/one', title: 'B' });
    manager.stop('mem_a');

    expect(spawner.launches[0].killed).toBe(true);
    expect(spawner.launches[1].killed).toBe(false);
    expect(events).toContainEqual({ chatId: 'mem_a', type: 'closed', reason: 'stopped' });
    expect(events.some((e) => e.chatId === 'mem_b' && e.type === 'closed')).toBe(false);
    expect(manager.processCount()).toBe(1);

    const fakeB = await spawner.launches[1].fake;
    await manager.send('mem_b', 'sigo vivo');
    expect(fakeB.requests.some((r) => r.path.endsWith('/prompt_async'))).toBe(true);
  });

  it('reabrir levanta un proceso nuevo y reanuda la sesión de OpenCode con su historia', async () => {
    const first = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A' });
    await manager.send('mem_a', 'Primer mensaje');
    manager.stop('mem_a');

    const again = await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', previousSessionId: first.runtimeSessionId });
    expect(spawner.launches).toHaveLength(2);
    expect(spawner.launches[0].killed).toBe(true);
    expect(again.session.resumed).toBe(true);
    expect(again.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(manager.listMessages('mem_a')[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Primer mensaje' }] });
  });

  it('si el proceso de un miembro se muere solo, ese chat se cierra con el motivo y el otro sigue', async () => {
    await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A' });
    await manager.start({ workId: 'wrk_1', chatId: 'mem_b', directory: '/w/one', title: 'B' });
    spawner.launches[0].crash(9);

    await waitFor(() => events.some((e) => e.chatId === 'mem_a' && e.type === 'closed'));
    expect(events.find((e) => e.chatId === 'mem_a' && e.type === 'closed')).toMatchObject({ reason: expect.stringMatching(/OpenCode server exited \(code 9/) });
    expect(manager.owns('mem_a')).toBe(false);
    expect(manager.owns('mem_b')).toBe(true);
    expect(manager.processCount()).toBe(1);
  });

  it(`el tope de la app es ${MAX_OPENCODE_SERVERS_TOTAL} procesos, y rechaza con el motivo de siempre sin spawnear`, async () => {
    // Todos a la vez: el tope cuenta también las aperturas en vuelo.
    const opens = Array.from({ length: MAX_OPENCODE_SERVERS_TOTAL + 1 }, (_, i) => manager.start({ workId: 'wrk_1', chatId: `mem_${i}`, directory: '/w/one', title: `M${i}` }));
    const results = await Promise.allSettled(opens);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(new RegExp(`Too many open chats \\(max ${MAX_OPENCODE_SERVERS_TOTAL}\\)`));
    expect(spawner.launches).toHaveLength(MAX_OPENCODE_SERVERS_TOTAL);
    expect(manager.processCount()).toBe(MAX_OPENCODE_SERVERS_TOTAL);
  });

  it('los proveedores van a un proceso propio sin MCP, que no cuenta como miembro ni muere con ellos', async () => {
    await manager.start({ workId: 'wrk_1', chatId: 'mem_a', directory: '/w/one', title: 'A', mcpServers: [coordination('tok-a')] });
    const providers = await manager.listProviders();
    expect(providers.map((p) => p.id)).toContain('fake-provider');
    expect(spawner.launches).toHaveLength(2);
    const control = spawner.launches[1];
    expect(control.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(Object.keys(control.env).some((k) => k.startsWith('LATTE_MCP_TOKEN_'))).toBe(false);

    manager.stop('mem_a');
    expect(control.killed).toBe(false);
    await manager.listProviders();
    expect(spawner.launches).toHaveLength(2);
  });
});
