import { useEffect, useState } from 'react';
import { Building2, Download, Globe, LogIn, Plug, Plus, RefreshCw, Trash2, Unplug, X } from 'lucide-react';
import { translate as t, currentLocale, type MessageKey } from './i18n';
import { CoordRow } from './coordination/anatomy';
import { hourOf, minutesSince } from './coordination/time';
import { Loading } from './brand-marks';
import { api } from './browser-api';
import { displayError } from './App';
import type { Brand, ChatRuntime, Connection, ConnectionInput, ConnectionScope, ConnectionState, ImportableConnection } from '../shared/contracts';

/**
 * Conexiones: UNA SOLA PANTALLA, en Ajustes.
 *
 * Antes eran dos —las globales acá, las de la marca adentro de la marca— y eso
 * metía lo técnico en lo cotidiano: el área de una marca terminaba llena de
 * direcciones de servidores MCP, que no es lo que alguien va a buscar ahí. Lo
 * técnico vive en Ajustes; la marca es el día a día.
 *
 * Así que esta lista trae TODAS: las globales primero, después las de cada
 * marca, y cada fila dice de quién es en su única línea ("Global · conectada",
 * "Marca: Maldita Poesía · vencida hace 2 h"). La fila ES la acción: abre el
 * detalle, que es donde están la dirección, la cuenta y los botones.
 *
 * La anatomía es la del equipo (`coordination/anatomy`), no una parecida:
 * ícono y punto de estado a la izquierda, nombre, una línea, la hora en mono a
 * la derecha.
 */

const STATE_LABEL: Record<ConnectionState, MessageKey> = {
  connected: 'connections.state.connected',
  expired: 'connections.state.expired',
  error: 'connections.state.error',
  disconnected: 'connections.state.disconnected',
};

/**
 * El punto. Verde es "anda"; el acento (rust) es lo que te necesita —una
 * vencida o una en error son exactamente eso—; gris es "existe y todavía nadie
 * entró". Nunca el rojo de `failed`: una conexión sin sesión no es un fallo.
 */
const DOT: Record<ConnectionState, 'ok' | 'live' | 'idle'> = {
  connected: 'ok',
  expired: 'live',
  error: 'live',
  disconnected: 'idle',
};

/** El nombre de la marca dueña, o '' cuando la conexión es global. */
function brandNameOf(connection: Connection, brands: Brand[]): string {
  if (connection.scope === 'global') return '';
  return brands.find(brand => brand.id === connection.brandId)?.name ?? '';
}

/** "Global" o "Marca: Maldita Poesía". Lo que la fila dice antes del estado. */
export function scopeLabel(connection: Connection, brands: Brand[]): string {
  if (connection.scope === 'global') return t('connections.scopeGlobalShort');
  return t('connections.scopeBrandShort', { brand: brandNameOf(connection, brands) });
}

/**
 * "hace 2 h". Sólo para lo que NO está conectado: de una conexión que anda, la
 * hora de la derecha ya dice todo lo que hay que saber; de una vencida, lo que
 * importa es cuánto hace que lo está.
 */
export function agoLabel(at: string, now: number): string {
  const minutes = minutesSince(at, now);
  if (minutes === null) return '';
  if (minutes < 60) return t('connections.agoMin', { count: minutes });
  if (minutes < 60 * 48) return t('connections.agoHours', { count: Math.floor(minutes / 60) });
  return t('connections.agoDays', { count: Math.floor(minutes / (60 * 24)) });
}

/** La única línea de la fila: alcance y estado, nunca dos renglones. */
export function connectionLine(connection: Connection, brands: Brand[], now: number): string {
  const state = t(STATE_LABEL[connection.state]);
  const ago = connection.state === 'connected' ? '' : agoLabel(connection.updatedAt, now);
  return t('connections.line', { scope: scopeLabel(connection, brands), detail: ago ? `${state} ${ago}` : state });
}

