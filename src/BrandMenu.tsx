import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, MoreHorizontal, Plus } from 'lucide-react';
import { useI18n } from './i18n';

export interface BrandMenuProps {
  /** La marca que se está mirando. `null`: todavía no hay ninguna. */
  brandName: string | null;
  disabled?: boolean;
  archivedCount: number;
  onNewBrand: () => void;
  onShowArchived: () => void;
  onArchive: () => void;
}

/**
 * The "⋯" next to the brand selector: what you do WITH the brand you are
 * looking at. Archiving lives here because that is where a marketer looks
 * for it — beside the brand's name, not inside one of its views.
 * A plain menu button: Escape or a click outside closes it and focus goes
 * back to the button.
 *
 * 2.0: "Agregar marca" y "Marcas archivadas" viven acá también. Eran dos
 * renglones sueltos entre el selector y Inicio que se veían amontonados y
 * cortados en 1024; en el menú dejan al selector con todo el ancho, como el
 * cambio de espacio de Slack o Notion.
 */
export function BrandMenu({ brandName, disabled, archivedCount, onNewBrand, onShowArchived, onArchive }: BrandMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const onPointer = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); toggleRef.current?.focus(); } };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const label = brandName ? t('brand.menu', { name: brandName }) : t('brand.menuNone');
  const pick = (action: () => void) => () => { setOpen(false); action(); };

  return <div className="brand-menu" ref={rootRef}>
    <button
      ref={toggleRef}
      type="button"
      className="brand-menu-toggle"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(v => !v)}
    ><MoreHorizontal size={16} aria-hidden="true" /></button>
    {open && <div className="brand-menu-list" role="menu" aria-label={label}>
      <button ref={firstItemRef} type="button" role="menuitem" onClick={pick(onNewBrand)}><Plus size={14} aria-hidden="true" />{t('brand.new')}</button>
      <button type="button" role="menuitem" onClick={pick(onShowArchived)}><ArchiveRestore size={14} aria-hidden="true" />{t('brand.archivedToggle')}{archivedCount > 0 && <span className="brand-menu-count">{archivedCount}</span>}</button>
      {brandName && <>
        <div className="brand-menu-sep" role="separator" />
        <button type="button" role="menuitem" onClick={pick(onArchive)}><Archive size={14} aria-hidden="true" />{t('brand.archive')}</button>
      </>}
    </div>}
  </div>;
}
