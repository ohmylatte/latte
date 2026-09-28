import { describe, expect, it } from 'vitest';
import { checkPieceAgainstDna, foldText, highlightSegments } from '../shared/brand-check';
import type { BrandDnaEntry, BrandDnaFields } from '../shared/contracts';

/**
 * ADN · CHEQUEO DE MARCA: el veredicto es determinista y cada regla se prueba
 * por su cuenta — acentos, mayúsculas, plurales, una palabra DENTRO de otra
 * que no cuenta, texto vacío, ADN sin `wordsNo`, y el criterio de "ante la
 * duda, unknown" de las afirmaciones.
 */

const entry = <T>(value: T): BrandDnaEntry<T> => ({ value, sources: [], assumption: false });

const dna = (patch: Partial<BrandDnaFields> = {}): BrandDnaFields => ({
  tone: null,
  audience: null,
  valueProp: null,
  wordsYes: null,
  wordsNo: null,
  claims: null,
  colors: null,
  fonts: null,
  ...patch,
});

const finding = (result: ReturnType<typeof checkPieceAgainstDna>, kind: string) =>
  result.findings.find((f) => f.kind === kind)!;

const wordsNoCount = (result: ReturnType<typeof checkPieceAgainstDna>) =>
  finding(result, 'wordsNo').hits?.length ?? 0;

describe('foldText', () => {
  it('baja mayúsculas y saca tildes, pero la ñ se queda entera', () => {
    expect(foldText('CAFÉ')).toBe('cafe');
    expect(foldText('Propuesta Número')).toBe('propuesta numero');
    expect(foldText('mañana')).toBe('mañana');
  });

  it('es idempotente y acepta texto con la tilde descompuesta', () => {
    expect(foldText(foldText('é'))).toBe('e');
    expect(foldText('cafe\u0301')).toBe('cafe');
  });
});

describe('wordsNo', () => {
  const banned = dna({ wordsNo: entry(['oferta', 'barato']) });

  it('encuentra la palabra exacta y devuelve el conteo', () => {
    const result = checkPieceAgainstDna('Esta oferta y esta oferta más.', banned, 3);
    const hits = finding(result, 'wordsNo').hits!;
    expect(hits).toEqual([{ word: 'oferta', count: 2 }]);
    expect(finding(result, 'wordsNo').status).toBe('warn');
    // Un AVISO por cada palabra distinta: "oferta" dos veces es un aviso, y el
    // detalle dice cuántas.
    expect(result.warnings).toBe(1);
    expect(result.dnaVersion).toBe(3);
  });

  it('no distingue mayúsculas ni tildes', () => {
    const result = checkPieceAgainstDna('La OFERTA del día y un barató', banned, null);
    expect(wordsNoCount(result)).toBe(2);

    const acentos = checkPieceAgainstDna('Una gran oferta', dna({ wordsNo: entry(['ofértà']) }), null);
    expect(wordsNoCount(acentos)).toBe(1);
  });

  it('acepta el plural simple en los dos lados', () => {
    expect(wordsNoCount(checkPieceAgainstDna('Ofertas de la semana', banned, null))).toBe(1);
    expect(wordsNoCount(checkPieceAgainstDna('oferta de la semana', dna({ wordsNo: entry(['ofertas']) }), null))).toBe(1);
    // La misma forma listada dos veces en el ADN no cuenta dos veces.
    const duplicated = dna({ wordsNo: entry(['oferta', 'ofertas']) });
    const result = checkPieceAgainstDna('ofertas', duplicated, null);
    expect(finding(result, 'wordsNo').hits).toEqual([{ word: 'oferta', count: 1 }]);
    expect(result.warnings).toBe(1);
  });

  it('una palabra dentro de otra NO cuenta', () => {
    expect(wordsNoCount(checkPieceAgainstDna('Producto baratón de la casa', banned, null))).toBe(0);
    expect(wordsNoCount(checkPieceAgainstDna('Precio megabarato hoy', banned, null))).toBe(0);
    expect(wordsNoCount(checkPieceAgainstDna('Ofertistas de siempre', banned, null))).toBe(0);
    expect(wordsNoCount(checkPieceAgainstDna('xoferta x', banned, null))).toBe(0);
    // ...pero sí cuenta con puntuación al lado.
    expect(wordsNoCount(checkPieceAgainstDna('¡Oferta! (barato)', banned, null))).toBe(2);
  });

  it('texto vacío y ADN sin wordsNo no acusan nada', () => {
    const empty = checkPieceAgainstDna('', banned, null);
    expect(empty.warnings).toBe(0);
    expect(finding(empty, 'wordsNo').status).toBe('ok');

    const noList = checkPieceAgainstDna('Oferta barato', dna(), null);
    expect(wordsNoCount(noList)).toBe(0);
    expect(finding(noList, 'wordsNo').status).toBe('ok');
    expect(noList.warnings).toBe(0);
  });

  it('encuentra palabras con ñ y números dentro de la palabra', () => {
    const result = checkPieceAgainstDna('El diseño no es maño', dna({ wordsNo: entry(['maño']) }), null);
    expect(wordsNoCount(result)).toBe(1);
    const ano = checkPieceAgainstDna('Este año hay descuento', dna({ wordsNo: entry(['ano']) }), null);
    expect(wordsNoCount(ano)).toBe(0);
  });
});

