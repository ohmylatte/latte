import { translate as t, type MessageKey } from './i18n';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { Loading } from './brand-marks';
import type { ChatRuntime, McpRuntimeTools, McpServer } from '../shared/contracts';
import { api } from './browser-api';

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
 * El registro MCP de cada CLI, **de sólo lectura**.
 *
 * Esta pantalla dejó de poder agregar servidores y de poder autenticarlos
 * (decisiones C y D del brief `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`).
 * El motivo no es de gusto: el único camino que podía terminar un OAuth desde
 * acá era una terminal embebida donde la persona escribía `/mcp` a mano, el
 * token quedaba en el perfil de un CLI —indexado por nombre, no por URL, y por
 * eso se perdía en silencio al renombrar— y no había forma de tener una cuenta
 * distinta por marca. Eso ahora lo hacen las **Conexiones**, que son de Latte.
 *
 * Lo que queda acá es lo que sigue siendo verdad: qué tiene configurado cada
 * CLI, y poder quitarlo cuando ya se importó.
 */
export function ToolsView({ onNotice, onError }: { onNotice: (text: string) => void; onError: (text: string) => void; workId?: string | null }) {
  const [runtimes, setRuntimes] = useState<McpRuntimeTools[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return <ToolsViewContent runtimes={runtimes} loading={loading} busy={busy} onRefresh={() => void load()} onRemove={remove} />;
}

/** Presentational surface: rendering it never queries or configures a runtime. */
export function ToolsViewContent({ runtimes, loading, busy, onRefresh, onRemove }: {
  runtimes: McpRuntimeTools[] | null;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onRemove: (runtime: 'claude' | 'codex', name: string) => void;
}) {
  return <section className="settings-section tools-view">
    <h2>{t('ui.auto.304')}</h2>
    <p className="settings-lead">
      {t('tools.readOnlyLead')}
    </p>
    <p className="footnote">{t('tools.authorization')}
    </p>
    <button className="subtle" disabled={loading || busy} onClick={onRefresh}>{loading ? <Loading size={16} /> : <RefreshCw size={13} />}{t('ui.auto.306')}</button>

    {/* A blank wait reads as "no hay nada": name what is still pending. */}
    {loading && Object.entries(RUNTIME_NAME).filter(([key]) => !runtimes?.some(r => r.runtime === key)).map(([key, label]) => <div className="runtime-card pending" key={key}>
      <div className="runtime-head"><strong>{label}</strong><small><Loading size={16} />  {t('ui.auto.408')}</small></div>
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
          {rt.canEdit && <button className="icon-button" aria-label={t('tools.remove', { name: server.name })} title={t('tools.removeHelp')} disabled={busy} onClick={() => onRemove(rt.runtime as 'claude' | 'codex', server.name)}><Trash2 size={14} /></button>}
        </div>)}
      </div>}
      {rt.installed && !rt.canEdit && <p className="footnote"><AlertTriangle size={13} />  {t('ui.auto.312')} <code>opencode mcp add</code>  {t('ui.auto.313')}</p>}
    </div>)}

    <p className="footnote">{t('tools.movedToConnections')}</p>
  </section>;
}
