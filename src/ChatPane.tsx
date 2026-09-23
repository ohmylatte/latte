import { translate as t } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, CircleAlert, FilePlus, LogIn, Plug, ShieldQuestion, Square, Wrench, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { AgentRole, ChatMessage, ChatPart, ChatPermission, ChatQuestion, ChatSession, ChatStatus, ChatToolStatus, CoordinationAskView, CoordinationGateView, CoordinationRunView, TeamMember } from '../shared/contracts';
import { api, chatStore } from './browser-api';
import { useChatState } from './chat-store';
import { friendlyTool } from './tool-names';
import { isNearConversationEnd } from './conversation-scroll';
import { TeamCardsCollapsible } from './coordination/TeamCards';
import { ChatComposer } from './ChatComposer';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Lo que la coordinación le pide a ESTE chat.
 *
 * Todo opcional y aditivo: un llamador sin cablear (la vista previa del
 * navegador, un test de otra cosa) ve el chat exactamente como estaba. El id
 * del miembro es el id de la sesión — en Latte un chat ES un miembro —, así
 * que no hace falta pasarlo aparte.
 */
export interface ChatCoordinationProps {
  coordinationRun?: CoordinationRunView | null;
  gates?: readonly CoordinationGateView[];
  openAsks?: readonly CoordinationAskView[];
  roles?: readonly AgentRole[];
  team?: readonly TeamMember[];
  formatDate?: (value: string) => string;
  onResolveGate?: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void | boolean | Promise<boolean | void>;
  onAnswerAsk?: (askId: string, answer: string) => void;
  coordinationPending?: Record<string, boolean>;
  /** Cambia de pestaña dentro del Trabajo: lo que aprieta "El equipo te espera". */
  onSelectMember?: (memberId: string) => void;
  /** C6: la hora local de un ISO, para la línea del plan aprobado y la pregunta. */
  formatTime?: (value: string) => string;
  /** C6: cambia el rail a Equipo: lo que aprieta "Ver equipo". */
  onShowTeam?: () => void;
  /** H1: la persona ya abrió el equipo de este run; la línea del plan aprobado ya no avisa nada. */
  teamSeen?: boolean;
  /**
   * H1: el rail avisa que el equipo se abrió, por el verbo o por el segmento.
   * Lo consume `TeamPanel`, que es quien tiene el rail; viaja acá porque es el
   * mismo paquete de props de coordinación que baja del `App`.
   */
  onTeamOpened?: () => void;
  /**
   * B3.5: la persona ya pidio ver el pendiente.
   *
   * Inicio ("te espera una aprobacion") y la tira lateral abren la
   * conversacion del coordinador JUSTAMENTE para que apruebe: dejarle la
   * linea plegada seria cobrarle un clic mas por lo que ya pidio. En
   * cualquier otra navegacion queda plegada, que es el default.
   */
  initiallyExpanded?: boolean;
}

