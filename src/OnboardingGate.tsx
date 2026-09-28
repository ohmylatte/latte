import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, FolderOpen, Plus, Settings2, Sparkles, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { AgentRole, Brand, ChatRuntimeStatus, OnboardingDraft, PrimaryAgent } from '../shared/contracts';
import { useI18n } from './i18n';
import { roleLabel } from './pack-i18n';
import { api, isDesktop } from './browser-api';
import { ConnectAI } from './ConnectAI';
import { confirmFolderLink } from './folder-link';
import {
  FREE_FORM_WORK_TYPE,
  findWorkType,
  recommendRole,
  type Answer,
  type WorkType,
} from './work-catalog';
import { WorkCatalogBlocks } from './WorkCatalogBlocks';
import {
  brandChoices,
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

export interface OnboardingResult {
  workId: string;
  brandId: string;
  recommendedRoleId: string;
  title: string;
  /**
   * The brief this walk composed (or the human's correction, edited on the
   * summary step) — never the `# Title\n\n` prefixed version `saveBrief`
   * stored. The shell reuses it verbatim as the recommended role's first
   * chat turn, so the same text becomes both the brief document and the
   * opening message: one source, never re-derived.
   */
  brief: string;
  /**
   * The brief kept the disk version because an unseen change was detected. The
   * work exists, but the human's brief text was not saved, and the shell has to
   * say so: the gate unmounts the moment this result lands.
   */
  briefConflict?: boolean;
  /** The folder picker was cancelled or declined: the work exists, nothing was linked. */
  folderNotLinked?: boolean;
  /**
   * The human accepted the folder link and the link itself failed. Distinct
   * from `folderNotLinked`: nothing was declined, something broke. The gate
   * unmounts with this result, so the shell is the only surface left that can
   * say the link failed — without it the rejection vanished on unmount.
   */
  folderLinkError?: string;
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
  const [chatStatus, setChatStatus] = useState<ChatRuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Which in-gate failure the retry belongs to; `null` means there is nothing
   * to retry. A single value instead of one boolean per path: the gate is the
   * only mounted surface, so every failure lands in ONE alert with ONE owner.
   */
  const [retryAction, setRetryAction] = useState<'completion' | 'skip' | null>(null);
  const [notice, setNotice] = useState('');
  /**
   * Progressive disclosure on the summary: the brief is READ as a document by
   * default, because a marketer reads "## Objetivo" as broken code, not as a
   * heading. The plain editor is one click away and writes the same state, so
   * a correction still reaches the created work's brief.
   */
  const [editingBrief, setEditingBrief] = useState(false);
  /**
   * QA1 · B: the brand step's disclosure. `create` shows the name form (a clean
   * install shows it from the start), `others` shows the rest of the person's
   * brands. `justCreated` is the brand this walk created: it stays on the step
   * with its optional context field until "Continuar".
   */
  const [brandPanel, setBrandPanel] = useState<'none' | 'create' | 'others'>('none');
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  useEffect(() => {
    void api.listBrands().then(setBrands).catch((e) => setError(displayError(e)));
    void api.listRoles().then(setRoles).catch(() => setRoles([]));
  }, []);

  // The backend draft is authoritative: on a remount (e.g. returning from
  // Settings) it holds newer state than the boot-time prop, so re-hydrate once.
  // Only while the state is still the one we mounted with: a read that resolves
  // after the human already acted must not rewind their step or answers.
  const mountedState = useRef(state);
  useEffect(() => {
    void api.getOnboardingDraft().then((draft) => {
      if (draft) setState((prev) => (prev === mountedState.current ? initialState(draft) : prev));
    }).catch(() => undefined);
  }, []);

  // Persist on every step transition, so abandoning the walk resumes here.
  const firstRender = useRef(true);
  /**
   * The completion path is idempotent across a retry, and it needs TWO
   * milestones, not one: "a work was created" and "the result is complete".
   * A failure after `createWork` but before the result exists (`saveBrief`
   * rejecting) would otherwise leave nothing to resume from, and the retry
   * would run `createWork` again — a second work for the same brief.
   */
  const createdWork = useRef<{ workId: string; brandId: string; title: string } | null>(null);
  // A work already created whose landing failed: the retry must land THIS work,
  // never create a second one.
  const pendingResult = useRef<OnboardingResult | null>(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    void api.setOnboardingDraft(toDraft(state)).catch(() => undefined);
  }, [state.step]);

  // Step 4 queries provider state honestly: never pretend a provider is present.
  // The runtime cards themselves (ConnectAI) do their own detection; this is
  // only for the "Configuración avanzada" summary line below them.
  useEffect(() => {
    if (state.step !== 'connect') return;
    void api.getPrimaryAgent().then(setPrimary).catch(() => setPrimary(null));
    void api.chatStatus().then(setChatStatus).catch(() => setChatStatus(null));
  }, [state.step]);

  const workType = state.workTypeId ? findWorkType(state.workTypeId) : null;
  const choices = brandChoices(brands, state.usedDemo ? null : state.brandId);
  const demoBrand = choices.demo;
  const selectedBrand = brands.find((b) => b.id === state.brandId) ?? null;
  const justCreated = justCreatedId ? brands.find((b) => b.id === justCreatedId) ?? null : null;
  const cleanInstall = choices.userBrands.length === 0;

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
      setJustCreatedId(brand.id);
      setBrandPanel('none');
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

  const advance = () => { setError(''); setNotice(''); setRetryAction(null); setState((prev) => ({ ...prev, step: 'prepare' })); };

  const startWork = async () => {
    if (busy) return;
    const pending = pendingResult.current;
    const created = createdWork.current;
    // A previous attempt created the work but could not land it: retry from
    // there. Re-running createWork would duplicate the human's work.
    if (!pending && !created && (!workType || (!state.brandId && !state.usedDemo))) return;
    setBusy(true);
    setError('');
    setRetryAction(null);
    try {
      if (pending) {
        // The result is already complete: only the landing is left.
        await onComplete(pending);
        pendingResult.current = null;
        createdWork.current = null;
        return;
      }
      // Resume with what the failed attempt established; only a first attempt
      // reads the walk's state. `title` and `brandId` come from the created
      // work so a resume cannot depend on the step the human is looking at.
      let work = created;
      if (!work) {
        const brandId = state.brandId;
        if (!brandId || !workType) return;
        const title = t(workType.titleKey);
        const createdWorkRecord = await api.createWork(brandId, title);
        work = { workId: createdWorkRecord.id, brandId, title };
        // Remembered the moment it exists, BEFORE anything else can fail.
        createdWork.current = work;
      }
      const { workId, brandId, title } = work;
      // A save never overwrites silently: on a conflict the disk version wins
      // and the human's text is kept as a revision. The work exists either way,
      // so the walk continues, but the shell is told the brief was not saved.
      const outcome = await api.saveBrief(workId, `# ${title}\n\n${state.brief}`);
      const briefConflict = outcome.status === 'conflict';
      // Folder linking is optional and honest: the same confirmation the
      // workspace shows comes first, a declined confirm or a cancelled picker
      // means "not linked", and neither ever loses the work just created.
      let folderNotLinked = false;
      let folderLinkError: string | undefined;
      if (state.linkFolderRequested && isDesktop) {
        if (confirmFolderLink()) {
          try {
            const result = await api.useFolder(workId);
            if (!result) folderNotLinked = true;
          } catch (e) {
            // The human said yes and the link failed. Setting the gate's error
            // here used to be the whole fix, but the gate unmounts right after
            // and the message died with it: the failure travels in the result
            // so the shell can render it.
            folderLinkError = displayError(e);
          }
        } else {
          folderNotLinked = true;
        }
      }
      const result: OnboardingResult = { workId, brandId, recommendedRoleId: state.recommendedRoleId, title, brief: state.brief, briefConflict, folderNotLinked, folderLinkError };
      // Remembered BEFORE the landing: if the shell cannot take over, the retry
      // lands this same work instead of creating a duplicate.
      pendingResult.current = result;
      await onComplete(result);
      pendingResult.current = null;
      createdWork.current = null;
    } catch (e) {
      // The gate is still mounted, so the failure has to be visible HERE with a
      // way forward; the shell's error state renders off-screen behind the gate.
      setError(displayError(e));
      if (createdWork.current) setRetryAction('completion');
    } finally {
      // Whatever happened, the CTA can never be left disabled forever.
      setBusy(false);
    }
  };

  /**
   * "Saltar por ahora" is an async write of its own: it sets the flag the shell
   * reads at boot. If it fails, the shell is STILL off-screen, so the failure
   * is owned here — the same alert and retry the completion path uses — instead
   * of vanishing into the shell's error state, where nobody could see it.
   */
  const skipOnboarding = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setRetryAction(null);
    try {
      await onSkip();
    } catch (e) {
      setError(displayError(e));
      setRetryAction('skip');
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    setError('');
    setNotice('');
    // A failure belongs to the step that produced it: leaving the step clears
    // the alert, so the retry can never land an old result on a new screen.
    // The created work stays in the ref, so a later attempt resumes it.
    setRetryAction(null);
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
  const showBrandContext = state.step === 'brand' && Boolean(justCreated) && justCreated!.id === state.brandId && justCreated!.context.trim() === '';
  const createForm = (
    <form className="onboarding-brand-create" onSubmit={(e) => { e.preventDefault(); void createBrand(); }}>
      <input aria-label={t('onboarding.brand.createName')} value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder={t('onboarding.brand.createName')} autoFocus={!cleanInstall} />
      <button className="primary" disabled={!brandName.trim() || busy}>{busy ? <Loading size={16} /> : <Plus size={15} aria-hidden="true" />}{t('onboarding.brand.createMine')}</button>
    </form>
  );
  const folderToggle = (
    <button
      type="button"
      className="subtle onboarding-folder-toggle"
      aria-pressed={state.linkFolderRequested}
      title={isDesktop ? undefined : t('onboarding.brand.linkFolderWebNote')}
      onClick={() => setState((prev) => ({ ...prev, linkFolderRequested: !prev.linkFolderRequested }))}
    >
      {state.linkFolderRequested ? <Check size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}{t('onboarding.brand.linkFolder')}
    </button>
  );
  const demoLink = demoBrand && (
    <button type="button" className="subtle onboarding-demo-link" onClick={() => chooseBrand(demoBrand, true)}><Sparkles size={14} aria-hidden="true" />{t('onboarding.brand.tourDemo')}</button>
  );

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <div className="onboarding-brand"><span className="logo-mark" aria-hidden="true" />Latte</div>
        <div className="onboarding-steps" aria-label={t('onboarding.stepOf', { current: stepIndex + 1, total: STEP_ORDER.length })}>
          {STEP_ORDER.map((step, i) => (
            <span key={step} className={'step' + (i <= stepIndex ? ' active' : '')}>{t(`onboarding.step.${step}` as const)}</span>
          ))}
        </div>
        <button className="onboarding-skip" disabled={busy} onClick={() => void skipOnboarding()}>{t('onboarding.skip')}</button>
        {controls}
      </header>

      <main className="onboarding-main">
        <div className="onboarding-content">
          {error && !retryAction && <div role="alert" className="message error onboarding-message"><span>{error}</span><button aria-label={t('ui.auto.001')} onClick={() => setError('')}><X size={16} /></button></div>}
          {retryAction && (
            // INVARIANT — no async failure may be routed to state owned by a
            // surface that is not mounted. The gate REPLACES the shell while it
            // is up, so anything the shell renders (its `error` state) is
            // invisible here. Every failure that can happen while the gate is
            // mounted lands in this one alert, with the retry that finishes the
            // action it belongs to.
            <div role="alert" className="message error onboarding-message">
              <span>{t(retryAction === 'skip' ? 'onboarding.skipFailed' : 'onboarding.completionFailed')}{error ? ` — ${error}` : ''}</span>
              <button className="primary" disabled={busy} onClick={() => void (retryAction === 'skip' ? skipOnboarding() : startWork())}>{busy ? <Loading size={16} /> : <ArrowRight size={15} />}{t('continue.retry')}</button>
            </div>
          )}
          {notice && <div role="status" className="message onboarding-message"><span>{notice}</span><button aria-label={t('ui.auto.001')} onClick={() => setNotice('')}><X size={16} /></button></div>}

          {state.step === 'intent' && (
            <>
              <h1>{t('onboarding.title')}</h1>
              <WorkCatalogBlocks onSelect={selectWorkType} disabled={busy} />
              <button type="button" className="subtle catalog-free" title={t(FREE_FORM_WORK_TYPE.descriptionKey)} onClick={() => selectWorkType(FREE_FORM_WORK_TYPE)}>
                {t(FREE_FORM_WORK_TYPE.titleKey)}<ArrowRight size={14} aria-hidden="true" />
              </button>
            </>
          )}

          {state.step === 'context' && workType && (
            <>
              <h1>{t(workType.titleKey)}</h1>
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
              {justCreated ? (
                // A brand this walk just created: confirm it, offer its optional
                // context, and let "Continuar" carry both to the next step.
                <div className="onboarding-brand-created">
                  <strong><Check size={16} aria-hidden="true" />{justCreated.name}</strong>
                  <button type="button" className="subtle" onClick={() => { setJustCreatedId(null); setBrandContext(''); }}>{t('onboarding.brand.change')}</button>
                </div>
              ) : cleanInstall ? (
                // Clean install: the demo is never "an existing brand". Two ways in.
                <div className="onboarding-brand-choices">
                  {createForm}
                  {demoLink}
                </div>
              ) : (
                <div className="onboarding-brand-choices">
                  {choices.primary && (
                    <button type="button" className="primary onboarding-brand-primary" onClick={() => chooseBrand(choices.primary!)}>
                      {t('onboarding.brand.continueWith', { name: choices.primary.name })}<ArrowRight size={15} aria-hidden="true" />
                    </button>
                  )}
                  <div className="onboarding-brand-secondary">
                    {choices.others.length > 0 && (
                      <button type="button" aria-expanded={brandPanel === 'others'} onClick={() => setBrandPanel((v) => (v === 'others' ? 'none' : 'others'))}>
                        {t('onboarding.brand.other')}<ChevronDown size={14} aria-hidden="true" />
                      </button>
                    )}
                    <button type="button" aria-expanded={brandPanel === 'create'} onClick={() => setBrandPanel((v) => (v === 'create' ? 'none' : 'create'))}>
                      <Plus size={14} aria-hidden="true" />{t('onboarding.brand.createAnother')}
                    </button>
                  </div>
                  {brandPanel === 'others' && (
                    <ul className="onboarding-brand-list">
                      {choices.others.map((b) => (
                        <li key={b.id}><button type="button" className="catalog-row" onClick={() => chooseBrand(b)}><span>{b.name}</span></button></li>
                      ))}
                    </ul>
                  )}
                  {brandPanel === 'create' && createForm}
                  {demoLink}
                </div>
              )}
              {showBrandContext && (
                <div className="onboarding-context-field">
                  <label className="field-label" htmlFor="onboarding-brand-context">{t('onboarding.brand.context')}</label>
                  <textarea id="onboarding-brand-context" value={brandContext} onChange={(e) => setBrandContext(e.target.value)} />
                  <small>{t('onboarding.brand.contextNote')}</small>
                </div>
              )}
              {folderToggle}
              {state.linkFolderRequested && <p className="onboarding-note">{isDesktop ? t('onboarding.brand.linkFolderOn') : t('onboarding.brand.linkFolderWebNote')}</p>}
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                {justCreated && <button className="primary" disabled={!selectedBrand || busy} onClick={() => void continueFromBrand()}>{busy ? <Loading size={16} /> : <ArrowRight size={15} />}{t('onboarding.continue')}</button>}
              </div>
            </>
          )}

          {state.step === 'connect' && (
            <>
              <div className="onboarding-connect-head">
                <h1>{t('onboarding.connect.title')}</h1>
                <button className="subtle" disabled={busy} onClick={advance}><Sparkles size={14} aria-hidden="true" />{t('onboarding.connect.demo')}</button>
              </div>
              <ConnectAI showHeader={false} onConnected={advance} onError={setError} />
              <details className="onboarding-details">
                <summary>{t('onboarding.advanced')}</summary>
                <p className="runtime-detail">
                  {primary ? t('onboarding.connect.primary') + ' · ' + primary.label : t('onboarding.connect.unavailable')}
                </p>
                {chatStatus && <p className="runtime-detail">{chatStatus.detail}</p>}
                <p className="runtime-detail">{t('onboarding.advancedLead')}</p>
                {onAdvanced && <button className="subtle" onClick={onAdvanced}><Settings2 size={14} />{t('onboarding.openSettings')}</button>}
              </details>
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
                {/* The same row the role picker uses: label on the left, action on the right. */}
                <div className="onboarding-role-row" style={{ marginTop: 0, marginBottom: 12 }}>
                  <label className="field-label" htmlFor={editingBrief ? 'onboarding-brief' : undefined}>{t('onboarding.summary.brief')}</label>
                  <button className="subtle" onClick={() => setEditingBrief((v) => !v)}>{editingBrief ? t('onboarding.summary.view') : t('onboarding.summary.edit')}</button>
                </div>
                {editingBrief
                  ? <textarea id="onboarding-brief" value={state.brief} onChange={(e) => setState((prev) => ({ ...prev, brief: e.target.value }))} />
                  : <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{state.brief || t('onboarding.summary.empty')}</ReactMarkdown></article>}
                {state.assumptions.length > 0 && (
                  <ul className="onboarding-assumptions">
                    {state.assumptions.map((a, i) => <li key={i}>{a.text}</li>)}
                  </ul>
                )}
              </div>
              <div className="onboarding-role-row">
                <span className="field-label">{t('onboarding.summary.role')}</span>
                <select value={state.recommendedRoleId} onChange={(e) => setState((prev) => ({ ...prev, recommendedRoleId: e.target.value }))}>
                  {roles.map((r) => <option key={r.id} value={r.id}>{roleLabel(r)}</option>)}
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
                  {busy ? <Loading size={16} /> : <Check size={15} />}{t('onboarding.startWork')}<ArrowUpRight size={15} />
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
