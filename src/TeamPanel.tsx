import { currentLocale, translate as t, type MessageKey } from './i18n';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, CircleAlert, CircleCheck, FolderCheck, FolderLock, Forward, LoaderCircle, MessageSquare, MessageSquarePlus, Pause, Play, Plug, Plus, Settings2, Trash2, UserPlus, Users, X, Zap } from 'lucide-react';
import { DEFAULT_EFFORT_TIER, EFFORT_TIERS, type AgentModelList, type AgentRole, type BrandMember, type WorkPermissionMode, type ChatRuntime, type ChatSession, type CoordinationAskView, type CoordinationAuthorityMode, type CoordinationBudgetView, type CoordinationDegradedReason, type CoordinationGateView, type CoordinationHireView, type CoordinationLogEntryView, type CoordinationMemberSupport, type CoordinationMessageView, type CoordinationRunTaskView, type CoordinationRunView, type EffortTier, type HandoffRequest, type TeamMember, type TeamMemberOptions, type TeamMemberStatus, type Work } from '../shared/contracts';
import { api, chatStore } from './browser-api';
import { ChatPane, type ChatCoordinationProps } from './ChatPane';
import { useChatState } from './chat-store';
import { canChangePermission } from './permission-ux';
import { continuationModel, continuationOptions, type ContinuationTarget } from './provider-models';
import { contextWeight, describeUsage, formatTokens, totalTokens } from './usage-format';
import { Loading } from './brand-marks';
import { pendingForMember, pendingForWork } from './coordination/inbox';
import { roleSummary } from './pack-i18n';
import { CoordAvatar, CoordTime } from './coordination/anatomy';
import { Avatar } from './coordination/Avatar';
import { avatarOfMember } from './coordination/avatar-of';
import { parseAvatar } from '../shared/avatar';
import { memberSignal, type MemberDot } from './coordination/member-line';
import { hourOf } from './coordination/time';
import { titleOf } from './coordination/text';
import { TeamView } from './TeamView';

/** A runtime the user can pick for a new member instead of the primary agent. */
export interface RuntimeChoice { key: string; label: string; runtime: ChatRuntime; accountId: string | null }

/**
 * How dense the interface is. `simple` hides the inline technical controls
 * (model, effort, runtime tooltip, active-context footnote); `advanced` shows
 * them. Owned here because TeamPanel is where the gating happens.
 */
export type LatteMode = 'simple' | 'advanced';

export interface TeamPanelProps {
  work: Work | null;
  team: TeamMember[];
  /** Live sessions by chat id (= member id). */
  chats: Record<string, ChatSession>;
  selectedId: string | null;
  roles: AgentRole[];
  primaryLabel: string;
  primaryDetail: string;
  primaryReady: boolean;
  /** The runtimes are still being detected: the list of agents is not empty, it is unknown. */
  checking: boolean;
  /** Runtime the primary agent uses; the folder grant only changes anything for Claude. */
  primaryRuntime: ChatRuntime;
  /** Account of the primary agent, so a continuation can default to a different one. */
  primaryAccountId: string | null;
  /** Model saved for the primary agent: where a continuation on it starts when the source ran on another runtime. */
  primaryModel: string | null;
  choices: RuntimeChoice[];
  busy: boolean;
  isDesktop: boolean;
  /** How dense the team panel is: `simple` hides the inline technical controls. */
  mode: LatteMode;
  onSelect: (memberId: string) => void;
  onAdd: (roleId: string, options: TeamMemberOptions | null) => Promise<void>;
  /**
   * El plantel de la marca (esquema 14). "Sumar un rol" en un trabajo muestra
   * primero a los que todavía no están en él; elegir uno lo convoca con
   * `onCallUp`. Sin esto, el diálogo de siempre.
   */
  roster?: readonly BrandMember[];
  onCallUp?: (brandMemberId: string) => Promise<void>;
  onOpen: (memberId: string) => Promise<void>;
  onPause: (memberId: string) => Promise<void>;
  onFinish: (memberId: string) => Promise<void>;
  onRestart: (memberId: string) => Promise<void>;
  /** Creates a member that continues another one, with the reviewed hand-over as its first message. Rejects when nothing was created. */
  onContinue: (sourceId: string, roleId: string, options: TeamMemberOptions | null, text: string) => Promise<void>;
  /** Roles one agent asked for; the human decides whether any conversation opens. */
  handoffs: HandoffRequest[];
  onAcceptHandoff: (handoff: HandoffRequest) => Promise<void>;
  /**
   * B4.1: EL TRASPASO DURANTE UNA COORDINACION NO PASA POR LA PERSONA.
   *
   * Aditivo y opcional: sin esta prop el aviso se comporta exactamente como
   * estaba. Con un run VIVO la accion primaria deja de prellenar el borrador
   * del otro miembro --que dejaba a la persona apretando enviar en el medio de
   * un circuito que ya estaba andando-- y pasa a crear la tarea y despacharla
   * con la autoridad del run (`acceptHandoffAsTask`). Sin run vivo, nada
   * cambia.
   */
  onAcceptHandoffAsTask?: (handoff: HandoffRequest) => Promise<void>;
  /**
   * H1: QUÉ PASÓ CUANDO LATTE INTENTÓ PUENTEAR CADA TRASPASO SOLO, por nombre
   * de archivo. Aditivo: sin esta prop el aviso se comporta como antes.
   *
   * - sin entrada: el puente está en vuelo, y el aviso NO se dibuja — no hay
   *   nada que ofrecer, y el botón viejo prellenaría el borrador;
   * - `null`: la coordinación está apagada, vuelve el aviso de siempre;
   * - un motivo: no se pudo; el aviso dice por qué —en palabras, ya
   *   resuelto por el contenedor (M3: nunca un código)— y ofrece reintentar
   *   el puente, NUNCA el borrador.
   */
  handoffHolds?: Record<string, { text: string; detail: string | null } | null>;
  /** H1: el rol de la propuesta que nació de un traspaso y espera un sí. Dibuja "Propuesta lista · Aprobar". */
  handoffProposal?: string | null;
  /** H1: la línea lleva a la tarjeta DESPLEGADA: el contenedor sabe abrirla como "vengo de un pendiente". */
  onOpenHandoffProposal?: () => void;
  onDismissHandoff: (handoff: HandoffRequest) => Promise<void>;
  onRemove: (memberId: string) => Promise<void>;
  onProviders: () => void;
  onRecheck: () => void;
  /** Changes the model of one conversation; the runtime restarts and resumes underneath. */
  onModel: (memberId: string, model: string | null) => void;
  /** Changes how hard one conversation works per answer; same mechanics as onModel. */
  onTier: (memberId: string, tier: EffortTier) => void;
  onError: (message: string) => void;
  /** Turns an answer into a document of the work. */
  onSaveAsDocument?: (text: string) => void;
  /** Copies client material into this work so the active agent can read it. */
  onAttachFiles: () => Promise<string[]>;
  /** Files the agent left in the folder that are not documents yet. */
  untracked: string[];
  onAdoptFile: (fileName: string) => void;
  /** How much this work's team may do without asking. */
  permissions: WorkPermissionMode;
  /** Only the permission mutation is pending; chat activity must not disable this control. */
  permissionBusy: boolean;
  onPermissions: (mode: WorkPermissionMode) => void;
  /**
   * Additive, optional (autonomous-coordination Phase 7 task 7.7): `undefined`
   * or `null` means no active run to pause — the control does not render, so
   * an unwired caller sees zero change. `pauseCoordinationRun` already exists
   * (Phase 3); this is UI only. Pausing lets the in-flight dispatch finish
   * and report; no new dispatch starts.
   */
  coordinationRun?: CoordinationRunView | null;
  onPauseCoordination?: (runId: string) => void;
  /**
   * La vuelta de la pausa, en el MISMO control que la ofrece. Pausar hacía
   * desaparecer su propio botón y dejaba el run `suspended` para siempre:
   * `findActiveCoordinationRun` bloqueaba todo run futuro de ese Trabajo y el
   * run seguía ocupando uno de los cuatro cupos app-wide, sin ninguna salida.
   */
  onResumeCoordination?: (runId: string) => void;
  onCancelCoordination?: (runId: string) => void;
  /**
   * Additive, optional (juicio ronda 4, ítem 14): `useCoordination`'s
   * per-action in-flight flags, keyed `run:<runId>` for the pause/resume/
   * cancel trio. `undefined` disables nothing, same as every other additive
   * coordination prop here. `busy` (the app-wide flag above) never covered
   * this: a mutation issued through `useCoordination` does not touch it, so
   * the run-control buttons stayed clickable for the whole time a pause/
   * resume/cancel was in flight.
   */
  pending?: Record<string, boolean>;
  /**
   * Lo que la coordinacion le pide al chat del miembro seleccionado.
   * Opcional y aditivo: sin esto el chat se dibuja exactamente como estaba.
   */
  chatCoordination?: ChatCoordinationProps;
  /**
   * EL BUZON DEL EQUIPO (B1.2). Todo aditivo: sin estas props el panel se
   * dibuja exactamente como estaba.
   *
   * La bitacora, los mensajes entre miembros, las preguntas y las altas son
   * las CUATRO fuentes de "que le paso a cada uno". Se pasan crudas y la
   * derivacion vive en `./coordination/inbox`, sin React: la linea de cada
   * miembro se puede probar sin montar medio panel.
   */
  coordinationLog?: readonly CoordinationLogEntryView[];
  coordinationMessages?: readonly CoordinationMessageView[];
  coordinationAsks?: readonly CoordinationAskView[];
  coordinationHires?: readonly CoordinationHireView[];
  /** Los gates del run: el contador de pendientes de la pestana del coordinador. */
  coordinationGates?: readonly CoordinationGateView[];
  /** C1: las tareas del run, para la tira del encabezado del modo Equipo. */
  coordinationTasks?: readonly CoordinationRunTaskView[];
  /** La hora local de un ISO, inyectable para los tests. */
  formatTime?: (value: string) => string;
  /** C4: el instante contra el que se cuenta "vence en N min". Inyectable para los tests. */
  now?: number;
  formatDate?: (value: string) => string;
  /**
   * B1.3: EL ESTADO DE COORDINACION POR MIEMBRO, CORTO.
   *
   * `coordinationRuntimeSupport` dice, por miembro, si el runtime confirmo lo
   * que Latte le pidio inyectar. Esa informacion vivia en Decisiones como un
   * parrafo de dos lineas por miembro ("el runtime todavia no confirmo la
   * coordinacion: Latte la pidio, falta que el agente diga que la levanto").
   * Aca se dice en una palabra al lado del nombre; la frase larga sigue
   * existiendo, en el `title`.
   */
  coordinationSupport?: readonly CoordinationMemberSupport[];
  /**
   * B3.1: LOS AJUSTES DEL EQUIPO. No los dibuja el panel: viajan a `TeamView`,
   * que es el modo Equipo de esta misma columna, y viven al pie de esa vista.
   */
  coordinationAuthority?: CoordinationAuthorityMode;
  onSetCoordinationAuthority?: (mode: CoordinationAuthorityMode) => void;
  coordinationBudget?: CoordinationBudgetView;
  onSetCoordinationBudget?: (maxDispatches: number) => void;
  coordinatorGrant?: string | null;
  /**
   * Elegir quién coordina este trabajo desde el modo Equipo: escribe el permiso
   * del trabajo. Con un run activo el botón no se aprieta (manda el del run).
   */
  onSetCoordinator?: (memberId: string) => void;
}

