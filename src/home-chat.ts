import type { BrandDnaFields } from '../shared/contracts';
import type { MessageKey } from './i18n';
import { FREE_FORM_WORK_TYPE, findWorkType, recommendRole, workTypes, type WorkType } from './work-catalog';

/**
 * Inicio · la caja "¿Qué querés hacer hoy con {marca}?".
 *
 * Sin IA: clasificar un texto contra el catálogo con palabras clave es un
 * problema de datos, no de modelo, y resolverlo adentro de un componente habría
 * hecho imposible probarlo. Este módulo es puro — no React, no `browser-api`,
 * nada que toque una ventana — así un test en Node puede decir qué tipo de
 * trabajo corresponde a "armame una campaña para primavera" sin montar nada.
 *
 * La caída es `Empezar libremente`: un texto que el catálogo no reconoce sigue
 * siendo un pedido válido, sólo que sin el molde de preguntas. Nunca se inventa
 * un tipo de trabajo que no corresponde.
 */

/** Lowercase, accent-free: "calendario" y "calendário" son la misma palabra. */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Keywords por tipo de trabajo, en los dos idiomas que habla la interfaz.
 *
 * Una keyword de 6 letras o más se busca como subcadena ("campana" encuentra
 * "campañas"); una más corta sólo como palabra entera, porque "vs" o "ads"
 * sueltos adentro de otra palabra inventarían coincidencias que no hay.
 */
const KEYWORDS: Record<string, string[]> = {
  'campaign-new': ['campana', 'campaign', 'lanzamiento', 'lanzar', 'lanza', 'launch'],
  'strategy': ['estrategia', 'strategy', 'posicionamiento', 'positioning', 'roadmap', 'branding'],
  'content-calendar': ['calendario', 'calendar', 'contenido', 'content', 'editorial', 'publicaciones', 'posts'],
  'copy-pieces': ['copy', 'copywriting', 'redaccion', 'redactar', 'texto', 'textos', 'anuncio', 'anuncios', 'caption', 'headline', 'email', 'newsletter', 'writing'],
  'adapt-pieces': ['adaptar', 'adapt', 'traducir', 'translate', 'resize', 'reformatear'],
  presentation: ['presentacion', 'present', 'deck', 'pitch', 'slides', 'webinar'],
  'campaign-ops': ['cuenta', 'pauta', 'activar', 'pausar', 'operar', 'ads'],
  'campaign-optimize': ['optimizar', 'optimize', 'optimization', 'rendimiento', 'performance', 'roas', 'ctr', 'mejorar'],
  'budget-review': ['presupuesto', 'budget', 'gasto', 'inversion', 'invertir', 'spend'],
  'paid-media-audit': ['auditoria', 'audit', 'paidmedia', 'pagada', 'pauta'],
  'period-compare': ['comparar', 'comparacion', 'compara', 'compare', 'benchmark'],
  'report-build': ['reporte', 'report', 'informe', 'metricas', 'dashboard', 'indicadores', 'analytics'],
};

/** The catalog order is the tie-break: the first type in the list wins. */
const CATALOG_ORDER: WorkType[] = [...workTypes];

/**
 * The work type a free-text request maps to. Scores every type by the length of
 * the keywords it matched — a longer keyword is a more specific signal, so
 * "auditoría de pauta" lands on the audit and not on the first type that also
 * mentions "pauta". Ties keep the catalog order; nothing matched falls back to
 * `Empezar libremente`.
 */
export function classifyWorkType(text: string): WorkType {
  const query = normalize(text ?? '').trim();
  if (!query) return FREE_FORM_WORK_TYPE;
  const words = query.split(/[^a-z0-9]+/).filter(Boolean);
  let best: WorkType | null = null;
  let bestScore = 0;
  for (const type of CATALOG_ORDER) {
    const keywords = KEYWORDS[type.id];
    if (!keywords) continue;
    let score = 0;
    for (const keyword of keywords) {
      if (!keyword) continue;
      const hit = keyword.length >= 6 ? query.includes(keyword) : words.includes(keyword);
      if (hit) score += keyword.length;
    }
    if (score > bestScore) { bestScore = score; best = type; }
  }
  return best ?? FREE_FORM_WORK_TYPE;
}

/** The role the classification recommends: the catalog's own, never a guess. */
export function classifyRole(text: string): string {
  return recommendRole(classifyWorkType(text));
}

/** The title of the type the text maps to, for the "Se arma como…" line. */
export function classifyTitleKey(text: string): MessageKey {
  return classifyWorkType(text).titleKey;
}

/**
 * The four suggestions Inicio offers: catalog templates whose one-line detail
 * is filled from the brand's DNA when there is one, and from the catalog's own
 * description when there is not. The same source of truth `Nuevo trabajo` uses.
 */
export interface HomeSuggestion {
  id: string;
  workTypeId: string;
  labelKey: MessageKey;
  detail: string;
}

const SUGGESTION_TYPES: Array<{ id: string; from?: (dna: BrandDnaFields) => string | null }> = [
  { id: 'campaign-new', from: (dna) => dna.audience?.value ?? null },
  { id: 'copy-pieces', from: (dna) => dna.tone?.value.adjectives.slice(0, 3).join(', ') || null },
  { id: 'content-calendar', from: (dna) => dna.valueProp?.value ?? null },
  { id: 'paid-media-audit' },
];

export function homeSuggestions(dna: BrandDnaFields | null, t: (key: MessageKey) => string): HomeSuggestion[] {
  return SUGGESTION_TYPES.map(({ id, from }) => {
    const type = findWorkType(id);
    if (!type) return null;
    const fromDna = dna && from ? from(dna) : null;
    return { id, workTypeId: type.id, labelKey: type.titleKey, detail: fromDna?.trim() || t(type.descriptionKey) };
  }).filter((s): s is HomeSuggestion => s !== null);
}
