import { FileCheck } from 'lucide-react';
import { translate as t } from '../i18n';
import type { CoordinationTaskAudience } from '../../shared/contracts';

/**
 * E1: LA MARCA DE "PARA EL CLIENTE", UNA SOLA VEZ.
 *
 * El ícono hace el sustantivo (criterio 3) y la palabra lo dice entero donde
 * hay lugar: la tarjeta de la propuesta y el detalle. En la ficha de la tira,
 * donde el título ya ocupa la línea, va sólo el ícono con su nombre para el
 * lector de pantalla. Una tarea interna no lleva nada: es el caso de siempre.
 */
export function isClientTask(task: { audience?: CoordinationTaskAudience | null } | null | undefined): boolean {
  return task?.audience === 'client';
}

export function AudienceBadge({ compact = false }: { compact?: boolean }) {
  const label = t('coord.audience.client');
  if (compact) {
    return <span className="coord-audience is-compact" role="img" aria-label={label}><FileCheck size={12} aria-hidden="true" /></span>;
  }
  return <span className="coord-audience"><FileCheck size={12} aria-hidden="true" />{label}</span>;
}
