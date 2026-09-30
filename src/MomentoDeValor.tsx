import { translate as t } from './i18n';
import { Bookmark, CircleCheck, FileText, Sparkles } from 'lucide-react';
import type { MomentoDeValorSummary } from './momento-de-valor';

/**
 * ENTREGA 1A: LA TARJETA DE CIERRE DEL PRIMER RESULTADO.
 *
 * Brief 01, "7. Momento de valor": nunca un "listo" genérico. Dice, con lo que
 * ya está cargado (nunca inventado), qué usó Latte —el contexto de marca, los
 * documentos y decisiones de este Trabajo— y qué produjo —cuántos documentos
 * esperan revisión, cuántos ya se aprobaron—, con tres acciones concretas.
 *
 * Pura por props: nada de estado ni de `browser-api`, así que se puede montar
 * y leer sin un chat store — la misma razón por la que `WorkOutcomeView` está
 * separada de `WorkOutcome`.
 */
export function MomentoDeValorCard({ summary, onViewResult, onReviewDecisions, onContinue }: {
  summary: MomentoDeValorSummary;
  onViewResult: () => void;
  onReviewDecisions: () => void;
  onContinue: () => void;
}) {
  const produced: string[] = [];
  if (summary.reviewCount > 0) produced.push(t('momento.producedReview', { count: summary.reviewCount }));
  if (summary.approvedCount > 0) produced.push(t('momento.producedApproved', { count: summary.approvedCount }));
  return <section className="momento-card" aria-label={t('momento.region')}>
    <div className="momento-kicker"><Sparkles size={13} />{t('momento.region')}</div>
    <h3>{t('momento.title')}</h3>
    <p className="momento-used">
      <strong>{t('momento.usedTitle')}</strong>{' '}
      {summary.brandContextDefined ? t('momento.usedBrand') : t('momento.usedNoBrand')}
      {', '}{t('momento.usedDocuments', { count: summary.documentCount })}
      {', '}{t('momento.usedDecisions', { count: summary.decisionCount })}.
    </p>
    {produced.length > 0 && <p className="momento-produced"><strong>{t('momento.producedTitle')}</strong> {produced.join(' · ')}.</p>}
    <div className="momento-actions">
      <button className="primary" onClick={onViewResult}><FileText size={14} />{t('momento.viewResult')}</button>
      <button onClick={onReviewDecisions}><Bookmark size={14} />{t('momento.reviewDecisions')}</button>
      <button className="subtle" onClick={onContinue}><CircleCheck size={14} />{t('momento.continue')}</button>
    </div>
  </section>;
}
