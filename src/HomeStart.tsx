import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, PenLine, Send, Target, TrendingUp, X, CalendarDays } from 'lucide-react';
import type { AgentRole, Brand, BrandDnaView } from '../shared/contracts';
import { useI18n } from './i18n';
import { roleLabel } from './pack-i18n';
import { classifyRole, classifyWorkType, homeSuggestions } from './home-chat';
import { type FirstStep, type FirstStepId, firstStepsProgress } from './first-steps';

/**
 * H · Inicio: arriba de la superficie de atención.
 *
 * Una caja tipo chat que convierte lo que la persona quiere en un trabajo real
 * (`onStartWork` crea el trabajo con ese texto como brief y activa el rol que
 * el catálogo recomienda), cuatro sugerencias armadas con el catálogo y el ADN
 * de la marca, y —al costado— la tarjeta Primeros pasos, que se marca sola con
 * datos reales y desaparece cuando los cuatro están.
 *
 * Presentacional como todo Inicio: los datos y la escritura son del contenedor.
 * La clasificación es un problema de datos (`home-chat.ts`), no de modelo.
 */
export interface HomeStartProps {
  brand: Brand;
  /** La ficha del ADN; `null` todavía no hay, y la caja lo dice en vez de prometer. */
  dna: BrandDnaView | null;
  decisions: number;
  roles: readonly AgentRole[];
  /** `null` cuando el contenedor no arma la tarjeta (cerrada o completa). */
  steps: readonly FirstStep[] | null;
  onSend: (text: string) => void;
  /** "Ver todos los tipos de trabajo": el mismo catálogo de Nuevo trabajo. */
  onOpenCatalog: () => void;
  onTryStep: (id: FirstStepId) => void;
  onCloseSteps: () => void;
}

const SUGGEST_ICONS: Record<string, typeof Target> = {
  'campaign-new': Target,
  'copy-pieces': PenLine,
  'content-calendar': CalendarDays,
  'paid-media-audit': TrendingUp,
};

export function HomeStart(props: HomeStartProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const brand = props.brand;
  const suggestions = homeSuggestions(props.dna?.draft ?? null, (key) => t(key));
  const workType = classifyWorkType(text);
  const roleId = classifyRole(text);
  const roleName = roleLabel(props.roles.find((role) => role.id === roleId) ?? { id: roleId, name: roleId });

  const send = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    props.onSend(body);
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
            onChange={(e) => setText(e.target.value)}
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

        <div className="home-suggests">
          {suggestions.map((suggestion) => {
            const Icon = SUGGEST_ICONS[suggestion.workTypeId] ?? Target;
            return (
              <button
                key={suggestion.id}
                type="button"
                className="home-suggest"
                onClick={() => setText(t('home.ask.suggestSeed', { type: t(suggestion.labelKey), detail: suggestion.detail }))}
              >
                <span className="home-suggest-icon" aria-hidden="true"><Icon size={16} /></span>
                <span className="home-suggest-text">
                  <strong>{t(suggestion.labelKey)}</strong>
                  <small>{suggestion.detail}</small>
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
                <span className="first-step-state">{step.done ? t('firstSteps.done') : t('firstSteps.pending')}</span>
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
