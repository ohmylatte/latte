import { createHash } from 'node:crypto';
import { PATTERN_ALGO, type HexSha256 } from './types';

export function sha256Utf8(value: string): HexSha256 {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical bytes of a validated package. Key order is part of the contract. */
export function canonicalSkillJson(input: { name: string; description: string; markdown: string }): string {
  return JSON.stringify({
    description: input.description,
    markdown: input.markdown,
    name: input.name,
  });
}

export function skillContentHash(input: { name: string; description: string; markdown: string }): HexSha256 {
  return sha256Utf8(canonicalSkillJson(input));
}

export function patternKey(scopeKey: string, name: string, markdown: string): string {
  const nameN = name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
  const bodyN = markdown.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
  return sha256Utf8(`${PATTERN_ALGO}\0${scopeKey}\0${nameN}\0${bodyN}`);
}

export function commandHash(command: {
  candidateId: string;
  expectedRevision: number;
  expectedHash: string;
  decision: 'approve' | 'reject';
}): HexSha256 {
  return sha256Utf8(JSON.stringify({
    candidateId: command.candidateId,
    decision: command.decision,
    expectedHash: command.expectedHash,
    expectedRevision: command.expectedRevision,
  }));
}

export function isHexSha256(value: unknown): value is HexSha256 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
