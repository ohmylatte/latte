import { useEffect, useRef } from 'react';

/**
 * Shared accessibility wiring for a `role="dialog"` overlay.
 *
 * `App.tsx`'s own "nueva marca/nuevo trabajo" modal was the one dialog in the
 * app with real behaviour: it trapped Tab/Shift+Tab inside itself, closed on
 * Escape (unless `busy`), moved focus to its first control on open, and gave
 * focus back to whatever had it once it closed. Every other `role="dialog"`
 * in the app either reimplemented a piece of this by hand or skipped it
 * outright. This hook is that original logic, extracted so every dialog gets
 * the same guarantees from one place instead of five slightly different ones.
 *
 * Usage: call it with whether the dialog is currently open, a callback to
 * close it, and whether it is busy (Escape and outside clicks are ignored
 * while busy, matching the original modal). Put the returned ref on the
 * dialog's own container element (the one with `role="dialog"`), not on the
 * backdrop.
 */
export function useModalA11y<T extends HTMLElement>(open: boolean, onClose: () => void, busy = false) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    // `:not(:disabled)` inside a grouped selector list trips a jsdom/nwsapi
    // ordering bug (it groups matches by which branch of the selector
    // matched instead of returning strict document order, so a dialog with
    // both buttons and an input could report the input before a later
    // button). Querying broadly and filtering disabled buttons afterwards
    // sidesteps the engine quirk and is no less correct in a real browser.
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex="0"]') ?? [])
      .filter((el) => !(el instanceof HTMLButtonElement && el.disabled));
    if (!dialog?.contains(document.activeElement)) controls()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!busy) onClose(); return; }
      if (e.key !== 'Tab') return;
      const list = controls();
      if (list.length === 0) return;
      const first = list[0]!, last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);
  return ref;
}
