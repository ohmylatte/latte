import { useEffect, useState } from 'react';
import { api } from './browser-api';
import { shouldRefreshWork } from './coordination-event-routing';
import type {
  CoordinationActiveRunSummary, CoordinationAuthorityMode, CoordinationBudget,
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
  /** The global "Equipos activos" strip (task 6.34): every Brand, not scoped to `workId`. */
  activeRuns: CoordinationActiveRunSummary[];
  resolveGate: (gateId: string, decision: 'approve' | 'reject', editedPayload?: string | null) => void;
  answerAsk: (askId: string, answer: string) => void;
  /** Surfaces task 3.19's `settleCoordinationDispatch` — never reinvented. */
  settleDispatch: (taskId: string, outcome: 'succeeded' | 'failed', summary: string) => void;
  pauseRun: (runId: string) => void;
}

/**
 * `useCoordination(workId)` (autonomous-coordination Phase 7 task 7.11): the
 * one hook `src/App.tsx` calls to wire real coordination data into the four
 * additive-prop views (`HomeView`, `ResumenView`, `DecisionsView`,
 * `TeamPanel`), the active-teams strip and the memory notice — every one of
 * which was built in slice 7-A against `undefined`/empty state only.
 *
 * Two independent halves, on purpose (mirrors the injection policies'
 * design): `activeRuns` is GLOBAL — fetched and refreshed regardless of
 * `workId`, because the strip must show a run in a Brand the person is not
 * currently viewing. Everything else is scoped to `workId` and resets to a
 * safe, honest default the moment it is `null` (no Work open).
 *
 * `openAsks` is deliberately NOT part of this hook: no IPC method lists open
 * asks (`answerCoordinationAsk` only answers one by id), and adding one is
 * out of scope for this slice (all 21 coordination methods already exist).
 * `DecisionsView.openAsks` stays unwired — a disclosed gap, not an
 * oversight.
 */
export function useCoordination(workId: string | null): CoordinationState {
  const [authority, setAuthority] = useState<CoordinationAuthorityMode>('manual');
  const [budget, setBudget] = useState<CoordinationBudget | null>(null);
  const [coordinatorGrant, setCoordinatorGrant] = useState<CoordinatorGrant>(null);
  const [run, setRun] = useState<CoordinationRunView | null>(null);
  const [gates, setGates] = useState<CoordinationGateView[]>([]);
  const [log, setLog] = useState<CoordinationLogEntryView[]>([]);
  const [support, setSupport] = useState<CoordinationMemberSupport[]>([]);
  const [activeRuns, setActiveRuns] = useState<CoordinationActiveRunSummary[]>([]);

  const refreshActiveRuns = () => {
    void api.listActiveCoordinationRuns().then(setActiveRuns).catch(() => setActiveRuns([]));
  };

  const refreshWork = (id: string) => {
    void api.getCoordinationAuthority(id).then(setAuthority).catch(() => setAuthority('manual'));
    void api.getCoordinationBudget(id).then(setBudget).catch(() => setBudget(null));
    void api.getCoordinatorGrant(id).then(setCoordinatorGrant).catch(() => setCoordinatorGrant(null));
    void api.coordinationRuntimeSupport(id).then(setSupport).catch(() => setSupport([]));
    void api.getCoordinationRun(id).then((current) => {
      setRun(current);
      if (!current) { setGates([]); setLog([]); return; }
      void api.listCoordinationGates(current.id).then(setGates).catch(() => setGates([]));
      void api.listCoordinationLog(current.id).then(setLog).catch(() => setLog([]));
    }).catch(() => { setRun(null); setGates([]); setLog([]); });
  };

  // The global strip: fetched once, regardless of whether a Work is open.
  useEffect(() => { refreshActiveRuns(); }, []);

  // Per-work state: reset to the safe default the moment no Work is open,
  // exactly what an unwired caller of the four views already sees.
  useEffect(() => {
    if (!workId) {
      setAuthority('manual'); setBudget(null); setCoordinatorGrant(null);
      setRun(null); setGates([]); setLog([]); setSupport([]);
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

  return {
    authority, budget, coordinatorGrant, run, gates, log, support, activeRuns,
    resolveGate: (gateId, decision, editedPayload) => {
      void api.resolveCoordinationGate(gateId, decision, editedPayload).then(() => { if (workId) refreshWork(workId); });
    },
    answerAsk: (askId, answer) => {
      void api.answerCoordinationAsk(askId, answer).then(() => { if (workId) refreshWork(workId); });
    },
    settleDispatch: (taskId, outcome, summary) => {
      void api.settleCoordinationDispatch(taskId, outcome, summary).then(() => { if (workId) refreshWork(workId); });
    },
    pauseRun: (runId) => {
      void api.pauseCoordinationRun(runId).then(setRun);
    },
  };
}
