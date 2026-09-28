import { Check } from 'lucide-react';
import type {
  BrandDnaBuildJob,
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
 */
export interface BrandDnaPanelProps {
  brandName: string;
  job: BrandDnaBuildJob | null;
  dna: BrandDnaView | null;
  busy?: boolean;
  error?: string | null;
  onApprove?: () => void;
  onCorrect?: () => void;
  onEdit?: (field: BrandDnaField, value: BrandDnaValue | null) => void;
}

const STEP_KEYS: Record<BrandDnaBuildStepKey, MessageKey> = {
  web: 'dna.step.web',
  instagram: 'dna.step.instagram',
  files: 'dna.step.files',
  context: 'dna.step.context',
  documents: 'dna.step.documents',
  decisions: 'dna.step.decisions',
  memory: 'dna.step.memory',
  compose: 'dna.step.compose',
};

const STATE_KEYS: Record<BrandDnaBuildStep['state'], MessageKey> = {
  pending: 'dna.step.pending',
  running: 'dna.step.running',
  done: 'dna.step.done',
  skipped: 'dna.step.skipped',
  failed: 'dna.step.failed',
};

function StepMark({ state }: { state: BrandDnaBuildStep['state'] }) {
  if (state === 'done') return <span className="dna-step-mark is-done"><Check size={13} aria-hidden="true" /></span>;
  if (state === 'running') return <span className="dna-step-mark is-running" aria-hidden="true" />;
  if (state === 'failed') return <span className="dna-step-mark is-failed" aria-hidden="true">!</span>;
  return <span className="dna-step-mark is-pending" aria-hidden="true" />;
}

export function BrandDnaPanel(props: BrandDnaPanelProps) {
  const { t } = useI18n();
  const job = props.job;
  const draft = props.dna?.draft ?? null;
  const status: MessageKey | null = !job
    ? null
    : !job.done ? 'dna.build.waiting'
      : job.outcome === 'proposed' ? 'dna.build.done'
        : job.outcome === 'failed' ? 'dna.build.failed'
          : job.outcome === 'cancelled' ? 'dna.build.cancelled' : 'dna.build.waiting';

  return (
    <div className="dna-build">
      {job && (
        <div className="dna-build-steps">
          <ol className="dna-steps">
            {job.steps.map((step) => (
              <li key={step.key} className="dna-step" data-state={step.state} data-key={step.key}>
                <StepMark state={step.state} />
                <span className="dna-step-text">
                  <span className="dna-step-label">{t(STEP_KEYS[step.key])}</span>
                  <span className="dna-step-state">{t(STATE_KEYS[step.state])}</span>
                  {step.detail && <span className="dna-step-detail">{step.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
          {status && (
            <p className="dna-build-status" role="status" data-outcome={job.outcome ?? 'running'}>
              {t(status)}
              {job.reason && job.outcome === 'failed' && <> {t('dna.build.reason', { reason: job.reason })}</>}
            </p>
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
