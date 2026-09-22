import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CircleSlash, Download, LogIn, Plug, Plus, RefreshCw, Trash2, Unplug, X } from 'lucide-react';
import { translate as t, type MessageKey } from './i18n';
import { Loading } from './brand-marks';
import { api } from './browser-api';
import { displayError } from './App';
import type { Connection, ConnectionScope, ConnectionState, ImportableConnection } from '../shared/contracts';

/**
 * Conexiones MCP: las cuentas que Latte tiene con un servidor externo.
 *
 * Dos pantallas, porque hay dos alcances (brief
 * `docs/briefs/2026-09-23-conexiones-mcp-arquitectura.md`, 4.3):
 *
 * - **Ajustes → Conexiones** (`brandId = null`) lista las globales y es donde
 *   se agregan. Una global vale para TODAS las marcas, y el formulario lo dice
 *   con todas las letras: es el riesgo 3 del documento, y la única defensa
 *   contra él es que se lea antes de apretar.
 * - **Marca → Conexiones** (`brandId` presente) lista las de esa marca y
 *   muestra las globales **heredadas**, en gris y sin botón de quitar, con la
 *   salida "usar una cuenta propia para esta marca" — que crea una de marca y
 *   pasa a ganar sobre la global sin tocar a las demás.
 *
 * La fila tiene la anatomía del equipo: ícono, nombre, UNA línea y la hora.
 */

const STATE_LABEL: Record<ConnectionState, MessageKey> = {
  connected: 'connections.state.connected',
  expired: 'connections.state.expired',
  error: 'connections.state.error',
  disconnected: 'connections.state.disconnected',
};

function StateIcon({ state }: { state: ConnectionState }) {
  if (state === 'connected') return <CircleCheck size={15} />;
  if (state === 'expired') return <CircleAlert size={15} />;
  if (state === 'error') return <CircleAlert size={15} />;
  return <CircleSlash size={15} />;
}

