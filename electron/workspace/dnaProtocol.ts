import { extractFencedBlocks } from '../core/fenced';
import { ValidationError } from '../core/errors';
import { requireRequestId } from '../services/validation';
import { BRAND_DNA_FIELDS, type BrandDnaField, type BrandDnaSourceKind } from '../../shared/contracts';
import { requireBrandDnaFieldValue, type BrandDnaValue } from '../branding/dna';

/**
 * 1B: APRENDIZAJE POR BLOQUE DE PROTOCOLO, como decision y brand-context.
 *
 * Cuando la persona corrige la marca ("no digas oferta"), el agente propone el
 * cambio con un bloque fenced `latte-dna` y la persona lo acepta o lo rechaza.
 * La forma se valida SIN PITOS NI FLAUTAS: un campo desconocido, una fuente
 * que no es `correction`/`document` o un valor que no le corresponde al campo
 * hacen que el bloque sea inerte, nunca que pase medio.
 *
 * El input NO es un tipo del contrato: `BrandDnaProposal` (lo que ve la persona)
 * está fijado, y ésta es sólo la forma en que un agente lo pide.
 */
export const DNA_PROTOCOL_LANGUAGE = 'latte-dna';

/** Las únicas dos clases de fuente que un agente puede invocar al proponer. */
export const DNA_PROPOSAL_SOURCE_KINDS: readonly BrandDnaSourceKind[] = ['correction', 'document'];

export interface BrandDnaProposalInput {
  field: BrandDnaField;
  /** El valor que quedaría si se acepta: el valor CRUDO del campo (`BrandDnaValue`), no su entrada. */
  next: BrandDnaValue | null;
  reason: string;
  source: { kind: BrandDnaSourceKind; label: string };
  clientRequestId: string;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function cleanReason(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('DNA proposal reason must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError('DNA proposal reason cannot be empty');
  if (trimmed.length > 600) throw new ValidationError('DNA proposal reason is too long');
  if (CONTROL_CHARS.test(value)) throw new ValidationError('DNA proposal reason contains control characters');
  return trimmed;
}

/** Throws on unknown keys, a field that is not part of the DNA, a bad source or a value that does not fit the field. */
export function requireBrandDnaProposalInput(input: unknown): BrandDnaProposalInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid brand DNA proposal');
  const record = input as Record<string, unknown>;
  const allowed = ['field', 'next', 'reason', 'source', 'clientRequestId'];
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ValidationError(`Unknown brand DNA proposal field: ${unknown.join(', ')}`);
  if (typeof record.field !== 'string' || !(BRAND_DNA_FIELDS as readonly string[]).includes(record.field)) {
    throw new ValidationError('Invalid brand DNA proposal field');
  }
  const field = record.field as BrandDnaField;
  if (!('next' in record)) throw new ValidationError('Brand DNA proposal is missing next');
  const source = record.source && typeof record.source === 'object' && !Array.isArray(record.source)
    ? record.source as Record<string, unknown>
    : null;
  if (!source) throw new ValidationError('Invalid brand DNA proposal source');
  const sourceKeys = Object.keys(source);
  if (sourceKeys.length !== 2 || sourceKeys.some((key) => key !== 'kind' && key !== 'label')) {
    throw new ValidationError('Unknown brand DNA proposal source field');
  }
  if (typeof source.kind !== 'string' || !DNA_PROPOSAL_SOURCE_KINDS.includes(source.kind as BrandDnaSourceKind)) {
    throw new ValidationError('Invalid brand DNA proposal source kind');
  }
  if (typeof source.label !== 'string' || source.label.trim().length === 0 || source.label.length > 200 || CONTROL_CHARS.test(source.label)) {
    throw new ValidationError('Invalid brand DNA proposal source label');
  }
  return {
    field,
    // El valor tiene que ser válido PARA ESE campo: no se propone un texto donde va una paleta.
    next: requireBrandDnaFieldValue(field, record.next),
    reason: cleanReason(record.reason),
    source: { kind: source.kind as BrandDnaSourceKind, label: source.label.trim() },
    clientRequestId: requireRequestId(record.clientRequestId),
  };
}

/** Strict parse: invalid JSON or a validator failure is inert. */
export function parseBrandDnaJson(raw: string): BrandDnaProposalInput | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  try { return requireBrandDnaProposalInput(value); } catch { return null; }
}

export function extractBrandDnaBlocks(text: string): string[] {
  return extractFencedBlocks(DNA_PROTOCOL_LANGUAGE, text);
}

export function brandDnaProtocolBlocks(text: string): BrandDnaProposalInput[] {
  const out: BrandDnaProposalInput[] = [];
  for (const body of extractBrandDnaBlocks(text)) {
    const parsed = parseBrandDnaJson(body);
    if (parsed) out.push(parsed);
  }
  return out;
}
