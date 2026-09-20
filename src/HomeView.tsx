import { Plus } from 'lucide-react';
import type { Brand, Decision, DocumentState, WorkDocument } from '../shared/contracts';
import { translate as t } from './i18n';
import { homeSummary, type HomeSinceLastVisitInput } from './home-summary';

/**
 * Inicio: the decision-first landing, before any work is open.
 *
 * It answers what needs attention across the brand's works — what to continue,
 * what waits on a decision, what needs a look — from state `App` already loaded,
 * and every row it renders is a navigation action. It is not a dashboard: it
 * adds no data and no metric that does not lead somewhere.
 *
 * Props only, like `ContextView` and `OrientationStrip`. That is deliberate: the
 * review sweep (`useDocumentStates`) is owned by `App` and handed down as
 * `states` + `checking`, so this component renders from fixtures with no
 * `browser-api` mock, and the sweep can never run twice. `formatDate` is a prop
 * for the same reason — a locale-dependent assertion is not an assertion.
 *
 * It renders no `<nav>` (the sidebar owns navigation) and no `.document-scroll`
 * (it is not a document pane), so both remain unambiguous for the guards that
 * walk the tree.
 */
export interface HomeViewProps {
  /** Null before any brand resolves: the surface must still be honest. */
  brand: Brand | null;
  works: ReadonlyArray<{ id: string; title: string; updatedAt: string }>;
  /** The brand's documents, unfiltered: the knowledge scope is in-work chrome. */
  documents: readonly WorkDocument[];
  /** Every decision of the brand; only the pending ones are shown. */
  decisions: readonly Decision[];
  /** The review sweep's result, owned by `App`. */
  states: Readonly<Record<string, DocumentState>>;
  /** True while the first review sweep has not answered. */
  checking: boolean;
  /** Work ids with a running agent session (`contextStatus.works[].live`). */
  liveWorkIds: readonly string[];
  /** Pending brand-context proposals. */
  pendingContextProposals: number;
  /**
   * Additive, optional (autonomous-coordination Phase 7 task 7.2): `undefined`
   * means the caller has not wired coordination state yet — the card simply
   * does not render, same as an empty list. Persisted facts only, never a
   * narrative guess.
   */
  coordinationSinceLastVisit?: readonly HomeSinceLastVisitInput[];
  formatDate: (value: string) => string;
  onOpenWork: (workId: string) => void;
  onOpenDecisions: (workId: string) => void;
  onOpenDocument: (documentId: string) => void;
  onOpenContext: () => void;
  onNewWork: () => void;
  onAddBrand: () => void;
}

