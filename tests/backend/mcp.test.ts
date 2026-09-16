import { describe, expect, it } from 'vitest';
import { claudeAddArgs, codexAddArgs, McpCatalog, parseClaude, parseCodex, parseOpenCode } from '../../electron/agents/mcp';
import { RuntimeDetector } from '../../electron/runtime/detect';
import { fakeRunner, notFoundRunner } from './helpers';

/** Captured from `claude mcp list` on this machine. */
const CLAUDE_OUTPUT = `Checking MCP server health…

plugin:engram:engram: engram mcp --tools=agent - ✔ Connected
efecto: npx -y @efectoapp/mcp - ✔ Connected
acdp: C:\\Program Files\\nodejs\\node.exe C:\\Users\\x\\acdp-mcp.js - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
remoto: https://mcp.sentry.dev/mcp - ✔ Connected
sentry: https://mcp.sentry.dev/mcp - ! Needs authentication
`;

/** Captured from `codex mcp list --json`. */
const CODEX_OUTPUT = JSON.stringify([
  { name: 'engram', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'C:\\engram.exe', args: ['mcp', '--tools=agent'] } },
  { name: 'apagado', enabled: false, disabled_reason: 'sin credenciales', transport: { type: 'stdio', command: 'npx', args: ['algo'] } },
  { name: 'remoto', enabled: true, transport: { type: 'http', url: 'https://mcp.example.test/mcp' } },
]);

/** Captured from `opencode mcp list` (decorated tree with colour codes). */
const OPENCODE_OUTPUT = `\u001b[0m
\u001b[90m┌\u001b[39m  MCP Servers
\u001b[90m│\u001b[39m
\u001b[34m●\u001b[39m  ✓ context7 \u001b[90mconnected
\u001b[90m│\u001b[39m      \u001b[90mhttps://mcp.context7.com/mcp
\u001b[90m│\u001b[39m
\u001b[34m●\u001b[39m  ✓ engram \u001b[90mconnected
\u001b[90m│\u001b[39m      \u001b[90mC:\\engram.exe mcp --tools=agent
\u001b[90m│\u001b[39m
\u001b[34m●\u001b[39m  ✗ roto \u001b[90mfailed
`;

describe('Reading what each runtime has configured', () => {
  it('parses Claude Code, including the real connection state', () => {
    const servers = parseClaude(CLAUDE_OUTPUT);
    expect(servers.map((s) => [s.name, s.status, s.transport])).toEqual([
      ['plugin:engram:engram', 'connected', 'stdio'],
      ['efecto', 'connected', 'stdio'],
      ['acdp', 'failed', 'stdio'],
      ['remoto', 'connected', 'http'],
      ['sentry', 'needsAuth', 'http'],
    ]);
    expect(servers[4].needsAuth).toBe(true);
    expect(servers[1].target).toBe('npx -y @efectoapp/mcp');
    expect(servers[2].detail).toContain('CONNECTION_CLOSED');
    expect(parseClaude('')).toEqual([]);
  });

  it('parses Codex JSON, including a disabled server and its reason', () => {
    const servers = parseCodex(CODEX_OUTPUT);
    expect(servers.map((s) => [s.name, s.status, s.transport])).toEqual([
      ['engram', 'configured', 'stdio'],
      ['apagado', 'disabled', 'stdio'],
      ['remoto', 'configured', 'http'],
    ]);
    expect(servers[0].target).toBe('C:\\engram.exe mcp --tools=agent');
    expect(servers[1].detail).toBe('sin credenciales');
    expect(servers[2].target).toBe('https://mcp.example.test/mcp');
    // Malformed output must not take the screen down.
    expect(parseCodex('not json')).toEqual([]);
    expect(parseCodex('{}')).toEqual([]);
  });

  it('parses the OpenCode tree through its colour codes', () => {
    const servers = parseOpenCode(OPENCODE_OUTPUT);
    expect(servers.map((s) => [s.name, s.status])).toEqual([['context7', 'connected'], ['engram', 'connected'], ['roto', 'failed']]);
    expect(servers[0].transport).toBe('http');
    expect(servers[0].target).toBe('https://mcp.context7.com/mcp');
    expect(servers[1].target).toBe('C:\\engram.exe mcp --tools=agent');
    expect(parseOpenCode('')).toEqual([]);
  });
});

