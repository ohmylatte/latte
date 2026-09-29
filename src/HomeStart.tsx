import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, RefreshCw, Send, Target, X } from 'lucide-react';
import type { AgentRole, Brand, BrandDnaBuildJob, BrandDnaView } from '../shared/contracts';
import { useI18n } from './i18n';
import { roleLabel } from './pack-i18n';
import { classifyRole, classifyWorkType } from './home-chat';
import { homeIdeas, type HomeIdeaItem, type HomeIdeaText } from './home-ideas';
import { FREE_FORM_WORK_TYPE, findWorkType, recommendRole, type WorkType } from './work-catalog';
import { WORK_ICON } from './WorkCatalogBlocks';
import { Loading } from './brand-marks';
import { type FirstStep, type FirstStepId, firstStepsProgress } from './first-steps';

/**
 * H · Inicio: arriba de la superficie de atención.
 *
 * Una caja tipo chat que convierte lo que la persona quiere en un trabajo real
 * (`onStartWork` crea el trabajo con ese texto como brief y activa el rol que
 * el catálogo recomienda), las IDEAS —del agente cuando las escribió, o de
 * respaldo con fecha, estación y ADN—, y —al costado— la tarjeta Primeros
 * pasos, que se marca sola con datos reales y desaparece cuando los cuatro
 * están.
 *
 * Presentacional como todo Inicio: los datos y la escritura son del contenedor.
 * La clasificación es un problema de datos (`home-chat.ts`), no de modelo. Al
 * tocar una idea la caja queda con su título y el tipo de la idea, que es lo
 * que el envío va a respetar.
 */
export interface HomeStartProps {
  brand: Brand;
  /** La ficha del ADN; `null` todavía no hay, y la caja lo dice en vez de prometer. */
  dna: BrandDnaView | null;
  decisions: number;
  roles: readonly AgentRole[];
  /** `null` cuando el contenedor no arma la tarjeta (cerrada o completa). */
  steps: readonly FirstStep[] | null;
  onSend: (text: string, workTypeId?: string) => void;
  /** "Ver todos los tipos de trabajo": el mismo catálogo de Nuevo trabajo. */
  onOpenCatalog: () => void;
  onTryStep: (id: FirstStepId) => void;
  onCloseSteps: () => void;
  /** Sin esta prop no hay botón de ideas: Inicio queda como siempre. */
  onRefreshIdeas?: () => void;
  /** El build de ideas en vuelo: el estado de carga sale del job, no de una promesa. */
  ideasJob?: BrandDnaBuildJob | null;
  /** `null` = todavía se chequea; `false` = no hay IA y el botón lo dice. `undefined` = no se preguntó. */
  ideasReady?: boolean | null;
}

