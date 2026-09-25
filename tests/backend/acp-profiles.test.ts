import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage } from '../../shared/contracts';
import type { AcpChatAdapter } from '../../electron/agents/acp/acpAdapter';
import { grokProfile, grokRules, readGrokUsage } from '../../electron/agents/acp/profiles/grok';
import { ensureManualApprovals, HERMES_STDIN_FIX, hermesPreamble, hermesProfile } from '../../electron/agents/acp/profiles/hermes';
import { grokEffortForTier, HERMES_DEFAULT_TIER_MODELS, hermesModelForTier } from '../../electron/agents/tiers';
import { makeTempDir, removeDir } from './helpers';
import { fakeRequests, makeFakeAcpAdapter, readFakeLog, waitFor, type FakeAcpSetup } from './acpHelpers';

const ACCOUNT = 'acc_0123456789abcdef';
const COORDINATION = { kind: 'http' as const, name: 'latte_coordination', url: 'http://127.0.0.1:9/mcp', token: 'tok-member' };

function input(dir: string, extra: Record<string, unknown> = {}) {
  return { workId: 'wrk_1', chatId: 'mem_p1', directory: dir, title: 'Trabajo', label: 'X', accountId: ACCOUNT, instructions: 'Sos la estratega de la marca.', ...extra };
}

function lastAssistant(adapter: AcpChatAdapter): ChatMessage {
  const messages = adapter.listMessages('mem_p1').filter((m) => m.role === 'assistant');
  return messages[messages.length - 1];
}

function lastText(adapter: AcpChatAdapter): string {
  const part = lastAssistant(adapter).parts.filter((p) => p.type === 'text').pop();
  return part && part.type === 'text' ? part.text : '';
}

async function turn(adapter: AcpChatAdapter, events: ChatEvent[], text: string): Promise<void> {
  const idle = events.filter((e) => e.type === 'status' && e.status === 'idle').length;
  await adapter.send('mem_p1', text);
  await waitFor(() => events.filter((e) => e.type === 'status' && e.status === 'idle').length > idle);
}

describe('tiers for ACP runtimes', () => {
  it('Grok moves only the effort; Hermes picks provider:model, and the human choice wins', () => {
    expect([grokEffortForTier('light'), grokEffortForTier('balanced'), grokEffortForTier('deep')]).toEqual(['low', 'medium', 'high']);
    expect(hermesModelForTier('light', null, null)).toBe(HERMES_DEFAULT_TIER_MODELS.light);
    expect(hermesModelForTier('deep', null, 'deepseek:deepseek-v4-pro')).toBe('deepseek:deepseek-v4-pro');
    expect(hermesModelForTier('deep', ' openai-codex:gpt-5.5 ', 'deepseek:deepseek-v4-pro')).toBe('openai-codex:gpt-5.5');
    // Ningún default de la familia gpt-6: Hermes 0.21 no puede cambiar a ellos por ACP.
    expect(Object.values(HERMES_DEFAULT_TIER_MODELS).some((m) => m.includes('gpt-6'))).toBe(false);
  });
});

