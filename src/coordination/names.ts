import { translate as t } from '../i18n';
import type { AgentRole, TeamMember } from '../../shared/contracts';

/**
 * B2.2: LA RESOLUCIÓN DE NOMBRES DE COORDINACIÓN, EN UN SOLO LUGAR.
 *
 * Cada superficie —el buzón, el hilo, las tarjetas, la bitácora del Resumen,
 * lo avanzado del equipo— resolvía el `memberId` por su cuenta, y todas
 * terminaban igual: `team.find(...)?.roleName ?? memberId`. Ese `??` es el
 * problema. Un miembro contratado por un run que ya terminó puede no estar más
 * en el equipo, y entonces la persona leía `mem_9f3a11c4`, que no nombra a
 * nadie y además parece un error de la app.
 *
 * Acá la cadena termina SIEMPRE en algo que se puede leer:
 *   1. el rol del miembro, si el miembro sigue en el equipo;
 *   2. el rol que traiga la fila (`roleId`), resuelto contra el equipo y
 *      después contra el catálogo de roles;
 *   3. "miembro que ya no está", que es un hecho, no un relleno.
 *
 * El id pelado puede quedar en un `title` o en un `data-*` —son para depurar,
 * no para leer—, nunca en el copy.
 */
export function memberDisplayName(
  memberId: string | null | undefined,
  team: readonly TeamMember[],
  roleId?: string | null,
  roles: readonly AgentRole[] = [],
): string {
  if (memberId) {
    const member = team.find((m) => m.id === memberId);
    if (member) return member.roleName;
  }
  if (roleId) {
    const byRole = team.find((m) => m.roleId === roleId);
    if (byRole) return byRole.roleName;
    const role = roles.find((r) => r.id === roleId);
    if (role) return role.name;
  }
  return t('coordination.member.gone');
}

/**
 * Un `roleId` resuelto a un nombre: el miembro ya contratado si existe, si no
 * el catálogo de roles, y si no el id.
 *
 * Acá el id crudo SÍ se queda, y a propósito: esto nombra roles de una
 * PROPUESTA, donde un `roleId` que el catálogo no conoce no es un miembro que
 * se fue sino un rol que el coordinador inventó. Taparlo con "miembro que ya
 * no está" sería mentir sobre qué pasó; mostrarlo dice exactamente lo que la
 * persona necesita para decidir si aprueba ese plan.
 */
export function roleDisplayName(roleId: string, roles: readonly AgentRole[], team: readonly TeamMember[]): string {
  const member = team.find((m) => m.roleId === roleId);
  if (member) return member.roleName;
  const role = roles.find((r) => r.id === roleId);
  if (role) return role.name;
  return roleId;
}