const RUNTIME_SHORT: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude', codex: 'Codex' };
/**
 * El rol neutral que siempre esta (`electron/agents/roles.ts`): sin run y sin
 * permiso de coordinacion, es a quien le llega lo que se escribe en el modo
 * Equipo, porque es el unico que puede pedir coordinacion.
 */
const ASSISTANT_ROLE = 'assistant';

/**
 * QUIÉN COORDINA ESTE TRABAJO — el que se lleva la tira y el modo Equipo.
 *
 * El del run si ese miembro EXISTE en el equipo; si no, el coordinador
 * designado del Trabajo, con la misma condición; y si la copia local del
 * permiso todavía no llegó, el miembro que `listTeam` trae marcado
 * (`coordinates`), que es ESE mismo permiso ya fijado en el backend
 * (`LatteService.effectiveCoordinator`). Acá no se recalcula ningún descarte:
 * recalcularlo en cada render es lo que hacía que sumar al Asistente le sacara
 * la coordinación a quien la tenía.
 *
 * Ese "tiene que existir" es el bug entero: con un run cancelado cuyo
 * coordinador ya estaba borrado, la vista fijaba un coordinador fantasma. El
 * composer le escribía al Asistente por su propio fallback y el hilo miraba a
 * nadie, así que el Asistente trabajaba y contestaba mientras la pantalla
 * decía "Sin novedades".
 *
 * Un run TERMINADO cuyo coordinador sigue en el equipo sí lo fija, y a
 * propósito: cerrar un run no borra la conversación en la que se pidió, y ese
 * hilo es donde la persona vuelve a buscarla.
 */
export function teamCoordinator(
  team: readonly TeamMember[],
  run: CoordinationRunView | null | undefined,
  grant: string | null | undefined,
): string | null {
  const inTeam = (id: string | null | undefined) => (id && team.some(m => m.id === id) ? id : null);
  return inTeam(run?.coordinatorMemberId) ?? inTeam(grant) ?? team.find(m => m.coordinates)?.id ?? null;
}

/**
 * Y a quién le llega lo que se escribe abajo: el coordinador; sin ninguno el
 * Asistente, que es el rol que siempre está y el único que puede pedir
 * coordinación; y sin él el primero del equipo — el cuadro de texto nunca
 * escribe al vacío.
 *
 * Esos dos últimos eslabones NO sacan a nadie de la tira, y es la diferencia
 * que importa: un Trabajo sin run y sin permiso no tiene coordinador, tiene
 * miembros. Sus pestañas siguen donde estaban y su conversación sigue siendo
 * suya; lo único que esto decide ahí es a quién le llega el mensaje si la
 * persona igual escribe en el modo Equipo — y de quién es, entonces, el hilo
 * que ese modo tiene que mostrar.
 */
export function teamChatTarget(
  team: readonly TeamMember[],
  run: CoordinationRunView | null | undefined,
  grant: string | null | undefined,
): string | null {
  return teamCoordinator(team, run, grant)
    ?? team.find(m => m.roleId === ASSISTANT_ROLE)?.id
    ?? team[0]?.id
    ?? null;
}

/**
 * The work's team: one row per role opened in this work, the selected one's
 * conversation underneath. Status is live for open members (from the chat
 * store) and persisted for the rest (paused / finished).
 */
