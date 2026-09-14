import { randomBytes } from 'node:crypto';
import { ID_PATTERN } from '../core/ids';

/** Own namespace, distinct from shipped skill ids and from brd_/wrk_/doc_. */
export type LearningIdPrefix = 'lsk' | 'lcd' | 'ljb' | 'lrs' | 'lau' | 'lld';

export function newLearningId(prefix: LearningIdPrefix): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function isLearningId(value: unknown, prefix?: LearningIdPrefix): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  if (!prefix) return /^(lsk|lcd|ljb|lrs|lau|lld)_/.test(value);
  return value.startsWith(`${prefix}_`);
}

export function brandScopeKey(brandId: string): string {
  return `brand:${brandId}`;
}

export function parseScopeKey(scopeKey: string): { kind: 'brand'; brandId: string } | { kind: 'agency' } | null {
  if (scopeKey === 'agency:local') return { kind: 'agency' };
  if (scopeKey.startsWith('brand:')) {
    const brandId = scopeKey.slice('brand:'.length);
    if (ID_PATTERN.test(brandId)) return { kind: 'brand', brandId };
  }
  return null;
}
