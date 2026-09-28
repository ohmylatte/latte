import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy, ExternalLink, LogIn, RefreshCw, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type {
  AccountRuntimeName, ChatRuntime, InstallFailureCode, LoginFailureCode, Provider,
  RuntimeDiagnostic, RuntimeInstallState, RuntimeLoginState, SetupPrereq,
} from '../shared/contracts';
import { RUNTIME_GUIDE_URLS } from '../shared/contracts';
import { translate, useI18n } from './i18n';
import { agentBus, api } from './browser-api';
import { TerminalPane } from './TerminalPane';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Commercial names only — never the runtime id, per Maqueta E. */
export const RUNTIME_DISPLAY_KEY: Record<Provider, 'connectAI.name.claude' | 'connectAI.name.codex' | 'connectAI.name.opencode' | 'connectAI.name.grok' | 'connectAI.name.hermes'> = {
  claude: 'connectAI.name.claude', codex: 'connectAI.name.codex', opencode: 'connectAI.name.opencode', grok: 'connectAI.name.grok', hermes: 'connectAI.name.hermes',
};
const PREREQ_KEY: Record<SetupPrereq, 'connectAI.prereq.git_for_windows' | 'connectAI.prereq.winget' | 'connectAI.prereq.node'> = {
  git_for_windows: 'connectAI.prereq.git_for_windows', winget: 'connectAI.prereq.winget', node: 'connectAI.prereq.node',
};
const OTHER_RUNTIMES = ['grok', 'hermes', 'opencode'] as const satisfies readonly Provider[];
const isAccountRuntime = (p: Provider): p is AccountRuntimeName => p === 'claude' || p === 'codex' || p === 'grok' || p === 'hermes';
/** Claude/Codex accept the person's own local CLI session ("system"); Grok/Hermes (ACP) can only ever be primary through a Latte-managed profile (`hub.ts` `setPrimary`). */
const isSubscriptionRuntime = (rt: AccountRuntimeName): rt is 'claude' | 'codex' => rt === 'claude' || rt === 'codex';

/** One card's whole state machine — install (Latte-driven) then, for account runtimes, login. */
type CardPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'not_installed'; canInstall: boolean; guideUrl: string }
  | { kind: 'needs_prereq'; prereq: SetupPrereq; canInstall: boolean; guideUrl: string }
  | { kind: 'installing'; phase: 'prereq' | 'downloading' | 'checking'; jobId: string }
  | { kind: 'install_failed'; code: InstallFailureCode; detail: string; guideUrl: string; jobId: string }
  /** OpenCode has no account/login concept here: once installed its provider keys live in Configuración avanzada. */
  | { kind: 'opencode_ready' }
  | { kind: 'needs_login' }
  | { kind: 'logging_in'; jobId: string; state: RuntimeLoginState }
  | { kind: 'login_failed'; code: LoginFailureCode; detail: string; guideUrl: string }
  | { kind: 'connected'; accountId: string; displayName: string | null };

interface RuntimeCardApi {
  runtime: Provider | null;
  phase: CardPhase;
  showDetail: boolean;
  transcript: string;
  install: (installPrereqs?: boolean) => void;
  cancelInstall: () => void;
  toggleDetail: () => void;
  login: () => void;
  reopen: () => void;
  cancelLogin: () => void;
  use: () => void;
  retry: () => void;
}

/**
 * Drives ONE runtime card end to end against the "onboarding sin terminal"
 * engine (shared/contracts.ts). `runtime` may be null (the "Otra cuenta" slot
 * before something is picked): the hook then just sits idle, so the three
 * main cards and the expandable one can all call this the same way.
 */
