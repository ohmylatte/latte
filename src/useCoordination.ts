import { useEffect, useRef, useState } from 'react';
import { api } from './browser-api';
import { shouldRefreshWork } from './coordination-event-routing';
import type {
  CoordinationActiveRunSummary, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudgetView,
  CoordinationGateView, CoordinationHireView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationRunView, CoordinatorGrant,
} from '../shared/contracts';

export { shouldRefreshWork } from './coordination-event-routing';

export interface CoordinationState {
  authority: CoordinationAuthorityMode;
  budget: CoordinationBudgetView;
  coordinatorGrant: CoordinatorGrant;
  run: CoordinationRunView | null;
  gates: CoordinationGateView[];
  log: CoordinationLogEntryView[];
  /** Las contrataciones del run, para la bitacora. Antes esa prop no la llenaba nadie. */
  hires: CoordinationHireView[];
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
  resolveGate: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void;
  answerAsk: (askId: string, answer: string) => void;
  /** Surfaces task 3.19's `settleCoordinationDispatch` — never reinvented. */
  settleDispatch: (taskId: string, outcome: 'succeeded' | 'failed', summary: string) => void;
  pauseRun: (runId: string) => void;
  /** La vuelta de la pausa: sin esto, "Pausar equipo" era una trampa de ida. */
  resumeRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
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
export function useCoordination(workId: string | null, onError?: (error: unknown) => void): CoordinationState {
  const [authority, setAuthority] = useState<CoordinationAuthorityMode>('manual');
  const [budget, setBudget] = useState<CoordinationBudgetView>({ state: 'unset' });
  const [coordinatorGrant, setCoordinatorGrant] = useState<CoordinatorGrant>(null);
  const [run, setRun] = useState<CoordinationRunView | null>(null);
  const [gates, setGates] = useState<CoordinationGateView[]>([]);
  const [log, setLog] = useState<CoordinationLogEntryView[]>([]);
  const [hires, setHires] = useState<CoordinationHireView[]>([]);
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
  const report = (error: unknown) => { errorSink.current?.(error); };

  const refreshActiveRuns = () => {
    const n = ++activeRunsGeneration.current;
    const fresh = () => n === activeRunsGeneration.current;
    void api.listActiveCoordinationRuns().then((v) => { if (fresh()) setActiveRuns(v); }).catch(() => { if (fresh()) setActiveRuns([]); });
  };

  const refreshWork = (id: string) => {
    const n = ++generation.current;
    const fresh = () => n === generation.current;
    void api.getCoordinationAuthority(id).then((v) => { if (fresh()) setAuthority(v); }).catch(() => { if (fresh()) setAuthority('manual'); });
    void api.getCoordinationBudget(id).then((v) => { if (fresh()) setBudget(v); }).catch(() => { if (fresh()) setBudget({ state: 'unset' }); });
    void api.getCoordinatorGrant(id).then((v) => { if (fresh()) setCoordinatorGrant(v); }).catch(() => { if (fresh()) setCoordinatorGrant(null); });
    void api.coordinationRuntimeSupport(id).then((v) => { if (fresh()) setSupport(v); }).catch(() => { if (fresh()) setSupport([]); });
    // `loaded()` marca el recorte de ESTE `id` como cargado, y sólo si sigue
    // siendo el vigente. Es lo que `markSeen` espera: hasta acá la pantalla
    // de Decisiones no tiene un solo gate dibujado.
    const loaded = () => { if (fresh()) setLoadedWorkId(id); };
    void api.getCoordinationRun(id).then((current) => {
      if (!fresh()) return;
      setRun(current);
      // Sin run no hay nada más que esperar: eso ya es una respuesta completa.
      if (!current) { setGates([]); setLog([]); setHires([]); setOpenAsks([]); loaded(); return; }
      // `allSettled`: un error de una de las cuatro no puede dejar la visita
      // colgada para siempre — cada `.catch` de abajo ya degrada a su default
      // seguro, y la pantalla igual terminó de cargar.
      void Promise.allSettled([
        api.listCoordinationGates(current.id).then((v) => { if (fresh()) setGates(v); }).catch((e) => { report(e); if (fresh()) setGates([]); }),
        api.listCoordinationLog(current.id).then((v) => { if (fresh()) setLog(v); }).catch((e) => { report(e); if (fresh()) setLog([]); }),
        api.listCoordinationHires(current.id).then((v) => { if (fresh()) setHires(v); }).catch((e) => { report(e); if (fresh()) setHires([]); }),
        api.listOpenCoordinationAsks(current.id).then((v) => { if (fresh()) setOpenAsks(v); }).catch((e) => { report(e); if (fresh()) setOpenAsks([]); }),
      ]).then(loaded);
    }).catch((e) => { report(e); if (fresh()) { setRun(null); setGates([]); setLog([]); setHires([]); setOpenAsks([]); loaded(); } });
  };

  // The global strip: fetched once, regardless of whether a Work is open.
  useEffect(() => { refreshActiveRuns(); }, []);

  // Per-work state: reset to the safe default the moment no Work is open,
  // exactly what an unwired caller of the four views already sees.
  useEffect(() => {
    if (!workId) {
      generation.current += 1; // toda respuesta en vuelo queda huérfana
      setAuthority('manual'); setBudget({ state: 'unset' }); setCoordinatorGrant(null);
      setRun(null); setGates([]); setLog([]); setHires([]); setSupport([]); setOpenAsks([]);
      return;
    }
    refreshWork(workId);
  }, [workId]);

  // `latte:coordination-event` (task 6.37): the global strip refreshes for
  // EVERY event, even one for a Brand the person is not viewing. The
  // per-work slice only refreshes when the event names the OPEN Work.
  useEffect(() => api.onCoordinationEvent((event) => {
    refreshActiveRuns();
    if (shouldRefreshWork(event, workId)) refreshWork(workId!);
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
  const mutate = (key: string, action: Promise<unknown>) => {
    const issuedWorkId = workId;
    setPending((prev) => ({ ...prev, [key]: true }));
    void action
      .catch(report)
      .finally(() => {
        setPending((prev) => { const next = { ...prev }; delete next[key]; return next; });
        refreshActiveRuns();
        if (issuedWorkId && issuedWorkId === liveWorkId.current) refreshWork(issuedWorkId);
      });
  };

  return {
    authority, budget, coordinatorGrant, run, gates, log, hires, support, openAsks, activeRuns, pending,
    // Comparado contra el `workId` de ESTE render: el `true` del Trabajo
    // anterior no puede sobrevivir a la navegación ni un solo render.
    workLoaded: workId != null && loadedWorkId === workId,
    resolveGate: (gateId, decision, editedPayload) => mutate(`gate:${gateId}`, api.resolveCoordinationGate(gateId, decision, editedPayload)),
    answerAsk: (askId, answer) => mutate(`ask:${askId}`, api.answerCoordinationAsk(askId, answer)),
    settleDispatch: (taskId, outcome, summary) => mutate(`task:${taskId}`, api.settleCoordinationDispatch(taskId, outcome, summary)),
    pauseRun: (runId) => mutate(`run:${runId}`, api.pauseCoordinationRun(runId)),
    resumeRun: (runId) => mutate(`run:${runId}`, api.resumeCoordinationRun(runId)),
    cancelRun: (runId) => mutate(`run:${runId}`, api.cancelCoordinationRun(runId)),
    markSeen: () => { if (workId) mutate(`seen:${workId}`, api.markCoordinationSeen(workId)); },
  };
}
