import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { makeBackend, type TestBackend } from './helpers';

/**
 * R8: LA MUERTE DE UN MIEMBRO LLEGA A LA INTERFAZ PASE LO QUE PASE.
 *
 * La rama `closed` de `createBackend` hace tres cosas antes de reenviar el
 * evento —`hub.stop`, liquidar los despachos de ese miembro y avisar que su
 * turno terminó— y las tres escriben en la base. Ninguna estaba en un try: si
 * cualquiera tiraba (la base trabada, una fila que no está, un constraint), el
 * `forward(event)` de abajo no corría NUNCA y el renderer no se enteraba de
 * que el miembro se había muerto. La persona se quedaba mirando un miembro
 * "trabajando" que ya no existe, sin una sola pista, hasta reiniciar la app.
 *
 * Contabilidad y aviso son independientes: que las cuentas no cierren no puede
 * ser razón para ocultarle a la persona que su agente se cayó.
 */
describe('R8: un fallo al cerrar las cuentas no oculta la muerte del miembro', () => {
  let b: TestBackend;
  let forwarded: ChatEvent[];
  let logged: string[];

  beforeEach(async () => {
    forwarded = [];
    logged = [];
    b = await makeBackend({
      emitChat: (event) => { forwarded.push(event); },
      log: (line) => { logged.push(line); },
    });
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  const closed = (): ChatEvent => ({ chatId: 'mem_muerto', type: 'closed', reason: 'Codex app-server exited (code 1)' });

  it('el camino feliz reenvía el `closed` (la premisa del test existe)', () => {
    b.emitChat(closed());

    expect(forwarded.filter((e) => e.type === 'closed')).toHaveLength(1);
  });

  it('si liquidar los despachos tira, el renderer recibe el `closed` igual', () => {
    const settle = vi.spyOn(b.service, 'settleCoordinationDispatchesForMember').mockImplementation(() => {
      throw new Error('database is locked');
    });

    b.emitChat(closed());

    expect(settle).toHaveBeenCalledTimes(1);
    expect(forwarded.filter((e) => e.type === 'closed')).toHaveLength(1);
    // Y el fallo no se traga en silencio: queda en el log.
    expect(logged.some((line) => line.includes('database is locked'))).toBe(true);
  });

  it('si avisar del fin de turno tira, el renderer recibe el `closed` igual', () => {
    const note = vi.spyOn(b.service, 'noteCoordinationTurnEnded').mockImplementation(() => {
      throw new Error('run row vanished');
    });

    b.emitChat(closed());

    expect(note).toHaveBeenCalledTimes(1);
    expect(forwarded.filter((e) => e.type === 'closed')).toHaveLength(1);
    expect(logged.some((line) => line.includes('run row vanished'))).toBe(true);
  });

  it('si `hub.stop` tira, las cuentas se cierran igual y el renderer recibe el `closed`', () => {
    vi.spyOn(b.hub, 'stop').mockImplementation(() => { throw new Error('adapter blew up'); });
    const settle = vi.spyOn(b.service, 'settleCoordinationDispatchesForMember');

    b.emitChat(closed());

    expect(settle).toHaveBeenCalledTimes(1); // lo de abajo no queda rehén de lo de arriba
    expect(forwarded.filter((e) => e.type === 'closed')).toHaveLength(1);
    expect(logged.some((line) => line.includes('adapter blew up'))).toBe(true);
  });

  it('si las TRES tiran, el `closed` llega igual', () => {
    vi.spyOn(b.hub, 'stop').mockImplementation(() => { throw new Error('a'); });
    vi.spyOn(b.service, 'settleCoordinationDispatchesForMember').mockImplementation(() => { throw new Error('b'); });
    vi.spyOn(b.service, 'noteCoordinationTurnEnded').mockImplementation(() => { throw new Error('c'); });

    b.emitChat(closed());

    expect(forwarded.filter((e) => e.type === 'closed')).toHaveLength(1);
  });
});
