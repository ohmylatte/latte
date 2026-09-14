import { canonicalJson, sha256Utf8 } from '../core/canonical';
import { PATTERN_ALGO, type HexSha256 } from './types';

/** Canonical bytes of a validated package. Key order is part of the contract. */
export function canonicalSkillJson(input: { name: string; description: string; markdown: string }): string {
  return canonicalJson({
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
  return sha256Utf8(canonicalJson({
    candidateId: command.candidateId,
    decision: command.decision,
    expectedHash: command.expectedHash,
    expectedRevision: command.expectedRevision,
  }));
}


