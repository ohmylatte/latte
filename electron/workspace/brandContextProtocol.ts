import { canonicalJson, sha256Utf8 } from '../core/canonical';
import { extractFencedBlocks } from '../core/fenced';
import type { BrandContextMode, BrandContextProposalInput } from '../../shared/contracts';
import { LIMITS } from '../services/validation';

export const BRAND_CONTEXT_DRAFT_PROMPT_ES =
  'Leé el brief y los documentos de este trabajo. Redactá el contexto de marca (posicionamiento, tono, audiencia y lo que es durable) y proponelo con exactamente un bloque fenced `latte-brand-context` JSON con `text`, `rationale`, `mode` y `clientRequestId`. Si ya hay contexto, usá `mode: "append"` y sumá sólo hechos durables nuevos. Nunca lo escribas vos: Latte se lo muestra al humano para que lo acepte.';

export const BRAND_CONTEXT_DRAFT_PROMPT_EN =
  'Read the brief and the documents of this work. Draft the brand context (positioning, tone, audience and what is durable) and propose it with exactly one fenced `latte-brand-context` JSON block with `text`, `rationale`, `mode` and `clientRequestId`. If context already exists, use `mode: "append"` and add only new durable facts. Never write it yourself: Latte shows it to the human for approval.';

const ALLOWED_KEYS = new Set(['text', 'rationale', 'mode', 'clientRequestId']);
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function brandContextFingerprint(text: string): string {
  return sha256Utf8(canonicalJson(text.normalize('NFC').trim()));
}

export function extractBrandContextBlocks(text: string): string[] {
  return extractFencedBlocks('latte-brand-context', text);
}

/** Strict parse: unknown keys, bad types, control chars and oversize text are inert. */
export function parseBrandContextJson(raw: string): BrandContextProposalInput | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((k) => !ALLOWED_KEYS.has(k))) return null;
  if (typeof record.text !== 'string' || typeof record.rationale !== 'string' || typeof record.mode !== 'string' || typeof record.clientRequestId !== 'string') return null;
  if (record.mode !== 'replace' && record.mode !== 'append') return null;
  if (record.text.length > LIMITS.context || record.rationale.length > LIMITS.context) return null;
  if (CONTROL_CHARS.test(record.text) || CONTROL_CHARS.test(record.rationale)) return null;
  return {
    text: record.text,
    rationale: record.rationale,
    mode: record.mode as BrandContextMode,
    clientRequestId: record.clientRequestId,
  };
}

export function brandContextProtocolBlocks(text: string): BrandContextProposalInput[] {
  const out: BrandContextProposalInput[] = [];
  for (const body of extractBrandContextBlocks(text)) {
    const parsed = parseBrandContextJson(body);
    if (parsed) out.push(parsed);
  }
  return out;
}