export function TeamPanel(props: TeamPanelProps) {
  const { work, team, chats, selectedId, roles, busy, isDesktop, mode } = props;
  const [adding, setAdding] = useState(false);
  // Member whose work is being handed over; the dialog stays tied to it.
  const [continuing, setContinuing] = useState<string | null>(null);
  /**
   * B3.1: EL MODO DE ESTA COLUMNA.
   *
   * El equipo no es una pestana de CONTEXTO del Trabajo (Resumen, Evidencia,
   * Documentos son eso: lo que permanece). Trabajar en equipo es acotado y a
   * pedido, y necesita el mismo alto que la conversacion, no un pedazo
   * apilado encima. Asi que es un MODO de esta misma columna: o la
   * conversacion, o el equipo, nunca los dos peleandose el alto.
   */
  const [railChoice, setRailChoice] = useState<'chat' | 'team'>('chat');
  /** Que miembro se esta leyendo en el modo Equipo. `null` cae en el coordinador, y sin run en el primero. */
  const [threadMember, setThreadMember] = useState<string | null>(null);
  useEffect(() => { setAdding(false); setContinuing(null); setRailChoice('chat'); setThreadMember(null); }, [work?.id]);
  /**
   * H1: EL RAIL ES QUIEN SABE QUE EL EQUIPO SE ABRIO.
   *
   * "Ver equipo", el segmento Conversacion|Equipo y "Ver hilo" son tres
   * puertas al MISMO modo, y las tres tienen que apagar el aviso del plan
   * aprobado. En vez de colgar el aviso de cada `onClick` —que es la forma de
   * olvidarse de la cuarta puerta— se cuelga del ESTADO: si el rail quedo en
   * Equipo, el equipo esta abierto, haya entrado por donde haya entrado.
   */
  /**
   * EL RAIL ES "UNO VS EL EQUIPO", NO "CONVERSACION VS EQUIPO".
   *
   * El coordinador era una pestaña más en una tira que no lo esperaba: la vida
   * del equipo estaba en la otra mitad del rail y sin manera de escribir, así
   * que se miraba en un lado y se escribía en el otro. Ahora su conversación ES
   * el modo Equipo, y la tira queda para los que no coordinan.
   *
   * Elegirlo por cualquier camino —Inicio, la tira de equipos activos, "Nuevo
   * pedido"— aterriza acá, sin que ninguno de esos caminos tenga que saber que
   * existe un rail: el rail es de este componente, así que la regla vive acá.
   */
  const coordinatorId = teamCoordinator(team, props.coordinationRun, props.coordinatorGrant);
  const teamChatTargetId = teamChatTarget(team, props.coordinationRun, props.coordinatorGrant);
  const memberTabs = team.filter(m => m.id !== coordinatorId);
  const coordinatorSelected = Boolean(coordinatorId && selectedId === coordinatorId);
  // Sin nadie más que el coordinador no hay "uno" con quien hablar: el modo
  // Equipo ES la pantalla, y el toggle recién aparece con más de uno.
  const teamOnly = Boolean(coordinatorId) && memberTabs.length === 0 && team.length > 0;
  const rail: 'chat' | 'team' = coordinatorSelected || teamOnly ? 'team' : railChoice;
  /** Volver a "uno": si lo que estaba abierto era el coordinador, se elige a alguien con quien hablar. */
  const showChat = () => {
    setRailChoice('chat');
    if (coordinatorSelected && memberTabs[0]) props.onSelect(memberTabs[0].id);
  };
  const showTeam = () => setRailChoice('team');
  // Aterrizar en el coordinador es aterrizar en SU hilo, no en el del miembro
  // que se estuviera leyendo antes en el modo Equipo.
  useEffect(() => { if (coordinatorSelected) setThreadMember(null); }, [coordinatorSelected]);
  const onTeamOpened = props.chatCoordination?.onTeamOpened;
  const railRunId = props.coordinationRun?.id ?? null;
  useEffect(() => { if (rail === 'team') onTeamOpened?.(); }, [rail, railRunId]);
  const selected = team.find(m => m.id === selectedId) ?? null;
  const continuingMember = team.find(m => m.id === continuing) ?? null;
  const liveChat = selected ? chats[selected.id] ?? null : null;
  const selectedState = useChatState(chatStore, liveChat?.id ?? null);
  const selectedLive = Boolean(liveChat) && !selectedState.closed;
  const selectedStatus: TeamMemberStatus = selectedLive ? (selectedState.status === 'idle' ? 'idle' : 'working') : selected?.status === 'ended' ? 'ended' : 'paused';
  const activity = useTeamActivity(team, chats);
  // La conversación del coordinador, para que su línea de tiempo la traiga
  // intercalada por hora con los hechos del run. Es una sola lista.
  const coordinatorState = useChatState(chatStore, teamChatTargetId);
  /**
   * Y SI EL COORDINADOR ESTA PAUSADO, SE PIDE SU TRANSCRIPTO.
   *
   * Pausar a un miembro hace `chatStore.forget`, y cerrar un run pausa al
   * coordinador: el renderer se queda sin una sola linea de su conversacion.
   * Mientras su chat era una pestana mas eso se arreglaba solo —abrirla llamaba
   * a `openMember`, que sincroniza—, pero desde que su conversacion ES el modo
   * Equipo, el mismo olvido deja un vacio que MIENTE: el equipo termino y lo
   * que se hablo no esta en ningun lado.
   *
   * Sin reabrir nada: `listChatMessages` contesta con lo que Latte guarda
   * cuando no hay adaptador vivo. Y solo cuando NO hay sesion viva — con una
   * abierta el store ya viene alimentado por eventos, y re-sincronizar encima
   * de un turno en vuelo le pisaria el mensaje que se esta escribiendo.
   */
  const liveCoordinator = Boolean(teamChatTargetId && chats[teamChatTargetId]);
  const runStatus = props.coordinationRun?.status ?? null;
  useEffect(() => {
    if (rail !== 'team' || !teamChatTargetId || liveCoordinator) return;
    void chatStore.sync(teamChatTargetId).catch(() => undefined);
  }, [rail, teamChatTargetId, liveCoordinator, runStatus]);
  // The first team is the empty state itself; after that, adding is a dialog.
  const firstTeam = team.length === 0 && Boolean(work);
  const showPicker = adding || firstTeam;
  // Del plantel, sólo quien todavía no está en ESTE trabajo: a los demás ya
  // se los ve en la lista y se les habla por su hilo.
  const rosterPicker = work && props.onCallUp
    ? {
      roster: (props.roster ?? []).filter(m => !m.workIds.includes(work.id)),
      onCallUp: async (brandMemberId: string) => { await props.onCallUp!(brandMemberId); setAdding(false); },
    }
    : {};
  const workTotal = useTeamUsageTotal(team);
  /**
   * Lo que el Trabajo entero está esperando. Las preguntas NATIVAS del
   * destinatario (`AskUserQuestion`) cuentan igual que una `latte_ask`: son
   * dos canales distintos y una sola persona a la que le toca decidir. Sin
   * esto, el segmento decía "nada pendiente" con una pregunta abierta adentro.
   */
  const railPending = pendingForWork(props.coordinationGates, props.coordinationAsks, props.coordinationRun ?? null)
    + coordinatorState.questions.length;
  const inbox = { log: props.coordinationLog, messages: props.coordinationMessages, asks: props.coordinationAsks, hires: props.coordinationHires };
  /**
   * B4.1: las DOS condiciones, no una. `active` porque un run cerrado no puede
   * despachar nada, y la prop porque sin el puente cableado el boton estaria
   * prometiendo un despacho que nadie puede hacer.
   */
  const bridgeHandoffs = Boolean(props.coordinationRun?.active) && typeof props.onAcceptHandoffAsTask === 'function';
  /**
   * C5: "Pedirlo en el chat" y "Nuevo pedido" abren la conversacion del
   * coordinador. El rail lo maneja ESTE componente, asi que el salto vive aca
   * y no viaja como una prop que el contenedor tendria que inventar.
   */
  /**
   * C2: la MISMA derivacion que la lista del modo Equipo. La pestana y la fila
   * cuentan el mismo hecho; si cada una lo derivara por su cuenta, "la misma
   * anatomia" seria una intencion y no un hecho.
   */
  const taskTitle = (taskId: string) => titleOf((props.coordinationTasks ?? []).find(task => task.id === taskId)?.spec);
  const memberTabSignal = (memberId: string) => {
    const signal = memberSignal({ ...inbox, team, roles: props.roles, run: props.coordinationRun ?? null, taskTitle }, memberId);
    return {
      dot: signal.dot,
      lastExchange: signal.line,
      urgent: signal.urgent,
      at: signal.at,
      time: signal.at ? (props.formatTime ? props.formatTime(signal.at) : hourOf(signal.at)) : '',
    };
  };
  /**
   * "Nuevo pedido" y "Pedirlo en el chat" abren la conversación del
   * coordinador, que desde ahora ES el modo Equipo: no se salta a un rail
   * donde su pestaña ya no existe.
   */
  const openCoordinatorChat = () => {
    if (teamChatTargetId) props.onSelect(teamChatTargetId);
    setThreadMember(null);
    setRailChoice('team');
  };

  return <div className="team">
    {/* FUERA del guard `team.length > 0`: un run `planning` es exactamente el
        momento en el que el equipo todavía no tiene un solo miembro, y ahí los
        controles del run desaparecían enteros — la persona se quedaba sin
        ninguna salida justo cuando la coordinación recién arranca. */}
    <div className="team-rail-head">
      {/* B5.4: EN MODO EQUIPO ESTA LINEA LA DIBUJA `TeamView`, Y UNA SOLA VEZ.
          Los dos la renderizaban, asi que el modo Equipo mostraba las cuentas
          del run, el presupuesto y los botones de pausar/cancelar DOS VECES,
          una encima de la otra: dos "Cancelar equipo" distintos para el mismo
          run es una pantalla que no dice cual es cual. En modo conversacion
          `TeamView` no se dibuja, asi que ahi esta es la unica. */}
      {/* C7: EL ESTADO DEL RUN VIVE EN EL MODO EQUIPO, NO ACA.

          Las dos lineas de contadores arriba de la conversacion eran el
          deposito de texto que el rediseno saca: siete numeros y tres botones
          con la palabra escrita al lado del icono, compitiendo por el alto con
          lo unico que esa columna tiene que hacer. El encabezado del pedido
          --titulo, barra, presupuesto, salidas-- vive en el modo Equipo, a un
          clic del segmento de al lado.

          La UNICA excepcion es un equipo VACIO: sin miembros no hay modo
          Equipo al que ir (el toggle no se dibuja y la vista cae en su
          pantalla vacia), asi que un run que todavia esta planificando se
          quedaria sin ninguna salida. Ahi, y solo ahi, siguen aca. */}
      {rail === 'chat' && team.length === 0 && <CoordinationRunControls run={props.coordinationRun ?? null} busy={busy} pending={props.pending}
        onPause={props.onPauseCoordination} onResume={props.onResumeCoordination} onCancel={props.onCancelCoordination} />}
      {work && memberTabs.length > 0 && <div className="team-rail-modes" role="group" aria-label={t('team.rail.group')}>
        <button type="button" className={'team-rail-chat' + (rail === 'chat' ? ' selected' : '')} aria-pressed={rail === 'chat'} onClick={showChat}><MessageSquare size={13} />{t('team.rail.chat')}</button>
        {/* El contador es del TRABAJO entero: gates mas preguntas. No promete a
            quien le toca -- eso lo dice la lista de adentro --, promete que hay algo. */}
        <button type="button" className={'team-rail-team' + (rail === 'team' ? ' selected' : '')} aria-pressed={rail === 'team'} onClick={showTeam}><Users size={13} />{t('team.rail.team')}{railPending > 0 && <span className="team-rail-pending">{railPending}</span>}</button>
      </div>}
    </div>
    {work && props.handoffProposal && <div className="doc-banner handoff handoff-proposed" role="status">
      <UserPlus size={14} />
      <span>{t('handoff.proposed', { role: props.handoffProposal })}</span>
      <button className="primary" disabled={busy} onClick={() => { openCoordinatorChat(); props.onOpenHandoffProposal?.(); }}>{t('handoff.proposed.open')}</button>
    </div>}
    {work && props.handoffs.map(handoff => {
      const holds = props.handoffHolds;
      // H1: con el puente automático cableado, lo que el aviso ofrece lo decide
      // el motor (ver `handoffHolds`). Sin él, el aviso de siempre.
      if (holds && !(handoff.fileName in holds)) return null;
      const held = holds ? holds[handoff.fileName] : null;
      const retry = Boolean(held) && typeof props.onAcceptHandoffAsTask === 'function';
      // Con el puente automático y la coordinación apagada (`null`) vuelve el
      // borrador a pedido; sin la prop, lo de B4.1 tal cual.
      const asTask = bridgeHandoffs && !holds;
      return <div key={handoff.fileName} className="doc-banner handoff" role="status">
        <UserPlus size={14} />
        <span>{t('ui.auto.266')} <strong>{handoff.roleName}</strong> {t('handoff.wants')} <em>{handoff.request.split(/\r?\n/)[0].slice(0, 140)}</em>{handoff.known || held ? '' : t('handoff.unknownRole')}{held && <span className="handoff-reason"> — {held.text}{held.detail && <> <span className="handoff-reason-detail">{held.detail}</span></>}</span>}</span>
        {handoff.known && (retry
          ? <button className="primary" disabled={busy} onClick={() => void props.onAcceptHandoffAsTask!(handoff)}>{t('handoff.retry')}</button>
          : <button className="primary" disabled={busy} onClick={() => void (asTask ? props.onAcceptHandoffAsTask!(handoff) : props.onAcceptHandoff(handoff))}>{asTask ? t('handoff.dispatchAsTask') : t('ui.auto.267')}</button>)}
        <button disabled={busy} onClick={() => void props.onDismissHandoff(handoff)}>{t('ui.auto.379')}</button>
      </div>;
    })}
    {/* C7: las salidas del run, CABLEADAS. TeamView las declaraba desde B3.1 y
        nadie se las pasaba: mientras los controles vivieron tambien en la
        cabecera del chat eso no se notaba, pero el dia que el encabezado del
        pedido paso a ser el unico lugar donde estan, pausar y cancelar
        habrian sido dos botones que no hacian nada. */}
    {rail === 'team' && <TeamView work={work} team={team} roles={roles} mode={mode} busy={busy}
      selectedMemberId={threadMember} onSelectMember={setThreadMember}
      onOpenChat={(memberId) => { props.onSelect(memberId); setRailChoice('chat'); }}
      coordinationRun={props.coordinationRun} pending={props.pending}
      onPauseCoordination={props.onPauseCoordination} onResumeCoordination={props.onResumeCoordination}
      onCancelCoordination={props.onCancelCoordination}
      coordinationLog={props.coordinationLog} coordinationMessages={props.coordinationMessages}
      coordinationAsks={props.coordinationAsks} coordinationHires={props.coordinationHires}
      coordinationGates={props.coordinationGates} coordinationTasks={props.coordinationTasks}
      formatTime={props.formatTime} onNewRequest={openCoordinatorChat} coordinationSupport={props.coordinationSupport}
      onAnswerAsk={props.chatCoordination?.onAnswerAsk} now={props.now}
      onAddMember={isDesktop && !busy ? () => setAdding(true) : undefined}
      formatDate={props.formatDate} coordinationAuthority={props.coordinationAuthority}
      onSetCoordinationAuthority={props.onSetCoordinationAuthority} coordinationBudget={props.coordinationBudget}
      onSetCoordinationBudget={props.onSetCoordinationBudget} coordinatorGrant={props.coordinatorGrant}
      coordinatorMemberId={coordinatorId} onSetCoordinator={props.onSetCoordinator}
      chatCoordination={props.chatCoordination}
      coordinatorChat={coordinatorState.messages}
      teamChatTargetId={teamChatTargetId}
      teamChatStatus={coordinatorState.status} teamChatStatusDetail={coordinatorState.statusDetail}
      teamChatQuestions={coordinatorState.questions}
      onError={props.onError}
      composer={teamChatTargetId ? {
        sessionId: teamChatTargetId,
        onError: props.onError,
        onAttachFiles: props.onAttachFiles,
        // Cerrar un run apaga al coordinador: escribirle lo despierta, y recién
        // después sale el mensaje. Si abrir falla, el borrador queda intacto.
        onBeforeSend: async () => { if (!chats[teamChatTargetId]) await props.onOpen(teamChatTargetId); },
      } : undefined} />}
    {/*
      EL DIALOGO DE SUMAR UN ROL VIVE ACA, FUERA DEL MODO CONVERSACION.

      Estaba adentro de `rail === chat`, asi que en el modo Equipo la fila
      "Sumar un rol" prendia `adding` y no dibujaba NADA: el boton existia,
      se podia clickear, y no pasaba nada. Un boton que no abre nada es peor
      que un boton que no esta.

      Es un modal: va sobre la pantalla que haya, no dentro de una de las
      dos. Y se abre donde estas -- sumar un rol desde el modo Equipo te
      deja en el modo Equipo, que es de donde lo pediste.
    */}
    {adding && !firstTeam && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) setAdding(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="add-member-title" className="modal">
        <div className="modal-head"><div><div className="document-kicker">{t('ui.auto.076')}</div><h2 id="add-member-title">{t('ui.auto.275')}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={() => setAdding(false)}><X size={20} /></button></div>
        <div className="modal-body"><RolePicker roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryDetail={props.primaryDetail} primaryReady={props.primaryReady} checking={props.checking} busy={busy} isDesktop={isDesktop} canCancel={false} onCancel={() => setAdding(false)} onProviders={props.onProviders} onRecheck={props.onRecheck} onAdd={async (roleId, options) => { await props.onAdd(roleId, options); setAdding(false); }} {...rosterPicker} /></div>
      </section></div>}
    {rail === 'chat' && <>
    {work && team.length > 0 && <>
      <div className="team-tabs" role="tablist" aria-label={t('ui.auto.268')}>
        <div className="team-tab-strip">
          {/* El coordinador no está acá: su conversación es el modo Equipo. */}
          {memberTabs.map(member => <MemberTab key={member.id} member={member} chat={chats[member.id] ?? null} selected={member.id === selectedId} busy={busy} mode={mode}
            pending={pendingForMember(member.id, props.coordinationGates, props.coordinationAsks, props.coordinationRun ?? null)}
            {...memberTabSignal(member.id)}
            coordinator={props.coordinationRun?.coordinatorMemberId === member.id}
            onSelect={() => props.onSelect(member.id)} />)}
        </div>
        {activity && <span className={'team-activity' + (activity.needsAttention ? ' attention' : '')} role="status" title={activity.detail}>{activity.label}</span>}
        {workTotal > 0 && <span className="team-usage-total" title={t('usage.help')}>{t('usage.workTotal', { tokens: formatTokens(workTotal, currentLocale()) })}</span>}
        <button className="team-tab-add" aria-label={t('ui.auto.269')} title={t('ui.auto.269')} disabled={busy || !isDesktop} onClick={() => setAdding(true)}><UserPlus size={15} /></button>
        <button className="team-tab-add" aria-label={t('team.providers.label')} title={t('team.providers.title')} onClick={props.onProviders}><Settings2 size={15} /></button>
        {selected && <div className="team-tab-actions">
          {mode === 'advanced' && <>
            <ModelPicker member={selected} busy={busy} onModel={props.onModel} />
            <TierPicker tier={selected.tier} busy={busy} compact onChange={tier => props.onTier(selected.id, tier)} />
          </>}
          <button type="button" className="team-tab-thread" title={t('team.view.threadHelp')} disabled={busy} onClick={() => { setThreadMember(selected.id); setRailChoice('team'); }}>{t('team.view.thread')}</button>
          <button className="icon-button" aria-label={t('continue.action')} title={t('continue.actionHelp')} disabled={busy || !isDesktop} onClick={() => setContinuing(selected.id)}><Forward size={13} /></button>
          {selectedLive && <button className="icon-button" aria-label={t('ui.auto.087')} title={t('ui.auto.270')} disabled={busy} onClick={() => void props.onPause(selected.id)}><Pause size={13} /></button>}
          {selectedStatus !== 'ended' && <button className="icon-button" aria-label={t('team.finish.label')} title={t('ui.auto.271')} disabled={busy} onClick={() => void props.onFinish(selected.id)}><CircleCheck size={13} /></button>}
          <button className="icon-button" aria-label={t('ui.auto.272')} title={t('ui.auto.273')} disabled={busy} onClick={() => { if (window.confirm(t('ui.auto.401', { p0: selected.roleName, p1: selected.roleName }))) void props.onRestart(selected.id); }}><MessageSquarePlus size={13} /></button>
          <button className="icon-button" aria-label={t('ui.auto.274')} title={t('ui.auto.274')} disabled={busy} onClick={() => { if (window.confirm(t('ui.auto.402', { p0: selected.roleName }))) void props.onRemove(selected.id); }}><Trash2 size={13} /></button>
        </div>}
      </div>
      {selected && <MemberUsage member={selected} />}
    </>}
    {firstTeam && <RolePicker roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryDetail={props.primaryDetail} primaryReady={props.primaryReady} checking={props.checking} busy={busy} isDesktop={isDesktop} canCancel={team.length > 0} onCancel={() => setAdding(false)} onProviders={props.onProviders} onRecheck={props.onRecheck} onAdd={async (roleId, options) => { await props.onAdd(roleId, options); setAdding(false); }} {...rosterPicker} />}
    {continuingMember && <ContinueDialog source={continuingMember} roles={roles} choices={props.choices} primaryLabel={props.primaryLabel} primaryReady={props.primaryReady} primaryRuntime={props.primaryRuntime} primaryAccountId={props.primaryAccountId} primaryModel={props.primaryModel} checking={props.checking} busy={busy} isDesktop={isDesktop} onClose={() => setContinuing(null)} onProviders={props.onProviders} onRecheck={props.onRecheck} onContinue={async (roleId, options, text) => { await props.onContinue(continuingMember.id, roleId, options, text); setContinuing(null); }} />}
    {!work && <div className="agent-idle"><div className="agent-symbol"><MessageSquare size={27} /></div><h3>{t('ui.auto.276')}<br />{t('ui.auto.277')}</h3><p className="footnote">{t('ui.auto.278')}</p></div>}
    {!showPicker && selected && (liveChat ? <ChatPane key={liveChat.id} session={liveChat} onStop={() => void props.onPause(selected.id)} onError={props.onError} onSaveAsDocument={props.onSaveAsDocument} untracked={props.untracked} onAdoptFile={props.onAdoptFile} onAttachFiles={props.onAttachFiles} coordination={props.chatCoordination && { ...props.chatCoordination, formatTime: props.formatTime, onShowTeam: showTeam }} beforeComposer={<WorkPermissions mode={props.permissions} busy={props.permissionBusy} hasClaude={props.primaryRuntime === 'claude' || team.some(m => m.runtime === 'claude')} isDesktop={isDesktop} onChange={props.onPermissions} />} /> : <ResumeCard member={selected} origin={team.find(m => m.id === selected.continuedFrom) ?? null} busy={busy} isDesktop={isDesktop} onOpen={() => props.onOpen(selected.id)} onRestart={() => props.onRestart(selected.id)} onRemove={() => props.onRemove(selected.id)} onContinue={() => setContinuing(selected.id)} />)}
    {!showPicker && !selected && team.length > 0 && <p className="chat-empty">{t('ui.auto.279')}</p>}
    </>}
  </div>;
}

