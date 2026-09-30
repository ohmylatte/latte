import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Plus, Settings2, Sparkles, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { Brand, BrandDnaSourcesInput, BrandIdentityFileView, ChatRuntimeStatus, OnboardingDraft, PrimaryAgent, RuntimeStatus } from '../shared/contracts';
import { useI18n } from './i18n';
import { api, isDesktop } from './browser-api';
import { ConnectAI } from './ConnectAI';
import { useBrandDna } from './brand-dna';
import { BrandDnaPanel } from './BrandDnaPanel';
import { BrandDnaSources } from './BrandDnaSources';
import {
  brandChoices,
  initialState,
  previousStep,
  toDraft,
  type GateStep,
  type OnboardingState,
} from './onboarding-flow';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * La barra de pasos del encabezado: LOS TRES PASOS DEL RECORRIDO 2.0.
 *
 * `Inicio` es el aterrizaje, no una pantalla del gate: se enciende en el
 * momento en que el recorrido entrega el control al shell, que es cuando la
 * persona ya está yendo para ahí. Los dos pasos anteriores quedan encendidos,
 * porque fueron completados.
 */
const STEP_LABELS: Array<{ key: GateStep | 'home'; labelKey: 'onboarding.step.connectAi' | 'onboarding.step.bring' | 'onboarding.step.home' }> = [
  { key: 'connect', labelKey: 'onboarding.step.connectAi' },
  { key: 'brand', labelKey: 'onboarding.step.bring' },
  { key: 'home', labelKey: 'onboarding.step.home' },
];

