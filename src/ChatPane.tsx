import { translate as t } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpRight, Check, ChevronRight, CircleAlert, FilePlus, Paperclip, ShieldQuestion, Square, Wrench, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { ChatMessage, ChatPart, ChatPermission, ChatQuestion, ChatSession, ChatToolStatus } from '../shared/contracts';
import { api, chatStore } from './browser-api';
import { useChatState } from './chat-store';
import { friendlyTool } from './tool-names';
import { isNearConversationEnd } from './conversation-scroll';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ChatPane({ session, onStop, onError, onSaveAsDocument, untracked = [], onAdoptFile, onAttachFiles, beforeComposer }: { session: ChatSession; onStop: () => void; onError: (error: string) => void; onSaveAsDocument?: (text: string) => void; untracked?: string[]; onAdoptFile?: (fileName: string) => void; onAttachFiles?: () => Promise<string[]>; beforeComposer?: ReactNode }) {
  const state = useChatState(chatStore, session.id);
  const draft = state.draft;
  const setDraft = (text: string) => chatStore.setDraft(session.id, text);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const restoreComposerFocus = useRef(false);
  const composerHadFocus = useRef(false);
  const caretToEnd = useRef(false);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const busy = state.status === 'busy' || state.status === 'retry';

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (following.current) el.scrollTop = el.scrollHeight;
    else setUnread(true);
  }, [state.messages, state.permissions.length, state.questions.length]);

  // Layout switches resize this same mounted pane. Keep following only if the
  // reader already was at the end; never reset an older-message reading position.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (following.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  const showLatest = () => {
    following.current = true;
    setUnread(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || busy || state.closed) return;
    setSending(true);
    try {
      await api.sendChat(session.id, text);
      setDraft('');
    } catch (e) {
      onError(displayError(e));
    } finally {
      setSending(false);
    }
  };

  const abort = () => api.abortChat(session.id).catch(e => onError(displayError(e)));

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
      onError(displayError(e));
    } finally {
      setAttaching(false);
    }
  };

  return <div className="chat-pane">
    <div className="session-heading">
      <span title={`${session.roleName} · ${session.label}`}><i className={'role-dot ' + (state.closed ? 'ended' : busy ? 'busy' : '')} data-role={session.roleId} /><strong>{session.roleName}</strong><span className="chat-heading-runtime">{session.label}</span>{session.resumed ? ' · reanudado' : ''}</span>
      <div className="chat-heading-actions">
        {busy && <button aria-label={t('ui.auto.086')} title={t('ui.auto.086')} onClick={abort}><Square size={12} /></button>}
        <button aria-label={t('ui.auto.087')} title={t('ui.auto.088')} onClick={onStop}><X size={13} /></button>
      </div>
    </div>
    <div className="chat-scroll" ref={scroller} aria-live="polite" onScroll={e => {
      const el = e.currentTarget;
      following.current = isNearConversationEnd(el.scrollTop, el.clientHeight, el.scrollHeight);
      if (following.current) setUnread(false);
    }}>
      {state.messages.length === 0 && <p className="chat-empty">{t('ui.auto.089')} {session.roleName}{t('ui.auto.090')}</p>}
      {state.messages.map(message => <MessageView key={message.id} message={message} roleName={session.roleName} onSaveAsDocument={onSaveAsDocument} untracked={untracked} onAdoptFile={onAdoptFile} />)}
      {state.permissions.map(permission => <PermissionCard key={permission.id} chatId={session.id} runtime={session.provider} request={permission} onError={onError} />)}
      {state.questions.map(question => <QuestionCard key={question.id} chatId={session.id} request={question} onError={onError} />)}
      {busy && <div className="chat-status"><Loading size={16} />{state.status === 'retry' ? state.statusDetail || 'Reintentando…' : t('ui.auto.091')}</div>}
      {state.error && <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{state.error}</span><button aria-label={t('ui.auto.092')} onClick={() => chatStore.clearError(session.id)}><X size={13} /></button></div>}
    </div>
    {unread && <button className="conversation-new-messages" onClick={showLatest}>Hay mensajes nuevos · Ir al final</button>}
    {beforeComposer}
    <form className="prompt-form" onSubmit={e => { e.preventDefault(); void send(); }}>
      <textarea ref={composer} aria-label={t('ui.auto.019')} placeholder={state.closed ? t('ui.auto.093') : t('ui.auto.020')} value={draft} disabled={state.closed} onFocus={() => { composerHadFocus.current = true; }} onBlur={e => { if (e.relatedTarget) composerHadFocus.current = false; }} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div><small>{state.closed ? t('ui.auto.093') : busy ? t('ui.auto.094') : t('ui.auto.095')}</small><span><button type="button" className="icon-button" disabled={!onAttachFiles || attaching || busy || state.closed} aria-label={t('chat.attach.label')} title={t('chat.attach.label')} onClick={() => void attach()}><Paperclip size={16} /></button><button className="primary icon-button" disabled={!draft.trim() || sending || busy || state.closed} aria-label={t('ui.auto.023')}><ArrowUpRight size={18} /></button></span></div>
    </form>
  </div>;
}

