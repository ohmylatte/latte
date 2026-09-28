import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Utf8 } from '../core/canonical';
import { ValidationError } from '../core/errors';
import { IDENTITY_DIR } from './identity';
import {
  BRAND_DNA_FIELDS,
  type BrandDnaBuildMode,
  type BrandDnaEntry,
  type BrandDnaField,
  type BrandDnaFields,
  type BrandDnaIdea,
  type BrandDnaSourceKind,
} from '../../shared/contracts';

/**
 * 1B: EL ADN DE MARCA COMO MOTOR, NO COMO FORMULARIO.
 *
 * Acá vive lo que es puro manejo de datos y de archivos:
 *  - la forma EXACTA de cada campo, validada sin pitos ni flautas: lo que el
 *    agente escribe en `ADN.json` entra sólo si es la forma del contrato;
 *  - la huella con la que se compara un borrador contra una versión;
 *  - `identidad/ADN.md`, el archivo legible por agentes que Latte proyecta en
 *    cada trabajo cuando hay una versión aprobada (mismo camino que
 *    `IDENTIDAD.md`, distinto archivo: el kit y el ADN son cosas distintas);
 *  - el pedido que le entrega el equipo para que componga.
 *
 * Regla de oro: cada dato dice de dónde salió; lo inferido sin fuente firme es
 * `assumption: true`. Nunca se inventa un dato.
 */

/** Carpeta de trabajo donde viven las fuentes de un build y su resultado. */
export const DNA_DRAFT_DIR = 'adn';
/** Lo que el agente tiene que escribir, con la forma exacta de `BrandDnaFields`. */
export const DNA_JSON = 'ADN.json';
/** El reporte de pasos del agente: qué fuente pudo leer y cuál no. */
export const DNA_STEPS_JSON = 'pasos.json';
/** El archivo legible que viaja a `identidad/` de cada trabajo. */
export const DNA_MD = 'ADN.md';
/** Rutas relativas al trabajo, tal como las reporta el agente. */
export const DNA_JSON_RELATIVE = `borradores/${DNA_DRAFT_DIR}/${DNA_JSON}`;
export const DNA_STEPS_RELATIVE = `borradores/${DNA_DRAFT_DIR}/${DNA_STEPS_JSON}`;
/** 3: las ideas para empezar, con la misma vara estricta que el ADN. */
export const DNA_IDEAS_JSON = 'IDEAS.json';
export const DNA_IDEAS_RELATIVE = `borradores/${DNA_DRAFT_DIR}/${DNA_IDEAS_JSON}`;
/** Vigentes: el máximo que guarda Latte por marca. */
export const MAX_DNA_IDEAS = 4;
/** Los pasos que sólo el agente puede resolver (el resto los junta Latte). */
export const DNA_AGENT_STEP_KEYS = ['web', 'instagram'] as const;
export type DnaAgentStepKey = (typeof DNA_AGENT_STEP_KEYS)[number];

/** Las fuentes que el contrato acepta. Un `kind` fuera de esta lista es inválido. */
export const BRAND_DNA_SOURCE_KINDS: readonly BrandDnaSourceKind[] = [
  'web', 'instagram', 'file', 'context', 'document', 'decision', 'memory', 'identity', 'correction', 'human', 'calendar',
];

/** Tab control: todo lo que no sea tab, salto de línea o retorno. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function cleanText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${name} cannot be empty`);
  if (trimmed.length > max) throw new ValidationError(`${name} is too long (max ${max} characters)`);
  if (CONTROL_CHARS.test(value)) throw new ValidationError(`${name} contains control characters`);
  return trimmed;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return cleanText(value, name, max);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new ValidationError(`${name} has unknown fields: ${unknown.join(', ')}`);
  const missing = keys.filter((key) => !(key in record));
  if (missing.length > 0) throw new ValidationError(`${name} is missing fields: ${missing.join(', ')}`);
}

function textList(value: unknown, name: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array`);
  if (value.length > maxItems) throw new ValidationError(`${name} has too many items (max ${maxItems})`);
  return value.map((item, index) => cleanText(item, `${name}[${index}]`, maxChars));
}

function nullableTextList(value: unknown, name: string, maxItems: number, maxChars: number): string[] | null {
  if (value === null || value === undefined) return null;
  return textList(value, name, maxItems, maxChars);
}

/**
 * El valor CRUDO de cualquier campo (no la entrada con su procedencia): lo
 * que un `next` de propuesta guarda y lo que la persona edita. El contrato
 * tipa `next`/`value` como la unión de entradas; ésta es la unión de VALORES
 * que el motor valida y persiste, y en la frontera del contrato se castea.
 */
