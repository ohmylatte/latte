import { useState } from 'react';
import { Check } from 'lucide-react';
import type {
  BrandDnaBuildJob,
  BrandDnaBuildMode,
  BrandDnaBuildStep,
  BrandDnaBuildStepKey,
  BrandDnaField,
  BrandDnaFields,
  BrandDnaView, BrandDnaValue } from '../shared/contracts';
import type { MessageKey } from './i18n';
import { useI18n } from './i18n';
import { BrandDnaCard } from './BrandDnaCard';

/**
 * G · "El ADN de tu marca": los pasos reales del build a la izquierda, la ficha
 * a la derecha.
 *
 * La izquierda dibuja lo que el motor está haciendo, no una animación: cada
 * fila es un `BrandDnaBuildStep` leído con `readBrandDnaBuildJob`. El estado se
 * narra con un ícono Y con la palabra ("Listo", "En curso", "Pendiente"), así
 * que el color nunca es la única señal. La ficha aparece cuando hay borrador;
 * mientras tanto, la derecha dice qué está pasando en vez de mostrar una grilla
 * vacía.
 *
 * K1: la fila habla de negocio en sans ("Leyendo tu web", "Armando la ficha")
 * mientras el paso corre; lo que el motor escribe para sí mismo (`detail`) no
 * se muestra: va en un "Ver detalle" plegado. Y NUNCA se está sin explicación:
 * un build que no cambia en 3 minutos lo dice con "Reintentar" y "Cancelar",
 * y un fallido explica el motivo POR CÓDIGO.
 */
export interface BrandDnaPanelProps {
  brandName: string;
  job: BrandDnaBuildJob | null;
  dna: BrandDnaView | null;
  busy?: boolean;
  error?: string | null;
  /** K1: el build dejó de cambiar hace 3 minutos. */
  stale?: boolean;
  onApprove?: () => void;
  onCorrect?: () => void;
  onEdit?: (field: BrandDnaField, value: BrandDnaValue | null) => void;
  /** Repite el build con lo mismo que se pidió la vez pasada. */
  onRetry?: () => void;
  /** Deja de observar el build que está quieto. */
  onCancel?: () => void;
}

const STEP_KEYS: Record<BrandDnaBuildStepKey, MessageKey> = {
  web: 'dna.step.web',
  channels: 'dna.step.channels',
  files: 'dna.step.files',
  context: 'dna.step.context',
  documents: 'dna.step.documents',
  decisions: 'dna.step.decisions',
  memory: 'dna.step.memory',
  compose: 'dna.step.compose',
};

/** K1: lo que Latte está haciendo AHORA, en las palabras de la persona. */
const DOING_KEYS: Record<BrandDnaBuildStepKey, MessageKey> = {
  web: 'dna.step.doing.web',
  channels: 'dna.step.doing.channels',
  files: 'dna.step.doing.files',
  context: 'dna.step.doing.context',
  documents: 'dna.step.doing.documents',
  decisions: 'dna.step.doing.decisions',
  memory: 'dna.step.doing.memory',
  compose: 'dna.step.doing.compose',
};

const STATE_KEYS: Record<BrandDnaBuildStep['state'], MessageKey> = {
  pending: 'dna.step.pending',
  running: 'dna.step.running',
  done: 'dna.step.done',
  skipped: 'dna.step.skipped',
  failed: 'dna.step.failed',
};

/**
 * K1: un fallo se explica con una frase de la persona, no con el código del
 * motor. El código queda para lo que no tiene frase propia.
 */
const REASON_KEYS: Record<string, MessageKey> = {
  NOT_INSTALLED: 'dna.reason.NOT_INSTALLED',
  UNAVAILABLE: 'dna.reason.UNAVAILABLE',
  FEATURE_DISABLED: 'dna.reason.FEATURE_DISABLED',
  AGENT_FAILED: 'dna.reason.AGENT_FAILED',
  NO_ADN_FILE: 'dna.reason.NO_ADN_FILE',
  INVALID_ADN: 'dna.reason.INVALID_ADN',
  NO_IDEAS_FILE: 'dna.reason.NO_IDEAS_FILE',
  INVALID_IDEAS: 'dna.reason.INVALID_IDEAS',
  RUN_ALREADY_ACTIVE: 'dna.reason.RUN_BUSY',
  RUN_NOT_ACTIVE: 'dna.reason.RUN_BUSY',
  BUDGET_UNSET: 'dna.reason.BUDGET',
  COORDINATION_BUDGET_INVALID: 'dna.reason.BUDGET',
  TASK_CAP: 'dna.reason.TEAM_BUSY',
  PLAN_HAS_UNAPPROVED_ROLES: 'dna.reason.TEAM_BUSY',
  ROLE_NOT_APPROVED: 'dna.reason.TEAM_BUSY',
  COORDINATION_NOT_APPROVED: 'dna.reason.TEAM_BUSY',
  INTERNAL: 'dna.reason.INTERNAL',
};

