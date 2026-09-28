import type { BrandDnaFields, BrandDnaIdea, ContentLocale, UiLocale } from '../shared/contracts';
import {
  commercialDateName,
  countryLabel,
  countryOf,
  daysUntil,
  fullDateLabel,
  seasonLabel,
  seasonOn,
  upcomingCommercialDates,
} from '../shared/commercial-dates';
import type { MessageKey } from './i18n';

/**
 * 3 · LAS IDEAS DE INICIO.
 *
 * Si el agente escribió ideas (máx. 4 vigentes), esas: son concretas, con
 * motivo y con base. Si no —todavía no hubo un build, o no hay IA—, las de
 * respaldo, que sí son mejores que las cuatro fijas del catálogo porque salen
 * de datos reales de la marca y del calendario: la fecha comercial más
 * cercana con su fecha exacta, la estación del país, y una leída del ADN.
 *
 * Pura y con el `now` como parámetro: la fecha se pasa, nunca se adivina.
 */
export interface HomeIdeaItem {
  id: string;
  workTypeId: string;
  title: string;
  why: string;
  /** El agente la escribió: lleva la marca discreta "Idea de Latte". */
  fromAgent?: boolean;
}

export type HomeIdeaText = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface HomeIdeasInput {
  /** Las ideas del agente, tal como vienen en la ficha del ADN. */
  ideas: readonly BrandDnaIdea[];
  dna: BrandDnaFields | null;
  now: Date;
  /** El idioma de CONTENIDO: de él sale el país y la estación (es-AR → Argentina). */
  locale: ContentLocale;
  /** El idioma de la INTERFAZ: en él se escriben los nombres y las fechas que se muestran. */
  uiLocale: UiLocale;
}

/** Vigentes: las mismas 4 que guarda el backend, nunca una grilla infinita. */
export const MAX_HOME_IDEAS = 4;

/** El "hoy" de la persona, en calendario local: el mismo día que ella ve. */
function isoOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function homeIdeas(input: HomeIdeasInput, t: HomeIdeaText): HomeIdeaItem[] {
  const fromAgent = input.ideas.slice(0, MAX_HOME_IDEAS).map((idea) => ({
    id: idea.id,
    workTypeId: idea.workTypeId,
    title: idea.title,
    why: idea.why,
    fromAgent: true,
  }));
  if (fromAgent.length > 0) return fromAgent;

  const today = isoOf(input.now);
  const country = countryOf(input.locale);
  const out: HomeIdeaItem[] = [];

  // La fecha comercial más cercana dentro de las próximas 6 semanas.
  const date = upcomingCommercialDates(country, today)[0];
  if (date) {
    const days = daysUntil(today, date.date);
    const name = commercialDateName(date.id, input.uiLocale);
    const when = days < 7 ? t('home.ideas.days', { count: days }) : t('home.ideas.weeks', { count: Math.floor(days / 7) });
    out.push({
      id: `fecha-${date.id}`,
      workTypeId: 'content-calendar',
      title: days === 0 ? t('home.ideas.today', { date: name }) : t('home.ideas.soon', { date: name, when }),
      why: t(date.approximate ? 'home.ideas.dateWhyApprox' : 'home.ideas.dateWhy', { date: fullDateLabel(date.date, input.uiLocale) }),
    });
  }

  // La estación del país: el contenido de temporada no es lo mismo en los dos hemisferios.
  const season = seasonOn(country, today);
  out.push({
    id: 'temporada',
    workTypeId: 'campaign-new',
    title: t('home.ideas.season', { season: seasonLabel(season, input.uiLocale) }),
    why: t('home.ideas.seasonWhy', { date: fullDateLabel(today, input.uiLocale), country: countryLabel(country, input.uiLocale) }),
  });

  // El ADN, cuando hay: primero lo que la marca NO dice, después la propuesta o la audiencia.
  const forbidden = input.dna?.wordsNo?.value ?? [];
  if (forbidden.length > 0) {
    out.push({
      id: 'adn-palabras',
      workTypeId: 'copy-pieces',
      title: t('home.ideas.dnaWords', { word: forbidden[0] }),
      why: t('home.ideas.dnaWordsWhy'),
    });
  } else {
    const value = (input.dna?.valueProp?.value ?? input.dna?.audience?.value ?? '').trim();
    if (value) out.push({ id: 'adn-propuesta', workTypeId: 'copy-pieces', title: t('home.ideas.dnaProp'), why: value });
  }

  return out.slice(0, MAX_HOME_IDEAS);
}
