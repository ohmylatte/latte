#!/usr/bin/env node
'use strict';
// Stand-in for `claude -p --output-format stream-json --input-format stream-json`.
// Speaks the subset of the protocol Latte relies on, deterministically.
const readline = require('node:readline');

const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex !== -1 ? args[resumeIndex + 1] : 'sess-fake-0001';
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'claude-fake';
const stdioPermissions = args.includes('--permission-prompt-tool') && args[args.indexOf('--permission-prompt-tool') + 1] === 'stdio';
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// El `mcp_servers` que el `system/init` real trae, con el ESTADO de conexion
// de cada servidor. `FAKE_CLAUDE_MCP_STATUS` (un objeto nombre->estado) lo
// reemplaza, para probar que Latte lee el reporte del runtime y no su propia
// lista de pedidos.
const mcpServers = process.env.FAKE_CLAUDE_MCP_STATUS
  ? Object.entries(JSON.parse(process.env.FAKE_CLAUDE_MCP_STATUS)).map(([name, status]) => ({ name, status }))
  : [{ name: 'The-agentcy', status: 'needs-auth' }, { name: 'efecto', status: 'connected' }];

let initialised = false;
let counter = 0;
let pendingTool = null;

function reply(text, extraBlocks) {
  const id = `msg_${++counter}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant' } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId });
  const half = Math.ceil(text.length / 2);
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } }, session_id: sessionId });
  out({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'text', text }] }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId });
  for (const block of extraBlocks || []) out({ type: 'assistant', message: { id, role: 'assistant', model, content: [block] }, session_id: sessionId });
  return id;
}

function replyThinkingThenText(text) {
  const id = `msg_${++counter}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant' } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando' } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }, session_id: sessionId });
  // Solo el texto, en el indice 0 de su propio array.
  out({ type: 'assistant', message: { id, role: 'assistant', model, content: [{ type: 'text', text }] }, session_id: sessionId });
  return id;
}

// The real CLI prices the whole PROCESS on every result and counts tokens per
// turn, so the second result here reports 0.02 for two turns that cost 0.01
// each. Latte has to read that as a delta, not as a second full charge.
let turns = 0;
function finish(resultText, isError) {
  turns += 1;
  out({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: Boolean(isError),
    result: resultText,
    session_id: sessionId,
    num_turns: turns,
    total_cost_usd: Number((0.01 * turns).toFixed(4)),
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 },
    modelUsage: { [model]: { inputTokens: 120, outputTokens: 45, costUSD: 0.01 } },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'user') {
    const text = typeof msg.message?.content === 'string' ? msg.message.content : '';
    if (!initialised) {
      initialised = true;
      out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: 'default', tools: ['Write'], cwd: process.cwd(), mcp_servers: mcpServers });
    }
    out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId });
    if (/razonar/i.test(text)) {
      replyThinkingThenText('Encontre actividad real en la cuenta.');
      finish('ok');
      return;
    }
    if (/write/i.test(text)) {
      const toolId = `toolu_${++counter}`;
      const input = { file_path: 'brief.md', content: 'hello' };
      reply('Writing the file now.', [{ type: 'tool_use', id: toolId, name: 'Write', input }]);
      pendingTool = { toolId, input };
      if (stdioPermissions) {
        out({ type: 'control_request', request_id: `req_${counter}`, request: { subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: 'brief.md', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: toolId } });
      } else {
        out({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: toolId, message: 'not granted', session_id: sessionId });
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'not granted', is_error: true }] }, session_id: sessionId });
        finish('Blocked.', false);
      }
      return;
    }
    // Lets a test see the command line it was actually started with.
    if (/argv/i.test(text)) {
      reply(`ARGV ${args.join(' ')}`);
      finish('ARGV', false);
      return;
    }
    if (/slow/i.test(text)) {
      reply('Thinking slowly...');
      return; // waits for interrupt
    }
    // El `result` que el CLI 2.1.278 manda cuando el turno se rompe: trae
    // `subtype` y `errors`, y NO trae `result`. Latte leia solo `result`, asi
    // que la persona veia el generico y no quedaba nada escrito en ningun lado.
    if (/sin-result/i.test(text)) {
      reply('Intentando...');
      turns += 1;
      out({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['boom'],
        session_id: sessionId,
        num_turns: turns,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      return;
    }
    // El aviso de limite de uso. No es un `result`: llega solo, y el turno
    // puede terminar bien igual.
    if (/limite-rechazado/i.test(text)) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1758400000, rateLimitType: 'five_hour', unifiedRateLimitFallbackAvailable: false } });
      finish('ok', false);
      return;
    }
    if (/limite-permitido/i.test(text)) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1758400000, rateLimitType: 'five_hour', utilization: 0.97 } });
      finish('ok', false);
      return;
    }
    if (/informativo/i.test(text)) {
      out({ type: 'system', subtype: 'informational', message: 'el modelo cambio a sonnet', session_id: sessionId });
      finish('ok', false);
      return;
    }
    if (/fail/i.test(text)) {
      finish('Simulated failure', true);
      return;
    }
    reply(`Echo: ${text}`);
    finish(`Echo: ${text}`, false);
    return;
  }
  if (msg.type === 'control_response' && pendingTool) {
    const response = msg.response?.response || {};
    const allowed = response.behavior === 'allow';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: pendingTool.toolId, content: allowed ? 'File created successfully at: brief.md' : 'User declined', is_error: !allowed }] }, session_id: sessionId });
    pendingTool = null;
    reply(allowed ? 'Done, the file is written.' : 'Understood, I did not write the file.');
    finish(allowed ? 'Done' : 'Skipped', false);
    return;
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    finish('Interrupted by user', false);
  }
});
rl.on('close', () => process.exit(0));
