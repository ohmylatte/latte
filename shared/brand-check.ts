import type {
  BrandCheckFinding,
  BrandCheckResult,
  BrandDnaEntry,
  BrandDnaFields,
} from './contracts';

/**
 * ADN DE MARCA · CHEQUEO DE MARCA (Latte 2.0).
 *
 * Puro, sin IA y determinístico: la misma pieza contra el mismo ADN da siempre
 * el mismo resultado, y CADA veredicto sale de una regla que se puede explicar
 * en una frase. Lo que acá queda `unknown` lo cierra la persona (el revisor):
 * el chequeo empuja a mirar, no decide por la pieza.
 *
 * Tres reglas y nada más:
 *  1. `wordsNo`: cada palabra del ADN, como palabra completa, sin distinguir
 *     mayúsculas ni tildes y con el plural simple (oferta/ofertas). Una palabra
 *     DENTRO de otra no cuenta: "baratón" no es "barato".
 *  2. `wordsYes`: informativo. Si aparece alguna, `ok`; si no aparece ninguna,
 *     `unknown`. Nunca un `warn` por no usarlas.
 *  3. `claims`: una frase con número, porcentaje o superlativo que la marca NO
 *     tiene registrada es `warn`. Un número suelto, sin nada que lo vuelva una
 *     promesa ("3 pasos"), es `unknown`: ante la duda no se acusa.
 */

/** Tildes y diéresis a su vocal; la ñ se queda entera: "año" no es "ano". */
const ACCENT_FOLDS: Array<[RegExp, string]> = [
  [/[áàäâã]/g, 'a'],
  [/[éèëê]/g, 'e'],
  [/[íìïî]/g, 'i'],
  [/[óòöôõ]/g, 'o'],
  [/[úùüû]/g, 'u'],
  [/[ýÿ]/g, 'y'],
];

/** Minúsculas y sin tildes, idempotente: se aplica a la pieza y a la palabra del ADN. */
export function foldText(value: string): string {
  let out = value.normalize('NFC').toLowerCase();
  for (const [pattern, to] of ACCENT_FOLDS) out = out.replace(pattern, to);
  return out;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Ocurrencias de `needle` en `hay` (ambos plegados) que son PALABRA COMPLETA. */
function wholeWordRanges(hay: string, needle: string): Array<[number, number]> {
  if (!needle) return [];
  const found: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    if (!isWordChar(hay[at - 1]) && !isWordChar(hay[end])) found.push([at, end]);
    from = at + 1;
  }
  return found;
}

function containsPhrase(hay: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(phrase, from);
    if (at < 0) return false;
    if (!isWordChar(hay[at - 1]) && !isWordChar(hay[at + phrase.length])) return true;
    from = at + 1;
  }
}

/** La palabra del ADN con su plural simple, en las dos direcciones, ya plegada. */
function pluralVariants(word: string): string[] {
  const base = foldText(word).trim();
  if (!base) return [];
  const out = [base];
  if (/[sxzç]$/.test(base)) out.push(`${base}es`);
  else if (!/s$/.test(base)) out.push(`${base}s`);
  // El ADN también puede guardar la palabra ya en plural: "ofertas" tiene que
  // encontrar "oferta". Corto de más no se recorta ("sin" no es "si").
  if (base.length > 3 && /s$/.test(base)) out.push(base.slice(0, -1));
  return out;
}

function wordsOf(entry: BrandDnaEntry<string[]> | null): string[] {
  return (entry?.value ?? []).map((word) => String(word ?? '').trim()).filter(Boolean);
}

/** Una frase corta para listar en el detalle y en el diálogo de aprobación. */
function snippet(value: string, max = 60): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

interface WordsCheck {
  hits: { word: string; count: number }[];
}

/**
 * Cuenta cada palabra del ADN (y su plural) como palabra completa, sin contar
 * dos veces el mismo lugar del texto aunque el ADN la liste de las dos formas.
 */
function countWords(foldedText: string, words: string[]): WordsCheck {
  const hits: { word: string; count: number }[] = [];
  const taken = new Set<string>();
  for (const word of words) {
    let count = 0;
    for (const variant of pluralVariants(word)) {
      for (const [start, end] of wholeWordRanges(foldedText, variant)) {
        const key = `${start}:${end}`;
        if (taken.has(key)) continue;
        taken.add(key);
        count += 1;
      }
    }
    if (count > 0) hits.push({ word, count });
  }
  return { hits };
}

/** Superlativos y promesas: la marca las afirma, tiene que tenerlas registradas. */
const SUPERLATIVES = [
  'mejor', 'mejores', 'peor', 'peores',
  'unico', 'unica', 'unicos', 'unicas',
  'primero', 'primera', 'lider',
  'el mas', 'la mas', 'los mas', 'las mas',
  'el menos', 'la menos',
  '#1', 'best', 'the only',
];

/** Lo que vuelve a un número una promesa y no un dato de la receta. */
const PROMO_CUES = [
  'mas de', 'hasta', 'en tan solo', 'solo', 'gratis',
  'clientes', 'usuarios', 'personas', 'veces',
  'dias', 'horas', 'garantia', 'satisfaccion', 'recomienda',
];

interface ClaimCandidate {
  sentence: string;
  strong: boolean;
  tokens: string[];
}

/**
 * Frases con cara de afirmación. Se limpia lo que nunca es una promesa: URLs,
 * código entre acentos y años (2026 no es un reclamo).
 */
