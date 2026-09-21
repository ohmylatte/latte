import { useState } from 'react';
import { CircleCheck, CircleX, FileText, List, MessageSquare, Send, Users } from 'lucide-react';
import { translate as t } from '../i18n';
import { CoordAvatar } from './anatomy';
import { memberDisplayName } from './names';
import { fileNames, titleOf } from './text';
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
      memberId: entry.memberId,
      summary,
      files: fileNames(entry.summaryPreview),
      at: entry.settledAt ?? entry.createdAt,
      failed: entry.status === 'failed' || entry.outcome === 'failed',
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface RunOutputProps {
  run: CoordinationRunView;
  log?: readonly CoordinationLogEntryView[];
  team: readonly TeamMember[];
  roles?: readonly AgentRole[];
  formatTime?: (value: string) => string;
}

export function RunOutput(props: RunOutputProps) {
  const [openLog, setOpenLog] = useState(false);
  const time = props.formatTime ?? ((value: string) => value);
  const roles = props.roles ?? [];
  const rows = outcomeRows(props.log);
  const entries = (props.log ?? []).filter((entry) => entry.kind !== 'run_done' && entry.kind !== 'run_cancelled');

  return <div className="coord-output">
    <div className="coord-output-head">
      <div className="coord-output-title">{t('coord.done.produced')}</div>
      {entries.length > 0 && <button type="button" className="coord-btn coord-btn-ghost coord-output-log"
        aria-expanded={openLog} onClick={() => setOpenLog((v) => !v)}>
        <List size={14} />{t('coord.done.log', { count: entries.length })}
      </button>}
    </div>
    {rows.length === 0
      ? <p className="coord-output-empty">{t('coord.done.producedEmpty')}</p>
      : <ul className="coord-output-list">
        {rows.map((row) => {
          const name = memberDisplayName(row.memberId, props.team, null, roles);
          return <li key={row.id} className={'coord-output-row' + (row.failed ? ' is-failed' : '')} data-report-id={row.id}>
            {row.failed ? <CircleX size={14} className="coord-ic-bad" /> : <FileText size={14} className="coord-ic-idle" />}
            <span className="coord-output-summary">{row.summary}</span>
            <CoordAvatar name={name} small roleId={props.team.find((m) => m.id === row.memberId)?.roleId} />
            <time className="coord-time" dateTime={row.at}>{time(row.at)}</time>
            {row.files.length > 0 && <span className="coord-files coord-output-files">
              {row.files.map((file) => <span key={file} className="coord-file"><FileText size={12} />{file}</span>)}
            </span>}
          </li>;
        })}
      </ul>}
    {openLog && <ol className="coord-log">
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
    </ol>}
  </div>;
}
