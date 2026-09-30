import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCIAL_DATE_WINDOW_DAYS,
  commercialDateOn,
  daysUntil,
  fullDateLabel,
  nthWeekdayDay,
  seasonOn,
  thanksgivingDay,
  upcomingCommercialDates,
} from '../shared/commercial-dates';
import type { BrandDnaFields, BrandDnaIdea, BrandDnaEntry, ContentLocale } from '../shared/contracts';
import { homeIdeas, type HomeIdeaText } from './home-ideas';

/**
 * 3 · LAS IDEAS DE INICIO.
 *
 * El primer bloque mide el calendario de `shared/commercial-dates`, que se
 * queda porque lo usan otros lados; ya no es una idea de Inicio. El resto
 * mide la grilla: las del agente mandan, y el respaldo sale SÓLO del ADN de
 * esta marca —sin fecha comercial ni estación: eran iguales para todas las
 * marcas (el Día de la Madre para un software B2B).
 */

afterEach(() => { vi.unstubAllGlobals(); });

describe('fechas comerciales: domingos exactos, hemisferio y ventana de 6 semanas', () => {
  it('cada fecha cae el día exacto de su año: los domingos se calculan', () => {
    // 3er domingo de octubre de 2026 (AR) = 18; 2º de mayo (US) = 10.
    expect(nthWeekdayDay(2026, 10, 0, 3)).toBe(18);
    expect(nthWeekdayDay(2026, 5, 0, 2)).toBe(10);
    expect(nthWeekdayDay(2026, 6, 0, 3)).toBe(21);
    expect(nthWeekdayDay(2026, 8, 0, 3)).toBe(16);
    // Acción de Gracias = 4º jueves de noviembre; Black Friday y Cyber Monday salen de ahí.
    expect(thanksgivingDay(2026)).toBe(26);
    expect(commercialDateOn(2026, 'black-friday', 'AR')).toEqual({ month: 11, day: 27, approximate: false });
    expect(commercialDateOn(2026, 'cyber-monday', 'US')).toEqual({ month: 11, day: 30, approximate: false });
    expect(commercialDateOn(2026, 'mothers-day', 'AR')).toEqual({ month: 10, day: 18, approximate: false });
    expect(commercialDateOn(2026, 'mothers-day', 'US')).toEqual({ month: 5, day: 10, approximate: false });
    // Hot Sale es la única aproximada, y lo dice.
    expect(commercialDateOn(2026, 'hot-sale', 'AR')).toEqual({ month: 5, day: 15, approximate: true });
  });

  it('la ventana es exactamente 6 semanas: el día 42 adentro, el 43 afuera', () => {
    expect(COMMERCIAL_DATE_WINDOW_DAYS).toBe(42);
    // Del 3 de enero al 14 de febrero hay 42 días exactos.
    expect(upcomingCommercialDates('AR', '2027-01-03').find((date) => date.id === 'valentines')).toMatchObject({ date: '2027-02-14' });
    expect(upcomingCommercialDates('AR', '2027-01-02').map((date) => date.id)).not.toContain('valentines');
  });

  it('sólo lo que viene: lo pasado rueda al año que viene y queda fuera', () => {
    expect(upcomingCommercialDates('AR', '2026-09-27').map((date) => date.date)).toEqual(['2026-10-18']);
    expect(upcomingCommercialDates('US', '2026-11-01').map((date) => date.id)).toEqual(['black-friday', 'cyber-monday']);
    expect(upcomingCommercialDates('AR', '2026-09-27').map((date) => date.id)).not.toContain('childrens-day');
    expect(upcomingCommercialDates('AR', '2026-05-01').find((date) => date.id === 'hot-sale')).toMatchObject({ date: '2026-05-15', approximate: true });
  });

  it('la estación sigue el hemisferio del país, no el mes del calendario', () => {
    expect(seasonOn('AR', '2026-09-27')).toBe('spring');
    expect(seasonOn('US', '2026-09-27')).toBe('autumn');
    expect(seasonOn('AR', '2026-01-15')).toBe('summer');
    expect(seasonOn('US', '2026-01-15')).toBe('winter');
    expect(seasonOn('AR', '2026-07-10')).toBe('winter');
    expect(seasonOn('US', '2026-07-10')).toBe('summer');
  });

  it('la fecha larga sale igual en los dos idiomas, sin depender de la máquina', () => {
    expect(fullDateLabel('2026-10-18', 'es-AR')).toBe('domingo 18 de octubre de 2026');
    expect(fullDateLabel('2026-10-18', 'en-US')).toBe('Sunday, October 18, 2026');
    expect(daysUntil('2026-09-27', '2026-10-18')).toBe(21);
  });
});