function useRuntimeCard(runtime: Provider | null, refreshToken: number, onError: (text: string) => void, onConnected?: (runtime: AccountRuntimeName, accountId: string) => void): RuntimeCardApi {
  const [phase, setPhase] = useState<CardPhase>({ kind: 'idle' });
  const [showDetail, setShowDetail] = useState(false);
  const [transcript, setTranscript] = useState('');
  const jobIdRef = useRef<string | null>(null);
  const runtimeRef = useRef(runtime); runtimeRef.current = runtime;

  const checkLogin = useCallback(async (rt: AccountRuntimeName) => {
    try {
      const list = await api.listAgentRuntimes();
      const info = list.find(r => r.runtime === rt);
      const account = info?.accounts.find(a => a.loggedIn) ?? null;
      if (runtimeRef.current === rt) setPhase(account ? { kind: 'connected', accountId: account.id, displayName: null } : { kind: 'needs_login' });
    } catch (e) { onError(displayError(e)); }
  }, [onError]);

  const detect = useCallback(async (rt: Provider) => {
    setPhase({ kind: 'loading' });
    try {
      const state = await api.detectRuntime(rt);
      if (runtimeRef.current !== rt) return;
      if (state.state === 'found') { if (isAccountRuntime(rt)) await checkLogin(rt); else setPhase({ kind: 'opencode_ready' }); }
      else if (state.state === 'not_found') setPhase({ kind: 'not_installed', canInstall: state.canInstall, guideUrl: state.guideUrl });
      else if (state.state === 'needs_prereq') setPhase({ kind: 'needs_prereq', prereq: state.prereq, canInstall: state.canInstall, guideUrl: state.guideUrl });
    } catch (e) { onError(displayError(e)); }
  }, [checkLogin, onError]);

  useEffect(() => {
    setShowDetail(false); setTranscript(''); jobIdRef.current = null;
    if (!runtime) { setPhase({ kind: 'idle' }); return; }
    void detect(runtime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, refreshToken]);

  useEffect(() => api.onRuntimeSetupEvent(event => {
    if (event.jobId !== jobIdRef.current) return;
    const rt = runtimeRef.current;
    if (event.kind === 'install') {
      const s: RuntimeInstallState = event.state;
      if (s.state === 'installing') setPhase({ kind: 'installing', phase: s.phase, jobId: event.jobId });
      else if (s.state === 'installed' || s.state === 'found') { jobIdRef.current = null; if (rt && isAccountRuntime(rt)) void checkLogin(rt); else setPhase({ kind: 'opencode_ready' }); }
      else if (s.state === 'failed') { jobIdRef.current = null; setPhase({ kind: 'install_failed', code: s.code, detail: s.detail, guideUrl: s.guideUrl, jobId: event.jobId }); }
      else if (s.state === 'needs_prereq') { jobIdRef.current = null; setPhase({ kind: 'needs_prereq', prereq: s.prereq, canInstall: s.canInstall, guideUrl: s.guideUrl }); }
      else if (s.state === 'cancelled') { jobIdRef.current = null; if (rt) void detect(rt); }
    } else {
      const s: RuntimeLoginState = event.state;
      // Logging in is not the same as choosing to use it: the card still shows
      // "Usar {name}" and `onConnected` fires from THAT click, never from here.
      if (s.state === 'connected') { jobIdRef.current = null; setPhase({ kind: 'connected', accountId: event.accountId, displayName: s.displayName }); }
      else if (s.state === 'failed') { jobIdRef.current = null; setPhase({ kind: 'login_failed', code: s.code, detail: s.detail, guideUrl: rt ? RUNTIME_GUIDE_URLS[rt] : '' }); }
      else if (s.state === 'cancelled') { jobIdRef.current = null; if (rt && isAccountRuntime(rt)) void checkLogin(rt); }
      else setPhase({ kind: 'logging_in', jobId: event.jobId, state: s });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [checkLogin, detect]);

  // A login stuck at "needs_terminal" ends when the embedded CLI exits.
  useEffect(() => {
    if (phase.kind !== 'logging_in' || phase.state.state !== 'needs_terminal') return;
    const sessionId = phase.state.sessionId;
    return agentBus.subscribe(sessionId, event => {
      if (event.type === 'exit') { const rt = runtimeRef.current; if (rt && isAccountRuntime(rt)) void checkLogin(rt); }
    }, false);
  }, [phase, checkLogin]);

  const install = useCallback((installPrereqs = false) => {
    if (!runtime) return;
    void (async () => {
      try {
        const job = await api.startRuntimeInstall(runtime, installPrereqs ? { installPrereqs: true } : null);
        jobIdRef.current = job.jobId;
        setPhase(job.state.state === 'installing' ? { kind: 'installing', phase: job.state.phase, jobId: job.jobId } : { kind: 'installing', phase: 'downloading', jobId: job.jobId });
      } catch (e) { onError(displayError(e)); }
    })();
  }, [runtime, onError]);

  const cancelInstall = useCallback(() => {
    const jobId = jobIdRef.current; if (!jobId) return;
    void api.cancelRuntimeInstall(jobId).catch(e => onError(displayError(e)));
  }, [onError]);

  const toggleDetail = useCallback(() => {
    setShowDetail(v => {
      const next = !v;
      const jobId = jobIdRef.current;
      if (next && jobId) void api.getRuntimeSetupTranscript(jobId).then(setTranscript).catch(() => undefined);
      return next;
    });
  }, []);

  const login = useCallback(() => {
    if (!runtime || !isAccountRuntime(runtime)) return;
    const rt = runtime;
    void (async () => {
      try {
        const list = await api.listAgentRuntimes();
        const info = list.find(r => r.runtime === rt);
        // Grok/Hermes can only ever be primary through a Latte-managed profile
        // (never "system" — see `hub.ts` `setPrimary`); Claude/Codex are happy
        // signing in with the person's own local CLI session.
        let account = info?.accounts.find(a => a.loggedIn)
          ?? info?.accounts.find(a => !a.system)
          ?? (isSubscriptionRuntime(rt) ? info?.accounts.find(a => a.system) : undefined)
          ?? null;
        if (!account) account = await api.addAgentAccount(rt, translate(RUNTIME_DISPLAY_KEY[rt]));
        if (account.loggedIn) { setPhase({ kind: 'connected', accountId: account.id, displayName: null }); return; }
        const job = await api.startBrowserLogin(rt, account.id);
        jobIdRef.current = job.jobId;
        setPhase({ kind: 'logging_in', jobId: job.jobId, state: job.state });
      } catch (e) { onError(displayError(e)); }
    })();
  }, [runtime, onError]);

  const reopen = useCallback(() => {
    const jobId = jobIdRef.current; if (!jobId) return;
    void api.reopenLoginUrl(jobId).catch(e => onError(displayError(e)));
  }, [onError]);

  const cancelLogin = useCallback(() => {
    const jobId = jobIdRef.current; if (!jobId) return;
    void api.cancelBrowserLogin(jobId).catch(e => onError(displayError(e)));
  }, [onError]);

  const use = useCallback(() => {
    if (!runtime || phase.kind !== 'connected') return;
    const accountId = phase.accountId;
    void api.setPrimaryAgent({ runtime: runtime as ChatRuntime, model: null, accountId })
      .then(() => onConnected?.(runtime as AccountRuntimeName, accountId))
      .catch(e => onError(displayError(e)));
  }, [runtime, phase, onError, onConnected]);

  const retry = useCallback(() => {
    if (!runtime) return;
    if (phase.kind === 'login_failed') { if (isAccountRuntime(runtime)) void checkLogin(runtime); return; }
    void detect(runtime);
  }, [runtime, phase.kind, detect, checkLogin]);

  return { runtime, phase, showDetail, transcript, install, cancelInstall, toggleDetail, login, reopen, cancelLogin, use, retry };
}

function InstallProgress({ phase }: { phase: 'prereq' | 'downloading' | 'checking' }) {
  const { t } = useI18n();
  return <div className="connect-ai-progress">
    <div className="connect-ai-progress-bar"><span /></div>
    <small>{t(phase === 'downloading' ? 'connectAI.install.downloading' : phase === 'checking' ? 'connectAI.install.checking' : 'connectAI.install.prereq')}</small>
  </div>;
}

/** One card: Claude / ChatGPT / a picked "otra cuenta" runtime. */
function RuntimeCard({ card, onError }: { card: RuntimeCardApi; onError: (text: string) => void }) {
  const { t } = useI18n();
  if (!card.runtime) return null;
  const runtime = card.runtime;
  const name = t(RUNTIME_DISPLAY_KEY[runtime]);
  const phase = card.phase;

  let dot: 'green-ok' | 'rust' | 'line-strong' = 'line-strong';
  let statusKey: 'connectAI.status.connected' | 'connectAI.status.needsLogin' | 'connectAI.status.notInstalled' | 'connectAI.status.checking' = 'connectAI.status.checking';
  if (phase.kind === 'connected' || phase.kind === 'opencode_ready') { dot = 'green-ok'; statusKey = 'connectAI.status.connected'; }
  else if (phase.kind === 'needs_login' || phase.kind === 'logging_in' || phase.kind === 'login_failed') { dot = 'rust'; statusKey = 'connectAI.status.needsLogin'; }
  else if (phase.kind === 'not_installed' || phase.kind === 'needs_prereq' || phase.kind === 'installing' || phase.kind === 'install_failed') { dot = 'line-strong'; statusKey = 'connectAI.status.notInstalled'; }

  return <div className={'connect-ai-card' + (dot === 'rust' ? ' is-attention' : '')} role="group" aria-label={name}>
    <strong className="connect-ai-card-name">{name}</strong>
    <span className="connect-ai-card-status"><i className={'connect-ai-dot dot-' + dot} aria-hidden="true" />{t(statusKey)}</span>

    {(phase.kind === 'idle' || phase.kind === 'loading') && <p>{t('connectAI.status.checking')}</p>}

    {phase.kind === 'not_installed' && <>
      <p>{t('connectAI.body.notInstalled')}</p>
      {phase.canInstall
        ? <button className="primary" onClick={() => card.install()}><LogIn size={14} />{t('connectAI.action.install')}</button>
        : <a className="connect-ai-guide-link" href={phase.guideUrl} target="_blank" rel="noreferrer">{t('connectAI.action.officialGuide')} <ExternalLink size={12} /></a>}
    </>}

    {phase.kind === 'needs_prereq' && <>
      <p>{t('connectAI.prereq.ask', { name, prereq: t(PREREQ_KEY[phase.prereq]) })}</p>
      {phase.canInstall
        ? <button className="primary" onClick={() => card.install(true)}>{t('connectAI.prereq.installToo')}</button>
        : <><p>{t('connectAI.prereq.onlyGuide', { name, prereq: t(PREREQ_KEY[phase.prereq]) })}</p><a className="connect-ai-guide-link" href={phase.guideUrl} target="_blank" rel="noreferrer">{t('connectAI.action.officialGuide')} <ExternalLink size={12} /></a></>}
    </>}

    {phase.kind === 'installing' && <>
      <InstallProgress phase={phase.phase} />
      <div className="connect-ai-card-actions">
        <button className="subtle" onClick={card.toggleDetail}>{t(card.showDetail ? 'connectAI.action.hideDetail' : 'connectAI.action.viewDetail')}</button>
        <button onClick={card.cancelInstall}><X size={13} />{t('connectAI.action.cancel')}</button>
      </div>
      {card.showDetail && <pre className="connect-ai-transcript">{card.transcript}</pre>}
    </>}

    {phase.kind === 'install_failed' && <>
      <p>{t(`connectAI.error.install.${phase.code}` as 'connectAI.error.install.unknown')}</p>
      <div className="connect-ai-card-actions">
        <button className="primary" onClick={card.retry}><RefreshCw size={13} />{t('connectAI.action.retryDetect')}</button>
        <a className="connect-ai-guide-link" href={phase.guideUrl} target="_blank" rel="noreferrer">{t('connectAI.action.officialGuide')} <ExternalLink size={12} /></a>
      </div>
    </>}

    {phase.kind === 'opencode_ready' && <>
      <p>{t('connectAI.opencode.installedBody')}</p>
    </>}

    {phase.kind === 'needs_login' && <>
      <p>{t('connectAI.body.needsLogin')}</p>
      <button className="primary" onClick={card.login}><LogIn size={14} />{t('connectAI.action.login', { name })}</button>
    </>}

    {phase.kind === 'logging_in' && <LoginInFlight state={phase.state} card={card} onError={onError} />}

    {phase.kind === 'login_failed' && <>
      <p>{t(`connectAI.error.login.${phase.code}` as 'connectAI.error.login.unknown')}</p>
      <div className="connect-ai-card-actions">
        <button className="primary" onClick={card.retry}><RefreshCw size={13} />{t('connectAI.action.retryDetect')}</button>
        <a className="connect-ai-guide-link" href={phase.guideUrl} target="_blank" rel="noreferrer">{t('connectAI.action.officialGuide')} <ExternalLink size={12} /></a>
      </div>
    </>}

    {phase.kind === 'connected' && <>
      <p>{t('connectAI.body.connected')}</p>
      <button className="primary" onClick={card.use}><Check size={14} />{t('connectAI.action.use', { name })}</button>
    </>}
  </div>;
}

function LoginInFlight({ state, card, onError }: { state: RuntimeLoginState; card: RuntimeCardApi; onError: (text: string) => void }) {
  const { t } = useI18n();
  if (state.state === 'needs_terminal') return <div className="connect-ai-login-flight">
    <p>{t('connectAI.login.needsTerminal')}</p>
    <TerminalPane sessionId={state.sessionId} onError={onError} />
    <button onClick={card.cancelLogin}><X size={13} />{t('connectAI.action.cancel')}</button>
  </div>;
  if (state.state === 'connected') return <p>{state.displayName ? t('connectAI.login.connectedAs', { name: state.displayName }) : t('connectAI.login.connectedPlain')}</p>;
  const url = state.state === 'browser_opened' || state.state === 'waiting' ? state.url : null;
  return <div className="connect-ai-login-flight">
    <p>{state.state === 'starting' ? t('connectAI.status.checking') : t('connectAI.login.opened')}</p>
    {state.state === 'waiting' && <small>{t('connectAI.login.waiting')}</small>}
    <div className="connect-ai-card-actions">
      {url && <button onClick={card.reopen}><ExternalLink size={13} />{t('connectAI.action.reopen')}</button>}
      <button onClick={card.cancelLogin}><X size={13} />{t('connectAI.action.cancel')}</button>
    </div>
  </div>;
}

function DiagnosticPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<RuntimeDiagnostic | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void api.diagnoseRuntimes().then(setReport); }, []);
  const copy = async () => {
    if (!report) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(report.report);
      setCopyNotice(t('connectAI.diagnostic.copied'));
    } catch {
      textRef.current?.select();
      setCopyNotice(t('connectAI.diagnostic.selectFallback'));
    }
  };
  return <div className="connect-ai-diagnostic" role="group" aria-label={t('connectAI.diagnostic.title')}>
    <div className="connect-ai-diagnostic-head"><strong>{t('connectAI.diagnostic.title')}</strong><button className="icon-button" aria-label={t('connectAI.diagnostic.close')} onClick={onClose}><X size={15} /></button></div>
    {!report && <Loading size={16} />}
    {report && <ul>
      {report.runtimes.map(r => <li key={r.runtime}>
        {t(r.installed ? (r.version ? 'connectAI.diagnostic.line.installed' : 'connectAI.diagnostic.line.installedNoVersion') : 'connectAI.diagnostic.line.notInstalled', { name: t(RUNTIME_DISPLAY_KEY[r.runtime]), version: r.version ?? '' })}
        {r.loggedIn != null && (r.loggedIn ? t('connectAI.diagnostic.loggedIn') : t('connectAI.diagnostic.notLoggedIn'))}
        {r.lastError && t('connectAI.diagnostic.lastError', { detail: r.lastError })}
      </li>)}
    </ul>}
    {report && <textarea ref={textRef} readOnly className="connect-ai-diagnostic-text" value={report.report} aria-label={t('connectAI.diagnostic.title')} />}
    {report && <button onClick={() => void copy()}><Copy size={13} />{t('connectAI.diagnostic.copy')}</button>}
    {copyNotice && <p role="status" className="footnote">{copyNotice}</p>}
  </div>;
}

