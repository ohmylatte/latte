import { useState } from 'react';
import { CircleCheck, CircleX, FileText, List, MessageSquare, Send, Users } from 'lucide-react';
import { currentLocale, translate as t } from '../i18n';
import { CoordAvatar } from './anatomy';
import { avatarOfMember } from './avatar-of';
import { memberDisplayName } from './names';
import { fileNames, titleOf } from './text';
import { daysAgo, whenOf } from './time';
import type { AgentRole, CoordinationLogEntryView, CoordinationRunView, TeamMember } from '../../shared/contracts';

/**
 * C5: EL VACÍO TIENE PROPÓSITO, Y LO TERMINADO TIENE QUÉ MOSTRAR.
 *
 * Criterio 6: o la pantalla muestra algo entero, o dice qué hacer. Nunca un
 * titular con una sola línea gris debajo.
 *
 * Sin run, el panel derecho no es una lista vacía: es la frase que explica
 * cómo se pone a trabajar al equipo, con el ejemplo del pedido y el botón que
 * lleva ahí. Con el run terminado, es lo que el equipo dejó.
 */

export function EmptyTeam({ coordinatorName, onAsk }: { coordinatorName: string; onAsk?: () => void }) {
  return <div className="coord-empty">
    <Users size={44} className="coord-empty-icon" aria-hidden="true" />
    <p className="coord-empty-title">{t('coord.empty.title')}</p>
    <p className="coord-empty-body">{coordinatorName
      ? t('coord.empty.body', { name: coordinatorName })
      : t('coord.empty.bodyNoCoordinator')}</p>
    {/* El ejemplo es un ejemplo, y se ve como tal: punteado e itálica, nunca
        como un campo que se puede escribir ni como una cita del producto. */}
    <p className="coord-empty-example">{t('coord.empty.example')}</p>
    {onAsk && <button type="button" className="coord-btn coord-btn-primary coord-empty-action" onClick={onAsk}>
      <MessageSquare size={14} />{t('coord.empty.action')}
    </button>}
  </div>;
}

/** Un reporte del run, como la lista de lo producido lo muestra. */
interface OutcomeRow {
  id: string;
  taskId: string;
  memberId: string;
  summary: string;
  files: string[];
  at: string;
  failed: boolean;
}

/**
 * Lo que el equipo dejó, derivado SÓLO de lo que existe.
 *
 * El modelo de datos NO tiene una lista de archivos producidos: lo único que
 * el motor guarda de un reporte es su resumen (`coordination_dispatch.summary`,
 * recortado a 120 caracteres). Así que esto muestra resúmenes, y una ficha de
 * archivo sólo cuando el resumen NOMBRA uno. Inventar una lista de entregables
 * sería exactamente la capacidad-que-no-funciona que este producto no hace.
 */
