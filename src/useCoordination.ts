import { useEffect, useRef, useState } from 'react';
import { api } from './browser-api';
import { shouldRefreshWork } from './coordination-event-routing';
import type {
  CoordinationActiveRunSummary, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudgetView,
  CoordinationGateView, CoordinationHireView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationMessageView, CoordinationRunTaskView, CoordinationRunView, CoordinatorGrant,
} from '../shared/contracts';

export { shouldRefreshWork } from './coordination-event-routing';

export interface CoordinationState {
  authority: CoordinationAuthorityMode;
  /** E2: "revisión antes de publicar" del Trabajo abierto. Prendida por defecto. */
  review: boolean;
  budget: CoordinationBudgetView;
  coordinatorGrant: CoordinatorGrant;
  run: CoordinationRunView | null;
  gates: CoordinationGateView[];
  log: CoordinationLogEntryView[];
  /**
   * El buzon del run: los `latte_message` entre miembros, con los dos extremos
   * ya resueltos a `memberId` + `roleId`. Se refresca con el MISMO ritmo que
   * la bitacora --el panel de equipo dibuja las dos cosas en una sola linea
   * por miembro, y dos ritmos distintos harian que esa linea se contradijera
   * consigo misma entre un refresco y el siguiente.
   *
   * Se pide por `workId`, no por `runId`: `listCoordinationMessages` resuelve
   * el run del Trabajo por su cuenta y contesta `[]` cuando no hay ninguno.
   */
  messages: CoordinationMessageView[];
  /** Las contrataciones del run, para la bitacora. Antes esa prop no la llenaba nadie. */
  hires: CoordinationHireView[];
  /**
   * C1: las tareas del run, para la tira del encabezado. Se refresca con el
   * MISMO ritmo que la bitacora: el encabezado y la lista de miembros cuentan
   * el mismo pedido, y dos ritmos distintos harian que se contradijeran entre
   * un refresco y el siguiente.
   */
  tasks: CoordinationRunTaskView[];
  support: CoordinationMemberSupport[];
  /** Las `latte_ask` abiertas del run: una superficie propia, nunca un gate de aprobar/rechazar. */
  openAsks: CoordinationAskView[];
  /** The global "Equipos activos" strip (task 6.34): every Brand, not scoped to `workId`. */
  activeRuns: CoordinationActiveRunSummary[];
  /**
   * Per-action in-flight flags, keyed `gate:<gateId>` / `ask:<askId>` /
   * `task:<taskId>` / `run:<runId>` (juicio ronda 4, ítem 14). `true` desde
   * que se emite la mutación hasta que su `.finally` corre — ningún gate/ask/
   * control de run exponía esto, así que un doble click en un gate de
   * PROPUESTA corría `hub.addMember` dos veces antes de que la transacción
   * del perdedor tirara, dejando un proceso de agente huérfano spawneado.
   * Una clave ausente (o en `false`) significa "nada en vuelo para esa
   * acción" — el mismo default seguro que el resto de este hook.
   */
  pending: Record<string, boolean>;
  /**
   * El recorte por-Trabajo del Trabajo ABIERTO ya terminó de cargar: el run,
   * sus gates, su bitácora, sus altas y sus preguntas resolvieron (o no hay
   * run, que es una respuesta completa igual). `false` sin Trabajo abierto.
   *
   * Existe por una sola razón: `markSeen`. Marcar visto en el mismo tick en
   * que la persona toca la pestaña registraba la visita sobre una pantalla
   * todavía vacía, y todo lo que llegaba después —justo lo que tenía que ver—
   * nacía ya "visto". Una visita que se anota antes de que haya algo que
   * mirar no es una visita.
   */
  workLoaded: boolean;
  /**
   * O1: DEVUELVE SI EL MOTOR ACEPTÓ.
   *
   * Esto devolvía `void`, así que la tarjeta de la propuesta cerraba su editor
   * en el mismo tick en que emitía la mutación — antes de que el backend
   * contestara. Cuando contestaba que NO (`DEPTH_CAP`, `PROPOSAL_STALE`,
   * `COORDINATION_BUDGET_INVALID`, un `addMember` caído), el gate seguía en
   * pantalla con el editor CERRADO y el formulario a medio editar perdido, y
   * el "Aprobar" simple volvía a aparecer: un clic más mandaba la propuesta
   * GUARDADA, con todas las altas que la persona acababa de destildar.
   *
   * La promesa resuelve `true` si la mutación resolvió bien y `false` si falló
   * — nunca rechaza. Rechazar obligaría a cada botón de esta app a encadenar
   * un `.catch`, y el que se olvidara dejaría una promesa sin manejar; el
   * error ya se reporta por el canal de error de la app, acá adentro, una sola
   * vez.
   */
  resolveGate: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => Promise<boolean>;
  answerAsk: (askId: string, answer: string) => void;
  /** Surfaces task 3.19's `settleCoordinationDispatch` — never reinvented. */
  settleDispatch: (taskId: string, outcome: 'succeeded' | 'failed', summary: string) => void;
  pauseRun: (runId: string) => void;
  /** La vuelta de la pausa: sin esto, "Pausar equipo" era una trampa de ida. */
  resumeRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
  /**
   * Escribe el tope de despachos del Trabajo abierto. Pasa por `mutate` como
   * cualquier otra mutación: refresca, reporta su error y marca su propio
   * `pending`. Sin Trabajo abierto no hace nada — no hay presupuesto de nadie
   * que escribir.
   */
  setBudget: (maxDispatches: number) => void;
  /** E2: prende o apaga la revisión antes de publicar del Trabajo abierto. */
  setReview: (on: boolean) => void;
  /**
   * Elegir quién coordina el Trabajo abierto (el permiso del trabajo). Pasa por
   * `mutate`: refresca, reporta el error por el canal de la app y nunca
   * rechaza. `false` sin Trabajo abierto.
   */
  setCoordinator: (memberId: string | null) => Promise<boolean>;
  /**
   * Deja constancia de que la persona está mirando la coordinación de ESTE
   * Trabajo ahora. Es lo que "Desde tu última visita" mide: antes no había
   * ninguna visita registrada en ningún lado, y la tarjeta mostraba el estado
   * actual bajo un título que habla del pasado.
   */
  markSeen: () => void;
}

