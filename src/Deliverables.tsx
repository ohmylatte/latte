import { currentLocale, translate as t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, ExternalLink, FolderOpen, Package, RefreshCw } from 'lucide-react';
import type { DeliverableListing } from '../shared/contracts';
import { api, isDesktop } from './browser-api';

// The day is enough to tell two versions of a deliverable apart in one line.
const date = (value: string) => new Date(value).toLocaleDateString(currentLocale(), { dateStyle: 'short' });
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * What the client actually receives: the PDF, the deck, the spreadsheet, the
 * self-contained HTML. They live in `entregables/` inside the work folder,
 * which is where the agent is told to write them.
 *
 * Latte lists them and hands them over — open, show in the folder, copy
 * somewhere else. It does not version them, does not edit them and never
 * converts one format into another. A binary is opaque to a Markdown
 * workspace, and promising otherwise would break on the first real delivery.
 * Opening is always the human's decision, and HTML asks again before opening
 * because it can run scripts.
 */
export function Deliverables({ workId, onListing }: { workId: string; onListing?: (listing: DeliverableListing | null) => void }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DeliverableListing | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  // The listing is reported up through `onListing` so a parent that also needs
  // it (Resultados, to flag the linked documento) reads the SAME readdir instead
  // of issuing a second one. Kept in a ref so the fetch effect never re-runs on
  // a fresh callback identity.
  const onListingRef = useRef(onListing);
  useEffect(() => { onListingRef.current = onListing; });

  // One readdir, so the count is honest even while the panel is closed.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api.listDeliverables(workId)
      .then(result => { if (live) setListing(result); onListingRef.current?.(result); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); onListingRef.current?.(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workId, refresh]);

  useEffect(() => { setOpen(false); setNote(''); }, [workId]);

  if (!isDesktop) return null;
  const files = listing?.files ?? [];

  // The file may have been replaced or removed since the list was read; every
  // action reports what actually happened instead of assuming it worked.
  const act = async (fileName: string, run: () => Promise<void>) => {
    setBusy(fileName);
    setError('');
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };

  return <section className={'folder-contents deliverables' + (open ? ' open' : '')} aria-label={t('ui.auto.108')}>
    <header>
      <button aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronDown size={15} className={open ? 'rotated' : ''} />

        {t('ui.auto.365')} <small>{loading && !listing ? '…' : files.length}</small>
      </button>
      {open && <button className="icon-button" aria-label={t('ui.auto.109')} disabled={loading} onClick={() => { setNote(''); setRefresh(n => n + 1); }}><RefreshCw size={12} /></button>}
    </header>
    {open && <div className="folder-body">
      {error && <p role="alert" className="explorer-warning">{error}</p>}
      {note && <p className="footnote deliverable-note">{note}</p>}
      {files.length === 0 && !loading && !error && <p className="stage-empty">{t('ui.auto.110')} <code>{t('ui.auto.366')}</code>  {t('ui.auto.111')}</p>}

      {files.map(f => <div key={f.fileName} className="folder-row deliverable-row">
        <Package size={14} />
        <span title={f.fileName}>
          <strong>{f.fileName}</strong>
          <small>{f.extension.toUpperCase()} · {size(f.bytes)} · {date(f.modifiedAt)}</small>
        </span>
        <button className="icon-button" aria-label={t('ui.auto.367', { p0: f.fileName })} title={t('ui.auto.112')} disabled={busy === f.fileName} onClick={() => void act(f.fileName, () => api.openDeliverable(workId, f.fileName))}><ExternalLink size={13} /></button>
        <button className="icon-button" aria-label={t('ui.auto.368', { p0: f.fileName })} title={t('ui.auto.113')} disabled={busy === f.fileName} onClick={() => void act(f.fileName, () => api.revealDeliverable(workId, f.fileName))}><FolderOpen size={13} /></button>
        <button className="icon-button" aria-label={t('ui.auto.369', { p0: f.fileName })} title={t('ui.auto.114')} disabled={busy === f.fileName} onClick={() => void act(f.fileName, async () => {
          const target = await api.copyDeliverable(workId, f.fileName);
          setNote(target ? `Copia guardada en ${target}. El original sigue en entregables/.` : '');
        })}><Copy size={13} /></button>
      </div>)}

      {listing?.truncated && <p className="footnote">{t('ui.auto.115')}</p>}
      {files.length > 0 && <p className="footnote">{t('ui.auto.116')}</p>}
    </div>}
  </section>;
}