describe('Grok profile', () => {
  let dir: string;
  let setup: FakeAcpSetup;
  let adapter: AcpChatAdapter | null = null;
  let events: ChatEvent[];

  beforeEach(() => {
    dir = makeTempDir('latte-grok-');
    setup = { dir, log: path.join(dir, 'fake.log'), state: path.join(dir, 'state'), flavor: 'grok' };
    events = [];
  });
  afterEach(async () => {
    adapter?.shutdown();
    adapter = null;
    await new Promise((r) => setTimeout(r, 50));
    removeDir(dir);
  });

  it('runs `agent --no-leader stdio` isolated in the account: its own home, no imports from other tools', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir));
    const start = readFakeLog(setup.log).find((e) => e.kind === 'start') as { argv: string[]; env: Record<string, string> };
    const account = path.join(dir, 'accounts', ACCOUNT);
    expect(start.argv).toEqual(['agent', '--no-leader', 'stdio']);
    expect(start.env).toMatchObject({ GROK_HOME: account, USERPROFILE: path.join(account, 'home'), HOME: path.join(account, 'home'), GROK_DISABLE_AUTOUPDATER: '1' });
    for (const source of ['CLAUDE', 'CURSOR', 'CODEX']) {
      for (const thing of ['MCPS', 'HOOKS', 'RULES', 'AGENTS', 'SKILLS', 'SESSIONS']) expect(start.env[`GROK_${source}_${thing}_ENABLED`]).toBe('0');
    }
    expect(fs.existsSync(path.join(account, 'home'))).toBe(true);
  });

  it('adds the role to its rules (never replaces the system prompt) and turns always-approve off', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir, { mcpServers: [COORDINATION] }));
    const meta = fakeRequests(setup.log, 'session/new')[0]._meta as Record<string, unknown>;
    expect(meta.yoloMode).toBe(false);
    expect(meta.systemPromptOverride).toBeUndefined();
    expect(meta.rules).toContain('Sos la estratega de la marca.');
    expect(meta.rules).toContain('latte_coordination__latte_report');
    expect(meta.rules).toContain('search_tool');
    expect(grokRules({ ...input(dir), instructions: '' })).toBe('');
  });

  it('turns the tier into reasoning_effort, sent as a string', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir, { tier: 'light' }));
    expect(fakeRequests(setup.log, 'session/set_config_option')).toEqual([{ sessionId: expect.any(String), configId: 'reasoning_effort', value: 'low' }]);
    await turn(adapter, events, 'LISTMCP');
    expect(lastText(adapter)).toContain('effort=low');
  });

  it('reads usage and cost from _meta: the last call is the context, ticks are 1e-10 USD', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir));
    await turn(adapter, events, 'hola');
    const usage = events.find((e) => e.type === 'usage') as Extract<ChatEvent, { type: 'usage' }>;
    expect(usage.turn).toMatchObject({ inputTokens: 56200 - 21888, cacheReadTokens: 21888, outputTokens: 764, contextTokens: 19024 });
    expect(usage.turn.costUsd).toBeCloseTo(0.084152, 6);
    expect(readGrokUsage({ stopReason: 'end_turn' })).toBeNull();
  });

  it('asks native questions and sends back the shape Grok accepts', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir));
    await adapter.send('mem_p1', 'ASK');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const asked = events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>;
    expect(asked.request.questions).toEqual([{ header: '', question: 'Which color?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cold' }], multiple: false, custom: true }]);
    await adapter.replyQuestion('mem_p1', asked.request.id, [['Blue']]);
    await waitFor(() => lastAssistant(adapter!).completed);
    expect(lastText(adapter)).toBe('answer={"outcome":"accepted","answers":{"Which color?":"Blue"},"annotations":{}}');
  });

  it('dismissing a question answers with an error the model can read', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir));
    await adapter.send('mem_p1', 'ASK');
    await waitFor(() => events.some((e) => e.type === 'question'));
    const asked = events.find((e) => e.type === 'question') as Extract<ChatEvent, { type: 'question' }>;
    await adapter.replyQuestion('mem_p1', asked.request.id, null);
    await waitFor(() => lastAssistant(adapter!).completed);
    expect(lastText(adapter)).toMatch(/^error=The user dismissed these questions in Latte/);
  });

  it('confirms the MCP servers Grok reports ready', async () => {
    const confirmed: string[][] = [];
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile, onMcpServers: (_chat, names) => confirmed.push(names) });
    await adapter.start(input(dir, { mcpServers: [COORDINATION] }));
    await waitFor(() => confirmed.length > 0);
    expect(confirmed[0]).toEqual(['latte_coordination']);
    expect(grokProfile.mcpToolName('latte_coordination', 'latte_report')).toBe('latte_coordination__latte_report');
  });

  it('"always" on a permission picks the session-wide option Grok offers', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir));
    await adapter.send('mem_p1', 'PERMISSION');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const asked = events.find((e) => e.type === 'permission') as Extract<ChatEvent, { type: 'permission' }>;
    await adapter.replyPermission('mem_p1', asked.request.id, 'always');
    await waitFor(() => lastAssistant(adapter!).completed);
    expect(lastText(adapter)).toBe('permission=allow-edits-session');
  });

  it('a trusted folder does not become Grok accept-edits: it keeps asking', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: grokProfile });
    await adapter.start(input(dir, { trustedFolder: true }));
    expect(fakeRequests(setup.log, 'session/set_mode')).toEqual([]);
    expect((fakeRequests(setup.log, 'session/new')[0]._meta as Record<string, unknown>).yoloMode).toBe(false);
  });
});