/**
 * Qué controles tiene un run, decidido UNA vez y de forma exhaustiva.
 *
 * Antes cada botón traía su propia condición suelta y "Cancelar" viajaba
 * pegado a "Reanudar": un run `planning` o `running` no tenía NINGUNA salida —
 * para cancelar había que pausar primero, y pausar un run que todavía no
 * despachó nada es una instrucción que no le cabe en la cabeza a nadie.
 *
 * El `switch` es exhaustivo contra `CoordinationRunStatus` (`never` en el
 * default): un estado nuevo en el contrato no compila hasta que alguien
 * decida, mirando el producto, qué salida le corresponde. Es exactamente la
 * clase de decisión que no puede quedar en un `else` implícito.
 */
interface RunControlPlan { cancel: boolean; pause: boolean; resume: boolean; statusKey: MessageKey | null }

function planRunControls(run: CoordinationRunView): RunControlPlan {
  switch (run.status) {
    // Planificando: nada que pausar todavía (no hay despacho en vuelo), pero
    // sí hay algo que cancelar — el run ocupa un cupo desde que nace.
    case 'planning': return { cancel: true, pause: false, resume: false, statusKey: 'coordination.run.planning' };
    case 'running': return { cancel: true, pause: true, resume: false, statusKey: null };
    case 'suspended': return { cancel: true, pause: false, resume: true, statusKey: 'coordination.teams.status.suspended' };
    // Los dos finales: se dice cómo terminó y nada más. Ninguna acción de run
    // vivo sobre algo que el motor ya cerró.
    case 'done': return { cancel: false, pause: false, resume: false, statusKey: 'coordination.teams.status.done' };
    case 'cancelled': return { cancel: false, pause: false, resume: false, statusKey: 'coordination.teams.status.cancelled' };
    default: {
      const exhaustive: never = run.status;
      return exhaustive;
    }
  }
}

