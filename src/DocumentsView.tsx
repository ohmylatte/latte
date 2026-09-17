import { currentLocale, translate as t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Check, Download, FileText, History, Layers, Plus, RefreshCw, Save, SlidersHorizontal, X } from 'lucide-react';
import { ApprovalStamp, Loading, VersionRing } from './brand-marks';
import type { DocumentContent, DocumentKind, FunnelStage, Revision, WorkDocument, Work } from '../shared/contracts';
import { api } from './browser-api';
import { STAGE_LABEL } from './document-organizer';
import { DocumentList } from './DocumentList';
import { FunnelView } from './FunnelView';
import { useDocumentStates } from './document-states';
import { DocumentMetadata, hasMetadataDrafts } from './DocumentMetadata';
import { documentDrafts } from './document-drafts';
import { WorkOutcome, hasOutcomeDrafts, isWorkBrief } from './WorkOutcome';
import { KnowledgeOrigin } from './KnowledgeScope';
import { documentOriginTitle } from './brand-knowledge';

const KIND_LABEL: Record<DocumentKind, string> = new Proxy({} as Record<DocumentKind,string>, { get: (_, key: DocumentKind) => t(`kind.${key}` as 'kind.brief') });
const KIND_HINT: Record<DocumentKind, string> = new Proxy({} as Record<DocumentKind,string>, { get: (_, key: DocumentKind) => t(`kindHint.${key}` as 'kindHint.brief') });
const NEW_KINDS: DocumentKind[] = ['strategy', 'calendar', 'research', 'copy', 'note'];
const POLL_MS = 2500;
const date = (value: string) => new Date(value).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' });
const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the editor is holding for one document. Mirrored in documentDrafts so it survives unmounting. */
interface Editing { content: string; fingerprint: string; dirty: boolean }
/** An unresolved clash between the editor and the file on disk. */
interface Conflict { mine: string; disk: string; diskFingerprint: string; revisionId: string }

export interface DocumentsViewProps {
  work: Work | null;
  brandName: string;
  documents: WorkDocument[];
  selectedId: string | null;
  onSelect: (documentId: string) => void;
  onDocumentsChanged: () => Promise<void>;
  onWorkUpdated: (work: Work) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  onCreate: () => void;
  onUseFolder: () => void;
  /** Which workspace tab is showing: the document split, or the funnel. */
  funnel: boolean;
  /** Opening a document from the funnel takes you to the document. */
  onView: (view: 'brief' | 'funnel') => void;
  /** The empty screen needs a way in: create the first brand, or a work for the one there is. */
  hasBrand: boolean;
  onStart: () => void;
  /** Markdown in the folder that Latte is not tracking yet. */
  untracked: { fileName: string; title: string; funnelStages?: FunnelStage[] }[];
  onTrack: (fileName: string) => Promise<void>;
  /** Role currently writing to each file, by file name. */
  editors: Record<string, { roleId: string; roleName: string }>;
  busy: boolean;
  currentWorkId: string | null;
  workTitles: Record<string, string>;
  showWorkDelta: boolean;
}

/**
 * The documents of a work: one tab per tracked Markdown file, an editor that
 * knows which version it started from, and explicit resolution when the file
 * changed underneath. Nothing is ever saved implicitly.
 */
