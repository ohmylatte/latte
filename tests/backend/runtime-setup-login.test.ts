import { describe, expect, it } from 'vitest';
import { RuntimeSetupService } from '../../electron/runtime/setup/runtimeSetup';
import { LIMITS, settleAll, setupHarness } from './runtime-setup-fakes';

const CLAUDE_EXE = 'C:\\Users\\ana\\.local\\bin\\claude.exe';
const ACC = 'acc_0123456789abcdef';
const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=abc123';

function loginStates(events: Array<{ kind: string; state: unknown }>): unknown[] {
  return events.filter((e) => e.kind === 'login').map((e) => e.state);
}

function withClaude() {
  const h = setupHarness();
  h.resolved.set('claude', { executable: CLAUDE_EXE, version: '2.1.211' });
  return h;
}

describe('RuntimeSetupService: browser login', () => {
  it('runs the login in a hidden PTY with the managed account env, captures the URL, opens the browser and confirms with the runtime status', async () => {
    const h = withClaude();
    h.statusQueue.set(`claude:${ACC}`, [{ loggedIn: false, detail: 'Sin sesión iniciada' }, { loggedIn: true, detail: 'Plan max', displayName: 'ana@example.com' }]);
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();

    expect(h.terminal.started).toHaveLength(1);
    const pty = h.terminal.started[0];
    expect(pty.executable).toBe(CLAUDE_EXE);
    expect(pty.args).toEqual(['auth', 'login']);
    expect(pty.extraEnv).toEqual({ CLAUDE_CONFIG_DIR: `C:\\data\\accounts\\claude\\${ACC}` });
    expect(pty.cols).toBe(500);
    expect(job.sessionId).toBe(pty.id);

    h.terminal.print(0, `\u001b[2mVisit this URL to sign in:\u001b[0m\r\n${CLAUDE_URL}\r\n`);
    await settleAll();
    expect(h.opened).toEqual([CLAUDE_URL]);

    h.scheduler.fire(LIMITS.statusPollMs);
    await settleAll();
    h.scheduler.fire(LIMITS.statusPollMs);
    await settleAll();

    expect(loginStates(h.events)).toEqual([
      { state: 'starting' },
      { state: 'browser_opened', url: CLAUDE_URL, openedBy: 'latte' },
      { state: 'waiting', url: CLAUDE_URL },
      { state: 'connected', displayName: 'ana@example.com' },
    ]);
    expect(h.terminal.stopped).toContain(pty.id);
    expect(setup.getJob(job.jobId)).toMatchObject({ done: true });
  });

  it('does not open a second tab when the runtime says it opened the browser; "Abrir de nuevo" opens the captured URL', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    h.terminal.print(0, `Opening browser to sign in…\r\nIf it did not open: ${CLAUDE_URL}\r\n`);
    await settleAll();
    expect(h.opened).toEqual([]);
    expect(loginStates(h.events).at(-1)).toEqual({ state: 'browser_opened', url: CLAUDE_URL, openedBy: 'runtime' });
    await setup.reopenLogin(job.jobId);
    expect(h.opened).toEqual([CLAUDE_URL]);
  });

  it('joins a URL the PTY wrapped at the column width', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    await setup.startLogin('claude', ACC);
    await settleAll();
    const long = `https://claude.ai/oauth/authorize?state=${'x'.repeat(600)}`;
    const wrapped = long.slice(0, 500) + '\r\n' + long.slice(500) + '\r\n';
    h.terminal.print(0, wrapped);
    await settleAll();
    expect(h.opened).toEqual([long]);
  });

  it('never opens a URL outside the runtime allowlist, and falls back to the embedded terminal when nothing is recognized in time', async () => {
    const h = withClaude();
    h.statusQueue.set(`claude:${ACC}`, [{ loggedIn: true, detail: 'ok', displayName: null }]);
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    h.terminal.print(0, 'Go to https://evil.example.com/login?x=1 to continue\r\n');
    await settleAll();
    expect(h.opened).toEqual([]);
    h.scheduler.fire(LIMITS.urlTimeoutMs);
    await settleAll();
    expect(loginStates(h.events).at(-1)).toEqual({ state: 'needs_terminal', reason: 'url_not_recognized', sessionId: job.sessionId });
    // The terminal is live, not a dead end: the person finishes there and Latte still confirms.
    expect(h.terminal.stopped).not.toContain(job.sessionId);
    h.scheduler.fire(LIMITS.statusPollMs);
    await settleAll();
    expect(loginStates(h.events).at(-1)).toEqual({ state: 'connected', displayName: null });
  });

  it('fails as not_confirmed when the login process ends and the runtime says it is not logged in', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    h.terminal.print(0, 'Error: login cancelled by user\r\n');
    h.terminal.exit(0, 1);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'not_confirmed', detail: expect.stringContaining('login cancelled') });
  });

  it('confirms instead of failing when the process ends after a successful login', async () => {
    const h = withClaude();
    h.statusQueue.set(`claude:${ACC}`, [{ loggedIn: true, detail: 'ok', displayName: null }]);
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    h.terminal.print(0, 'Login successful. Press Enter to continue\r\n');
    h.terminal.exit(0, 0);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toEqual({ state: 'connected', displayName: null });
  });

  it('reports not_installed with a code (the renderer offers "Lo instalamos por vos")', async () => {
    const h = setupHarness();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    expect(h.terminal.started).toHaveLength(0);
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'not_installed' });
  });

  it('reports terminal_unavailable when node-pty cannot load', async () => {
    const h = withClaude();
    h.terminal.unavailable = true;
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'terminal_unavailable' });
  });

  it('sends Hermes straight to the embedded terminal: it needs a provider and model chosen first', async () => {
    const h = setupHarness();
    h.resolved.set('hermes', { executable: 'C:\\hermes\\hermes.exe', version: 'v0.21.0' });
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('hermes', ACC);
    await settleAll();
    expect(h.terminal.started[0].args).toEqual(['model']);
    expect(setup.getJob(job.jobId).state).toEqual({ state: 'needs_terminal', reason: 'needs_choice', sessionId: job.sessionId });
    expect(h.opened).toEqual([]);
  });

  it('logs Codex in through its app-server URL, no PTY', async () => {
    const h = setupHarness();
    h.resolved.set('codex', { executable: 'C:\\codex.exe', version: '0.90' });
    h.statusQueue.set(`codex:${ACC}`, [{ loggedIn: true, detail: 'Logged in using ChatGPT' }]);
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('codex', ACC);
    await settleAll();
    expect(job.sessionId).toBeNull();
    expect(h.terminal.started).toHaveLength(0);
    expect(h.opened).toEqual(['https://auth.openai.com/oauth/authorize?client_id=x&state=y']);
    h.scheduler.fire(LIMITS.statusPollMs);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toEqual({ state: 'connected', displayName: null });
  });

  it('cancels: stops the hidden terminal', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    expect(setup.cancelLogin(job.jobId)).toMatchObject({ done: true, state: { state: 'cancelled' } });
    expect(h.terminal.stopped).toContain(job.sessionId);
    h.terminal.exit(0, 1);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toEqual({ state: 'cancelled' });
  });

  it('times out a login nobody finishes', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    const job = await setup.startLogin('claude', ACC);
    await settleAll();
    h.scheduler.fire(LIMITS.loginTimeoutMs);
    await settleAll();
    expect(setup.getJob(job.jobId).state).toMatchObject({ state: 'failed', code: 'timeout' });
    expect(h.terminal.stopped).toContain(job.sessionId);
  });

  it('keeps one login per account: a second start returns the live job', async () => {
    const h = withClaude();
    const setup = new RuntimeSetupService(h.deps);
    const a = await setup.startLogin('claude', ACC);
    const b = await setup.startLogin('claude', ACC);
    expect(b.jobId).toBe(a.jobId);
    await settleAll();
    expect(h.terminal.started).toHaveLength(1);
  });
});

