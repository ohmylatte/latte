import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Paperclip } from 'lucide-react';
import { translate as t } from './i18n';
import { api, chatStore } from './browser-api';
import { useChatState } from './chat-store';

/**
 * EL COMPOSER, UNO SOLO PARA TODA LA APP.
 *
 * Vivia adentro de `ChatPane`, y era el UNICO campo de texto del producto: se
 * miraba el equipo en un lado y se escribia en el otro, a una pestana que
 * competia con las de los demas. El modo Equipo necesita exactamente este
 * composer al pie —el mismo `<textarea>`, el mismo Enter, el mismo adjuntar—,
 * asi que se extrae en vez de copiarse: dos composers son dos comportamientos
 * que se van separando con cada arreglo.
 *
 * Todo lo que sabe sale de la sesion: el borrador vive en el store (sobrevive
 * a cambiar de pestana), el estado ocupado/cerrado tambien. Un id de sesion que
 * el store todavia no conoce se lee como ocioso y abierto, que es la verdad:
 * el miembro esta pausado y escribirle lo despierta (`onBeforeSend`).
 */
export function ChatComposer({ sessionId, onError, onAttachFiles, onBeforeSend, className }: {
  /** La sesion a la que va el mensaje. En Latte el id de un chat ES el id de su miembro. */
  sessionId: string;
  onError: (error: string) => void;
  onAttachFiles?: () => Promise<string[]>;
  /**
   * Lo que hay que hacer ANTES de mandar, cuando el destinatario puede no tener
   * proceso vivo: abrirlo. Se espera; si tira, el mensaje no se manda y el
   * borrador queda intacto — perder lo que la persona escribio es peor que no
   * mandarlo.
   */
  onBeforeSend?: () => Promise<void>;
  className?: string;
}) {
  const state = useChatState(chatStore, sessionId);
  const draft = state.draft;
  const setDraft = (text: string) => chatStore.setDraft(sessionId, text);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const restoreComposerFocus = useRef(false);
  const composerHadFocus = useRef(false);
  const caretToEnd = useRef(false);
  const busy = state.status === 'busy' || state.status === 'retry';

  // Chromium can drop the renderer's text-input focus while the native window
  // is minimized. Restore only a composer that had focus before that native
  // blur; never steal focus from another control inside Latte.
  useEffect(() => {
    const onWindowBlur = () => { restoreComposerFocus.current = composerHadFocus.current; };
    const onWindowFocus = () => {
      if (!restoreComposerFocus.current || state.closed) return;
      restoreComposerFocus.current = false;
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [state.closed]);

  // After attaching, the note is already in the draft: put the caret at the end
  // so the person keeps typing their request instead of landing before the text.
  // It runs on the render that already shows the new value, never on the stale one.
  useEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    const el = composer.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || busy || state.closed) return;
    setSending(true);
    try {
      await onBeforeSend?.();
      await api.sendChat(sessionId, text);
      setDraft('');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Attachments are copied into the work folder first. The note that names them
  // is intentional: file-system access alone does not tell an agent which
  // material the person just added. But attaching does NOT send it — it leaves
  // the note in the composer so the person can attach and ask in one message,
  // instead of the agent starting to think about a bare "here are some files".
  // Anything already typed is kept: the note goes above it, never over it.
  const attach = async () => {
    if (!onAttachFiles || attaching || busy || state.closed) return;
    setAttaching(true);
    try {
      const files = await onAttachFiles();
      if (files.length > 0) {
        const note = t('chat.attach.note', { files: files.map(file => `\`${file}\``).join(', ') });
        caretToEnd.current = true;
        setDraft(draft.trim() ? `${note}\n\n${draft}` : note);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  };

  return <form className={'prompt-form' + (className ? ' ' + className : '')} onSubmit={e => { e.preventDefault(); void send(); }}>
    <textarea ref={composer} aria-label={t('ui.auto.019')} placeholder={state.closed ? t('ui.auto.093') : t('ui.auto.020')} value={draft} disabled={state.closed} onFocus={() => { composerHadFocus.current = true; }} onBlur={e => { if (e.relatedTarget) composerHadFocus.current = false; }} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
    <div><small>{state.closed ? t('ui.auto.093') : busy ? t('ui.auto.094') : t('ui.auto.095')}</small><span><button type="button" className="icon-button" disabled={!onAttachFiles || attaching || busy || state.closed} aria-label={t('chat.attach.label')} title={t('chat.attach.label')} onClick={() => void attach()}><Paperclip size={16} /></button><button className="primary icon-button" disabled={!draft.trim() || sending || busy || state.closed} aria-label={t('ui.auto.023')}><ArrowUpRight size={18} /></button></span></div>
  </form>;
}