export function DocumentsView(props: DocumentsViewProps) {
  const { work, documents, selectedId } = props;
  const selected = documents.find(d => d.id === selectedId) ?? documents[0] ?? null;
  const [editing, setEditingState] = useState<Editing | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setModeState] = useState<'read' | 'edit'>('read');
  // Every editor change is mirrored outside React, so opening Settings or
  // another view never drops what the human typed.
  const remember = (documentId: string, next: Editing | null, nextMode: 'read' | 'edit') => {
    if (!next || !next.dirty) documentDrafts.clear(documentId);
    else documentDrafts.set(documentId, { ...next, mode: nextMode });
  };
  const setEditing = (next: Editing | null) => { setEditingState(next); if (selected) remember(selected.id, next, mode); };
  const setMode = (next: 'read' | 'edit') => { setModeState(next); if (selected && editing) remember(selected.id, editing, next); };
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [external, setExternal] = useState<string | null>(null);
  const [baseOutdated, setBaseOutdated] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [pickedRevision, setPicked] = useState<Revision | null>(null);
  const [saving, setSaving] = useState(false);
  // Metadata is a per-document detour, not a permanent strip above the text.
  const [organizing, setOrganizing] = useState(false);
  const loadToken = useRef(0);
  const funnel = props.funnel;
  const { states, failed, checking, refresh: refreshStates } = useDocumentStates(work?.id ?? '', documents, Boolean(work));

  const load = async (documentId: string) => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const doc = await api.readDocument(documentId);
      if (token !== loadToken.current) return;
      setEditingState({ content: doc.content, fingerprint: doc.fingerprint, dirty: false });
      documentDrafts.clear(documentId);
      setBaseOutdated(doc.baseOutdated);
      setExternal(null);
      setConflict(null);
    } catch (e) {
      if (token === loadToken.current) props.onError(displayError(e));
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  };

  // Opening a document restores a pending draft instead of re-reading over it.
  useEffect(() => {
    ++loadToken.current; setExternal(null); setConflict(null); setEditingState(null);
    if (!selected) return;
    setShowVersions(false);
    const pending = documentDrafts.get(selected.id);
    if (pending) {
      setEditingState({ content: pending.content, fingerprint: pending.fingerprint, dirty: pending.dirty });
      setModeState(pending.mode);
      const token=loadToken.current;
      void api.documentState(selected.id).then(state => {if(token===loadToken.current)setBaseOutdated(state.baseOutdated);}).catch(e => {if(token===loadToken.current)props.onError(displayError(e));});
      return;
    }
    setModeState('read');
    void load(selected.id);
  }, [selected?.id]);
  useEffect(() => { setOrganizing(false); }, [selected?.id]);
  // Editor text, document metadata and the work's expected output are all unsaved work.
  const reportDirty = (extra: boolean) => props.onDirtyChange(extra || Boolean(editing?.dirty) || hasMetadataDrafts() || hasOutcomeDrafts());
  useEffect(() => { reportDirty(false); }, [editing?.dirty]);

  // Bounded polling instead of a filesystem watcher: one cheap fingerprint read
  // for the open document, only while the window is focused. Survives atomic
  // writes (temp file + rename), which break inode-based watchers.
  useEffect(() => {
    if (!selected || !editing) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.hidden || saving) return;
      try {
        const state = await api.documentState(selected.id);
        if (stopped) return;
        setBaseOutdated(state.baseOutdated);
        if (state.fingerprint === editing.fingerprint) { setExternal(null); return; }
        if (editing.dirty) setExternal(state.fingerprint);
        else await load(selected.id);
      } catch { /* the next tick tries again */ }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [selected?.id, editing?.fingerprint, editing?.dirty, saving]);

  const save = async () => {
    if (!selected || !editing || saving) return;
    setSaving(true);
    try {
      const outcome = await api.saveDocument(selected.id, editing.content, editing.fingerprint);
      if (outcome.status === 'conflict') {
        setConflict({ mine: editing.content, disk: outcome.disk.content, diskFingerprint: outcome.disk.fingerprint, revisionId: outcome.keptRevision.id });
        setExternal(null);
        props.onNotice(t('ui.auto.137'));
        return;
      }
      setEditing({ content: editing.content, fingerprint: outcome.fingerprint, dirty: false });
      documentDrafts.clear(selected.id);
      setExternal(null);
      props.onWorkUpdated(outcome.work);
      await props.onDocumentsChanged();
      props.onNotice(t('ui.auto.138'));
    } catch (e) {
      props.onError(displayError(e));
    } finally {
      setSaving(false);
    }
  };

  const keepMine = async () => {
    if (!selected || !conflict) return;
    setSaving(true);
    try {
      const outcome = await api.saveDocument(selected.id, conflict.mine, conflict.diskFingerprint);
      if (outcome.status === 'saved') {
        setEditing({ content: conflict.mine, fingerprint: outcome.fingerprint, dirty: false });
        setConflict(null);
        props.onWorkUpdated(outcome.work);
        props.onNotice(t('ui.auto.139'));
      } else props.onNotice(t('ui.auto.140'));
    } catch (e) { props.onError(displayError(e)); } finally { setSaving(false); }
  };

  const keepDisk = async () => {
    if (!selected || !conflict) return;
    setSaving(true);
    try {
      // The human's text is archived before it leaves the editor: both variants survive.
      await api.keepDraftAsVersion(selected.id, conflict.mine);
      setEditing({ content: conflict.disk, fingerprint: conflict.diskFingerprint, dirty: false });
      setConflict(null);
      props.onNotice(t('ui.auto.141'));
    } catch (e) { props.onError(displayError(e)); } finally { setSaving(false); }
  };

  const snapshot = async () => {
    if (!selected) return;
    try {
      await api.snapshotDocument(selected.id);
      setRevisions(await api.listDocumentRevisions(selected.id));
      props.onNotice(t('ui.auto.142'));
    } catch (e) { props.onError(displayError(e)); }
  };

  const openVersions = async () => {
    if (!selected) return;
    setPicked(null);
    setShowVersions(true);
    try { setRevisions(await api.listDocumentRevisions(selected.id)); } catch (e) { props.onError(displayError(e)); }
  };

  if (!work) return <div className="empty-state">
    <FileText size={38} />
    <h1>{t('ui.auto.143')}<br />{t('ui.auto.144')}</h1>
    <p>{t('ui.auto.145')}</p>
    <button className="primary" onClick={props.onStart}><Plus size={16} />{props.hasBrand ? t('ui.auto.146') : t('ui.auto.147')}</button>
  </div>;

  const kindLabel = selected ? KIND_LABEL[selected.kind] : '';
  const linked = work?.folder ?? null;
  // Optional help, not a required sequence: the usual next document, offered once.
  const suggestion = !documents.some(d => d.kind === 'strategy')
    ? { label: 'Un paso habitual:', hint: 'una estrategia que decida objetivo, audiencia y elecciones antes de bajar a piezas.' }
    : !documents.some(d => d.kind === 'calendar')
      ? { label: 'Un paso habitual:', hint: 'un calendario derivado de la estrategia, con fecha, canal, mensaje y CTA.' }
      : null;

  // The funnel gap actions, wired to the APIs DocumentsView already holds.
  const onCreateAction = async (stage: FunnelStage, action: 'analyze' | 'propose' | 'experiment') => {
    if (!work) return;
    try {
      const kind = action === 'propose' ? 'strategy' : 'research';
      const title = { analyze: t('funnel.doc.analyze'), propose: t('funnel.doc.proposal'), experiment: t('funnel.doc.experiment') }[action];
      await api.createDocument(work.id, kind, title + ' · ' + STAGE_LABEL[stage]);
      await props.onDocumentsChanged();
      props.onNotice(t('ui.auto.138'));
    } catch (e) { props.onError(displayError(e)); }
  };
  const onAssociate = async (documentId: string, stage: FunnelStage) => {
    const doc = documents.find(d => d.id === documentId);
    if (!doc) return;
    try {
      await api.updateDocument(documentId, { funnelStages: [...doc.funnelStages, stage] });
      await props.onDocumentsChanged();
    } catch (e) { props.onError(displayError(e)); }
  };
  const onToggleOutOfScope = async (stage: FunnelStage) => {
    if (!work) return;
    try {
      // The toggle returns the updated work; App mirrors it through onWorkUpdated.
      props.onWorkUpdated(await api.toggleOutOfScopeStage(work.id, stage));
    } catch (e) { props.onError(displayError(e)); }
  };

  return <div className={'documents' + (funnel ? ' funnel-mode' : '')}>
    {funnel
      ? <FunnelView documents={documents} selectedId={selected?.id ?? null} states={states} checking={checking} onRefresh={refreshStates} onSelect={id => { if (!saving) { props.onSelect(id); props.onView('brief'); } }} busy={props.busy} currentWorkId={props.currentWorkId} workTitles={props.workTitles} outOfScopeStages={work.outOfScopeStages ?? []} onCreateAction={onCreateAction} onAssociate={onAssociate} onToggleOutOfScope={onToggleOutOfScope} />
      : <><DocumentList documents={documents} workId={work.id} currentWorkId={work.id} workTitles={props.workTitles} selectedId={selected?.id ?? null} states={states} failed={failed} checking={checking} onRefresh={refreshStates} onSelect={id => { if (!saving) props.onSelect(id); }} onCreate={props.onCreate} onUseFolder={props.onUseFolder} folder={linked} untracked={props.untracked} onTrack={props.onTrack} busy={props.busy || saving} suggestion={suggestion} showWorkDelta={props.showWorkDelta} onImported={names => { void props.onDocumentsChanged(); props.onNotice(names.length === 1 ? t('ui.auto.374', { p0: names[0] }) : t('ui.auto.375', { p0: names.length })); }} />
    <div className="doc-pane">
    {selected && <div className="document-toolbar">
      <span><FileText size={16} />{selected.title}{selected.status === 'approved' && <span className="approval-badge" role="status"><ApprovalStamp size={34} className="approval-stamp" /><em>{t('approval.byYou')}</em></span>}<small>{kindLabel} · {editing?.dirty ? t('ui.auto.148') : selected.status === 'approved' ? 'Aprobado' : selected.status === 'review' ? t('ui.auto.149') : 'Borrador'}</small><KnowledgeOrigin workId={selected.workId} currentWorkId={props.currentWorkId} titles={props.workTitles} /></span>
      <div className="doc-actions">
        <button className="primary" disabled={!editing?.dirty || saving || props.busy} onClick={() => void save()}>{saving ? <Loading size={16} /> : <Save size={14} />}{t('ui.auto.150')}</button>
        <button disabled={props.busy || saving} onClick={() => setMode(mode === 'edit' ? 'read' : 'edit')}>{mode === 'edit' ? 'Leer' : 'Editar'}</button>
        <button aria-expanded={organizing} onClick={() => setOrganizing(o => !o)} disabled={props.busy}><SlidersHorizontal size={14} />{t('ui.auto.376')}</button>
        <button disabled={props.busy || saving} onClick={() => void snapshot()}><Layers size={14} />{t('ui.auto.151')}</button>
        <button disabled={props.busy} onClick={() => void openVersions()}><History size={14} />{t('ui.auto.377')}</button>
        <button className="icon-button" title={t('ui.auto.152')} disabled={props.busy} onClick={() => void api.exportDocument(selected.id).then(p => p && props.onNotice(t('ui.auto.153'))).catch(e => props.onError(displayError(e)))}><Download size={15} /></button>
      </div>
    </div>}

    {selected && organizing && <DocumentMetadata key={selected.id} document={selected} onChanged={props.onDocumentsChanged} onError={props.onError} onDirtyChange={reportDirty}/>}

    {selected && isWorkBrief(selected) && selected.workId === work.id && <WorkOutcome key={work.id} work={work} busy={props.busy} onUpdated={props.onWorkUpdated} onNotice={props.onNotice} onError={props.onError} onDirtyChange={reportDirty} />}

    {selected && selected.proposedFunnelStages.length > 0 && <div className="doc-banner proposal" role="status">
      <SlidersHorizontal size={14} />
      <span>{t('ui.auto.154')} <strong>{selected.proposedFunnelStages.map(s => STAGE_LABEL[s]).join(' + ')}</strong>.</span>
      <button className="primary" disabled={props.busy} onClick={() => void api.applyFunnelProposal(selected.id).then(props.onDocumentsChanged).then(() => props.onNotice('Etapas aplicadas.')).catch(e => props.onError(displayError(e)))}>{t('ui.auto.378')}</button>
      <button disabled={props.busy} onClick={() => void api.dismissFunnelProposal(selected.id).then(props.onDocumentsChanged).catch(e => props.onError(displayError(e)))}>{t('ui.auto.379')}</button>
    </div>}

    {conflict && <div className="doc-conflict" role="alert">
      <div className="doc-conflict-head"><AlertTriangle size={16} />{t('ui.auto.155')}</div>
      <p>{t('ui.auto.156')}</p>
      <div className="revision-comparison">
        <div><h4>{t('ui.auto.157')}</h4><pre>{conflict.mine}</pre></div>
        <div><h4>{t('ui.auto.158')}</h4><pre>{conflict.disk}</pre></div>
      </div>
      <div className="chat-card-actions">
        <button className="primary" disabled={saving} onClick={() => void keepMine()}>{t('ui.auto.159')}</button>
        <button disabled={saving} onClick={() => void keepDisk()}>{t('ui.auto.160')}</button>
      </div>
    </div>}

    {selected && selected.workId === work.id && props.editors[selected.fileName] && <div className="doc-banner editing" role="status" data-role={props.editors[selected.fileName].roleId}>
      <i className="doc-editing" data-role={props.editors[selected.fileName].roleId} />
      <span><strong>{props.editors[selected.fileName].roleName}</strong>  {t('ui.auto.161')}</span>
    </div>}

    {!conflict && external && <div className="doc-banner" role="status">
      <RefreshCw size={14} /><span>{t('ui.auto.162')}</span>
      <button onClick={() => void load(selected!.id)}>{t('ui.auto.163')}</button>
      <button onClick={() => setExternal(null)}>Seguir editando</button>
    </div>}

    {baseOutdated && selected?.baseDocumentId && <div className="doc-banner base" role="status">
      <AlertTriangle size={14} /><span>{t('ui.auto.164')}</span>
      <button onClick={() => props.onSelect(selected.baseDocumentId!)}>{t('ui.auto.165')}</button>
      <button onClick={() => void api.acknowledgeBase(selected.id).then(async () => { setBaseOutdated(false); await props.onDocumentsChanged(); props.onNotice(t('ui.auto.166')); }).catch(e => props.onError(displayError(e)))}>{t('ui.auto.167')}</button>
    </div>}

    <div className="document-scroll">
      <div className="document-kicker" data-origin-work={selected?.workId ?? work.id}>{props.brandName} / {documentOriginTitle(selected?.workId, work.title, props.workTitles)}{selected ? ` / ${kindLabel}` : ''}</div>
      {loading && !editing && <p className="footnote"><Loading size={16} />  {t('ui.auto.168')}</p>}
      {editing && mode === 'edit' && <textarea className="markdown-editor" aria-label={t('ui.auto.169')} value={editing.content} spellCheck={false} onChange={e => setEditing({ ...editing, content: e.target.value, dirty: true })} />}
      {editing && mode === 'read' && <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{editing.content || t('ui.auto.170')}</ReactMarkdown></article>}
    </div>

    </div></>}

    {showVersions && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowVersions(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="versions-title" className="modal wide">
        <div className="modal-head">
          <div>
            <div className="document-kicker">{kindLabel}</div>
            <h2 id="versions-title">{t('ui.auto.171')}</h2>
          </div>
          <button className="modal-close" aria-label={t('ui.auto.001')} onClick={() => setShowVersions(false)}><X size={20} /></button>
        </div>
        <div className="modal-body">
        <p className="intro">{t('ui.auto.172')}</p>
        <div className="revision-layout">
          <div className="revision-list">
            {revisions.map((r, i) => <button key={r.id} className={pickedRevision?.id === r.id ? 'selected-revision' : ''} onClick={() => setPicked(r)}>
              <VersionRing filled={i === 0} drawing={i === 0} /><span><span className="revision-version">v{revisions.length - i} · {r.source === 'external' ? 'cambio externo' : r.source === 'latte' ? 'referencia' : t('ui.auto.174')}</span><small>{date(r.createdAt)}</small></span>
            </button>)}
            {!revisions.length && <p>{t('ui.auto.175')}</p>}
          </div>
          {pickedRevision && <div className="revision-comparison">
            <div><h4>{t('ui.auto.176')}</h4><pre>{pickedRevision.content}</pre></div>
            <div><h4>TEXTO ACTUAL</h4><pre>{editing?.content ?? ''}</pre></div>
          </div>}
        </div>
        </div>
      </section>
    </div>}
  </div>;
}