function MessageView({ message, roleName, onSaveAsDocument, untracked, onAdoptFile }: { message: ChatMessage; roleName: string; onSaveAsDocument?: (text: string) => void; untracked: string[]; onAdoptFile?: (fileName: string) => void }) {
  const visible = message.parts.filter(p => p.type !== 'text' || p.text.trim().length > 0);
  if (message.role === 'user') {
    const text = message.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
    return <div className="chat-message user"><div className="chat-role">{t('ui.auto.356')}</div><div className="chat-bubble">{text}</div></div>;
  }
  // An answer worth keeping should not stay trapped in the conversation.
  // Decision protocol blocks are a machine channel, not conversation content.
  // Keeping them out of the transcript avoids turning an audit feature into UI noise.
  const text = message.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n\n').replace(/```latte-decision\s*\r?\n[\s\S]*?```/g,'').replace(/```latte-brand-context\s*\r?\n[\s\S]*?```/g,'').trim();
  const worthKeeping = message.completed && !message.error && text.length > 400;
  // If the agent already wrote a file, saying so with its own button is what
  // stops the work from ending with two copies of one deliverable. Two named
  // buttons, no dialog: the person picks the file or the answer, on sight.
  const pending = worthKeeping ? untracked : [];
  return <div className="chat-message assistant">
    <div className="chat-role">{roleName}{!message.completed && !message.error ? <Loading size={16} /> : null}
      {worthKeeping && onSaveAsDocument && <button className="save-as-document" title={t('ui.auto.096')} onClick={() => onSaveAsDocument(text)}><FilePlus size={12} />{pending.length > 0 ? t('ui.auto.097') : t('ui.auto.098')}</button>}
    </div>
    {pending.length > 0 && onAdoptFile && <div className="answer-file-hint">
      <span>{t('ui.auto.099')} {pending.length === 1 ? t('ui.auto.100') : 'estos archivos'}  {t('ui.auto.101')}</span>
      {pending.map(fileName => <button key={fileName} className="primary" onClick={() => onAdoptFile(fileName)}><FilePlus size={12} />{t('ui.auto.357')} {fileName}</button>)}
    </div>}
    {visible.map(part => <PartView key={part.id} part={part} />)}
    {message.error && <div className="chat-error"><CircleAlert size={14} /><span>{message.error}</span></div>}
  </div>;
}

function PartView({ part }: { part: ChatPart }) {
  if (part.type === 'text') return <div className="markdown chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>;
  if (part.type === 'reasoning') return <details className="chat-reasoning"><summary><ChevronRight size={12} />{t('ui.auto.358')}</summary><pre>{part.text}</pre></details>;
  return <details className={'chat-tool ' + part.status}>
    <summary><Wrench size={12} /><span className="chat-tool-name">{part.tool}</span><span className="chat-tool-title">{part.title}</span><span className="chat-tool-status">{part.status === 'running' ? <Loading size={16} /> : part.status === 'completed' ? <Check size={11} /> : part.status === 'error' ? <CircleAlert size={11} /> : null}{labelFor(part.status)}</span></summary>
    {part.input && <><div className="field-label">{t('ui.auto.359')}</div><pre>{part.input}</pre></>}
    {part.output && <><div className="field-label">{t('ui.auto.360')}</div><pre>{part.output}</pre></>}
    {part.error && <div className="chat-error"><CircleAlert size={13} /><span>{part.error}</span></div>}
  </details>;
}

function labelFor(status: ChatToolStatus): string {
  switch (status) {
    case 'running': return 'en curso';
    case 'completed': return 'listo';
    case 'error': return 'error';
    default: return 'pendiente';
  }
}

/**
 * What "always" really covers, per runtime. Verified, not assumed: Claude Code
 * writes the grant into `.claude/settings.local.json` inside the work folder,
 * so it survives the conversation; Codex answers `acceptForSession`, so it does
 * not. Saying which one you are in is what stops "¿por qué pregunta de nuevo?".
 */
