import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { approveCoordinationRoles, fakeExecutablePath, fakeRunner, makeBackend, type TestBackend } from './helpers';
import { fakeOpenCodeSpawner, type FakeOpenCodeSpawner } from './fakeOpenCodeSpawn';

/**
 * S3 (paridad de OpenCode): LO QUE UN MIEMBRO DE OPENCODE HACE, POR LA CAPA REAL.
 *
 * Servicio → hub → planificador → `ChatManager` → un `opencode serve` (falso)
 * por miembro, lanzado por el mismo camino que en producción. Nada de esto
 * llama al adaptador de costado: los permisos, las preguntas, el consumo, la
 * pausa y el run de coordinación entran por donde entran en la app.
 *
 * Lo que OpenCode NO tiene a la par está escrito en el encabezado de
 * `electron/opencode/chatManager.ts` y en los tests de abajo que lo fijan.
 */

const OPENCODE_BIN = fakeExecutablePath('opencode');

function opencodeInstalled() {
  return fakeRunner((file, args) => {
    if (args[0] === 'opencode') return { code: 0, stdout: `${OPENCODE_BIN}\r\n` };
    if (file === OPENCODE_BIN && args[0] === '--version') return { code: 0, stdout: '1.18.32' };
    return { code: 1, stdout: '', stderr: 'not found' };
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Every MCP server in a process's inline config reports `connected`, like a healthy opencode. */
function allConnected(env: Record<string, string>): Record<string, unknown> | undefined {
  if (!env.OPENCODE_CONFIG_CONTENT) return undefined;
  const names = Object.keys((JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, unknown> }).mcp);
  return Object.fromEntries(names.map((name) => [name, { status: 'connected' }]));
}

describe('OpenCode a la par, por la capa real', () => {
  let b: TestBackend;
  let spawner: FakeOpenCodeSpawner;
  let events: ChatEvent[];
  let logs: string[];
  let workId: string;

  beforeEach(async () => {
    spawner = fakeOpenCodeSpawner({ mcpStatus: allConnected });
    events = [];
    logs = [];
    b = await makeBackend({
      runner: opencodeInstalled(),
      chatSpawn: { spawnImpl: spawner.spawnImpl, killProcess: spawner.killProcess },
      emitChat: (e) => events.push(e),
      log: (line) => logs.push(line),
    });
    const brand = await b.service.createBrand('Marca');
    workId = (await b.service.createWork(brand.id, 'Trabajo')).id;
  });

  afterEach(async () => {
    b.cleanup();
    await spawner.closeAll();
  });

  // Members open one after the other, so `spawner.launches[i]` is the i-th
  // member's process; each test also checks the traffic landed on that one.

  it('dos miembros, dos procesos; el permiso de uno llega a SU chat y la respuesta a SU proceso', async () => {
    const a = await b.service.addTeamMember(workId, 'strategist', { runtime: 'opencode' });
    const c = await b.service.addTeamMember(workId, 'sales-copywriter', { runtime: 'opencode' });
    expect(b.chat.processCount()).toBe(2);
    const [fakeA, fakeC] = await Promise.all(spawner.launches.slice(0, 2).map((l) => l.fake));

    await b.service.sendChat(a.id, 'Editá el brief');
    expect(fakeA.requests.some((r) => r.path.endsWith('/prompt_async'))).toBe(true);
    expect(fakeC.requests.some((r) => r.path.endsWith('/prompt_async'))).toBe(false);

    // OpenCode pide permiso: el fake emite `permission.asked` como el runtime.
    await waitFor(() => events.some((e) => e.type === 'permission' && e.chatId === a.id));
    expect(events.some((e) => e.type === 'permission' && e.chatId === c.id)).toBe(false);
    await b.service.replyPermission(a.id, 'per_1', 'once');
    expect(fakeA.requests.find((r) => r.path === '/permission/per_1/reply')?.body).toEqual({ reply: 'once' });
    expect(fakeC.requests.some((r) => r.path.startsWith('/permission/'))).toBe(false);
    await waitFor(() => events.some((e) => e.type === 'permission-resolved' && e.chatId === a.id));
  });

  it('las preguntas de OpenCode llegan como `question` (la QuestionCard de siempre) y la respuesta vuelve a su proceso', async () => {
    const a = await b.service.addTeamMember(workId, 'strategist', { runtime: 'opencode' });
    const fakeA = await spawner.launches[0].fake;
    const sessionID = b.repo.getMember(a.id).sessionId;
    await waitFor(() => fakeA.subscribers === 1);

    fakeA.emit('ignored', 'question.asked', { id: 'que_1', sessionID, questions: [{ header: 'Tono', question: '¿Qué tono?', options: [{ label: 'Cálido', description: 'Cercano' }], multiple: false, custom: true }] });
    await waitFor(() => events.some((e) => e.type === 'question' && e.chatId === a.id));
    await b.service.replyQuestion(a.id, 'que_1', [['Cálido']]);
    expect(fakeA.requests.find((r) => r.path === '/question/que_1/reply')?.body).toEqual({ answers: [['Cálido']] });
    await waitFor(() => events.some((e) => e.type === 'question-resolved' && e.chatId === a.id));
  });

  it('el consumo se registra por miembro, y el contexto es el de la ÚLTIMA llamada, no una suma', async () => {
    const a = await b.service.addTeamMember(workId, 'strategist', { runtime: 'opencode' });
    const fakeA = await spawner.launches[0].fake;
    const sessionID = b.repo.getMember(a.id).sessionId;
    await waitFor(() => fakeA.subscribers === 1);

    // OpenCode escribe UN mensaje de asistente por llamada al modelo
    // (verificado con 1.18.32: un turno con una herramienta son dos mensajes,
    // cada uno con sus `tokens`). Dos llamadas del mismo turno:
    const call = (id: string, input: number, cacheRead: number, output: number) => fakeA.emit('ignored', 'message.updated', {
      sessionID,
      info: { id, sessionID, role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } }, cost: 0 },
    });
    call('msg_c1', 19_103, 1_928, 108);
    call('msg_c2', 113, 21_316, 2);
    await waitFor(() => events.filter((e) => e.type === 'usage' && e.chatId === a.id).length === 2);

    const usage = b.hub.listTeam(workId).find((m) => m.id === a.id)!.usage;
    expect(usage.turns).toBe(2);
    expect(usage.inputTokens).toBe(19_103 + 113);
    expect(usage.cacheReadTokens).toBe(1_928 + 21_316);
    expect(usage.contextTokens).toBe(113 + 21_316);
  });

  it('pausar mata SU proceso; reanudar levanta otro y la conversación vuelve con su historia', async () => {
    const a = await b.service.addTeamMember(workId, 'strategist', { runtime: 'opencode' });
    const c = await b.service.addTeamMember(workId, 'sales-copywriter', { runtime: 'opencode' });
    await b.service.sendChat(a.id, 'Primer mensaje');
    const sessionBefore = b.repo.getMember(a.id).sessionId;

    await b.service.pauseTeamMember(a.id);
    expect(spawner.launches[0].killed).toBe(true);
    expect(spawner.launches[1].killed).toBe(false);
    expect(b.chat.processCount()).toBe(1);
    // Pausado, el historial de OpenCode vive en el runtime y no se lee sin
    // levantarlo: sin paridad con el transcripto propio de Claude Code.
    expect(b.hub.recentMessages(a.id)).toEqual({ messages: [], exposed: false });

    const resumed = await b.service.openTeamMember(a.id);
    expect(spawner.launches).toHaveLength(3);
    expect(resumed.resumed).toBe(true);
    expect(b.repo.getMember(a.id).sessionId).toBe(sessionBefore);
    const history = await b.service.listChatMessages(a.id);
    expect(history[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Primer mensaje' }] });
    expect(b.hub.listTeam(workId).find((m) => m.id === c.id)?.status).not.toBe('paused');
  });

  it('un run de coordinación con un worker de OpenCode: despacho → el worker reporta por SU servidor MCP con SU bearer', async () => {
    await b.service.setCoordinationBudget(workId, { maxDispatches: 5 });
    await b.service.setCoordinationAuthority(workId, 'auto');
    const engine = b.service.coordinationEngine;
    const run = await engine.startRun(workId, null);
    approveCoordinationRoles(b, run.id, 'sales-copywriter');

    const worker = await b.service.addTeamMember(workId, 'sales-copywriter', { runtime: 'opencode' });
    const launch = spawner.launches.at(-1)!;
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    const coordination = config.mcp.latte_coordination;
    expect(coordination.type).toBe('remote');
    const envVar = /\{env:([A-Z0-9_]+)\}/.exec(coordination.headers.Authorization)?.[1];
    expect(envVar).toBeDefined();
    const bearer = launch.env[envVar!];
    expect(bearer).toBeTruthy();

    // La fila de la UI: coordina, y el runtime lo CONFIRMÓ por `GET /mcp`
    // (el motivo es la memoria: este runner no tiene engram).
    const rows = await b.service.coordinationRuntimeSupport(workId);
    expect(rows.find((r) => r.memberId === worker.id)).toMatchObject({ canPropose: true, runtimeConfirmed: true, runtimeReportsInjection: true, reason: 'engram_not_installed' });

    const task = engine.taskCreate(run.id, { roleId: 'sales-copywriter', spec: 'Escribí el titular de la campaña' });
    const outcome = await engine.startDispatch({ grant: { workId, runId: run.id, memberId: 'mem_coordinator', role: 'coordinator' }, taskId: task.id });
    expect(outcome.status).toBe('dispatched');
    expect(b.repo.getCoordinationDispatch(outcome.dispatchId).memberId).toBe(worker.id);

    const fake = await launch.fake;
    const prompt = fake.requests.find((r) => r.path.endsWith('/prompt_async'))?.body as { parts: Array<{ text: string }> } | undefined;
    expect(prompt?.parts[0].text).toContain('Escribí el titular de la campaña');

    // "El modelo" llama a `latte_report` como lo haría OpenCode: a la URL de su
    // config, con el header que resuelve `{env:VAR}` desde SU entorno.
    const response = await fetch(coordination.url, {
      method: 'POST',
      headers: { Authorization: coordination.headers.Authorization.replace(`{env:${envVar}}`, bearer), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'latte_report', arguments: { taskId: task.id, outcome: 'succeeded', summary: 'Titular listo' } } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { structuredContent?: { ok: boolean } } };
    expect(body.result?.structuredContent?.ok).toBe(true);
    expect(b.repo.getCoordinationDispatch(outcome.dispatchId)).toMatchObject({ outcome: 'succeeded', summary: 'Titular listo' });
    // El turno del worker termina (OpenCode emite `session.idle`) y, sin nada
    // más por hacer, el run se cierra.
    fake.emit('ignored', 'session.idle', { sessionID: b.repo.getMember(worker.id).sessionId });
    await waitFor(() => b.repo.getCoordinationRun(run.id).status === 'done');

    // Y el bearer no quedó escrito en ningún log ni en la línea de comandos.
    expect(logs.join('\n')).not.toContain(bearer);
    expect(launch.args.join(' ')).not.toContain(bearer);
  });

  it('un equipo de tres de OpenCode son tres procesos (más ninguno de proveedores si nadie abrió esa pantalla)', async () => {
    await b.service.addTeamMember(workId, 'strategist', { runtime: 'opencode' });
    await b.service.addTeamMember(workId, 'sales-copywriter', { runtime: 'opencode' });
    await b.service.addTeamMember(workId, 'analyst', { runtime: 'opencode' });
    expect(b.chat.processCount()).toBe(3);
    expect(spawner.live()).toHaveLength(3);
  });
});