const entry = <T>(value: T): BrandDnaEntry<T> => ({ value, sources: [{ kind: 'context', label: 'contexto de marca' }], assumption: false });
const fields = (patch: Partial<BrandDnaFields> = {}): BrandDnaFields => ({
  tone: null, audience: null, valueProp: null, wordsYes: null, wordsNo: null, claims: null, colors: null, fonts: null, ...patch,
});
const agentIdea = (patch: Partial<BrandDnaIdea> = {}): BrandDnaIdea => ({
  id: 'idea-1',
  title: 'Lanzamiento de la colección de otoño',
  why: 'La colección nueva todavía no tiene campaña.',
  workTypeId: 'campaign-new',
  basedOn: [{ kind: 'document', label: 'brief de primavera' }],
  createdAt: '2026-09-27',
  ...patch,
});

describe('las ideas del agente mandan sobre las de respaldo', () => {
  it('con ideas del agente se muestran ESAS, con su motivo, y nada más', async () => {
    const t = await loadT('es-AR');
    const items = homeIdeas({ ideas: [agentIdea()], dna: fields() }, t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'idea-1',
      workTypeId: 'campaign-new',
      title: 'Lanzamiento de la colección de otoño',
      why: 'La colección nueva todavía no tiene campaña.',
      fromAgent: true,
    });
  });

  it('se cortan en cuatro: sólo las vigentes entran a la grilla', async () => {
    const t = await loadT('es-AR');
    const ideas = Array.from({ length: 6 }, (_, i) => agentIdea({ id: `idea-${i}` }));
    expect(homeIdeas({ ideas, dna: null }, t)).toHaveLength(4);
  });
});

describe('respaldo: sólo lo que sale del ADN, en los dos idiomas', () => {
  it('sin ideas del agente y sin ADN no hay nada que proponer', async () => {
    const t = await loadT('es-AR');
    const items = homeIdeas({ ideas: [], dna: null }, t);
    expect(items).toEqual([]);
  });

  it('lo mismo con la interfaz en inglés', async () => {
    const t = await loadT('en-US');
    const items = homeIdeas({ ideas: [], dna: null }, t);
    expect(items).toEqual([]);
  });

  it('la idea del ADN usa la palabra que la marca no usa', async () => {
    const t = await loadT('es-AR');
    const items = homeIdeas({ ideas: [], dna: fields({ wordsNo: entry(['oferta']) }) }, t);
    const dnaItem = items.find((item) => item.id === 'adn-palabras');
    expect(dnaItem).toMatchObject({
      workTypeId: 'copy-pieces',
      title: 'Revisá las piezas: la marca no usa «oferta»',
      why: 'Lo dice el ADN de la marca.',
    });
    // 2.0: nada del calendario ni de la estación: esas eran iguales para todas.
    for (const item of items) {
      expect(item.id).not.toMatch(/^fecha-/);
      expect(item.id).not.toBe('temporada');
      expect(item.title).not.toMatch(/Día de la Madre|Black Friday|Hot Sale|temporada|Seasonal/i);
    }
  });

  it('sin palabras prohibidas, la segunda línea es la propuesta o la audiencia', async () => {
    const t = await loadT('es-AR');
    const conPropuesta = homeIdeas({ ideas: [], dna: fields({ valueProp: entry('Objetos de diseño para la vida cotidiana.') }) }, t);
    expect(conPropuesta.find((item) => item.id === 'adn-propuesta')).toMatchObject({
      title: 'Llevá tu propuesta a cada pieza',
      why: 'Objetos de diseño para la vida cotidiana.',
    });

    const conAudiencia = homeIdeas({ ideas: [], dna: fields({ audience: entry('Personas que eligen menos.') }) }, t);
    expect(conAudiencia.find((item) => item.id === 'adn-propuesta')!.why).toBe('Personas que eligen menos.');

    const sinDna = homeIdeas({ ideas: [], dna: fields() }, t);
    expect(sinDna.some((item) => item.id.startsWith('adn-'))).toBe(false);
  });
});

/** Carga el formateador real una vez, con el stub que i18n necesita en el entorno node. */
async function loadT(locale: ContentLocale): Promise<HomeIdeaText> {
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  const { formatMessage } = await import('./i18n');
  return ((key: never, params?: never) => formatMessage(locale, key, params)) as HomeIdeaText;
}