export function ChatPane({ session, onStop, onError, onSaveAsDocument, untracked = [], onAdoptFile, onAttachFiles, beforeComposer, coordination }: { session: ChatSession; onStop: () => void; onError: (error: string) => void; onSaveAsDocument?: (text: string) => void; untracked?: string[]; onAdoptFile?: (fileName: string) => void; onAttachFiles?: () => Promise<string[]>; beforeComposer?: ReactNode; coordination?: ChatCoordinationProps }) {
  const state = useChatState(chatStore, session.id);
  const scroller = useRef<HTMLDivElement>(null);
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

  const showLatest = () => {
    following.current = true;
    setUnread(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };

  const abort = () => api.abortChat(session.id).catch(e => onError(displayError(e)));

  return <div className="chat-pane">
    <div className="session-heading">
      <span title={`${session.roleName} · ${session.label}`}><i className={'role-dot ' + (state.closed ? 'ended' : busy ? 'busy' : '')} data-role={session.roleId} /><strong>{session.roleName}</strong><span className="chat-heading-runtime">{session.label}</span>{session.resumed ? t('chat.resumed') : ''}</span>
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
      {state.expiredConnections.map(connection => <ConnectionExpiredCard key={connection.connectionId} connection={connection} onError={onError} />)}
      <ChatWorking status={state.status} detail={state.statusDetail} />
      {state.error && <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{state.error}</span><button aria-label={t('ui.auto.092')} onClick={() => chatStore.clearError(session.id)}><X size={13} /></button></div>}
    </div>
    {unread && <button className="conversation-new-messages" onClick={showLatest}>{t('chat.newMessages')}</button>}
    {/* Arriba del composer, fija: lo que el equipo le está pidiendo a ESTE
        miembro. No entra en el scroll de la conversación a propósito — una
        aprobación que se va hacia arriba con los mensajes es una aprobación
        que la persona no ve. */}
    {coordination && <TeamCardsCollapsible
      memberId={session.id}
      coordinationRun={coordination.coordinationRun}
      gates={coordination.gates}
      openAsks={coordination.openAsks}
      roles={coordination.roles}
      team={coordination.team}
      formatDate={coordination.formatDate}
      onResolveGate={coordination.onResolveGate}
      onAnswerAsk={coordination.onAnswerAsk}
      pending={coordination.coordinationPending}
      onSelectMember={coordination.onSelectMember}
      formatTime={coordination.formatTime}
      onShowTeam={coordination.onShowTeam}
      teamSeen={coordination.teamSeen}
      initiallyExpanded={coordination.initiallyExpanded}
    />}
    {beforeComposer}
    <ChatComposer sessionId={session.id} onError={onError} onAttachFiles={onAttachFiles} />
  </div>;
}

/**
 * "El agente está trabajando…", UNA vez para las DOS superficies.
 *
 * La conversación de un miembro y el hilo del chat de equipo cuentan el mismo
 * hecho —el destinatario está escribiendo— y tienen que contarlo igual: mismo
 * texto, misma marca, mismo reintento. Duplicarlo sería la forma de que un día
 * una de las dos se quede muda, que es exactamente lo que pasó con el hilo.
 *
 * `idle` no dibuja nada: una barra que dice "listo" es una barra que sobra.
 */
export function ChatWorking({ status, detail }: { status: ChatStatus; detail?: string }) {
  if (status !== 'busy' && status !== 'retry') return null;
  return <div className="chat-status"><Loading size={16} />{status === 'retry' ? detail || t('chat.retrying') : t('ui.auto.091')}</div>;
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
      <span>{t('ui.auto.099')} {pending.length === 1 ? t('chat.files.one') : t('chat.files.many')}  {t('ui.auto.101')}</span>
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
    case 'running': return t('chat.tool.running');
    case 'completed': return t('chat.tool.completed');
    case 'error': return t('chat.tool.error');
    default: return t('chat.tool.pending');
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
    return <div className="chat-card permission" role="group" aria-label={t('chat.permission.group')}>
      <div className="chat-card-title"><ShieldQuestion size={15} />{request.serverName ? t('chat.elicitation.server', { name: request.serverName }) : t('ui.auto.102')}</div>
      {request.title && <p>{request.title}</p>}
      <p><code>{request.url}</code></p>
      <div className="chat-card-actions">
        <button className="primary" disabled={busy} onClick={() => reply('once')}>{t('chat.elicitation.openAccept')}</button>
        <button disabled={busy} onClick={() => reply('reject')}>{t('chat.elicitation.reject')}</button>
      </div>
    </div>;
  }
  return <div className="chat-card permission" role="group" aria-label={t('chat.permission.group')}>
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

/**
 * Una Conexión MCP se venció a mitad de run.
 *
 * Va en el HILO, no en un toast: el runtime, ante un token que no sirve,
 * reporta `failed` y no `needs-auth` (medido en 1.6 del brief de conexiones),
 * así que un aviso que se va solo es un aviso que nadie va a ver. Y lo que
 * pide es una acción concreta, no un "algo salió mal": volver a entrar. Al
 * volver, el gateway sigue sirviendo sin reiniciar a nadie, así que la tarjeta
 * se retira sola cuando llega `connection-restored`.
 */
export function ConnectionExpiredCard({ connection, onError }: {
  connection: { connectionId: string; label: string; detail: string };
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return <div className="chat-card connection-expired" role="group" aria-label={t('connections.expiredCardTitle', { name: connection.label })}>
    <div className="chat-card-title"><Plug size={15} />{t('connections.expiredCardTitle', { name: connection.label })}</div>
    <p>{t('connections.expiredCardBody')}</p>
    <div className="chat-card-actions">
      <button className="primary" disabled={busy} onClick={() => {
        setBusy(true);
        api.reconnectConnection(connection.connectionId)
          .catch(e => onError(displayError(e)))
          .finally(() => setBusy(false));
      }}>{busy ? <Loading size={16} /> : <LogIn size={14} />}{t('connections.reenter')}</button>
    </div>
  </div>;
}