describe('wordsYes', () => {
  const liked = dna({ wordsYes: entry(['hogar', 'calma']) });

  it('es informativo: ok si aparece alguna, nunca warn', () => {
    const present = checkPieceAgainstDna('Un hogar con calma', liked, null);
    expect(finding(present, 'wordsYes').status).toBe('ok');
    expect(finding(present, 'wordsYes').hits).toEqual([{ word: 'hogar', count: 1 }, { word: 'calma', count: 1 }]);
    expect(present.warnings).toBe(0);

    const absent = checkPieceAgainstDna('Todo apurado y ruidoso', liked, null);
    expect(finding(absent, 'wordsYes').status).not.toBe('warn');
    expect(finding(absent, 'wordsYes').status).toBe('unknown');
    expect(absent.warnings).toBe(0);
  });

  it('sin palabras cargadas queda en unknown y no juzga', () => {
    const result = checkPieceAgainstDna('Cualquier texto', dna({ wordsYes: null }), null);
    expect(finding(result, 'wordsYes').status).toBe('unknown');
    expect(finding(result, 'wordsYes').hits).toEqual([]);
  });
});

describe('claims', () => {
  it('una promesa sin respaldo es warn y entra en los avisos', () => {
    const result = checkPieceAgainstDna('El mejor café de la ciudad.', dna(), null);
    const claims = finding(result, 'claims');
    expect(claims.status).toBe('warn');
    expect(claims.hits).toHaveLength(1);
    expect(result.warnings).toBe(1);
  });

  it('porcentajes y números con promesa también', () => {
    const pct = checkPieceAgainstDna('100% de clientes repiten.', dna(), null);
    expect(finding(pct, 'claims').status).toBe('warn');

    const more = checkPieceAgainstDna('Más de 500 marcas ya trabajan con Latte.', dna(), null);
    expect(finding(more, 'claims').status).toBe('warn');
    expect(finding(more, 'claims').hits![0]!.word).toContain('500');
  });

  it('un número suelto queda unknown: ante la duda no se acusa', () => {
    const doubt = checkPieceAgainstDna('3 pasos para armar el plan.', dna(), null);
    expect(finding(doubt, 'claims').status).toBe('unknown');
    expect(finding(doubt, 'claims').hits).toEqual([]);
    expect(doubt.warnings).toBe(0);

    const year = checkPieceAgainstDna('Plan 2026 de crecimiento.', dna(), null);
    expect(finding(year, 'claims').status).toBe('ok');
  });

  it('la afirmación registrada por la marca la respalda', () => {
    const registered = dna({ claims: entry(['El mejor café de la ciudad', '100% de clientes repiten']) });
    const backed = checkPieceAgainstDna('El mejor café de la ciudad. 100% de clientes repiten.', registered, null);
    expect(finding(backed, 'claims').status).toBe('ok');
    expect(finding(backed, 'claims').hits).toEqual([]);
    expect(backed.warnings).toBe(0);

    const partial = checkPieceAgainstDna('El mejor café de la ciudad y gratis para todos.', registered, null);
    expect(finding(partial, 'claims').status).toBe('ok');
  });

  it('un texto sin ninguna cara de afirmación queda ok', () => {
    const plain = checkPieceAgainstDna('Un texto simple, sin promesas, para leer tranquilo.', dna({ claims: entry([]) }), null);
    expect(finding(plain, 'claims').status).toBe('ok');
    expect(plain.warnings).toBe(0);
  });

  it('las URLs y el código no se toman por afirmación', () => {
    const url = checkPieceAgainstDna('Ver en https://ejemplo.com/100 de descuento', dna(), null);
    expect(finding(url, 'claims').status).toBe('ok');
  });
});

describe('tone e identity', () => {
  it('quedan en unknown: los verifica la persona', () => {
    const result = checkPieceAgainstDna('Cualquier cosa', dna(), 7);
    expect(finding(result, 'tone').status).toBe('unknown');
    expect(finding(result, 'identity').status).toBe('unknown');
  });

  it('siempre trae los cinco veredictos, en el mismo orden', () => {
    const result = checkPieceAgainstDna('', dna(), null);
    expect(result.findings.map((f) => f.kind)).toEqual(['wordsNo', 'wordsYes', 'claims', 'tone', 'identity']);
  });
});

describe('los avisos suman palabras y afirmaciones', () => {
  it('cuenta cada palabra distinta y cada afirmación sin respaldo', () => {
    const result = checkPieceAgainstDna(
      'La mejor oferta y barato. 100% natural.',
      dna({ wordsNo: entry(['barato', 'oferta']) }),
      null,
    );
    expect(wordsNoCount(result)).toBe(2);
    expect(finding(result, 'claims').hits).toHaveLength(2);
    expect(result.warnings).toBe(4);
  });
});

describe('highlightSegments', () => {
  it('parte el texto y conserva la suma exacta', () => {
    const segments = highlightSegments('La mejor oferta del año', [{ word: 'oferta', tone: 'blocked' }]);
    expect(segments.map((s) => s.text).join('')).toBe('La mejor oferta del año');
    expect(segments.filter((s) => s.tone).map((s) => s.text)).toEqual(['oferta']);
  });

  it('usa los mismos límites de palabra que el conteo', () => {
    const segments = highlightSegments('baratón barato', [{ word: 'barato', tone: 'blocked' }]);
    expect(segments.filter((s) => s.tone).map((s) => s.text)).toEqual(['barato']);
  });

  it('resalta el plural y respeta el tono de cada grupo', () => {
    const segments = highlightSegments('ofertas para el hogar', [
      { word: 'oferta', tone: 'blocked' },
      { word: 'hogar', tone: 'verified' },
    ]);
    expect(segments.filter((s) => s.tone)).toEqual([
      { text: 'ofertas', tone: 'blocked' },
      { text: 'hogar', tone: 'verified' },
    ]);
  });

  it('sin coincidencias devuelve el texto entero sin tono', () => {
    expect(highlightSegments('nada por acá', [{ word: 'oferta', tone: 'blocked' }]))
      .toEqual([{ text: 'nada por acá', tone: null }]);
  });
});
