import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ExternalLink, Folder, FolderOpen, LoaderCircle, LogIn, Plug, Plus, Settings2, Sparkles, X } from 'lucide-react';
import type { AgentRole, AgentRuntimeInfo, Brand, ChatRuntimeStatus, OnboardingDraft, PrimaryAgent, ProviderInfo, ProviderOAuthStart } from '../shared/contracts';
import { useI18n } from './i18n';
import { agentBus, api, isDesktop } from './browser-api';
import { TerminalPane } from './TerminalPane';
import { confirmFolderLink } from './folder-link';
import {
  FREE_FORM_WORK_TYPE,
  findWorkType,
  intentGroups,
  recommendRole,
  workTypesForIntent,
  type Answer,
  type WorkType,
} from './work-catalog';
import {
  completeOnboarding,
  declareAssumptions,
  initialState,
  missingRequiredQuestions,
  previousStep,
  toDraft,
  type OnboardingState,
  type OnboardingStep,
} from './onboarding-flow';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STEP_ORDER: OnboardingStep[] = ['intent', 'context', 'brand', 'connect', 'prepare'];
const RUNTIME_LABEL: Record<'claude' | 'codex', string> = { claude: 'Claude Code', codex: 'Codex' };

function isDemoBrand(b: Brand): boolean {
  return b.id === 'demo' || b.id === 'brd_demo_casa_oliva' || /\bdemo\b/i.test(b.name);
}

export interface OnboardingResult {
  workId: string;
  brandId: string;
  recommendedRoleId: string;
  title: string;
  /**
   * The brief kept the disk version because an unseen change was detected. The
   * work exists, but the human's brief text was not saved, and the shell has to
   * say so: the gate unmounts the moment this result lands.
   */
  briefConflict?: boolean;
  /** The folder picker was cancelled or declined: the work exists, nothing was linked. */
  folderNotLinked?: boolean;
}