export function CoordinationRunControls({ run, busy, pending, onPause, onResume, onCancel }: {
  run: CoordinationRunView | null;
  busy: boolean;
  pending?: Record<string, boolean>;
  onPause?: (runId: string) => void;
  onResume?: (runId: string) => void;
  onCancel?: (runId: string) => void;
}) {
  if (!run) return null;
  const plan = planRunControls(run);
  // `active` se cruza con el plan a propósito: dos candados, no uno. Un
  // `status` que alguien marque mal en el backend no puede devolverle botones
  // de run vivo a algo que ya cerró.
  const live = run.active;
  const inFlight = busy || Boolean(pending?.[`run:${run.id}`]);
  // B1.2: LAS CUENTAS VIVEN ACA, en la cabecera del equipo.
  //
  // El banner de "este equipo termino: N listas, M fallidas" vivia en
  // Decisiones, que es la pantalla de lo que PERMANECE. Un run es lo
  // contrario: pasa. Su estado va donde estan sus controles -- pausar,
  // reanudar, cancelar --, compacto, en una linea.
  // B5.3: LO QUE ESTA EN VUELO SE VE, en las dos frases.
  //
  // "3 sin empezar" sobre un run con su unica tarea ya despachada, y
  // "Despachos: 0 / 3" con un miembro escribiendo: las dos eran falsas al
  // mismo tiempo, en la misma linea. `tasksInFlight` viaja aparte desde el
  // motor y `tasksPending` volvio a significar lo que su nombre dice.
  //
  // Se muestra SIEMPRE, tambien en cero: un run terminado diciendo "0 en
  // curso" es cierto, y una frase que cambia de forma segun el numero obliga
  // a aprender dos lecturas de la misma linea.
  const counts = t('team.run.counts', { done: run.tasksDone, inFlight: run.tasksInFlight, failed: run.tasksFailed, pending: run.tasksPending });
  // Un presupuesto ILEGIBLE no se dibuja como un numero: eso seria exactamente
  // la mentira que el `null` produce.
  //
  // `used` son los despachos CERRADOS y `inFlight` los comprometidos: sumarlos
  // en un solo numero escondia cual de los dos era, y dejar afuera el segundo
  // —como estaba— le mentia a la persona sobre su propio presupuesto.
  const budget = run.budgetInvalid ? t('coordination.budget.invalid') : t('team.run.budget', { used: run.tasksDone + run.tasksFailed, inFlight: run.tasksInFlight, max: run.budget?.maxDispatches ?? '∞' });
  return <div className="team-coordination-controls">
    {/* `team-finished-coordination` se conserva como segunda clase para los
        dos finales: es el gancho con el que el resto del producto ya
        distingue "este equipo cerró" de "este equipo está en un estado". */}
    {plan.statusKey && <span className={'team-coordination-status' + (live ? '' : ' team-finished-coordination')} data-run-status={run.status} role="status">{t(plan.statusKey)}</span>}
    <span className="team-coordination-counts">{counts}</span>
    <span className="team-coordination-budget">{budget}</span>
    {live && plan.pause && <button className="team-pause-coordination" title={t('coordination.run.pauseHelp')} disabled={inFlight} onClick={() => onPause?.(run.id)}><Pause size={13} />{t('coordination.run.pause')}</button>}
    {live && plan.resume && <button className="team-resume-coordination" title={t('coordination.run.resumeHelp')} disabled={inFlight} onClick={() => onResume?.(run.id)}><Play size={13} />{t('coordination.run.resume')}</button>}
    {live && plan.cancel && <button className="team-cancel-coordination" title={t('coordination.run.cancelHelp')} disabled={inFlight} onClick={() => onCancel?.(run.id)}><X size={13} />{t('coordination.run.cancel')}</button>}
  </div>;
}

/**
 * A compact, live answer to "what is still running?". It deliberately shows
 * activity rather than invented token/cost figures: Latte has no provider-
 * independent cost meter yet, but it can honestly expose which conversations
 * are spending time or waiting on the human.
 */
function useTeamActivity(team: TeamMember[], chats: Record<string, ChatSession>): { label: string; detail: string; needsAttention: boolean } | null {
  const key = useSyncExternalStore(chatStore.subscribe, () => {
    let working = 0;
    let retrying = 0;
    let attention = 0;
    for (const member of team) {
      const chat = chats[member.id];
      if (!chat) continue;
      const state = chatStore.get(chat.id);
      if (state.closed) continue;
      if (state.status === 'busy') working += 1;
      if (state.status === 'retry') retrying += 1;
      if (state.permissions.length > 0 || state.questions.length > 0) attention += 1;
    }
    return `${working}:${retrying}:${attention}`;
  }, () => '0:0:0');
  const [working, retrying, attention] = key.split(':').map(Number);
  if (working === 0 && retrying === 0 && attention === 0) return null;
  const parts = [
    working > 0 ? t('team.activity.working', { count: working }) : null,
    retrying > 0 ? t('team.activity.retrying', { count: retrying }) : null,
    attention > 0 ? t('team.activity.attention', { count: attention }) : null,
  ].filter((part): part is string => part !== null);
  return { label: parts.join(' · '), detail: t('team.activity.detail', { parts: parts.join(', ') }), needsAttention: attention > 0 };
}

/**
 * How much this work's whole team has spent, live. Reads the chat store
 * directly (not `member.usage`) so a turn that just finished shows up without
 * waiting for the team roster to reload.
 */
function useTeamUsageTotal(team: TeamMember[]): number {
  return useSyncExternalStore(chatStore.subscribe, () => {
    let sum = 0;
    for (const member of team) sum += totalTokens(chatStore.get(member.id).usage);
    return sum;
  }, () => 0);
}

/**
 * What the selected member has spent, in plain language and never the word
 * "tokens". Nothing renders before the first turn: there is nothing honest to
 * report yet.
 */
function MemberUsage({ member }: { member: TeamMember }) {
  const state = useChatState(chatStore, member.id);
  const line = describeUsage(state.usage, currentLocale());
  if (!line) return null;
  const heavy = contextWeight(state.usage.contextTokens) === 'heavy';
  return <p className="team-usage" title={t('usage.help')}>
    <span>{t('usage.label')}: {line}</span>
    {heavy && <span className="team-usage-hint">{t('usage.heavyHint')}</span>}
  </p>;
}

/**
 * One grant instead of a prompt per file.
 *
 * Every claim here was measured against a real Claude Code, not assumed: with
 * the folder patterns a write inside the work folder stops asking, a read or
 * write one level up still asks, and every other tool keeps asking. Codex
 * already runs with its workspace writable, so the row only shows up when the
 * team has a member this actually changes something for.
 *
 * It stays one line tall on purpose: the conversation below needs the height
 * more than this does.
 */
const permissionLabel = (mode: WorkPermissionMode) => t(`permission.mode.${mode}` as 'permission.mode.ask');

/**
 * How much this work's team may do without stopping to ask.
 *
 * Three levels, because the middle one is the honest default for writing
 * documents and the last one is a real handover of judgement: in `auto` Latte
 * answers every request itself. It answers *once* each time, never "always",
 * so nothing is written into a runtime's own permission file and going back to
 * asking takes effect on the very next request.
 */
export function WorkPermissions({ mode, busy, hasClaude, isDesktop, onChange }: { mode: WorkPermissionMode; busy: boolean; hasClaude: boolean; isDesktop: boolean; onChange: (mode: WorkPermissionMode) => void }) {
  const pick = (next: WorkPermissionMode) => {
    if (!canChangePermission(mode, next, busy, isDesktop)) return;
    const warning = [
      t('permission.auto.confirmTitle'),
      t('permission.auto.confirmBody'),
      hasClaude ? t('permission.auto.claudeWarning') : '',
      t('permission.auto.confirmAction'),
    ].filter(Boolean).join('\n\n');
    if (next === 'auto' && !window.confirm(warning)) return;
    onChange(next);
  };
  return <details className={'folder-trust mode-' + mode}>
    <summary>
      {mode === 'ask' ? <FolderLock size={13} /> : mode === 'folder' ? <FolderCheck size={13} /> : <Zap size={13} />}
      <span><strong>{permissionLabel(mode)}</strong>{mode === 'auto' && <small>{t('permission.auto.once')}</small>}</span>
      {busy && <Loading size={16} label={t('permission.changing')} />}
    </summary>
    <div className="permission-modes" role="radiogroup" aria-label={t('permission.group')}>
      {(['ask', 'folder', 'auto'] as WorkPermissionMode[]).map(value => <button
        key={value}
        type="button"
        role="radio"
        aria-checked={mode === value}
        aria-label={t('permission.select', { mode: permissionLabel(value) })}
        className={mode === value ? 'selected' : ''}
        disabled={busy || !isDesktop}
        onClick={() => pick(value)}
      >
        <strong>{permissionLabel(value)}</strong>
        <small>{t(`permission.help.${value}` as 'permission.help.ask')}</small>
      </button>)}
    </div>
    {!isDesktop && <p className="permission-preview" role="note">{t('permission.preview')}</p>}
    {mode === 'auto' && hasClaude && <p className="permission-warning">{t('permission.auto.activeWarning')}</p>}
  </details>;
}

/**
 * B3.3: LA PESTANA DICE EN QUE ANDA ESE MIEMBRO.
 *
 * Con el buzon mudado al modo Equipo, la tira se quedaba con el nombre del rol
 * y nada mas. Bajo el nombre va su ultimo intercambio, recortado, con el texto
 * entero en el `title`: recortar no es callar.
 *
 * Y el chip de coordinacion se calla cuando no tiene nada que decir. La captura
 * del dueno mostraba tres miembros con "arrancando" y el run `cancelled`: nadie
 * estaba arrancando nada. El chip habla de un PROCESO, asi que pide las dos
 * cosas -- run vivo y miembro con proceso (`working` o `idle` en `TeamMember`,
 * que es lo que `hub.describe()` reporta).
 */
