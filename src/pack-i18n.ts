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
};

const SKILL_SUMMARY_KEYS: Record<string, MessageKey> = {
  writing: 'skill.summary.writing',
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