export function HomeView(props: HomeViewProps) {
  // The pure module takes pending decisions only; narrowing here keeps that
  // contract literal whatever the caller hands over.
  const pendingDecisions = props.decisions.filter((decision) => decision.status === 'pending');
  const summary = homeSummary({
    hasBrand: Boolean(props.brand),
    brandContextDefined: Boolean(props.brand?.context.trim()),
    works: props.works,
    liveWorkIds: props.liveWorkIds,
    decisions: pendingDecisions,
    pendingContextProposals: props.pendingContextProposals,
    documents: props.documents,
    states: props.states,
    checking: props.checking,
    coordinationSinceLastVisit: props.coordinationSinceLastVisit,
  });

  // A card renders only when it has at least one row — or, for Continuar on a
  // brand with no work, the single action that creates the first one. An empty
  // signal renders nothing, never a zero.
  const showContinue = Boolean(props.brand) && (summary.continueRows.length > 0 || summary.showNewWork);
  const showDecisions = Boolean(props.brand) && (summary.decisionRows.length > 0 || props.pendingContextProposals > 0);
  const showReview = Boolean(props.brand) && summary.reviewRows.length > 0;
  const showSinceLastVisit = Boolean(props.brand) && summary.sinceLastVisitRows.length > 0;
  const sinceTitleKey = summary.sinceLastVisitRows.every((row) => row.sinceVisit) ? 'home.since.title' : 'home.since.titleNoVisit';

  return <section className="home-view" role="region" aria-label={t('home.region')}>
    <div className="home-next" data-step={summary.step}>
      <strong>{t('orientation.next')}</strong>
      <span>{t(summary.stepKey, summary.stepParams)}</span>
    </div>

    {summary.step === 'start' && <div className="home-actions">
      <button type="button" className="primary" onClick={props.onAddBrand}><Plus size={15} />{t('ui.auto.033')}</button>
    </div>}

    {showContinue && <section className="home-card home-continue" aria-label={t('home.continue.title')}>
      <h2 className="home-card-title">{t('home.continue.title')}</h2>
      {summary.continueRows.length > 0
        ? <div className="home-rows">{summary.continueRows.map((row) => <button type="button" className="home-row" key={row.id} onClick={() => props.onOpenWork(row.id)}>
            <span className="home-row-title">{row.title}</span>
            <span className="home-row-meta">{props.formatDate(row.updatedAt)}</span>
            {row.live && <span className="tag">{t('home.continue.live')}</span>}
          </button>)}</div>
        : <div className="home-actions"><button type="button" onClick={props.onNewWork}><Plus size={15} />{t('ui.auto.038')}</button></div>}
    </section>}

    {showDecisions && <section className="home-card home-decisions" aria-label={t('home.decisions.title')}>
      <h2 className="home-card-title">{t('home.decisions.title')}</h2>
      <div className="home-rows">
        {summary.decisionRows.map((row) => <button type="button" className="home-row" key={row.id} onClick={() => props.onOpenDecisions(row.workId)}>
          <span className="home-row-title">{row.text}</span>
          {row.workTitle && <span className="home-row-meta">{row.workTitle}</span>}
        </button>)}
        {props.pendingContextProposals > 0 && <button type="button" className="home-row" onClick={props.onOpenContext}>
          <span className="home-row-title">{t('home.decisions.proposal')}</span>
          <span className="home-row-meta">{t('ui.auto.035')}</span>
        </button>}
      </div>
    </section>}

    {showReview && <section className="home-card home-review" aria-label={t('home.review.title')}>
      <h2 className="home-card-title">{t('home.review.title')}</h2>
      <div className="home-rows">{summary.reviewRows.map((row) => <button type="button" className="home-row" key={row.id} onClick={() => props.onOpenDocument(row.id)}>
        <span className="home-row-title">{row.title}</span>
        {row.workTitle && <span className="home-row-meta">{row.workTitle}</span>}
      </button>)}</div>
    </section>}

    {/* El título se elige por la EVIDENCIA que hay: "desde tu última visita"
        sólo se puede afirmar si TODA fila se mide contra una visita real. Una
        sola sin visita registrada y la tarjeta dice desde cuándo habla de
        verdad — prometer una visita que nunca se midió era la mentira. */}
    {showSinceLastVisit && <section className="home-card home-since" aria-label={t(sinceTitleKey)}>
      <h2 className="home-card-title">{t(sinceTitleKey)}</h2>
      {/* El `kind` viaja al DOM: un equipo que TERMINÓ no es una novedad
          cualquiera y su fila tiene que poder verse distinta sin que el estilo
          dependa de leer el texto de la frase. */}
      <div className="home-rows">{summary.sinceLastVisitRows.map((row) => <button type="button" className={'home-row' + (row.kind === 'done' || row.kind === 'failed' ? ' home-row-finished' : '')} data-kind={row.kind} key={row.id} onClick={() => row.kind === 'awaitingYou' ? props.onOpenDecisions(row.workId) : props.onOpenWork(row.workId)}>
        <span className="home-row-title">{t(`home.since.kind.${row.kind}` as 'home.since.kind.done', { workTitle: row.workTitle })}</span>
      </button>)}</div>
    </section>}
  </section>;
}
