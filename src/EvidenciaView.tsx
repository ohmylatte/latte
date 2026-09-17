import { translate as t, type MessageKey } from './i18n';
import { EVIDENCE_TAG_KEYS, evidenciaSummary, type EvidenceTag } from './evidencia-summary';
import { FolderContents } from './FolderContents';
import { Deliverables } from './Deliverables';
import type { Decision, DocumentState, UntrackedFile, Work, WorkDocument } from '../shared/contracts';

/**
 * Evidencia: the in-work surface answering "¿qué respalda este trabajo?".
 *
 * Its derived part is pure: the classification of documents and decisions into
 * the evidence classes lives in `evidencia-summary`, so this component only
 * renders. The folder and the entregables reuse the canonical self-fetching
 * panels (`FolderContents` + `Deliverables`) — no new backend, no
 * re-implementation. Those panels render nothing on the web preview, so the web
 * tests only exercise the derived content.
 *
 * The 5-class taxonomy is rendered as a legend; `cálculo` and `hipótesis` have
 * no persisted source in this slice and are shown empty, never invented. It
 * renders no `<nav>` and no `.document-scroll` (it is not a document pane).
 */

/** The legend order: the full 5-class taxonomy. */
const LEGEND: readonly EvidenceTag[] = ['hecho', 'calculo', 'hipotesis', 'recomendacion', 'decision'];

export interface EvidenciaViewProps {
  /** Null before a work resolves: a safe empty state, never derived content. */
  work: Work | null;
  workId: string;
  documents: readonly WorkDocument[];
  decisions: readonly Decision[];
  untracked: readonly UntrackedFile[];
  /** The review sweep's result, owned by `App` (kept for symmetry; unused here). */
  states: Readonly<Record<string, DocumentState>>;
  checking: boolean;
  formatDate: (value: string) => string;
  onTrack: (fileName: string) => Promise<void>;
  onImported: (fileNames: string[]) => void;
  busy: boolean;
}

export function EvidenciaView(props: EvidenciaViewProps) {
  if (!props.work) {
    return <section className="evidencia-view" role="region" aria-label={t('evidencia.region')} />;
  }
  const summary = evidenciaSummary({
    work: props.work,
    documents: props.documents,
    decisions: props.decisions,
    untracked: props.untracked,
  });
  const periodo = summary.periodo.from
    ? (summary.periodo.to && summary.periodo.to !== summary.periodo.from
      ? `${props.formatDate(summary.periodo.from)} → ${props.formatDate(summary.periodo.to)}`
      : props.formatDate(summary.periodo.from))
    : null;

  const group = (tag: EvidenceTag, titleKey: MessageKey, items: { id: string; title: string; tag: EvidenceTag }[]) => (
    <section className="evidencia-group" data-tag={tag}>
      <h2>{t(titleKey)}</h2>
      {items.length === 0
        ? <p className="evidencia-empty">{t('evidencia.empty')}</p>
        : <ul className="evidencia-list">{items.map((item) => <li key={item.id} data-tag={item.tag}><span className="evidencia-item-title">{item.title}</span><span className="evidencia-tag">{t(EVIDENCE_TAG_KEYS[item.tag])}</span></li>)}</ul>}
    </section>
  );

  return <section className="evidencia-view" role="region" aria-label={t('evidencia.region')}>
    <div className="document-kicker">{t('evidencia.kicker')}</div>

    <div className="evidencia-meta">
      {summary.fecha && <p className="evidencia-fecha"><strong>{t('evidencia.fecha')}</strong> <span>{props.formatDate(summary.fecha)}</span></p>}
      {periodo && <p className="evidencia-periodo"><strong>{t('evidencia.periodo')}</strong> <span>{periodo}</span></p>}
    </div>

    <div className="evidencia-groups">
      {group('hecho', 'evidencia.investigacion', summary.investigacion)}
      {group('recomendacion', 'evidencia.recomendaciones', summary.recomendaciones)}
      {group('decision', 'evidencia.decisiones', summary.decisionesAprobadas)}
      {group('calculo', 'evidencia.tag.calculo', summary.calculo)}
      {group('hipotesis', 'evidencia.tag.hipotesis', summary.hipotesis)}
      <section className="evidencia-group" data-tag="importados">
        <h2>{t('evidencia.importados')}</h2>
        {summary.importados.length === 0
          ? <p className="evidencia-empty">{t('evidencia.empty')}</p>
          : <ul className="evidencia-list">{summary.importados.map((name) => <li key={name}><span className="evidencia-item-title">{name}</span></li>)}</ul>}
      </section>
    </div>

    {summary.limitaciones.length > 0 && <ul className="evidencia-limitaciones">{summary.limitaciones.map((key) => <li key={key}>{t(key)}</li>)}</ul>}

    <section className="evidencia-legend">
      <h2>{t('evidencia.legend')}</h2>
      <ul>{LEGEND.map((tag) => <li key={tag} data-tag={tag}>{t(EVIDENCE_TAG_KEYS[tag])}</li>)}</ul>
    </section>

    {props.workId && <>
      <FolderContents workId={props.workId} untracked={props.untracked.map((file) => ({ fileName: file.fileName, title: file.title, funnelStages: file.funnelStages }))} onTrack={props.onTrack} onImported={props.onImported} busy={props.busy} />
      <Deliverables workId={props.workId} />
    </>}
  </section>;
}
