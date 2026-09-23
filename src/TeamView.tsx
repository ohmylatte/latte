import { useState } from 'react';
import { translate as t } from './i18n';
import { MessageSquare, UserPlus, Users } from 'lucide-react';
import type {
  AgentRole, ChatMessage, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudgetView,
  CoordinationGateView, CoordinationHireView, CoordinationLogEntryView, CoordinationMemberSupport,
  CoordinationMessageView, CoordinationRunTaskView, CoordinationRunView, TeamMember, Work,
} from '../shared/contracts';
import type { ChatCoordinationProps } from './ChatPane';
import { ChatComposer } from './ChatComposer';
import { TeamCardsCollapsible } from './coordination/TeamCards';
import { describeCoordinationSupport, describeMemorySupport, memberCoordinationState, type LatteMode } from './TeamPanel';
import { inboxEvents, pendingForMember } from './coordination/inbox';
import { RunHeader } from './coordination/RunHeader';
import { MemberDetail } from './coordination/MemberDetail';
import { CoordAvatar, CoordRow } from './coordination/anatomy';
import { avatarOfMember } from './coordination/avatar-of';
import { EmptyTeam, RunOutput } from './coordination/TeamOutcome';
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
  /** C4: contestar una pregunta abierta desde el detalle del miembro que la hizo. */
  onAnswerAsk?: (askId: string, answer: string) => void;
  /** C4: el instante contra el que se cuenta "vence en N min". Inyectable para los tests. */
  now?: number;
  /** C5: empezar otro pedido, o pedir el primero: abre el chat del coordinador. */
  onNewRequest?: () => void;
  /** C5: abre el flujo de alta que ya existe. Sin handler, la fila no se ofrece. */
  onAddMember?: () => void;
  coordinationSupport?: readonly CoordinationMemberSupport[];
  formatDate?: (value: string) => string;
  /** B3.1: la configuración del equipo, que bajó del panel a esta vista. */
  coordinationAuthority?: CoordinationAuthorityMode;
  onSetCoordinationAuthority?: (mode: CoordinationAuthorityMode) => void;
  coordinationBudget?: CoordinationBudgetView;
  onSetCoordinationBudget?: (maxDispatches: number) => void;
  coordinatorGrant?: string | null;
  /**
   * EL CHAT DE EQUIPO: a quien le llega lo que se escribe abajo.
   *
   * Es el coordinador del run; sin run, el coordinador designado del trabajo o
   * el Asistente. No hay destinatario que elegir y no existe un "a todos": el
   * coordinador ES el "a todos" — le pedis al equipo y el despacha. Sin esto
   * cableado el modo Equipo no dibuja composer, que es como estaba.
   */
  composer?: {
    /** La sesion destino. En Latte el id de un chat ES el id de su miembro. */
    sessionId: string;
    onError: (error: string) => void;
    onAttachFiles?: () => Promise<string[]>;
    /** Despierta al destinatario cuando no tiene proceso vivo (cerrar un run lo apaga). */
    onBeforeSend?: () => Promise<void>;
  };
  /**
   * La conversacion del coordinador con la persona, para intercalarla por hora
   * en su linea de tiempo. Sale del store del chat, que es de quien navega.
   */
  coordinatorChat?: readonly ChatMessage[];
  /**
   * Las tarjetas del equipo —propuesta, presupuesto, despacho, pregunta—, que
   * salian en el chat del coordinador y ahora salen donde vive esa
   * conversacion. Es el MISMO paquete que recibe `ChatPane`.
   */
  chatCoordination?: ChatCoordinationProps;
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
  const hour = (at: string) => (props.formatTime ? props.formatTime(at) : hourOf(at));
  /**
   * C2: el titulo de una tarea sale del PLAN, no del prompt del despacho.
   * El prompt es lo que el coordinador le escribio al miembro; el titulo es
   * lo que la persona pidio. Sin tareas cableadas, la fila cae en el prompt,
   * que es lo que ya habia.
   */
  const taskTitle = (taskId: string) => titleOf((props.coordinationTasks ?? []).find((task) => task.id === taskId)?.spec);
  /**
   * QUIEN COORDINA, RESUELTO UNA VEZ.
   *
   * El del run manda; sin run, el permiso del trabajo. Es quien recibe lo que
   * se escribe abajo y el unico cuyo hilo trae tambien su conversacion.
   */
  const coordinatorId = run?.coordinatorMemberId ?? props.coordinatorGrant ?? null;
  const readingCoordinator = Boolean(selected && selected === coordinatorId);
  // La conversacion entra SOLO en el hilo del coordinador: los demas la tienen
  // en su propia pestana, y meterla en los dos seria la misma charla dos veces.
  const thread = selected ? inboxEvents(readingCoordinator ? { ...input, chat: props.coordinatorChat } : input, selected) : [];
  const coordinatorName = run?.coordinatorMemberId
    ? memberDisplayName(run.coordinatorMemberId, team, null, roles)
    : (props.coordinatorGrant ? memberDisplayName(props.coordinatorGrant, team, null, roles) : '');
  /**
   * C5: el vacio manda MIENTRAS la persona no haya abierto a nadie. Abrir un
   * miembro es una decision suya, y taparsela con la pantalla de bienvenida
   * seria decidir por ella.
   */
  const openedMember = Boolean(props.selectedMemberId && team.some((m) => m.id === props.selectedMemberId));

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
              avatar={avatarOfMember(member)}
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
        {/* C5: SUMAR UN ROL ES UNA FILA MÁS, con la misma anatomía y el avatar
            punteado. Abre el flujo de alta que ya existe; sin handler no se
            ofrece un botón que no abre nada. */}
        {props.onAddMember && <li className="team-inbox-row coord-add-row">
          <button type="button" className="coord-row coord-add" onClick={props.onAddMember}>
            <CoordAvatar name="" dot="none"><UserPlus size={14} /></CoordAvatar>
            <span className="coord-row-text"><span className="coord-row-name">{t('coord.empty.addRole')}</span></span>
          </button>
        </li>}
      </ul>
      {/* C3: EL DETALLE DE UN MIEMBRO ES UNA LÍNEA DE TIEMPO, NO UNA LISTA DE
          RENGLONES IGUALES. El ícono hace el sustantivo, la palabra agrega lo
          específico, y lo último va arriba.

          C5: y el panel derecho cambia con el estado del pedido. Sin run es el
          vacío con propósito; con el run terminado, lo que el equipo dejó. */}
      <div className="team-view-thread">
        {!run && !openedMember && <EmptyTeam coordinatorName={coordinatorName} onAsk={props.onNewRequest} />}
        {run && !run.active && <RunOutput run={run} log={props.coordinationLog} team={team} roles={roles} formatTime={hour} />}
        {(run?.active || openedMember) && selected && <MemberDetail memberId={selected} team={team} roles={roles} run={run}
          events={thread} tasks={props.coordinationTasks}
          signal={memberSignal({ ...input, team, roles, run, taskTitle }, selected)}
          formatTime={hour} onOpenChat={readingCoordinator ? undefined : props.onOpenChat}
          openAsks={(props.coordinationAsks ?? []).filter((ask) => ask.memberId === selected && (run == null || run.active))}
          onAnswerAsk={props.onAnswerAsk} pending={props.pending} now={props.now} />}
      </div>
    </div>
    {/* Las tarjetas del equipo, arriba del composer y fuera del scroll de la
        lista, por el mismo motivo que en el chat de un miembro: una aprobacion
        que se va hacia arriba con los mensajes es una aprobacion que nadie ve. */}
    {props.chatCoordination && coordinatorId && <TeamCardsCollapsible
      memberId={coordinatorId}
      coordinationRun={props.chatCoordination.coordinationRun}
      gates={props.chatCoordination.gates}
      openAsks={props.chatCoordination.openAsks}
      roles={roles}
      team={team}
      formatDate={props.formatDate}
      onResolveGate={props.chatCoordination.onResolveGate}
      onAnswerAsk={props.chatCoordination.onAnswerAsk}
      pending={props.chatCoordination.coordinationPending}
      onSelectMember={props.onSelectMember}
      formatTime={props.formatTime}
      now={props.now}
      /* "Ver equipo" no se ofrece: ya estas en el equipo. */
      teamSeen={props.chatCoordination.teamSeen}
      initiallyExpanded={props.chatCoordination.initiallyExpanded}
    />}
    {/* EL COMPOSER, AL PIE. Un mensaje aca va al coordinador: eso es hablarle
        al equipo. Hablarle a UNO sigue siendo su hilo, que se abre de la lista. */}
    {props.composer && <ChatComposer className="team-view-composer" sessionId={props.composer.sessionId}
      onError={props.composer.onError} onAttachFiles={props.composer.onAttachFiles}
      onBeforeSend={props.composer.onBeforeSend} />}
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
