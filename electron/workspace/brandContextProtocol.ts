import { BRAND_CONTEXT_INPUT_KEY_SET } from '../../shared/brandContext';
import { canonicalJson, sha256Utf8 } from '../core/canonical';
import { extractFencedBlocks } from '../core/fenced';
import type { BrandContextMode, BrandContextProposalInput } from '../../shared/contracts';
import { ValidationError } from '../core/errors';
import { requireCleanContext, requireRequestId } from '../services/validation';

export const BRAND_CONTEXT_DRAFT_PROMPT_ES =
  'Leé el brief y los documentos de este trabajo. Redactá el contexto de marca (posicionamiento, tono, audiencia y lo que es durable) y proponelo con exactamente un bloque fenced `latte-brand-context` JSON con `text`, `rationale`, `mode` y `clientRequestId`. Si ya hay contexto, usá `mode: "append"` y sumá sólo hechos durables nuevos. Nunca lo escribas vos: Latte se lo muestra al humano para que lo acepte.';

export const BRAND_CONTEXT_DRAFT_PROMPT_EN =
  'Read the brief and the documents of this work. Draft the brand context (positioning, tone, audience and what is durable) and propose it with exactly one fenced `latte-brand-context` JSON block with `text`, `rationale`, `mode` and `clientRequestId`. If context already exists, use `mode: "append"` and add only new durable facts. Never write it yourself: Latte shows it to the human for approval.';

export function brandContextFingerprint(text: string): string {
  return sha256Utf8(canonicalJson(text.normalize('NFC').trim()));
}

export function extractBrandContextBlocks(text: string): string[] {
  return extractFencedBlocks('latte-brand-context', text);
}

/** Throws on unknown keys, bad types, control chars, empty text or oversize fields. */
export function requireBrandContextInput(input: unknown): BrandContextProposalInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid brand context proposal');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !BRAND_CONTEXT_INPUT_KEY_SET.has(key))) throw new ValidationError('Unknown brand context proposal field');
  const text = requireCleanContext(record.text, 'Brand context');
  const rationale = requireCleanContext(record.rationale, 'Rationale', { allowEmpty: true });
  if (record.mode !== 'replace' && record.mode !== 'append') throw new ValidationError('Invalid brand context mode');
  return { text, rationale, mode: record.mode as BrandContextMode, clientRequestId: requireRequestId(record.clientRequestId) };
}

/** Strict parse: invalid JSON or a validator failure is inert. */
export function parseBrandContextJson(raw: string): BrandContextProposalInput | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  try { return requireBrandContextInput(value); } catch { return null; }
}

export function brandContextProtocolBlocks(text: string): BrandContextProposalInput[] {
  const out: BrandContextProposalInput[] = [];
  for (const body of extractBrandContextBlocks(text)) {
    const parsed = parseBrandContextJson(body);
    if (parsed) out.push(parsed);
  }
  return out;
}