export interface ConnectAIProps {
  /** Fires once a runtime becomes usable (connected + set as primary). Onboarding uses it to advance; Settings ignores it. */
  onConnected?: () => void;
  /** Onboarding renders its own h1; Settings shows this component's own header. */
  showHeader?: boolean;
  /** The unchanged "Agentes y proveedores" block (ProvidersView + raw terminal), revealed inside the collapsed advanced box. Omitted in onboarding, which keeps its own separate advanced details. */
  advanced?: ReactNode;
  onError: (text: string) => void;
}

/**
 * Maqueta E — "¿Con qué cuenta trabaja tu equipo?": three cards (Claude,
 * ChatGPT, Otra cuenta), a recheck row and a collapsed advanced box. Built on
 * top of the "onboarding sin terminal" engine (runtimeSetupCatalog,
 * detectRuntime, startRuntimeInstall, startBrowserLogin — shared/contracts.ts);
 * never invents a state the contract does not report.
 */
export function ConnectAI({ onConnected, showHeader = true, advanced, onError }: ConnectAIProps) {
  const { t } = useI18n();
  const [refreshToken, setRefreshToken] = useState(0);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [otherRuntime, setOtherRuntime] = useState<Provider | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  const onRuntimeConnected = useCallback(() => { onConnected?.(); }, [onConnected]);
  const claude = useRuntimeCard('claude', refreshToken, onError, onRuntimeConnected);
  const codex = useRuntimeCard('codex', refreshToken, onError, onRuntimeConnected);
  const other = useRuntimeCard(otherRuntime, refreshToken, onError, onRuntimeConnected);

  useEffect(() => { setLastChecked(Date.now()); }, [refreshToken]);
  useEffect(() => { const id = window.setInterval(() => tick(v => v + 1), 1000); return () => window.clearInterval(id); }, []);

  const recheck = () => setRefreshToken(v => v + 1);
  const elapsed = lastChecked != null ? Math.max(0, Math.round((Date.now() - lastChecked) / 1000)) : null;

  return <div className="connect-ai">
    {showHeader && <><h1>{t('connectAI.title')}</h1><p className="intro">{t('connectAI.subtitle')}</p></>}
    <div className="connect-ai-cards">
      <RuntimeCard card={claude} onError={onError} />
      <RuntimeCard card={codex} onError={onError} />
      <div className="connect-ai-card connect-ai-other">
        {!otherRuntime ? <>
          <strong className="connect-ai-card-name">{t('connectAI.other.title')}</strong>
          <p>{t('connectAI.other.body')}</p>
          <div className="connect-ai-other-pick" role="group" aria-label={t('connectAI.other.pick')}>
            {OTHER_RUNTIMES.map(r => <button key={r} onClick={() => setOtherRuntime(r)}>{t(RUNTIME_DISPLAY_KEY[r])}</button>)}
          </div>
        </> : <>
          <button className="subtle connect-ai-other-back" onClick={() => setOtherRuntime(null)}>{t('connectAI.other.back')}</button>
          <RuntimeCard card={other} onError={onError} />
        </>}
      </div>
    </div>

    <div className="connect-ai-recheck-row">
      <button className="subtle" onClick={recheck}><RefreshCw size={13} />{t('team.recheck')}</button>
      <small>{elapsed == null ? t('connectAI.recheck.never') : t('connectAI.recheck.last', { seconds: elapsed })}</small>
      <button className="subtle" onClick={() => setDiagnosticOpen(v => !v)}>{t('connectAI.diagnostic.button')}</button>
    </div>
    {diagnosticOpen && <DiagnosticPanel onClose={() => setDiagnosticOpen(false)} />}

    {advanced && <details className="connect-ai-advanced">
      <summary><ChevronRight size={13} />{t('connectAI.advanced.summary')}</summary>
      {advanced}
    </details>}
  </div>;
}