/** Globales primero; después por marca, y adentro de cada una por nombre. */
export function sortConnections(connections: Connection[], brands: Brand[]): Connection[] {
  return [...connections].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
    const byBrand = brandNameOf(a, brands).localeCompare(brandNameOf(b, brands));
    return byBrand !== 0 ? byBrand : a.label.localeCompare(b.label);
  });
}

/** Lo que el diálogo trae escrito al abrirse: vacío, o lo de una importación. */
export interface AddDraft { url: string; name: string }

export function ConnectionsView({ onNotice, onError }: {
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [importable, setImportable] = useState<ImportableConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AddDraft | null>(null);
  const [needsClientId, setNeedsClientId] = useState(false);

  const load = async () => {
    try {
      const [list, brandList, toImport] = await Promise.all([api.listAllConnections(), api.listBrands(), api.listImportableConnections()]);
      setConnections(list);
      setBrands(brandList);
      setImportable(toImport.filter(entry => !entry.alreadyImported));
    } catch (e) {
      setConnections([]);
      onError(displayError(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      await load();
      onNotice(done);
      setNeedsClientId(false);
      setDraft(null);
    } catch (e) {
      // El único error que cambia la PANTALLA y no sólo el mensaje: este
      // servidor no da de alta clientes solo, así que el diálogo tiene que
      // pedir el id de cliente y quedarse abierto con lo que ya se escribió.
      if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'CONNECTION_CLIENT_ID_REQUIRED') setNeedsClientId(true);
      onError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <ConnectionsContent
      connections={connections}
      brands={brands}
      importable={importable}
      busy={busy}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onAdd={() => { setNeedsClientId(false); setDraft({ url: '', name: '' }); }}
      onReconnect={connection => void run(() => api.reconnectConnection(connection.id), t('connections.connected', { name: connection.label }))}
      onDisconnect={connection => void run(() => api.disconnectConnection(connection.id), t('connections.disconnected', { name: connection.label }))}
      onDelete={connection => {
        if (!window.confirm(t('connections.confirmDelete', { name: connection.label }))) return;
        setSelectedId(null);
        void run(() => api.deleteConnection(connection.id), t('connections.deleted', { name: connection.label }));
      }}
      onImport={entry => { setNeedsClientId(false); setDraft({ url: entry.url, name: entry.name }); }}
      onForget={entry => {
        if (entry.runtime !== 'claude' && entry.runtime !== 'codex') return;
        if (!window.confirm(t('connections.forget', { name: entry.name }))) return;
        void run(() => api.removeMcpServer(entry.runtime as 'claude' | 'codex', entry.name), t('connections.forgotten', { name: entry.name, runtime: RUNTIME_NAME[entry.runtime] ?? entry.runtime }));
      }}
      onRefresh={() => void load()} />
    {draft && <AddConnectionDialog
      brands={brands}
      initial={draft}
      busy={busy}
      needsClientId={needsClientId}
      onCancel={() => { setDraft(null); setNeedsClientId(false); }}
      onConnect={input => void run(() => api.connectConnection(input), t('connections.connected', { name: input.name }))} />}
  </>;
}

export interface ConnectionsContentProps {
  /** TODAS: globales y de marca. `null` mientras se cargan. */
  connections: Connection[] | null;
  brands: Brand[];
  /** Lo que los CLI tienen anotado y todavía no es una Conexión de Latte. */
  importable: ImportableConnection[];
  busy: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onReconnect: (connection: Connection) => void;
  onDisconnect: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
  /** Traerse una del registro de un CLI: abre el mismo diálogo, así el alcance se elige igual. */
  onImport: (entry: ImportableConnection) => void;
  /** Sacarla del registro del CLI. No toca ninguna conexión de Latte. */
  onForget: (entry: ImportableConnection) => void;
  onRefresh: () => void;
  /** Inyectable para que "hace 2 h" se pueda probar sin un reloj de verdad. */
  now?: number;
}

/** Presentational: renderizarla no habla con ningún servidor. */
export function ConnectionsContent(props: ConnectionsContentProps) {
  const { connections, brands, busy } = props;
  const now = props.now ?? Date.now();
  const rows = connections ? sortConnections(connections, brands) : [];
  const selected = rows.find(connection => connection.id === props.selectedId) ?? null;

  return <section className="settings-section connections-view">
    <h2>{t('connections.title')}</h2>
    <p className="settings-lead">{t('connections.lead')}</p>

    <div className="connections-actions">
      <button className="subtle" disabled={busy} onClick={props.onAdd}><Plus size={13} />{t('connections.add')}</button>
      <button className="subtle" disabled={busy} onClick={props.onRefresh}><RefreshCw size={13} />{t('connections.refresh')}</button>
    </div>

    {connections === null && <p className="footnote"><Loading size={16} /> {t('connections.loading')}</p>}
    {connections !== null && rows.length === 0 && <p className="footnote">{t('connections.empty')}</p>}

    {rows.length > 0 && <div className="connections-list">
      {rows.map(connection => <CoordRow
        key={connection.id}
        name={connection.label}
        icon={connection.scope === 'global' ? <Globe size={15} /> : <Building2 size={15} />}
        dot={DOT[connection.state]}
        line={connectionLine(connection, brands, now)}
        urgent={connection.state === 'expired' || connection.state === 'error'}
        at={connection.updatedAt}
        time={hourOf(connection.updatedAt, currentLocale())}
        selected={connection.id === props.selectedId}
        className="connection-row"
        onClick={() => props.onSelect(connection.id === props.selectedId ? null : connection.id)} />)}
    </div>}

    {selected && <ConnectionDetail
      connection={selected}
      scope={scopeLabel(selected, brands)}
      busy={busy}
      onClose={() => props.onSelect(null)}
      onReconnect={() => props.onReconnect(selected)}
      onDisconnect={() => props.onDisconnect(selected)}
      onDelete={() => props.onDelete(selected)} />}

    <CliRegistry importable={props.importable} busy={busy} onImport={props.onImport} onForget={props.onForget} />
  </section>;
}

const RUNTIME_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/**
 * El registro de los CLI: un bloque SECUNDARIO, plegado.
 *
 * Fue una sección entera de Ajustes ("Herramientas (MCP)"), y no lo merecía:
 * es de sólo lectura, casi nadie la abre, y lo único que se hace desde acá es
 * traerse algo a Latte o sacarlo del registro. Cerrado por defecto, al pie de
 * la única pantalla de Conexiones.
 */
function CliRegistry({ importable, busy, onImport, onForget }: {
  importable: ImportableConnection[];
  busy: boolean;
  onImport: (entry: ImportableConnection) => void;
  onForget: (entry: ImportableConnection) => void;
}) {
  const canForget = (runtime: ChatRuntime) => runtime === 'claude' || runtime === 'codex';
  return <details className="connections-cli">
    <summary>{t('connections.importHead')}</summary>
    <p className="footnote">{t('connections.importHelp')}</p>
    {importable.length === 0 && <p className="footnote">{t('connections.cliEmpty')}</p>}
    {importable.length > 0 && <div className="connections-cli-list">
      {importable.map(entry => <div className="connections-cli-row" key={`${entry.runtime}-${entry.name}`}>
        <div>
          <strong>{entry.name}</strong>
          <small title={entry.url}>{entry.url}</small>
        </div>
        <button className="subtle" disabled={busy} onClick={() => onImport(entry)}><Download size={13} />{t('connections.import')}</button>
        {canForget(entry.runtime) && <button className="icon-button" aria-label={t('connections.forget', { name: entry.name })} disabled={busy} onClick={() => onForget(entry)}><Trash2 size={14} /></button>}
      </div>)}
    </div>}
    <p className="footnote">{t('connections.authorization')}</p>
  </details>;
}

/** Lo que la fila no dice porque no cabe: la dirección, la cuenta, y qué hacer. */
function ConnectionDetail({ connection, scope, busy, onClose, onReconnect, onDisconnect, onDelete }: {
  connection: Connection;
  scope: string;
  busy: boolean;
  onClose: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  return <div className="connection-detail" role="group" aria-label={connection.label}>
    <div className="connection-detail-head">
      <strong>{connection.label}</strong>
      <button className="icon-button" aria-label={t('connections.close')} onClick={onClose}><X size={14} /></button>
    </div>
    <dl className="connection-detail-facts">
      <div><dt>{t('connections.urlLabel')}</dt><dd><code>{connection.url}</code></dd></div>
      <div><dt>{t('connections.scopeLabel')}</dt><dd>{scope}</dd></div>
      {connection.identity && <div><dt>{t('connections.accountLabel')}</dt><dd>{connection.identity}</dd></div>}
      <div><dt>{t('connections.stateLabel')}</dt><dd>{t(STATE_LABEL[connection.state])}{connection.stateDetail ? ` · ${connection.stateDetail}` : ''}</dd></div>
    </dl>
    <div className="connection-detail-actions">
      {connection.state !== 'connected' && <button className="primary" disabled={busy} onClick={onReconnect}><RefreshCw size={13} />{t('connections.reenter')}</button>}
      {connection.state === 'connected' && <button disabled={busy} onClick={onDisconnect}><Unplug size={13} />{t('connections.disconnect')}</button>}
      <button className="icon-button" aria-label={t('connections.delete', { name: connection.label })} disabled={busy} onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  </div>;
}

/**
 * Agregar una conexión: un diálogo, como el de sumar un miembro. El alcance se
 * ELIGE acá y no se deduce de dónde estabas parado — por eso las dos opciones
 * están escritas, y "Una marca" trae su selector.
 */
export function AddConnectionDialog({ brands, initial, busy, needsClientId, onCancel, onConnect }: {
  brands: Brand[];
  initial: AddDraft;
  busy: boolean;
  needsClientId: boolean;
  onCancel: () => void;
  onConnect: (input: ConnectionInput) => void;
}) {
  const [url, setUrl] = useState(initial.url);
  const [name, setName] = useState(initial.name);
  const [scope, setScope] = useState<ConnectionScope>('global');
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [clientId, setClientId] = useState('');
  const suggested = suggestedName(url);
  const finalName = (name.trim() || suggested).toLowerCase();
  const ready = /^https?:\/\//.test(url.trim())
    && /^[a-z0-9][a-z0-9-]{0,47}$/.test(finalName)
    && (scope === 'global' || Boolean(brandId));

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="add-connection-title" className="modal">
      <div className="modal-head">
        <div><div className="document-kicker"><Plug size={13} />{t('connections.title')}</div><h2 id="add-connection-title">{t('connections.add')}</h2></div>
        <button className="modal-close" aria-label={t('connections.close')} onClick={onCancel}><X size={20} /></button>
      </div>
      <div className="modal-body connection-form">
        <label className="field-label" htmlFor="connection-url">{t('connections.urlLabel')}</label>
        <input id="connection-url" value={url} maxLength={500} placeholder="https://theagentcy.app/api/mcp" onChange={e => setUrl(e.target.value)} />
        <p className="footnote">{t('connections.urlHelp')}</p>

        <label className="field-label" htmlFor="connection-name">{t('connections.nameLabel')}</label>
        <input id="connection-name" value={name} maxLength={48} placeholder={suggested} onChange={e => setName(e.target.value)} />

        <label className="field-label" htmlFor="connection-scope">{t('connections.scopeLabel')}</label>
        <select id="connection-scope" value={scope} onChange={e => setScope(e.target.value as ConnectionScope)}>
          <option value="global">{t('connections.scope.global')}</option>
          <option value="brand">{t('connections.scope.brand')}</option>
        </select>

        {scope === 'brand' && <>
          <label className="field-label" htmlFor="connection-brand">{t('connections.brandLabel')}</label>
          <select id="connection-brand" value={brandId} onChange={e => setBrandId(e.target.value)}>
            {brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </>}

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
      </div>
    </section>
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
