import type { CoordinationEvent } from '../shared/contracts';

/**
 * Does this `latte:coordination-event` concern the Work currently open.
 * Pure, free of React and of `browser-api` (same discipline `home-summary.ts`
 * and `resumen-summary.ts` follow) so it is testable without touching a
 * `window`. `useCoordination` (task 7.11) uses this for the per-work half of
 * its event subscription; the global "Equipos activos" strip refreshes
 * unconditionally on every event and needs no such decision.
 */
export function shouldRefreshWork(event: CoordinationEvent, workId: string | null): boolean {
  return workId !== null && event.workId === workId;
}
