import { avatarHash } from '../../shared/avatar';

/**
 * Un color por rol, para TODOS los roles.
 *
 * Antes había cinco tokens fijos (`assistant`, `strategist`, `researcher`,
 * `analyst`, `reviewer`) y todo lo demás caía en `--role-default`: paid-media,
 * community-manager, sales-copywriter y cualquier rol propio quedaban del
 * mismo beige. Tres miembros indistinguibles no son una paleta sobria, son una
 * identidad perdida.
 *
 * Ahora la paleta tiene ocho tonos de Latte. Los cinco roles que ya tenían el
 * suyo lo conservan —cambiarlos sería reescribirle el color a un equipo que ya
 * existe— y al resto se le asigna uno por hash de su id: determinista, sin
 * estado y sin registro que mantener, así un rol propio se ve igual en cada
 * pantalla, en cada sesión y en cada máquina.
 *
 * Cada tono viene con su "wash", el tono claro que va de fondo en el disco del
 * avatar. El color pleno lleva texto encima (la inicial de reserva), así que
 * los ocho pasan 4.5:1 contra `--on-accent`; hay un test que lo verifica sobre
 * la hoja, no sobre esta lista.
 */
export const ROLE_PALETTE = [
  'assistant',
  'strategist',
  'researcher',
  'analyst',
  'reviewer',
  'terracotta',
  'copper',
  'forest',
] as const;

export type RoleTone = (typeof ROLE_PALETTE)[number];

/** Los roles que ya tenían color: su tono no se toca nunca. */
const FIXED: Readonly<Record<string, RoleTone>> = {
  assistant: 'assistant',
  strategist: 'strategist',
  researcher: 'researcher',
  analyst: 'analyst',
  reviewer: 'reviewer',
};

/** El tono que le toca a un rol. Fijo si lo tiene; si no, por hash de su id. */
export function roleTone(roleId: string | null | undefined): RoleTone | null {
  if (typeof roleId !== 'string' || !roleId) return null;
  return FIXED[roleId] ?? ROLE_PALETTE[avatarHash('role\u0000' + roleId) % ROLE_PALETTE.length];
}

/** El par de variables CSS de un rol: el color pleno y su wash. */
export interface RoleColor { color: string; wash: string }

/**
 * El color de un rol, como variables CSS. Devuelve tokens, nunca hex: el tema
 * sigue viviendo en la hoja y esto sólo elige cuál.
 */
export function roleColor(roleId: string | null | undefined): RoleColor {
  const tone = roleTone(roleId);
  return tone === null
    ? { color: 'var(--role-default)', wash: 'var(--role-default-wash)' }
    : { color: `var(--role-${tone})`, wash: `var(--role-${tone}-wash)` };
}

/** El token del color pleno, para quien sólo necesita eso. */
export function roleColorVar(roleId: string | null | undefined): string {
  return roleColor(roleId).color;
}
