import { useState } from 'react';
import { X } from 'lucide-react';
import { translate as t } from './i18n';
import { useModalA11y } from './useModalA11y';

/**
 * A small in-app replacement for `window.prompt`: a single labelled field,
 * with a validation message next to it instead of a silently-ignored empty
 * submit. Same anatomy as every other dialog (`.modal-backdrop` / `.modal` /
 * `.modal-head` / `.modal-body`), so it needs no new CSS.
 *
 * Enter submits (it is a `<form>`); Escape cancels, via `useModalA11y`.
 */
export interface PromptDialogProps {
  titleId: string;
  title: string;
  label: string;
  fieldId: string;
  initialValue?: string;
  placeholder?: string;
  /** Multi-line input (a `<textarea>`) instead of a single-line `<input>`. */
  multiline?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Returns an error message to show next to the field, or null when the value is fine. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog(props: PromptDialogProps) {
  const busy = props.busy ?? false;
  const [value, setValue] = useState(props.initialValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalA11y<HTMLElement>(true, props.onCancel, busy);
  const errorId = `${props.fieldId}-error`;

  const submit = () => {
    const trimmed = value.trim();
    const problem = props.validate ? props.validate(trimmed) : (trimmed ? null : t('dialog.fieldRequired'));
    if (problem) { setError(problem); return; }
    setError(null);
    props.onSubmit(trimmed);
  };

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) props.onCancel(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={props.titleId} className="modal">
      <div className="modal-head">
        <div><h2 id={props.titleId}>{props.title}</h2></div>
        <button className="modal-close" aria-label={t('ui.auto.001')} disabled={busy} onClick={props.onCancel}><X size={20} /></button>
      </div>
      <div className="modal-body">
        <form onSubmit={e => { e.preventDefault(); submit(); }}>
          <label className="field-label" htmlFor={props.fieldId}>{props.label}</label>
          {props.multiline
            ? <textarea id={props.fieldId} autoFocus value={value} placeholder={props.placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={e => { setValue(e.target.value); if (error) setError(null); }} />
            : <input id={props.fieldId} autoFocus value={value} placeholder={props.placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={e => { setValue(e.target.value); if (error) setError(null); }} />}
          {error && <p id={errorId} className="footnote" role="alert">{error}</p>}
          <div className="chat-card-actions">
            <button type="submit" className="primary" disabled={busy}>{props.submitLabel}</button>
            <button type="button" disabled={busy} onClick={props.onCancel}>{props.cancelLabel ?? t('ui.auto.241')}</button>
          </div>
        </form>
      </div>
    </section>
  </div>;
}
