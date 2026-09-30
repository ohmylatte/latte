import { catalogs, currentLocale, type MessageKey } from './i18n';
import type { AgentRole, AgentSkill, UiLocale } from '../shared/contracts';

/**
 * EL COPY DEL PACK, LEÍDO EN EL IDIOMA DE LA INTERFAZ.
 *
 * El `summary:` del frontmatter de cada rol y de cada skill está escrito en
 * castellano dentro del `.md` del pack, y esos `.md` son el prompt que viaja
 * al runtime: ahí el idioma no es una decisión de interfaz, y además cada
 * archivo está contra su propio tope de caracteres (`sales-copywriter.md` a 23
 * del `ROLE_BODY_LIMIT`). Traducirlos en el disco no se puede.
 *
 * Así que se traduce del lado de la pantalla, que es donde el idioma importa:
 * un mapa por id contra el catálogo de i18n. Lo que NO está en el mapa —un rol
 * propio, una skill aprendida— devuelve su propio texto tal cual, que es lo
 * único honesto: la persona lo escribió y nadie lo tradujo.
 *
 * En castellano las claves repiten la frase del frontmatter palabra por
 * palabra. No es duplicación por descuido: es lo que hace que cambiar el
 * idioma no cambie el texto que la persona ya conocía.
 */
const ROLE_SUMMARY_KEYS: Record<string, MessageKey> = {
  assistant: 'role.summary.assistant',
  strategist: 'role.summary.strategist',
  researcher: 'role.summary.researcher',
  analyst: 'role.summary.analyst',
  reviewer: 'role.summary.reviewer',
  'paid-media': 'role.summary.paid-media',
  'sales-copywriter': 'role.summary.sales-copywriter',
  'community-manager': 'role.summary.community-manager',
};

const SKILL_SUMMARY_KEYS: Record<string, MessageKey> = {
  writing: 'skill.summary.writing',
};

/**
 * EL NOMBRE VISIBLE DE UN ROL, EN EL IDIOMA DE LA INTERFAZ.
 *
 * `role.name` sale del frontmatter del pack (`name: Strategist`), escrito en
 * inglés porque ese `.md` es el prompt que viaja al runtime: traducirlo en el
 * disco cambiaría lo que el agente lee. Con la interfaz en castellano una
 * persona sin jerga técnica veía "Strategist" en el medio de una pantalla en
 * español. `paid-media` no está en el mapa a propósito: "Paid Media" ya es el
 * nombre correcto en los dos idiomas.
 */
const ROLE_NAME_KEYS: Record<string, MessageKey> = {
  assistant: 'role.name.assistant',
  strategist: 'role.name.strategist',
  researcher: 'role.name.researcher',
  analyst: 'role.name.analyst',
  reviewer: 'role.name.reviewer',
  'sales-copywriter': 'role.name.sales-copywriter',
};

function translated(keys: Record<string, MessageKey>, id: string, fallback: string, locale: UiLocale): string {
  const key = keys[id];
  if (!key) return fallback;
  // El catálogo por locale, no `translate`: así esto se puede probar en los dos
  // idiomas sin tocar el estado global del provider.
  const text = catalogs[locale][key];
  return typeof text === 'string' && text.trim() !== '' ? text : fallback;
}

/** El resumen de un rol, traducido si es del pack; el suyo propio si es custom. */
export function roleSummary(role: Pick<AgentRole, 'id' | 'summary'>, locale: UiLocale = currentLocale()): string {
  return translated(ROLE_SUMMARY_KEYS, role.id, role.summary, locale);
}

/** Lo mismo para las skills que Latte trae. Una skill aprendida devuelve la suya. */
export function skillSummary(skill: Pick<AgentSkill, 'id' | 'summary'>, locale: UiLocale = currentLocale()): string {
  return translated(SKILL_SUMMARY_KEYS, skill.id, skill.summary, locale);
}

/**
 * El nombre de un rol del pack, traducido; el suyo propio si es custom o si el
 * nombre ya es igual en los dos idiomas (`paid-media`). Toma `id`+`name` en vez
 * de un `AgentRole` completo para que un `TeamMember` (`roleId`/`roleName`) y
 * un `AgentRole` (`id`/`name`) puedan pasar por la misma función.
 */
export function roleLabel(role: { id: string; name: string }, locale: UiLocale = currentLocale()): string {
  return translated(ROLE_NAME_KEYS, role.id, role.name, locale);
}