export interface OnboardingResult {
  /**
   * The brand Inicio opens with. Absent when the walk arrived without one:
   * the shell then picks its own (the seeded demo), never a fabricated id.
   *
   * The walk no longer creates a work — the catalog and its questions moved to
   * "Nuevo trabajo" — so there is nothing else to hand over: no brief, no role,
   * no landing to negotiate. Inicio is where the person asks for the first one.
   */
  brandId?: string;
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
  const { t } = useI18n();
  const [state, setState] = useState<OnboardingState>(() => initialState(initialDraft ?? null));
  const [brands, setBrands] = useState<Brand[]>([]);
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
  /**
   * QA1 · B: the brand step's disclosure. `create` shows the name form (a clean
   * install shows it from the start), `others` shows the rest of the person's
   * brands. `justCreated` is the brand this walk created: it stays on the step
   * with its optional context field until "Continuar".
   */
  const [brandPanel, setBrandPanel] = useState<'none' | 'create' | 'others'>('none');
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  /**
   * ADN · dentro de "Traé tu marca" (paso 2 del recorrido).
   *
   * `form` es la pantalla F (fuentes) y `build` la G (pasos del motor a la
   * izquierda, ficha a la derecha). Vive FUERA del estado persistido a
   * propósito: el contrato de pasos (`ONBOARDING_STEPS`) es del backend y no
   * cambia con esto, y un recorrido abandonado vuelve a la pantalla en la que
   * quedó, con la marca que tenía elegida.
   *
   * `null` = sigue la entrada automática: con marca elegida se arma, sin marca
   * y con marcas propias se elige, sin marcas propias se pide el nombre.
   */
  const dna = useBrandDna(state.brandId);
  const [dnaPhase, setDnaPhase] = useState<'brand' | 'build' | null>(null);
  const [dnaName, setDnaName] = useState('');
  const [dnaUrl, setDnaUrl] = useState('');
  const [dnaInstagram, setDnaInstagram] = useState('');
  /** Las fuentes elegidas, para poder "Volver a armar" con lo mismo. */
  const [dnaSources, setDnaSources] = useState<BrandDnaSourcesInput | null>(null);
  const [dnaFiles, setDnaFiles] = useState<BrandIdentityFileView[]>([]);
  /**
   * El recorrido terminó y el shell está tomando el control: la barra enciende
   * "Inicio" durante ese gesto, que es lo único honesto: todavía no se está en
   * Inicio, pero ya no se está en "Traé tu marca".
   */
  const [landing, setLanding] = useState(false);
  /**
   * Detección de runtimes del escritorio. `null` = todavía no se preguntó (o
   * no se pudo preguntar), y en ese caso el gate no afirma nada sobre la IA.
   */
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);

  useEffect(() => {
    void api.listBrands().then(setBrands).catch((e) => setError(displayError(e)));
    void api.runtimeStatus().then(setRuntimes).catch(() => setRuntimes(null));
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
   * The landing path is idempotent across a retry: the result is remembered the
   * moment it exists, BEFORE the shell takes it, so a shell that failed to take
   * over gets the same result again — never a second brand for the same name.
   */
  const pendingResult = useRef<OnboardingResult | null>(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    void api.setOnboardingDraft(toDraft(state)).catch(() => undefined);
  }, [state.step]);

  // Step one queries provider state honestly: never pretend a provider is present.
  // The runtime cards themselves (ConnectAI) do their own detection; this is
  // only for the "Configuración avanzada" summary line below them.
  useEffect(() => {
    if (state.step !== 'connect') return;
    void api.getPrimaryAgent().then(setPrimary).catch(() => setPrimary(null));
    void api.chatStatus().then(setChatStatus).catch(() => setChatStatus(null));
  }, [state.step]);

  const choices = brandChoices(brands, state.usedDemo ? null : state.brandId);
  const demoBrand = choices.demo;
  const selectedBrand = brands.find((b) => b.id === state.brandId) ?? null;
  const justCreated = justCreatedId ? brands.find((b) => b.id === justCreatedId) ?? null : null;
  const cleanInstall = choices.userBrands.length === 0;
  /** Qué pantalla de "Traé tu marca" corresponde, sin estado de más. */
  const entryPhase: 'brand' | 'form' = state.brandId ? 'form' : cleanInstall ? 'form' : 'brand';
  const phase: 'brand' | 'form' | 'build' = dnaPhase === 'build' ? 'build' : dnaPhase === 'brand' ? 'brand' : entryPhase;
  /**
   * SIN IA CONECTADA no se puede componer. Sólo el escritorio lo afirma: él
   * corrió la detección y ninguno de sus runtimes está disponible. La vista
   * previa no detecta nada ("Requiere escritorio"), así que no afirma nada.
   */
  const composeBlocked = isDesktop && Boolean(runtimes && runtimes.length > 0 && !runtimes.some((r) => r.available));

  // Los archivos de identidad sólo interesan en la pantalla F, y sólo cuando
  // ya hay marca: sin marca no hay dónde guardarlos.
  useEffect(() => {
    setDnaFiles([]);
    if (phase !== 'form' || !state.brandId) return;
    let live = true;
    void api.readBrandIdentity(state.brandId).then((view) => { if (live) setDnaFiles(view.files); }).catch(() => undefined);
    return () => { live = false; };
  }, [phase, state.brandId]);

  /**
   * AL RETOMAR UNA MARCA: la web y los canales del último armado vuelven a la
   * pantalla, porque el formulario sólo vive en memoria y se pierde al cerrar.
   * Cada campo se llena SÓLO si sigue vacío: lo que la persona ya escribió no
   * se pisa, y una marca sin `lastSources` no precarga nada.
   */
  const seededBrand = useRef<string | null>(null);
  useEffect(() => {
    const brandId = state.brandId;
    const view = dna.dna;
    if (!brandId || !view || view.brandId !== brandId || seededBrand.current === brandId) return;
    const last = view.lastSources;
    if (!last) return;
    seededBrand.current = brandId;
    setDnaUrl((previous) => (previous.trim() ? previous : last.url ?? ''));
    setDnaInstagram((previous) => (previous.trim() ? previous : last.channels.join('\n')));
  }, [state.brandId, dna.dna, dnaUrl, dnaInstagram]);

  /** Paso 1 → paso 2: el enlace propio del paso, sin conectar nada. */
  const advance = () => { setError(''); setRetryAction(null); setDnaPhase(null); setState((prev) => ({ ...prev, step: 'brand' })); };

  const chooseBrand = (brand: Brand, usedDemo = false) => {
    setError('');
    setBrandContext('');
    // La entrada automática pasa a ser la pantalla de fuentes: elegir la marca
    // ES avanzar dentro del paso.
    setDnaPhase(null);
    setState((prev) => ({ ...prev, brandId: brand.id, usedDemo }));
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
      // Stay on the brand screen on purpose: a brand created seconds ago has no
      // context, and the optional field below is where it can arrive before
      // the first agent conversation has to ask for it.
      setState((prev) => ({ ...prev, brandId: brand.id, usedDemo: false }));
      setDnaPhase('brand');
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Leaves the brand screen for the sources screen. The optional context is
   * written only when it has something to say: `saveBrandContext` refuses empty
   * text with CONTEXT_EMPTY, and `expectedFingerprint: null` means "nothing to
   * compare", so a brand created moments ago can never be refused as
   * CONTEXT_STALE.
   */
  const continueFromBrand = async () => {
    const selected = selectedBrand;
    if (!selected || busy) return;
    const goToSources = () => { setError(''); setDnaPhase(null); };
    const text = brandContext.trim();
    if (!text) { goToSources(); return; }
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveBrandContext(selected.id, text, null);
      setBrands((prev) => prev.map((b) => (b.id === saved.brand.id ? saved.brand : b)));
      setBrandContext('');
      goToSources();
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * INICIO · el recorrido termina acá, sin trabajo creado y sin brief que
   * revisar: el catálogo vive en "Nuevo trabajo", y la caja de Inicio pide el
   * primero. El resultado se recuerda ANTES de dárselo al shell, para que un
   * reintento aterrice el mismo resultado.
   */
  const landHome = async (brandId: string | null | undefined) => {
    const result: OnboardingResult = { brandId: brandId ?? undefined };
    pendingResult.current = result;
    setLanding(true);
    try {
      await onComplete(result);
      pendingResult.current = null;
    } catch (e) {
      // El aterrizaje falló con el gate montado: el alerta y el reintento de
      // siempre, apuntando a ESTE resultado (que no vuelve a crear nada).
      setError(displayError(e));
      setRetryAction('completion');
    } finally {
      setLanding(false);
    }
  };

  /**
   * "Empezar sin marca": aterriza en Inicio sin ADN. Si la persona escribió un
   * nombre en esta pantalla, la marca se crea con ese nombre — es la suya, no
   * un marcador de posición.
   */
  const startWithoutBrand = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setRetryAction(null);
    try {
      let brandId = state.brandId;
      if (!brandId) {
        const name = dnaName.trim();
        if (name) {
          const brand = await api.createBrand(name);
          setBrands((prev) => [...prev, brand]);
          setDnaName('');
          brandId = brand.id;
          setState((prev) => ({ ...prev, brandId: brand.id, usedDemo: false }));
        }
      }
      await landHome(brandId);
    } catch (e) {
      // La marca no llegó a crearse: el aviso es del gesto, y el CTA sigue
      // vivo para que la persona lo vuelva a intentar.
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /** "Seguir con el demo" desde la pared sin IA: misma marca demo, sin ADN. */
  const continueWithDemo = async () => {
    if (!demoBrand || busy) return;
    setError('');
    setRetryAction(null);
    setBusy(true);
    try {
      setState((prev) => ({ ...prev, brandId: demoBrand.id, usedDemo: true }));
      await landHome(demoBrand.id);
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Armar mi marca": crea la marca si todavía no existe y arranca el motor
   * con las tres fuentes. La pantalla G toma el relevo y mira el job.
   */
  const startBuild = async (sources: BrandDnaSourcesInput) => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      let brandId = state.brandId;
      if (!brandId) {
        const name = dnaName.trim();
        if (!name) return;
        const brand = await api.createBrand(name);
        setBrands((prev) => [...prev, brand]);
        setDnaName('');
        brandId = brand.id;
        setState((prev) => ({ ...prev, brandId: brand.id, usedDemo: false }));
      }
      setDnaSources(sources);
      const outcome = await dna.build('sources', sources, brandId);
      if (!outcome.ok) { setError(outcome.error); return; }
      setDnaPhase('build');
    } catch (e) {
      setError(displayError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Aprobar ADN" cierra el recorrido y aterriza en Inicio. No se creó ningún
   * trabajo: el primero lo pide la persona desde la caja de ahí, y "Pedí tu
   * primer trabajo" sigue estando adelante.
   */
  const approveDna = async () => {
    if (busy) return;
    setError('');
    setRetryAction(null);
    setBusy(true);
    try {
      const outcome = await dna.approve();
      // Falló el motor: el mensaje quedó en la ficha, que sigue en pantalla.
      if (!outcome.ok) return;
      await landHome(outcome.value.brandId);
    } catch (e) {
      setError(displayError(e));
      setRetryAction('completion');
    } finally {
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

  /** El reintento del alerta: termina el mismo gesto que falló. */
  const retryCompletion = async () => {
    const pending = pendingResult.current;
    if (busy) return;
    setBusy(true);
    setError('');
    setRetryAction(null);
    try {
      if (pending) {
        await onComplete(pending);
        pendingResult.current = null;
      } else {
        // No hubo resultado que reanudar (fallo antes de armarlo): se repite el
        // gesto de aterrizar con lo que el paso tiene ahora.
        await landHome(state.brandId);
      }
    } catch (e) {
      setError(displayError(e));
      setRetryAction('completion');
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    setError('');
    // A failure belongs to the step that produced it: leaving the step clears
    // the alert, so the retry can never land an old result on a new screen.
    setRetryAction(null);
    setDnaPhase(null);
    setState((prev) => ({ ...prev, step: previousStep(prev) }));
  };

  /** La barra: los dos pasos del recorrido, y "Inicio" mientras se aterriza. */
  const activeStep = landing ? STEP_LABELS.length - 1 : state.step === 'brand' ? 1 : 0;
  const showBrandContext = Boolean(justCreated) && justCreated!.id === state.brandId && justCreated!.context.trim() === '';
  const createForm = (
    <form className="onboarding-brand-create" onSubmit={(e) => { e.preventDefault(); void createBrand(); }}>
      <input aria-label={t('onboarding.brand.createName')} value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder={t('onboarding.brand.createName')} autoFocus={!cleanInstall} />
      <button className="primary" disabled={!brandName.trim() || busy}>{busy ? <Loading size={16} /> : <Plus size={15} aria-hidden="true" />}{t('onboarding.brand.createMine')}</button>
    </form>
  );
  const demoLink = demoBrand && (
    <button type="button" className="subtle onboarding-demo-link" onClick={() => chooseBrand(demoBrand, true)}><Sparkles size={14} aria-hidden="true" />{t('onboarding.brand.tourDemo')}</button>
  );

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <div className="onboarding-brand"><span className="logo-mark" aria-hidden="true" />Latte</div>
        <div className="onboarding-steps" aria-label={t('onboarding.stepOf', { current: activeStep + 1, total: STEP_LABELS.length })}>
          {STEP_LABELS.map((step, i) => (
            <span key={step.key} className={'step' + (i <= activeStep ? ' active' : '')}>{t(step.labelKey)}</span>
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
              <button className="primary" disabled={busy} onClick={() => void (retryAction === 'skip' ? skipOnboarding() : retryCompletion())}>{busy ? <Loading size={16} /> : <ArrowRight size={15} />}{t('continue.retry')}</button>
            </div>
          )}

          {/* PASO 1 · CONECTÁ TU IA. El catálogo ya no vive acá: se usa cuando
              se crea un trabajo, desde Inicio o "Nuevo trabajo". */}
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
            </>
          )}

          {/* PASO 2 · TRAE TU MARCA, sin IA conectada en el escritorio: el
              motor no puede componer, y las tres salidas que sí existen quedan
              a la vista. El ADN se arma después, desde Marca → ADN. */}
          {state.step === 'brand' && phase === 'form' && composeBlocked && (
            <section className="onboarding-ai-wall" aria-label={t('dna.sources.title')}>
              <h1>{t('dna.sources.title')}</h1>
              <p className="intro">{t('onboarding.compose.needAi')}</p>
              <div className="onboarding-brand-choices">
                <button type="button" className="primary onboarding-brand-primary" onClick={goBack}>
                  {t('onboarding.compose.connect')}<ArrowRight size={15} aria-hidden="true" />
                </button>
                <div className="onboarding-brand-secondary">
                  {demoBrand && state.brandId !== demoBrand.id && (
                    <button type="button" className="subtle" disabled={busy} onClick={() => void continueWithDemo()}>
                      <Sparkles size={14} aria-hidden="true" />{t('onboarding.brand.tourDemo')}
                    </button>
                  )}
                  <button type="button" className="subtle" disabled={busy} onClick={() => void startWithoutBrand()}>
                    {t('dna.sources.skip')}
                  </button>
                </div>
              </div>
              <div className="onboarding-footer">
                <button type="button" onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
              </div>
            </section>
          )}

          {/* PASO 2 · elegir la marca. Es la parte del recorrido que antes era
              un paso aparte ("Marca y fuentes"): acá es una opción DENTRO de
              "Traé tu marca", y una instalación sin marcas propias ni siquiera
              la necesita — el nombre se pide en la pantalla de fuentes. */}
          {state.step === 'brand' && phase === 'brand' && (
            <>
              <h1>{t('onboarding.brand.title')}</h1>
              {justCreated ? (
                // A brand this walk just created: confirm it, offer its optional
                // context, and let "Continuar" carry both to the next screen.
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
              <div className="onboarding-footer">
                <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                {justCreated && <button className="primary" disabled={!selectedBrand || busy} onClick={() => void continueFromBrand()}>{busy ? <Loading size={16} /> : <ArrowRight size={15} />}{t('onboarding.continue')}</button>}
              </div>
            </>
          )}

          {/* F · TRAE TU MARCA: las tres fuentes. "Empezar sin marca" y el demo
              siguen siendo salidas discretas, y el CTA de armado se ofrece con
              lo que la pantalla pidió (nombre y fuentes). */}
          {state.step === 'brand' && phase === 'form' && !composeBlocked && (
            <BrandDnaSources
              brandName={selectedBrand?.name ?? null}
              url={dnaUrl}
              onUrl={setDnaUrl}
              instagram={dnaInstagram}
              onInstagram={setDnaInstagram}
              name={dnaName}
              onName={setDnaName}
              files={dnaFiles}
              busy={busy}
              onAddFiles={isDesktop && state.brandId
                ? () => { void api.addBrandIdentityFiles(state.brandId!).then((view) => setDnaFiles(view.files)).catch((e) => setError(displayError(e))); }
                : undefined}
              onRemoveFile={isDesktop && state.brandId
                ? (fileId) => { void api.removeBrandIdentityFile(state.brandId!, fileId).then((view) => setDnaFiles(view.files)).catch((e) => setError(displayError(e))); }
                : undefined}
              onBuild={(sources) => void startBuild(sources)}
              onSkip={() => void startWithoutBrand()}
              onDemo={demoBrand && state.brandId !== demoBrand.id ? () => chooseBrand(demoBrand, true) : undefined}
              onBack={goBack}
              footerEnd={state.brandId && (choices.userBrands.length > 0 || Boolean(demoBrand)) ? (
                <button type="button" className="subtle" disabled={busy} onClick={() => setDnaPhase('brand')}>{t('onboarding.brand.switch')}</button>
              ) : undefined}
            />
          )}

          {/* G · EL ADN DE TU MARCA: los pasos reales del build a la izquierda,
              la ficha a la derecha. "Aprobar ADN" cierra el recorrido. */}
          {state.step === 'brand' && phase === 'build' && (
            <div className="onboarding-dna">
              <h1>{t('dna.build.title')}</h1>
              <BrandDnaPanel
                brandName={selectedBrand?.name ?? ''}
                job={dna.job}
                dna={dna.dna}
                busy={dna.busy || busy}
                error={dna.error}
                stale={dna.stale}
                onApprove={() => void approveDna()}
                onCorrect={() => { setError(''); setDnaPhase(null); }}
                onEdit={(field, value) => void dna.edit(field, value)}
                onRetry={() => void dna.retry()}
                onCancel={() => void dna.cancel()}
              />
              <div className="onboarding-footer">
                <button type="button" disabled={busy} onClick={() => { setError(''); setDnaPhase(null); }}><ArrowLeft size={15} />{t('onboarding.back')}</button>
                <span className="spacer" />
                {dna.job?.done && dna.job.outcome !== 'proposed' && (
                  <button type="button" className="primary" disabled={dna.busy || busy} onClick={() => void dna.build('sources', dnaSources)}>
                    {t('dna.build.again')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
