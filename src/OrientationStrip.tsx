import { translate as t } from './i18n';
import { orientationSummary, type OrientationInput } from './orientation-summary';

/**
 * "Dónde estamos": the read-only strip above the brief.
 *
 * It answers four questions from state the shell already loaded — is the brand
 * context defined, what does this work have to deliver, what needs a look, what
 * is waiting on a decision — and names the one next step. It renders from props
 * alone: no state, no backend, no handlers, so both languages render from the
 * same markup and nothing here can write.
 *
 * It is deliberately NOT gated on a selected document: orientation has to
 * survive moving between documents. The only editor of the expected output
 * remains `WorkOutcome`, further down the same pane.
 */
export function OrientationStrip(input: OrientationInput) {
  const summary = orientationSummary(input);
  return <section className="orientation-strip" role="region" aria-label={t('orientation.region')}>
    <div className="orientation-cells">
      <span className="orientation-cell" data-cell="brand" data-state={input.brandContextDefined ? 'defined' : 'empty'}>
        <strong>{t('orientation.brand')}</strong>
        <span className="orientation-value">{t(summary.brandStateKey)}</span>
      </span>
      <span className="orientation-cell" data-cell="outcome" data-state={summary.expectedOutput ? 'set' : 'unset'}>
        <strong>{t('outcome.label')}</strong>
        <span className="orientation-value" title={summary.expectedOutput ?? undefined}>{summary.expectedOutput ?? <em>{t('outcome.unset')}</em>}</span>
      </span>
      <span className="orientation-cell" data-cell="review" data-state={summary.reviewDocuments === null ? 'pending' : summary.reviewDocuments > 0 ? 'some' : 'none'}>
        <strong>{t('orientation.review')}</strong>
        <span className="orientation-value">{summary.reviewDocuments === null ? '…' : summary.reviewDocuments}</span>
      </span>
      <span className="orientation-cell" data-cell="decisions" data-state={summary.pendingDecisions > 0 ? 'some' : 'none'}>
        <strong>{t('orientation.decisions')}</strong>
        <span className="orientation-value">{summary.pendingDecisions}</span>
      </span>
    </div>
    <span className="orientation-next" data-step={summary.step}>
      <strong>{t('orientation.next')}</strong>
      <span>{t(summary.stepKey, summary.stepParams)}</span>
    </span>
  </section>;
}