export type { BrandDnaValue } from '../../shared/contracts';
import type { BrandDnaValue } from '../../shared/contracts';

/** La forma de UN campo, sin conocer el resto. `null` sigue siendo válido: "todavía no se sabe". */
export function requireBrandDnaFieldValue(field: BrandDnaField, value: unknown): BrandDnaValue | null {
  switch (field) {
    case 'tone': {
      if (value === null || value === undefined) return null;
      const record = requireObject(value, 'tone');
      requireKeys(record, ['adjectives', 'example'], 'tone');
      return {
        adjectives: textList(record.adjectives, 'tone.adjectives', 12, 60),
        example: optionalText(record.example, 'tone.example', 400),
      };
    }
    case 'audience':
      return (value === null || value === undefined) ? null : cleanText(value, 'audience', 2_000);
    case 'valueProp':
      return (value === null || value === undefined) ? null : cleanText(value, 'valueProp', 2_000);
    case 'wordsYes':
      return nullableTextList(value, 'wordsYes', 80, 80);
    case 'wordsNo':
      return nullableTextList(value, 'wordsNo', 80, 80);
    case 'claims':
      return nullableTextList(value, 'claims', 40, 400);
    case 'colors': {
      if (value === null || value === undefined) return null;
      if (!Array.isArray(value)) throw new ValidationError('colors must be an array');
      if (value.length > 32) throw new ValidationError('colors has too many items (max 32)');
      return value.map((item, index) => {
        const record = requireObject(item, `colors[${index}]`);
        requireKeys(record, ['hex', 'name'], `colors[${index}]`);
        if (typeof record.hex !== 'string' || !HEX_COLOR.test(record.hex)) {
          throw new ValidationError(`colors[${index}].hex must be #rrggbb`);
        }
        return { hex: record.hex, name: optionalText(record.name, `colors[${index}].name`, 60) };
      });
    }
    case 'fonts':
      return nullableTextList(value, 'fonts', 12, 120);
    default:
      throw new ValidationError(`Unknown brand DNA field: ${String(field)}`);
  }
}

export function emptyBrandDnaFields(): BrandDnaFields {
  return { tone: null, audience: null, valueProp: null, wordsYes: null, wordsNo: null, claims: null, colors: null, fonts: null };
}

/**
 * La forma EXACTA de `BrandDnaFields`, para el `ADN.json` que escribe el
 * agente. Ocho claves, ni una más; cada una `null` o una entrada con su
 * procedencia y su supuesto. Cualquier desvío es un `ValidationError`: el
 * archivo no entra ni a medias.
 */
