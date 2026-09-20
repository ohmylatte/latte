import { describe, expect, it } from 'vitest';
import type { AdapterMcpServer } from '../../electron/agents/types';
import { CoordinationInjectionPlanner } from '../../electron/coordination/injection';
import { CoordinationTokenRegistry } from '../../electron/coordination/tokens';

/**
 * Crítico 11: `confirmInjection` detectaba que el runtime había rechazado la
 * inyección, soltaba el cupo… y dejaba la credencial viva. Un token no vence,
 * así que el miembro rechazado seguía teniendo un bearer que funcionaba
 * mientras otro se quedaba con su cupo; y como `stopIfIdle` cuenta tokens
 * ENTREGADOS, el servidor de loopback no se podía apagar nunca.
 */
function coordinationTokenOf(servers: AdapterMcpServer[] | undefined): string {
  const entry = servers?.find((s) => s.name === 'latte_coordination');
  if (!entry || entry.kind !== 'http') throw new Error('el miembro no recibió latte_coordination');
  return entry.token;
}

function makePlanner() {
  const tokens = new CoordinationTokenRegistry(() => '2026-01-01T00:00:00.000Z');
  /** Lo que `deliveredSize` valía CADA vez que se evaluó apagar el servidor. */
  const stopChecks: number[] = [];
  const planner = new CoordinationInjectionPlanner({
    repo: { findActiveCoordinationRun: () => ({}) },
    tokens,
    server: {
      ensureStarted: async () => undefined,
      stopIfIdle: () => { stopChecks.push(tokens.deliveredSize); },
      boundPort: 7777,
    },
    resolveClaudeVersion: async () => '2.1.300',
    resolveEngramBinary: async () => '/usr/bin/engram',
  });
  return { planner, tokens, stopChecks };
}

describe('confirmInjection: un runtime que rechaza la inyección pierde su token (crítico 11)', () => {
  it('el token deja de verificar, `deliveredSize` baja y el servidor se puede apagar', async () => {
    const { planner, tokens, stopChecks } = makePlanner();
    const assigned = await planner.assign({ memberId: 'mem_a', workId: 'wrk_a', brandId: 'brd', runtime: 'claude', accountId: null });
    const token = coordinationTokenOf(assigned.servers);
    expect(tokens.verify(token)).toMatchObject({ workId: 'wrk_a', memberId: 'mem_a' });
    expect(tokens.deliveredSize).toBe(1);

    // El proceso arrancó y `latte_coordination` no levantó.
    planner.confirmInjection('mem_a', ['latte_memory']);

    expect(tokens.verify(token)).toBeNull();
    expect(tokens.deliveredSize).toBe(0);
    // Y el apagado se evaluó con el contador YA en cero: revocar después de
    // `stopIfIdle` habría dejado el listener abierto hasta el próximo cierre.
    expect(stopChecks).toEqual([0]);
  });

  it('el token del miembro que SÍ recibió la inyección sigue vivo, y el servidor con él', async () => {
    const { planner, tokens, stopChecks } = makePlanner();
    const rejected = await planner.assign({ memberId: 'mem_a', workId: 'wrk_a', brandId: 'brd', runtime: 'claude', accountId: null });
    const accepted = await planner.assign({ memberId: 'mem_b', workId: 'wrk_a', brandId: 'brd', runtime: 'claude', accountId: null });
    const rejectedToken = coordinationTokenOf(rejected.servers);
    const acceptedToken = coordinationTokenOf(accepted.servers);
    expect(tokens.deliveredSize).toBe(2);

    planner.confirmInjection('mem_a', ['latte_memory']);

    expect(tokens.verify(rejectedToken)).toBeNull();
    expect(tokens.verify(acceptedToken)).toMatchObject({ memberId: 'mem_b' });
    expect(tokens.deliveredSize).toBe(1);
    expect(stopChecks).toEqual([1]); // todavía queda alguien: no se apaga nada
  });

  it('un adaptador que no reporta (`undefined`) no revoca nada', async () => {
    const { planner, tokens } = makePlanner();
    const assigned = await planner.assign({ memberId: 'mem_a', workId: 'wrk_a', brandId: 'brd', runtime: 'claude', accountId: null });
    const token = coordinationTokenOf(assigned.servers);

    planner.confirmInjection('mem_a', undefined);

    expect(tokens.verify(token)).toMatchObject({ memberId: 'mem_a' });
    expect(tokens.deliveredSize).toBe(1);
  });
});
