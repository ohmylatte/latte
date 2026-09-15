import { translate as t } from './i18n';
import { useEffect, useState } from 'react';
import { FileText, FolderOpen, Plus, RefreshCw, Search } from 'lucide-react';
import type { DocumentState, DocumentStatus, FunnelStage, WorkDocument } from '../shared/contracts';
import { filterDocuments, reviewReasons, STAGES, STAGE_LABEL, STATUS_LABEL } from './document-organizer';
import { Deliverables } from './Deliverables';
import { FolderContents } from './FolderContents';
import { KnowledgeOrigin } from './KnowledgeScope';

interface Untracked { fileName: string; title: string; funnelStages?: FunnelStage[] }

/**
 * The column you navigate from, next to the document instead of on top of it.
 *
 * Everything that used to be a stacked strip lives here: search, filters, the
 * review queue and what the folder holds. The document keeps the full height
 * of the screen, which is the only reason any of this exists.
 */
export function DocumentList({ documents, workId, currentWorkId, workTitles, selectedId, states, failed, checking, onRefresh, onSelect, onCreate, onUseFolder, folder, untracked, onTrack, suggestion, onImported, busy, showWorkDelta }: {
  documents: WorkDocument[];
  workId: string;
  currentWorkId: string;
  workTitles: Record<string, string>;
  selectedId: string | null;
  states: Record<string, DocumentState>;
  failed: string[];
  checking: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onUseFolder: () => void;
  folder: string | null;
  untracked: Untracked[];
  onTrack: (fileName: string) => Promise<void>;
  /** The usual next document, offered once. Help, never a required sequence. */
  suggestion: { label: string; hint: string } | null;
  onImported: (fileNames: string[]) => void;
  busy: boolean;
  showWorkDelta: boolean;
}) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<FunnelStage | 'all' | 'unclassified'>('all');
  const [status, setStatus] = useState<DocumentStatus | 'all'>('all');
  const [onlyReview, setOnlyReview] = useState(false);
  useEffect(() => { setQuery(''); setStage('all'); setStatus('all'); setOnlyReview(false); }, [workId]);

  const needsReview = (d: WorkDocument) => reviewReasons(d, states[d.id]?.baseOutdated ?? false);
  const reviewCount = documents.filter(d => needsReview(d).length).length;
  const filtered = filterDocuments(documents, { query, stage, status });
  const visible = onlyReview ? filtered.filter(d => needsReview(d).length) : filtered;

  return <aside className="doc-list" aria-label={t('ui.auto.117')}>
    <header>
      <h2>{t('ui.auto.350')} <small>{documents.length}</small></h2>
      <button onClick={onCreate} disabled={busy}><Plus size={14} />{t('ui.auto.118')}</button>
    </header>

    <div className="doc-list-filters">
      <label className="doc-list-search"><Search size={14} /><input aria-label={t('ui.auto.370')} placeholder={t('ui.auto.371')} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div>
        <select aria-label={t('ui.auto.119')} value={stage} onChange={e => setStage(e.target.value as typeof stage)}>
          <option value="all">{t('ui.auto.120')}</option>
          {[...STAGES, 'unclassified' as const].map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <select aria-label="Filtrar por estado" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
          <option value="all">{t('ui.auto.121')}</option>
          {Object.entries(STATUS_LABEL).map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
      </div>
      <button className={'doc-list-review' + (onlyReview ? ' on' : '')} aria-pressed={onlyReview} onClick={() => setOnlyReview(v => !v)}>

        {t('ui.auto.122')} <small>{checking && !reviewCount ? '…' : reviewCount}</small>
      </button>
    </div>

    {failed.length > 0 && <div role="alert" className="explorer-warning">No se pudo verificar {failed.length}  {t('ui.auto.123')}<button onClick={onRefresh}>{t('ui.auto.372')}</button></div>}

    <div className="doc-list-rows">
      {visible.map(d => <button key={d.id} data-document-id={d.id} data-origin-work={d.workId} data-current-work={d.workId === currentWorkId ? 'true' : 'false'} disabled={busy} className={'doc-row' + (selectedId === d.id ? ' selected' : '')} onClick={() => onSelect(d.id)} aria-label={t('ui.auto.124') + d.title} aria-current={selectedId === d.id}>
        <FileText size={14} />
        <span>
          <strong>{d.title}</strong>
          <small>{STATUS_LABEL[d.status]} · {d.fileName}</small>
          <KnowledgeOrigin workId={d.workId} currentWorkId={currentWorkId} titles={workTitles} />
          {d.proposedFunnelStages.length > 0 && <em className="proposed">{t('ui.auto.373')} {d.proposedFunnelStages.map(s => STAGE_LABEL[s]).join(' + ')}</em>}
          {needsReview(d).map(reason => <em key={reason}>{reason}</em>)}
          {failed.includes(d.id) && <em>{t('ui.auto.125')}</em>}
        </span>
      </button>)}
      {visible.length === 0 && <p className="stage-empty">{onlyReview ? t('ui.auto.126') : t('ui.auto.127')}</p>}
    </div>

    {showWorkDelta && <FolderContents workId={workId} untracked={untracked} onTrack={onTrack} onImported={onImported} busy={busy} />}

    {showWorkDelta && <Deliverables workId={workId} />}

    {suggestion && <div className="doc-suggestion">
      <span><strong>{suggestion.label}</strong> {suggestion.hint}</span>
      <button onClick={onCreate} disabled={busy}><Plus size={13} />{t('ui.auto.083')}</button>
    </div>}

    <footer className="doc-list-footer">
      {folder
        ? <span title={folder}><FolderOpen size={12} /><code>{folder}</code></span>
        : <><span><FolderOpen size={12} />Dentro de Latte</span><button onClick={onUseFolder} disabled={busy}>{t('ui.auto.128')}</button></>}
      <button className="icon-button" aria-label={t('ui.auto.129')} disabled={checking} onClick={onRefresh}><RefreshCw size={12} /></button>
    </footer>
  </aside>;
}