describe('RuntimeSetupService: diagnostic', () => {
  it('lists every runtime and builds a copyable report with no emails, account names or home directory', async () => {
    const h = setupHarness({
      accounts: [
        { runtime: 'claude', id: 'system', label: 'Mi sesión de Claude Code', system: true, loggedIn: true, detail: 'Plan max · claude.ai · ana@example.com', models: [] },
        { runtime: 'grok', id: ACC, label: 'Cuenta de Ana Pérez', system: false, loggedIn: false, detail: 'Sin sesión iniciada', models: [] },
      ],
    });
    h.resolved.set('claude', { executable: CLAUDE_EXE, version: '2.1.211 (Claude Code)' });
    const setup = new RuntimeSetupService(h.deps);
    // A failed install leaves its code behind for "¿Qué falta?".
    await setup.startInstall('grok', null);
    await settleAll();
    h.launched[0].print("irm : The remote name could not be resolved: 'x.ai'\n");
    h.launched[0].exit(1);
    await settleAll();

    const diagnostic = await setup.diagnose();
    expect(diagnostic.runtimes).toEqual([
      { runtime: 'claude', installed: true, version: '2.1.211 (Claude Code)', path: '~\\.local\\bin\\claude.exe', loggedIn: true, lastError: null },
      { runtime: 'codex', installed: false, version: null, path: null, loggedIn: false, lastError: null },
      { runtime: 'opencode', installed: false, version: null, path: null, loggedIn: null, lastError: null },
      { runtime: 'grok', installed: false, version: null, path: null, loggedIn: false, lastError: 'network' },
      { runtime: 'hermes', installed: false, version: null, path: null, loggedIn: false, lastError: null },
    ]);
    expect(diagnostic.report).toContain('claude');
    expect(diagnostic.report).toContain('network');
    expect(diagnostic.report).toContain('9.9.9');
    expect(diagnostic.report).not.toMatch(/@|ana|Ana|Pérez|C:\\Users/);
  });
});
