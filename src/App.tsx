import { currentLocale, translate as t, type MessageKey } from './i18n';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpRight, Bookmark, Check, ChevronDown, Circle, Copy, FileText, Folder, Home, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Plus, Save, Settings2, Square, TerminalSquare, X } from 'lucide-react';
import { Loading } from './brand-marks';
import type { Brand, BrandContextDecisionResult, BrandContextProposal, BrandContextStatus, Work, Decision, DecisionAuthorityMode, WorkPermissionMode, RuntimeStatus, AgentSession, Provider, ChatSession, ChatRuntimeStatus, PrimaryAgent, AgentRuntimeInfo, AgentRole, EffortTier, TeamMember, TeamMemberOptions, WorkDocument, DocumentKind, UntrackedFile, HandoffRequest, AppInfo, OnboardingDraft, CoordinationActiveRunSummary } from '../shared/contracts';
import { api, chatStore, isDesktop } from './browser-api';
import { DocumentsView, NewDocumentDialog } from './DocumentsView';
import { hasMetadataDrafts } from './DocumentMetadata';
import { hasOutcomeDrafts } from './WorkOutcome';
import { documentDrafts } from './document-drafts';
import { useActiveEdits } from './chat-store';
import { SettingsScreen, type SettingsSection } from './SettingsScreen';
import { TeamPanel, type LatteMode, type RuntimeChoice } from './TeamPanel';
import { TerminalPane } from './TerminalPane';
import { UpdateBanner } from './UpdateBanner';
import { ALL_BRAND_SCOPE, inKnowledgeScope, selectWorkBrief, workBrief, workTitles, type KnowledgeScope } from './brand-knowledge';
import { KnowledgeScopeFilter } from './KnowledgeScope';
import { ContextView } from './ContextView';
import { HomeView } from './HomeView';
import { ResumenView } from './ResumenView';
import { TrabajoView } from './TrabajoView';
import { EvidenciaView } from './EvidenciaView';
import { ResultadosView } from './ResultadosView';
import { DecisionsView } from './DecisionsView';
import { useDocumentStates } from './document-states';
import { OnboardingGate, type OnboardingResult } from './OnboardingGate';
import { contextSaveNotice } from './context-view';
import { applyFetchedBrand } from './brand-context-sync';
import { confirmFolderLink } from './folder-link';
import { useCoordination } from './useCoordination';
import { ActiveTeamsStrip } from './ActiveTeamsStrip';
import { MemoryNotice } from './MemoryNotice';
import { sinceLastVisitFromActiveRuns } from './home-summary';

/**
 * Every workspace view, in one place.
 *
 * It is a runtime list on purpose: a view that is added here but has no render
 * branch in `<main>` shows an empty workspace, and a render test that walks the
 * list catches it. Deriving the type from the list keeps the two in step.
 *
 * `home` is first because it is where the product starts: it is the attention
 * surface, reachable before any work is open. Opening a work still opens the
 * work (`selectWork`), so the two destinations never blur.
 */
export const VIEWS = ['home', 'resumen', 'trabajo', 'evidencia', 'brief', 'funnel', 'context', 'memory', 'decisions', 'resultados'] as const;
type View = (typeof VIEWS)[number];
type Modal = 'brand' | 'work' | 'document' | null;
const date = (value: string) => new Date(value).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' });
const AGENT_WIDTH_KEY = 'latte-agent-width';
const AGENT_MIN = 320, SIDEBAR = 232, WORKSPACE_MIN = 360;
const maxAgentWidth = () => Math.max(AGENT_MIN, window.innerWidth - SIDEBAR - WORKSPACE_MIN);
const clampAgentWidth = (value: number) => Math.min(maxAgentWidth(), Math.max(AGENT_MIN, Math.round(value)));
const readAgentWidth = () => { try { const raw = localStorage.getItem(AGENT_WIDTH_KEY); const n = raw ? Number(raw) : NaN; return Number.isFinite(n) ? clampAgentWidth(n) : 355; } catch { return 355; } };
/**
 * Q8: LOS ERRORES DE COORDINACIÓN HABLAN EL IDIOMA DE LA PERSONA.
 *
 * `displayError` era `e.message`, y los mensajes del motor están escritos para
 * quien lee el código: `ASK_CLOSED` llega en castellano desde `repository.ts` y
 * `RUN_NOT_RUNNING` en inglés desde `engine.ts`, en la misma pantalla y a veces
 * en la misma sesión. El código SÍ cruza la frontera IPC (`preload.cjs` lo
 * copia sobre el `Error`), así que traducir es mirar el código, que es lo que
 * la app ya hace con `permission.error` y `continue.sendFailed`.
 *
 * Sólo los que la persona puede ver de verdad. Un código sin entrada acá cae al
 * `message` del motor: inventarle una frase genérica a un error desconocido
 * sería tapar información que alguien va a necesitar.
 */
export const COORDINATION_ERROR_KEYS: Record<string, MessageKey> = {
  ASK_CLOSED: 'error.coordination.askClosed',
  RUN_NOT_RUNNING: 'error.coordination.runNotRunning',
  RUN_NOT_ACTIVE: 'error.coordination.runNotActive',
  MEMBER_BUSY: 'error.coordination.memberBusy',
  ROLE_NOT_APPROVED: 'error.coordination.roleNotApproved',
  COORDINATION_BUDGET_INVALID: 'error.coordination.budgetInvalid',
  PLAN_HAS_UNAPPROVED_ROLES: 'error.coordination.planHasUnapprovedRoles',
  // Q6: `INVALID_ARGUMENT` NO ESTÁ. Sólo existe en el sobre MCP —el error que
  // `tools.ts` le devuelve a un agente— y nunca cruza la frontera IPC: era una
  // frase escrita para una pantalla que no la iba a mostrar jamás.
  //
  // Y los que la persona alcanza con un clic, que es el único criterio que
  // decide si un código necesita frase propia.
  BUDGET_EXCEEDED: 'error.coordination.budgetExceeded',
  MAX_CONCURRENT: 'error.coordination.maxConcurrent',
  INVALID_GATE: 'error.coordination.invalidGate',
  COORDINATION_NOT_APPROVED: 'error.coordination.coordinationNotApproved',
  RUN_ALREADY_ACTIVE: 'error.coordination.runAlreadyActive',
  TASK_NOT_READY: 'error.coordination.taskNotReady',
  NO_ACTIVE_RUN: 'error.coordination.noActiveRun',
  GLOBAL_BUDGET_INVALID: 'error.coordination.globalBudgetInvalid',
  TOO_MANY_ACTIVE_RUNS: 'error.coordination.tooManyActiveRuns',
  // `commitProposal` crea las tareas del plan aprobado, así que los topes del
  // DAG llegan a la persona por el botón "Aprobar" — no sólo al agente.
  TASK_CAP: 'error.coordination.taskCap',
  DEPTH_CAP: 'error.coordination.depthCap',
  // M2 (ronda 8): `PROPOSAL_STALE` y `PROPOSAL_DECIDED` SALIERON DE ACÁ. El
  // motor de coordinación no los tiraba: los tiraban los métodos de contexto
  // de MARCA de `latteService`, y su copy hablaba de marca dentro del
  // namespace de coordinación. Ahora tienen código y frase propios en
  // `BRAND_ERROR_KEYS`.
  // O2: los códigos de las SUBCLASES de `LatteError`, invisibles hasta acá.
  // `BUDGET_UNSET` lo tira `startRun` —y SÓLO él— cuando nadie configuró un
  // tope todavía.
  BUDGET_UNSET: 'error.coordination.budgetUnset',
};

/**
 * N2 (ronda 7): ESTE MAPA ES DE TODA LA APP, Y POR ESO SU COPY ES NEUTRA.
 *
 * La ronda 6 metió `FEATURE_DISABLED`, `NOT_FOUND`, `UNAVAILABLE` y `CONFLICT`
 * en el mapa de arriba, con frases escritas para la coordinación. Pero
 * `displayError` es el formateador de errores de TODA la app: el mismo
 * `FEATURE_DISABLED` lo tiran cuatro features (`requireFeature` en
 * `branding/service.ts`, `latteService` para generación, `learning/service.ts`
 * y coordinación), `UNAVAILABLE` lo tira el arranque de un runtime, y
 * `NOT_FOUND`/`CONFLICT` los tira medio backend. Quien abría un kit de marca
 * con su flag apagado leía "La coordinación de equipo está apagada": una
 * explicación falsa de un hecho verdadero.
 *
 * Dos mapas, entonces: arriba lo que SÓLO tira el motor de coordinación, acá
 * lo genérico, y ninguna de estas frases nombra equipos ni tareas.
 *
 * N3: `FEATURE_DISABLED` ya no promete Ajustes. No hay interruptor en ninguna
 * pantalla —los flags se escriben en `meta`— así que la frase dice el hecho y
 * se calla la acción que no existe.
 */
/**
 * M2 (ronda 8): EL CONTEXTO DE MARCA TIENE SUS PROPIOS CÓDIGOS.
 *
 * Tres errores de los caminos de contexto de marca viajaban con códigos del
 * mapa de COORDINACIÓN (`PROPOSAL_DECIDED`, `PROPOSAL_STALE`, `MEMBER_BUSY`),
 * así que la persona que aprobaba una propuesta de marca leía una frase
 * escrita para equipos y despachos. Y uno de ellos —"El contexto de marca
 * cambió"— era copy de MARCA viviendo en `error.coordination.*`: el namespace
 * decía una cosa y el texto otra.
 *
 * No van en `APP_ERROR_KEYS` porque no son genéricos de toda la app: son de un
 * alcance concreto, con su pantalla y su vocabulario.
 */
export const BRAND_ERROR_KEYS: Record<string, MessageKey> = {
  BRAND_PROPOSAL_STALE: 'error.brand.proposalStale',
  BRAND_PROPOSAL_DECIDED: 'error.brand.proposalDecided',
  STRATEGIST_BUSY: 'error.brand.strategistBusy',
};

export const APP_ERROR_KEYS: Record<string, MessageKey> = {
  FEATURE_DISABLED: 'error.app.featureDisabled',
  NOT_FOUND: 'error.app.notFound',
  UNAVAILABLE: 'error.app.unavailable',
  CONFLICT: 'error.app.conflict',
  // El código de todo `ValidationError`, que sí cruza IPC por cualquier
  // camino: un nombre de marca vacío no es un problema de coordinación.
  VALIDATION: 'error.app.validation',
};

/**
 * Primero el mapa de coordinación, después el genérico, y al final el
 * `message` del motor: un código sin frase no se tapa con una genérica
 * inventada, porque ahí hay información que alguien va a necesitar.
 *
 * El orden importa y es el único posible: un código que estuviera en los dos
 * mapas tendría que leerse con la frase específica. Hoy no hay ninguno, y el
 * test estructural de `coordination-error-map.dom.test.tsx` lo sostiene.
 */
export const displayError = (e: unknown) => {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  const key = COORDINATION_ERROR_KEYS[code] ?? BRAND_ERROR_KEYS[code] ?? APP_ERROR_KEYS[code];
  if (key) return t(key);
  return e instanceof Error ? e.message : String(e);
};