/**
 * `useCoordination(workId, onError?)` (autonomous-coordination Phase 7 task
 * 7.11): the one hook `src/App.tsx` calls to wire real coordination data into
 * the four additive-prop views (`HomeView`, `ResumenView`, `DecisionsView`,
 * `TeamPanel`), the active-teams strip and the memory notice.
 *
 * Two independent halves, on purpose (mirrors the injection policies'
 * design): `activeRuns` is GLOBAL — fetched and refreshed regardless of
 * `workId`, because the strip must show a run in a Brand the person is not
 * currently viewing. Everything else is scoped to `workId` and resets to a
 * safe, honest default the moment it is `null` (no Work open).
 *
 * TODO ninguno pendiente sobre las asks: `listOpenCoordinationAsks` existe y
 * este hook la consume — antes la brecha estaba "declarada" en un comentario,
 * que es exactamente la clase de capacidad-que-no-funciona que AGENTS.md
 * prohíbe.
 *
 * GUARD DE GENERACIÓN (obligatorio, el mismo precedente que `generation.current`
 * en `App.tsx`): `refreshWork` dispara cinco promesas IPC que nadie puede
 * cancelar. Navegando de un Trabajo de la Marca A a uno de la Marca B, la
 * respuesta lenta de A llegaba DESPUÉS de la de B y pintaba los gates de A
 * bajo el Trabajo de B — y tocar "Aprobar" ahí resolvía un gate de la plata y
 * el equipo de otra Marca. Cada `setState` pasa por el contador.
 */
