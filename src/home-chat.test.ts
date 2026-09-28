import { describe, expect, it } from 'vitest';
import { classifyRole, classifyTitleKey, classifyWorkType, homeSuggestions } from './home-chat';
import { FREE_FORM_WORK_TYPE, findWorkType } from './work-catalog';
import type { BrandDnaFields } from '../shared/contracts';

/**
 * Inicio · la clasificación del chat y las sugerencias.
 *
 * "Sin IA" es una decisión de producto, no un atajo: un texto se clasifica
 * contra el catálogo con palabras clave, y lo que el catálogo no reconoce cae
 * en "Empezar libremente". Si esto se resolviera dentro del componente, la
 * única forma de probarlo sería montar la pantalla entera.
 */

const dna = (patch: Partial<BrandDnaFields> = {}): BrandDnaFields => ({
  tone: { value: { adjectives: ['Cercano', 'Preciso'], example: 'Diseño que acompaña.' }, sources: [], assumption: false },
  audience: { value: 'Personas que eligen menos, con más intención.', sources: [], assumption: false },
  valueProp: { value: 'Objetos de diseño para la vida cotidiana.', sources: [], assumption: false },
  wordsYes: null, wordsNo: null, claims: null, colors: null, fonts: null,
  ...patch,
});

describe('la clasificación del chat contra el catálogo', () => {
  it('cada tipo de trabajo se alcanza con el lenguaje de una persona', () => {
    expect(classifyWorkType('Armame una campaña para primavera').id).toBe('campaign-new');
    expect(classifyWorkType('Launch the new product line').id).toBe('campaign-new');
    expect(classifyWorkType('Necesito un calendario de contenidos para octubre').id).toBe('content-calendar');
    expect(classifyWorkType('Escribí los copy para instagram').id).toBe('copy-pieces');
    expect(classifyWorkType('Haceme un reporte con las métricas del mes').id).toBe('report-build');
    expect(classifyWorkType('Auditoría de la pauta en Meta').id).toBe('paid-media-audit');
    expect(classifyWorkType('Optimizar el rendimiento de las campañas').id).toBe('campaign-optimize');
    expect(classifyWorkType('Comparar septiembre contra agosto').id).toBe('period-compare');
    expect(classifyWorkType('Revisar el presupuesto de ads').id).toBe('budget-review');
    expect(classifyWorkType('Preparar una presentación para el cliente').id).toBe('presentation');
  });

  it('escribes con acentos o sin acentos: la respuesta es la misma', () => {
    expect(classifyWorkType('campaña de primavera').id).toBe('campaign-new');
    expect(classifyWorkType('campana de primavera').id).toBe('campaign-new');
    expect(classifyWorkType('HACEMOS UN CALENDARIO').id).toBe('content-calendar');
  });

  it('la señal más específica gana: "auditoría" manda más que "pauta"', () => {
    expect(classifyWorkType('auditoría de pauta').id).toBe('paid-media-audit');
    expect(classifyWorkType('pausar la pauta de la cuenta').id).toBe('campaign-ops');
  });

  it('lo que el catálogo no reconoce cae en Empezar libremente', () => {
    expect(classifyWorkType('').id).toBe(FREE_FORM_WORK_TYPE.id);
    expect(classifyWorkType('   ').id).toBe(FREE_FORM_WORK_TYPE.id);
    expect(classifyWorkType('charlemos de la marca un rato').id).toBe(FREE_FORM_WORK_TYPE.id);
    expect(classifyWorkType('').titleKey).toBe('work.freeForm.title');
  });

  it('el rol recomendado es el del catálogo, nunca uno inventado', () => {
    expect(classifyRole('armame una campaña')).toBe('strategist');
    expect(classifyRole('escribí los copy')).toBe('sales-copywriter');
    expect(classifyRole('charlemos de la marca')).toBe('assistant');
    expect(classifyTitleKey('un reporte mensual')).toBe(findWorkType('report-build')!.titleKey);
  });
});

describe('las sugerencias de Inicio: plantillas del catálogo con datos del ADN', () => {
  const t = (key: string) => `«${key}»`;

  it('son cuatro, en el orden en que se piden, y cada una nombra un tipo real', () => {
    const suggestions = homeSuggestions(null, t);
    expect(suggestions.map((s) => s.workTypeId)).toEqual(['campaign-new', 'copy-pieces', 'content-calendar', 'paid-media-audit']);
    for (const suggestion of suggestions) expect(findWorkType(suggestion.workTypeId)).not.toBeNull();
  });

  it('sin ADN, el detalle es la descripción del catálogo', () => {
    const suggestions = homeSuggestions(null, t);
    expect(suggestions[0].detail).toBe('«work.campaign.description»');
    expect(suggestions[3].detail).toBe('«work.paidMedia.description»');
    expect(suggestions.every((s) => s.detail.length > 0)).toBe(true);
  });

  it('con ADN, el detalle sale de la ficha de la marca', () => {
    const suggestions = homeSuggestions(dna(), t);
    expect(suggestions[0].detail).toBe('Personas que eligen menos, con más intención.');
    expect(suggestions[1].detail).toBe('Cercano, Preciso');
    expect(suggestions[2].detail).toBe('Objetos de diseño para la vida cotidiana.');
    // El cuarto no tiene dato propio en la ficha: sigue siendo del catálogo.
    expect(suggestions[3].detail).toBe('«work.paidMedia.description»');
  });

  it('un campo vacío en la ficha no deja la sugerencia en blanco', () => {
    const suggestions = homeSuggestions(dna({ audience: null, tone: null }), t);
    expect(suggestions[0].detail).toBe('«work.campaign.description»');
    expect(suggestions[1].detail).toBe('«work.copy.description»');
  });
});