/**
 * The window is frameless, so Latte draws its own controls. The title bar area
 * is draggable; every button opts out of dragging so it stays clickable.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => api.onWindowState(state => setMaximized(state.maximized)), []);
  return <div className="window-controls">
    <button aria-label="Minimizar" title="Minimizar" onClick={() => api.windowControl('minimize')}><Minus size={15} /></button>
    <button aria-label={maximized ? 'Restaurar' : 'Maximizar'} title={maximized ? 'Restaurar' : 'Maximizar'} onClick={() => api.windowControl('maximize')}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
    <button className="close" aria-label={t('ui.auto.001')} title={t('ui.auto.001')} onClick={() => api.windowControl('close')}><X size={16} /></button>
  </div>;
}
export function App() {
  // Loaded once on mount; null until it arrives so the footer never flashes a fake version.
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]), [brand, setBrand] = useState<Brand | null>(null);
  const [archivedBrands, setArchivedBrands] = useState<Brand[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [works, setWorks] = useState<Work[]>([]), [work, setWork] = useState<Work | null>(null);
  const [context, setContext] = useState('');
  // A returning user lands on Inicio; a just-onboarded one is landed by
  // `finishOnboarding`, which keeps the conversation the walk just opened.
  const [view, setView] = useState<View>('home');
  // Collapsed to a rail: every label hides, every icon and its tooltip stay.
  const [railed, setRailed] = useState(() => { try { return localStorage.getItem('latte:rail') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('latte:rail', railed ? '1' : '0'); } catch { /* private window */ } }, [railed]);
  // Interface density: `simple` hides the inline technical controls, `advanced`
  // shows them. Persisted the same way as the rail, and toggled only in Ajustes.
  const [mode, setMode] = useState<LatteMode>(() => { try { return localStorage.getItem('latte:mode') === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; } });
  useEffect(() => { try { localStorage.setItem('latte:mode', mode); } catch { /* private window */ } }, [mode]);
  // Documents of the current work: the editor lives in DocumentsView, App only tracks which one is open.
  const [documents, setDocuments] = useState<WorkDocument[]>([]), [selectedDoc, setSelectedDoc] = useState<Record<string, string>>({});
  const [documentDirty, setDocumentDirty] = useState(false);
  const [profileDirty,setProfileDirty]=useState(false);
  const [untracked, setUntracked] = useState<UntrackedFile[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRequest[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [contextProposals, setContextProposals] = useState<BrandContextProposal[]>([]);
  // The fingerprint, works and history of the context the editor is editing.
  // Null until the first read: a save with no fingerprint is a save with nothing
  // to compare against, which is the pre-CAS behaviour, not a bypass.
  const [contextStatus, setContextStatus] = useState<BrandContextStatus | null>(null);
  // A save the CAS refused: the context changed underneath. The draft survives
  // and Contexto offers reload-or-override instead of leaving the human stuck.
  const [contextConflict, setContextConflict] = useState(false);
  const [knowledgeScope, setKnowledgeScope] = useState<KnowledgeScope>(ALL_BRAND_SCOPE);
  const [decisionAuthority,setDecisionAuthority]=useState<DecisionAuthorityMode>('suggest');
  const [modal, setModal] = useState<Modal>(null), [name, setName] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]), [provider, setProvider] = useState<Provider>('opencode');
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({}), [starting, setStarting] = useState(false);
  const session = work ? sessions[work.id] ?? null : null;
  const setSession = (value: AgentSession | null) => setSessions(previous => { const next = { ...previous }; if (value) next[value.workId] = value; else if (work) delete next[work.id]; return next; });
  // Settings is a screen of its own: the workspace shell unmounts while it is open (no document controls in the DOM) and comes back untouched.
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // First-run gate: while loading we render the shell (the returning-user path); once the flag resolves the gate takes over for fresh installs.
  const [onboarding, setOnboarding] = useState<'loading' | 'incomplete' | 'complete'>('loading');
  // Persisted mid-flow draft, read at boot so a first paint resumes instantly.
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingDraft | null>(null);
  // The work the walk just created. The brand effect consumes it: `selectWork`
  // would read `brand?.context` from a stale closure and the new work is not
  // guaranteed to be `works[0]` once the list is re-read.
  const pendingWorkRef = useRef<string | null>(null);
  /**
   * The view a pending brand-switch should land on once its work resolves
   * (autonomous-coordination Phase 7 task 7.11): the active-teams strip can
   * select a Brand the person is not currently viewing, and it must land on
   * Decisiones, not the default Brief — same mechanism as `pendingWorkRef`,
   * consumed once by the same effect.
   */
  const pendingViewRef = useRef<View | null>(null);
  /**
   * R5: el Trabajo que LA PERSONA abrió, por su id.
   *
   * Marcar la visita al abrir un Trabajo (F13) chocaba con que la app abre uno
   * SOLA: `works[0]` al arrancar y en cada cambio de Marca. Con eso, "desde tu
   * última visita" se consumía sin que nadie mirara nada — el arranque se
   * comía la novedad que existía para avisarle a la persona.
   *
   * Sólo los caminos de navegación EXPLÍCITA escriben acá: `selectWork` (la
   * lista de Trabajos, las filas de Inicio, `openWorkDecisions`, la cola de
   * revisión) y el `pendingWorkRef` que resuelve una acción de la persona
   * (abrir un run de otra Marca desde la tira, o terminar el onboarding). La
   * autoselección de `list[0]` NO lo escribe, y por eso no cuenta como visita.
   *
   * Es un id y no un booleano a propósito: un `true` del Trabajo anterior
   * sobreviviría a un cambio de Marca y volvería a marcar visto lo que la app
   * eligió sola del otro lado.
   */
  /**
   * Q3: ESTADO, no ref, y por dos razones que son la misma.
   *
   * Como ref, el efecto de abajo sólo la miraba cuando `work.id` o la carga del
   * recorte cambiaban: abrir desde Inicio un Trabajo que ya estaba seleccionado
   * —el caso normal después de volver a la Marca— no volvía a correr el efecto,
   * así que ese acto explícito no anotaba nada. Y como valor que nadie limpiaba
   * sobrevivía a los cambios de Marca, así que la autoselección de `list[0]`
   * anotaba visitas que nadie hizo. Un dato que decide un efecto tiene que
   * poder dispararlo.
   */
  const [humanOpenedWorkId, setHumanOpenedWorkId] = useState<string | null>(null);
  // The brand effect re-reads works when the id changes. Finishing the walk on
  // the already-selected brand (the demo) changes nothing, so it needs its own
  // reason to run; the ref above is only honoured if the effect runs.
  const [brandEpoch, setBrandEpoch] = useState(0);
  // Review retains its resizable split; conversation focus leaves that width untouched.
  const [agentWidth, setAgentWidth] = useState<number>(readAgentWidth), [dragging, setDragging] = useState(false);
  /** The open brand, readable from an async callback that outlived its render. */
  const openBrandId = useRef<string | null>(null);
  useEffect(() => { openBrandId.current = brand?.id ?? null; }, [brand?.id]);
  const [layout, setLayout] = useState<'conversation' | 'review'>('conversation');
  const focusChat = Boolean(work) && layout === 'conversation' && view === 'brief';
  const persistWidth = (value: number) => { try { localStorage.setItem(AGENT_WIDTH_KEY, String(value)); } catch { /* per-viewer convenience only */ } };
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault(); setDragging(true);
    const move = (ev: PointerEvent) => setAgentWidth(clampAgentWidth(window.innerWidth - ev.clientX));
    const up = (ev: PointerEvent) => { const w = clampAgentWidth(window.innerWidth - ev.clientX); setAgentWidth(w); persistWidth(w); setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  useEffect(() => { const onResize = () => setAgentWidth(w => clampAgentWidth(w)); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize); }, []);
  // Team: live sessions by chat id (= member id), the persisted roster of the current work, and the selected member per work.
  const [chats, setChats] = useState<Record<string, ChatSession>>({}), [startingChat, setStartingChat] = useState(false);
  const [permissions, setPermissions] = useState<WorkPermissionMode>('ask');
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [team, setTeam] = useState<TeamMember[]>([]), [roles, setRoles] = useState<AgentRole[]>([]), [selectedMembers, setSelectedMembers] = useState<Record<string, string>>({});
  const [chatRuntime, setChatRuntime] = useState<ChatRuntimeStatus | null>(null);
  const [primary, setPrimary] = useState<PrimaryAgent | null>(null), [agentRuntimes, setAgentRuntimes] = useState<AgentRuntimeInfo[]>([]);
  const selectedMemberId = work ? selectedMembers[work.id] ?? null : null;
  const selectedChat = selectedMemberId ? chats[selectedMemberId] ?? null : null;
  const teamGeneration = useRef(0);
  const loadTeam = async (workId: string) => {
    const n = ++teamGeneration.current;
    const list = await api.listTeam(workId);
    if (n === teamGeneration.current) {
      setTeam(list);
      // Backfills the live store with what the backend persisted, so the
      // consumption line reads correctly even before this session's first
      // `usage` event (a freshly opened app, a member just resumed).
      for (const member of list) chatStore.seedUsage(member.id, member.usage);
    }
    return list;
  };
  /**
   * Autonomous-coordination Phase 7 task 7.11: the one hook that wires real
   * coordination data into `HomeView`, `ResumenView`, `DecisionsView` and
   * `TeamPanel` — every one of which slice 7-A built against additive,
   * optional props only. `activeRuns` is global (every Brand); everything
   * else is scoped to whichever Work is currently open.
   */
  // El canal de error de la app, no una promesa sin manejar: un
  // `BUDGET_EXCEEDED` o un `ValidationError` al resolver un gate se ve.
  const coordination = useCoordination(work?.id ?? null, (e) => setError(displayError(e)));
  // La visita a la coordinación se marca cuando la persona ABRE el panel de
  // coordinación de un Trabajo (Decisiones: gates, autoridad, presupuesto,
  // coordinador) o vuelve a él. Es lo único que hace honesto el "Desde tu
  // última visita" de Inicio: antes no se medía ninguna visita.
  const markSeen = coordination.markSeen;
  // DESPUÉS de que el recorte de coordinación cargue, nunca en el mismo tick
  // del clic. Antes esto corría al montar la pestaña, antes de pedir un solo
  // gate: la visita quedaba anotada sobre una pantalla vacía y todo lo que
  // llegaba después —justamente lo que la persona tenía que ver— nacía ya
  // visto. `workLoaded` es del Trabajo ABIERTO y se apaga al navegar, así que
  // esto tampoco puede marcar visto el Trabajo nuevo por la carga del viejo.
  const coordinationLoaded = coordination.workLoaded;
  // F13: una visita es ABRIR EL TRABAJO, en la vista que sea. Atada a
  // `view === 'decisions'`, la fila "tu equipo terminó" de Inicio —que abre el
  // TRABAJO, no Decisiones— no marcaba nada: la novedad seguía en la tira y el
  // run terminado seguía en la tira global hasta que alguien se acordara de
  // entrar a Decisiones de ese Trabajo. Abrirlo ES mirarlo.
  // R5: y SÓLO si el Trabajo lo abrió la persona. `App` autoselecciona
  // `works[0]` al arrancar y en cada cambio de Marca; con F13 eso anotaba la
  // visita sin un solo acto humano y se comía la fila "tu equipo terminó" —
  // la novedad que existe justamente para avisarle. `humanOpenedWorkId` lo
  // escriben los caminos de navegación explícita, nunca la autoselección.
  // Q3: y la ref se CONSUME al marcar. Un acto explícito vale por UNA visita:
  // dejarla puesta hacía que cualquier re-carga posterior del recorte de
  // coordinación —otra Marca y vuelta, un evento que refresca— volviera a
  // anotar visto un Trabajo que la persona no abrió de nuevo.
  useEffect(() => {
    if (work?.id && coordinationLoaded && humanOpenedWorkId === work.id) {
      markSeen();
      setHumanOpenedWorkId(null);
    }
  }, [work?.id, coordinationLoaded, humanOpenedWorkId]);
  // The memory notice (task 7.10) is dismissed per Brand, for this session
  // only: this state is plain React state, never persisted, so it "returns
  // next launch while the condition holds" simply because a fresh launch
  // starts with an empty Set — no localStorage, no backend write.
  const [memoryNoticeDismissed, setMemoryNoticeDismissed] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState(''), [decision, setDecision] = useState('');
  const [memory, setMemory] = useState(''), [memoryAvailable, setMemoryAvailable] = useState(false), [memoryNote, setMemoryNote] = useState('');
  const [endedSessions, setEndedSessions] = useState<Set<string>>(new Set());
  const sessionEnded = Boolean(session && endedSessions.has(session.id));
  const generation = useRef(0), memoryGeneration = useRef(0);
  const selectionWorkRef = useRef<string | null>(null);
  const dirty = profileDirty || documentDirty || documentDrafts.hasUnsaved() || hasMetadataDrafts() || hasOutcomeDrafts(), contextDirty = Boolean(brand && context !== brand.context);
  /**
   * The Contexto editor's live values, for the turn-end refresh.
   *
   * That refresh runs from a chat subscription created once per work, so it
   * cannot close over `brand`, `context` and `contextDirty` without going
   * stale. The ref is updated after every render and the refresh reads it.
   */
  const brandContextRef = useRef({ brand, context, dirty: contextDirty });
  useEffect(() => { brandContextRef.current = { brand, context, dirty: contextDirty }; });
  /**
   * The newest status read in flight.
   *
   * Two things read the status: the brand-change / turn-end refresh and the
   * reload right after a write. Without an order, the slower one can land last
   * and leave the editor holding a fingerprint that is already superseded — so
   * the next save is refused with a conflict Latte invented itself.
   */
  const contextStatusSeq = useRef(0);
  /**
   * How many authoritative brand-context values the editor has taken: a write,
   * or an explicit reload.
   *
   * A refresh that started BEFORE one of those read an older `brands.context`.
   * If it applied after, it would put that older value back on screen, so it
   * bails instead: the write's own reload already brought the fresh state.
   */
  const contextWriteSeq = useRef(0);
  /**
   * Reads the status and applies it only if nothing newer landed since.
   *
   * Returns null when the read was superseded, so the caller knows not to trust
   * its result as the current one.
   */
  const readContextStatus = async (brandId: string): Promise<BrandContextStatus | null> => {
    const seq = ++contextStatusSeq.current;
    const status = await api.brandContextStatus(brandId);
    if (seq !== contextStatusSeq.current) return null;
    if (brandContextRef.current.brand?.id !== brandId) return null;
    // One read gives the proposals AND the fingerprint the editor is editing
    // against: without it a save could not tell "changed underneath" from "mine".
    setContextStatus(status);
    setContextProposals(status.proposals);
    return status;
  };
  /**
   * Re-reads `brands.context` and this brand's proposals.
   *
   * An agent can propose a context on its own, and the brand can change under
   * us. `applyFetchedBrand` keeps that honest: a clean editor follows the new
   * value, a dirty one keeps the human's text and says so (`context.staleDraft`).
   */
  const refreshBrandContext = async () => {
    const current = brandContextRef.current;
    if (!current.brand) { setContextProposals([]); setContextStatus(null); return; }
    const brandId = current.brand.id;
    const writes = contextWriteSeq.current;
    // The status read applies itself (guarded by sequence); the brand always
    // lands, because a superseded status says nothing about this brand fetch.
    const [fetched] = await Promise.all([api.getBrand(brandId), readContextStatus(brandId)]);
    if (brandContextRef.current.brand?.id !== brandId) return;
    // A write landed while this read was in flight: its value is newer than ours.
    if (writes !== contextWriteSeq.current) return;
    const applied = applyFetchedBrand({ selectedId: brandId, fetched, previousPersisted: current.brand.context, draft: current.context, dirty: current.dirty });
    if (!applied.applied) return;
    setBrand(applied.brand);
    setBrands(previous => previous.map(x => x.id === applied.brand.id ? applied.brand : x));
    setContext(applied.draft);
    if (applied.notice) setNotice(t('context.staleDraft'));
  };
  const selectedDocId = brand ? selectedDoc[brand.id] ?? null : null;
  const titlesByWork = workTitles(works);
  const visibleDocuments = inKnowledgeScope(documents, knowledgeScope);
  const visibleDecisions = inKnowledgeScope(decisions, knowledgeScope);
  const showWorkDelta = knowledgeScope === ALL_BRAND_SCOPE || knowledgeScope === (work?.id ?? '');
  // Inicio's two live facts, both read from the status the shell already loads:
  // no new call, and the badge names no agent (the roster is per-work).
  const liveWorkIds = (contextStatus?.works ?? []).filter((entry) => entry.live).map((entry) => entry.id);
  const pendingContextProposals = contextStatus?.pending ? 1 : 0;
  // ONE review sweep for Inicio and Resumen, owned here and gated on the view.
  // `home` and `resumen` never mount together — one `view` selects one `<main>`
  // branch — so exactly one sweep is ever active and the sweep can never double.
  const { states: homeStates, checking: homeChecking } = useDocumentStates(brand?.id ?? '', documents, (view === 'home' || view === 'resumen') && Boolean(brand));
  // Who is writing to which file right now, straight from each runtime's own
  // tool reports. A write that did not come through a tool is never attributed.
  const documentFileNames = documents.map(d => d.fileName);
  const liveEdits = useActiveEdits(chatStore, documentFileNames);
  const editors: Record<string, { roleId: string; roleName: string }> = {};
  for (const [chatId, files] of Object.entries(liveEdits)) {
    const session = chats[chatId];
    if (!session) continue;
    for (const file of files) editors[file] = { roleId: session.roleId, roleName: session.roleName };
  }
  // `stillWanted` lets a caller that can be superseded (the effect on the open
  // work) drop a listing that arrived after the work changed.
  const loadFolderDelta = (workId: string, stillWanted: () => boolean = () => true) => {
    // An agent can create a file but cannot register it: Latte finds it and offers to adopt it.
    void api.listUntrackedFiles(workId).then(list => { if (stillWanted()) setUntracked(list); }).catch(() => { if (stillWanted()) setUntracked([]); });
    // An agent can ask for a colleague the same way: by leaving a file.
    void api.listHandoffs(workId).then(list => { if (stillWanted()) setHandoffs(list); }).catch(() => { if (stillWanted()) setHandoffs([]); });
  };
  const loadKnowledge = async (brandId: string, workId?: string | null) => {
    const [docs, listed] = await Promise.all([api.listBrandDocuments(brandId), api.listBrandDecisions(brandId)]);
    setDocuments(docs);
    setDecisions(listed);
    if (workId) loadFolderDelta(workId);
    return docs;
  };
  /** Saves an answer from the conversation as a document of this work. */
  const saveAnswerAsDocument = (text: string) => {
    if (!work) return;
    const title = window.prompt(t('ui.auto.002'), 'Estrategia');
    if (!title || !title.trim()) return;
    const guess = /calendario|cronograma/i.test(title) ? 'calendar' : /estrateg/i.test(title) ? 'strategy' : /investigac|research/i.test(title) ? 'research' : /copy|pieza/i.test(title) ? 'copy' : 'note';
    void run(async () => {
      const document = await api.saveAsDocument(work.id, guess as DocumentKind, title.trim(), text);
      await loadKnowledge(work.brandId, work.id);
      setSelectedDoc(prev => ({ ...prev, [work.brandId]: document.id }));
      setLayout('review'); setView('brief');
      setNotice(t('ui.auto.336', { p0: document.title }));
    });
  };

  const trackFile = async (fileName: string) => {
    if (!work) return;
    const focused = document.activeElement as HTMLElement | null;
    const conversation = document.querySelector<HTMLElement>('.chat-scroll');
    const scrollTop = conversation?.scrollTop;
    await run(async () => {
      const trackedDocument = await api.trackFile(work.id, fileName);
      await loadKnowledge(work.brandId, work.id);
      setNotice(t('chat.fileAdded', { name: trackedDocument.title }));
      requestAnimationFrame(() => {
        if (conversation && scrollTop !== undefined) conversation.scrollTop = scrollTop;
        if (focused?.isConnected) focused.focus();
        else document.querySelector<HTMLTextAreaElement>('.prompt-form textarea')?.focus();
      });
    });
  };
  const transitioning = busy || starting || startingChat;
  const guard = () => !transitioning && (!(dirty || contextDirty) || window.confirm(t('ui.auto.003')));
  const run = async (fn: () => Promise<void>) => { setError(''); setBusy(true); try { await fn(); } catch (e) { setError(displayError(e)); } finally { setBusy(false); } };
  // Decision actions, hoisted out of the inline decisions block into App so the
  // extracted `DecisionsView` stays props-only: every backend call and state
  // write lives here, the view only renders and forwards intent.
  const changeDecisionAuthority = (mode: DecisionAuthorityMode) => {
    if (!work) return;
    void api.setDecisionAuthority(work.id, mode).then(setDecisionAuthority).catch(x => setError(displayError(x)));
  };
  const addDecision = (text: string) => void run(async () => {
    if (!work || !text.trim()) return;
    await api.addDecision(work.id, text.trim());
    setDecisions(await api.listBrandDecisions(work.brandId));
    setDecision('');
  });
  /**
   * Re-reads the decisions of the brand the action was taken in, and applies
   * them only if that brand is still the open one. These four actions do not
   * go through `run()`, so nothing marks the app busy and a brand switch right
   * after a click is free: without this, the list of the brand just left would
   * land on the new one, and the next approval would act on the wrong brand.
   */
  const refreshDecisionsOf = async (brandId: string) => {
    const listed = await api.listBrandDecisions(brandId);
    if (brandId === openBrandId.current) setDecisions(listed);
  };
  const approveDecision = (id: string) => { if (!brand) return; const owner = brand.id; void api.approveDecision(id, null).then(() => refreshDecisionsOf(owner)).catch(e => setError(displayError(e))); };
  const editApproveDecision = (id: string, edited: string) => { if (!brand) return; const owner = brand.id; void api.approveDecision(id, edited).then(() => refreshDecisionsOf(owner)).catch(e => setError(displayError(e))); };
  const rejectDecision = (id: string) => { if (!brand) return; const owner = brand.id; void api.rejectDecision(id).then(() => refreshDecisionsOf(owner)).catch(e => setError(displayError(e))); };
  const archiveDecision = (id: string) => { if (!brand) return; const owner = brand.id; void api.archiveDecision(id).then(() => refreshDecisionsOf(owner)).catch(e => setError(displayError(e))); };
  // True until the first detection answers. The runtimes are found by running
  // their CLIs, which costs seconds: an empty list means "not asked yet", and
  // the UI has to say that instead of offering nothing.
  const [checkingAgents, setCheckingAgents] = useState(true);
  const refreshChatStatus = () => {
    setCheckingAgents(true);
    return Promise.all([
      api.chatStatus().then(setChatRuntime).catch(e => setChatRuntime({ available: false, detail: displayError(e), version: null, models: [], defaultModel: null })),
      api.getPrimaryAgent().then(setPrimary).catch(() => setPrimary(null)),
      api.listAgentRuntimes().then(setAgentRuntimes).catch(() => setAgentRuntimes([])),
    ]).then(() => { setCheckingAgents(false); });
  };
  // The primary agent is chosen once in Providers; here we only say whether it can start.
  const primaryRuntime = primary?.runtime ?? 'opencode';
  const primaryAccount = primaryRuntime === 'opencode' ? null : agentRuntimes.find(r => r.runtime === primaryRuntime)?.accounts.find(a => a.id === (primary?.accountId ?? 'system')) ?? null;
  const primaryReady = primaryRuntime === 'opencode' ? Boolean(chatRuntime?.available) : Boolean(primaryAccount?.loggedIn);
  const primaryLabel = primary?.label ?? t('agent.primaryFallback');
  const activeRuntime = selectedChat?.provider ?? primaryRuntime;
  const runtimeName = activeRuntime === 'claude' ? 'Claude Code' : activeRuntime === 'codex' ? 'Codex' : 'OpenCode';
  const primaryDetail = primaryRuntime === 'opencode' ? (chatRuntime?.detail ?? 'Comprobando OpenCode…') : (primaryAccount ? primaryAccount.detail : `${primaryRuntime === 'claude' ? 'Claude Code' : 'Codex'}: cuenta no disponible`);
  // Alternatives to the primary agent when adding a member: every logged-in subscription account, plus OpenCode when configured.
  const runtimeChoices: RuntimeChoice[] = [
    ...agentRuntimes.flatMap(r => r.accounts.filter(a => a.loggedIn).map(a => ({ key: `${r.runtime}:${a.id}`, label: `${r.runtime === 'claude' ? 'Claude Code' : 'Codex'} · ${a.label}`, runtime: r.runtime, accountId: a.id }))),
    ...(chatRuntime?.available ? [{ key: 'opencode', label: `OpenCode · ${chatRuntime.defaultModel ?? 'modelo por defecto'}`, runtime: 'opencode' as const, accountId: null }] : []),
  ].filter(c => !(c.runtime === primaryRuntime && (c.runtime === 'opencode' || c.accountId === (primary?.accountId ?? 'system'))));
  useEffect(() => { void Promise.all([api.listBrands(), api.listArchivedBrands()]).then(([list, archived]) => { setBrands(list); setArchivedBrands(archived); if (list[0]) { setBrand(list[0]); setContext(list[0].context); } }).catch(e => setError(displayError(e))); void api.runtimeStatus().then(setRuntimes).catch(e => setError(displayError(e))); void api.listRoles().then(setRoles).catch(e => setError(displayError(e))); void api.appInfo().then(setAppInfo).catch(e => setError(displayError(e))); void refreshChatStatus(); void Promise.all([api.getOnboardingComplete(), api.getOnboardingDraft().catch(() => null)]).then(([complete, draft]) => { setOnboardingDraft(draft); setOnboarding(complete ? 'complete' : 'incomplete'); }).catch(() => setOnboarding('complete')); }, []);
  // The team read is generation-guarded; the two reads beside it were not, so a
  // fast switch between works could land the PREVIOUS work's permissions on
  // this one — and that value decides whether an agent writes without asking.
  useEffect(() => {
    if (!work) { setTeam([]); setPermissions('ask'); setDecisionAuthority('suggest'); return; }
    let active = true;
    void loadTeam(work.id).catch(e => setError(displayError(e)));
    void api.getWorkPermissions(work.id).then(value => { if (active) setPermissions(value); }).catch(() => { if (active) setPermissions('ask'); });
    void api.getDecisionAuthority(work.id).then(value => { if (active) setDecisionAuthority(value); }).catch(() => { if (active) setDecisionAuthority('suggest'); });
    return () => { active = false; };
  }, [work?.id]);
  useEffect(() => { if (!brand) return; const n = ++generation.current; setWork(null); setWorks([]); setKnowledgeScope(ALL_BRAND_SCOPE); void api.listWorks(brand.id).then(list => { if (n !== generation.current) return; setWorks(list); const requested = list.find(w => w.id === pendingWorkRef.current) ?? null; const preferred = requested ?? list[0] ?? null; pendingWorkRef.current = null; /* R5: sólo el Trabajo PEDIDO por una acción de la persona cuenta como abierto por ella; `list[0]` lo elige la app sola y no es ninguna visita. Q3: y se PISA, no se deja. Sin el `else` la ref sobrevivía al cambio de Marca, así que volver a esta Marca por el selector autoseleccionaba `list[0]` —que puede ser el mismo Trabajo— y la visita se anotaba sola, con la persona mirando Inicio. */ setHumanOpenedWorkId(requested?.id ?? null); setWork(preferred); if (preferred && pendingViewRef.current) setView(pendingViewRef.current); pendingViewRef.current = null; }).catch(e => setError(displayError(e))); }, [brand?.id, brandEpoch]);
  useEffect(() => {
    if (!brand) { setDocuments([]); setDecisions([]); return; }
    let active = true;
    void Promise.all([api.listBrandDocuments(brand.id), api.listBrandDecisions(brand.id)]).then(([docs, listed]) => {
      if (active) { setDocuments(docs); setDecisions(listed); }
    }).catch(e => { if (active) setError(displayError(e)); });
    return () => { active = false; };
  }, [brand?.id, works.map(w => w.id).join(',')]);
  // Same guard as the documents effect below: a slower listing from the work
  // just left would otherwise offer its untracked files and its handoffs here,
  // and accepting one would act on the wrong work's folder.
  useEffect(() => {
    if (!work) { setUntracked([]); setHandoffs([]); return; }
    let active = true;
    loadFolderDelta(work.id, () => active);
    return () => { active = false; };
  }, [work?.id]);
  useEffect(() => {
    if (!brand || !work) { selectionWorkRef.current = null; return; }
    if (selectionWorkRef.current === work.id) return;
    if (!workBrief(documents, work.id)) return;
    selectionWorkRef.current = work.id;
    setSelectedDoc((prev) => selectWorkBrief(prev, brand.id, work.id, documents));
  }, [brand?.id, work?.id, documents]);
  useEffect(() => {
    if (!brand) { setContextProposals([]); return; }
    void refreshBrandContext().catch((e) => setError(displayError(e)));
  }, [brand?.id]);
  /**
   * When an agent finishes a turn, look at the folder again.
   *
   * An agent writes files directly to disk and has no way to register them, so
   * without this Latte kept showing the folder as it was before the agent
   * worked: the new file stayed invisible, the offer to adopt it never
   * appeared, and saving the answer produced a second copy of the same thing.
   * A real run is what surfaced it; the turn ending is the honest moment to look.
   */
  const workChatIds = Object.values(chats).filter(c => work && c.workId === work.id).map(c => c.id).join(',');
  useEffect(() => {
    if (!work) return;
    const ids = workChatIds ? workChatIds.split(',') : [];
    if (ids.length === 0) return;
    const anyBusy = () => ids.some(id => chatStore.get(id).status !== 'idle');
    let wasBusy = anyBusy();
    return chatStore.subscribe(() => {
      const busyNow = anyBusy();
      if (wasBusy && !busyNow) {
        void loadKnowledge(work.brandId, work.id).catch(() => undefined);
        // An agent can also have proposed brand context during that turn.
        void refreshBrandContext().catch(() => undefined);
      }
      wasBusy = busyNow;
    });
  }, [work?.id, workChatIds]);
  // Only real unsaved edits are worth a confirmation. Open chats and terminals
  // are not: closing the app is how you end them.
  const unsaved = dirty || contextDirty;
  useEffect(() => {
    // Desktop: report the state and let the main process ask with a native
    // dialog. A cancelled beforeunload shows nothing in Electron and would
    // leave the close button silently doing nothing.
    if (isDesktop) { api.reportUnsaved(unsaved); return; }
    // Web preview: the browser does show its own confirmation, so use it.
    const warn = (e: BeforeUnloadEvent) => { if (unsaved) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => api.onAgentEvent(event => { if (event.type === 'exit') { setEndedSessions(previous => new Set(previous).add(event.sessionId)); setNotice(t('ui.auto.004')); } if (event.type === 'error') setError(event.data); }), []);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, [tabindex="0"]') ?? []);
    if (!dialog?.contains(document.activeElement)) controls()[0]?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setModal(null); if (e.key !== 'Tab') return; const list = controls(); const first = list[0], last = list[list.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } };
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [modal, busy]);
  const selectBrand = (b: Brand) => { if (!guard()) return; setBrand(b); setContext(b.context); setView('home'); setMemory(''); setMemoryAvailable(false); memoryGeneration.current++; };
  /**
   * Opens a work. The target defaults to the work's brief, so every existing
   * call site keeps opening the conversation; Inicio passes `decisions` when the
   * row it activated was a pending decision.
   */
  const selectWork = (w: Work, target: 'brief' | 'decisions' = 'brief', as: 'conversation' | 'review' = 'conversation') => {
    if (!guard()) return;
    // R5: TODO camino que pasa por acá es un acto de la persona — un clic en la
    // lista de Trabajos, una fila de Inicio, la cola de revisión. La visita se
    // anota sólo por estos, nunca por la autoselección del arranque.
    setHumanOpenedWorkId(w.id);
    setWork(w);
    setContext(brand?.context ?? '');
    setView(target);
    // Entering a work states its layout here, once. An effect on `work.id`
    // used to reset it after the fact, so any caller that asked for the
    // document (Inicio's review queue) was overwritten into the chat.
    setLayout(as);
    if (brand) setSelectedDoc((prev) => selectWorkBrief(prev, brand.id, w.id, documents));
  };
  // Inicio's rows are ids, because the surface renders rows and the shell owns
  // the resolution: a row whose work is gone does nothing instead of crashing.
  const openWork = (workId: string) => { const target = works.find((w) => w.id === workId); if (target) selectWork(target); };
  const openWorkDecisions = (workId: string) => { const target = works.find((w) => w.id === workId); if (target) selectWork(target, 'decisions'); };
  /**
   * The active-teams strip (task 7.8) only observes and navigates: clicking
   * a row selects that Brand + Work and opens Decisiones, where the real
   * approve/reject controls live. When the run's Brand is already open,
   * this is `openWorkDecisions` unchanged. When it is a DIFFERENT Brand —
   * the interesting case, a run the person was not looking at — the same
   * `pendingWorkRef` mechanism `finishOnboarding` uses lands on the right
   * work once its list loads, and `pendingViewRef` (added for this task)
   * makes it land on Decisiones instead of the default Brief.
   */
  const openActiveRun = (run: CoordinationActiveRunSummary) => {
    if (brand?.id === run.brandId) { openWorkDecisions(run.workId); return; }
    const target = brands.find((b) => b.id === run.brandId);
    if (!target || !guard()) return;
    pendingWorkRef.current = run.workId;
    pendingViewRef.current = 'decisions';
    setBrand(target);
    setContext(target.context);
    setMemory(''); setMemoryAvailable(false); memoryGeneration.current++;
  };
  const openDocument = (documentId: string) => {
    const document = documents.find((d) => d.id === documentId);
    if (!document) return;
    const owner = works.find((w) => w.id === document.workId);
    // `selectWork` goes first: it lands on the work's brief and resets the
    // selected document, so the explicit selection has to be the last write.
    // A row in the review queue asks for the DOCUMENT, so it opens in review.
    if (owner) selectWork(owner, 'brief', 'review');
    if (brand) setSelectedDoc((prev) => ({ ...prev, [brand.id]: document.id }));
  };
  const openNewWork = () => { setName(''); setModal('work'); };
  const openAddBrand = () => { setName(''); setModal('brand'); };
  // First-run gate actions: skip sets the flag and keeps the returning-user path
  // intact; completion re-bootstraps and pre-selects the recommended role.
  //
  // Both REJECT on failure on purpose. While the gate is mounted it is the only
  // surface on screen, so writing the failure into the shell's `error` state
  // renders it off-screen: the human sees nothing. The gate owns the failure and
  // shows it with a retry that finishes the same action.
  const skipOnboarding = async () => {
    await api.setOnboardingComplete(true);
    setOnboarding('complete');
    // The demo brand is already seeded by the backend on an empty database; just re-read it.
    void api.listBrands().then(list => { setBrands(list); if (list[0]) { setBrand(list[0]); setContext(list[0].context); } }).catch(() => undefined);
  };
  /**
   * Lands the walk in the shipped workspace.
   *
   * `selectBrand` is reused so guard(), the context swap, the memory reset and
   * `memoryGeneration` behave exactly like a sidebar switch. The work is picked
   * by the brand effect through `pendingWorkRef`, never by calling `selectWork`:
   * that one reads `brand?.context` from a stale closure and would put the old
   * brand's context on screen.
   */
  const finishOnboarding = async (result: OnboardingResult) => {
    // No catch on purpose: the gate owns this call and shows the failure with a
    // retry. Swallowing it here used to leave the gate frozen with no message,
    // because the shell's error state renders off-screen behind the gate.
    await api.setOnboardingComplete(true);
    const list = await api.listBrands();
    setBrands(list);
    const brand = list.find(b => b.id === result.brandId) ?? list[0] ?? null;
    pendingWorkRef.current = result.workId;
    if (brand) selectBrand(brand);
    // The walk just opened a role conversation. A returning user starts on
    // Inicio; a just-onboarded one lands where the walk left them, so the
    // validated onboarding landing is preserved instead of being re-decided.
    setLayout('conversation');
    setView('brief');
    // The extra bump re-reads the works even when the brand was already the
    // selected one (choosing the demo), which changes no id at all.
    setBrandEpoch(n => n + 1);
    setOnboarding('complete');
    // The gate unmounts with this result, so the shell is the only place the
    // human can still be told what the brief or the folder link did.
    if (result.briefConflict) setNotice(t('onboarding.briefConflict'));
    else if (result.folderLinkError) setNotice(t('onboarding.folderLinkFailed', { reason: result.folderLinkError }));
    else if (result.folderNotLinked) setNotice(t('onboarding.folderNotLinked'));
    // Pre-select the recommended role (opens its conversation). The web preview has no live team, so this is desktop-only.
    if (isDesktop && result.recommendedRoleId) {
      void api.addTeamMember(result.workId, result.recommendedRoleId).then(s => {
        setChats(prev => ({ ...prev, [s.id]: s }));
        setSelectedMembers(prev => ({ ...prev, [result.workId]: s.id }));
        void loadTeam(result.workId);
      }).catch(e => setError(displayError(e)));
    }
  };
  // Reopening the walk has to close Settings with it: the Settings branch renders
  // before the gate, so leaving it open would hide the walk behind the screen the
  // button was clicked from, and the click would look like it did nothing. The
  // draft held here is the one read at boot; the flag write clears it on disk, so
  // it has to be dropped too or the fresh walk resumes a finished one.
  const reopenOnboarding = () => { void api.setOnboardingComplete(false).then(() => { setOnboardingDraft(null); setSettings(null); setOnboarding('incomplete'); }).catch(e => setError(displayError(e))); };
  /**
   * A brand-context write landed. The report is what makes it honest: when a
   * work has a live session, the write does not reach it, and the notice says
   * so (`ui.auto.052`) instead of claiming everything is up to date.
   */
  const applyBrandDecision = async (result: Pick<BrandContextDecisionResult, 'brand' | 'refresh'>) => {
    contextWriteSeq.current += 1;
    setBrand(result.brand);
    setBrands((prev) => prev.map((x) => x.id === result.brand.id ? result.brand : x));
    setContext(result.brand.context);
    // The editor is clean again and the ref must say so BEFORE the status
    // reload: otherwise the reload reads a stale draft and reports a conflict.
    brandContextRef.current = { brand: result.brand, context: result.brand.context, dirty: false };
    setContextConflict(false);
    const notice = contextSaveNotice(result.refresh);
    setNotice(t(notice.key, notice.params));
    // The fingerprint the editor holds changed with the write, and this reload
    // is AWAITED on purpose. The save controls are disabled while a write is in
    // flight, so awaiting is what guarantees the next save sends a fresh
    // fingerprint instead of being refused with a conflict Latte created itself.
    await readContextStatus(result.brand.id).catch(() => null);
  };
  /** The fingerprint of what the editor loaded, or null before the first read. */
  const contextFingerprint = contextStatus?.fingerprint ?? null;
  /**
   * Runs a brand-context write and keeps the draft when the CAS refuses it.
   *
   * A refusal is not a dead end: `contextConflict` turns on the reload/override
   * affordance in Contexto, and the human's text is untouched.
   */
  const writeContext = async (write: () => Promise<Pick<BrandContextDecisionResult, 'brand' | 'refresh'>>) => {
    try {
      await applyBrandDecision(await write());
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'CONTEXT_STALE') setContextConflict(true);
      throw e;
    }
  };
  const saveContext = async () => {
    if (!brand) return;
    await writeContext(() => api.saveBrandContext(brand.id, context, contextFingerprint));
  };
  /** Emptying is explicit and confirmed; the empty box alone is refused. */
  const clearContext = async () => {
    if (!brand) return;
    if (!window.confirm(t('context.clear.confirm'))) return;
    await writeContext(() => api.clearBrandContext(brand.id, contextFingerprint));
  };
  /** Restoring is a write too: confirmed, recorded, and reversible. */
  const restoreContext = async (revisionId: string) => {
    if (!brand) return;
    if (!window.confirm(t('context.restore.confirm'))) return;
    await writeContext(() => api.restoreBrandContextRevision(brand.id, revisionId, contextFingerprint));
  };
  /**
   * The human's answer to a refused save: take what is on disk and drop the
   * draft. `refreshBrandContext` deliberately keeps a dirty draft, which is the
   * opposite of what someone asking for the current value wants.
   */
  const reloadContext = () => run(async () => {
    if (!brand) return;
    const fetched = await api.getBrand(brand.id);
    contextWriteSeq.current += 1;
    setBrand(fetched);
    setBrands((prev) => prev.map((x) => x.id === fetched.id ? fetched : x));
    setContext(fetched.context);
    brandContextRef.current = { brand: fetched, context: fetched.context, dirty: false };
    setContextConflict(false);
    await readContextStatus(fetched.id).catch(() => null);
  });
  /**
   * The other answer: keep the draft and write it against the value that is
   * there now. Explicit, never a silent last-write-wins.
   */
  const overrideContext = () => run(async () => {
    if (!brand) return;
    const status = await readContextStatus(brand.id).catch(() => null);
    await writeContext(() => api.saveBrandContext(brand.id, context, status?.fingerprint ?? contextFingerprint));
  });
  const decideContextProposal = async (proposalId: string, action: 'approve' | 'edit' | 'reject', acceptStale = false) => {
    if (!brand) return;
    if (action === 'reject') await writeContext(() => api.rejectBrandContextProposal(proposalId));
    else {
      let edited: string | null = null;
      if (action === 'edit') {
        const current = contextProposals.find((p) => p.id === proposalId);
        const next = window.prompt(t('context.editAccept'), current?.text ?? '');
        if (!next?.trim()) return;
        edited = next.trim();
      }
      await writeContext(() => api.approveBrandContextProposal(proposalId, edited, acceptStale));
    }
  };
  const askStrategist = () => run(async () => {
    if (!work) { setNotice(t('context.ask.needWork')); return; }
    const session = await api.requestBrandContextDraft(work.id);
    setChats((prev) => ({ ...prev, [session.id]: session }));
    setSelectedMembers((prev) => ({ ...prev, [work.id]: session.id }));
    await loadTeam(work.id);
    setLayout('conversation');
    setView('brief');
    setNotice(t('ui.auto.341', { p0: session.roleName }));
  });
  const reloadBrandLists = async () => {
    const [list, archived] = await Promise.all([api.listBrands(), api.listArchivedBrands()]);
    setBrands(list);
    setArchivedBrands(archived);
    return { list, archived };
  };
  const archiveSelectedBrand = async () => {
    if (!brand) return;
    if (!window.confirm(t('brand.archiveConfirm', { name: brand.name }))) return;
    await api.archiveBrand(brand.id);
    const { list } = await reloadBrandLists();
    const next = list[0] ?? null;
    setBrand(next);
    setContext(next?.context ?? '');
    setWork(null);
    setWorks([]);
    setView('brief');
    setNotice(t('brand.archived'));
  };
  const restoreArchivedBrand = async (id: string) => {
    const restored = await api.restoreBrand(id);
    const { list } = await reloadBrandLists();
    setNotice(t('brand.restored'));
    if (!brand) {
      const next = list.find(x => x.id === restored.id) ?? list[0] ?? null;
      if (next) { setBrand(next); setContext(next.context); }
    }
  };
  const onWorkUpdated = (updated: Work) => { setWork(updated); setWorks(prev => prev.map(x => x.id === updated.id ? updated : x)); };
  const openMemory = () => { setView('memory'); if (!brand) return; const n = ++memoryGeneration.current; setMemory('Recuperando memoria…'); void api.readMemory(brand.id).then(r => { if (n !== memoryGeneration.current) return; setMemory(r.text); setMemoryAvailable(r.available); }).catch(e => setError(displayError(e))); };
  const create = () => run(async () => { if (!name.trim()) return; if (!guard()) return; if (modal === 'brand') { const b = await api.createBrand(name.trim()); setBrands(prev => [...prev, b]); setBrand(b); setContext(b.context); } else if (brand) { const w = await api.createWork(brand.id, name.trim()); setWorks(prev => [...prev, w]); setWork(w); setLayout('conversation'); setContext(brand.context); } setView('brief'); setModal(null); setName(''); });
  const createDocument = async (kind: DocumentKind, title: string, baseDocumentId: string | null) => {
    if (!work) return;
    await run(async () => {
      const created = await api.createDocument(work.id, kind, title, baseDocumentId);
      await loadKnowledge(work.brandId, work.id);
      setSelectedDoc(prev => ({ ...prev, [work.brandId]: created.document.id }));
      setModal(null);
      // A template is an empty structure on purpose: nobody wants invented data.
      // But a derived document that stays empty is a dead end, so the ask to
      // fill it is written out here and left in the chat for review, not sent.
      const base = baseDocumentId ? documents.find(d => d.id === baseDocumentId) : null;
      if (!base) { setNotice(t('ui.auto.006')); return; }
      const ask = `Completá ${created.document.fileName} a partir de ${base.fileName}. Escribí el archivo en este turno con lo que ya tengamos, y marcá cada hueco como PENDIENTE: qué falta y por qué importa.`;
      const open = selectedMemberId && chats[selectedMemberId] ? chats[selectedMemberId] : Object.values(chats).find(c => c.workId === work.id) ?? null;
      if (!open) { setNotice(t('ui.auto.338', { p0: created.document.title, p1: base.title })); return; }
      chatStore.setDraft(open.id, ask);
      setSelectedMembers(prev => ({ ...prev, [work.id]: open.id }));
      setNotice(t('ui.auto.339', { p0: created.document.title, p1: open.roleName }));
    });
  };
  /**
   * Points this work at a folder the person already uses. Latte then works in
   * it: no copy. It writes its context files there and agents get that folder,
   * so the confirmation says exactly that before anything happens.
   */
  const useFolder = () => {
    if (!work) return;
    if (!confirmFolderLink()) return;
    void run(async () => {
      const result = await api.useFolder(work.id);
      if (!result) return;
      onWorkUpdated(result.work);
      await loadKnowledge(work.brandId, work.id);
      const extra = result.otherFiles.length + result.subfolders.length;
      setNotice(result.documents.length > 0
        ? t('ui.auto.340', { p0: result.documents.length, p1: result.documents.length === 1 ? '' : 's', p2: extra ? `; hay ${extra} archivo(s) y carpeta(s) más que el agente puede leer` : '' })
        : t('ui.auto.007'));
    });
  };

  // Nothing is saved implicitly. Opening a member warns instead of writing the editor's text.
  const warnUnsaved = () => { if (dirty) setNotice(t('ui.auto.008')); };
  const start = async () => { if (!work || starting || session) return; setStarting(true); setError(''); try { warnUnsaved(); const s = await api.startAgent(work.id, provider); setSession(s); setNotice(t('ui.auto.009')); } catch (e) { setError(displayError(e)); } finally { setStarting(false); } };
  // Team actions. A member's chat id is its member id, so the store state follows it through pause and resume.
  const selectMember = (memberId: string) => { if (work) setSelectedMembers(prev => ({ ...prev, [work.id]: memberId })); };
  const openSession = async (open: () => Promise<ChatSession>, workId: string) => {
    setStartingChat(true); setError('');
    try { warnUnsaved(); const s = await open(); setChats(prev => ({ ...prev, [s.id]: s })); if (s.resumed) await chatStore.sync(s.id); setSelectedMembers(prev => ({ ...prev, [workId]: s.id })); await loadTeam(workId); setNotice(s.resumed ? t('app.resumed', { name: s.roleName }) : t('ui.auto.341', { p0: s.roleName })); return s; }
    catch (e) { setError(displayError(e)); void refreshChatStatus(); throw e; }
    finally { setStartingChat(false); }
  };
  const addMember = async (roleId: string, options: TeamMemberOptions | null) => { if (!work || startingChat) return; await openSession(() => api.addTeamMember(work.id, roleId, options), work.id).catch(() => undefined); };
  const openMember = async (memberId: string) => { if (!work || startingChat) return; chatStore.forget(memberId); await openSession(() => api.openTeamMember(memberId), work.id).catch(() => undefined); };
  /**
   * The grant is a start-time flag of the agent process, so a conversation
   * already running would not see it. Rather than say "next time", the idle
   * Claude members are reopened right here: pause and resume keeps their
   * history. One that is mid-answer is left alone and named.
   */
  const changePermissions = (next: WorkPermissionMode) => {
    if (!work || permissionBusy || next === permissions) return;
    const currentWork = work;
    setPermissionBusy(true);
    setError('');
    void (async () => {
      const previous = permissions;
      await api.setWorkPermissions(currentWork.id, next);
      setPermissions(next);
      // `auto` is answered by Latte as requests arrive, so it needs no restart.
      // The folder grant is a start-time flag of the runtime, so it does.
      if (next === 'auto' || previous === 'auto') { setNotice(next === 'auto' ? t('ui.auto.010') : t('ui.auto.011')); return; }
      const claudeChats = Object.values(chats).filter(c => c.workId === currentWork.id && c.provider === 'claude');
      const busyNames = claudeChats.filter(c => chatStore.get(c.id).status !== 'idle').map(c => c.roleName);
      const idle = claudeChats.filter(c => chatStore.get(c.id).status === 'idle');
      for (const chat of idle) {
        await api.pauseTeamMember(chat.id);
        chatStore.forget(chat.id);
        const reopened = await api.openTeamMember(chat.id);
        setChats(prev => ({ ...prev, [reopened.id]: reopened }));
        await chatStore.sync(reopened.id);
      }
      await loadTeam(currentWork.id);
      const applied = next ? 'Listo, escriben en esta carpeta sin preguntar.' : 'Vuelven a pedir permiso por cada archivo.';
      setNotice(busyNames.length > 0
        ? t('ui.auto.342', { p0: applied, p1: busyNames.join(' y ') })
        : applied);
    })().catch(e => setError(t('permission.error', { message: displayError(e) }))).finally(() => setPermissionBusy(false));
  };
  const dropChat = (memberId: string) => { setChats(prev => { const next = { ...prev }; delete next[memberId]; return next; }); chatStore.forget(memberId); };
  const pauseMember = (memberId: string) => run(async () => { await api.pauseTeamMember(memberId); dropChat(memberId); if (work) await loadTeam(work.id); });
  const finishMember = (memberId: string) => run(async () => { await api.finishTeamMember(memberId); dropChat(memberId); if (work) await loadTeam(work.id); setNotice('Miembro marcado como finalizado'); });
  /**
   * Acepta un handoff como TAREA de la coordinación cuando el Trabajo tiene un
   * run vivo: `acceptHandoffAsTask` estaba cableada de punta a punta (motor,
   * IPC, contrato, preload, browser-api, tests) y no tenía un solo llamador en
   * el renderer. Fuera de un run vivo devuelve `{bridged:false}` y cae al
   * camino de siempre, el borrador de chat.
   */
  const acceptHandoffAsTask = (handoff: HandoffRequest) => run(async () => {
    if (!work) return;
    const result = await api.acceptHandoffAsTask(work.id, handoff.fileName);
    if (!result.bridged) { await acceptHandoff(handoff); return; }
    setHandoffs(await api.listHandoffs(work.id).catch(() => []));
    // NO se abrio ninguna conversacion: se creo una `coordination_task` y
    // `startDispatch` ya la mando (gastando un despacho, con `hub.send`
    // incluido). Reusar la frase de la otra rama --"revisalo antes de
    // enviarlo"-- le pedia a la persona revisar algo que no existe DESPUES de
    // haber gastado. Clave semantica propia, en los dos idiomas.
    // R3: el puente ya no tira cuando el despacho se deniega, lo devuelve. Y
    // entonces la frase no puede ser la misma: la tarea existe pero nadie la
    // está haciendo, y decir "despachada" sería anunciar algo que no pasó.
    // Q1: y son TRES, no dos. Con la autoridad por defecto (`manual`, y también
    // `plan`, porque la tarea del puente nace fuera del plan) el motor devuelve
    // `pending_approval`: la tarea existe, nadie la está haciendo, y lo que
    // falta es un gesto de la persona en Decisiones. Decirle "despachada al
    // equipo" la dejaba esperando un resultado que nunca iba a llegar, sin
    // saber que la decisión era suya.
    if (result.outcome === 'not_dispatched') { setNotice(t('handoff.bridged.queued', { role: handoff.roleName, reason: result.reason ?? '' })); return; }
    if (result.outcome === 'pending_approval') { setNotice(t('handoff.bridged.pendingApproval', { role: handoff.roleName })); return; }
    setNotice(t('handoff.bridged.dispatched', { role: handoff.roleName }));
  });
  const acceptHandoff = (handoff: HandoffRequest) => run(async () => {
    if (!work || startingChat) return;
    const existing = team.find(m => m.roleId === handoff.roleId);
    const session = existing
      ? await openSession(() => api.openTeamMember(existing.id), work.id)
      : await openSession(() => api.addTeamMember(work.id, handoff.roleId), work.id);
    if (!session) return;
    // Loaded, never sent: the request is a draft you read before it costs anything.
    chatStore.setDraft(session.id, handoff.request);
    // Reveal the conversation without unmounting or saving the document editor.
    setLayout('conversation'); setView('brief');
    await api.dismissHandoff(work.id, handoff.fileName).catch(() => undefined);
    setHandoffs(await api.listHandoffs(work.id).catch(() => []));
    setNotice(t('ui.auto.343', { p0: handoff.roleName }));
  });
  /**
   * Continues a member's work with another agent or account. A NEW member is
   * created and the hand-over the human just reviewed is its first message:
   * they read and edited it in the dialog, so sending it is what they asked
   * for. The source is never paused, restarted or moved to another account.
   * Rejects when nothing was created, so the dialog keeps the edited text; if
   * only the send fails, the text waits in the new member's composer.
   */
  const continueMember = async (sourceId: string, roleId: string, options: TeamMemberOptions | null, text: string) => {
    if (!work || startingChat) return;
    const source = team.find(m => m.id === sourceId);
    const session = await openSession(() => api.addTeamMember(work.id, roleId, { ...(options ?? {}), continuedFrom: sourceId }), work.id);
    setLayout('conversation'); setView('brief');
    try {
      await api.sendChat(session.id, text);
      setNotice(t('continue.sent', { role: session.roleName, source: source?.roleName ?? '' }));
    } catch (e) {
      chatStore.setDraft(session.id, text);
      setError(t('continue.sendFailed', { role: session.roleName, message: displayError(e) }));
    }
  };
  const dismissHandoff = (handoff: HandoffRequest) => run(async () => {
    if (!work) return;
    await api.dismissHandoff(work.id, handoff.fileName);
    setHandoffs(await api.listHandoffs(work.id).catch(() => []));
  });
  const restartMember = (memberId: string) => run(async () => { await api.restartTeamMember(memberId); dropChat(memberId); if (work) await loadTeam(work.id); setNotice(t('ui.auto.012')); await openMember(memberId); });
  /**
   * Changing the model restarts the runtime and resumes the conversation. The
   * notice says which of the two happened: claiming a history that did not
   * come back would be a lie the old terminal never told.
   */
  const setMemberModel = (memberId: string, model: string | null) => run(async () => {
    const result = await api.setTeamMemberModel(memberId, model);
    if (work) await loadTeam(work.id);
    const name = model ?? 'el modelo por defecto del CLI';
    if (!result.session) { setNotice(t('ui.auto.344', { p0: name })); return; }
    chatStore.forget(memberId);
    // forget() clears the whole chat state, consumption included; the model
    // swap itself never changes what was already spent, so put it right back.
    chatStore.seedUsage(result.member.id, result.member.usage);
    setChats(prev => ({ ...prev, [result.session!.id]: result.session! }));
    if (result.resumed) await chatStore.sync(result.session.id);
    setNotice(result.resumed ? t('ui.auto.345', { p0: name }) : t('app.runtimeChanged', { name }));
  });
  /**
   * Changes how hard one conversation works per answer. Same mechanics as
   * setMemberModel: the runtime restarts underneath and the same conversation
   * is resumed when the runtime allows it.
   */
  const setMemberTier = (memberId: string, tier: EffortTier) => run(async () => {
    const result = await api.setTeamMemberTier(memberId, tier);
    if (work) await loadTeam(work.id);
    const label = t(`effort.tier.${tier}.label` as 'effort.tier.light.label');
    if (!result.session) { setNotice(t('effort.changedPaused', { p0: label })); return; }
    chatStore.forget(memberId);
    chatStore.seedUsage(result.member.id, result.member.usage);
    setChats(prev => ({ ...prev, [result.session!.id]: result.session! }));
    if (result.resumed) await chatStore.sync(result.session.id);
    setNotice(t(result.resumed ? 'effort.changedResumed' : 'effort.changedFresh', { p0: label }));
  });
  const removeMember = (memberId: string) => run(async () => { await api.removeTeamMember(memberId); dropChat(memberId); if (work) { setSelectedMembers(prev => { const next = { ...prev }; if (next[work.id] === memberId) delete next[work.id]; return next; }); await loadTeam(work.id); } });
  const liveChatIds = new Set(Object.keys(chats));
  const workHasLiveChat = (workId: string) => Object.values(chats).some(c => c.workId === workId);
  const sessionWork = works.find(w => w.id === session?.workId);
  const activeTerminals = Object.values(sessions).filter(s => !endedSessions.has(s.id)).length, activeChats = liveChatIds.size;
  // The update notice follows the user into Ajustes: it is about the app, not about the view.
  /**
   * The raw CLI, moved out of the work on purpose.
   *
   * A terminal inside the workspace competed with the conversation and
   * promised something Latte does not keep: nothing typed there becomes a
   * document, a version or a decision. It stays as the way out when a
   * conversation will not start, and it lives in Settings, where an escape
   * hatch belongs.
   */
  const terminalConsole = <section className="terminal-console">
    <h3>Terminal · avanzado</h3>
    <p className="settings-lead">{work ? <>{t('ui.auto.013')} <strong>{work.title}</strong>{t('ui.auto.014')}</> : t('ui.auto.015')}</p>
    {work && <><p className="agent-explanation">{t('ui.auto.016')}</p><label className="field-label" htmlFor="provider">RUNTIME</label><select id="provider" value={provider} disabled={Boolean(session) || starting} onChange={e => setProvider(e.target.value as Provider)}>{(['opencode', 'claude', 'codex'] as Provider[]).map(p => <option key={p} value={p}>{p === 'opencode' ? 'OpenCode' : p === 'claude' ? 'Claude Code' : 'Codex'}{runtimes.find(r => r.provider === p)?.available ? t('ui.auto.346') : ''}</option>)}</select><p className="runtime-detail">{runtimes.find(r => r.provider === provider)?.detail ?? 'Comprobando disponibilidad…'}</p>
        <div className="terminal-stack">{Object.values(sessions).map(s => <div key={s.id} style={{ display: s.id === session?.id ? 'block' : 'none' }}><TerminalPane sessionId={s.id} onError={setError} /></div>)}</div>
        {session ? <><div className="session-heading"><span><i className={sessionEnded ? 'ended-dot' : 'live-dot'} />{session.provider} · {sessionWork?.title ?? t('ui.auto.017')}</span><button aria-label={t('ui.auto.018')} title={t('ui.auto.018')} onClick={() => run(async () => { await api.stopAgent(session.id); setSession(null); })}><Square size={13} /></button></div><form className="prompt-form" onSubmit={e => { e.preventDefault(); if (!prompt.trim() || sessionEnded) return; void run(async () => { await api.writeAgent(session.id, prompt + '\r'); setPrompt(''); }); }}><textarea aria-label={t('ui.auto.019')} placeholder={t('ui.auto.020')} value={prompt} onChange={e => setPrompt(e.target.value)} /><div><small>{sessionEnded ? t('ui.auto.021') : t('ui.auto.022')}</small><button className="primary icon-button" disabled={!prompt.trim() || busy || sessionEnded} aria-label={t('ui.auto.023')}><ArrowUpRight size={18} /></button></div></form></> : <div className="agent-idle"><div className="agent-symbol"><TerminalSquare size={27} /></div><h3>{t('ui.auto.024')}<br />{t('ui.auto.025')}</h3><p>{t('ui.auto.026')}</p><button className="primary" disabled={!work || starting || !runtimes.find(r => r.provider === provider)?.available} onClick={start}>{starting ? <Loading size={16} /> : <Plus size={15} />}{starting ? t('ui.auto.347') : t('ui.auto.027')}</button>{!isDesktop && <small className="preview-note">{t('ui.auto.028')}</small>}</div>}</>}
  </section>;

  if (settings) return <><SettingsScreen workId={work?.id ?? null} terminal={terminalConsole} onProfileDirtyChange={setProfileDirty} controls={isDesktop ? <WindowControls /> : null} section={settings} onSection={setSettings} onClose={() => { setSettings(null); setError(''); setNotice(''); }} onChanged={() => { void refreshChatStatus(); void api.listRoles().then(setRoles).catch(e=>setError(displayError(e))); }} onNotice={setNotice} onError={setError} notice={notice} error={error} onDismiss={() => { setError(''); setNotice(''); }} onReopenOnboarding={reopenOnboarding} mode={mode} onModeChange={setMode} /><UpdateBanner /></>;
  // Order matters: settings first, so the gate's "Configuración avanzada" wins
  // and closing Settings returns to the walk with its draft re-hydrated.
  if (onboarding === 'incomplete') return <><OnboardingGate controls={isDesktop ? <WindowControls /> : null} onComplete={finishOnboarding} onSkip={skipOnboarding} initialDraft={onboardingDraft} onAdvanced={() => setSettings('agents')} /><UpdateBanner /></>;
  return <div className={'app-shell' + (railed ? ' railed' : '') + (focusChat ? ' conversation-focus' : '') + (dragging ? ' dragging' : '')} style={{ ['--agent-width' as string]: `${agentWidth}px` }}>
    <aside className="sidebar">
      <div className="wordmark"><span className="logo-mark" aria-hidden="true" />Latte<button className="rail-toggle" aria-expanded={!railed} aria-label={railed ? t('ui.auto.029') : t('ui.auto.030')} title={railed ? t('ui.auto.029') : t('ui.auto.030')} onClick={() => setRailed(v => !v)}>{railed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
      <div className="brand-picker"><select aria-label={t('ui.auto.031')} value={brand?.id ?? ''} onChange={e => { const b = brands.find(b => b.id === e.target.value); if (b) selectBrand(b); }}>{!brands.length && <option value="">{t('ui.auto.032')}</option>}{brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select><ChevronDown size={15} /></div>
      <ActiveTeamsStrip runs={coordination.activeRuns} onOpen={openActiveRun} />
      <button className="subtle sidebar-add" disabled={transitioning} onClick={() => { setName(''); setModal('brand'); }}><Plus size={14} />  {t('ui.auto.033')}</button>
      <button type="button" className="subtle sidebar-add" onClick={() => setShowArchived(v => !v)} aria-expanded={showArchived}>{t('brand.archivedToggle')}{archivedBrands.length ? ` (${archivedBrands.length})` : ''}</button>
      {showArchived && <div className="archived-brands">{archivedBrands.length === 0 ? <p className="sidebar-hint">{t('brand.noneArchived')}</p> : archivedBrands.map(b => <div key={b.id} className="archived-brand-row"><span title={b.name}>{b.name}</span><button type="button" className="subtle" disabled={busy} onClick={() => run(() => restoreArchivedBrand(b.id))}>{t('brand.restore')}</button></div>)}</div>}
      <nav><button type="button" title={t('home.nav')} className={view === 'home' ? 'nav-active' : ''} onClick={() => setView('home')}><Home size={18} />{t('home.nav')}</button></nav>
      <div className="nav-label">{t('ui.auto.034')}</div>
      <nav><button disabled={!brand} title={brand && !brand.context.trim() ? t('context.badge') : t('ui.auto.035')} className={view === 'context' ? 'nav-active' : ''} onClick={() => setView('context')}><FileText size={18} />{t('ui.auto.035')}{brand && !brand.context.trim() && <i className="nav-badge" aria-hidden="true" />}</button><button disabled={!brand} title={t('ui.auto.036')} className={view === 'memory' ? 'nav-active' : ''} onClick={openMemory}><Bookmark size={18} />{t('ui.auto.036')}</button></nav>
      <div className="sidebar-rule" /><div className="nav-label">TRABAJOS <span>{works.length.toString().padStart(2, '0')}</span></div>
      <nav className="work-nav">{works.map(w => <button key={w.id} title={w.title} className={work?.id === w.id && (view === 'brief' || view === 'funnel' || view === 'decisions' || view === 'resumen' || view === 'trabajo' || view === 'evidencia' || view === 'resultados') ? 'work-active' : ''} onClick={() => selectWork(w)}><Folder size={17} /><span>{w.title}</span>{(workHasLiveChat(w.id) || sessions[w.id]) && <i className={sessions[w.id] && endedSessions.has(sessions[w.id].id) && !workHasLiveChat(w.id) ? 'ended-dot' : 'live-dot'} />}</button>)}{!works.length && <p className="sidebar-hint">{t('ui.auto.037')}</p>}</nav>
      <div className="sidebar-bottom"><button disabled={!brand || transitioning} title={t('ui.auto.038')} onClick={() => { setName(''); setModal('work'); }}><Plus size={20} />{t('ui.auto.038')}</button><div className="sidebar-rule" /><nav><button onClick={() => setSettings('agents')} title={t('ui.auto.348')}><Settings2 size={17} />{t('ui.auto.348')}</button></nav><div className="profile"><span className="avatar">G</span><div>Tu estudio<small>{t('ui.auto.039')}</small></div></div></div>
    </aside>
    <header className="topbar"><div className="breadcrumb">{brand?.name ?? 'Bienvenido a Latte'}<span>/</span><strong>{work?.title ?? 'Tu espacio de marketing'}</strong></div>{work && view !== 'home' && <div className="workspace-modes" role="group" aria-label={t('ui.auto.040')}><button aria-pressed={focusChat} onClick={() => { setLayout('conversation'); setView('brief'); }}><MessageSquare size={15} />{t('ui.auto.349')}</button><button aria-pressed={!focusChat} onClick={() => { setLayout('review'); setView('brief'); }}><FileText size={15} />{t('ui.auto.041')}</button></div>}{isDesktop && <WindowControls />}</header>
    <main className="workspace" aria-hidden={focusChat} inert={focusChat}>
      <MemoryNotice support={coordination.support} dismissed={Boolean(brand && memoryNoticeDismissed.has(brand.id))} onDismiss={() => { if (brand) setMemoryNoticeDismissed(prev => new Set(prev).add(brand.id)); }} />
      {view === 'home' && <HomeView brand={brand} works={works} documents={documents} decisions={decisions} states={homeStates} checking={homeChecking} liveWorkIds={liveWorkIds} pendingContextProposals={pendingContextProposals} coordinationSinceLastVisit={brand ? sinceLastVisitFromActiveRuns(coordination.activeRuns, brand.id) : []} formatDate={date} onOpenWork={openWork} onOpenDecisions={openWorkDecisions} onOpenDocument={openDocument} onOpenContext={() => setView('context')} onNewWork={openNewWork} onAddBrand={openAddBrand} />}
      {/* The tabs and the knowledge-scope filter are in-work chrome: on Inicio
          they would read as "a work with no tab selected". */}
      {view !== 'home' && <><div className="tabs"><button className={view === 'resumen' ? 'selected' : ''} onClick={() => setView('resumen')}>{t('resumen.tab')}</button><button className={view === 'trabajo' ? 'selected' : ''} onClick={() => setView('trabajo')}>{t('trabajo.tab')}</button><button className={view === 'evidencia' ? 'selected' : ''} onClick={() => setView('evidencia')}>{t('evidencia.tab')}</button><button className={view === 'brief' ? 'selected' : ''} onClick={() => setView('brief')}>{t('ui.auto.350')} <span>{visibleDocuments.length}</span></button><button className={view === 'funnel' ? 'selected' : ''} onClick={() => setView('funnel')}>{t('ui.auto.043')}</button><button className={view === 'decisions' ? 'selected' : ''} onClick={() => setView('decisions')}>{t('ui.auto.351')} <span>{visibleDecisions.filter(d => d.status === 'approved' || d.status === 'pending').length}</span></button><button className={view === 'resultados' ? 'selected' : ''} onClick={() => setView('resultados')}>{t('resultados.tab')}</button><div className="tab-spacer" /></div>
      {(view === 'brief' || view === 'funnel' || view === 'decisions') && brand && <KnowledgeScopeFilter works={works} currentWorkId={work?.id ?? null} value={knowledgeScope} onChange={setKnowledgeScope} />}</>}
      {(error || notice) && <div role={error ? 'alert' : 'status'} className={'message ' + (error ? 'error' : '')}><span>{error || notice}</span><button aria-label={t('ui.auto.044')} onClick={() => { setError(''); setNotice(''); }}><X size={16} /></button></div>}
      {view === 'resumen' && <ResumenView brand={brand} work={work} documents={documents} decisions={decisions} states={homeStates} checking={homeChecking} team={team} permissions={permissions} live={work ? liveWorkIds.includes(work.id) : false} brandContextDefined={Boolean(brand?.context.trim())} coordinationLog={work ? coordination.log : undefined} coordinationHires={work ? coordination.hires : undefined} onSettleDispatch={coordination.settleDispatch} formatDate={date} onOpenBrief={() => { setLayout('review'); setView('brief'); }} />}
      {view === 'trabajo' && <TrabajoView brand={brand} work={work} documents={documents} decisions={decisions} states={homeStates} checking={homeChecking} team={team} permissions={permissions} handoffs={handoffs} live={work ? liveWorkIds.includes(work.id) : false} brandContextDefined={Boolean(brand?.context.trim())} mode={mode} formatDate={date} onOpenChat={() => { setLayout('conversation'); setView('brief'); }} />}
      {view === 'evidencia' && <EvidenciaView work={work} workId={work?.id ?? ''} documents={documents} decisions={decisions} untracked={untracked} states={homeStates} checking={homeChecking} formatDate={date} onTrack={trackFile} onImported={() => loadKnowledge(work?.brandId ?? '', work?.id)} busy={busy} />}
      {view === 'resultados' && <ResultadosView work={work} decisions={decisions} formatDate={date} />}
      {(view === 'brief' || view === 'funnel') && <DocumentsView funnel={view === 'funnel'} onView={(next) => { if (next === 'brief') setLayout('review'); setView(next); }} work={work} brandName={brand?.name ?? ''} documents={visibleDocuments} selectedId={selectedDocId} onSelect={id => brand && setSelectedDoc(prev => ({ ...prev, [brand.id]: id }))} onDocumentsChanged={async () => { if (brand) await loadKnowledge(brand.id, work?.id); }} onWorkUpdated={onWorkUpdated} onDirtyChange={setDocumentDirty} onNotice={setNotice} onError={setError} onCreate={() => setModal('document')} onUseFolder={useFolder} hasBrand={Boolean(brand)} onStart={() => { setName(''); setModal(brand ? 'work' : 'brand'); }} untracked={untracked} onTrack={trackFile} editors={editors} busy={busy} currentWorkId={work?.id ?? null} workTitles={titlesByWork} showWorkDelta={showWorkDelta} />}
      {view === 'context' && brand && <ContextView
        brand={brand}
        proposals={contextProposals}
        status={contextStatus ? {
          liveCount: contextStatus.works.filter(w => w.live).length,
          worksCount: contextStatus.works.length,
          fingerprint: contextStatus.fingerprint,
          revisions: contextStatus.revisions,
        } : null}
        work={work}
        draft={context}
        busy={busy}
        desktop={isDesktop}
        onDraft={setContext}
        onSave={() => void run(saveContext)}
        onClear={() => void run(clearContext)}
        onRestore={(revisionId) => void run(() => restoreContext(revisionId))}
        onDecide={(id, action, acceptStale) => void run(() => decideContextProposal(id, action, acceptStale))}
        onAsk={() => void askStrategist()}
        conflict={contextConflict}
        onReload={() => void reloadContext()}
        onOverride={() => void overrideContext()}
      />}
      {view === 'decisions' && <DecisionsView work={work} decisions={visibleDecisions} team={team} roles={roles} permissions={permissions} handoffs={handoffs} decisionAuthority={decisionAuthority} draft={decision} busy={busy} formatDate={date} titlesByWork={titlesByWork} onDraftChange={setDecision} onAdd={addDecision} onApprove={approveDecision} onEditApprove={editApproveDecision} onReject={rejectDecision} onArchive={archiveDecision} onAuthorityChange={changeDecisionAuthority} coordinationAuthority={work ? coordination.authority : undefined} coordinationBudget={work ? coordination.budget : undefined} onSetCoordinationBudget={coordination.setBudget} coordinatorGrant={work ? coordination.coordinatorGrant : undefined} coordinationRun={work ? coordination.run : undefined} gates={work ? coordination.gates : undefined} onResolveGate={coordination.resolveGate} openAsks={work ? coordination.openAsks : undefined} onAnswerAsk={coordination.answerAsk} onAcceptHandoff={acceptHandoffAsTask} coordinationSupport={work ? coordination.support : undefined} pending={coordination.pending} />}
      {view === 'memory' && <div className="document-scroll"><div className="document-kicker">{t('ui.auto.057')}</div><h1>{t('ui.auto.058')}<br />{t('ui.auto.059')}</h1><p className="intro">{t('ui.auto.060')}</p><div className="memory-result"><ReactMarkdown remarkPlugins={[remarkGfm]}>{memory || t('ui.auto.061')}</ReactMarkdown></div><label className="field-label" htmlFor="memory-note">{t('ui.auto.062')}</label><textarea id="memory-note" className="context-editor short" value={memoryNote} onChange={e => setMemoryNote(e.target.value)} placeholder={t('ui.auto.063')} /><button className="primary" disabled={!memoryAvailable || !memoryNote.trim() || busy} onClick={() => run(async () => { const r = await api.saveMemory(brand!.id, memoryNote); if (!r.available) throw new Error(r.text); setMemoryNote(''); setNotice('Aprendizaje guardado en Engram'); openMemory(); })}><Bookmark size={15} />{t('ui.auto.064')}</button></div>}
      <div className="document-footer"><span><FileText size={13} />{work ? (knowledgeScope === ALL_BRAND_SCOPE ? t('knowledge.docsBrand', { p0: visibleDocuments.length, p1: visibleDocuments.length === 1 ? '' : 's' }) : t('knowledge.docsWork', { p0: visibleDocuments.length, p1: visibleDocuments.length === 1 ? '' : 's', title: titlesByWork[knowledgeScope] ?? work.title })) : t('ui.auto.065')}</span><span>{work ? date(work.updatedAt) : 'An Agent Marketing Platform'}</span></div>
    </main>
    <aside className="agent-panel">{focusChat && (error || notice) && <div role={error ? 'alert' : 'status'} className={'message ' + (error ? 'error' : '')}><span>{error || notice}</span><button aria-label={t('ui.auto.044')} onClick={() => { setError(''); setNotice(''); }}><X size={16} /></button></div>}<button type="button" className={'panel-resizer' + (dragging ? ' dragging' : '')} aria-label={t('ui.auto.066')} title={t('ui.auto.067')} onPointerDown={startResize} />
      <TeamPanel work={work} team={team} chats={chats} selectedId={selectedMemberId} roles={roles} primaryLabel={primaryLabel} primaryDetail={primaryDetail} primaryReady={primaryReady} checking={checkingAgents} choices={runtimeChoices} busy={busy || startingChat} isDesktop={isDesktop} mode={mode} onSelect={selectMember} onAdd={addMember} onOpen={openMember} onPause={pauseMember} onFinish={finishMember} onRestart={restartMember} onContinue={continueMember} onRemove={removeMember} onModel={setMemberModel} onTier={setMemberTier} handoffs={handoffs} onAcceptHandoff={acceptHandoff} onDismissHandoff={dismissHandoff} onSaveAsDocument={saveAnswerAsDocument} onAttachFiles={() => work ? api.importFiles(work.id) : Promise.resolve([])} untracked={untracked.map(f => f.fileName)} onAdoptFile={fileName => void trackFile(fileName)} primaryRuntime={primaryRuntime} primaryAccountId={primary?.accountId ?? null} primaryModel={primary?.model ?? null} permissions={permissions} permissionBusy={permissionBusy} onPermissions={changePermissions} onProviders={() => setSettings('agents')} onRecheck={() => void refreshChatStatus()} onError={setError} coordinationRun={work ? coordination.run : undefined} onPauseCoordination={coordination.pauseRun} onResumeCoordination={coordination.resumeRun} onCancelCoordination={coordination.cancelRun} pending={coordination.pending} />
      <details className="active-context">
        <summary><Bookmark size={12} />{t('ui.auto.035')}<span>{[brand?.context ? 'marca' : null, work ? 'trabajo' : null, decisions.length ? `${decisions.length} decisiones` : null].filter(Boolean).join(' · ') || t('ui.auto.068')}</span></summary>
        <div className="active-context-body">
          <span><FileText size={13} />{brand?.context ? t('ui.auto.069') : t('ui.auto.070')}</span>
          <span><Folder size={13} />{work?.title ?? t('ui.auto.071')}</span>
          <span><Bookmark size={13} />{decisions.length}  {t('ui.auto.353')}</span>
          {mode === 'advanced' && <p className="agent-footnote" title={runtimeName}>{t('ui.auto.072')} {t('ui.auto.073')}</p>}
        </div>
      </details>
    </aside>
    <footer className="statusbar"><span><Circle size={11} />{isDesktop ? t('ui.auto.354', { p0: activeChats, p1: activeTerminals }) : t('ui.auto.074')}</span><span>{busy ? t('ui.auto.355') : dirty || contextDirty ? t('ui.auto.075') : 'Todo guardado'}<Check size={13} /></span>{appInfo && <span>Latte <span className="status-version">{appInfo.version}</span></span>}</footer>
    {(modal === 'brand' || modal === 'work') && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) setModal(null); }}><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="modal"><div className="modal-head"><div><div className="document-kicker">{t('ui.auto.076')}</div><h2 id="dialog-title">{modal === 'brand' ? t('ui.auto.077') : t('ui.auto.078')}</h2></div><button className="modal-close" aria-label={t('ui.auto.001')} onClick={() => setModal(null)}><X size={20} /></button></div><div className="modal-body"><form onSubmit={e => { e.preventDefault(); void create(); }}><label className="field-label" htmlFor="new-name">{modal === 'brand' ? t('ui.auto.079') : t('ui.auto.080')}</label><input autoFocus id="new-name" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder={modal === 'brand' ? 'Ej. Casa Oliva' : t('ui.auto.081')} /><p className="footnote">{t('ui.auto.082')}</p><button className="primary" disabled={!name.trim() || busy}>{modal === 'brand' ? <>{t('ui.auto.083')} {t('ui.auto.084')}</> : t('ui.auto.038')}<ArrowUpRight size={16} /></button></form></div></section></div>}
    {modal === 'document' && <NewDocumentDialog documents={documents.filter(d => d.workId === work?.id)} busy={busy} onCancel={() => setModal(null)} onCreate={createDocument} />}
    <UpdateBanner />
  </div>;
}
