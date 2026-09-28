import { useEffect, useRef, useState } from 'react';
import { Archive, MoreHorizontal } from 'lucide-react';
import { useI18n } from './i18n';

export interface BrandMenuProps {
  brandName: string;
  disabled?: boolean;
  onArchive: () => void;
}

/**
 * The "⋯" next to the brand selector: what you do WITH the brand you are
 * looking at. Archiving lives here because that is where a marketer looks
 * for it — beside the brand's name, not inside one of its views.
 * A plain menu button: Escape or a click outside closes it and focus goes
 * back to the button.
 */
export function BrandMenu({ brandName, disabled, onArchive }: BrandMenuProps) {
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

  return <div className="brand-menu" ref={rootRef}>
    <button
      ref={toggleRef}
      type="button"
      className="brand-menu-toggle"
      aria-label={t('brand.menu', { name: brandName })}
      title={t('brand.menu', { name: brandName })}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(v => !v)}
    ><MoreHorizontal size={16} aria-hidden="true" /></button>
    {open && <div className="brand-menu-list" role="menu" aria-label={t('brand.menu', { name: brandName })}>
      <button ref={firstItemRef} type="button" role="menuitem" onClick={() => { setOpen(false); onArchive(); }}><Archive size={14} aria-hidden="true" />{t('brand.archive')}</button>
    </div>}
  </div>;
}
