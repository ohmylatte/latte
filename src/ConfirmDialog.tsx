import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { translate as t } from './i18n';
import { useModalA11y } from './useModalA11y';

/**
 * A small in-app confirmation dialog, for the destructive actions that used
 * to fire straight from `window.confirm`. Same anatomy as every other
 * `role="dialog"` in the app (`.modal-backdrop` / `.modal` / `.modal-head` /
 * `.modal-body`), so it needs no new CSS, and the same `useModalA11y` hook
 * every other dialog uses: focus trap, Escape closes (unless `busy`), focus
 * returns to the opener.
 */

/** Una fila de lo que hay que revisar: su ícono y su texto, uno por renglón. */
export interface ConfirmDialogItem {
  icon?: ReactNode;
  text: string;
}

export interface ConfirmDialogProps {
  /** Id the `<h2>` gets, referenced by the dialog's `aria-labelledby`. */
  titleId: string;
  title: string;
  /** The consequence, in plain language — what happens and whether it can be undone. */
  body: string;
  /** Lo que hay que revisar, fila por fila. Una lista, nunca una frase corrida. */
  items?: readonly ConfirmDialogItem[];
  /** Labels the destructive/confirming button with the action itself, never a generic "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button with the existing `.danger` button class. */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const busy = props.busy ?? false;
  const dialogRef = useModalA11y<HTMLElement>(true, props.onCancel, busy);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) props.onCancel(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={props.titleId} className="modal">
      <div className="modal-head">
        <div><h2 id={props.titleId}>{props.title}</h2></div>
        <button className="modal-close" aria-label={t('ui.auto.001')} disabled={busy} onClick={props.onCancel}><X size={20} /></button>
      </div>
      <div className="modal-body">
        <p className="intro">{props.body}</p>
        {props.items && props.items.length > 0 && <ul className="confirm-items">
          {props.items.map((item, index) => <li key={index}>{item.icon}<span>{item.text}</span></li>)}
        </ul>}
        <div className="chat-card-actions">
          <button className={props.destructive ? 'danger' : 'primary'} disabled={busy} onClick={props.onConfirm}>{props.confirmLabel}</button>
          <button disabled={busy} onClick={props.onCancel}>{props.cancelLabel ?? t('ui.auto.241')}</button>
        </div>
      </div>
    </section>
  </div>;
}
