import { translate as t, type MessageKey } from './i18n';
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, LoaderCircle, LogIn, Plug, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { AccountLoginStart, ChatRuntime, McpRuntimeTools, McpServer } from '../shared/contracts';
import { api } from './browser-api';
import { TerminalPane } from './TerminalPane';

const RUNTIME_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const STATUS_LABEL: Record<McpServer['status'], MessageKey> = {
  connected: 'tools.status.connected',
  failed: 'tools.status.failed',
  pending: 'tools.status.pending',
  disabled: 'tools.status.disabled',
  configured: 'tools.status.configured',
  needsAuth: 'tools.status.needsAuth',
};
const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * MCP: the tools an agent can reach beyond this folder.
 *
 * Latte implements no MCP client and stores no credential. It reads and writes
 * each runtime's own configuration through its `mcp` command, so what you see
 * here is what that runtime will actually use, in Latte and outside it.
 */
export function ToolsView({ onNotice, onError, workId }: { onNotice: (text: string) => void; onError: (text: string) => void; workId?: string | null }) {
  const [runtimes, setRuntimes] = useState<McpRuntimeTools[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<'claude' | 'codex' | null>(null);
  const [login, setLogin] = useState<{ runtime: ChatRuntime; name: string; start: AccountLoginStart } | null>(null);

  /**
   * One query per runtime, all three at once, each card drawn as it answers.
   * Claude Code health-checks every server it has configured, so it can take
   * half a minute; Codex and OpenCode answer in a second and there is no
   * reason to hide them behind the slow one.
   */
  const load = async () => {
    setLoading(true);
    setRuntimes(null);
    const order: ChatRuntime[] = ['claude', 'codex', 'opencode'];
    const done = new Map<ChatRuntime, McpRuntimeTools>();
    await Promise.all(order.map(async runtime => {
      try {
        const [result] = await api.listMcpServers(runtime);
        if (result) done.set(runtime, result);
      } catch (e) {
        onError(displayError(e));
      }
      setRuntimes(order.filter(r => done.has(r)).map(r => done.get(r) as McpRuntimeTools));
    }));
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const remove = (runtime: 'claude' | 'codex', name: string) => {
    if (!window.confirm(t('ui.auto.407', { p0: name, p1: RUNTIME_NAME[runtime] }))) return;
    setBusy(true);
    api.removeMcpServer(runtime, name)
      .then(async () => { await load(); onNotice(t('tools.removed', { name, runtime: RUNTIME_NAME[runtime] })); })
      .catch(e => onError(displayError(e)))
      .finally(() => setBusy(false));
  };

  const loginCodex = (name: string) => {
    setBusy(true);
    api.loginMcpServer('codex', name)
      .then(start => { setLogin({ runtime: 'codex', name, start }); onNotice(t('tools.loginCodexInstructions', { name })); })
      .catch(e => onError(displayError(e)))
      .finally(() => setBusy(false));
  };
  const authenticateClaude = (name: string) => {
    if (!workId) { onError(t('tools.needWork')); return; }
    setBusy(true);
    void api.getPrimaryAgent().then(primary => api.authenticateClaudeMcp(workId, primary?.runtime === 'claude' ? (primary.accountId ?? 'system') : 'system'))
      .then(start => { setLogin({ runtime: 'claude', name, start }); onNotice(t('tools.authenticateClaudeInstructions')); })
      .catch(e => onError(displayError(e)))
      .finally(() => setBusy(false));
  };

  return <ToolsViewContent runtimes={runtimes} loading={loading} busy={busy} adding={adding} login={login} onError={onError} onRefresh={() => void load()} onRemove={remove} onAdding={setAdding} onLoginCodex={loginCodex} onAuthenticateClaude={authenticateClaude} onDismissLogin={() => {
    if (login?.start.mode === 'terminal') void api.stopAgent(login.start.sessionId).catch(() => undefined);
    setLogin(null);
    void load();
  }} onAdd={async (runtime, input) => {
    setBusy(true);
    try {
      await api.addMcpServer(runtime, input);
      setAdding(null);
      await load();
      onNotice(t('tools.added', { name: input.name, runtime: RUNTIME_NAME[runtime] }));
    } catch (e) { onError(displayError(e)); } finally { setBusy(false); }
  }} />;
}

type ServerInput = { name: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string; env: string[] };

/** Presentational surface: rendering it never queries or configures a runtime. */
export function ToolsViewContent({ runtimes, loading, busy, adding, login, onRefresh, onRemove, onAdding, onAdd, onLoginCodex, onAuthenticateClaude, onDismissLogin, onError }: {
  runtimes: McpRuntimeTools[] | null;
  loading: boolean;
  busy: boolean;
  adding: 'claude' | 'codex' | null;
  login?: { runtime: ChatRuntime; name: string; start: AccountLoginStart } | null;
  onError?: (text: string) => void;
  onRefresh: () => void;
  onRemove: (runtime: 'claude' | 'codex', name: string) => void;
  onAdding: (runtime: 'claude' | 'codex' | null) => void;
  onAdd: (runtime: 'claude' | 'codex', input: ServerInput) => Promise<void>;
  onLoginCodex?: (name: string) => void;
  onAuthenticateClaude?: (name: string) => void;
  onDismissLogin?: () => void;
}) {
  return <section className="settings-section tools-view">
    <h2>{t('ui.auto.304')}</h2>
    <p className="settings-lead">

      {t('tools.optional')}
    </p>
    <p className="footnote">{t('tools.authorization')}
    </p>
    <button className="subtle" disabled={loading || busy} onClick={onRefresh}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{t('ui.auto.306')}</button>

    {/* A blank wait reads as "no hay nada": name what is still pending. */}
    {loading && Object.entries(RUNTIME_NAME).filter(([key]) => !runtimes?.some(r => r.runtime === key)).map(([key, label]) => <div className="runtime-card pending" key={key}>
      <div className="runtime-head"><strong>{label}</strong><small><LoaderCircle className="spin" size={12} />  {t('ui.auto.408')}</small></div>
    </div>)}
    {loading && <p className="footnote">{t('ui.auto.307')}</p>}

    {runtimes?.map(rt => <div className="runtime-card" key={rt.runtime}>
      <div className="runtime-head">
        <strong>{RUNTIME_NAME[rt.runtime] ?? rt.runtime}</strong>
        <small>{rt.detail}</small>
      </div>
      {rt.installed && rt.servers.length === 0 && <p className="footnote">{t('ui.auto.308')}</p>}
      {rt.servers.length > 0 && <div className="provider-list">
        {rt.servers.map(server => <div className="provider-card mcp-card" key={server.name}>
          <i className={'mcp-dot ' + server.status} title={t(STATUS_LABEL[server.status])} />
          <div>
            <strong>{server.name}</strong>
            <small title={server.target}>{server.transport === 'http' ? 'HTTP' : t('ui.auto.309')} · {server.target || t('ui.auto.310')}</small>
            {server.detail && server.status !== 'connected' && <small className="mcp-detail">{server.detail}</small>}
          </div>
          <span className="tag">{t(STATUS_LABEL[server.status])}</span>
          {rt.runtime === 'codex' && (server.needsAuth || server.status === 'needsAuth') && onLoginCodex && <button className="subtle" disabled={busy} title={t('tools.loginHelp')} onClick={() => onLoginCodex(server.name)}><LogIn size={13} />{t('tools.login')}</button>}
          {rt.runtime === 'claude' && (server.needsAuth || server.status === 'needsAuth' || server.status === 'failed') && onAuthenticateClaude && <button className="subtle" disabled={busy} title={t('tools.authenticateClaudeHelp')} onClick={() => onAuthenticateClaude(server.name)}><LogIn size={13} />{t('tools.authenticateClaude')}</button>}
          {rt.canEdit && <button className="icon-button" aria-label={t('tools.remove', { name: server.name })} title={t('tools.removeHelp')} disabled={busy} onClick={() => onRemove(rt.runtime as 'claude' | 'codex', server.name)}><Trash2 size={14} /></button>}
        </div>)}
      </div>}
      {rt.installed && rt.canEdit && adding !== rt.runtime && <button className="subtle" disabled={busy} onClick={() => onAdding(rt.runtime as 'claude' | 'codex')}><Plus size={13} />{t('ui.auto.311')}</button>}
      {login && login.runtime === rt.runtime && <div className="chat-card login-card" role="group" aria-label={t('tools.login')}>
        <div className="chat-card-title"><Plug size={15} />{login.name}</div>
        <p>{login.start.instructions}</p>
        {login.start.mode === 'browser' && <p><code>{login.start.url}</code></p>}
        {login.start.mode === 'terminal' && <TerminalPane sessionId={login.start.sessionId} onError={onError ?? (() => undefined)} />}
        <div className="chat-card-actions"><button onClick={() => onDismissLogin?.()}>{t('ui.auto.001')}</button></div>
      </div>}
      {adding === rt.runtime && <AddServer runtime={rt.runtime as 'claude' | 'codex'} busy={busy} onCancel={() => onAdding(null)} onAdd={input => onAdd(rt.runtime as 'claude' | 'codex', input)} />}
      {rt.installed && !rt.canEdit && <p className="footnote"><AlertTriangle size={13} />  {t('ui.auto.312')} <code>opencode mcp add</code>  {t('ui.auto.313')}</p>}
    </div>)}

    <p className="footnote">

      {t('ui.auto.314')}
    </p>
  </section>;
}

export function AddServer({ runtime, busy, onCancel, onAdd }: {
  runtime: 'claude' | 'codex';
  busy: boolean;
  onCancel: () => void;
  onAdd: (input: ServerInput) => Promise<void>;
}) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const env = envText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ready = name.trim().length > 0 && (transport === 'http' ? /^https?:\/\//.test(url.trim()) : parts.length > 0);

  return <div className="chat-card mcp-form" role="group" aria-label={t('ui.auto.311')}>
    <div className="chat-card-title"><Plug size={15} />{t('ui.auto.315')} {RUNTIME_NAME[runtime]}</div>
    <label className="field-label" htmlFor={`mcp-name-${runtime}`}>{t('ui.auto.409')}</label>
    <input id={`mcp-name-${runtime}`} value={name} maxLength={64} placeholder={t('tools.namePlaceholder')} onChange={e => setName(e.target.value)} />
    <label className="field-label" htmlFor={`mcp-transport-${runtime}`}>{t('ui.auto.316')}</label>
    <select id={`mcp-transport-${runtime}`} value={transport} onChange={e => setTransport(e.target.value as 'stdio' | 'http')}>
      <option value="stdio">{t('ui.auto.317')}</option>
      <option value="http">{t('ui.auto.318')}</option>
    </select>
    {transport === 'stdio' ? <>
      <label className="field-label" htmlFor={`mcp-command-${runtime}`}>{t('ui.auto.410')}</label>
      <input id={`mcp-command-${runtime}`} value={command} maxLength={400} placeholder={t('tools.commandPlaceholder')} onChange={e => setCommand(e.target.value)} />
      <label className="field-label" htmlFor={`mcp-env-${runtime}`}>{t('ui.auto.319')}</label>
      <textarea id={`mcp-env-${runtime}`} className="context-editor short" value={envText} placeholder={'API_KEY=...'} onChange={e => setEnvText(e.target.value)} />
      <p className="footnote">{t('ui.auto.320')}</p>
    </> : <>
      <label className="field-label" htmlFor={`mcp-url-${runtime}`}>{t('ui.auto.412')}</label>
      <input id={`mcp-url-${runtime}`} value={url} maxLength={500} placeholder={t('tools.urlPlaceholder')} onChange={e => setUrl(e.target.value)} />
      <p className="footnote">{t('ui.auto.321')} <code>{runtime} mcp login {name || t('ui.auto.413')}</code>  {t('ui.auto.322')}</p>
    </>}
    <div className="chat-card-actions">
      <button className="primary" disabled={busy || !ready} onClick={() => void onAdd({ name: name.trim(), transport, command: parts[0] ?? '', args: parts.slice(1), url: url.trim(), env })}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{t('ui.auto.261')}</button>
      <button disabled={busy} onClick={onCancel}><X size={14} />{t('ui.auto.241')}</button>
    </div>
  </div>;
}