export function MemberTab({ member, chat, selected, busy, mode = 'simple', pending = 0, lastExchange = '', urgent = false, time = '', at = null, coordinator = false, dot = 'idle', onSelect }: { member: TeamMember; chat: ChatSession | null; selected: boolean; busy: boolean; mode?: LatteMode; pending?: number; lastExchange?: string; urgent?: boolean; time?: string; at?: string | null; coordinator?: boolean; dot?: MemberDot; onSelect: () => void }) {
  const state = useChatState(chatStore, chat ? chat.id : null);
  const live = Boolean(chat) && !state.closed;
  const status: TeamMemberStatus = live ? (state.status === 'idle' ? 'idle' : 'working') : member.status === 'ended' ? 'ended' : 'paused';
  const attention = live && (state.permissions.length > 0 || state.questions.length > 0);
  // The runtime is a technical detail the simple mode keeps out of the tooltip.
  // `title` es texto plano: `statusLabel` devuelve JSX y concatenarlo daba "[object Object]".
  const title = member.roleName + (mode === 'advanced' ? ' · ' + RUNTIME_SHORT[member.runtime] : '') + ' · ' + statusText(status, attention);
  /**
   * C2: LA MISMA ANATOMIA QUE LA LISTA DEL MODO EQUIPO.
   *
   * Avatar con punto, nombre, una linea, hora a la derecha. El chip de
   * coordinacion --"conectado", "arrancando", "sin confirmar"-- se fue: es una
   * FRASE adentro de una pastilla, que es exactamente lo que el criterio 5
   * prohibe, y encima repetia en palabras lo que el punto ya dice. Lo que el
   * runtime confirmo o no no se pierde: sigue dicho entero, con su frase
   * larga, al pie del modo Equipo en modo avanzado.
   *
   * El punto habla del PROCESO cuando hay proceso --trabajando ahora mismo es
   * el hecho mas fuerte que esta fila puede contar-- y de la coordinacion
   * cuando el proceso esta callado.
   */
  const signal: MemberDot = attention || status === 'working' ? 'live' : dot;
  return <button role="tab" aria-selected={selected} className={'team-tab coord-row status-' + status + (attention ? ' attention' : '')} disabled={busy} onClick={onSelect} title={lastExchange ? title + ' · ' + lastExchange : title}>
    <CoordAvatar name={member.roleName} roleId={member.roleId} avatar={avatarOfMember(member)} dot={signal} small />
    <span className="team-tab-text coord-row-text">
      <span className="team-tab-top coord-row-top">
        <span className="team-tab-name coord-row-name">{member.roleName}{coordinator && <Users size={12} className="coord-row-coordinator" aria-label={t('coord.member.coordinator')} />}</span>
        {/* B1.2: lo que ESTE miembro esta esperando de la persona, en el mismo
            lugar que la hora: son la misma columna, y nunca hay que leer las
            dos cosas a la vez. */}
        {pending > 0
          ? <span className="team-tab-pending coord-badge" title={t('team.inbox.pending', { count: pending })}>{pending}</span>
          : <CoordTime at={at} label={time} />}
      </span>
      {lastExchange && <span className={'team-tab-last coord-row-line' + (urgent ? ' is-urgent' : signal === 'failed' ? ' is-failed' : '')}>{lastExchange}</span>}
    </span>
    <span className="visually-hidden">{statusLabel(status, attention)}</span>
  </button>;
}



/** Maps a `CoordinationDegradedReason` to the matching `coordination.degraded.*` and `coordination.short.*` key suffixes. */
const DEGRADED_KEY: Record<CoordinationDegradedReason, string> = {
  claude_below_floor: 'claudeBelowFloor',
  codex_run_cap: 'codexRunCap',
  codex_global_cap: 'codexGlobalCap',
  codex_process_ceiling: 'codexProcessCeiling',
  opencode_shared_server: 'opencodeSharedServer',
  engram_not_installed: 'engramMissing',
  runtime_refused_injection: 'runtimeRefused',
  coordination_server_unavailable: 'coordinationServerDown',
};

/**
 * B1.3: EL ESTADO DE COORDINACION DE UN MIEMBRO, EN UNA PALABRA.
 *
 * Cuatro estados, y ninguno afirma lo que el runtime no confirmo:
 *
 *  - `connected`: el runtime hablo y dijo que la levanto. Recien ahi se afirma.
 *  - `starting`: Latte la pidio y el runtime TODAVIA no contesto. Puede llegar.
 *  - `unconfirmed`: este runtime no tiene forma de informarlo NUNCA (OpenCode:
 *    su servidor no expone ningun endpoint que liste servidores MCP).
 *    "Arrancando" ahi dejaria a la persona esperando algo que no va a pasar.
 *  - `uncoordinated`: no puede proponer, y se nombra por que.
 *
 * La frase larga -- la que vivia en Decisiones -- viaja en el `title`.
 */
export function memberCoordinationState(row: CoordinationMemberSupport): { state: string; label: string; title: string; className: string } {
  if (!row.canPropose) {
    const short = row.reason
      ? t(`coordination.short.${DEGRADED_KEY[row.reason]}` as 'coordination.short.claudeBelowFloor')
      : t('coordination.short.disabled');
    const long = row.reason
      ? t(`coordination.degraded.${DEGRADED_KEY[row.reason]}` as 'coordination.degraded.claudeBelowFloor')
      : t('coordination.support.disabled');
    return { state: 'uncoordinated', label: t('team.member.uncoordinated', { reason: short }), title: long, className: 'is-uncoordinated' };
  }
  if (row.runtimeConfirmed) return { state: 'connected', label: t('team.member.connected'), title: t('coordination.support.available'), className: 'is-connected' };
  if (row.runtimeReportsInjection) return { state: 'starting', label: t('team.member.starting'), title: t('coordination.support.unconfirmed'), className: 'is-starting' };
  return { state: 'unconfirmed', label: t('team.member.unconfirmed'), title: t('coordination.support.notReported'), className: 'is-unconfirmed' };
}

/**
 * La linea de coordinacion, entera: nada que marcar cuando el miembro puede
 * proponer; la frase de su motivo en cualquier otro caso.
 *
 * "Sin restricciones" es una afirmacion sobre un proceso que esta andando.
 * Mientras el runtime no diga que levanto, lo unico que Latte sabe es lo que
 * PIDIO, y eso se dice con esas palabras. "Sin confirmar" promete que la
 * confirmacion puede llegar; cuando el runtime no tiene forma de informarla
 * NUNCA (OpenCode: su servidor no expone ningun endpoint que liste servidores
 * MCP), esa frase deja a la persona esperando algo que no va a pasar.
 */
export function describeCoordinationSupport(row: CoordinationMemberSupport): string {
  if (row.canPropose && !row.runtimeConfirmed) {
    return row.runtimeReportsInjection ? t('coordination.support.unconfirmed') : t('coordination.support.notReported');
  }
  if (row.canPropose) return t('coordination.support.available');
  // Un miembro que no puede proponer SIN motivo adjunto significa que el flag
  // `coordination` esta apagado app-wide: una causa distinta y real, nunca la
  // misma frase que "sin restricciones".
  return row.reason
    ? t(`coordination.degraded.${DEGRADED_KEY[row.reason]}` as 'coordination.degraded.claudeBelowFloor')
    : t('coordination.support.disabled');
}

/**
 * La linea de memoria, INDEPENDIENTE de la de coordinacion: son dos politicas
 * de inyeccion distintas. Un miembro puede llevar memoria sin coordinacion, o
 * coordinacion sin memoria, y nunca se calla ninguna de las dos.
 */
export function describeMemorySupport(row: CoordinationMemberSupport): string {
  if (row.memoryInjected && !row.runtimeConfirmed) {
    return row.runtimeReportsInjection ? t('coordination.memory.unconfirmed') : t('coordination.memory.notReported');
  }
  if (row.memoryInjected) return t('coordination.memory.available');
  if (row.reason === 'engram_not_installed') return t('coordination.degraded.engramMissing');
  return t('coordination.memory.unavailable');
}

/** La misma frase que `statusLabel`, sin iconos: para `title` y cualquier atributo de texto. */
function statusText(status: TeamMemberStatus, attention: boolean): string {
  if (attention) return t('team.status.attention');
  switch (status) {
    case 'working': return t('ui.auto.403');
    case 'idle': return t('ui.auto.404');
    case 'ended': return t('ui.auto.285');
    default: return t('team.status.paused');
  }
}

function statusLabel(status: TeamMemberStatus, attention: boolean) {
  if (attention) return <><i className="busy-dot" />{t('team.status.attention')}</>;
  switch (status) {
    case 'working': return <><Loading size={16} />{t('ui.auto.403')}</>;
    case 'idle': return <><i className="live-dot" />{t('ui.auto.404')}</>;
    case 'ended': return <>{t('ui.auto.285')}<CircleCheck size={13} /></>;
    default: return <>{t('team.status.paused')}<Pause size={12} /></>;
  }
}