export function useCoordination(
  workId: string | null,
  onError?: (error: unknown) => void,
  /**
   * B5.2: "pasó algo de coordinación EN EL TRABAJO ABIERTO", para lo que este
   * hook no tiene y no debe tener: el equipo.
   *
   * El motor contrata solo. En la prueba real contrató a paid-media, lo
   * spawneó y le mandó la tarea, y la pestaña de ese miembro NO apareció
   * nunca: `loadTeam` sólo corre al cambiar de Trabajo y después de una acción
   * de la PERSONA, y las cinco lecturas de `refreshWork` no incluyen
   * `listTeam`. La persona se quedó con un miembro trabajando al que no tenía
   * forma de abrir.
   *
   * Va como callback de la suscripción que YA existe, no como una segunda
   * suscripción a `onCoordinationEvent`: dos suscripciones sobre el mismo
   * canal son dos ruteos que pueden desincronizarse, y el criterio de
   * "¿es de este Trabajo?" (`shouldRefreshWork`) vive acá adentro, testeado,
   * una sola vez. El contenedor pone el efecto (recargar el equipo), el hook
   * pone el momento.
   */
  onWorkTouched?: (workId: string) => void,
): CoordinationState {
  const [authority, setAuthority] = useState<CoordinationAuthorityMode>('manual');
  const [review, setReviewState] = useState(true);
  const [budget, setBudget] = useState<CoordinationBudgetView>({ state: 'unset' });
  const [coordinatorGrant, setCoordinatorGrant] = useState<CoordinatorGrant>(null);
  const [run, setRun] = useState<CoordinationRunView | null>(null);
  const [gates, setGates] = useState<CoordinationGateView[]>([]);
  const [log, setLog] = useState<CoordinationLogEntryView[]>([]);
  const [messages, setMessages] = useState<CoordinationMessageView[]>([]);
  const [hires, setHires] = useState<CoordinationHireView[]>([]);
  const [tasks, setTasks] = useState<CoordinationRunTaskView[]>([]);
  const [support, setSupport] = useState<CoordinationMemberSupport[]>([]);
  const [openAsks, setOpenAsks] = useState<CoordinationAskView[]>([]);
  const [activeRuns, setActiveRuns] = useState<CoordinationActiveRunSummary[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // El Trabajo cuyo recorte YA terminó de cargar, no un booleano: con un
  // booleano, navegar de un Trabajo a otro dejaba el `true` del anterior
  // prendido durante el render en el que el nuevo todavía no pidió nada — y
  // ahí `markSeen` marcaba visto el Trabajo NUEVO por la carga del VIEJO.
  const [loadedWorkId, setLoadedWorkId] = useState<string | null>(null);
  const generation = useRef(0);
  // Contador INDEPENDIENTE del de arriba (ronda 4, ítem 13e-a): `generation`
  // es del recorte por-Trabajo; `activeRuns` es global y se refresca en el
  // mount, en CADA evento de coordinación y en el `.finally` de cada
  // mutación. Sin su propio guard, una `listActiveCoordinationRuns` lenta de
  // un refresh anterior podía llegar DESPUÉS de una más nueva y pisarla con
  // filas viejas.
  const activeRunsGeneration = useRef(0);
  // El workId "vivo", el mismo patrón `.current = valor` que `errorSink` de
  // abajo: `mutate` (ronda 4, ítem 13e-b) captura el workId con el que fue
  // EMITIDA la mutación, y en su `.finally` compara contra ESTE ref, no
  // contra el `workId` cerrado en su propio closure, para saber si la Marca
  // que la emitió sigue siendo la que está abierta.
  const liveWorkId = useRef(workId);
  liveWorkId.current = workId;
  // La última función de error, sin re-suscribir nada: el hook no re-corre por
  // que el contenedor recree su callback.
  const errorSink = useRef(onError);
  errorSink.current = onError;
  // El mismo patrón que `errorSink`: el contenedor recrea su callback en cada
  // render y eso no puede re-suscribir el canal.
  const touchedSink = useRef(onWorkTouched);
  touchedSink.current = onWorkTouched;
  const report = (error: unknown) => { errorSink.current?.(error); };

  const refreshActiveRuns = () => {
    const n = ++activeRunsGeneration.current;
    const fresh = () => n === activeRunsGeneration.current;
    void api.listActiveCoordinationRuns().then((v) => { if (fresh()) setActiveRuns(v); }).catch((e) => { report(e); if (fresh()) setActiveRuns([]); });
  };

  const refreshWork = (id: string) => {
    const n = ++generation.current;
    const fresh = () => n === generation.current;
    void api.getCoordinationAuthority(id).then((v) => { if (fresh()) setAuthority(v); }).catch((e) => { report(e); if (fresh()) setAuthority('manual'); });
    void api.getCoordinationReview(id).then((v) => { if (fresh()) setReviewState(v); }).catch((e) => { report(e); if (fresh()) setReviewState(true); });
    void api.getCoordinationBudget(id).then((v) => { if (fresh()) setBudget(v); }).catch((e) => { report(e); if (fresh()) setBudget({ state: 'unset' }); });
    void api.getCoordinatorGrant(id).then((v) => { if (fresh()) setCoordinatorGrant(v); }).catch((e) => { report(e); if (fresh()) setCoordinatorGrant(null); });
    void api.coordinationRuntimeSupport(id).then((v) => { if (fresh()) setSupport(v); }).catch((e) => { report(e); if (fresh()) setSupport([]); });
    void api.listCoordinationMessages(id).then((v) => { if (fresh()) setMessages(v); }).catch((e) => { report(e); if (fresh()) setMessages([]); });
    // `loaded()` marca el recorte de ESTE `id` como cargado, y sólo si sigue
    // siendo el vigente. Es lo que `markSeen` espera: hasta acá la pantalla
    // de Decisiones no tiene un solo gate dibujado.
    const loaded = () => { if (fresh()) setLoadedWorkId(id); };
    void api.getCoordinationRun(id).then((current) => {
      if (!fresh()) return;
      setRun(current);
      // Sin run no hay nada más que esperar: eso ya es una respuesta completa.
      if (!current) { setGates([]); setLog([]); setHires([]); setTasks([]); setOpenAsks([]); loaded(); return; }
      // `allSettled`: un error de una de las cuatro no puede dejar la visita
      // colgada para siempre — cada `.catch` de abajo ya degrada a su default
      // seguro, y la pantalla igual terminó de cargar.
      void Promise.allSettled([
        api.listCoordinationGates(current.id).then((v) => { if (fresh()) setGates(v); }).catch((e) => { report(e); if (fresh()) setGates([]); }),
        api.listCoordinationLog(current.id).then((v) => { if (fresh()) setLog(v); }).catch((e) => { report(e); if (fresh()) setLog([]); }),
        api.listCoordinationHires(current.id).then((v) => { if (fresh()) setHires(v); }).catch((e) => { report(e); if (fresh()) setHires([]); }),
        api.listCoordinationTasks(current.id).then((v) => { if (fresh()) setTasks(v); }).catch((e) => { report(e); if (fresh()) setTasks([]); }),
        api.listOpenCoordinationAsks(current.id).then((v) => { if (fresh()) setOpenAsks(v); }).catch((e) => { report(e); if (fresh()) setOpenAsks([]); }),
      ]).then(loaded);
    }).catch((e) => { report(e); if (fresh()) { setRun(null); setGates([]); setLog([]); setHires([]); setTasks([]); setOpenAsks([]); loaded(); } });
  };

  // The global strip: fetched once, regardless of whether a Work is open.
  useEffect(() => { refreshActiveRuns(); }, []);

  // Per-work state: reset to the safe default the moment no Work is open,
  // exactly what an unwired caller of the four views already sees.
  useEffect(() => {
    if (!workId) {
      generation.current += 1; // toda respuesta en vuelo queda huérfana
      setAuthority('manual'); setReviewState(true); setBudget({ state: 'unset' }); setCoordinatorGrant(null);
      setRun(null); setGates([]); setLog([]); setHires([]); setTasks([]); setSupport([]); setOpenAsks([]); setMessages([]);
      return;
    }
    refreshWork(workId);
  }, [workId]);

  // `latte:coordination-event` (task 6.37): the global strip refreshes for
  // EVERY event, even one for a Brand the person is not viewing. The
  // per-work slice only refreshes when the event names the OPEN Work.
  useEffect(() => api.onCoordinationEvent((event) => {
    refreshActiveRuns();
    if (!shouldRefreshWork(event, workId)) return;
    refreshWork(workId!);
    // B5.2: y lo que NO vive en este hook también se entera. Un alta hecha por
    // el motor no dispara ninguna acción de la persona, así que sin esto la
    // lista de miembros del contenedor se queda con la foto de antes.
    try { touchedSink.current?.(workId!); } catch { /* el efecto del contenedor nunca puede voltear el ruteo del evento */ }
  }), [workId]);

  /**
   * Toda mutación refresca PASE LO QUE PASE y reporta el error por el canal de
   * la app. Sin el `.catch`, un `BUDGET_EXCEEDED` o un `ValidationError`
   * dejaba el gate en pantalla, sin explicación, más una promesa sin manejar.
   *
   * `key` (ítem 14) marca `pending[key]` en `true` al emitir y en `false` en
   * el MISMO `.finally` — un doble click síncrono ve el segundo click con el
   * botón ya deshabilitado, así que sólo la primera mutación real sale.
   *
   * `issuedWorkId` (ítem 13e-b) es el workId de ESTE render, capturado antes
   * de que la promesa exista. `refreshActiveRuns()` es global y no necesita
   * guard acá (ya tiene el suyo propio); `refreshWork` sólo corre si la Marca
   * que emitió la mutación sigue siendo la que está abierta AHORA — si no,
   * ni se llama, y el `generation` del recorte por-Trabajo actual queda
   * intacto para que sus propias lecturas en vuelo lleguen.
   */
  const mutate = (key: string, action: Promise<unknown>): Promise<boolean> => {
    const issuedWorkId = workId;
    setPending((prev) => ({ ...prev, [key]: true }));
    // O1: el resultado VUELVE a quien la emitió. `true` sólo cuando el backend
    // resolvió bien; `false` cuando falló, ya reportado acá adentro. Nunca
    // rechaza: una promesa que rechaza obliga a cada llamador a encadenar su
    // propio `.catch`, y el que se olvide deja una promesa sin manejar.
    //
    // N9 (ronda 7): Y EL `.finally` TAMPOCO PUEDE RECHAZAR.
    //
    // "Nunca rechaza" era la promesa, pero el cuerpo del `.finally` la rompía:
    // un throw sincrónico en `refreshActiveRuns`/`refreshWork` —o en el propio
    // `report`— rechaza la promesa que `.finally` devuelve, aunque el `.then`
    // de arriba haya resuelto `true`. `confirmEdit` lo ve como "el motor
    // rechazó" y deja el editor abierto sobre una aprobación QUE SÍ ENTRÓ: la
    // persona vuelve a apretar y manda la propuesta dos veces. Un refresco que
    // falla es un dato viejo en pantalla, no una mutación deshecha, así que no
    // puede cambiar lo que se le responde a quien la emitió.
    return action
      .then(() => true, (e: unknown) => { try { report(e); } catch { /* el canal de error no puede tapar el resultado */ } return false; })
      // M10 (ronda 8): TRES PASOS, TRES `try`. N9 los puso a los tres bajo UNO
      // solo, así que un throw síncrono en cualquiera se llevaba puestos a los
      // siguientes. Hoy el orden salva a `setPending` por accidente —está
      // primera—, y eso es la clase de garantía que se pierde la próxima vez
      // que alguien reordena: sin limpiar el pendiente, el botón queda
      // deshabilitado PARA SIEMPRE y la persona se queda sin poder resolver la
      // decisión. Y la tira global cayéndose dejaba la pantalla del Trabajo con
      // el gate que la persona acaba de resolver todavía dibujado.
      //
      // Son independientes: ninguno necesita que el anterior haya salido bien.
      .finally(() => {
        const step = (fn: () => void): void => {
          try { fn(); } catch { /* un refresco caído deja datos viejos, no una mutación sin respuesta */ }
        };
        step(() => setPending((prev) => { const next = { ...prev }; delete next[key]; return next; }));
        step(() => refreshActiveRuns());
        step(() => { if (issuedWorkId && issuedWorkId === liveWorkId.current) refreshWork(issuedWorkId); });
      });
  };

  return {
    authority, review, budget, coordinatorGrant, run, gates, log, messages, hires, tasks, support, openAsks, activeRuns, pending,
    // Comparado contra el `workId` de ESTE render: el `true` del Trabajo
    // anterior no puede sobrevivir a la navegación ni un solo render.
    workLoaded: workId != null && loadedWorkId === workId,
    resolveGate: (gateId, decision, editedPayload) => mutate(`gate:${gateId}`, api.resolveCoordinationGate(gateId, decision, editedPayload)),
    answerAsk: (askId, answer) => mutate(`ask:${askId}`, api.answerCoordinationAsk(askId, answer)),
    settleDispatch: (taskId, outcome, summary) => mutate(`task:${taskId}`, api.settleCoordinationDispatch(taskId, outcome, summary)),
    pauseRun: (runId) => mutate(`run:${runId}`, api.pauseCoordinationRun(runId)),
    resumeRun: (runId) => mutate(`run:${runId}`, api.resumeCoordinationRun(runId)),
    cancelRun: (runId) => mutate(`run:${runId}`, api.cancelCoordinationRun(runId)),
    setBudget: (maxDispatches) => { if (workId) mutate(`budget:${workId}`, api.setCoordinationBudget(workId, { maxDispatches })); },
    setReview: (on) => { if (workId) mutate(`review:${workId}`, api.setCoordinationReview(workId, on)); },
    setCoordinator: (memberId) => (workId
      ? mutate(`coordinator:${workId}`, api.setCoordinatorGrant(workId, memberId))
      : Promise.resolve(false)),
    /**
     * Anotar la visita es CONTABILIDAD DE FONDO, no una acción de la persona:
     * desde F13 corre sola con sólo abrir el Trabajo, en cualquier vista. Por
     * eso no pasa por `mutate` — su fallo no puede ocupar el canal de error de
     * la app (taparía el aviso que la persona sí estaba leyendo) ni marcar
     * nada como pendiente, y en la vista previa del navegador, donde
     * `markCoordinationSeen` no existe, abrir un Trabajo cualquiera empezaba
     * con un cartel de error. Lo único que pierde un fallo acá es que la fila
     * de "desde tu última visita" siga un rato más: se reintenta sola la
     * próxima vez que se abra.
     */
    markSeen: () => {
      if (!workId) return;
      const issuedWorkId = workId;
      void Promise.resolve()
        .then(() => api.markCoordinationSeen(issuedWorkId))
        .then(
          () => { refreshActiveRuns(); },
          () => { /* una visita que no se pudo anotar no es un error de la persona */ },
        );
    },
  };
}