export function requireBrandDnaFields(raw: unknown): BrandDnaFields {
  const record = requireObject(raw, 'ADN.json');
  requireKeys(record, BRAND_DNA_FIELDS, 'ADN.json');
  const out = emptyBrandDnaFields();
  for (const field of BRAND_DNA_FIELDS) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    const entry = requireObject(value, field);
    requireKeys(entry, ['value', 'sources', 'assumption'], field);
    if (!('value' in entry)) throw new ValidationError(`${field} is missing value`);
    if (entry.value === null || entry.value === undefined) throw new ValidationError(`${field}.value is null: use null for the whole field instead`);
    if (typeof entry.assumption !== 'boolean') throw new ValidationError(`${field}.assumption must be a boolean`);
    if (!Array.isArray(entry.sources) || entry.sources.length === 0 || entry.sources.length > 16) {
      throw new ValidationError(`${field}.sources must be a non-empty array`);
    }
    const sources = entry.sources.map((source, index) => {
      const item = requireObject(source, `${field}.sources[${index}]`);
      requireKeys(item, ['kind', 'label'], `${field}.sources[${index}]`);
      if (typeof item.kind !== 'string' || !BRAND_DNA_SOURCE_KINDS.includes(item.kind as BrandDnaSourceKind)) {
        throw new ValidationError(`${field}.sources[${index}].kind is not a brand DNA source`);
      }
      return { kind: item.kind as BrandDnaSourceKind, label: cleanText(item.label, `${field}.sources[${index}].label`, 200) };
    });
    const fieldValue = requireBrandDnaFieldValue(field, entry.value);
    if (fieldValue === null) throw new ValidationError(`${field}.value validated to null: use null for the whole field instead`);
    // Escritura por clave genérica: el tipo del contrato es una unión y sólo
    // acepta la intersección; el validador ya probó que el valor le corresponde.
    (out as unknown as Record<string, unknown>)[field] = { value: fieldValue, sources, assumption: entry.assumption };
  }
  return out;
}

/** Mismo algoritmo que el resto de Latte: huella canónica, un solo criterio. */
export function brandDnaFingerprint(fields: BrandDnaFields): string {
  return sha256Utf8(canonicalJson(fields));
}

export function brandDnaIsEmpty(fields: BrandDnaFields | null | undefined): boolean {
  if (!fields) return true;
  return BRAND_DNA_FIELDS.every((field) => fields[field] === null);
}

/** Texto de una sola línea: título y motivo de una idea no pueden saltar de renglón. */
function cleanLine(value: unknown, name: string, max: number): string {
  const text = cleanText(value, name, max);
  if (/[\r\n]/.test(text)) throw new ValidationError(`${name} cannot span lines`);
  return text;
}

const IDEA_DATE = /^\d{4}-\d{2}-\d{2}([T][0-9:.+-]{0,40}Z?)?$/;
const IDEA_WORK_TYPE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * 3: la forma EXACTA del `IDEAS.json`, con la misma vara que `ADN.json`.
 * Cuatro como máximo, `workTypeId` con forma de id del catálogo, fechas con
 * forma de fecha, y `basedOn` SIN VACÍO: una idea sin base no se guarda.
 */
export function requireBrandDnaIdeas(raw: unknown): BrandDnaIdea[] {
  const record = requireObject(raw, 'IDEAS.json');
  requireKeys(record, ['ideas'], 'IDEAS.json');
  if (!Array.isArray(record.ideas)) throw new ValidationError('IDEAS.json ideas must be an array');
  if (record.ideas.length > MAX_DNA_IDEAS) throw new ValidationError(`IDEAS.json has too many ideas (max ${MAX_DNA_IDEAS})`);
  const seen = new Set<string>();
  return record.ideas.map((value, index) => {
    const idea = requireObject(value, `ideas[${index}]`);
    requireKeys(idea, ['id', 'title', 'why', 'workTypeId', 'basedOn', 'createdAt'], `ideas[${index}]`);
    const id = cleanLine(idea.id, `ideas[${index}].id`, 64);
    if (seen.has(id)) throw new ValidationError(`IDEAS.json has a duplicate idea id: ${id}`);
    seen.add(id);
    const workTypeId = cleanText(idea.workTypeId, `ideas[${index}].workTypeId`, 64);
    if (!IDEA_WORK_TYPE.test(workTypeId)) throw new ValidationError(`ideas[${index}].workTypeId must look like a catalog id`);
    if (!Array.isArray(idea.basedOn) || idea.basedOn.length === 0 || idea.basedOn.length > 6) {
      throw new ValidationError(`ideas[${index}].basedOn must name at least one base`);
    }
    const basedOn = idea.basedOn.map((source, position) => {
      const item = requireObject(source, `ideas[${index}].basedOn[${position}]`);
      requireKeys(item, ['kind', 'label'], `ideas[${index}].basedOn[${position}]`);
      if (typeof item.kind !== 'string' || !BRAND_DNA_SOURCE_KINDS.includes(item.kind as BrandDnaSourceKind)) {
        throw new ValidationError(`ideas[${index}].basedOn[${position}].kind is not a brand DNA source`);
      }
      return { kind: item.kind as BrandDnaSourceKind, label: cleanText(item.label, `ideas[${index}].basedOn[${position}].label`, 200) };
    });
    const createdAt = cleanText(idea.createdAt, `ideas[${index}].createdAt`, 40);
    if (!IDEA_DATE.test(createdAt)) throw new ValidationError(`ideas[${index}].createdAt must be a date (YYYY-MM-DD)`);
    return {
      id,
      title: cleanLine(idea.title, `ideas[${index}].title`, 160),
      why: cleanLine(idea.why, `ideas[${index}].why`, 240),
      workTypeId,
      basedOn,
      createdAt,
    };
  });
}