function ResumeCard({ member, origin, busy, isDesktop, onOpen, onRestart, onRemove, onContinue }: { member: TeamMember; origin: TeamMember | null; busy: boolean; isDesktop: boolean; onOpen: () => Promise<void>; onRestart: () => Promise<void>; onRemove: () => Promise<void>; onContinue: () => void }) {
  const [opening, setOpening] = useState(false);
  const open = async () => { setOpening(true); try { await onOpen(); } finally { setOpening(false); } };
  return <div className="agent-idle team-resume">
    <Avatar className="team-resume-av" size="lg" name={member.roleName} roleId={member.roleId} params={avatarOfMember(member)} />
    <h3>{member.roleName}<br /><small>{member.label}</small>{origin && <small>{t('continue.from', { role: origin.roleName })}</small>}</h3>
    <p>{member.status === 'ended' ? t('ui.auto.286') : t('ui.auto.287')}</p>
    <button className="primary" disabled={busy || opening} onClick={() => void open()}>{opening ? <Loading size={16} /> : <Play size={15} />}{opening ? t('team.opening') : member.status === 'ended' ? t('ui.auto.288') : t('ui.auto.289')}</button>
    {/* A paused or finished member is where an exhausted account usually leaves you: continuing elsewhere belongs right here. */}
    <button className="subtle" title={t('continue.actionHelp')} disabled={busy || opening || !isDesktop} onClick={onContinue}><Forward size={13} />{t('continue.action')}</button>
    <button className="subtle" disabled={busy || opening} onClick={() => { if (window.confirm(t('ui.auto.401', { p0: member.roleName, p1: member.roleName }))) void onRestart(); }}><MessageSquarePlus size={13} />{t('ui.auto.272')}</button>
    <button className="subtle" disabled={busy || opening} onClick={() => { if (window.confirm(t('ui.auto.405', { p0: member.roleName }))) void onRemove(); }}><Trash2 size={13} />{t('ui.auto.274')}</button>
  </div>;
}

export interface RolePickerProps {
  roles: AgentRole[]; choices: RuntimeChoice[]; primaryLabel: string; primaryDetail: string; primaryReady: boolean; checking: boolean; busy: boolean; isDesktop: boolean; canCancel: boolean;
  onCancel: () => void; onAdd: (roleId: string, options: TeamMemberOptions | null) => Promise<void>; onProviders: () => void; onRecheck: () => void;
  /**
   * EL PLANTEL PRIMERO (esquema 14): los de la marca que todavía no están en
   * este trabajo. Van arriba, con su cara, y elegir uno lo CONVOCA tal cual es
   * —su runtime y su esfuerzo son suyos—. Los roles de abajo suman a alguien
   * NUEVO a la marca (`newInBrand`). Sin plantel, el diálogo de siempre.
   */
  roster?: readonly BrandMember[];
  onCallUp?: (brandMemberId: string) => Promise<void>;
  /** El verbo del botón y la frase de arriba, para cuando el diálogo no abre una conversación (Marca → Equipo). `null` no dibuja la frase. */
  submitLabel?: string;
  lead?: string | null;
}