const alwaysScope = (): Record<string, string> => ({
  claude: t('chat.permission.claude'),
  codex: t('chat.permission.codex'),
  opencode: t('chat.permission.opencode'),
});

function PermissionCard({ chatId, runtime, request, onError }: { chatId: string; runtime: string; request: ChatPermission; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const reply = (value: 'once' | 'always' | 'reject') => {
    setBusy(true);
    api.replyPermission(chatId, request.id, value).catch(e => onError(displayError(e))).finally(() => setBusy(false));
  };
  if (request.url) {
    return <div className="chat-card permission" role="group" aria-label="Solicitud de permiso">
      <div className="chat-card-title"><ShieldQuestion size={15} />{request.serverName ? t('chat.elicitation.server', { name: request.serverName }) : t('ui.auto.102')}</div>
      {request.title && <p>{request.title}</p>}
      <p><code>{request.url}</code></p>
      <div className="chat-card-actions">
        <button className="primary" disabled={busy} onClick={() => reply('once')}>{t('chat.elicitation.openAccept')}</button>
        <button disabled={busy} onClick={() => reply('reject')}>{t('chat.elicitation.reject')}</button>
      </div>
    </div>;
  }
  return <div className="chat-card permission" role="group" aria-label="Solicitud de permiso">
    <div className="chat-card-title"><ShieldQuestion size={15} />{t('ui.auto.102')}<strong title={request.permission}>{friendlyTool(request.permission)}</strong></div>
    {request.title && <p>{request.title}</p>}
    {request.patterns.length > 0 && <ul>{request.patterns.map(p => <li key={p}><code>{p}</code></li>)}</ul>}
    <div className="chat-card-actions">
      <button className="primary" disabled={busy} onClick={() => reply('once')}>{t('ui.auto.103')}</button>
      {request.always.length > 0 && <button disabled={busy} onClick={() => reply('always')}>{t('ui.auto.361')}</button>}
      <button disabled={busy} onClick={() => reply('reject')}>{t('ui.auto.362')}</button>
    </div>
    {request.always.length > 0 && <small className="permission-scope">{alwaysScope()[runtime] ?? alwaysScope().opencode}</small>}
  </div>;
}

function QuestionCard({ chatId, request, onError }: { chatId: string; request: ChatQuestion; onError: (e: string) => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  const toggle = (qi: number, label: string, multiple: boolean) => setAnswers(prev => prev.map((a, i) => i !== qi ? a : multiple ? (a.includes(label) ? a.filter(x => x !== label) : [...a, label]) : [label]));
  const submit = () => {
    const final = answers.map((a, i) => (custom[i].trim() ? [...a, custom[i].trim()] : a));
    if (final.some((a, i) => request.questions[i].required !== false && a.length === 0)) return;
    setBusy(true);
    api.replyQuestion(chatId, request.id, final).catch(e => onError(displayError(e))).finally(() => setBusy(false));
  };
  const reject = () => { setBusy(true); api.replyQuestion(chatId, request.id, null).catch(e => onError(displayError(e))).finally(() => setBusy(false)); };
  const missingRequired = answers.some((a, i) => request.questions[i].required !== false && a.length === 0 && !custom[i].trim());
  return <div className="chat-card question" role="group" aria-label={t('ui.auto.104')}>
    {request.questions.map((q, qi) => <div key={qi} className="chat-question">
      <div className="chat-card-title"><ShieldQuestion size={15} />{q.header || t('ui.auto.105')}</div>
      <p>{q.question}</p>
      <div className="chat-options">{q.options.map(o => <button key={o.label} className={answers[qi].includes(o.label) ? 'selected-option' : ''} title={o.description} onClick={() => toggle(qi, o.label, q.multiple)}>{answers[qi].includes(o.label) && <Check size={12} />}{o.label}</button>)}</div>
      {q.custom && <input aria-label={t('ui.auto.106')} placeholder={t('ui.auto.107')} value={custom[qi]} onChange={e => setCustom(prev => prev.map((c, i) => (i === qi ? e.target.value : c)))} />}
    </div>)}
    <div className="chat-card-actions">
      <button className="primary" disabled={busy || missingRequired} onClick={submit}>{t('ui.auto.363')}</button>
      <button disabled={busy} onClick={reject}>{t('ui.auto.364')}</button>
    </div>
  </div>;
}
