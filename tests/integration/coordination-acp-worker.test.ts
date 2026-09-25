import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/contracts';
import { createCoordinationTools } from '../../electron/coordination/tools';
import { FEATURE_KEYS, FEATURE_ON } from '../../electron/core/features';
import { memorySecretBox } from '../../electron/storage/secretBox';
import { startToyMcp, type ToyMcpServer } from '../fakes/toyMcp';
import { FAKE_ACP, readFakeLog, waitFor } from '../backend/acpHelpers';
import { approveCoordinationRoles, fakeRunner, makeBackend, makeTempDir, removeDir, type TestBackend } from '../backend/helpers';

/**
 * De punta a punta, con procesos de verdad: un worker de Grok o de Hermes (el
 * agente ACP falso de `tests/backend/fakeAcp.ts`, con los quirks de cada uno)
 * recibe un despacho del motor real a través del hub real, llama a una
 * Conexión MCP por el gateway y reporta la tarea con `latte_report` por el
 * servidor MCP de coordinación. Cada bearer llega por
 * `session/new.mcpServers[].headers`, nunca por argv. En Hermes, además, las
 * tools siguen ahí después del `set_model` gracias al `session/load` de rescate.
 */
describe.each([
  { runtime: 'grok' as const, label: 'Grok', confirms: true },
  { runtime: 'hermes' as const, label: 'Hermes', confirms: false },
])('coordination run with a $label worker over ACP', ({ runtime, confirms }) => {
  let b: TestBackend;
  let dir: string;
  let upstream: ToyMcpServer;
  let chat: ChatEvent[];
  const box = memorySecretBox();
  const fakeLog = () => path.join(dir, 'fake-acp.log');
  const vars = () => path.join(dir, 'vars.json');

  beforeEach(async () => {
    chat = [];
    dir = makeTempDir('latte-acp-run-');
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    upstream = await startToyMcp({ validTokens: new Set(['at_del_proveedor']) });
    b = await makeBackend({
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return args[0] === runtime ? { stdout: `${process.execPath}\n` } : { code: 1 };
        if (args[0] === 'models') return { stdout: 'You are logged in with grok.com.\n' };
        if (args[0] === 'auth') return { stdout: 'openai-codex (1 credentials):\n' };
        return { stdout: '1.0.41\n' };
      }),
      secretBox: box,
      emitChat: (event) => chat.push(event),
      acpSpawnImpl: ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(file, [FAKE_ACP, ...args], options)) as typeof spawn,
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        NODE_NO_WARNINGS: '1',
        FAKE_ACP_FLAVOR: runtime,
        FAKE_ACP_STATE: path.join(dir, 'state'),
        FAKE_ACP_LOG: fakeLog(),
        FAKE_ACP_VARS: vars(),
      },
    });
    b.repo.setMeta(FEATURE_KEYS.coordination, FEATURE_ON);
  });
  afterEach(async () => {
    b.cleanup();
    await upstream.close();
    await new Promise((r) => setTimeout(r, 50));
    removeDir(dir);
  });

  it('dispatch → connection tool through the gateway → latte_report → task done', async () => {
    const brand = await b.service.createBrand('Casa');
    const work = await b.service.createWork(brand.id, 'Lanzamiento');
    const account = await b.service.addAgentAccount(runtime, 'Agencia');
    // La Conexión de la marca, ya logueada: el gateway tiene el token del proveedor.
    const now = new Date().toISOString();
    b.repo.connections.insert({
      id: 'con_agentcy', name: 'theagentcy', label: 'The Agentcy', url: upstream.url, transport: 'http', authKind: 'oauth',
      clientId: null, identity: null, scope: 'brand', brandId: brand.id, state: 'connected', stateDetail: '', memberOverride: null,
      createdAt: now, updatedAt: now,
    });
    b.repo.connections.saveTokens('con_agentcy', {
      accessToken: 'at_del_proveedor', refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: 'mcp', clientId: 'cli',
      issuer: null, tokenEndpoint: null, revocationEndpoint: null, resource: null,
    }, box, now);

    // El coordinador y el worker, del mismo runtime y la misma cuenta, cada uno en su proceso.
    const coordinator = await b.service.addTeamMember(work.id, 'assistant', { runtime, accountId: account.id });
    await b.service.setCoordinationBudget(work.id, { maxDispatches: 5 });
    await b.service.setCoordinationAuthority(work.id, 'auto');
    const run = await b.service.startCoordinationRun(work.id);
    // El worker entra con el run andando: sin run, un trabajo coordina a uno solo (MAX_BOOTSTRAP_ACP_MEMBERS_PER_WORK).
    const worker = await b.service.addTeamMember(work.id, 'sales-copywriter', { runtime, accountId: account.id });
    approveCoordinationRoles(b, run.id, 'sales-copywriter');
    // Grok confirma por su cuenta los servidores que levantó (llega mientras arranca); Hermes no lo dice
    // por ACP, y Latte no lo afirma por él. Se mira ahora: al terminar el run, el equipo se cierra.
    const support = await b.service.coordinationRuntimeSupport(work.id);
    expect(support.find((row) => row.memberId === worker.id)).toMatchObject({ canPropose: true, runtimeConfirmed: confirms });

    const tools = createCoordinationTools(b.service.coordinationEngine);
    const grant = { workId: work.id, runId: run.id, memberId: coordinator.id, role: 'coordinator' as const };
    const spec = [
      'Escribí el titular del lanzamiento.',
      'MCP latte_conn_theagentcy eco {"texto":"hola desde grok"}',
      'MCP latte_coordination latte_report {"taskId":"@TASK","outcome":"succeeded","summary":"Titular listo"}',
    ].join('\n');
    const submitted = await tools.latte_plan_submit(grant, { tasks: [{ roleId: 'sales-copywriter', spec }] });
    expect(submitted.ok).toBe(true);
    const [task] = submitted.data as Array<{ taskId: string }>;
    fs.writeFileSync(vars(), JSON.stringify({ TASK: task.taskId }));

    const dispatched = await tools.latte_dispatch(grant, { taskId: task.taskId });
    expect(dispatched.ok).toBe(true);
    await waitFor(() => b.repo.getCoordinationTask(task.taskId).status === 'done', 15_000);
    expect(b.repo.getCoordinationTask(task.taskId).assignedMemberId).toBe(worker.id);
    // El reporte llega al motor antes de que el worker termine su turno: se espera el turno entero.
    await waitFor(() => chat.some((e) => e.chatId === worker.id && e.type === 'status' && e.status === 'idle'));

    // Cada proceso recibió SUS servidores, con el bearer en un header.
    const log = readFakeLog(fakeLog());
    const starts = log.filter((e) => e.kind === 'start') as Array<{ pid: number; argv: string[] }>;
    expect(starts).toHaveLength(2);
    for (const start of starts) expect(JSON.stringify(start.argv)).not.toMatch(/Bearer|token/i);
    const sessions = log.filter((e) => e.kind === 'in' && (e.message as { method?: string }).method === 'session/new')
      .map((e) => (e.message as { params: { mcpServers: Array<{ name: string; headers?: Array<{ name: string; value: string }> }> } }).params.mcpServers);
    const bearers = sessions.map((servers) => servers.find((s) => s.name === 'latte_coordination')?.headers?.[0]);
    expect(bearers.every((h) => h?.name === 'Authorization' && /^Bearer \S{16,}$/.test(h.value))).toBe(true);
    // Un bearer por miembro: el coordinador y el worker no comparten credencial.
    expect(new Set(bearers.map((h) => h?.value)).size).toBe(2);
    expect(sessions.every((servers) => servers.some((s) => s.name === 'latte_conn_theagentcy' && s.headers?.[0]?.value.startsWith('Bearer ')))).toBe(true);

    // Las dos tools se llamaron por HTTP y contestaron 200.
    const mcpCalls = log.filter((e) => e.kind === 'mcp-call') as Array<{ server: string; tool: string; status: number }>;
    expect(mcpCalls).toEqual([
      expect.objectContaining({ server: 'latte_conn_theagentcy', tool: 'eco', status: 200 }),
      expect.objectContaining({ server: 'latte_coordination', tool: 'latte_report', status: 200 }),
    ]);
    // El upstream vio el token DEL PROVEEDOR, nunca el bearer del miembro.
    const upstreamCall = upstream.calls.find((c) => c.rpcMethod === 'tools/call');
    expect(upstreamCall?.bearer).toBe('at_del_proveedor');
    // El turno del worker se ve en su chat.
    const workerTexts = (await b.service.listChatMessages(worker.id)).filter((m) => m.role === 'assistant').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(workerTexts).toContain('latte_report=');
    expect(workerTexts).toContain('hola desde grok');
    expect(chat.some((e) => e.chatId === worker.id && e.type === 'usage')).toBe(true);
  }, 30_000);
});
