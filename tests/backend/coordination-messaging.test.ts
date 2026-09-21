import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { LIMITS } from '../../electron/services/validation';
import { fakeCoordinationHub, makeBackend, settle, type FakeTeamMember, type TestBackend } from './helpers';

/**
 * M2/M3/M4: LOS MIEMBROS SE HABLAN, O NO SON ROLES.
 *
 * «Si uno necesita algo se lo pide a otro; si un solo agente hace todo, no
 * tiene sentido tener roles». Faltaban las dos mitades de eso:
 * `coordination_message` existía en el esquema v12 y NADA la producía, y
 * `latte_check` devolvía `[]` por diseño, así que tampoco había buzón donde
 * leer lo que otro te escribió. Y la persona no podía ver nada de eso.
 */

const COORDINATOR = 'mem_coordinator';

function rpc(name: string, args: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

interface Envelope { ok: boolean; authority: string; data: unknown; error?: { code: string; message: string } }

function envelope(result: { body: string }): Envelope {
  const parsed = JSON.parse(result.body) as { result?: { structuredContent: unknown }; error?: unknown };
  expect(parsed.error).toBeUndefined();
  return (parsed.result as { structuredContent: Envelope }).structuredContent;
}

describe('los miembros se escriben entre sí: `latte_message` y `latte_check`', () => {
  let b: TestBackend;
  let members: FakeTeamMember[];
  let send: ReturnType<typeof fakeCoordinationHub>['send'];
  let workId: string;
  let runId: string;
  let coordinatorToken: string;
  let copywriterId: string;
  let designerId: string;

  function call(name: string, args: unknown, token = coordinatorToken) {
    return b.coordinationMcpServer.handleMcpRequest(rpc(name, args), `Bearer ${token}`, '127.0.0.1');
  }

  function sentTo(memberId: string): string {
    return send.mock.calls.filter((c) => c[0] === memberId).map((c) => c[1] as string).join('\n---\n');
  }

  beforeEach(async () => {
    b = await makeBackend();
    const brand = await b.service.createBrand('Marca');
    const work = await b.service.createWork(brand.id, 'Trabajo');
    workId = work.id;
    await b.service.setCoordinationBudget(workId, { maxDispatches: 20, maxConcurrent: 3 });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
    members = [];
    ({ send } = fakeCoordinationHub(b, members));
    members.push({ id: COORDINATOR, workId, roleId: 'strategist', status: 'idle' });
    coordinatorToken = b.coordinationTokens.mint(workId, COORDINATOR);

    expect(envelope(await call('latte_request_coordination', {
      plan: [{ roleId: 'copywriter', spec: 'Escribir los textos' }, { roleId: 'designer', spec: 'Diseñar las piezas' }],
      estimatedDispatches: 8,
      membersToHire: [{ roleId: 'copywriter', why: 'Nadie escribe' }, { roleId: 'designer', why: 'Nadie diseña' }],
      rationale: 'Coordinar el lanzamiento.',
    })).ok).toBe(true);
    runId = b.repo.findActiveCoordinationRun(workId)!.id;
    await b.service.resolveCoordinationGate(`proposal:${runId}`, 'approve');
    await settle();
    copywriterId = members.find((m) => m.roleId === 'copywriter')!.id;
    designerId = members.find((m) => m.roleId === 'designer')!.id;
    send.mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); b.cleanup(); });

  it('M2: un miembro le escribe al coordinador: se guarda y se entrega, con su rol adentro', async () => {
    const result = envelope(await call(
      'latte_message',
      { to: 'coordinator', text: 'Necesito el tono antes de escribir.' },
      b.coordinationTokens.mint(workId, copywriterId),
    ));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ delivered: true, queued: false, to: COORDINATOR });
    // Persistido, no sólo mandado: un aviso en memoria se pierde con el proceso.
    const rows = b.repo.listCoordinationMessages(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toMemberId: COORDINATOR, fromMemberId: copywriterId, body: 'Necesito el tono antes de escribir.' });
    // Y entregado, diciendo QUIÉN escribe: un mensaje sin remitente no se puede contestar.
    expect(sentTo(COORDINATOR)).toContain('«copywriter»');
    expect(sentTo(COORDINATOR)).toContain(copywriterId);
    expect(sentTo(COORDINATOR)).toContain('Necesito el tono antes de escribir.');
  });

  it('M2: `to` puede ser un roleId, y se resuelve al miembro vivo de ese rol', async () => {
    const result = envelope(await call(
      'latte_message',
      { to: 'designer', text: 'Te paso los textos en una hora.' },
      b.coordinationTokens.mint(workId, copywriterId),
    ));

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ to: designerId, delivered: true });
    expect(sentTo(designerId)).toContain('Te paso los textos en una hora.');
  });

  it('M2: con el destinatario ocupado el mensaje queda ENCOLADO, y la respuesta no miente', async () => {
    members.find((m) => m.id === designerId)!.status = 'working';

    const result = envelope(await call(
      'latte_message',
      { to: 'designer', text: 'Cuando termines, avisame.' },
      b.coordinationTokens.mint(workId, copywriterId),
    ));

    expect(result.data).toEqual({ delivered: false, queued: true, to: designerId });
    expect(sentTo(designerId)).toBe('');

    members.find((m) => m.id === designerId)!.status = 'idle';
    b.emitChat({ chatId: designerId, type: 'status', status: 'idle', detail: '' });
    await settle();
    expect(sentTo(designerId)).toContain('Cuando termines, avisame.');
  });

  it('M2: un `memberId` de OTRO Trabajo es FORBIDDEN, y no escribe una sola fila', async () => {
    const otherBrand = await b.service.createBrand('Otra marca');
    const otherWork = await b.service.createWork(otherBrand.id, 'Otro trabajo');
    const now = '2026-01-01T00:00:00.000Z';
    b.repo.insertMember({
      id: 'mem_ajeno', workId: otherWork.id, roleId: 'copywriter', roleName: 'Copywriter', initial: 'C',
      runtime: 'codex', model: null, accountId: null, sessionId: '', done: false, createdAt: now, updatedAt: now,
    });

    const result = envelope(await call(
      'latte_message',
      { to: 'mem_ajeno', text: 'Hola marca ajena' },
      b.coordinationTokens.mint(workId, copywriterId),
    ));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(b.repo.listCoordinationMessages(runId)).toHaveLength(0);
    expect(sentTo('mem_ajeno')).toBe('');
  });

  it('M2: un destinatario que no existe se rechaza nombrando el problema, sin escribir nada', async () => {
    const result = envelope(await call('latte_message', { to: 'no-existe', text: 'Hola' }, b.coordinationTokens.mint(workId, copywriterId)));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(b.repo.listCoordinationMessages(runId)).toHaveLength(0);
  });

  it('M2: un texto por encima del tope publicado lo rechaza el ESQUEMA, antes de tocar la base', async () => {
    const result = envelope(await call(
      'latte_message',
      { to: 'coordinator', text: 'x'.repeat(5_000) },
      b.coordinationTokens.mint(workId, copywriterId),
    ));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(b.repo.listCoordinationMessages(runId)).toHaveLength(0);
    // Y el tope se PUBLICA: el agente no lo descubre recién cuando falla.
    expect(LIMITS.decision).toBe(4_000);
  });

  it('M3: `latte_check` devuelve el mensaje UNA vez, y después ya no', async () => {
    await call('latte_message', { to: 'coordinator', text: 'Falta el tono' }, b.coordinationTokens.mint(workId, copywriterId));

    const first = envelope(await call('latte_check', {}));
    expect(first.ok).toBe(true);
    const inbox = (first.data as { messages: Array<{ id: string; from: { memberId: string; roleId: string }; text: string; createdAt: string }> }).messages;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ text: 'Falta el tono', from: { memberId: copywriterId, roleId: 'copywriter' } });

    const second = envelope(await call('latte_check', {}));
    expect((second.data as { messages: unknown[] }).messages).toEqual([]);
  });

  it('M3: `latte_check` deja de devolver `[]`: trae el estado del run junto con el buzón', async () => {
    const result = envelope(await call('latte_check', {}));

    expect(result.ok).toBe(true);
    const data = result.data as { run: { status: string; tasks: Record<string, number> }; messages: unknown[] };
    expect(data.run.status).toBe('running');
    expect(data.run.tasks).toEqual({ ready: 2, dispatched: 0, done: 0, failed: 0, blocked: 0, pending: 0 });
    expect(data.messages).toEqual([]);
  });

  it('M4: la persona puede LEER los mensajes del run por IPC, con los roles resueltos', async () => {
    await call('latte_message', { to: 'designer', text: 'Te paso los textos' }, b.coordinationTokens.mint(workId, copywriterId));

    const rows = await b.service.listCoordinationMessages(workId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      from: { memberId: copywriterId, roleId: 'copywriter' },
      to: { memberId: designerId, roleId: 'designer' },
      text: 'Te paso los textos',
    });
  });

  it('M4: un Trabajo sin ningún run devuelve una lista vacía, no una excepción', async () => {
    const brand = await b.service.createBrand('Marca sin run');
    const work = await b.service.createWork(brand.id, 'Trabajo sin run');
    await expect(b.service.listCoordinationMessages(work.id)).resolves.toEqual([]);
  });
});