function StepMark({ state }: { state: BrandDnaBuildStep['state'] }) {
  if (state === 'done') return <span className="dna-step-mark is-done"><Check size={13} aria-hidden="true" /></span>;
  if (state === 'running') return <span className="dna-step-mark is-running" aria-hidden="true" />;
  if (state === 'failed') return <span className="dna-step-mark is-failed" aria-hidden="true">!</span>;
  return <span className="dna-step-mark is-pending" aria-hidden="true" />;
}

/**
 * K1: el nombre de cada fila, en negocio. Mientras el paso corre, la fila dice
 * QUÉ ESTÁ HACIENDO Latte ("Leyendo tu web", "Armando la ficha"); y el último
 * paso tiene dos nombres según el modo —la ficha para los modos que la arman,
 * las ideas para el modo que sólo escribe ideas.
 */
function stepLabelKey(step: BrandDnaBuildStep, mode: BrandDnaBuildMode): MessageKey {
  const running = step.state === 'running';
  if (step.key === 'compose') {
    if (mode === 'ideas') return running ? 'dna.step.doing.ideas' : 'dna.step.ideas';
    return running ? 'dna.step.doing.compose' : 'dna.step.compose';
  }
  return running ? DOING_KEYS[step.key] : STEP_KEYS[step.key];
}

export function BrandDnaPanel(props: BrandDnaPanelProps) {
  const { t } = useI18n();
  const [showDetail, setShowDetail] = useState(false);
  const job = props.job;
  const draft = props.dna?.draft ?? null;
  const status: MessageKey | null = !job
    ? null
    : !job.done ? 'dna.build.waiting'
      : job.outcome === 'proposed' ? 'dna.build.done'
        : job.outcome === 'failed' ? 'dna.build.failed'
          : job.outcome === 'cancelled' ? 'dna.build.cancelled' : 'dna.build.waiting';
  const failed = Boolean(job?.done && job?.outcome === 'failed');
  const stale = Boolean(job && !job.done && props.stale);
  const withDetail = job?.steps.some((step) => Boolean(step.detail)) ?? false;
  const reasonKey = failed && job?.reason ? REASON_KEYS[job.reason] : undefined;

  return (
    <div className="dna-build">
      {job && (
        <div className="dna-build-steps">
          <ol className="dna-steps">
            {job.steps.map((step) => (
              <li key={step.key} className="dna-step" data-state={step.state} data-key={step.key}>
                <StepMark state={step.state} />
                <span className="dna-step-text">
                  <span className="dna-step-label">{t(stepLabelKey(step, job.mode))}</span>
                  <span className="dna-step-state">{t(STATE_KEYS[step.state])}</span>
                  {showDetail && step.detail && <span className="dna-step-detail">{step.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
          {withDetail && (
            <button type="button" className="dna-step-detail-toggle" aria-expanded={showDetail} onClick={() => setShowDetail((open) => !open)}>
              {showDetail ? t('dna.step.detail.hide') : t('dna.step.detail.show')}
            </button>
          )}
          {status && (
            <p className="dna-build-status" role="status" data-outcome={job.outcome ?? 'running'}>
              {t(status)}
              {failed && <> {reasonKey ? t(reasonKey) : t('dna.build.reason', { reason: job.reason ?? '' })}</>}
            </p>
          )}
          {(stale || failed) && (
            <div className="dna-build-actions">
              {stale && <p className="dna-build-stale" role="status">{t('dna.build.stale')}</p>}
              <button type="button" className="primary" disabled={props.busy} onClick={props.onRetry}>{t('dna.build.retry')}</button>
              {stale && <button type="button" disabled={props.busy} onClick={props.onCancel}>{t('dna.build.cancel')}</button>}
            </div>
          )}
        </div>
      )}

      <div className="dna-build-card">
        {props.error && <div role="alert" className="message error"><span>{props.error}</span></div>}
        {draft
          ? <BrandDnaCard brandName={props.brandName} dna={props.dna} busy={props.busy}
              onApprove={props.onApprove} onCorrect={props.onCorrect} onEdit={props.onEdit} />
          : <p className="dna-build-waiting" role="status">{job && !job.done ? t('dna.card.building') : t('dna.card.empty')}</p>}
      </div>
    </div>
  );
}
