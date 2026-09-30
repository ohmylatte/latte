import type { BrandDnaFields, BrandDnaIdea } from '../shared/contracts';
import type { MessageKey } from './i18n';

/**
 * 3 · LAS IDEAS DE INICIO.
 *
 * Si el agente escribió ideas (máx. 4 vigentes), esas: son concretas, con
 * motivo y con base. Si no —todavía no hubo un build, o no hay IA—, sólo las
 * que salen del ADN de ESTA marca.
 *
 * 2.0: se fueron la fecha comercial más cercana y la estación. Eran iguales
 * para todas las marcas —el Día de la Madre para un software B2B—: una idea
 * que no sale de la marca no es una idea. El calendario comercial va a ser
 * una herramienta del rol que arma calendarios, no un dato de cada marca.
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
}

/** Vigentes: las mismas 4 que guarda el backend, nunca una grilla infinita. */
export const MAX_HOME_IDEAS = 4;

export function homeIdeas(input: HomeIdeasInput, t: HomeIdeaText): HomeIdeaItem[] {
  const fromAgent = input.ideas.slice(0, MAX_HOME_IDEAS).map((idea) => ({
    id: idea.id,
    workTypeId: idea.workTypeId,
    title: idea.title,
    why: idea.why,
    fromAgent: true,
  }));
  if (fromAgent.length > 0) return fromAgent;

  const out: HomeIdeaItem[] = [];

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
