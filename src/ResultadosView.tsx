import { translate as t } from './i18n';
import { useState } from 'react';
import { Deliverables } from './Deliverables';
import { NON_DERIVED_RESULTADOS, RESULTADO_TYPE_KEYS, resultadosSummary } from './resultados-summary';
import type { DeliverableListing, Decision, Work } from '../shared/contracts';
import { isDesktop } from './browser-api';

/**
 * Resultados: the in-work surface answering "¿qué entregó este trabajo?".
 *
 * Its derived part is pure: `resultadosSummary` reduces the work's approved
 * decisions and the linked `resultPath` to a render-ready shape, so this
 * component only renders. The `entregable` class reuses the canonical
 * self-fetching `Deliverables` panel (no new backend, no re-listing). The four
 * non-produced classes — diagnóstico, experimento, cambio ejecutado, medición
 * — are rendered as honest empty states, never invented.
 *
 * The linked `documento` is a pointer into `entregables/`, so whether it is
 * still there is read from the folder (the `Deliverables` listing), never
 * stored. The listing is not fetched a second time here: `Deliverables` reports
 * its own readdir up through `onListing`, so this view flags the link from the
 * very same read that renders the panel. On the web preview there is no folder
 * to read, so the link renders unflagged.
 */

export interface ResultadosViewProps {
  /** Null before a work resolves: a safe empty state, never derived content. */
  work: Work | null;
  decisions: readonly Decision[];
  formatDate: (value: string) => string;
}

export function ResultadosView(props: ResultadosViewProps) {
  // The Deliverables panel's own listing, reported up so the linked documento
  // can be flagged present/missing without a second readdir.
  const [listing, setListing] = useState<DeliverableListing | null>(null);

  if (!props.work) {
    return <section className="resultados-view" role="region" aria-label={t('resultados.region')} />;
  }
  const summary = resultadosSummary({ work: props.work, decisions: props.decisions });

  const linked = summary.documento?.resultPath ?? null;
  const linkedPresent = Boolean(isDesktop && linked && listing && listing.files.some((file) => file.fileName === linked));
  const linkedMissing = Boolean(isDesktop && linked && listing && !linkedPresent);
  const documentoState = linked ? (linkedMissing ? 'missing' : linkedPresent ? 'present' : 'unverified') : null;

  return <section className="resultados-view" role="region" aria-label={t('resultados.region')}>
    <div className="document-kicker">{t('resultados.kicker')}</div>
    <p className="intro">{t('resultados.lead')}</p>

    <div className="resultados-groups">
      <section className="resultados-group" data-tag="documento">
        <h2>{t('resultados.documento')}</h2>
        {summary.documento
          ? <div className="resultados-documento">
            {summary.documento.expectedOutput && <p className="resultados-documento-expected">{summary.documento.expectedOutput}</p>}
            <p className="resultados-documento-path" data-state={documentoState ?? undefined} title={linkedMissing ? t('outcome.missingTitle', { file: summary.documento.resultPath }) : summary.documento.resultPath}>
              <code>{summary.documento.resultPath}</code>{linkedMissing && <span>{t('outcome.missingSuffix')}</span>}
            </p>
          </div>
          : <p className="resultados-empty">{t('resultados.documento.empty')}</p>}
      </section>

      <section className="resultados-group" data-tag="entregable">
        <h2>{t('resultados.entregable')}</h2>
        <Deliverables workId={props.work.id} onListing={setListing} />
      </section>

      <section className="resultados-group" data-tag="decision">
        <h2>{t('resultados.decision')}</h2>
        {summary.decisionesAprobadas.length === 0
          ? <p className="resultados-empty">{t('resultados.decision.empty')}</p>
          : <ul className="resultados-decision-list">{summary.decisionesAprobadas.map((row) => (
            <li key={row.id}><p>{row.text}</p>{row.decidedAt && <small>{props.formatDate(row.decidedAt)}</small>}</li>
          ))}</ul>}
      </section>

      {NON_DERIVED_RESULTADOS.map((type) => (
        <section className="resultados-group" data-tag={type} key={type}>
          <h2>{t(RESULTADO_TYPE_KEYS[type])}</h2>
          <p className="resultados-empty">{t('resultados.empty')}</p>
        </section>
      ))}
    </div>
  </section>;
}
