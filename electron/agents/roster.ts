import { avatarFromSeed, parseAvatar, serializeAvatar } from '../../shared/avatar';
import type { BrandMemberRecord } from '../storage/repository';

/**
 * EL PLANTEL DE LA MARCA: las reglas puras (brief
 * `docs/briefs/2026-09-23-equipo-de-marca.md`, 3.1 y decisión 3 del dueño).
 *
 * Sin I/O: el hub y el servicio leen el plantel y le preguntan acá qué cara
 * tiene cada uno y desde cuándo alguien cuenta como "nadie lo convoca".
 */

/**
 * Cuántos días sin que nadie lo convoque —ni una convocatoria nueva ni un
 * movimiento en alguno de sus hilos— tiene que pasar alguien del plantel para
 * retirarse solo. Decisión del dueño: "que entre sólo cuando se llame, eso baja
 * el ruido". Retirarse no borra nada: se ve en gris en Marca → Equipo y vuelve
 * en cuanto lo convocan. Configurable acá, a propósito no en la interfaz.
 */
export const BRAND_MEMBER_IDLE_DAYS = 30;

/** El instante antes del cual la última convocatoria cuenta como "nadie lo llamó". */
export function retirementCutoff(now: string, days = BRAND_MEMBER_IDLE_DAYS): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

/**
 * La cara de cada persona del plantel, resuelta UNA vez para toda la marca.
 *
 * Una cara elegida (la columna `avatar`) gana siempre. Sin elección, la
 * primera persona de cada rol —por orden de llegada— lleva la cara del rol, con
 * su override de Ajustes incluido, y las siguientes derivan la suya de su
 * propio id y conservan el color del rol. Es la regla de antes ("ninguna cara
 * repetida en un equipo") calculada dentro de la MARCA en vez del trabajo, que
 * es más estable: la cara de alguien deja de depender de a quién más
 * convocaron ese día.
 */
export function rosterFaces(roster: readonly BrandMemberRecord[], roleAvatar: (roleId: string) => string): Map<string, string> {
  const faces = new Map<string, string>();
  const seen = new Set<string>();
  const ordered = [...roster].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  for (const member of ordered) {
    const chosen = parseAvatar(member.avatar);
    if (chosen) {
      faces.set(member.id, serializeAvatar(chosen));
      continue;
    }
    faces.set(member.id, seen.has(member.roleId) ? serializeAvatar(avatarFromSeed(member.id)) : roleAvatar(member.roleId));
    seen.add(member.roleId);
  }
  return faces;
}
