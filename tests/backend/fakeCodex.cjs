#!/usr/bin/env node
'use strict';
// Stand-in for `codex app-server`: newline-delimited JSON-RPC over stdio with
// the subset of methods, notifications and server requests Latte relies on.
const readline = require('node:readline');

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
let counter = 0;
let serverRequestId = 100;
const threads = new Map();
const pendingApprovals = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // Client answering one of our server requests.
  if (msg.id !== undefined && msg.method === undefined && pendingApprovals.has(msg.id)) {
    const pending = pendingApprovals.get(msg.id);
    pendingApprovals.delete(msg.id);
    pending(msg);
    return;
  }
  const { id, method, params = {} } = msg;
  const reply = (result) => out({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      reply({ userAgent: 'fake-codex', codexHome: process.env.CODEX_HOME || 'default-home', platformFamily: 'test' });
      return;
    case 'model/list':
      // Shape of the real answer, including a hidden entry Latte must not offer.
      reply({ data: [
        { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Our most capable model.', hidden: false, isDefault: true },
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Everyday workhorse.', hidden: false, isDefault: false },
        { id: 'gpt-oculto', model: 'gpt-oculto', displayName: 'Escondido', hidden: true, isDefault: false },
        { displayName: 'Sin identificador', hidden: false },
        { model: 'gpt-6-astra', displayName: 'Repetido', hidden: false },
      ] });
      return;
    case 'account/read':
      reply({ account: process.env.FAKE_CODEX_LOGGED_OUT ? null : { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' }, requiresOpenaiAuth: true });
      return;
    case 'account/login/start':
      reply({ type: 'chatgpt', authUrl: 'https://auth.example.test/codex?login=1', loginId: 'login_1' });
      setTimeout(() => notify('account/login/completed', { loginId: 'login_1', success: true }), 20);
      return;
    case 'mcpServer/oauth/login':
      if (process.env.FAKE_CODEX_NO_MCP_OAUTH) {
        out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method mcpServer/oauth/login' } });
        return;
      }
      reply({ authorizationUrl: `https://auth.example.test/mcp?server=${encodeURIComponent(params.name || '')}` });
      return;
    case 'mcpServerStatus/list':
      if (process.env.FAKE_CODEX_NO_MCP_STATUS) {
        out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method mcpServerStatus/list' } });
        return;
      }
      reply({
        data: [
          { name: 'remoto', authStatus: 'notLoggedIn', resourceTemplates: [], resources: [], tools: {} },
          { name: 'engram', authStatus: 'unsupported', resourceTemplates: [], resources: [], tools: {} },
        ],
      });
      return;
    case 'thread/start': {
      const threadId = `thr_${++counter}`;
      threads.set(threadId, { cwd: params.cwd, turns: [], dev: params.developerInstructions || '' });
      reply({ thread: { id: threadId, cwd: params.cwd, createdAt: Date.now() / 1000 }, model: params.model || 'gpt-fake', modelProvider: 'openai', approvalPolicy: params.approvalPolicy, cwd: params.cwd });
      notify('thread/started', { thread: { id: threadId, cwd: params.cwd } });
      return;
    }
    case 'thread/resume': {
      if (!threads.has(params.threadId)) { out({ jsonrpc: '2.0', id, error: { code: -32000, message: 'thread not found' } }); return; }
      threads.get(params.threadId).dev = params.developerInstructions || '';
      reply({ thread: { id: params.threadId, cwd: params.cwd }, model: 'gpt-fake', modelProvider: 'openai' });
      return;
    }
    case 'thread/read': {
      const thread = threads.get(params.threadId);
      reply({ thread: { id: params.threadId, turns: thread ? thread.turns : [] } });
      return;
    }
    case 'turn/start': {
      const threadId = params.threadId;
      const text = (params.input || []).map((i) => i.text || '').join(' ');
      const turnId = `turn_${++counter}`;
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      const userItem = { id: `item_${++counter}`, type: 'userMessage', content: [{ type: 'text', text }] };
      notify('item/started', { threadId, turnId, item: userItem, startedAtMs: Date.now() });
      notify('item/completed', { threadId, turnId, item: userItem, completedAtMs: Date.now() });
      const record = threads.get(threadId);
      if (record) record.turns.push({ id: turnId, items: [userItem] });
      if (record) record.effort = params.effort;
      const finish = (agentText, status) => {
        const agentId = `item_${++counter}`;
        notify('item/started', { threadId, turnId, item: { id: agentId, type: 'agentMessage', text: '' }, startedAtMs: Date.now() });
        const half = Math.ceil(agentText.length / 2);
        notify('item/agentMessage/delta', { threadId, turnId, itemId: agentId, delta: agentText.slice(0, half) });
        notify('item/agentMessage/delta', { threadId, turnId, itemId: agentId, delta: agentText.slice(half) });
        notify('item/completed', { threadId, turnId, item: { id: agentId, type: 'agentMessage', text: agentText }, completedAtMs: Date.now() });
        if (record) record.turns[record.turns.length - 1].items.push({ id: agentId, type: 'agentMessage', text: agentText });
        // The real app-server reports RUNNING TOTALS per thread and fires once
        // per model request, so a turn is the growth of these numbers.
        if (record) {
          record.usage = record.usage || { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
          const last = { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 50, outputTokens: 60, reasoningOutputTokens: 20, totalTokens: 1060 };
          for (const key of Object.keys(last)) record.usage[key] += last[key];
          notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last, total: { ...record.usage }, modelContextWindow: 272000 } });
        }
        notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error: status === 'failed' ? { message: 'Simulated failure' } : null } });
      };
      if (/run/i.test(text)) {
        const cmdItem = { id: `item_${++counter}`, type: 'commandExecution', command: 'echo hola', cwd: params.cwd, status: 'inProgress' };
        notify('item/started', { threadId, turnId, item: cmdItem, startedAtMs: Date.now() });
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const decision = answer.result && answer.result.decision;
          if (decision === 'accept' || decision === 'acceptForSession') {
            notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: cmdItem.id, delta: 'hola\n' });
            notify('item/completed', { threadId, turnId, item: { ...cmdItem, status: 'completed', aggregatedOutput: 'hola\n', exitCode: 0 }, completedAtMs: Date.now() });
            finish('Command ran.', 'completed');
          } else {
            notify('item/completed', { threadId, turnId, item: { ...cmdItem, status: 'declined' }, completedAtMs: Date.now() });
            finish('Command was declined.', 'completed');
          }
        });
        out({ jsonrpc: '2.0', id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: cmdItem.id, command: 'echo hola', cwd: params.cwd, reason: 'Needs to run a command', startedAtMs: Date.now() } });
        return;
      }
      if (/ask/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const picked = answer.result && answer.result.answers && answer.result.answers.q1 ? answer.result.answers.q1.answers.join(',') : 'none';
          finish(`You chose ${picked}.`, 'completed');
        });
        out({ jsonrpc: '2.0', id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: `item_${++counter}`, isBlocking: true, questions: [{ id: 'q1', header: 'Tono', question: 'Which tone?', options: [{ label: 'Warm', description: 'Close' }, { label: 'Formal', description: 'Distant' }], isOther: false, isSecret: false }] } });
        return;
      }
      if (/elicit-url/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const action = answer.result && answer.result.action ? answer.result.action : (answer.error ? 'rpc-error' : 'none');
          finish(`elicitation ${action}`, 'completed');
        });
        out({ jsonrpc: '2.0', id: requestId, method: 'mcpServer/elicitation/request', params: { serverName: 'The-agentcy', threadId, turnId, message: 'Sign in to continue', mode: 'url', url: 'https://auth.example.test/elicit', elicitationId: 'elc_1' } });
        return;
      }
      if (/elicit-form/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const action = answer.result && answer.result.action ? answer.result.action : 'none';
          const content = answer.result && answer.result.content ? JSON.stringify(answer.result.content) : '';
          finish(`elicitation ${action} ${content}`, 'completed');
        });
        out({
          jsonrpc: '2.0', id: requestId, method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'The-agentcy', threadId, turnId, message: 'Workspace profile', mode: 'form',
            requestedSchema: {
              type: 'object',
              properties: {
                workspace: { type: 'string', title: 'Workspace', description: 'Which workspace?' },
                count: { type: 'number', title: 'Count' },
                ok: { type: 'boolean', title: 'Confirm' },
                tone: { type: 'string', title: 'Tone', enum: ['warm', 'formal'] },
              },
              required: ['workspace', 'ok'],
            },
          },
        });
        return;
      }
      if (/elicit-empty-form/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const action = answer.result && answer.result.action ? answer.result.action : 'none';
          const content = answer.result && answer.result.content ? JSON.stringify(answer.result.content) : '';
          finish(`elicitation ${action} ${content}`, 'completed');
        });
        out({
          jsonrpc: '2.0', id: requestId, method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'The-agentcy', threadId, turnId,
            message: 'Allow the The-agentcy MCP server to run tool "set_workspace_profile"?',
            mode: 'form', requestedSchema: { type: 'object', properties: {} },
          },
        });
        return;
      }
      if (/elicit-complex/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, (answer) => {
          const action = answer.result && answer.result.action ? answer.result.action : 'none';
          finish(`elicitation ${action}`, 'completed');
        });
        out({
          jsonrpc: '2.0', id: requestId, method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'The-agentcy', threadId, turnId, message: 'Pick many', mode: 'form',
            requestedSchema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } }, required: ['tags'] },
          },
        });
        return;
      }
      if (/mystery-method/i.test(text)) {
        const requestId = ++serverRequestId;
        pendingApprovals.set(requestId, () => finish('mystery answered', 'completed'));
        out({ jsonrpc: '2.0', id: requestId, method: 'account/chatgptAuthTokens/refresh', params: { threadId, reason: 'unauthorized' } });
        return;
      }
      if (/mcp-tool/i.test(text)) {
        const toolItem = {
          id: `item_${++counter}`,
          type: 'mcpToolCall',
          server: 'The-agentcy',
          tool: 'set_workspace_profile',
          status: 'failed',
          arguments: { workspace: 'acme' },
          result: { content: [{ type: 'text', text: 'could not apply' }], structuredContent: { code: 17 } },
          error: { message: 'profile locked' },
        };
        notify('item/started', { threadId, turnId, item: toolItem, startedAtMs: Date.now() });
        notify('item/completed', { threadId, turnId, item: toolItem, completedAtMs: Date.now() });
        finish('tool failed', 'completed');
        return;
      }
      if (/slow/i.test(text)) {
        threads.get(threadId).slowTurn = turnId;
        return; // waits for turn/interrupt
      }
      // Lets a test see the reasoning effort the turn was actually started with.
      if (/effort/i.test(text)) { finish(`EFFORT ${params.effort || 'none'}`, 'completed'); return; }
      if (/fail/i.test(text)) { finish('', 'failed'); return; }
      finish(`Echo: ${text}${record && record.dev ? ` [dev: ${record.dev}]` : ''}`, 'completed');
      return;
    }
    case 'turn/interrupt':
      reply({});
      notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } });
      return;
    default:
      out({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
rl.on('close', () => process.exit(0));
