import { useEffect, useRef, useState } from 'react';
import { api } from './browser-api';
import { shouldRefreshWork } from './coordination-event-routing';
import type {
  CoordinationActiveRunSummary, CoordinationAskView, CoordinationAuthorityMode, CoordinationBudget,
  CoordinationGateView, CoordinationLogEntryView, CoordinationMemberSupport, CoordinationRunView, CoordinatorGrant,
} from '../shared/contracts';

export { shouldRefreshWork } from './coordination-event-routing';

export interface CoordinationState {
  authority: CoordinationAuthorityMode;
  budget: CoordinationBudget | null;
  coordinatorGrant: CoordinatorGrant;
  run: CoordinationRunView | null;
  gates: CoordinationGateView[];
  log: CoordinationLogEntryView[];
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
  resolveGate: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void;
  answerAsk: (askId: string, answer: string) => void;
  /** Surfaces task 3.19's `settleCoordinationDispatch` — never reinvented. */
  settleDispatch: (taskId: string, outcome: 'succeeded' | 'failed', summary: string) => void;
  pauseRun: (runId: string) => void;
  /** La vuelta de la pausa: sin esto, "Pausar equipo" era una trampa de ida. */
  resumeRun: (runId: string) => void;
  cancelRun: (runId: string) => void;
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
  const [budget, setBudget] = useState<CoordinationBudget | null>(null);
  const [coordinatorGrant, setCoordinatorGrant] = useState<CoordinatorGrant>(null);
  const [run, setRun] = useState<CoordinationRunView | null>(null);
  const [gates, setGates] = useState<CoordinationGateView[]>([]);
  const [log, setLog] = useState<CoordinationLogEntryView[]>([]);
  const [support, setSupport] = useState<CoordinationMemberSupport[]>([]);
  const [openAsks, setOpenAsks] = useState<CoordinationAskView[]>([]);
  const [activeRuns, setActiveRuns] = useState<CoordinationActiveRunSummary[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
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
    void api.getCoordinationBudget(id).then((v) => { if (fresh()) setBudget(v); }).catch(() => { if (fresh()) setBudget(null); });
    void api.getCoordinatorGrant(id).then((v) => { if (fresh()) setCoordinatorGrant(v); }).catch(() => { if (fresh()) setCoordinatorGrant(null); });
    void api.coordinationRuntimeSupport(id).then((v) => { if (fresh()) setSupport(v); }).catch(() => { if (fresh()) setSupport([]); });
    void api.getCoordinationRun(id).then((current) => {
      if (!fresh()) return;
      setRun(current);
      if (!current) { setGates([]); setLog([]); setOpenAsks([]); return; }
      void api.listCoordinationGates(current.id).then((v) => { if (fresh()) setGates(v); }).catch(() => { if (fresh()) setGates([]); });
      void api.listCoordinationLog(current.id).then((v) => { if (fresh()) setLog(v); }).catch(() => { if (fresh()) setLog([]); });
      void api.listOpenCoordinationAsks(current.id).then((v) => { if (fresh()) setOpenAsks(v); }).catch(() => { if (fresh()) setOpenAsks([]); });
    }).catch(() => { if (fresh()) { setRun(null); setGates([]); setLog([]); setOpenAsks([]); } });
  };

  // The global strip: fetched once, regardless of whether a Work is open.
  useEffect(() => { refreshActiveRuns(); }, []);

  // Per-work state: reset to the safe default the moment no Work is open,
  // exactly what an unwired caller of the four views already sees.
  useEffect(() => {
    if (!workId) {
      generation.current += 1; // toda respuesta en vuelo queda huérfana
      setAuthority('manual'); setBudget(null); setCoordinatorGrant(null);
      setRun(null); setGates([]); setLog([]); setSupport([]); setOpenAsks([]);
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
    authority, budget, coordinatorGrant, run, gates, log, support, openAsks, activeRuns, pending,
    resolveGate: (gateId, decision, editedPayload) => mutate(`gate:${gateId}`, api.resolveCoordinationGate(gateId, decision, editedPayload)),
    answerAsk: (askId, answer) => mutate(`ask:${askId}`, api.answerCoordinationAsk(askId, answer)),
    settleDispatch: (taskId, outcome, summary) => mutate(`task:${taskId}`, api.settleCoordinationDispatch(taskId, outcome, summary)),
    pauseRun: (runId) => mutate(`run:${runId}`, api.pauseCoordinationRun(runId)),
    resumeRun: (runId) => mutate(`run:${runId}`, api.resumeCoordinationRun(runId)),
    cancelRun: (runId) => mutate(`run:${runId}`, api.cancelCoordinationRun(runId)),
  };
}
