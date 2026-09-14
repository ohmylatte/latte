import { createHash } from 'node:crypto';
import { HEX_SHA256 } from '../../shared/generationContracts';

/** Deterministic JSON: sorted object keys, no `undefined`, NFC strings. */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value);
}

function writeCanonical(value: unknown): string {
  if (value === undefined) throw new Error('undefined is not canonical');
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (kind === 'string') return JSON.stringify((value as string).normalize('NFC'));
  if (Array.isArray(value)) return `[${value.map(writeCanonical).join(',')}]`;
  if (kind === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k.normalize('NFC'))}:${writeCanonical(v)}`).join(',')}}`;
  }
  throw new Error(`unsupported type ${kind}`);
}

export function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isHexSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256.test(value);
}