export function HomeStart(props: HomeStartProps) {
  const { t, locale, contentLocale } = useI18n();
  const [text, setText] = useState('');
  /** El tipo de la idea tocada: manda sobre el de las palabras, hasta que se reescribe. */
  const [forced, setForced] = useState<WorkType | null>(null);
  const brand = props.brand;
  const ideaText: HomeIdeaText = (key, params) => t(key, params);
  const ideas: HomeIdeaItem[] = homeIdeas({
    ideas: props.dna?.ideas ?? [],
    dna: props.dna?.draft ?? null,
    now: new Date(),
    locale: contentLocale,
    uiLocale: locale,
  }, ideaText);
  const workType = forced ?? classifyWorkType(text);
  const roleId = forced ? recommendRole(workType) : classifyRole(text);
  const roleName = roleLabel(props.roles.find((role) => role.id === roleId) ?? { id: roleId, name: roleId });

  const refreshing = Boolean(props.ideasJob && !props.ideasJob.done);
  const canRefresh = Boolean(props.onRefreshIdeas) && !refreshing && props.ideasReady !== false && props.ideasReady !== null;
  const ideasFailed = Boolean(props.ideasJob?.done && props.ideasJob.outcome === 'failed');

  const send = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    const seeded = forced;
    setText('');
    setForced(null);
    if (seeded) props.onSend(body, seeded.id);
    else props.onSend(body);
  };

  const pick = (idea: HomeIdeaItem) => {
    setForced(findWorkType(idea.workTypeId) ?? FREE_FORM_WORK_TYPE);
    setText(idea.title);
  };

  const progress = props.steps ? firstStepsProgress(props.steps) : null;

  return (
    <section className="home-start" aria-label={t('home.ask.title', { brand: brand.name })}>
      <div className="home-start-main">
        <h1 className="home-ask-title">
          {title(t('home.ask.title', { brand: brand.name }), brand.name)}
        </h1>

        <form className="home-ask-box" onSubmit={send}>
          <p className="home-ask-line">
            {props.dna
              ? <span className="home-ask-dna">{t('home.ask.dna', { brand: brand.name, count: props.decisions })}</span>
              : <>
                  <span className="home-ask-dna is-pending">{t('home.ask.dnaPending')}</span>
                  <button type="button" className="subtle" onClick={() => props.onTryStep('dna')}>{t('home.ask.dnaAction')}</button>
                </>}
          </p>
          <textarea
            className="home-ask-input"
            rows={3}
            value={text}
            aria-label={t('home.ask.placeholder')}
            placeholder={t('home.ask.placeholder')}
            onChange={(e) => { setText(e.target.value); setForced(null); }}
          />
          <div className="home-ask-foot">
            <span className="home-ask-classify">
              {text.trim() && (
                <>
                  <span>{t('home.ask.classify', { type: t(workType.titleKey), role: roleName })}</span>
                  <button type="button" className="subtle" onClick={props.onOpenCatalog}>{t('home.ask.allTypes')}</button>
                </>
              )}
            </span>
            <button type="submit" className="home-ask-send" disabled={!text.trim()} aria-label={t('home.ask.send')}>
              <Send size={17} aria-hidden="true" />
            </button>
          </div>
        </form>

        {props.onRefreshIdeas && (
          <div className="home-ideas-head">
            {/* Encabezado de sección discreto: el botón queda chico a su
                derecha, y el motivo sin IA como línea de abajo (y como
                tooltip del botón que no se puede apretar). */}
            <span className="home-ideas-title">{t('home.ideas.title')}</span>
            <button
              type="button"
              className="subtle home-ideas-refresh"
              disabled={!canRefresh}
              title={props.ideasReady === false ? t('home.ideas.needAgent') : undefined}
              onClick={() => props.onRefreshIdeas?.()}
            >
              {refreshing ? <Loading size={14} /> : <RefreshCw size={13} aria-hidden="true" />}
              {refreshing ? t('home.ideas.running') : t('home.ideas.refresh')}
            </button>
            {props.ideasReady === false && <span className="home-ideas-note" role="status">{t('home.ideas.needAgent')}</span>}
            {ideasFailed && (
              <span className="home-ideas-note" role="status">
                {t('home.ideas.failed', { reason: props.ideasJob?.reason ?? '' })}
              </span>
            )}
          </div>
        )}

        <div className="home-suggests home-ideas">
          {ideas.map((idea) => {
            const Icon = WORK_ICON[idea.workTypeId] ?? Target;
            return (
              <button
                key={idea.id}
                type="button"
                className="home-suggest"
                onClick={() => pick(idea)}
              >
                <span className="home-suggest-icon" aria-hidden="true"><Icon size={16} /></span>
                <span className="home-suggest-text">
                  {idea.fromAgent && <em className="home-ideas-tag">{t('home.ideas.tag')}</em>}
                  <strong>{idea.title}</strong>
                  <small>{idea.why}</small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {props.steps && progress && !progress.complete && (
        <aside className="first-steps" aria-label={t('firstSteps.title')}>
          <header className="first-steps-head">
            <h2>{t('firstSteps.title')}</h2>
            <span className="first-steps-count">{t('firstSteps.progress', { done: progress.done, total: progress.total })}</span>
            <button type="button" className="icon-button" aria-label={t('ui.auto.001')} title={t('ui.auto.001')} onClick={props.onCloseSteps}>
              <X size={15} />
            </button>
          </header>
          <div className="first-steps-bar" role="img" aria-label={t('firstSteps.progress', { done: progress.done, total: progress.total })}>
            <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
          <ul className="first-steps-list">
            {props.steps.map((step) => (
              <li key={step.id} className="first-step" data-done={step.done}>
                <span className="first-step-mark" aria-hidden="true">{step.done ? <Check size={13} /> : <i />}</span>
                <span className="first-step-label">{t(step.labelKey)}</span>
                {/* El estado queda para lectores de pantalla: la fila ya se lee
                    con la tilde/círculo y con el "Probalo" que sólo aparece en
                    lo pendiente. */}
                <span className="first-step-state visually-hidden">{step.done ? t('firstSteps.done') : t('firstSteps.pending')}</span>
                {!step.done && (
                  <button type="button" className="subtle first-step-try"
                    aria-label={`${t('firstSteps.try')} · ${t(step.labelKey)}`}
                    onClick={() => props.onTryStep(step.id)}>{t('firstSteps.try')}</button>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

/**
 * La marca en óxido y en serif dentro de la pregunta: la frase se parte por el
 * nombre, que es el único fragmento que lleva otro estilo. Sin truco de
 * posiciones: si el nombre no aparece (un catálogo raro), la frase queda entera.
 */
function title(heading: string, brand: string): ReactNode {
  const parts = heading.split(brand);
  if (parts.length < 2 || !brand) return heading;
  return <>{parts[0]}<em className="home-ask-brand">{brand}</em>{parts.slice(1).join(brand)}</>;
}
