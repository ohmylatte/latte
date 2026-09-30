import type { MessageKey } from './i18n';

/**
 * Inicio · la tarjeta "Primeros pasos".
 *
 * Cuatro pasos que se marcan solos, con datos reales que la app ya tiene: el
 * ADN aprobado, que exista un trabajo, que haya un documento aprobado y que se
 * haya abierto el Embudo. Ninguno se deduce de una intención ni de una
 * narración: o el dato está o el paso queda pendiente.
 *
 * Puro y sin `browser-api`: los dos indicadores que no son hechos del negocio
 * —la tarjeta cerrada y el embudo abierto— se leen y escriben acá, con el mismo
 * `localStorage` protegido que usan las demás preferencias de vista, para que
 * el componente sólo reciba valores.
 */

export type FirstStepId = 'dna' | 'work' | 'document' | 'funnel';

export const FIRST_STEP_IDS: readonly FirstStepId[] = ['dna', 'work', 'document', 'funnel'];

export const FIRST_STEP_KEYS: Record<FirstStepId, MessageKey> = {
  dna: 'firstSteps.dna',
  work: 'firstSteps.work',
  document: 'firstSteps.document',
  funnel: 'firstSteps.funnel',
};

export interface FirstStepsInput {
  /** Hay una versión aprobada del ADN de la marca. */
  dnaApproved: boolean;
  /** La marca ya tiene al menos un trabajo. */
  hasWork: boolean;
  /** Al menos un documento de la marca está aprobado. */
  hasApprovedDocument: boolean;
  /** La persona abrió el Embudo de esta marca alguna vez. */
  funnelOpened: boolean;
}

export interface FirstStep {
  id: FirstStepId;
  labelKey: MessageKey;
  done: boolean;
}

export function firstSteps(input: FirstStepsInput): FirstStep[] {
  const done: Record<FirstStepId, boolean> = {
    dna: input.dnaApproved,
    work: input.hasWork,
    document: input.hasApprovedDocument,
    funnel: input.funnelOpened,
  };
  return FIRST_STEP_IDS.map((id) => ({ id, labelKey: FIRST_STEP_KEYS[id], done: done[id] }));
}

export interface FirstStepsProgress {
  done: number;
  total: number;
  /** La tarjeta desaparece cuando los cuatro están: no queda nada que ofrecer. */
  complete: boolean;
}

export function firstStepsProgress(steps: readonly FirstStep[]): FirstStepsProgress {
  const done = steps.filter((step) => step.done).length;
  const total = steps.length;
  return { done, total, complete: total > 0 && done === total };
}

/** La persona la cerró: una elección, guardada como cualquier otra vista. */
const CLOSED_KEY = 'latte:first-steps-closed';

export function isFirstStepsClosed(): boolean {
  try { return localStorage.getItem(CLOSED_KEY) === '1'; } catch { return false; }
}

export function setFirstStepsClosed(closed: boolean): void {
  try {
    if (closed) localStorage.setItem(CLOSED_KEY, '1');
    else localStorage.removeItem(CLOSED_KEY);
  } catch { /* private window: the card simply stays as it is */ }
}

/** Por marca: el Embudo de una marca no es el de otra. */
const FUNNEL_PREFIX = 'latte:funnel-opened:';

export function isFunnelOpened(brandId: string): boolean {
  if (!brandId) return false;
  try { return localStorage.getItem(FUNNEL_PREFIX + brandId) === '1'; } catch { return false; }
}

export function markFunnelOpened(brandId: string): void {
  if (!brandId) return;
  try { localStorage.setItem(FUNNEL_PREFIX + brandId, '1'); } catch { /* same as above */ }
}
