import { translate as t } from './i18n';
import { useEffect, useState } from 'react';
import { ChevronDown, File, FilePlus, FilePlus2, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FolderEntries, FunnelStage } from '../shared/contracts';
import { api, isDesktop } from './browser-api';
import { STAGE_LABEL } from './document-organizer';

interface Untracked { fileName: string; title: string; funnelStages?: FunnelStage[] }

/**
 * What is in the work folder that is not a tracked document.
 *
 * An agent opened here reads the whole tree; without this panel the person is
 * asked to trust a folder they cannot inspect. So it lists the same material:
 * the Markdown Latte can still adopt, the client's own files, and the
 * subfolders. Only the Markdown has an action — the rest is there to be seen,
 * because Latte tracks Markdown at the top level and says so instead of
 * pretending the rest is not there.
 */
export function FolderContents({ workId, untracked, onTrack, onImported, busy }: {
  workId: string;
  untracked: Untracked[];
  onTrack: (fileName: string) => Promise<void>;
  onImported: (fileNames: string[]) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<FolderEntries | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);

  // One readdir, so the count is honest even while the panel is closed.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api.listFolderEntries(workId)
      .then(result => { if (live) setEntries(result); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workId, refresh, untracked.length]);

  const others = entries?.otherFiles ?? [];
  const folders = entries?.subfolders ?? [];
  const total = others.length + folders.length + untracked.length;
  if (!isDesktop) return null;

  return <section className={'folder-contents' + (open ? ' open' : '')} aria-label={t('ui.auto.185')}>
    <header>
      <button aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronDown size={15} className={open ? 'rotated' : ''} />

        {t('ui.auto.186')} <small>{loading && !entries ? '…' : total}</small>
      </button>
      <button className="icon-button" aria-label={t('ui.auto.187')} title={t('ui.auto.188')} disabled={busy} onClick={() => void api.importFiles(workId).then(landed => { if (landed.length) { setRefresh(n => n + 1); onImported(landed); } }).catch(e => setError(e instanceof Error ? e.message : String(e)))}><FilePlus2 size={13} /></button>
      <button className="icon-button" aria-label={t('ui.auto.189')} title={t('ui.auto.190')} onClick={() => void api.revealWorkFolder(workId).catch(e => setError(e instanceof Error ? e.message : String(e)))}><FolderOpen size={13} /></button>
      {open && <button className="icon-button" aria-label={t('ui.auto.191')} disabled={loading} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={12} /></button>}
    </header>
    {open && <div className="folder-body">
      {error && <p role="alert" className="explorer-warning">{t('ui.auto.192')} {error}</p>}
      {!error && total === 0 && !loading && <p className="stage-empty">{t('ui.auto.193')}</p>}

      {untracked.length > 0 && <div className="folder-group">
        <h4>Markdown que Latte puede seguir <small>{untracked.length}</small></h4>
        {untracked.map(f => <div key={f.fileName} className="folder-row">
          <FilePlus size={14} />
          <span>{f.fileName}{f.funnelStages?.length ? <em>{f.funnelStages.map(s => t(STAGE_LABEL[s])).join(' + ')}</em> : null}</span>
          <button disabled={busy} onClick={() => void onTrack(f.fileName)}>{t('ui.auto.357')}</button>
        </div>)}
      </div>}

      {others.length > 0 && <div className="folder-group">
        <h4>Archivos del cliente <small>{others.length}</small></h4>
        {others.map(name => <div key={name} className="folder-row"><File size={14} /><span>{name}</span></div>)}
      </div>}

      {folders.length > 0 && <div className="folder-group">
        <h4>Subcarpetas <small>{folders.length}</small></h4>
        {folders.map(name => <div key={name} className="folder-row"><Folder size={14} /><span>{name}/</span></div>)}
      </div>}

      {entries?.truncated && <p className="footnote">{t('ui.auto.194')}</p>}
      <p className="footnote">{t('ui.auto.195')}</p>
      {total > 0 && <p className="footnote">{t('ui.auto.196')}</p>}
    </div>}
  </section>;
}