describe('Adding a server through the runtime CLI', () => {
  it('builds arguments as an array, never a shell string', () => {
    expect(claudeAddArgs({ name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notion/mcp'], url: '', env: ['NOTION_TOKEN=abc'] }))
      .toEqual(['mcp', 'add', '--scope', 'user', '-e', 'NOTION_TOKEN=abc', 'notion', '--', 'npx', '-y', '@notion/mcp']);
    expect(claudeAddArgs({ name: 'sentry', transport: 'http', command: '', args: [], url: 'https://mcp.sentry.dev/mcp', env: [] }))
      .toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'sentry', 'https://mcp.sentry.dev/mcp']);
    expect(codexAddArgs({ name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notion/mcp'], url: '', env: ['NOTION_TOKEN=abc'] }))
      .toEqual(['mcp', 'add', '--env', 'NOTION_TOKEN=abc', 'notion', '--', 'npx', '-y', '@notion/mcp']);
    expect(codexAddArgs({ name: 'remoto', transport: 'http', command: '', args: [], url: 'https://x.test/mcp', env: [] }))
      .toEqual(['mcp', 'add', 'remoto', '--url', 'https://x.test/mcp']);
  });

  it('refuses names and variables that are not what they claim to be', async () => {
    const catalog = new McpCatalog({
      runner: fakeRunner(() => ({ code: 0, stdout: '' })),
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
    });
    const base = { name: 'x', transport: 'stdio' as const, command: 'npx', args: [], url: '', env: [] };
    await expect(catalog.add('claude', { ...base, name: 'con espacio' })).rejects.toThrow(/nombre/i);
    await expect(catalog.add('claude', { ...base, name: '../escape' })).rejects.toThrow(/nombre/i);
    await expect(catalog.add('claude', { ...base, env: ['no-es-una-variable'] })).rejects.toThrow(/Variable inválida/);
    await expect(catalog.remove('claude', 'mal nombre')).rejects.toThrow(/inválido/i);
  });

  it('reports honestly when a runtime is missing or the command fails', async () => {
    const missing = new McpCatalog({
      runner: notFoundRunner,
      detector: new RuntimeDetector({ runner: notFoundRunner, terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
    });
    const list = await missing.list();
    expect(list.map((r) => [r.runtime, r.installed, r.canEdit])).toEqual([['claude', false, false], ['codex', false, false], ['opencode', false, false]]);
    expect(list[0].detail).toMatch(/no está instalado/i);
    await expect(missing.add('claude', { name: 'x', transport: 'stdio', command: 'npx', args: [], url: '', env: [] })).rejects.toThrow(/no está instalado/i);
  });

  it('says that OpenCode can only be read from here', async () => {
    const catalog = new McpCatalog({
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
        if (args[0] === 'mcp' && args[1] === 'list' && args[2] === '--json') return { code: 0, stdout: CODEX_OUTPUT };
        if (args[0] === 'mcp' && args[1] === 'list') return { code: 0, stdout: file.includes('opencode') ? OPENCODE_OUTPUT : CLAUDE_OUTPUT };
        return { code: 0, stdout: '1.0\n' };
      }),
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
    });
    const list = await catalog.list();
    const opencode = list.find((r) => r.runtime === 'opencode');
    expect(opencode).toMatchObject({ installed: true, canEdit: false });
    expect(opencode?.detail).toMatch(/interactivo/i);
    expect(opencode?.servers.map((s) => s.name)).toEqual(['context7', 'engram', 'roto']);
    expect(list.find((r) => r.runtime === 'claude')?.canEdit).toBe(true);
    expect(list.find((r) => r.runtime === 'codex')?.servers).toHaveLength(3);
  });

  it('answers for one runtime alone, so the screen fills in as each lands', async () => {
    const runner = fakeRunner((file, args) => {
      if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
      if (args[0] === 'mcp' && args[2] === '--json') return { code: 0, stdout: CODEX_OUTPUT };
      if (args[0] === 'mcp') return { code: 0, stdout: file.includes('opencode') ? OPENCODE_OUTPUT : CLAUDE_OUTPUT };
      return { code: 0, stdout: '1.0\n' };
    });
    const catalog = new McpCatalog({
      runner,
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
    });
    const codex = await catalog.listOne('codex');
    expect(codex).toMatchObject({ runtime: 'codex', installed: true, canEdit: true });
    expect(codex.servers).toHaveLength(3);
    // Asking for one must not have queried the slow one.
    expect(runner.calls.filter((c) => c.args[0] === 'mcp')).toHaveLength(1);
  });

  it('starts Codex MCP OAuth login and marks servers that need auth', async () => {
    const catalog = new McpCatalog({
      runner: fakeRunner((file, args) => {
        if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
        if (args[0] === 'mcp' && args[2] === '--json') return { code: 0, stdout: CODEX_OUTPUT };
        return { code: 0, stdout: '1.0\n' };
      }),
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
      codex: {
        listMcpStatus: async () => [{ name: 'remoto', authStatus: 'notLoggedIn' }, { name: 'engram', authStatus: 'unsupported' }],
        startMcpLogin: async (accountId, name) => ({ url: `https://auth.example.test/mcp?account=${accountId}&name=${name}` }),
      },
    });
    const listed = await catalog.listOne('codex');
    expect(listed.servers.find((s) => s.name === 'remoto')).toMatchObject({ status: 'needsAuth', needsAuth: true });
    const login = await catalog.loginCodex('remoto');
    expect(login).toMatchObject({ mode: 'browser', url: 'https://auth.example.test/mcp?account=system&name=remoto' });
  });

  it('surfaces a clear error when Codex does not support MCP OAuth', async () => {
    const catalog = new McpCatalog({
      runner: fakeRunner(() => ({ code: 0, stdout: '' })),
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
      codex: {
        listMcpStatus: async () => { throw new Error('Este Codex no soporta mcpServerStatus/list: unknown method'); },
        startMcpLogin: async () => { throw new Error('Este Codex no pudo iniciar sesión en el servidor MCP «x»: unknown method'); },
      },
    });
    await expect(catalog.loginCodex('x')).rejects.toThrow(/unknown method/i);
  });

  it('opens an embedded Claude terminal with the account profile env', async () => {
    const started: Array<{ cwd: string; extraEnv?: Record<string, string>; args?: string[] }> = [];
    const catalog = new McpCatalog({
      runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: 'C:\\bin\\claude.exe\n' } : { code: 0, stdout: '1.0\n' })),
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: true, reason: '' }), platform: 'win32', env: {} }),
      accountEnv: (_runtime, accountId): Record<string, string> => (accountId ? { CLAUDE_CONFIG_DIR: `C:\\profiles\\${accountId}` } : {}),
      env: {},
      startTerminal: (input) => {
        started.push({ cwd: input.cwd, extraEnv: input.extraEnv, args: input.args });
        return { id: 'ses_mcp', workId: input.workId, provider: 'claude' };
      },
    });
    const login = await catalog.authenticateClaude('C:\\work\\folder', 'acc_0123456789abcdef');
    expect(login).toMatchObject({ mode: 'terminal', sessionId: 'ses_mcp' });
    expect(login.instructions).toMatch(/\/mcp/);
    expect(started[0]).toEqual({
      cwd: 'C:\\work\\folder',
      extraEnv: { CLAUDE_CONFIG_DIR: 'C:\\profiles\\acc_0123456789abcdef' },
      args: [],
    });
  });

  it('asks the three runtimes at the same time, not one after the other', async () => {
    // Claude Code health-checks every server before answering. Asked in turn,
    // the three timeouts stacked up and the screen stayed empty for a minute.
    let inFlight = 0;
    let peak = 0;
    const runner = fakeRunner(async (file, args) => {
      if (file === 'where.exe' || file === 'which') return { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` };
      if (args[0] !== 'mcp') return { code: 0, stdout: '1.0\n' };
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (args[2] === '--json') return { code: 0, stdout: CODEX_OUTPUT };
      return { code: 0, stdout: file.includes('opencode') ? OPENCODE_OUTPUT : CLAUDE_OUTPUT };
    });
    const catalog = new McpCatalog({
      runner,
      detector: new RuntimeDetector({ runner: fakeRunner((file, args) => (file === 'where.exe' || file === 'which' ? { code: 0, stdout: `C:\\bin\\${args[0]}.exe\n` } : { code: 0, stdout: '1.0\n' })), terminalAvailability: () => ({ available: false, reason: 'test' }), platform: 'win32', env: {} }),
      accountEnv: () => ({}),
      env: {},
    });
    const list = await catalog.list();
    expect(peak).toBe(3);
    // Order still has to be stable, or the cards would jump around on refresh.
    expect(list.map((r) => r.runtime)).toEqual(['claude', 'codex', 'opencode']);
  });
});