describe('Hermes profile', () => {
  let dir: string;
  let setup: FakeAcpSetup;
  let adapter: AcpChatAdapter | null = null;
  let events: ChatEvent[];

  beforeEach(() => {
    dir = makeTempDir('latte-hermes-');
    setup = { dir, log: path.join(dir, 'fake.log'), state: path.join(dir, 'state'), flavor: 'hermes', extraEnv: { FAKE_ACP_DEFAULT_MODEL: 'openai-codex:gpt-6-luna', FAKE_ACP_CATALOG: 'gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-5.5' } };
    events = [];
  });
  afterEach(async () => {
    adapter?.shutdown();
    adapter = null;
    await new Promise((r) => setTimeout(r, 50));
    removeDir(dir);
  });

  it('runs `acp` with its own HERMES_HOME and an empty ~', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    await adapter.start(input(dir));
    const start = readFakeLog(setup.log).find((e) => e.kind === 'start') as { argv: string[]; env: Record<string, string> };
    const account = path.join(dir, 'accounts', ACCOUNT);
    expect(start.argv).toEqual(['acp']);
    expect(start.env).toMatchObject({ HERMES_HOME: account, USERPROFILE: path.join(account, 'home'), HOME: path.join(account, 'home') });
    // Los comandos peligrosos le preguntan a la persona, no al "smart approval" de Hermes.
    expect(fs.readFileSync(path.join(account, 'config.yaml'), 'utf8')).toContain('approvals:\n  mode: manual');
  });

  it('on Windows, children of Hermes stop inheriting the ACP pipe (the stdin fix rides PYTHONPATH)', () => {
    const accountHome = path.join(dir, 'acc');
    const supportDir = path.join(dir, 'support');
    const ctx = { accountHome, supportDir, platform: 'win32' as NodeJS.Platform };
    hermesProfile.prepareHome?.(ctx);
    const env = hermesProfile.env(ctx);
    expect(env.PYTHONPATH).toBe(path.join(supportDir, 'hermes-stdin-fix'));
    expect(fs.readFileSync(path.join(env.PYTHONPATH, 'sitecustomize.py'), 'utf8')).toBe(HERMES_STDIN_FIX);
    expect(HERMES_STDIN_FIX).toContain('SetStdHandle(-10');
    expect(hermesProfile.env({ ...ctx, platform: 'linux' }).PYTHONPATH).toBeUndefined();
  });

  it('keeps the approvals the person chose in this account, and never duplicates the block', () => {
    const home = path.join(dir, 'acc');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: gpt-5.5\n  provider: openai-codex');
    ensureManualApprovals(home);
    ensureManualApprovals(home);
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe('model:\n  default: gpt-5.5\n  provider: openai-codex\napprovals:\n  mode: manual\n');
    fs.writeFileSync(path.join(home, 'config.yaml'), 'approvals:\n  mode: smart\n');
    ensureManualApprovals(home);
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe('approvals:\n  mode: smart\n');
  });

  it('switches to the tier model and reloads the session so the ACP MCP servers come back', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    const result = await adapter.start(input(dir, { tier: 'balanced', mcpServers: [COORDINATION] }));
    expect(fakeRequests(setup.log, 'session/set_model')).toEqual([{ sessionId: result.runtimeSessionId, modelId: HERMES_DEFAULT_TIER_MODELS.balanced }]);
    const loads = fakeRequests(setup.log, 'session/load');
    expect(loads).toHaveLength(1);
    expect(loads[0].mcpServers).toEqual(fakeRequests(setup.log, 'session/new')[0].mcpServers);
    expect(result.session.model).toBe(HERMES_DEFAULT_TIER_MODELS.balanced);
    await turn(adapter, events, 'LISTMCP');
    expect(lastText(adapter)).toContain('mcp=[latte_coordination]');
    expect(lastText(adapter)).toContain(`model=${HERMES_DEFAULT_TIER_MODELS.balanced}`);
  });

  it('a model Hermes cannot switch to keeps the conversation on its own model and says so', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    const result = await adapter.start(input(dir, { model: 'openai-codex:gpt-6-astra', mcpServers: [COORDINATION] }));
    expect(result.session.model).toBe('openai-codex:gpt-6-luna');
    expect(events.some((e) => e.type === 'error' && /did not switch to openai-codex:gpt-6-astra/.test(e.message) && /No LLM provider configured/.test(e.message))).toBe(true);
    expect(fakeRequests(setup.log, 'session/load')).toEqual([]);
    await turn(adapter, events, 'LISTMCP');
    expect(lastText(adapter)).toContain('mcp=[latte_coordination]');
  });

  it('skips set_model when the session is already on the wanted model', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile, tierModel: () => 'openai-codex:gpt-6-luna' });
    await adapter.start(input(dir));
    expect(fakeRequests(setup.log, 'session/set_model')).toEqual([]);
  });

  it('puts the role before the first message only, and never on screen', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    await adapter.start(input(dir, { mcpServers: [COORDINATION] }));
    await turn(adapter, events, 'ECHO uno');
    expect(lastText(adapter)).toContain('Sos la estratega de la marca.');
    expect(lastText(adapter)).toContain('mcp__<server>__<tool>');
    expect(lastText(adapter).endsWith('ECHO uno')).toBe(true);
    const user = adapter.listMessages('mem_p1').find((m) => m.role === 'user');
    expect(user?.parts).toEqual([expect.objectContaining({ text: 'ECHO uno' })]);
    await turn(adapter, events, 'ECHO dos');
    expect(lastText(adapter)).toBe('ECHO dos');
    expect(hermesPreamble({ ...input(dir), instructions: '' })).toBeNull();
  });

  it('a resumed conversation already has its role: no preamble, and the rescue load replays nothing on screen', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    const first = await adapter.start(input(dir));
    await turn(adapter, events, 'hola');
    adapter.stop('mem_p1');
    const resumed = await adapter.start(input(dir, { previousSessionId: first.runtimeSessionId }));
    expect(resumed.session.resumed).toBe(true);
    // Retomada: el `session/load` del resume y el de rescate después de `set_model`.
    expect(fakeRequests(setup.log, 'session/load').length).toBeGreaterThanOrEqual(2);
    expect(adapter.listMessages('mem_p1')).toEqual([]);
    await turn(adapter, events, 'ECHO tres');
    expect(lastText(adapter)).toBe('ECHO tres');
  });

  it('maps the trusted folder to accept_edits and anything else to default', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    await adapter.start(input(dir, { trustedFolder: true }));
    await adapter.start(input(dir, { chatId: 'mem_p2' }));
    expect(fakeRequests(setup.log, 'session/set_mode').map((p) => p.modeId)).toEqual(['accept_edits', 'default']);
  });

  it('reports the context from usage_update, without a cost, and gives up permissions at 60 s', async () => {
    adapter = makeFakeAcpAdapter(events, setup, { profile: hermesProfile });
    await adapter.start(input(dir));
    await turn(adapter, events, 'hola');
    const usage = events.find((e) => e.type === 'usage') as Extract<ChatEvent, { type: 'usage' }>;
    expect(usage.turn).toMatchObject({ contextTokens: 11437, costUsd: null });
    expect(hermesProfile.permissionTimeoutMs).toBe(60_000);
    expect(hermesProfile.questions).toBeNull();
    expect(hermesProfile.confirmsMcpInjection).toBe(false);
    expect(hermesProfile.mcpToolName('latte_coordination', 'latte_report')).toBe('mcp__latte_coordination__latte_report');
  });
});