export function OnboardingGate({ onComplete, onSkip, controls, initialDraft, onAdvanced }: {
  onComplete: (result: OnboardingResult) => Promise<void> | void;
  onSkip: () => Promise<void> | void;
  /** Window controls: the gate is a full screen, and the window is frameless. */
  controls?: ReactNode;
  /** Persisted mid-flow draft, read at boot so the first paint resumes instantly. */
  initialDraft?: OnboardingDraft | null;
  /** Progressive disclosure: jump to the full agent settings (never fakes a connection). */
  onAdvanced?: () => void;
}) {
  const { t, contentLocale } = useI18n();
  const [state, setState] = useState<OnboardingState>(() => initialState(initialDraft ?? null));
  const [brands, setBrands] = useState<Brand[]>([]);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [brandName, setBrandName] = useState('');
  // Optional brand context for a brand created in this walk. Local, never part
  // of the draft: the write goes straight to `brands.context`, the one source.
  const [brandContext, setBrandContext] = useState('');
  const [primary, setPrimary] = useState<PrimaryAgent | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completionFailed, setCompletionFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [login, setLogin] = useState<{ runtime: 'claude' | 'codex'; accountId: string; sessionId: string | null; url: string | null; instructions: string; ended: boolean } | null>(null);
  const [oauth, setOauth] = useState<{ providerId: string; methodIndex: number; start: ProviderOAuthStart } | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [showProviders, setShowProviders] = useState(false);

  useEffect(() => {
    void api.listBrands().then(setBrands).catch((e) => setError(displayError(e)));
    void api.listRoles().then(setRoles).catch(() => setRoles([]));
  }, []);

  // The backend draft is authoritative: on a remount (e.g. returning from
  // Settings) it holds newer state than the boot-time prop, so re-hydrate once.
  useEffect(() => {
    void api.getOnboardingDraft().then((draft) => {
      if (draft) setState(initialState(draft));
    }).catch(() => undefined);
  }, []);

  // Persist on every step transition, so abandoning the walk resumes here.
  const firstRender = useRef(true);
  // A work already created whose landing failed: the retry must land THIS work,
  // never create a second one.
  const pendingResult = useRef<OnboardingResult | null>(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    void api.setOnboardingDraft(toDraft(state)).catch(() => undefined);
  }, [state.step]);

  // Step 4 queries provider state honestly: never pretend a provider is present.
  useEffect(() => {
    if (state.step !== 'connect') return;
    void api.getPrimaryAgent().then(setPrimary).catch(() => setPrimary(null));
    void api.listAgentRuntimes().then(setRuntimes).catch(() => setRuntimes([]));
    void api.listProviders().then(setProviders).catch(() => setProviders([]));
    void api.chatStatus().then(setChatStatus).catch(() => setChatStatus(null));
  }, [state.step]);

  // A terminal login ends when the CLI exits: re-check and finish the connect.
  useEffect(() => {
    if (!login || login.ended || !login.sessionId) return;
    return agentBus.subscribe(login.sessionId, event => {
      if (event.type === 'exit') {
        setLogin(current => (current && current.sessionId === login.sessionId ? { ...current, ended: true } : current));
        void finishRuntimeConnect(login.runtime, login.accountId);
      }
    }, false);
  }, [login?.sessionId]);

  const workType = state.workTypeId ? findWorkType(state.workTypeId) : null;
  const demoBrand = brands.find(isDemoBrand) ?? null;
  const selectedBrand = brands.find((b) => b.id === state.brandId) ?? null;

  const selectWorkType = (w: WorkType) => {
    setError('');
    setState((prev) => ({
      ...prev,
      workTypeId: w.id,
      recommendedRoleId: recommendRole(w),
      assumptions: [],
      step: w.questions.length === 0 ? 'brand' : 'context',
    }));
  };

  const setAnswer = (questionId: string, value: Answer) => {
    setState((prev) => ({ ...prev, answers: { ...prev.answers, [questionId]: value } }));
  };

  const toggleMulti = (questionId: string, value: string) => {
    setState((prev) => {
      const current = prev.answers[questionId];
      const list = Array.isArray(current) ? current : [];
      const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
      return { ...prev, answers: { ...prev.answers, [questionId]: next } };
    });
  };

  const continueFromContext = () => {
    if (!workType) return;
    // Defense in depth: the CTA is disabled while a required question is blank,
    // and the step must never advance in silence if it is reached another way.
    if (missingRequiredQuestions(workType, state.answers).length > 0) return;
    const assumptions = declareAssumptions(workType, state.answers, (k) => t(k));
    setState((prev) => ({
      ...prev,
      assumptions: assumptions.map((text) => ({ text })),
      brief: workType.brief(prev.answers, { locale: contentLocale }),
      step: 'brand',
    }));
  };

  const chooseBrand = (brand: Brand, usedDemo = false) => {
    setError('');
    setBrandContext('');
    setState((prev) => ({ ...prev, brandId: brand.id, usedDemo, step: 'connect' }));
  };

  const createBrand = async () => {
    if (!brandName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const brand = await api.createBrand(brandName.trim());
      setBrands((prev) => [...prev, brand]);
      setBrandName('');
      // Stay on the brand step on purpose: a brand created seconds ago has no
      // context, and the optional field below is where it can arrive before
      // the first agent conversation has to ask for it.
      setState((prev) => ({ ...prev, brandId: brand.id, usedDemo: false }));
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Leaves the brand step for the connect step. The optional context is written
   * only when it has something to say: `saveBrandContext` refuses empty text
   * with CONTEXT_EMPTY, and `expectedFingerprint: null` means "nothing to
   * compare", so a brand created moments ago can never be refused as
   * CONTEXT_STALE.
   */
  const continueFromBrand = async () => {
    const selected = selectedBrand;
    if (!selected || busy) return;
    const goToConnect = () => { setError(''); setNotice(''); setState((prev) => ({ ...prev, step: 'connect' })); };
    const text = brandContext.trim();
    if (!text) { goToConnect(); return; }
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveBrandContext(selected.id, text, null);
      setBrands((prev) => prev.map((b) => (b.id === saved.brand.id ? saved.brand : b)));
      setBrandContext('');
      goToConnect();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  const advance = () => { setError(''); setNotice(''); setState((prev) => ({ ...prev, step: 'prepare' })); };

  /**
   * Connect a subscription runtime (Claude Code / Codex) for real: reuse the
   * existing account + login flow, then make it the primary agent so the
   * recommended team actually works. Honest unavailable states only.
   */
  const connectRuntime = async (runtime: 'claude' | 'codex') => {
    setError(''); setNotice(''); setConnecting(runtime);
    try {
      const info = runtimes.find((r) => r.runtime === runtime);
      if (!info?.installed) {
        setError(t('onboarding.connect.notInstalled', { name: RUNTIME_LABEL[runtime] }));
        return;
      }
      let account = info.accounts.find((a) => a.loggedIn) ?? info.accounts[0] ?? null;
      if (!account) account = await api.addAgentAccount(runtime, RUNTIME_LABEL[runtime]);
      if (!account.loggedIn) {
        const start = await api.startAccountLogin(runtime, account.id);
        setLogin({ runtime, accountId: account.id, sessionId: start.mode === 'terminal' ? start.sessionId : null, url: start.mode === 'browser' ? start.url : null, instructions: start.instructions, ended: false });
        return;
      }
      await api.setPrimaryAgent({ runtime, model: null, accountId: account.id });
      setPrimary(await api.getPrimaryAgent());
      setNotice(t('onboarding.connect.connectedPrimary', { name: RUNTIME_LABEL[runtime] }));
      advance();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setConnecting(null);
    }
  };

  const finishRuntimeConnect = async (runtime: 'claude' | 'codex', accountId: string) => {
    setError(''); setConnecting(runtime);
    try {
      const list = await api.listAgentRuntimes();
      setRuntimes(list);
      const info = list.find((r) => r.runtime === runtime);
      const account = info?.accounts.find((a) => a.id === accountId);
      if (!account?.loggedIn) {
        setError(t('onboarding.connect.stillWaiting'));
        setLogin(null);
        return;
      }
      await api.setPrimaryAgent({ runtime, model: null, accountId });
      setPrimary(await api.getPrimaryAgent());
      setLogin(null);
      setNotice(t('onboarding.connect.connectedPrimary', { name: RUNTIME_LABEL[runtime] }));
      advance();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setConnecting(null);
    }
  };

  /** "Conectar otro proveedor": OAuth-first, never raw API-key jargon up front. */
  const connectProvider = async (provider: ProviderInfo) => {
    setError(''); setNotice(''); setConnecting('provider:' + provider.id);
    try {
      const method = provider.methods.find((m) => m.type === 'oauth');
      if (!method) {
        setError(t('onboarding.connect.noOAuth'));
        return;
      }
      const start = await api.startProviderOAuth(provider.id, method.index, {});
      setOauth({ providerId: provider.id, methodIndex: method.index, start });
      setOauthCode('');
    } catch (e) {
      setError(displayError(e));
    } finally {
      setConnecting(null);
    }
  };

  const completeProvider = async () => {
    if (!oauth) return;
    setError(''); setConnecting('provider:' + oauth.providerId);
    try {
      await api.completeProviderOAuth(oauth.providerId, oauth.methodIndex, oauth.start.method === 'code' ? oauthCode.trim() || null : null);
      setOauth(null);
      await api.setPrimaryAgent({ runtime: 'opencode', model: null, accountId: null });
      setPrimary(await api.getPrimaryAgent());
      setNotice(t('onboarding.connect.providerConnected'));
      advance();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setConnecting(null);
    }
  };

  const startWork = async () => {
    if (busy) return;
    // A previous attempt created the work but could not land it: retry the
    // landing only. Re-running createWork would duplicate the human's work.
    const pending = pendingResult.current;
    if (!pending && (!workType || (!state.brandId && !state.usedDemo))) return;
    setBusy(true);
    setError('');
    try {
      if (pending) {
        await onComplete(pending);
        pendingResult.current = null;
        return;
      }
      const brandId = state.brandId;
      if (!brandId || !workType) return;
      const title = t(workType.titleKey);
      const work = await api.createWork(brandId, title);
      // A save never overwrites silently: on a conflict the disk version wins
      // and the human's text is kept as a revision. The work exists either way,
      // so the walk continues, but the shell is told the brief was not saved.
      const outcome = await api.saveBrief(work.id, `# ${title}\n\n${state.brief}`);
      const briefConflict = outcome.status === 'conflict';
      // Folder linking is optional and honest: the same confirmation the
      // workspace shows comes first, a declined confirm or a cancelled picker
      // means "not linked", and neither ever loses the work just created.
      let folderNotLinked = false;
      if (state.linkFolderRequested && isDesktop) {
        if (confirmFolderLink()) {
          try {
            const result = await api.useFolder(work.id);
            if (!result) folderNotLinked = true;
          } catch (e) {
            setError(displayError(e));
          }
        } else {
          folderNotLinked = true;
        }
      }
      const result: OnboardingResult = { workId: work.id, brandId, recommendedRoleId: state.recommendedRoleId, title, briefConflict, folderNotLinked };
      // Remembered BEFORE the landing: if the shell cannot take over, the retry
      // lands this same work instead of creating a duplicate.
      pendingResult.current = result;
      await onComplete(result);
      pendingResult.current = null;
    } catch (e) {
      // The gate is still mounted, so the failure has to be visible HERE with a
      // way forward; the shell's error state renders off-screen behind the gate.
      setError(displayError(e));
      if (pendingResult.current) setCompletionFailed(true);
    } finally {
      // Whatever happened, the CTA can never be left disabled forever.
      setBusy(false);
    }
  };

  const goBack = () => {
    setError('');
    setNotice('');
    setState((prev) => {
      let step = previousStep(prev);
      // Free-form (no questions) never shows the context step.
      if (step === 'context' && workType && workType.questions.length === 0) step = 'intent';
      return { ...prev, step };
    });
  };

  const stepIndex = STEP_ORDER.indexOf(state.step);
  const canComplete = Boolean(workType) && completeOnboarding(state) && Boolean(state.brandId);
  // A required question left blank is a hard stop: the step names it and the
  // summary explains the disabled CTA, so it is never a silent trap.
  const missingRequired = workType ? missingRequiredQuestions(workType, state.answers) : [];
  const missingRequiredLabels = missingRequired.map((q) => t(q.labelKey)).join(', ');
  // The optional field is for a brand this walk just created: it has no context
  // yet, and this is the only moment the human is already thinking about it.
  const showBrandContext = state.step === 'brand' && Boolean(selectedBrand) && selectedBrand!.context.trim() === '';

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <div className="onboarding-brand"><span className="logo-mark" aria-hidden="true" />Latte<span className="alpha">ALPHA</span></div>
        <div className="onboarding-steps" aria-label={t('onboarding.stepOf', { current: stepIndex + 1, total: STEP_ORDER.length })}>
          {STEP_ORDER.map((step, i) => (
            <span key={step} className={'step' + (i <= stepIndex ? ' active' : '')}>{t(`onboarding.step.${step}` as const)}</span>
          ))}
        </div>
        <button className="onboarding-skip" onClick={() => void onSkip()}>{t('onboarding.skip')}</button>
        {controls}
      </header>

      <main className="onboarding-main">
        <div className="onboarding-content">
          {error && !completionFailed && <div role="alert" className="message error onboarding-message"><span>{error}</span><button aria-label={t('ui.auto.001')} onClick={() => setError('')}><X size={16} /></button></div>}
          {completionFailed && (
            // The work exists; only the landing failed. Say so here, inside the
            // gate, and offer the one action that finishes the walk.
            <div role="alert" className="message error onboarding-message">
              <span>{t('onboarding.completionFailed')}{error ? ` — ${error}` : ''}</span>
              <button className="primary" disabled={busy} onClick={() => void startWork()}>{busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}{t('continue.retry')}</button>
            </div>
          )}
          {notice && <div role="status" className="message onboarding-message"><span>{notice}</span><button aria-label={t('ui.auto.001')} onClick={() => setNotice('')}><X size={16} /></button></div>}

          {state.step === 'intent' && (
            <>
              <h1>{t('onboarding.title')}</h1>
              <p className="intro">{t('onboarding.subtitle')}</p>
              <div className="onboarding-groups">
                {intentGroups.map((group) => (
                  <section className="onboarding-group" key={group.id}>
                    <h2>{t(group.nameKey)}</h2>
                    <div className="onboarding-cards">
                      {workTypesForIntent(group.id).map((w) => (
                        <button className="onboarding-card" key={w.id} onClick={() => selectWorkType(w)}>
                          <strong>{t(w.titleKey)}</strong>
                          <small>{t(w.descriptionKey)}</small>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                <section className="onboarding-group">
                  <h2>{t('onboarding.step.context')}</h2>
                  <div className="onboarding-cards">
                    <button className="onboarding-card" onClick={() => selectWorkType(FREE_FORM_WORK_TYPE)}>
                      <strong>{t(FREE_FORM_WORK_TYPE.titleKey)}</strong>
                      <small>{t(FREE_FORM_WORK_TYPE.descriptionKey)}</small>
                    </button>
                  </div>
                </section>
              </div>
            </>
          )}

          {state.step === 'context' && workType && (
            <>
              <h1>{t(workType.titleKey)}</h1>
              <p className="intro">{t(workType.descriptionKey)}</p>
              {workType.questions.map((q) => (
                <div className="onboarding-question" key={q.id}>
                  <label className="field-label">
                    {t(q.labelKey)}{q.required && <span className="onboarding-required">*</span>}
                  </label>
                  {q.kind === 'text' && (
                    <input value={typeof state.answers[q.id] === 'string' ? state.answers[q.id] as string : ''} onChange={(e) => setAnswer(q.id, e.target.value)} placeholder={t(q.labelKey)} />
                  )}
                  {q.kind === 'single' && (
                    <div className="onboarding-options">
                      {(q.options ?? []).map((o) => (
                        <button key={o.value} className={state.answers[q.id] === o.value ? 'selected-option' : ''} onClick={() => setAnswer(q.id, o.value)}>{t(o.labelKey)}</button>
                      ))}
                    </div>
                  )}
                  {q.kind === 'multi' && (
                    <div className="onboarding-options">
                      {(q.options ?? []).map((o) => {
                        const list = Array.isArray(state.answers[q.id]) ? state.answers[q.id] as string[] : [];
                        return <button key={o.value} className={list.includes(o.value) ? 'selected-option' : ''} onClick={() => toggleMulti(q.id, o.value)}>{t(o.labelKey)}</button>;
                      })}
                    </div>
                  )}
                </div>
              ))}
              {missingRequired.length > 0 && (
                <p className="onboarding-note" role="status">{t('onboarding.requiredMissing', { fields: missingRequiredLabels })}</p>
              )}
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                <button className="primary" disabled={missingRequired.length > 0} onClick={continueFromContext}>{t('onboarding.continue')}<ArrowRight size={15} /></button>
              </div>
            </>
          )}

          {state.step === 'brand' && (
            <>
              <h1>{t('onboarding.brand.title')}</h1>
              <p className="intro">{t('onboarding.brand.folderNote')}</p>
              <div className="onboarding-groups">
                {brands.length > 0 && (
                  <section className="onboarding-group">
                    <h2>{t('onboarding.brand.existing')}</h2>
                    <div className="onboarding-cards">
                      {brands.map((b) => (
                        <button className={'onboarding-card' + (state.brandId === b.id ? ' selected-option' : '')} key={b.id} onClick={() => chooseBrand(b)}>
                          <strong><Folder size={14} />{b.name}</strong>
                          <small>{isDemoBrand(b) ? t('onboarding.brand.demo') : b.context || ''}</small>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <section className="onboarding-group">
                  <h2>{t('onboarding.brand.create')}</h2>
                  <div className="onboarding-footer" style={{ marginTop: 0 }}>
                    <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder={t('onboarding.brand.createName')} style={{ flex: 1 }} />
                    <button className="primary" disabled={!brandName.trim() || busy} onClick={() => void createBrand()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t('onboarding.continue')}</button>
                  </div>
                </section>
                {showBrandContext && (
                  <section className="onboarding-group">
                    <h2>{t('onboarding.brand.context')}</h2>
                    <div className="onboarding-context-field">
                      <label className="field-label" htmlFor="onboarding-brand-context">{t('onboarding.brand.context')}</label>
                      <textarea id="onboarding-brand-context" value={brandContext} onChange={(e) => setBrandContext(e.target.value)} />
                      <small>{t('onboarding.brand.contextNote')}</small>
                    </div>
                  </section>
                )}
                <section className="onboarding-group">
                  <h2>{t('onboarding.brand.demo')}</h2>
                  <div className="onboarding-cards">
                    {demoBrand ? (
                      <button className="onboarding-card" onClick={() => chooseBrand(demoBrand, true)}>
                        <strong><Sparkles size={14} />{demoBrand.name}</strong>
                        <small>{t('onboarding.brand.folderNote')}</small>
                      </button>
                    ) : (
                      <button className="onboarding-card" disabled><strong>{t('onboarding.brand.demo')}</strong><small>{t('onboarding.connect.unavailable')}</small></button>
                    )}
                  </div>
                </section>
                <section className="onboarding-group">
                  <h2>{t('onboarding.brand.linkFolder')}</h2>
                  <button
                    className={'onboarding-card' + (state.linkFolderRequested ? ' selected-option' : '')}
                    onClick={() => setState((prev) => ({ ...prev, linkFolderRequested: !prev.linkFolderRequested }))}
                  >
                    <strong><FolderOpen size={14} />{t('onboarding.brand.linkFolder')}</strong>
                    <small>{state.linkFolderRequested ? t('onboarding.brand.linkFolderOn') : (isDesktop ? t('onboarding.brand.linkFolderNote') : t('onboarding.brand.linkFolderWebNote'))}</small>
                  </button>
                </section>
              </div>
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                <button className="primary" disabled={!selectedBrand || busy} onClick={() => void continueFromBrand()}>{busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}{t('onboarding.continue')}</button>
              </div>
            </>
          )}

          {state.step === 'connect' && (
            <>
              <h1>{t('onboarding.connect.title')}</h1>
              <p className="intro">{runtimes.length === 0 && providers.length === 0 ? t('onboarding.connect.unavailable') : t('onboarding.connect.demoAvailable')}</p>
              <div className="onboarding-groups">
                <section className="onboarding-group">
                  <div className="onboarding-cards">
                    {([
                      { runtime: 'claude' as const, label: t('onboarding.connect.claude') },
                      { runtime: 'codex' as const, label: t('onboarding.connect.codex') },
                    ]).map((option) => {
                      const installed = runtimes.some((r) => r.runtime === option.runtime && r.installed);
                      const loggedIn = runtimes.some((r) => r.runtime === option.runtime && r.accounts.some((a) => a.loggedIn));
                      const busyHere = connecting === option.runtime;
                      return (
                        <button className="onboarding-card" key={option.runtime} disabled={Boolean(connecting)} onClick={() => void connectRuntime(option.runtime)}>
                          <strong>{busyHere ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />}{option.label}</strong>
                          <small>{busyHere ? t('onboarding.connect.connecting', { name: RUNTIME_LABEL[option.runtime] }) : loggedIn ? t('ui.auto.346') : installed ? t('onboarding.connect.primary') : t('onboarding.connect.notInstalled', { name: RUNTIME_LABEL[option.runtime] })}</small>
                        </button>
                      );
                    })}
                    <button className="onboarding-card" disabled={Boolean(connecting)} onClick={() => setShowProviders((v) => !v)}>
                      <strong><Plug size={14} />{t('onboarding.connect.other')}</strong>
                      <small>{providers.length === 0 ? t('onboarding.connect.unavailable') : t('onboarding.connect.otherProvider')}</small>
                    </button>
                    <button className="onboarding-card selected-option" disabled={Boolean(connecting)} onClick={advance}>
                      <strong><Sparkles size={14} />{t('onboarding.connect.demo')}</strong>
                      <small>{t('onboarding.connect.demoAvailable')}</small>
                    </button>
                  </div>
                </section>

                {showProviders && providers.some((p) => !p.connected) && (
                  <section className="onboarding-group">
                    <h2>{t('onboarding.connect.other')}</h2>
                    <div className="onboarding-cards">
                      {providers.filter((p) => !p.connected).map((p) => {
                        const oauthMethod = p.methods.some((m) => m.type === 'oauth');
                        return (
                          <button className="onboarding-card" key={p.id} disabled={Boolean(connecting) || !oauthMethod} onClick={() => void connectProvider(p)}>
                            <strong>{connecting === 'provider:' + p.id ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}{p.name}</strong>
                            <small>{oauthMethod ? t('onboarding.connect.connect') : t('onboarding.connect.noOAuth')}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {login && (
                  <section className="onboarding-group">
                    <h2>{login.ended ? t('onboarding.connect.loginDone') : t('onboarding.connect.connecting', { name: RUNTIME_LABEL[login.runtime] })}</h2>
                    <p className="intro">{login.instructions}</p>
                    {login.url && <p><a href={login.url} target="_blank" rel="noreferrer">{login.url} <ExternalLink size={12} /></a></p>}
                    {!login.ended && login.sessionId && <TerminalPane sessionId={login.sessionId} onError={setError} />}
                    <div className="onboarding-footer">
                      <button className="primary" disabled={Boolean(connecting)} onClick={() => void finishRuntimeConnect(login.runtime, login.accountId)}><Check size={14} />{t('onboarding.connect.loginDone')}</button>
                      <button disabled={Boolean(connecting)} onClick={() => setLogin(null)}>{t('onboarding.back')}</button>
                    </div>
                  </section>
                )}

                {oauth && (
                  <section className="onboarding-group">
                    <h2>{t('onboarding.connect.connecting', { name: providers.find((p) => p.id === oauth.providerId)?.name ?? oauth.providerId })}</h2>
                    <p className="intro">{oauth.start.instructions || t('onboarding.connect.demoAvailable')}</p>
                    {oauth.start.url && <p><a href={oauth.start.url} target="_blank" rel="noreferrer">{t('onboarding.connect.connect')} <ExternalLink size={12} /></a></p>}
                    {oauth.start.method === 'code' && <input aria-label="código" placeholder="Código" value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} />}
                    <div className="onboarding-footer">
                      <button className="primary" disabled={Boolean(connecting) || (oauth.start.method === 'code' && !oauthCode.trim())} onClick={() => void completeProvider()}><Check size={14} />{t('onboarding.connect.loginDone')}</button>
                      <button disabled={Boolean(connecting)} onClick={() => setOauth(null)}>{t('onboarding.back')}</button>
                    </div>
                  </section>
                )}

                <details className="onboarding-details">
                  <summary>{t('onboarding.advanced')}</summary>
                  <p className="runtime-detail">
                    {primary ? t('onboarding.connect.primary') + ' · ' + primary.label : t('onboarding.connect.unavailable')}
                  </p>
                  {chatStatus && <p className="runtime-detail">{chatStatus.detail}</p>}
                  <p className="runtime-detail">{t('onboarding.advancedLead')}</p>
                  {onAdvanced && <button className="subtle" onClick={onAdvanced}><Settings2 size={14} />{t('onboarding.openSettings')}</button>}
                </details>
              </div>
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
              </div>
            </>
          )}

          {state.step === 'prepare' && workType && (
            <>
              <h1>{t('onboarding.summaryTitle')}</h1>
              <p className="intro">{t('onboarding.summaryLead')}</p>
              <div className="onboarding-summary">
                <label className="field-label">{t('onboarding.summary.brief')}</label>
                <textarea value={state.brief} onChange={(e) => setState((prev) => ({ ...prev, brief: e.target.value }))} />
                {state.assumptions.length > 0 && (
                  <ul className="onboarding-assumptions">
                    {state.assumptions.map((a, i) => <li key={i}>{a.text}</li>)}
                  </ul>
                )}
              </div>
              <div className="onboarding-role-row">
                <span className="field-label">{t('onboarding.summary.role')}</span>
                <select value={state.recommendedRoleId} onChange={(e) => setState((prev) => ({ ...prev, recommendedRoleId: e.target.value }))}>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              {missingRequired.length > 0 ? (
                // A disabled CTA with no explanation is a dead end: name the
                // missing required question and offer the way straight back to it.
                <>
                  <p className="onboarding-note" role="alert">{t('onboarding.summary.requiredMissing', { fields: missingRequiredLabels })}</p>
                  <button className="primary" style={{ marginTop: 10 }} onClick={() => setState((prev) => ({ ...prev, step: 'context' }))}>{t('onboarding.requiredMissing.action')}</button>
                </>
              ) : !completeOnboarding(state) && (
                <p className="onboarding-note">{t('onboarding.connect.unavailable')}</p>
              )}
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                <button className="primary" disabled={!canComplete || busy} onClick={() => void startWork()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t('onboarding.startWork')}<ArrowUpRight size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