export function RolePicker({ roles, choices, primaryLabel, primaryDetail, primaryReady, checking, busy, isDesktop, canCancel, onCancel, onAdd, onProviders, onRecheck, roster = [], onCallUp, submitLabel, lead }: RolePickerProps) {
  const [roleId, setRoleId] = useState('assistant');
  const people = onCallUp ? roster : [];
  // El plantel manda: si hay a quién convocar, arranca elegido el primero.
  const [personId, setPersonId] = useState<string | null>(() => people[0]?.id ?? null);
  const person = people.find(m => m.id === personId) ?? null;
  const [choice, setChoice] = useState('primary');
  const [opening, setOpening] = useState(false);
  // Follows the picked role's own default effort; picking another role resets it,
  // same as the role determines the starting point rather than carrying a stale choice.
  const [tier, setTier] = useState<EffortTier>(() => roles.find(r => r.id === roleId)?.tier ?? DEFAULT_EFFORT_TIER);
  useEffect(() => { setTier(roles.find(r => r.id === roleId)?.tier ?? DEFAULT_EFFORT_TIER); }, [roleId, roles]);
  const picked = choices.find(c => c.key === choice) ?? null;
  const ready = person ? true : choice === 'primary' ? primaryReady : Boolean(picked);
  const add = async () => {
    if (!ready || opening) return;
    setOpening(true);
    try {
      if (person && onCallUp) { await onCallUp(person.id); return; }
      const options: TeamMemberOptions = picked ? { runtime: picked.runtime, accountId: picked.accountId, model: null, tier } : { tier };
      // Con el plantel a la vista, elegir un rol de abajo es pedir a alguien NUEVO.
      await onAdd(roleId, people.length > 0 ? { ...options, newInBrand: true } : options);
    } finally { setOpening(false); }
  };
  const explanation = lead === undefined ? t('ui.auto.292') : lead;
  return <div className="role-picker">
    <div className="role-picker-head"><span className="field-label">{canCancel ? t('ui.auto.290') : t('ui.auto.291')}</span>{canCancel && <button className="icon-button" aria-label={t('ui.auto.241')} onClick={onCancel}><X size={15} /></button>}</div>
    {explanation && <p className="agent-explanation">{explanation}</p>}
    {people.length > 0 && <>
      <p className="field-label role-picker-section">{t('roster.picker.fromBrand')}</p>
      <div className="role-list role-list-roster" role="radiogroup" aria-label={t('roster.picker.fromBrand')}>
        {people.map(m => <button key={m.id} role="radio" aria-checked={personId === m.id} className={'role-card' + (personId === m.id ? ' selected' : '') + (m.retiredAt ? ' is-retired' : '')} onClick={() => setPersonId(m.id)}><Avatar params={parseAvatar(m.avatar)} roleId={m.roleId} name={m.roleName} size="lg" /><span><strong>{m.roleName}</strong><small>{m.retiredAt ? t('roster.retired') : m.label}</small></span>{personId === m.id && <Check size={14} />}</button>)}
      </div>
      <p className="field-label role-picker-section">{t('roster.picker.new')}</p>
    </>}
    <div className="role-list" role="radiogroup" aria-label={t('team.rolePicker.group')}>
      {roles.map(role => <button key={role.id} role="radio" aria-checked={!person && roleId === role.id} className={'role-card' + (!person && roleId === role.id ? ' selected' : '')} onClick={() => { setPersonId(null); setRoleId(role.id); }}><Avatar params={parseAvatar(role.avatar)} roleId={role.id} name={role.name} size="lg" /><span><strong>{role.name}</strong><small>{roleSummary(role)}</small></span>{!person && roleId === role.id && <Check size={14} />}</button>)}
    </div>
    {!person && <>
    <TierPicker tier={tier} busy={busy || opening} onChange={setTier} />
    <label className="field-label" htmlFor="member-runtime">{t('ui.auto.293')}</label>
    {/*
      Detecting the runtimes means running their CLIs, and that costs seconds.
      Until it answers, the list is not empty: it is unknown. Saying so beats a
      picker with one option that looks broken.
    */}
    <select id="member-runtime" value={choice} disabled={busy || opening || checking} onChange={e => setChoice(e.target.value)}>
      {checking
        ? <option value="primary">{t('ui.auto.294')}</option>
        : <>
          <option value="primary">{t('ui.auto.295')} {primaryLabel}</option>
          {choices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </>}
    </select>
    {choice === 'primary' && <small className="runtime-detail">{checking ? t('ui.auto.296') : primaryDetail}</small>}
    </>}
    <div className="chat-card-actions">
      <button className="primary" disabled={busy || opening || (!person && checking) || !ready || !isDesktop} onClick={() => void add()}>{opening || (!person && checking) ? <Loading size={16} /> : <Plus size={15} />}{opening ? t('team.opening') : person ? t('roster.callUp') : checking ? t('team.checkingAgents') : submitLabel ?? t('ui.auto.297')}</button>
      {isDesktop && !checking && <button className="subtle" onClick={onProviders}><Plug size={13} />{primaryReady ? t('ui.auto.298') : t('ui.auto.299')}</button>}
      {isDesktop && !checking && !primaryReady && <button className="subtle" onClick={onRecheck}>{t('team.recheck')}</button>}
    </div>
    {!isDesktop && <small className="preview-note">{t('ui.auto.300')}</small>}
  </div>;
}

const displayError = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An agent that can take the work over right now: the primary agent when it is ready, or a logged-in alternative. */
interface ContinueOption extends ContinuationTarget { label: string }
const RUNTIME_NAME: Record<ChatRuntime, string> = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex' };

/**
 * Continue a member's work with another agent or account.
 *
 * Latte writes the hand-over from its own records and the human edits it
 * here, before anything is created or spent. The origin is only read: it keeps
 * its conversation, its account and its status. Only agents that can start
 * now are offered; when there is none the dialog says what is missing and how
 * to fix it instead of offering something that would fail after opening.
 */
function ContinueDialog({ source, roles, choices, primaryLabel, primaryReady, primaryRuntime, primaryAccountId, primaryModel, checking, busy, isDesktop, onClose, onContinue, onProviders, onRecheck }: { source: TeamMember; roles: AgentRole[]; choices: RuntimeChoice[]; primaryLabel: string; primaryReady: boolean; primaryRuntime: ChatRuntime; primaryAccountId: string | null; primaryModel: string | null; checking: boolean; busy: boolean; isDesktop: boolean; onClose: () => void; onContinue: (roleId: string, options: TeamMemberOptions | null, text: string) => Promise<void>; onProviders: () => void; onRecheck: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState('');
  const [opening, setOpening] = useState(false);
  const [roleId, setRoleId] = useState(() => roles.some(r => r.id === source.roleId) ? source.roleId : roles[0]?.id ?? 'assistant');
  // null until the person picks one: the default follows the options as detection answers.
  const [choice, setChoice] = useState<string | null>(null);
  // Model picked per agent; untouched agents start where continuationModel says.
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{ key: string; list: AgentModelList } | null>(null);
  useEffect(() => {
    let live = true;
    setDraft(null); setLoadError('');
    api.draftContinuation(source.id)
      .then(result => { if (live && result.sourceMemberId === source.id) { setDraft(result.text); setText(result.text); } })
      .catch(e => { if (live) setLoadError(displayError(e)); });
    return () => { live = false; };
  }, [source.id, attempt]);

  const sameAsSource = (o: ContinueOption) => o.runtime === source.runtime && (o.runtime === 'opencode' || (o.accountId ?? 'system') === (source.accountId ?? 'system'));
  const options: ContinueOption[] = [
    ...(primaryReady ? [{ key: 'primary', label: t('continue.primary', { label: primaryLabel }), runtime: primaryRuntime, accountId: primaryRuntime === 'opencode' ? null : primaryAccountId ?? 'system' }] : []),
    ...choices.map(c => ({ key: c.key, label: c.label, runtime: c.runtime, accountId: c.accountId })),
  ];
  // Usually the reason to continue is the source's own account, so another one comes first.
  const picked = options.find(o => o.key === choice) ?? options.find(o => !sameAsSource(o)) ?? options[0] ?? null;
  const blocked = !checking && options.length === 0;
  const edited = draft !== null && text !== draft;
  const ready = isDesktop && !checking && !busy && !opening && picked !== null && draft !== null && text.trim().length > 0;

  // The catalog belongs to the agent and account picked; the same loader as the conversation's model picker.
  const catalogKey = picked ? `${picked.runtime}:${picked.accountId ?? ''}` : '';
  useEffect(() => {
    if (!picked) return;
    let live = true;
    void modelListFor(picked.runtime, picked.accountId)
      .then(list => { if (live) setCatalog({ key: catalogKey, list }); })
      .catch(() => { if (live) setCatalog({ key: catalogKey, list: { source: 'suggested', models: [], detail: '' } }); });
    return () => { live = false; };
  }, [catalogKey]);
  const list = catalog && catalog.key === catalogKey ? catalog.list : null;
  const models = list?.models ?? [];
  const model = picked ? continuationModel(picked, source, primaryModel, modelDrafts) : '';
  // Say where the model came from, and when it cannot come along, why.
  const modelNote = !picked || checking ? ''
    : model !== '' && list?.source === 'catalog' && !models.some(m => m.id === model) ? t('continue.modelNotListed', { model })
    : picked.runtime === source.runtime && model === (source.model ?? '') ? (source.model ? t('continue.modelKept', { model: source.model }) : t('continue.modelKeptDefault'))
    : picked.runtime !== source.runtime && source.model ? t('continue.modelOtherRuntime', { model: source.model, runtime: RUNTIME_NAME[source.runtime] })
    : '';

  const close = () => { if (opening) return; if (edited && !window.confirm(t('continue.leaveConfirm'))) return; onClose(); };
  const submit = async () => {
    if (!ready || !picked) return;
    setOpening(true); setFailure('');
    try { await onContinue(roleId, continuationOptions(picked, model), text); } catch (e) { setFailure(displayError(e)); } finally { setOpening(false); }
  };

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="continue-title" className="modal continuation" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <div className="modal-head"><div><div className="document-kicker">{t('continue.kicker')}</div><h2 id="continue-title">{t('continue.title', { role: source.roleName })}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={close}><X size={20} /></button></div>
      <div className="modal-body">
        <p className="agent-explanation">{t('continue.lead', { role: source.roleName, label: source.label })}</p>
        <div className="continuation-pickers">
          <label><span className="field-label">{t('continue.role')}</span>
            <select value={roleId} disabled={opening} onChange={e => setRoleId(e.target.value)}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label><span className="field-label">{t('continue.agent')}</span>
            <select value={picked?.key ?? ''} disabled={checking || opening || options.length === 0} onChange={e => setChoice(e.target.value)}>
              {checking ? <option value="">{t('continue.checking')}</option>
                : options.length === 0 ? <option value="">{t('continue.none')}</option>
                : options.map(o => <option key={o.key} value={o.key}>{sameAsSource(o) ? t('continue.sameAsSource', { label: o.label }) : o.label}</option>)}
            </select>
          </label>
          <label><span className="field-label">{t('continue.model')}</span>
            <select value={model} title={list?.detail ?? ''} disabled={checking || opening || !picked} onChange={e => { const key = picked?.key; if (key) setModelDrafts(prev => ({ ...prev, [key]: e.target.value })); }}>
              <option value="">{picked?.runtime === 'opencode' ? t('continue.modelDefaultOpenCode') : t('continue.modelDefault')}</option>
              {model !== '' && !models.some(m => m.id === model) && <option value={model}>{model}</option>}
              {models.map(m => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? t('continue.modelIsDefault') : ''}</option>)}
            </select>
          </label>
        </div>
        {picked && !checking && <small className="runtime-detail">{list ? modelNote : t('continue.modelLoading')}</small>}
        {blocked && <div className="continuation-block" role="alert">
          <span><CircleAlert size={14} />{t('continue.blocked')}</span>
          <div className="chat-card-actions">
            <button onClick={() => { if (!edited || window.confirm(t('continue.leaveConfirm'))) onProviders(); }}><Plug size={13} />{t('continue.providers')}</button>
            <button onClick={onRecheck}>{t('continue.recheck')}</button>
          </div>
        </div>}
        {!checking && picked && sameAsSource(picked) && <p className="runtime-detail">{t('continue.sameHint')}</p>}
        <label className="field-label" htmlFor="continuation-text">{t('continue.text')}</label>
        {loadError
          ? <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{t('continue.error', { message: loadError })}</span><button onClick={() => setAttempt(n => n + 1)}>{t('continue.retry')}</button></div>
          : <textarea id="continuation-text" className="continuation-text" spellCheck={false} value={draft === null ? t('continue.loading') : text} disabled={draft === null || opening} onChange={e => setText(e.target.value)} />}
        <p className="footnote">{t('continue.help')}</p>
        {failure && <div className="chat-error" role="alert"><CircleAlert size={14} /><span>{failure}</span></div>}
        <div className="chat-card-actions">
          <button className="primary" disabled={!ready} onClick={() => void submit()}>{opening ? <Loading size={16} /> : <Forward size={15} />}{opening ? t('continue.opening') : t('continue.submit')}</button>
          <button disabled={opening} onClick={close}>{t('continue.cancel')}</button>
          {edited && <button className="subtle" disabled={opening} onClick={() => { if (window.confirm(t('continue.resetConfirm'))) setText(draft ?? ''); }}>{t('continue.reset')}</button>}
        </div>
        {!isDesktop && <small className="preview-note">{t('continue.preview')}</small>}
      </div>
    </section>
  </div>;
}


/**
 * The model this conversation runs on, changed without leaving it.
 *
 * Neither CLI swaps a model in place, so Latte restarts the runtime and
 * resumes the same conversation. The list is the runtime's own catalog where
 * there is one; OpenCode has 155 models behind a provider, which is a Settings
 * decision and not a control to squeeze next to a chat, so there it only
 * reports what is in use.
 */
/**
 * The models a runtime says an account can use. OpenCode already publishes
 * what it has configured; the subscription runtimes are asked one by one, and
 * answer a catalog or an honest "this is what Latte knows".
 */
function modelListFor(runtime: ChatRuntime, accountId: string | null): Promise<AgentModelList> {
  return runtime === 'opencode'
    ? api.chatStatus().then((status): AgentModelList => ({
      source: 'catalog',
      detail: t('team.model.openCodeDetail', { suffix: status.defaultModel ? t('team.model.openCodeDefault', { model: status.defaultModel }) : '' }),
      models: status.models.map(id => ({ id, label: id, description: '', isDefault: id === status.defaultModel })),
    }))
    : api.listAccountModels(runtime, accountId ?? 'system');
}

function ModelPicker({ member, busy, onModel }: { member: TeamMember; busy: boolean; onModel: (memberId: string, model: string | null) => void }) {
  const [list, setList] = useState<AgentModelList | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    void modelListFor(member.runtime, member.accountId).then(value => { if (live) setList(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [member.runtime, member.accountId]);

  const models = list?.models ?? [];
  const current = member.model ?? '';
  // OpenCode ids read `provider/model`; grouping by provider keeps a long list navigable.
  const groups = new Map<string, typeof models>();
  for (const model of models) {
    const slash = model.id.indexOf('/');
    const group = slash > 0 ? model.id.slice(0, slash) : '';
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const grouped = groups.size > 1 || (groups.size === 1 && !groups.has(''));
  const option = (m: AgentModelList['models'][number]) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? t('team.model.isDefault') : ''}</option>;

  return <select
    className="team-model"
    aria-label={t('ui.auto.388', { p0: member.roleName })}
    title={list ? t('ui.auto.406', { p0: list.detail }) : t('ui.auto.301')}
    value={current}
    disabled={busy || !list}
    onChange={e => onModel(member.id, e.target.value || null)}
  >
    <option value="">{list ? t('ui.auto.302') : t('team.checkingModels')}</option>
    {current !== '' && !models.some(m => m.id === current) && <option value={current}>{current}</option>}
    {grouped
      ? [...groups.entries()].map(([group, items]) => group ? <optgroup key={group} label={group}>{items.map(option)}</optgroup> : items.map(option))
      : models.map(option)}
  </select>;
}

const tierLabel = (tier: EffortTier) => t(`effort.tier.${tier}.label` as 'effort.tier.light.label');
const tierHelp = (tier: EffortTier) => t(`effort.tier.${tier}.help` as 'effort.tier.light.help');

/**
 * How hard a member works per answer, in words a marketer chooses by outcome,
 * never by model name or reasoning-effort level. `compact` drops the help
 * caption under each option (kept on the `title`) for the tight space next to
 * the model picker; the roomier "Sumar un rol" dialog shows it in full.
 */
function TierPicker({ tier, busy, compact, onChange }: { tier: EffortTier; busy: boolean; compact?: boolean; onChange: (tier: EffortTier) => void }) {
  return <div className={'effort-picker' + (compact ? ' compact' : '')} role="radiogroup" aria-label={t('effort.group')}>
    {!compact && <span className="field-label">{t('effort.group')}</span>}
    <div className="effort-options">
      {EFFORT_TIERS.map(value => <button
        key={value}
        type="button"
        role="radio"
        aria-checked={tier === value}
        aria-label={t('effort.select', { tier: tierLabel(value) })}
        title={tierHelp(value)}
        className={tier === value ? 'selected' : ''}
        disabled={busy}
        onClick={() => onChange(value)}
      >
        <strong>{tierLabel(value)}</strong>
        {!compact && <small>{tierHelp(value)}</small>}
      </button>)}
    </div>
  </div>;
}