/** Kind picker for a new document, with the option to derive it from an existing one. */
export function NewDocumentDialog({ documents, busy, onCancel, onCreate }: {
  documents: WorkDocument[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (kind: DocumentKind, title: string, baseDocumentId: string | null) => Promise<void>;
}) {
  const [kind, setKind] = useState<DocumentKind>('strategy');
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const suggestion = KIND_LABEL[kind];
  const canDerive = documents.filter(d => d.kind !== kind || d.id !== base);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="new-doc-title" className="modal roomy">
      <div className="modal-head">
        <div>
          <div className="document-kicker">{t('ui.auto.177')}</div>
          <h2 id="new-doc-title">{t('ui.auto.178')}</h2>
        </div>
        <button className="modal-close" aria-label={t('ui.auto.001')} onClick={onCancel}><X size={20} /></button>
      </div>
      <div className="modal-body">
      <p className="intro">{t('ui.auto.179')}</p>
      <div className="kind-list" role="radiogroup" aria-label={t('ui.auto.180')}>
        {NEW_KINDS.map(k => <button key={k} role="radio" aria-checked={kind === k} className={'kind-card' + (kind === k ? ' selected' : '')} onClick={() => setKind(k)}>
          <span><strong>{KIND_LABEL[k]}</strong><small>{KIND_HINT[k]}</small></span>{kind === k && <Check size={14} />}
        </button>)}
      </div>
      <label className="field-label" htmlFor="doc-title">{t('ui.auto.181')}</label>
      <input id="doc-title" maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder={`Ej. ${suggestion} de lanzamiento`} />
      {canDerive.length > 0 && <>
        <label className="field-label" htmlFor="doc-base">{t('ui.auto.182')}</label>
        <select id="doc-base" value={base} onChange={e => setBase(e.target.value)}>
          <option value="">No, empieza solo</option>
          {documents.map(d => <option key={d.id} value={d.id}>{KIND_LABEL[d.kind]} · {d.title}</option>)}
        </select>
        <p className="footnote">{t('ui.auto.183')}</p>
      </>}
      <button className="primary" disabled={busy || !title.trim()} onClick={() => void onCreate(kind, title.trim(), base || null)}><Plus size={15} />{t('ui.auto.184')}</button>
      </div>
    </section>
  </div>;
}
