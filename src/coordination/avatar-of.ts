import { avatarFromSeed, parseAvatar, type AvatarParams } from '../../shared/avatar';
import type { AgentRole, TeamMember } from '../../shared/contracts';

/**
 * DE DÓNDE SALE LA CARA DE CADA SUPERFICIE.
 *
 * Hay dos preguntas distintas y conviene no confundirlas.
 *
 * Una fila de MIEMBRO pregunta por una persona: la cara es la suya, y en un
 * equipo con dos Reviewers son dos caras distintas. Una fila de TAREA o de
 * ROL pregunta por un puesto: ahí la cara es la del rol, que es la del primer
 * miembro que lo ocupa.
 *
 * Ninguna de las dos puede devolver "nada": un miembro sin avatar guardado, un
 * rol que ya no está en el catálogo, un fixture viejo de un test — todos
 * derivan una cara de su id. Que una superficie se quede sin avatar no es una
 * opción; que el avatar sea derivado, sí.
 */

/** La cara de una persona. */
export function avatarOfMember(member: Pick<TeamMember, 'avatar' | 'roleId'>): AvatarParams {
  return parseAvatar(member.avatar) ?? avatarFromSeed(member.roleId);
}

/**
 * La cara de un puesto: la del miembro que lo ocupa si hay uno, y si no la que
 * el rol declara. Se prefiere al miembro para que la tira de tareas muestre la
 * MISMA cara que la fila de quien va a hacerlas.
 */
export function avatarOfRole(
  roleId: string | null | undefined,
  roles: readonly AgentRole[] = [],
  team: readonly TeamMember[] = [],
): AvatarParams | null {
  if (!roleId) return null;
  const member = team.find((m) => m.roleId === roleId);
  if (member) return avatarOfMember(member);
  const role = roles.find((r) => r.id === roleId);
  return parseAvatar(role?.avatar) ?? avatarFromSeed(roleId);
}
