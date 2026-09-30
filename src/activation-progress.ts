import type { MessageKey } from './i18n';

/**
 * ENTREGA 1A: LOS PASOS DE NEGOCIO DE LA CONVERSACIÓN ACTIVADA.
 *
 * Brief 01 pide "progreso comprensible": nunca un spinner opaco, siempre pasos
 * de negocio (revisando el contexto, esperando tu aprobación, ...). Esta tira
 * es la versión compacta para la conversación de UN miembro (a diferencia de
 * `orientation-summary.ts`/`resumen-summary.ts`, que resumen el Trabajo
 * entero): cinco (o cuatro, sin verificación aplicable) casilleros fijos, cada
 * uno con su propio tono — nunca "cuál es el estado actual", que es lo que
 * decide `resumenEstado`.
 *
 * PURO: sin React ni `browser-api`. Cada señal ya la cargó quien llama
 * (App/TeamPanel, desde `chatStore` y los documentos del Trabajo); este módulo
 * sólo decide, para que la escalera tenga UNA sola implementación y se pueda
 * probar sin un componente.
 */

export type ActivationStepId = 'brief' | 'working' | 'approval' | 'result' | 'verified';
export type ActivationTone = 'done' | 'current' | 'pending';

export interface ActivationStep {
  id: ActivationStepId;
  labelKey: MessageKey;
  tone: ActivationTone;
}

export interface ActivationSignals {
  /** El primer turno humano de esta conversación ya se mandó. */
  briefSent: boolean;
  /** El agente está respondiendo AHORA (turno en curso). */
  agentWorking: boolean;
  /** Permisos o preguntas pendientes de esta conversación. */
  pendingApprovals: number;
  /** Hay un documento en revisión, o ya se vinculó un entregable. */
  resultReady: boolean;
  /** Este Trabajo tiene un entregable vinculado que verificar (`work.resultPath`). */
  hasVerification: boolean;
  /** El entregable vinculado es, para quien llama, un resultado confirmado por la persona. */
  verified: boolean;
}

const STEP_DEFS: ReadonlyArray<{ id: ActivationStepId; labelKey: MessageKey }> = [
  { id: 'brief', labelKey: 'activation.step.brief' },
  { id: 'working', labelKey: 'activation.step.working' },
  { id: 'approval', labelKey: 'activation.step.approval' },
  { id: 'result', labelKey: 'activation.step.result' },
  { id: 'verified', labelKey: 'activation.step.verified' },
];

/**
 * La escalera entera, de una vez: cada casillero se marca `done` (ya se pasó),
 * `current` (el más avanzado que se alcanzó, y no es el último) o `pending`
 * (todavía no). Es monótona a propósito — un resultado listo implica que la
 * aprobación, si hacía falta, ya se resolvió — y por eso nunca inventa un
 * estado: cada `reached` sale de una señal real, nunca de adivinar el paso de
 * uno anterior.
 */
export function activationSteps(input: ActivationSignals): ActivationStep[] {
  const reached: Record<ActivationStepId, boolean> = {
    brief: input.briefSent,
    working: input.briefSent && (input.agentWorking || input.pendingApprovals > 0 || input.resultReady || input.verified),
    approval: input.pendingApprovals > 0 || input.resultReady || input.verified,
    result: input.resultReady || input.verified,
    verified: input.verified,
  };
  const defs = input.hasVerification ? STEP_DEFS : STEP_DEFS.filter((d) => d.id !== 'verified');
  let lastReached = -1;
  defs.forEach((d, i) => { if (reached[d.id]) lastReached = i; });
  // Un casillero no alcanzado es SIEMPRE `pending`, sin importar su posición:
  // un `resultReady` sin `briefSent` (una señal inconsistente que nunca
  // debería llegar en la práctica) no puede pintar "brief" como si se hubiera
  // mandado. Sólo el más avanzado de los REALMENTE alcanzados es `current`.
  return defs.map((d, i) => {
    if (!reached[d.id]) return { id: d.id, labelKey: d.labelKey, tone: 'pending' };
    const tone: ActivationTone = i === lastReached ? (i === defs.length - 1 ? 'done' : 'current') : 'done';
    return { id: d.id, labelKey: d.labelKey, tone };
  });
}
