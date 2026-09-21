import { useState } from 'react';
import { translate as t } from './i18n';
import { MessageSquare, Users } from 'lucide-react';
import type {
  AgentRole, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudgetView,
  CoordinationGateView, CoordinationHireView, CoordinationLogEntryView, CoordinationMemberSupport,
  CoordinationMessageView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';
import { describeCoordinationSupport, describeMemorySupport, memberCoordinationState, type LatteMode } from './TeamPanel';
import { describeInboxEvent, inboxEvents, pendingForMember } from './coordination/inbox';
import { RunHeader } from './coordination/RunHeader';
import { CoordRow } from './coordination/anatomy';
import { memberSignal } from './coordination/member-line';
import { hourOf } from './coordination/time';
import { titleOf } from './coordination/text';
import { memberDisplayName } from './coordination/names';

/**
 * B3.1: LA VISTA "EQUIPO".
 *
 * En B1 el buzón se dibujó dentro del panel del equipo, es decir en la columna
 * del CHAT, entre la tira de pestañas y los mensajes. Con tres miembros eso son
 * tres filas fijas robándole alto a la conversación, que es lo único que esa
 * columna tiene que hacer. El dueño lo vio en la primera captura: "no puede
 * estar ahí, le roba el espacio al chat".
 *
 * Su referencia es un inbox multi-bot: la lista de bots a la izquierda con su
 * último mensaje; al abrir uno, su hilo. Eso necesita ANCHO, no la columna
 * angosta del chat, así que vive como una pestaña más del Trabajo, al lado de
 * Resumen y Trabajo.
 *
 * El componente es presentacional: no toca `browser-api`, no tiene estado de
 * selección propio (la selección la guarda quien navega, porque "Ver hilo"
 * desde la pestaña de un miembro del chat tiene que poder elegirla) y sin un
 * handler no ofrece el botón que lo usaría.
 */
export interface TeamViewProps {
  work: Work | null;
  team: readonly TeamMember[];
  roles: readonly AgentRole[];
  /** `advanced` agrega el `<details>` del pie; `simple` no lo dibuja. */
  mode: LatteMode;
  busy: boolean;
  /**
   * El miembro cuyo hilo se está leyendo. `null` —o un id que ya no está en el
   * equipo— cae en el coordinador del run, y sin run en el primer miembro.
   */
  selectedMemberId: string | null;
  onSelectMember: (memberId: string) => void;
  /** Abre la conversación de ese miembro en la columna del chat. */
  onOpenChat?: (memberId: string) => void;
  coordinationRun?: CoordinationRunView | null;
  pending?: Record<string, boolean>;
  onPauseCoordination?: (runId: string) => void;
  onResumeCoordination?: (runId: string) => void;
  onCancelCoordination?: (runId: string) => void;
  coordinationLog?: readonly CoordinationLogEntryView[];
  coordinationMessages?: readonly CoordinationMessageView[];
  coordinationAsks?: readonly CoordinationAskView[];
  coordinationHires?: readonly CoordinationHireView[];
  coordinationGates?: readonly CoordinationGateView[];
  /** C1: las tareas del run, para la tira del encabezado. */
  coordinationTasks?: readonly CoordinationRunTaskView[];
  /** La hora local de un ISO, inyectable para los tests. */
  formatTime?: (value: string) => string;
  /** C5: empezar otro pedido cuando el run terminó — abre el chat del coordinador. */
  onNewRequest?: () => void;
  coordinationSupport?: readonly CoordinationMemberSupport[];
  formatDate?: (value: string) => string;
  /** B3.1: la configuración del equipo, que bajó del panel a esta vista. */
  coordinationAuthority?: CoordinationAuthorityMode;
  onSetCoordinationAuthority?: (mode: CoordinationAuthorityMode) => void;
  coordinationBudget?: CoordinationBudgetView;
  onSetCoordinationBudget?: (maxDispatches: number) => void;
  coordinatorGrant?: string | null;
}

/**
 * Quién es el miembro abierto, resuelto UNA vez.
 *
 * Un id que ya no está en el equipo (el miembro que se eliminó mientras la
 * vista estaba abierta) no deja la pantalla sin hilo: cae en el mismo lugar que
 * el `null`.
 */
export function selectedThreadMember(
  team: readonly TeamMember[],
  selectedMemberId: string | null,
  run: CoordinationRunView | null | undefined,
): string | null {
  if (selectedMemberId && team.some((m) => m.id === selectedMemberId)) return selectedMemberId;
  const coordinator = run?.coordinatorMemberId ?? null;
  if (coordinator && team.some((m) => m.id === coordinator)) return coordinator;
  return team[0]?.id ?? null;
}

export function TeamView(props: TeamViewProps) {
  const { team, roles, work } = props;
  const run = props.coordinationRun ?? null;
  const input = {
    log: props.coordinationLog,
    messages: props.coordinationMessages,
    asks: props.coordinationAsks,
    hires: props.coordinationHires,
  };
  const selected = selectedThreadMember(team, props.selectedMemberId, run);
  const when = (at: string) => (props.formatDate ? props.formatDate(at) : at);
  const hour = (at: string) => (props.formatTime ? props.formatTime(at) : hourOf(at));
  /**
   * C2: el titulo de una tarea sale del PLAN, no del prompt del despacho.
   * El prompt es lo que el coordinador le escribio al miembro; el titulo es
   * lo que la persona pidio. Sin tareas cableadas, la fila cae en el prompt,
   * que es lo que ya habia.
   */
  const taskTitle = (taskId: string) => titleOf((props.coordinationTasks ?? []).find((task) => task.id === taskId)?.spec);
  const thread = selected ? inboxEvents(input, selected) : [];
  const openName = selected ? memberDisplayName(selected, team, null, roles) : '';

  if (!work || team.length === 0) {
    return <div className="team-view team-view-empty">
      <div className="agent-idle"><div className="agent-symbol"><MessageSquare size={27} /></div>
        <h3>{t('team.view.emptyTitle')}</h3>
        <p className="footnote">{t('team.view.emptyBody')}</p>
      </div>
    </div>;
  }

  return <div className="team-view">
    {/* C1: EL ENCABEZADO DEL PEDIDO, NO DOS LÍNEAS DE CONTADORES.
        Sin `run` no se dibuja nada de esto: un Trabajo sin equipo trabajando
        no tiene un pedido del que informar avance. */}
    {run && <RunHeader run={run} title={props.work?.title || t('coord.run.untitled')}
      coordinatorName={run.coordinatorMemberId ? memberDisplayName(run.coordinatorMemberId, team, null, roles) : ''}
      tasks={props.coordinationTasks} asks={props.coordinationAsks} team={team} roles={roles}
      busy={props.busy} pending={props.pending} formatTime={props.formatTime}
      onPause={props.onPauseCoordination} onResume={props.onResumeCoordination} onCancel={props.onCancelCoordination}
      onNewRequest={props.onNewRequest} />}
    <div className="team-view-columns">
      {/* C2: LA MISMA ANATOMÍA QUE TODA FILA DEL PRODUCTO.
          Avatar con punto · nombre · qué hace ahora · cuándo. La fila ES la
          acción (criterio 4): un `<button>` entero, sin un "Abrir chat"
          repetido al costado de cada nombre. El chip con la palabra
          ("conectado", "arrancando") se fue: el estado es el punto
          (criterio 5), y lo que el runtime confirmó o no sigue dicho —
          entero, con su frase larga— al pie, en modo avanzado. */}
      <ul className="team-inbox team-view-list" aria-label={t('coord.list.label')}>
        {team.map((member) => {
          const signal = memberSignal({ ...input, team, roles, run, taskTitle }, member.id);
          const waiting = pendingForMember(member.id, props.coordinationGates, props.coordinationAsks, run);
          const isCoordinator = run?.coordinatorMemberId === member.id;
          return <li key={member.id} className={'team-inbox-row' + (member.id === selected ? ' is-selected' : '')} data-member-id={member.id}>
            <CoordRow
              name={member.roleName}
              roleId={member.roleId}
              dot={signal.dot}
              nameIcon={isCoordinator ? <Users size={12} className="coord-row-coordinator" aria-label={t('coord.member.coordinator')} /> : undefined}
              line={signal.line}
              urgent={signal.urgent}
              at={signal.at}
              time={signal.at ? hour(signal.at) : ''}
              badge={waiting}
              selected={member.id === selected}
              onClick={() => props.onSelectMember(member.id)}
            />
          </li>;
        })}
      </ul>
      <div className="team-view-thread">
        <div className="document-kicker team-view-thread-title">{openName}</div>
        <ol className="team-thread">
          {thread.length === 0
            ? <li className="team-thread-empty">{t('team.inbox.threadEmpty')}</li>
            : thread.map((event) => <li key={event.id} className="team-thread-row" data-kind={event.kind}>
                <span className="team-thread-text">{describeInboxEvent(event, team, roles)}</span>
                <time dateTime={event.at}>{when(event.at)}</time>
              </li>)}
        </ol>
      </div>
    </div>
    {props.mode === 'advanced' && <TeamAdvanced {...props} />}
  </div>;
}

/**
 * El presupuesto de este Trabajo, con sus TRES estados separados. `invalid` no
 * es `unset`: decir "sin presupuesto configurado" sobre bytes rotos manda a la
 * persona a buscar un campo vacío que en realidad tiene algo adentro, mientras
 * el motor deniega cada despacho contra esos mismos bytes.
 */
function describeWorkBudget(view: CoordinationBudgetView | undefined): string {
  if (view == null || view.state === 'unset') return t('coordination.budget.unset');
  if (view.state === 'invalid') return t('coordination.budget.invalid');
  if (view.budget.maxDispatches == null) return t('coordination.budget.unlimited');
  return t('coordination.budget.limited', { count: view.budget.maxDispatches });
}

/**
 * El editor del tope de este Trabajo, con el MISMO patrón que Ajustes usa para
 * el tope global: un `number`, un botón, y ninguna forma de guardar algo que
 * el validador vaya a rechazar.
 *
 * Se ofrece en los TRES estados a propósito. `unset` es obvio; `set` porque un
 * tope que no se puede cambiar es una trampa, no un ajuste; e `invalid` sobre
 * todo — ese es el estado donde cada despacho ya se está denegando y la
 * pantalla promete que escribirlo de nuevo lo arregla.
 */
function WorkBudgetEditor({ onSave }: { onSave: (maxDispatches: number) => void }) {
  const [draft, setDraft] = useState('');
  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed > 0;
  return <div className="team-advanced-budget-edit">
    <label className="field-label">{t('coordination.budget.editLabel')}
      <input className="team-advanced-budget-input" type="number" min={1} value={draft} onChange={(e) => setDraft(e.target.value)} />
    </label>
    <button className="team-advanced-budget-save" disabled={!valid} onClick={() => { if (valid) { onSave(parsed); setDraft(''); } }}>{t('coordination.budget.save')}</button>
  </div>;
}

/** Una fila por miembro con las DOS políticas, dichas aparte — nunca un veredicto combinado. */
function SupportRow({ row, team }: { row: CoordinationMemberSupport; team: readonly TeamMember[] }) {
  // B2.2: la fila de `support` no trae `roleId`, así que cuando el miembro ya
  // no está la cadena termina en la frase. El id queda en `data-member-id`,
  // que es para depurar, no para leer.
  const name = memberDisplayName(row.memberId, team);
  /**
   * C2: LA VERSIÓN DE UNA PALABRA SE MUDÓ ACÁ.
   *
   * Vivía al lado del nombre en la pestaña del chat y en la fila del modo
   * Equipo, donde es una FRASE adentro de una pastilla —lo que el criterio 5
   * prohíbe— repitiendo en palabras lo que el punto ya dice. Acá no compite
   * con nada: éste es el panel técnico, plegado, en modo avanzado, y la
   * palabra corta es lo que hace escaneable una lista de miembros.
   */
  const state = memberCoordinationState(row);
  return <li className="team-support-row" data-member-id={row.memberId}>
    <strong>{name}</strong>
    <span className={'team-member-state ' + state.className} data-state={state.state} title={state.title}>{state.label}</span>
    <p className="team-support-coordination">{describeCoordinationSupport(row)}</p>
    <p className="team-support-memory">{describeMemorySupport(row)}</p>
  </li>;
}

/**
 * B1.3 / B3.1: LA CONFIGURACIÓN DEL EQUIPO, AL PIE Y EN MODO AVANZADO.
 *
 * El tope de despachos, la autoridad y el coordinador no son decisiones de
 * marca: son cómo trabaja ESTE equipo. Vivían al pie del panel del chat, donde
 * competían por el mismo alto que la conversación; desde B3.1 viven al pie de
 * la vista que es del equipo. En modo simple no se renderizan — la persona pide
 * en el chat y aprueba en el chat.
 */
function TeamAdvanced(props: TeamViewProps) {
  const coordinatorName = props.coordinatorGrant
    ? memberDisplayName(props.coordinatorGrant, props.team, null, props.roles)
    : null;
  return <details className="team-advanced">
    <summary>{t('team.advanced.title')}</summary>
    {props.coordinationAuthority !== undefined && <>
      <label className="field-label" htmlFor="team-coordination-authority">{t('team.advanced.authority')}</label>
      {/* Sin handler no se ofrece un `<select>` que no guarda nada: se lee. */}
      {props.onSetCoordinationAuthority
        ? <select id="team-coordination-authority" className="team-advanced-authority" value={props.coordinationAuthority} onChange={e => props.onSetCoordinationAuthority!(e.target.value as CoordinationAuthorityMode)}>
            <option value="manual">{t('coordination.authority.manual')}</option>
            <option value="plan">{t('coordination.authority.plan')}</option>
            <option value="auto">{t('coordination.authority.auto')}</option>
          </select>
        : <p className="team-advanced-authority">{t(`coordination.authority.${props.coordinationAuthority}` as 'coordination.authority.manual')}</p>}
    </>}
    <p className="team-advanced-budget">{describeWorkBudget(props.coordinationBudget)}</p>
    {/* Q6/O5: el presupuesto del RUN EN CURSO, cuando es ilegible. Sólo con el
        equipo vivo: con el run terminado ya no se deniega ni se va a denegar
        ningún despacho, y la frase del presupuesto del TRABAJO habla de otros
        bytes. El editor de abajo escribe los dos. */}
    {props.coordinationRun?.active && props.coordinationRun.budgetInvalid
      && <p className="team-advanced-run-budget-invalid">{t('coordination.budget.runInvalid')}</p>}
    {props.onSetCoordinationBudget && <WorkBudgetEditor onSave={props.onSetCoordinationBudget} />}
    {/* Las dos políticas de inyección, por miembro y ENTERAS. Al lado del
        nombre vive la versión de una palabra; el detalle completo — y la línea
        de memoria, que es independiente de la de coordinación — vive acá,
        donde hay lugar para decirlo sin taparle la conversación a nadie. */}
    {(props.coordinationSupport?.length ?? 0) > 0 && <ul className="team-support">
      {props.coordinationSupport!.map(row => <SupportRow key={row.memberId} row={row} team={props.team} />)}
    </ul>}
    <p className="team-advanced-coordinator">
      {coordinatorName ? t('coordination.coordinator.assigned', { name: coordinatorName }) : t('coordination.coordinator.none')}
    </p>
  </details>;
}