export function ConnectionsView({ brandId, brandName, onNotice, onError }: {
  /** `null` = la pantalla de Ajustes: sólo globales, y es donde se agregan. */
  brandId: string | null;
  brandName?: string;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [importable, setImportable] = useState<ImportableConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [needsClientId, setNeedsClientId] = useState(false);

  const load = async () => {
    try {
      const [list, toImport] = await Promise.all([api.listConnections(brandId), api.listImportableConnections()]);
      setConnections(list);
      setImportable(toImport.filter(entry => !entry.alreadyImported));
    } catch (e) {
      setConnections([]);
      onError(displayError(e));
    }
  };
  useEffect(() => { void load(); }, [brandId]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      await load();
      onNotice(done);
      setNeedsClientId(false);
    } catch (e) {
      // El único error que cambia la PANTALLA y no sólo el mensaje: este
      // servidor no da de alta clientes solo, así que el formulario tiene que
      // pedir el id de cliente y quedarse abierto con lo que ya se escribió.
      if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'CONNECTION_CLIENT_ID_REQUIRED') setNeedsClientId(true);
      onError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  return <ConnectionsContent
    brandId={brandId}
    brandName={brandName}
    connections={connections}
    importable={importable}
    busy={busy}
    adding={adding}
    needsClientId={needsClientId}
    onAdding={next => { setAdding(next); if (!next) setNeedsClientId(false); }}
    onConnect={input => run(() => api.connectConnection(input), t('connections.connected', { name: input.name }))}
    onReconnect={connection => run(() => api.reconnectConnection(connection.id), t('connections.connected', { name: connection.label }))}
    onDisconnect={connection => run(() => api.disconnectConnection(connection.id), t('connections.disconnected', { name: connection.label }))}
    onDelete={connection => {
      if (!window.confirm(t('connections.confirmDelete', { name: connection.label }))) return;
      void run(() => api.deleteConnection(connection.id), t('connections.deleted', { name: connection.label }));
    }}
    onImport={entry => run(
      () => api.connectConnection({ name: entry.name, url: entry.url, scope: brandId ? 'brand' : entry.suggestedScope, brandId }),
      t('connections.connected', { name: entry.name }),
    )}
    onRefresh={() => void load()}
  />;
}

export interface ConnectionsContentProps {
  brandId: string | null;
  brandName?: string;
  connections: Connection[] | null;
  importable: ImportableConnection[];
  busy: boolean;
  adding: boolean;
  needsClientId: boolean;
  onAdding: (adding: boolean) => void;
  onConnect: (input: { name: string; url: string; scope: ConnectionScope; brandId: string | null; clientId: string | null }) => void;
  onReconnect: (connection: Connection) => void;
  onDisconnect: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
  onImport: (entry: ImportableConnection) => void;
  onRefresh: () => void;
}

/** Presentational: renderizarla no habla con ningún servidor. */
export function ConnectionsContent(props: ConnectionsContentProps) {
  const { brandId, connections, importable, busy } = props;
  const own = connections?.filter(connection => !connection.inherited) ?? [];
  const inherited = connections?.filter(connection => connection.inherited) ?? [];

  return <section className="settings-section connections-view">
    <h2>{t('connections.title')}</h2>
    <p className="settings-lead">{brandId ? t('connections.leadBrand', { brand: props.brandName ?? '' }) : t('connections.leadGlobal')}</p>

    {connections === null && <p className="footnote"><Loading size={16} /> {t('connections.loading')}</p>}

    {connections !== null && own.length === 0 && <p className="footnote">{brandId ? t('connections.emptyBrand') : t('connections.emptyGlobal')}</p>}

    {own.length > 0 && <div className="provider-list">
      {own.map(connection => <ConnectionRow key={connection.id} connection={connection} busy={busy}
        onReconnect={() => props.onReconnect(connection)}
        onDisconnect={() => props.onDisconnect(connection)}
        onDelete={() => props.onDelete(connection)} />)}
    </div>}

    {/* Las globales vistas desde una marca: se usan, no se tocan desde acá. */}
    {brandId && inherited.length > 0 && <>
      <h3 className="connections-subhead">{t('connections.inheritedHead')}</h3>
      <p className="footnote">{t('connections.inheritedHelp')}</p>
      <div className="provider-list">
        {inherited.map(connection => <div className="provider-card connection-card inherited" key={connection.id}>
          <i className={'connection-dot ' + connection.state} aria-hidden="true"><StateIcon state={connection.state} /></i>
          <div>
            <strong>{connection.label}</strong>
            <small>{t('connections.inheritedLine', { url: connection.url })}</small>
          </div>
          <span className="tag">{t('connections.scope.global')}</span>
          <button className="subtle" disabled={busy} onClick={() => props.onAdding(true)}>{t('connections.ownAccount')}</button>
        </div>)}
      </div>
    </>}

    {/* Importación única del registro del CLI (decisión C). */}
    {importable.length > 0 && <>
      <h3 className="connections-subhead">{t('connections.importHead')}</h3>
      <p className="footnote">{t('connections.importHelp')}</p>
      <div className="provider-list">
        {importable.map(entry => <div className="provider-card connection-card" key={`${entry.runtime}-${entry.name}`}>
          <i className="connection-dot disconnected" aria-hidden="true"><Download size={15} /></i>
          <div>
            <strong>{entry.name}</strong>
            <small>{entry.url}</small>
          </div>
          <button className="subtle" disabled={busy} onClick={() => props.onImport(entry)}><Download size={13} />{t('connections.import')}</button>
        </div>)}
      </div>
    </>}

    <div className="connections-actions">
      {!props.adding && <button className="subtle" disabled={busy} onClick={() => props.onAdding(true)}><Plus size={13} />{t('connections.add')}</button>}
      <button className="subtle" disabled={busy} onClick={props.onRefresh}><RefreshCw size={13} />{t('connections.refresh')}</button>
    </div>

    {props.adding && <AddConnection
      brandId={brandId}
      busy={busy}
      needsClientId={props.needsClientId}
      onCancel={() => props.onAdding(false)}
      onConnect={props.onConnect} />}
  </section>;
}

function ConnectionRow({ connection, busy, onReconnect, onDisconnect, onDelete }: {
  connection: Connection;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  // UNA línea, la del equipo: qué es, de quién, y qué pasó. El detalle del
  // error va en esa misma línea y no en una segunda: una fila que crece cuando
  // algo falla hace que la lista se mueva justo cuando hay que leerla.
  const line = connection.state === 'connected'
    ? t('connections.lineConnected', { url: connection.url, identity: connection.identity ?? '' })
    : connection.stateDetail || connection.url;
  return <div className={'provider-card connection-card ' + connection.state}>
    <i className={'connection-dot ' + connection.state} aria-hidden="true"><StateIcon state={connection.state} /></i>
    <div>
      <strong>{connection.label}</strong>
      <small title={connection.url}>{line}</small>
    </div>
    <span className="tag">{t(STATE_LABEL[connection.state])}</span>
    <small className="connection-when">{new Date(connection.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</small>
    {connection.state !== 'connected' && <button className="subtle" disabled={busy} onClick={onReconnect}><LogIn size={13} />{t('connections.reenter')}</button>}
    {connection.state === 'connected' && <button className="subtle" disabled={busy} onClick={onDisconnect}><Unplug size={13} />{t('connections.disconnect')}</button>}
    <button className="icon-button" aria-label={t('connections.delete', { name: connection.label })} disabled={busy} onClick={onDelete}><Trash2 size={14} /></button>
  </div>;
}

export function AddConnection({ brandId, busy, needsClientId, onCancel, onConnect }: {
  brandId: string | null;
  busy: boolean;
  needsClientId: boolean;
  onCancel: () => void;
  onConnect: ConnectionsContentProps['onConnect'];
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // Desde una marca el alcance arranca en `brand`, que es lo que la persona
  // fue a buscar; desde Ajustes arranca en `global`, porque ésa es la pantalla
  // de las globales. En los dos casos se puede cambiar (decisión A).
  const [scope, setScope] = useState<ConnectionScope>(brandId ? 'brand' : 'global');
  const [clientId, setClientId] = useState('');
  const suggested = suggestedName(url);
  const finalName = (name.trim() || suggested).toLowerCase();
  const ready = /^https?:\/\//.test(url.trim()) && /^[a-z0-9][a-z0-9-]{0,47}$/.test(finalName);

  return <div className="chat-card connection-form" role="group" aria-label={t('connections.add')}>
    <div className="chat-card-title"><Plug size={15} />{t('connections.add')}</div>

    <label className="field-label" htmlFor="connection-url">{t('connections.urlLabel')}</label>
    <input id="connection-url" value={url} maxLength={500} placeholder="https://theagentcy.app/api/mcp" onChange={e => setUrl(e.target.value)} />
    <p className="footnote">{t('connections.urlHelp')}</p>

    <label className="field-label" htmlFor="connection-name">{t('connections.nameLabel')}</label>
    <input id="connection-name" value={name} maxLength={48} placeholder={suggested} onChange={e => setName(e.target.value)} />

    <label className="field-label" htmlFor="connection-scope">{t('connections.scopeLabel')}</label>
    <select id="connection-scope" value={scope} onChange={e => setScope(e.target.value as ConnectionScope)} disabled={!brandId}>
      <option value="global">{t('connections.scope.global')}</option>
      {brandId && <option value="brand">{t('connections.scope.brand')}</option>}
    </select>
    {/* Riesgo 3 del documento: una global mal elegida toca a todas las marcas,
        así que la pantalla lo dice con todas las letras ANTES de conectar. */}
    <p className={'footnote ' + (scope === 'global' ? 'warn' : '')}>{scope === 'global' ? t('connections.scopeGlobalWarning') : t('connections.scopeBrandHelp')}</p>

    {needsClientId && <>
      <label className="field-label" htmlFor="connection-client-id">{t('connections.clientIdLabel')}</label>
      <input id="connection-client-id" value={clientId} maxLength={200} onChange={e => setClientId(e.target.value)} />
      <p className="footnote">{t('connections.clientIdHelp')}</p>
    </>}

    <div className="chat-card-actions">
      <button className="primary" disabled={busy || !ready}
        onClick={() => onConnect({ name: finalName, url: url.trim(), scope, brandId: scope === 'brand' ? brandId : null, clientId: clientId.trim() || null })}>
        {busy ? <Loading size={16} /> : <LogIn size={14} />}{t('connections.connect')}
      </button>
      <button disabled={busy} onClick={onCancel}><X size={14} />{t('ui.auto.241')}</button>
    </div>
  </div>;
}

/** El slug que Latte propone: el dominio, sin el TLD. Nadie tiene por qué inventar un nombre. */
export function suggestedName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const base = host.split('.').slice(0, -1).join('-') || host;
    return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'conexion';
  } catch {
    return '';
  }
}