export function outcomeRows(log: readonly CoordinationLogEntryView[] | undefined): OutcomeRow[] {
  const out: OutcomeRow[] = [];
  for (const entry of log ?? []) {
    if (entry.kind === 'run_done' || entry.kind === 'run_cancelled') continue;
    if (entry.status !== 'reported' && entry.status !== 'failed') continue;
    const summary = titleOf(entry.summaryPreview, 200);
    if (!summary) continue;
    out.push({
      id: entry.id,
      taskId: entry.taskId,
      memberId: entry.memberId,
      summary,
      files: fileNames(entry.summaryPreview),
      at: entry.settledAt ?? entry.createdAt,
      failed: entry.status === 'failed' || entry.outcome === 'failed',
    });
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  // H2: UN FALLIDO SUPERADO NO ENCABEZA. Si la misma tarea se reportó bien
  // después (un reintento), el fallo ya no es lo que el equipo dejó: es
  // historia, y vive en la bitácora.
  return out.filter((row) => !row.failed || !out.some((later) => later.taskId === row.taskId && !later.failed && later.at > row.at));
}

/** H2: pasado este tiempo desde el cierre, lo producido se pliega a una línea. */
export const OUTCOME_FRESH_MS = 24 * 60 * 60 * 1000;

/** Cuándo cerró el run: su propia entrada de cierre en la bitácora, y si no está, su última escritura. */
function closedAt(run: CoordinationRunView, log: readonly CoordinationLogEntryView[] | undefined): string {
  const close = (log ?? []).find((entry) => entry.kind === 'run_done' || entry.kind === 'run_cancelled');
  return close?.createdAt ?? run.updatedAt;
}

export interface RunOutputProps {
  run: CoordinationRunView;
  log?: readonly CoordinationLogEntryView[];
  team: readonly TeamMember[];
  roles?: readonly AgentRole[];
  formatTime?: (value: string) => string;
  /** El reloj contra el que se decide qué es "ayer" y qué caducó. Sólo los tests lo fijan. */
  now?: number;
}

/**
 * H2: LO PRODUCIDO CADUCA.
 *
 * - Un run CANCELADO no produjo: su panel es una línea ("Cancelado ayer 23:19 ·
 *   Bitácora · N eventos"). Encabezarlo con sus reportes fallidos era lo que
 *   la persona veía a la mañana siguiente, sobre un trabajo que ya estaba
 *   hecho por otro lado.
 * - Un run TERMINADO se ve completo durante 24 h desde su cierre; después se
 *   pliega a "Terminado ayer 19:32 · 4 de 4 · Ver lo producido", que se
 *   despliega a pedido.
 * - Toda hora de otro día dice de qué día es (`whenOf`).
 */
export function RunOutput(props: RunOutputProps) {
  const [openLog, setOpenLog] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const now = props.now ?? Date.now();
  const locale = currentLocale();
  const hour = props.formatTime ?? ((value: string) => value);
  const time = (value: string) => ((daysAgo(value, now) ?? 0) > 0
    ? whenOf(value, { now, locale, yesterday: t('coord.time.yesterday'), hour })
    : hour(value));
  const roles = props.roles ?? [];
  const rows = outcomeRows(props.log);
  const entries = (props.log ?? []).filter((entry) => entry.kind !== 'run_done' && entry.kind !== 'run_cancelled');
  const closed = closedAt(props.run, props.log);
  const closedWhen = time(closed);
  const logToggle = entries.length > 0 && <button type="button" className="coord-btn coord-btn-ghost coord-output-log"
    aria-expanded={openLog} onClick={() => setOpenLog((v) => !v)}>
    <List size={14} />{t('coord.done.log', { count: entries.length })}
  </button>;
  const logList = openLog && <ol className="coord-log">
    {entries.map((entry) => {
      const dispatch = entry as Extract<CoordinationLogEntryView, { taskId: string }>;
      const name = memberDisplayName(dispatch.memberId, props.team, null, roles);
      const settled = Boolean(dispatch.settledAt);
      return <li key={dispatch.id} className="coord-log-row" data-status={dispatch.status}>
        {settled
          ? (dispatch.status === 'reported' ? <CircleCheck size={13} className="coord-ic-ok" /> : <CircleX size={13} className="coord-ic-idle" />)
          : <Send size={13} className="coord-ic-idle" />}
        <span className="coord-log-text">{name} · {titleOf(dispatch.promptPreview, 90)}</span>
        <time className="coord-time" dateTime={dispatch.settledAt ?? dispatch.createdAt}>{time(dispatch.settledAt ?? dispatch.createdAt)}</time>
      </li>;
    })}
  </ol>;

  if (props.run.status !== 'done') {
    return <div className="coord-output is-line">
      <p className="coord-output-line">
        <CircleX size={14} className="coord-ic-idle" />
        <span className="coord-output-line-text">{t('coord.done.cancelledAt', { when: closedWhen })}</span>
        {logToggle}
      </p>
      {logList}
    </div>;
  }

  const total = props.run.tasksDone + props.run.tasksFailed + props.run.tasksInFlight + props.run.tasksPending;
  const stale = now - new Date(closed).getTime() > OUTCOME_FRESH_MS;
  if (stale && !unfolded) {
    return <div className="coord-output is-line">
      <p className="coord-output-line">
        <CircleCheck size={14} className="coord-ic-ok" />
        <span className="coord-output-line-text">{t('coord.done.finishedAt', { when: closedWhen })} · {t('coord.done.ofTotal', { done: props.run.tasksDone, total })}</span>
        <button type="button" className="coord-btn coord-btn-ghost coord-output-unfold" onClick={() => setUnfolded(true)}>{t('coord.done.showProduced')}</button>
      </p>
    </div>;
  }

  return <div className="coord-output">
    <div className="coord-output-head">
      <div className="coord-output-title">{t('coord.done.produced')}</div>
      {logToggle}
    </div>
    {rows.length === 0
      ? <p className="coord-output-empty">{t('coord.done.producedEmpty')}</p>
      : <ul className="coord-output-list">
        {rows.map((row) => {
          const name = memberDisplayName(row.memberId, props.team, null, roles);
          return <li key={row.id} className={'coord-output-row' + (row.failed ? ' is-failed' : '')} data-report-id={row.id}>
            {row.failed ? <CircleX size={14} className="coord-ic-bad" /> : <FileText size={14} className="coord-ic-idle" />}
            <span className="coord-output-summary">{row.summary}</span>
            {/* Quien reportó y ya no está no se dibuja con las iniciales de
                la frase que lo nombra: va el avatar neutro. */}
            {(() => { const owner = props.team.find((m) => m.id === row.memberId); return <CoordAvatar name={name} small roleId={owner?.roleId} avatar={owner ? avatarOfMember(owner) : null} gone={!owner} />; })()}
            <time className="coord-time" dateTime={row.at}>{time(row.at)}</time>
            {row.files.length > 0 && <span className="coord-files coord-output-files">
              {row.files.map((file) => <span key={file} className="coord-file"><FileText size={12} />{file}</span>)}
            </span>}
          </li>;
        })}
      </ul>}
    {logList}
  </div>;
}
