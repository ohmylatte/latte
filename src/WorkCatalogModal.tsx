import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Plus, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { AgentRole, Brand, BrandDnaView, Work } from '../shared/contracts';
import { useI18n } from './i18n';
import { api } from './browser-api';
import {
  FREE_FORM_WORK_TYPE,
  dnaPrefillFor,
  findWorkType,
  isAnswered,
  recommendRole,
  type Answer,
  type OnboardingQuestion,
  type WorkType,
} from './work-catalog';
import { WorkCatalogBlocks } from './WorkCatalogBlocks';
import { declareAssumptions, missingRequiredQuestions } from './onboarding-flow';
import { roleLabel } from './pack-i18n';
import { useModalA11y } from './useModalA11y';

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * ENTREGA 1A (Brief 01, tarea 3): "NUEVO TRABAJO" USA EL MISMO CATÁLOGO.
 *
 * El modal reutiliza EXACTAMENTE la misma capa de datos y de estado que el
 * recorrido inicial — `work-catalog.ts` (intención → tipo de trabajo →
 * preguntas → brief) y `onboarding-flow.ts` (`declareAssumptions`,
 * `missingRequiredQuestions`) — nunca una segunda copia de esas decisiones.
 * QA1: la grilla de inicio TAMBIÉN es la misma — `WorkCatalogBlocks`, los
 * cuatro bloques del embudo —, así que el catálogo se ve igual en los dos.
 * Lo que NO reutiliza es la cromía de `OnboardingGate.tsx`: esa pantalla
 * REEMPLAZA el shell entero (controles de ventana, paso "conectar la IA",
 * persistencia de borrador entre reinicios) porque puede abandonarse y
 * retomarse a través de un reinicio de la app; este modal se abre SOBRE un
 * shell ya vivo, con la marca ya elegida y la IA ya conectada (o no — ver
 * Task 1), así que ninguna de esas dos cosas hace falta acá. Tocar
 * `OnboardingGate.tsx` para compartir JSX habría arriesgado sus 26 tests por
 * un ahorro de líneas que no vale la pena.
 *
 * "Empezar libremente" es la excepción a propósito (Brief 01: "Keep 'Empezar
 * libremente' = title-only fast path"): no entra al catálogo en absoluto,
 * hace exactamente lo que el modal viejo de título-solo hacía.
 */
export interface WorkCatalogCreated {
  /** `null` para "Empezar libremente": ni rol ni mensaje automático, el camino de siempre. */
  recommendedRoleId: string | null;
  brief: string;
}

export function WorkCatalogModal({ brand, roles, busy, onClose, onCreated, onError }: {
  brand: Brand;
  roles: AgentRole[];
  busy: boolean;
  onClose: () => void;
  onCreated: (work: Work, options: WorkCatalogCreated) => void;
  onError: (message: string) => void;
}) {
  const { t, contentLocale } = useI18n();
  const [step, setStep] = useState<'intent' | 'context' | 'prepare' | 'freeform'>('intent');
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [assumptions, setAssumptions] = useState<{ text: string }[]>([]);
  const [brief, setBrief] = useState('');
  const [recommendedRoleId, setRecommendedRoleId] = useState('assistant');
  const [editingBrief, setEditingBrief] = useState(false);
  const [freeformTitle, setFreeformTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  /**
   * Onboarding 2.0 · la ficha de la marca, leída una vez al abrir. La versión
   * aprobada manda (es la que viaja a los trabajos) y el borrador es el
   * respaldo de una marca cuyo ADN todavía no se aprobó: ver `dnaPrefillFor`.
   */
  const [dna, setDna] = useState<BrandDnaView | null>(null);
  /** Las respuestas del ADN que la persona tocó: dejan de ser "del ADN". */
  const [dnaEdited, setDnaEdited] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void api.readBrandDna(brand.id)
      .then((view) => { if (live) setDna(view); })
      .catch(() => { if (live) setDna(null); });
    return () => { live = false; };
  }, [brand.id]);

  const workType = workTypeId ? findWorkType(workTypeId) : null;
  /** Lo que el ADN ya contesta para ESTE tipo, y en qué pregunta. */
  const prefill = workType ? dnaPrefillFor(dna, workType) : { answers: {}, questionIds: [] };
  /** Lo que sigue siendo de la persona: se pregunta como siempre. */
  const askedQuestions: OnboardingQuestion[] = workType
    ? workType.questions.filter((q) => !prefill.questionIds.includes(q.id))
    : [];
  const dnaQuestions: OnboardingQuestion[] = workType
    ? workType.questions.filter((q) => prefill.questionIds.includes(q.id))
    : [];
  /**
   * Lo que se muestra y con lo que se calcula todo: lo que escribió la persona
   * y, para lo que no tocó, lo del ADN. Se mezcla al pintar —no en un efecto—
   * para que el valor del ADN esté en el PRIMER render: sin eso la pantalla
   * se ve un instante con las preguntas del ADN vacías.
   *
   * Un valor tocado por la persona (`dnaEdited`) o ya escrito nunca se pisa.
   */
  const effectiveAnswers: Record<string, Answer> = (() => {
    if (prefill.questionIds.length === 0) return answers;
    const merged = { ...answers };
    for (const id of prefill.questionIds) {
      if (dnaEdited.includes(id) || isAnswered(merged[id])) continue;
      merged[id] = prefill.answers[id];
    }
    return merged;
  })();
  const missingRequired = workType ? missingRequiredQuestions(workType, effectiveAnswers) : [];
  const missingRequiredLabels = missingRequired.map((q) => t(q.labelKey)).join(', ');

  const dialogRef = useModalA11y<HTMLElement>(true, () => { if (!busy && !creating) onClose(); }, busy || creating);

  const selectWorkType = (w: WorkType) => {
    setError('');
    setWorkTypeId(w.id);
    setRecommendedRoleId(recommendRole(w));
    setAssumptions([]);
    setDnaEdited([]);
    setStep(w.questions.length === 0 ? 'prepare' : 'context');
    if (w.questions.length === 0) setBrief(w.brief({}, { locale: contentLocale }));
  };

  const setAnswer = (questionId: string, value: Answer) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    // Tocar el valor lo vuelve de la persona: la fuente deja de nombrarlo.
    if (prefill.questionIds.includes(questionId)) {
      setDnaEdited((prev) => (prev.includes(questionId) ? prev : [...prev, questionId]));
    }
  };
  const toggleMulti = (questionId: string, value: string) => {
    setAnswers((prev) => {
      const current = prev[questionId];
      const list = Array.isArray(current) ? current : [];
      return { ...prev, [questionId]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
    });
    if (prefill.questionIds.includes(questionId)) {
      setDnaEdited((prev) => (prev.includes(questionId) ? prev : [...prev, questionId]));
    }
  };

  const continueFromContext = () => {
    if (!workType || missingRequiredQuestions(workType, effectiveAnswers).length > 0) return;
    setAssumptions(declareAssumptions(workType, effectiveAnswers, (k) => t(k)).map((text) => ({ text })));
    setBrief(workType.brief(effectiveAnswers, { locale: contentLocale }));
    setStep('prepare');
  };

  const create = async () => {
    if (!workType || busy || creating) return;
    if (missingRequiredQuestions(workType, effectiveAnswers).length > 0) return;
    setCreating(true);
    setError('');
    try {
      const title = t(workType.titleKey);
      const created = await api.createWork(brand.id, title);
      const outcome = await api.saveBrief(created.id, `# ${title}\n\n${brief}`);
      if (outcome.status === 'conflict') onError(t('onboarding.briefConflict'));
      onCreated(outcome.status === 'saved' ? outcome.work : created, { recommendedRoleId, brief });
    } catch (e) {
      setError(displayError(e));
    } finally {
      setCreating(false);
    }
  };

  const createFreeform = async () => {
    if (!freeformTitle.trim() || busy || creating) return;
    setCreating(true);
    setError('');
    try {
      const created = await api.createWork(brand.id, freeformTitle.trim());
      onCreated(created, { recommendedRoleId: null, brief: '' });
    } catch (e) {
      setError(displayError(e));
    } finally {
      setCreating(false);
    }
  };

  const goBack = () => {
    setError('');
    if (step === 'prepare' && workType && workType.questions.length > 0) { setStep('context'); return; }
    setStep('intent');
  };

  /** El control de una pregunta: texto, opción única o varias. El mismo para
   * las que se preguntan y para las que el ADN ya contestó. */
  const renderQuestion = (q: OnboardingQuestion, fromDna = false) => (
    <div className="onboarding-question" key={q.id}>
      <label className="field-label">
        {t(q.labelKey)}{q.required && <span className="onboarding-required">*</span>}
        {/* La fuente sólo mientras el valor siga siendo el del ADN. */}
        {fromDna && !dnaEdited.includes(q.id) && <small className="onboarding-dna-source">{t('work.dnaPrefill.source')}</small>}
      </label>
      {q.kind === 'text' && <input value={typeof effectiveAnswers[q.id] === 'string' ? effectiveAnswers[q.id] as string : ''} onChange={(e) => setAnswer(q.id, e.target.value)} placeholder={t(q.labelKey)} />}
      {q.kind === 'single' && <div className="onboarding-options">
        {(q.options ?? []).map((o) => <button key={o.value} className={effectiveAnswers[q.id] === o.value ? 'selected-option' : ''} onClick={() => setAnswer(q.id, o.value)}>{t(o.labelKey)}</button>)}
      </div>}
      {q.kind === 'multi' && <div className="onboarding-options">
        {(q.options ?? []).map((o) => { const list = Array.isArray(effectiveAnswers[q.id]) ? effectiveAnswers[q.id] as string[] : []; return <button key={o.value} className={list.includes(o.value) ? 'selected-option' : ''} onClick={() => toggleMulti(q.id, o.value)}>{t(o.labelKey)}</button>; })}
      </div>}
    </div>
  );

  return <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy && !creating) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="work-catalog-title" className="modal roomy work-catalog-modal">
      <div className="modal-head">
        {/* El eyebrow es "Nuevo trabajo" — el concepto que abrió este modal —,
            nunca el genérico prestado del modal viejo de sólo título. */}
        <div><div className="document-kicker">{t('ui.auto.038')}</div><h2 id="work-catalog-title">{t('onboarding.title')}</h2></div>
        <div className="work-catalog-head-actions">
          {/* "Empezar libremente" en el encabezado, no al final de la grilla:
              QA encontró que había que bajar toda la lista de intenciones para
              llegar a este camino rápido. Acá queda a la vista sin scrollear,
              en cualquier paso del catálogo. */}
          {step === 'intent' && <button type="button" className="subtle catalog-free" title={t(FREE_FORM_WORK_TYPE.descriptionKey)} disabled={creating} onClick={() => setStep('freeform')}>{t(FREE_FORM_WORK_TYPE.titleKey)}</button>}
          <button className="modal-close" aria-label={t('ui.auto.001')} disabled={creating} onClick={onClose}><X size={20} /></button>
        </div>
      </div>
      <div className="modal-body">
        {error && <div role="alert" className="message error onboarding-message"><span>{error}</span><button aria-label={t('ui.auto.001')} onClick={() => setError('')}><X size={16} /></button></div>}

        {step === 'intent' && <WorkCatalogBlocks onSelect={selectWorkType} disabled={creating} />}

        {step === 'freeform' && <>
          <h1>{t(FREE_FORM_WORK_TYPE.titleKey)}</h1>
          <form onSubmit={(e) => { e.preventDefault(); void createFreeform(); }}>
            <label className="field-label" htmlFor="work-catalog-freeform-title">{t('ui.auto.080')}</label>
            <input id="work-catalog-freeform-title" autoFocus maxLength={120} value={freeformTitle} onChange={(e) => setFreeformTitle(e.target.value)} placeholder={t('ui.auto.081')} />
            <div className="onboarding-footer">
              <button type="button" onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
              <span className="spacer" />
              <button className="primary" disabled={!freeformTitle.trim() || creating}>{creating ? <Loading size={16} /> : <Plus size={15} />}{t('ui.auto.038')}</button>
            </div>
          </form>
        </>}

        {step === 'context' && workType && <>
          <h1>{t(workType.titleKey)}</h1>
          {/* Onboarding 2.0: lo que el ADN ya sabe viene colapsado, con su
              fuente, y sólo lo que sigue vacío se le pregunta a la persona. */}
          {dnaQuestions.length > 0 && (
            <details className="onboarding-dna-prefill">
              <summary>{t('work.dnaPrefill.summary')}</summary>
              {dnaQuestions.map((q) => renderQuestion(q, true))}
            </details>
          )}
          {askedQuestions.map((q) => renderQuestion(q))}
          {missingRequired.length > 0 && <p className="onboarding-note" role="status">{t('onboarding.requiredMissing', { fields: missingRequiredLabels })}</p>}
          <div className="onboarding-footer">
            <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
            <span className="spacer" />
            <button className="primary" disabled={missingRequired.length > 0} onClick={continueFromContext}>{t('onboarding.continue')}<ArrowRight size={15} /></button>
          </div>
        </>}

        {step === 'prepare' && workType && <>
          <h1>{t('onboarding.summaryTitle')}</h1>
          <p className="intro">{t('onboarding.summaryLead')}</p>
          <div className="onboarding-summary">
            <div className="onboarding-role-row" style={{ marginTop: 0, marginBottom: 12 }}>
              <label className="field-label" htmlFor={editingBrief ? 'work-catalog-brief' : undefined}>{t('onboarding.summary.brief')}</label>
              <button className="subtle" onClick={() => setEditingBrief((v) => !v)}>{editingBrief ? t('onboarding.summary.view') : t('onboarding.summary.edit')}</button>
            </div>
            {editingBrief
              ? <textarea id="work-catalog-brief" value={brief} onChange={(e) => setBrief(e.target.value)} />
              : <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{brief || t('onboarding.summary.empty')}</ReactMarkdown></article>}
            {assumptions.length > 0 && <ul className="onboarding-assumptions">{assumptions.map((a, i) => <li key={i}>{a.text}</li>)}</ul>}
          </div>
          <div className="onboarding-role-row">
            <span className="field-label">{t('onboarding.summary.role')}</span>
            <select value={recommendedRoleId} onChange={(e) => setRecommendedRoleId(e.target.value)}>
              {roles.map((r) => <option key={r.id} value={r.id}>{roleLabel(r)}</option>)}
            </select>
          </div>
          {missingRequired.length > 0 && <>
            <p className="onboarding-note" role="alert">{t('onboarding.summary.requiredMissing', { fields: missingRequiredLabels })}</p>
            <button className="primary" style={{ marginTop: 10 }} onClick={() => setStep('context')}>{t('onboarding.requiredMissing.action')}</button>
          </>}
          <div className="onboarding-footer">
            <button onClick={goBack}><ArrowLeft size={15} />{t('onboarding.back')}</button>
            <span className="spacer" />
            <button className="primary" disabled={missingRequired.length > 0 || creating} onClick={() => void create()}>
              {creating ? <Loading size={16} /> : <Check size={15} />}{t('onboarding.startWork')}<ArrowUpRight size={15} />
            </button>
          </div>
        </>}
      </div>
    </section>
  </div>;
}