function claimCandidates(text: string): ClaimCandidate[] {
  const clean = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const candidates: ClaimCandidate[] = [];
  for (const sentence of clean.normalize('NFC').split(/[.!?\n;]+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const folded = foldText(trimmed).replace(/\b(?:19|20)\d{2}\b/g, ' ');
    const tokens: string[] = [];
    let strong = false;

    const pct = /(\d+)\s*(?:%|por ciento)/.exec(folded);
    if (pct) { strong = true; tokens.push(`${pct[1]}%`); }

    const superlative = SUPERLATIVES.find((word) => containsPhrase(folded, word));
    if (superlative) { strong = true; tokens.push(superlative); }

    const numbers = folded.match(/\d+/g) ?? [];
    if (numbers.length > 0) {
      const cue = PROMO_CUES.find((word) => containsPhrase(folded, word));
      if (cue) { strong = true; tokens.push(...numbers); }
      else if (!strong) tokens.push(...numbers);
    }

    if (!strong && numbers.length === 0) continue;
    candidates.push({ sentence: trimmed, strong, tokens });
  }
  return candidates;
}

/**
 * Respaldada: la afirmación registrada contiene la frase entera, o la frase
 * contiene la registrada, o comparte el mismo número/superlativo.
 */
function isBacked(candidate: ClaimCandidate, claims: string[]): boolean {
  const sentence = foldText(candidate.sentence);
  for (const raw of claims) {
    const claim = foldText(String(raw ?? '').trim());
    if (!claim) continue;
    if (claim.includes(sentence) || sentence.includes(claim)) return true;
    if (candidate.tokens.some((token) => token && claim.includes(token))) return true;
  }
  return false;
}

function claimsCheck(text: string, entry: BrandDnaEntry<string[]> | null): BrandCheckFinding {
  const claims = wordsOf(entry);
  const unbacked = claimCandidates(text).filter((candidate) => !isBacked(candidate, claims));
  const warns = unbacked.filter((candidate) => candidate.strong);
  const doubts = unbacked.filter((candidate) => !candidate.strong);
  return {
    kind: 'claims',
    status: warns.length > 0 ? 'warn' : doubts.length > 0 ? 'unknown' : 'ok',
    // Sólo las afirmaciones SIN respaldo viajan como `hits`: son las que el
    // diálogo de aprobación lista. Las dudas no acusan a nadie.
    hits: warns.map((candidate) => ({ word: snippet(candidate.sentence), count: 1 })),
  };
}

/**
 * El chequeo de una pieza contra el ADN aprobado de su marca.
 *
 * `dnaVersion` viaja en el resultado para que la persona sepa contra qué
 * versión de la marca se miró la pieza, y `warnings` cuenta AVISOS —una
 * palabra distinta de `wordsNo`, una afirmación sin respaldo— no ocurrencias:
 * "oferta" dos veces es un aviso con un conteo de dos.
 */
export function checkPieceAgainstDna(
  text: string,
  dna: BrandDnaFields,
  dnaVersion: number | null,
): BrandCheckResult {
  const source = typeof text === 'string' ? text : '';
  const foldedText = foldText(source);

  const noWords = countWords(foldedText, wordsOf(dna.wordsNo));
  const yesWords = countWords(foldedText, wordsOf(dna.wordsYes));
  const claims = claimsCheck(source, dna.claims);

  const findings: BrandCheckFinding[] = [
    { kind: 'wordsNo', status: noWords.hits.length > 0 ? 'warn' : 'ok', hits: noWords.hits },
    { kind: 'wordsYes', status: yesWords.hits.length > 0 ? 'ok' : 'unknown', hits: yesWords.hits },
    claims,
    // El tono y la identidad los verifica el revisor: el único veredicto del
    // revisor que existe vive en el motor (`coordination_review:*`, en los meta
    // de la tarea) y no llega al renderer para esta pieza, así que queda en
    // duda en lugar de adivinarse.
    { kind: 'tone', status: 'unknown' },
    { kind: 'identity', status: 'unknown' },
  ];

  const warnings = noWords.hits.length + (claims.hits?.length ?? 0);
  return { dnaVersion, findings, warnings };
}

export interface HighlightWord {
  word: string;
  /** Token de color: `--state-error-*` / `--state-verified-*`, nunca un color suelto. */
  tone: string;
}

export interface HighlightSegment {
  text: string;
  tone: string | null;
}

/**
 * Parte el texto para resaltar lo que el chequeo encontró, con los MISMOS
 * límites de palabra que el conteo: lo resaltado es lo que se cuenta.
 *
 * Devuelve segmentos cuya concatenación es el texto (en NFC, que se ve igual):
 * el renderer los envuelve en `<mark>` y nada del texto se pierde.
 */
export function highlightSegments(text: string, words: readonly HighlightWord[]): HighlightSegment[] {
  const normalized = typeof text === 'string' ? text.normalize('NFC') : '';
  const folded = foldText(normalized);
  const wanted = words.filter((entry) => entry && foldText(entry.word).trim());
  if (folded.length !== normalized.length || wanted.length === 0) {
    return [{ text: normalized, tone: null }];
  }

  const marks: Array<[number, number, string]> = [];
  for (const entry of wanted) {
    const tone = entry.tone || 'hit';
    for (const variant of pluralVariants(entry.word)) {
      for (const [start, end] of wholeWordRanges(folded, variant)) marks.push([start, end, tone]);
    }
  }
  if (marks.length === 0) return [{ text: normalized, tone: null }];

  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number, string]> = [];
  for (const [start, end, tone] of marks) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) { if (end > last[1]) last[1] = end; continue; }
    merged.push([start, end, tone]);
  }

  const segments: HighlightSegment[] = [];
  let at = 0;
  for (const [start, end, tone] of merged) {
    if (start > at) segments.push({ text: normalized.slice(at, start), tone: null });
    segments.push({ text: normalized.slice(start, end), tone });
    at = end;
  }
  if (at < normalized.length) segments.push({ text: normalized.slice(at), tone: null });
  return segments;
}