/** El archivo que el agente escribe con sus pasos. Inválido = inerte: el ADN no se pierde por el reporte. */
export type DnaStepReport = Partial<Record<DnaAgentStepKey, { state: 'done' | 'failed' | 'skipped'; detail: string }>>;

export function parseDnaStepReport(raw: string | null | undefined): DnaStepReport {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: DnaStepReport = {};
  for (const key of DNA_AGENT_STEP_KEYS) {
    const entry = record[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (item.state !== 'done' && item.state !== 'failed' && item.state !== 'skipped') continue;
    try {
      out[key] = { state: item.state, detail: cleanText(item.detail, `pasos.${key}.detail`, 300) };
    } catch { /* un detalle ilegible no invalida el resto del reporte */ }
  }
  return out;
}

export interface BrandDnaProjection {
  brandName: string;
  version: number;
  approvedAt: string;
  fields: BrandDnaFields;
}

function sourcesLine(entry: BrandDnaEntry<unknown> | null): string {
  if (!entry) return '';
  const labels = entry.sources.map((source) => source.label).join(' · ');
  return `- Sources: ${labels} (assumption: ${entry.assumption ? 'yes' : 'no'})`;
}

function section<T>(title: string, entry: BrandDnaEntry<T> | null, render: (value: T) => string): string {
  if (!entry) return `## ${title}\n\n_Not set._\n`;
  return `## ${title}\n\n${render(entry.value)}\n\n${sourcesLine(entry)}\n`;
}

/**
 * El ADN en markdown, con la versión cuando hay. El mismo texto que proyecta
 * `identidad/ADN.md` y el que Latte junta en las fuentes de un build de
 * ideas: una sola render, dos destinos.
 */
export function renderBrandDnaMarkdown(input: { brandName: string; version: number | null; approvedAt: string | null; fields: BrandDnaFields }): string {
  const header = input.version === null || input.approvedAt === null
    ? `# Brand DNA — ${input.brandName} (draft, not approved yet)`
    : `# Brand DNA — ${input.brandName} (version ${input.version}, approved ${input.approvedAt.slice(0, 10)})`;
  const parts = [
    header,
    '',
    'Structured brand identity, maintained by Latte. Do not edit this file.',
    'Every value says where it came from: the line under each section lists its sources, and `assumption: yes` means the value was inferred without a firm source — treat it as unconfirmed.',
    '',
    section('Tone', input.fields.tone, (value) => [
      `- Adjectives: ${value.adjectives.join(', ')}`,
      ...(value.example ? [`- Example: ${value.example}`] : []),
    ].join('\n')),
    section('Audience', input.fields.audience, (value) => `- ${value}`),
    section('Value proposition', input.fields.valueProp, (value) => `- ${value}`),
    section('Words the brand uses', input.fields.wordsYes, (value) => value.map((word) => `- ${word}`).join('\n')),
    section('Words the brand never uses', input.fields.wordsNo, (value) => value.map((word) => `- ${word}`).join('\n')),
    section('Claims the brand can make', input.fields.claims, (value) => value.map((claim) => `- ${claim}`).join('\n')),
    section('Colours', input.fields.colors, (value) => value.map((color) => `- \`${color.hex}\`${color.name ? ` — ${color.name}` : ''}`).join('\n')),
    section('Fonts', input.fields.fonts, (value) => value.map((font) => `- ${font}`).join('\n')),
  ];
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * `identidad/ADN.md`: lo que un agente lee para saber quién es la marca, con
 * la versión y la procedencia de cada dato. `null` lo saca (no hay versión
 * aprobada). Idempotente: escribirlo dos veces deja el mismo archivo.
 */
export function projectBrandDna(workDir: string, dna: BrandDnaProjection | null): boolean {
  const file = path.join(workDir, IDENTITY_DIR, DNA_MD);
  if (!dna) {
    fs.rmSync(file, { force: true });
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderBrandDnaMarkdown(dna), 'utf8');
  return true;
}

export interface DnaBuildSpecInput {
  /** La tarea lo lleva marcada: así Latte encuentra SU trabajo cuando la propuesta se aprueba. */
  jobId: string;
  brandName: string;
  mode: BrandDnaBuildMode;
  url: string | null;
  instagram: string | null;
  /** Rutas relativas al trabajo que Latte ya dejó en `borradores/adn/fuentes/`. */
  prepared: readonly string[];
  /** El idioma del contenido del trabajo: el ADN se escribe en ése, porque el chequeo de marca compara palabras literales. */
  language: 'es-AR' | 'en-US';
  /** Hoy (`YYYY-MM-DD`), para que `createdAt` de las ideas no dependa del reloj del agente. */
  today?: string;
}

/** El bloque de las ideas, igual para un build normal y para el modo `ideas`. */
function ideasInstructions(language: 'es-AR' | 'en-US', today?: string): string[] {
  const lang = language === 'en-US' ? 'English (United States)' : 'Spanish (Argentina)';
  return [
    '',
    `Also write ./${DNA_IDEAS_RELATIVE}: up to FOUR concrete ideas for this brand RIGHT NOW — {"ideas": [{"id": "...", "title": "...", "why": "...", "workTypeId": "...", "basedOn": [{"kind": "...", "label": "..."}], "createdAt": "YYYY-MM-DD"}]}.`,
    '- An idea is something to DO next with what the sources support: a campaign for the collection that just arrived, a review of pieces that break the DNA, a calendar for the closest commercial date. Short actionable title, one-line why, and NEVER an idea without a base: `basedOn` names where it came from (kind: web, instagram, file, context, document, decision, memory, identity, correction, human, calendar; label is what a person sees).',
    '- `workTypeId` is one of: campaign-new, strategy, content-calendar, copy-pieces, adapt-pieces, presentation, campaign-ops, campaign-optimize, budget-review, paid-media-audit, period-compare, report-build, free-form.',
    `- Write the ideas in ${lang}: the language this brand's content is written in. ${today ? `\`createdAt\` is ${today}.` : '`createdAt` is today\'s date.'}`,
  ];
}

/**
 * El pedido al equipo, en inglés como todo lo que Latte le dice a un agente.
 * El resultado es `ADN.json` con la forma exacta del contrato, validada por
 * Latte antes de tocar el borrador — y, si el agente puede, `IDEAS.json`.
 */
export function dnaBuildSpec(input: DnaBuildSpecInput): string {
  const lines = [
    `Task: compose the structured brand DNA of ${input.brandName} into ./${DNA_JSON_RELATIVE}.`,
    '',
    input.prepared.length > 0
      ? `Sources Latte prepared in this work: ${input.prepared.map((file) => `./${file}`).join(', ')}. Read every one you can.`
      : 'Latte prepared no source files for this build: read the sources named below.',
  ];
  if (input.mode === 'existing') {
    lines.push('This build runs from what the brand already has: its context, approved documents, recorded decisions, memory and identity. Do not research the web for this one.');
  }
  if (input.url) {
    lines.push(`Fetch ${input.url} (home, about, product pages) and read what the brand says about itself: audience, offer, tone, words it uses and forbids, colours, type.`);
  }
  if (input.instagram) {
    lines.push(`Read the PUBLIC profile ${input.instagram} (bio and public posts). If you cannot — login wall, no tool, rate limit — do not guess: leave that source out and mark the instagram step failed in ./${DNA_STEPS_RELATIVE} with that detail.`);
  }
  lines.push(
    '',
    `Write ./${DNA_JSON_RELATIVE} with EXACTLY these eight keys: ${BRAND_DNA_FIELDS.join(', ')}. Every key is either null or an object {"value": ..., "sources": [{"kind": "...", "label": "..."}], "assumption": true|false}.`,
    '- `sources` says where the value came from. `kind` is one of: web, instagram, file, context, document, decision, memory, identity, correction, human. `label` is what a person sees: "web · home", "manual.pdf p.2", "decisión del 12 sep".',
    '- `assumption` is true ONLY when you inferred the value without a firm source. Never invent a datum: leave the key null when the sources do not support it.',
    '- Shapes: tone is {"adjectives": [...], "example": ...}; colours are {"hex": "#rrggbb", "name": ...}; audience, valueProp are strings; wordsYes, wordsNo, claims, fonts are arrays of strings.',
    '- In `wordsNo` only what the brand explicitly avoids; in `claims` only what the sources back.',
    `- Write every human-readable value (tone adjectives and example, audience, valueProp, wordsYes, wordsNo, claims, font names as written, source labels) in ${input.language === 'en-US' ? 'English (United States)' : 'Spanish (Argentina)'}, the language this brand's content is written in. Words in wordsYes/wordsNo are the literal words as they appear in that language: Latte matches them word by word. Keep JSON keys and \`kind\` values exactly as specified.`,
    ...ideasInstructions(input.language, input.today),
    '',
    `Also write ./${DNA_STEPS_RELATIVE} reporting every source step you attempted: {"web": {"state": "done|failed|skipped", "detail": "..."}, "instagram": {...}}. A step you could not read is "failed" with the reason; saying so is the point — guessing is not.`,
    '',
    `Report with latte_report and files ["${DNA_JSON_RELATIVE}", "${DNA_STEPS_RELATIVE}", "${DNA_IDEAS_RELATIVE}"]. Latte validates ADN.json strictly and saves it as the draft the person reviews; a file that does not match this shape is rejected. An IDEAS.json that does not match is ignored (the DNA still stands).`,
    '',
    `Latte bookkeeping: build job ${input.jobId}.`,
  );
  return lines.join('\n');
}

export interface DnaIdeasSpecInput {
  jobId: string;
  brandName: string;
  /** Rutas relativas al trabajo que Latte ya dejó en `borradores/adn/fuentes/`. */
  prepared: readonly string[];
  language: 'es-AR' | 'en-US';
  /** Hoy (`YYYY-MM-DD`). */
  today: string;
}

/**
 * 3: la tarea LIVIANA de ideas — sólo se componen ideas, con los insumos que
 * Latte juntó. No toca el borrador del ADN.
 */
export function dnaIdeasSpec(input: DnaIdeasSpecInput): string {
  return [
    `Task: propose up to FOUR concrete ideas for ${input.brandName} right now, into ./${DNA_IDEAS_RELATIVE}.`,
    '',
    input.prepared.length > 0
      ? `Latte prepared your inputs in this work: ${input.prepared.map((file) => `./${file}`).join(', ')}. Read every one: adn.md is the brand DNA (approved or draft), fecha.md is today with the country and season, trabajos.md lists recent works, embudo.md says which funnel stages still have no pieces, and fechas-comerciales.md has the exact dates of the next 6 weeks.`
      : 'Latte prepared no input files: ground the ideas only in what you can verify from the brand context of this work.',
    ...ideasInstructions(input.language, input.today),
    '',
    `Report with latte_report and files ["${DNA_IDEAS_RELATIVE}"]. Latte validates IDEAS.json strictly: an idea with no base or a file that does not match this shape is rejected.`,
    '',
    `Latte bookkeeping: build job ${input.jobId}.`,
  ].join('\n');
}
